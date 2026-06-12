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
    if (!r.ok) {
      // QR may have been consumed after scan — re-check status before erroring
      const recheckStatus = await this.getStatus()
      if (recheckStatus === 'CONNECTED') return { connected: true }
      throw new Error('qr_not_ready_yet')
    }
    const j = await r.json()
    const base64 = j.value ?? j.qrCode ?? j.base64
    if (!base64) {
      // Empty QR response — treat as transitioning
      const recheckStatus = await this.getStatus()
      if (recheckStatus === 'CONNECTED') return { connected: true }
      throw new Error('qr_not_ready_yet')
    }
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
    const contacts: NormalizedContact[] = []
    let page = 1

    while (true) {
      const r = await fetch(`${this.base}/contacts?page=${page}&pageSize=100`, {
        headers: { 'Client-Token': this.clientToken },
      })
      if (!r.ok) throw new Error(`Z-API syncContacts failed (${r.status}): ${await r.text()}`)
      const batch: any[] = await r.json()
      if (!Array.isArray(batch) || batch.length === 0) break

      for (const c of batch) {
        const phone = String(c.phone ?? '').replace(/@[\w.]+$/, '').trim()
        if (!phone || !/^\d+$/.test(phone)) continue
        const rawName = c.name ?? c.vname ?? null
        const pushName = rawName && !/^\d+$/.test(String(rawName).trim()) ? rawName : null
        contacts.push({
          remoteJid: `${phone}@s.whatsapp.net`,
          pushName,
          canonicalPhone: phone,
        })
      }

      page++
    }

    return contacts
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

  async getChatMessages(chatId: string, opts?: { page?: number; limit?: number }): Promise<NormalizedMessage[]> {
    const phone = this.toPhone(chatId)
    const limit = opts?.limit ?? 50
    const page = opts?.page ?? 1

    const r = await fetch(`${this.base}/chat-messages/${phone}`, {
      headers: { 'Client-Token': this.clientToken },
    })
    if (!r.ok) {
      console.warn(`[ZapiProvider] getChatMessages failed for ${phone}: ${await r.text()}`)
      return []
    }
    const raw: any[] = await r.json()
    if (!Array.isArray(raw)) return []

    // Sort descending (newest first), then paginate
    const sorted = [...raw].sort((a, b) => {
      const ta = a.momment ?? a.timestamp ?? 0
      const tb = b.momment ?? b.timestamp ?? 0
      return tb - ta
    })
    const offset = (page - 1) * limit
    const slice = sorted.slice(offset, offset + limit)

    return slice.map((m) => {
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

  async getLastMessage(chatId: string): Promise<{ messageId: string; timestamp: string } | null> {
    const messages = await this.getChatMessages(chatId, { page: 1, limit: 1 })
    if (messages.length === 0) return null
    return { messageId: messages[0].messageId, timestamp: messages[0].timestamp }
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
