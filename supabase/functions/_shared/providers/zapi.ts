import type {
  NormalizedContact,
  NormalizedInbound,
  NormalizedMessage,
  WhatsAppProvider,
} from './types.ts'

interface ZapiCredentials {
  instanceId: string
  instanceToken: string
  clientToken: string
}

export class ZapiProvider implements WhatsAppProvider {
  private base: string
  private clientToken: string

  constructor(creds: ZapiCredentials) {
    this.base = `https://api.z-api.io/instances/${creds.instanceId}/token/${creds.instanceToken}`
    this.clientToken = creds.clientToken
  }

  private get headers(): Record<string, string> {
    return { 'Client-Token': this.clientToken, 'Content-Type': 'application/json' }
  }

  private toPhone(jid: string): string {
    return jid.replace(/@[\w.]+$/, '')
  }

  async sendText(toJid: string, text: string): Promise<{ messageId: string; raw: unknown }> {
    const r = await fetch(`${this.base}/send-text`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ phone: this.toPhone(toJid), message: text }),
    })
    if (!r.ok) throw new Error(`Z-API sendText failed (${r.status}): ${await r.text()}`)
    const j = await r.json()
    return { messageId: j.messageId ?? j.zaapId ?? j.id ?? crypto.randomUUID(), raw: j }
  }

  async getStatus(): Promise<'CONNECTED' | 'WAITING_QR' | 'DISCONNECTED'> {
    const r = await fetch(`${this.base}/status`, {
      headers: { 'Client-Token': this.clientToken },
    })
    if (!r.ok) return 'DISCONNECTED'
    const j = await r.json()
    return j.connected === true ? 'CONNECTED' : 'WAITING_QR'
  }

  async getQrCode(): Promise<{ base64: string } | { connected: true }> {
    const status = await this.getStatus()
    if (status === 'CONNECTED') return { connected: true }

    const r = await fetch(`${this.base}/qr-code/image`, {
      headers: { 'Client-Token': this.clientToken },
    })
    if (!r.ok) throw new Error(`Z-API getQrCode failed (${r.status}): ${await r.text()}`)
    const j = await r.json()
    const base64 = j.value ?? j.qrCode ?? j.base64
    if (!base64) throw new Error('Z-API getQrCode: no base64 in response')
    return { base64 }
  }

  async configureWebhook(callbackUrl: string): Promise<boolean> {
    const r = await fetch(`${this.base}/update-every-webhooks`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ value: callbackUrl }),
    })
    return r.ok
  }

  async disconnect(): Promise<void> {
    const r = await fetch(`${this.base}/disconnect`, {
      headers: { 'Client-Token': this.clientToken },
    })
    if (!r.ok) console.warn(`[ZapiProvider] disconnect failed: ${await r.text()}`)
  }

  async syncChats(): Promise<NormalizedContact[]> {
    const r = await fetch(`${this.base}/chats`, {
      headers: { 'Client-Token': this.clientToken },
    })
    if (!r.ok) throw new Error(`Z-API syncChats failed (${r.status}): ${await r.text()}`)
    const chats: any[] = await r.json()
    return chats
      .filter((c) => c.phone && !String(c.phone).includes('@g.us'))
      .map((c) => {
        const phone = String(c.phone).replace(/@[\w.]+$/, '')
        return {
          remoteJid: `${phone}@s.whatsapp.net`,
          pushName: c.name ?? c.chatName ?? null,
          canonicalPhone: phone,
          lastMessageAt: c.lastMessageTime
            ? new Date(
                c.lastMessageTime < 10000000000 ? c.lastMessageTime * 1000 : c.lastMessageTime,
              ).toISOString()
            : undefined,
        }
      })
  }

  async syncMessages(chatId: string): Promise<NormalizedMessage[]> {
    const phone = this.toPhone(chatId)
    const r = await fetch(`${this.base}/chat-messages/${phone}`, {
      headers: { 'Client-Token': this.clientToken },
    })
    if (!r.ok) {
      console.warn(`[ZapiProvider] syncMessages failed for ${phone}: ${await r.text()}`)
      return []
    }
    const messages: any[] = await r.json()
    return messages.map((m) => {
      const p = m.phone ?? phone
      const cleanPhone = String(p).replace(/@[\w.]+$/, '')
      const ts = m.momment ?? m.timestamp ?? m.messageTimestamp
      return {
        messageId: m.messageId ?? m.id,
        remoteJid: `${cleanPhone}@s.whatsapp.net`,
        fromMe: m.fromMe ?? false,
        text: m.text?.message ?? m.body ?? null,
        timestamp: ts
          ? new Date(ts < 10000000000 ? ts * 1000 : ts).toISOString()
          : new Date().toISOString(),
        type: m.audio ? 'audioMessage' : m.image ? 'imageMessage' : 'conversation',
        mediaUrl: m.audio?.audioUrl ?? m.image?.imageUrl ?? null,
        raw: m,
      }
    })
  }

  parseInbound(payload: unknown): NormalizedInbound | null {
    const p = payload as Record<string, any>

    if (p.type === 'ConnectedCallback' || p.type === 'DisconnectedCallback') return null
    if (p.type !== 'ReceivedCallback') return null
    if (p.fromMe) return null
    if (p.isGroup) return null

    const rawPhone = String(p.phone ?? '')
    const phone = rawPhone.includes('@') ? rawPhone.replace(/@[\w.]+$/, '') : rawPhone
    const remoteJid = `${phone}@s.whatsapp.net`

    const text = p.text?.message ?? null
    const type = p.audio
      ? 'audioMessage'
      : p.image
      ? 'imageMessage'
      : p.document
      ? 'documentMessage'
      : p.video
      ? 'videoMessage'
      : p.sticker
      ? 'stickerMessage'
      : text
      ? 'conversation'
      : 'unknown'
    const mediaUrl =
      p.audio?.audioUrl ??
      p.image?.imageUrl ??
      p.document?.documentUrl ??
      p.video?.videoUrl ??
      null

    const ts = p.momment ?? p.timestamp
    const timestamp = ts
      ? new Date(ts < 10000000000 ? ts * 1000 : ts).toISOString()
      : new Date().toISOString()

    return {
      remoteJid,
      pushName: p.senderName ?? p.chatName ?? null,
      text,
      timestamp,
      messageId: p.messageId ?? p.id,
      mediaUrl,
      lid: p.senderLid ?? null,
      fromMe: false,
      type,
      raw: payload,
    }
  }

  async fetchMedia(options: { messageId?: string; rawPayload?: unknown }): Promise<string | null> {
    const p = options.rawPayload as Record<string, any> | undefined
    if (!p) return null
    return p.audio?.audioUrl ?? p.image?.imageUrl ?? p.document?.documentUrl ?? p.video?.videoUrl ?? null
  }
}
