import { WhatsAppContact } from './types'

/**
 * Returns a user-friendly display name for a WhatsApp contact.
 * Falls back to a localized "Unknown" string when no push_name is available.
 */
export function getContactDisplayName(
  contact: Pick<WhatsAppContact, 'push_name' | 'custom_name'>,
  fallback: string = 'Contato sem nome',
): string {
  return contact.custom_name?.trim() || contact.push_name?.trim() || fallback
}

/**
 * Returns the secondary line shown under the contact name (typically the phone).
 * - If we have a custom_phone, returns "+<custom_phone>".
 * - If we have a real phone_number, returns "+<phone>".
 * - If the contact is an unresolved @lid (no phone), returns a friendly placeholder.
 * - Otherwise (legacy phone JID without phone_number column populated), falls back
 *   to the digits portion of the remote_jid.
 */
export function getContactDisplaySubtitle(
  contact: Pick<WhatsAppContact, 'phone_number' | 'remote_jid' | 'custom_phone'>,
  unknownLabel: string = 'Número desconhecido',
): string {
  if (contact.custom_phone) return `+${contact.custom_phone.replace(/\+/g, '')}`
  if (contact.phone_number) return `+${contact.phone_number}`
  if (contact.remote_jid?.endsWith('@lid')) return unknownLabel
  return contact.remote_jid?.split('@')[0] ?? unknownLabel
}
