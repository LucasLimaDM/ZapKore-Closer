export interface NormalizedInbound {
  remoteJid: string
  pushName: string | null
  text: string | null
  timestamp: string
  messageId: string
  mediaUrl: string | null
  lid: string | null
  fromMe: boolean
  type: string
  raw: unknown
}

export interface NormalizedContact {
  remoteJid: string
  pushName: string | null
  canonicalPhone: string | null
  lastMessageAt?: string
}

export interface NormalizedMessage {
  messageId: string
  remoteJid: string
  fromMe: boolean
  text: string | null
  timestamp: string
  type: string
  mediaUrl?: string | null
  raw: unknown
}

export interface WhatsAppProvider {
  sendText(toJid: string, text: string): Promise<{ messageId: string; raw: unknown }>
  getQrCode(): Promise<{ base64: string } | { connected: true }>
  getStatus(): Promise<'CONNECTED' | 'WAITING_QR' | 'DISCONNECTED'>
  configureWebhook(callbackUrl: string): Promise<boolean>
  disconnect(): Promise<void>
  syncChats(): Promise<NormalizedContact[]>
  syncMessages(chatId: string): Promise<NormalizedMessage[]>
  parseInbound(payload: unknown): NormalizedInbound | null
  fetchMedia(options: { messageId?: string; rawPayload?: unknown }): Promise<string | null>
}
