// Centralizes the merge of a LID contact into its phone-based counterpart
// once WhatsApp reveals the phone (via remoteJidAlt or other resolution).
// Idempotent: safe to call repeatedly with the same args.

import { normalizeJid } from './utils.ts'

export interface LinkLidArgs {
  userId: string
  instanceId: string
  lidJid: string
  phoneJid: string
  canonicalPhone: string
  displayName?: string | null
}

export async function linkLidToPhone(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  args: LinkLidArgs,
): Promise<void> {
  const { userId, instanceId, lidJid, canonicalPhone, displayName } = args
  const phoneJid = normalizeJid(args.phoneJid)

  if (!lidJid.includes('@lid') || !phoneJid.includes('@s.whatsapp.net')) {
    console.warn(`[linkLidToPhone] Skipped: invalid args lidJid=${lidJid} phoneJid=${phoneJid}`)
    return
  }

  // 1. Upsert contact_identity keyed by (instance_id, canonical_phone)
  const { data: existingIdentity } = await supabase
    .from('contact_identity')
    .select('id, lid_jid, phone_jid, display_name')
    .eq('instance_id', instanceId)
    .eq('canonical_phone', canonicalPhone)
    .maybeSingle()

  if (existingIdentity) {
    const updates: Record<string, string> = {}
    if (existingIdentity.lid_jid !== lidJid) updates.lid_jid = lidJid
    if (existingIdentity.phone_jid !== phoneJid) updates.phone_jid = phoneJid
    if (displayName && !existingIdentity.display_name) updates.display_name = displayName
    if (Object.keys(updates).length > 0) {
      await supabase.from('contact_identity').update(updates).eq('id', existingIdentity.id)
    }
  } else {
    await supabase.from('contact_identity').insert({
      instance_id: instanceId,
      user_id: userId,
      canonical_phone: canonicalPhone,
      lid_jid: lidJid,
      phone_jid: phoneJid,
      display_name: displayName ?? null,
    })
  }

  // 2 & 3. Find LID and phone contacts
  const { data: lidContact } = await supabase
    .from('whatsapp_contacts')
    .select('id, push_name, profile_picture_url, last_message_at, pipeline_stage')
    .eq('user_id', userId)
    .eq('remote_jid', lidJid)
    .maybeSingle()

  const { data: phoneContact } = await supabase
    .from('whatsapp_contacts')
    .select('id, push_name, profile_picture_url, last_message_at')
    .eq('user_id', userId)
    .or(`remote_jid.eq.${phoneJid},phone_number.eq.${canonicalPhone}`)
    .maybeSingle()

  // 4. Both exist -> merge LID into phone
  if (lidContact && phoneContact && lidContact.id !== phoneContact.id) {
    console.log(
      `[linkLidToPhone] Merging LID ${lidJid} (id=${lidContact.id}) into phone ${phoneJid} (id=${phoneContact.id})`,
    )
    await supabase.rpc('merge_whatsapp_contacts', {
      p_user_id: userId,
      p_primary_contact_id: phoneContact.id,
      p_secondary_contact_ids: [lidContact.id],
    })

    // Carry over display fields if phone contact had nothing
    const carryOver: Record<string, string | null> = {}
    if (!phoneContact.push_name && lidContact.push_name) {
      carryOver.push_name = lidContact.push_name
    }
    if (!phoneContact.profile_picture_url && lidContact.profile_picture_url) {
      carryOver.profile_picture_url = lidContact.profile_picture_url
    }
    if (Object.keys(carryOver).length > 0) {
      await supabase.from('whatsapp_contacts').update(carryOver).eq('id', phoneContact.id)
    }
    return
  }

  // 5. Only LID exists -> promote it to phone
  if (lidContact && !phoneContact) {
    console.log(`[linkLidToPhone] Promoting LID contact ${lidContact.id} to phone ${phoneJid}`)
    const { error } = await supabase
      .from('whatsapp_contacts')
      .update({ remote_jid: phoneJid, phone_number: canonicalPhone })
      .eq('id', lidContact.id)

    // If a phone contact was created concurrently, we now have a unique-constraint conflict.
    // Re-query and merge.
    if (error && (error.code === '23505' || error.message?.includes('duplicate'))) {
      console.log(`[linkLidToPhone] Concurrent phone contact appeared; retrying as merge`)
      const { data: phoneContact2 } = await supabase
        .from('whatsapp_contacts')
        .select('id')
        .eq('user_id', userId)
        .eq('remote_jid', phoneJid)
        .maybeSingle()
      if (phoneContact2 && phoneContact2.id !== lidContact.id) {
        await supabase.rpc('merge_whatsapp_contacts', {
          p_user_id: userId,
          p_primary_contact_id: phoneContact2.id,
          p_secondary_contact_ids: [lidContact.id],
        })
      }
    } else if (error) {
      console.error(`[linkLidToPhone] Unexpected update error:`, error)
    }
    return
  }

  // 6 & 7. Only phone exists, or neither — nothing more to do.
  console.log(
    `[linkLidToPhone] No contact merge needed (lidContact=${!!lidContact} phoneContact=${!!phoneContact})`,
  )
}
