export function extractCanonicalPhone(data: any): string | null {
  if (!data) return null
  const fields = ['phone', 'phoneNumber', 'wa_id', 'senderPn', 'id', 'remoteJid', 'jid']
  for (const field of fields) {
    const val = data[field]
    if (typeof val === 'string') {
      if (val.includes('@s.whatsapp.net')) {
        const extracted = val.split('@')[0]
        if (/^\d+$/.test(extracted)) return extracted
      }
      if (val.includes('@lid') || val.includes('@g.us') || val.includes('status@broadcast'))
        continue

      const digits = val.replace(/\D/g, '')
      if (digits.length >= 8) {
        return digits
      }
    } else if (typeof val === 'number') {
      const strVal = String(val)
      if (strVal.length >= 8) return strVal
    }
  }
  return null
}
