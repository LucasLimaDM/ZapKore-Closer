export function normalizeJid(jid: string): string {
  if (!jid) return jid
  if (jid.includes('@s.whatsapp.net')) {
    const phone = jid.split('@')[0].replace(/\D/g, '')
    if (/^\d{8,15}$/.test(phone)) return `${phone}@s.whatsapp.net`
  }
  return jid
}

export function extractCanonicalPhone(data: any): string | null {
  if (!data) return null
  const fields = ['remoteJid', 'jid', 'phone', 'phoneNumber', 'wa_id', 'senderPn', 'remoteJidAlt']
  for (const field of fields) {
    const val = data[field]
    if (typeof val === 'string') {
      if (val.includes('@s.whatsapp.net')) {
        const extracted = val.split('@')[0]
        if (/^\d{8,15}$/.test(extracted)) return extracted
      }
      if (val.includes('@lid') || val.includes('@g.us') || val.includes('status@broadcast'))
        continue

      const digits = val.replace(/\D/g, '')
      if (digits.length >= 8 && digits.length <= 15) {
        return digits
      }
    } else if (typeof val === 'number') {
      const strVal = String(val)
      if (strVal.length >= 8 && strVal.length <= 15) return strVal
    }
  }
  return null
}

export async function resolveLidToPhone(
  evoUrl: string,
  evoKey: string,
  instanceName: string,
  lid: string,
): Promise<string | null> {
  if (!lid || !lid.includes('@lid')) return null

  try {
    const res = await fetch(`${evoUrl}/chat/findContacts/${instanceName}`, {
      method: 'POST',
      headers: { apikey: evoKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ where: { id: lid } }),
    })

    if (res.ok) {
      const data = await res.json()
      let contacts = Array.isArray(data) ? data : data?.records || data?.data || []
      for (const c of contacts) {
        const phone = extractCanonicalPhone(c)
        if (phone) return phone

        if (c.linkedJid && c.linkedJid.includes('@s.whatsapp.net')) {
          const extracted = c.linkedJid.split('@')[0]
          if (/^\d{8,15}$/.test(extracted)) return extracted
        }
      }
    }
  } catch (e) {
    console.error(`[LID Resolver] Error resolving LID ${lid}:`, e)
  }
  return null
}
