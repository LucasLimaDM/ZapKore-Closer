import type {
  NormalizedContact,
  NormalizedInbound,
  NormalizedMessage,
  WhatsAppProvider,
} from './types.ts'

interface EvolutionCredentials {
  url: string
  key: string
  instance: string
}

export class EvolutionProvider implements WhatsAppProvider {
  private url: string
  private key: string
  private instance: string

  constructor(creds: EvolutionCredentials) {
    this.url = creds.url
    this.key = creds.key
    this.instance = creds.instance
  }

  async sendText(toJid: string, text: string): Promise<{ messageId: string; raw: unknown }> {
    const r = await fetch(`${this.url}/message/sendText/${this.instance}`, {
      method: 'POST',
      headers: { apikey: this.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: toJid, text }),
    })
    if (!r.ok) throw new Error(`Evolution sendText failed (${r.status}): ${await r.text()}`)
    const j = await r.json()
    return { messageId: j?.key?.id ?? j?.id ?? crypto.randomUUID(), raw: j }
  }

  async getStatus(): Promise<'CONNECTED' | 'WAITING_QR' | 'DISCONNECTED'> {
    const r = await fetch(`${this.url}/instance/connectionState/${this.instance}`, {
      headers: { apikey: this.key },
    })
    if (!r.ok) return 'DISCONNECTED'
    const j = await r.json()
    return j.instance?.state === 'open' || j.state === 'open' ? 'CONNECTED' : 'WAITING_QR'
  }

  async getQrCode(): Promise<{ base64: string } | { connected: true }> {
    const stateRes = await fetch(`${this.url}/instance/connectionState/${this.instance}`, {
      headers: { apikey: this.key },
    })

    if (stateRes.status === 404) {
      // Instance doesn't exist — create it
      const createRes = await fetch(`${this.url}/instance/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: this.key },
        body: JSON.stringify({
          instanceName: this.instance,
          token: this.instance,
          qrcode: true,
          integration: 'WHATSAPP-BAILEYS',
        }),
      })

      if (!createRes.ok) {
        const errText = await createRes.text()
        const isDuplicate = createRes.status === 409 || errText.includes('already exists') || errText.includes('Duplicated')
        if (!isDuplicate) throw new Error(`Evolution instance/create failed (${createRes.status}): ${errText}`)
      } else {
        const createData = await createRes.json()
        if (createData.qrcode?.base64) return { base64: createData.qrcode.base64 }
      }
    } else if (stateRes.ok) {
      const stateData = await stateRes.json()
      if (stateData.instance?.state === 'open' || stateData.state === 'open') {
        return { connected: true }
      }
    }

    // Instance exists but not connected — call /instance/connect to get QR
    const connectRes = await fetch(`${this.url}/instance/connect/${this.instance}`, {
      method: 'GET',
      headers: { apikey: this.key },
    })

    if (!connectRes.ok) {
      throw new Error(`Evolution instance/connect failed (${connectRes.status}): ${await connectRes.text()}`)
    }

    const connectData = await connectRes.json()
    if (connectData.instance?.state === 'open' || connectData.state === 'open') {
      return { connected: true }
    }

    const base64 = connectData.base64
    if (!base64) throw new Error('qr_not_ready_yet')
    return { base64 }
  }

  async configureWebhook(callbackUrl: string): Promise<boolean> {
    const r = await fetch(`${this.url}/webhook/set/${this.instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: this.key },
      body: JSON.stringify({
        webhook: {
          enabled: true,
          url: callbackUrl,
          events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'MESSAGES_DELETE', 'CONNECTION_UPDATE', 'CONTACTS_UPSERT'],
        },
      }),
    })
    return r.ok
  }

  async disconnect(): Promise<void> {
    const r = await fetch(`${this.url}/instance/logout/${this.instance}`, {
      method: 'DELETE',
      headers: { apikey: this.key },
    })
    if (!r.ok) console.warn(`[EvolutionProvider] disconnect failed: ${await r.text()}`)
  }

  async syncChats(): Promise<NormalizedContact[]> {
    const r = await fetch(`${this.url}/chat/findChats/${this.instance}`, {
      method: 'GET',
      headers: { apikey: this.key, 'Content-Type': 'application/json' },
    })
    if (!r.ok) throw new Error(`Evolution findChats failed (${r.status}): ${await r.text()}`)
    const chats: any[] = await r.json()
    return chats
      .filter((c) => {
        const jid = c.remoteJid ?? c.jid ?? c.id ?? ''
        return jid && !jid.includes('@g.us') && !jid.includes('@broadcast')
      })
      .map((c) => {
        const jid = c.remoteJid ?? c.jid ?? c.id ?? ''
        const rawName = c.pushName ?? c.name ?? c.verifiedName ?? c.contactName ?? c.profileName ?? c.displayName ?? null
        const pushName = rawName && !/^\d+$/.test(rawName) ? rawName : null
        return {
          remoteJid: jid,
          pushName,
          canonicalPhone: null,
          lastMessageAt: c.lastMsgTimestamp
            ? new Date(c.lastMsgTimestamp * 1000).toISOString()
            : undefined,
        }
      })
  }

  async syncMessages(chatId: string): Promise<NormalizedMessage[]> {
    const r = await fetch(`${this.url}/chat/findMessages/${this.instance}`, {
      method: 'POST',
      headers: { apikey: this.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ where: { key: { remoteJid: chatId } }, limit: 50 }),
    })
    if (!r.ok) {
      console.warn(`[EvolutionProvider] findMessages failed for ${chatId}: ${await r.text()}`)
      return []
    }
    const data = await r.json()
    const messages: any[] = Array.isArray(data) ? data : data?.messages ?? []
    return messages.map((m) => {
      const key = m.key ?? {}
      const content = m.message ?? {}
      const ts = m.messageTimestamp ?? m.timestamp
      return {
        messageId: key.id ?? m.id,
        remoteJid: key.remoteJid ?? chatId,
        fromMe: key.fromMe ?? false,
        text: content.conversation ?? content.extendedTextMessage?.text ?? null,
        timestamp: ts
          ? new Date(ts < 100000000000 ? ts * 1000 : ts).toISOString()
          : new Date().toISOString(),
        type: Object.keys(content).filter((k) => k !== 'messageContextInfo')[0] ?? 'text',
        raw: m,
      }
    })
  }

  async getChatMessages(chatId: string, opts?: { page?: number; limit?: number }): Promise<NormalizedMessage[]> {
    const page = opts?.page ?? 1
    const limit = opts?.limit ?? 50
    const r = await fetch(`${this.url}/chat/findMessages/${this.instance}`, {
      method: 'POST',
      headers: { apikey: this.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        where: { key: { remoteJid: chatId } },
        sort: 'desc',
        page,
        limit,
      }),
    })
    if (!r.ok) {
      console.warn(`[EvolutionProvider] getChatMessages failed for ${chatId}: ${await r.text()}`)
      return []
    }
    const data = await r.json()
    const messages: any[] = Array.isArray(data)
      ? data
      : data?.messages?.records ?? data?.messages ?? data?.records ?? []
    return messages.map((m) => {
      const key = m.key ?? {}
      const content = m.message ?? {}
      const ts = m.messageTimestamp ?? m.timestamp
      return {
        messageId: key.id ?? m.id,
        remoteJid: key.remoteJid ?? chatId,
        fromMe: key.fromMe ?? false,
        text: content.conversation ?? content.extendedTextMessage?.text ?? null,
        timestamp: ts
          ? new Date(ts < 100000000000 ? ts * 1000 : ts).toISOString()
          : new Date().toISOString(),
        type: Object.keys(content).filter((k) => k !== 'messageContextInfo')[0] ?? 'text',
        raw: m,
      }
    })
  }

  async getLastMessage(chatId: string): Promise<{ messageId: string; timestamp: string } | null> {
    const messages = await this.getChatMessages(chatId, { page: 1, limit: 1 })
    if (messages.length === 0) return null
    return { messageId: messages[0].messageId, timestamp: messages[0].timestamp }
  }

  async fetchMedia(options: { messageId?: string; rawPayload?: unknown }): Promise<string | null> {
    const { messageId } = options
    if (!messageId) return null
    const r = await fetch(`${this.url}/chat/getBase64FromMediaMessage/${this.instance}`, {
      method: 'POST',
      headers: { apikey: this.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { key: { id: messageId } } }),
    })
    if (!r.ok) {
      console.warn(`[EvolutionProvider] getBase64FromMediaMessage failed: ${await r.text()}`)
      return null
    }
    const j = await r.json()
    return j.base64 ?? null
  }

  // Evolution-webhook handles Baileys parsing directly — not needed here
  parseInbound(_payload: unknown): NormalizedInbound | null {
    return null
  }
}
