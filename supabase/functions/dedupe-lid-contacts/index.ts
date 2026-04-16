// dedupe-lid-contacts
// One-shot (idempotent) function that resolves LID ↔ phone duplicates using
// WhatsApp message key.id cross-matching.
//
// Algorithm:
// 1. Find all LID contacts without a contact_identity link.
// 2. For each, fetch messages from Evolution under that LID chat.
// 3. Look up those message IDs in whatsapp_messages for a different contact.
// 4. The other contact is the phone duplicate → merge + create contact_identity.
//
// This is safe because WhatsApp message key.id values are globally unique.
// A fromMe key.id can only appear once, so matching one proves identity.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing Authorization header')

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    // Auth client to identify the user
    const authClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })

    const {
      data: { user },
      error: userError,
    } = await authClient.auth.getUser()
    if (userError || !user) throw new Error('Unauthorized')

    // Service client for RPC calls (merge_whatsapp_contacts needs elevated access)
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const { data: integration } = await supabase
      .from('user_integrations')
      .select('*')
      .eq('user_id', user.id)
      .single()

    if (!integration?.instance_name) throw new Error('Integration not found')

    const evoUrlRaw = integration.evolution_api_url || Deno.env.get('EVOLUTION_API_URL')
    const evoUrl = evoUrlRaw ? evoUrlRaw.replace(/\/$/, '') : ''
    const evoKey = integration.evolution_api_key || Deno.env.get('EVOLUTION_API_KEY')

    if (!evoUrl || !evoKey) throw new Error('Evolution API config missing')

    const { data: job } = await supabase
      .from('import_jobs')
      .insert({
        user_id: user.id,
        type: 'dedupe_lid',
        status: 'running',
        total_items: 0,
        processed_items: 0,
      })
      .select()
      .single()

    const runDedupe = async () => {
      try {
        // ── Step 1: Find all LID contacts without a contact_identity link ──────
        const { data: lidContacts } = await supabase
          .from('whatsapp_contacts')
          .select('id, remote_jid, push_name, profile_picture_url')
          .eq('user_id', user.id)
          .like('remote_jid', '%@lid%')

        if (!lidContacts || lidContacts.length === 0) {
          await supabase
            .from('import_jobs')
            .update({ status: 'completed', total_items: 0, processed_items: 0 })
            .eq('id', job!.id)
          return
        }

        // Get existing contact_identity lid_jids for this instance
        const { data: identities } = await supabase
          .from('contact_identity')
          .select('lid_jid')
          .eq('instance_id', integration.id)

        const linkedLids = new Set((identities || []).map((i: any) => i.lid_jid).filter(Boolean))

        const unlinkedLids = lidContacts.filter((c) => !linkedLids.has(c.remote_jid))

        console.log(
          `[dedupe-lid] Found ${lidContacts.length} LID contacts, ${unlinkedLids.length} unlinked`,
        )

        if (unlinkedLids.length === 0) {
          await supabase
            .from('import_jobs')
            .update({ status: 'completed', total_items: 0, processed_items: 0 })
            .eq('id', job!.id)
          return
        }

        await supabase
          .from('import_jobs')
          .update({ total_items: unlinkedLids.length })
          .eq('id', job!.id)

        // ── Step 2: Build a lookup of all message_ids → contact_id in our DB ──
        // We only need fromMe messages since phone contacts have fromMe-only history.
        const { data: fromMeMessages } = await supabase
          .from('whatsapp_messages')
          .select('message_id, contact_id')
          .eq('user_id', user.id)
          .eq('from_me', true)

        const msgIdToContactId = new Map<string, string>()
        ;(fromMeMessages || []).forEach((m: any) => {
          if (m.message_id) msgIdToContactId.set(m.message_id, m.contact_id)
        })

        // ── Step 3: Load all phone contacts for merge lookups ─────────────────
        const { data: phoneContacts } = await supabase
          .from('whatsapp_contacts')
          .select('id, remote_jid, phone_number, push_name, profile_picture_url')
          .eq('user_id', user.id)
          .like('remote_jid', '%@s.whatsapp.net%')

        const phoneContactById = new Map<string, any>()
        ;(phoneContacts || []).forEach((c: any) => phoneContactById.set(c.id, c))

        // ── Step 4: For each unlinked LID, find its phone twin ────────────────
        let processed = 0
        let merged = 0

        for (const lidContact of unlinkedLids) {
          const lid = lidContact.remote_jid
          let phoneContactId: string | null = null
          let phoneJid: string | null = null
          let canonicalPhone: string | null = null

          try {
            // Fetch fromMe messages for this LID chat from Evolution
            const msgRes = await fetch(
              `${evoUrl}/chat/findMessages/${integration.instance_name}`,
              {
                method: 'POST',
                headers: { apikey: evoKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  where: { key: { remoteJid: lid, fromMe: true } },
                  sort: 'desc',
                  page: 1,
                  limit: 50,
                }),
              },
            )

            if (msgRes.ok) {
              const msgData = await msgRes.json()
              let messages: any[] = []
              if (Array.isArray(msgData)) messages = msgData
              else if (msgData?.messages?.records) messages = msgData.messages.records
              else if (msgData?.messages && Array.isArray(msgData.messages)) messages = msgData.messages
              else if (msgData?.records && Array.isArray(msgData.records)) messages = msgData.records
              else if (msgData?.data && Array.isArray(msgData.data)) messages = msgData.data

              // Also extract phone from remoteJidAlt if Evolution returns it
              for (const m of messages) {
                const alt = m.key?.remoteJidAlt
                if (alt && alt.includes('@s.whatsapp.net') && !canonicalPhone) {
                  const extracted = alt.split('@')[0].replace(/\D/g, '')
                  if (/^\d{8,15}$/.test(extracted)) canonicalPhone = extracted
                }

                const keyId = m.key?.id
                if (keyId && msgIdToContactId.has(keyId)) {
                  const candidateId = msgIdToContactId.get(keyId)!
                  if (candidateId !== lidContact.id) {
                    const candidate = phoneContactById.get(candidateId)
                    if (candidate?.remote_jid?.includes('@s.whatsapp.net')) {
                      phoneContactId = candidateId
                      phoneJid = candidate.remote_jid
                      if (!canonicalPhone) {
                        canonicalPhone = phoneJid.split('@')[0].replace(/\D/g, '')
                      }
                      break
                    }
                  }
                }
              }
            }

            if (phoneContactId && phoneJid && canonicalPhone) {
              console.log(
                `[dedupe-lid] Merging LID ${lid} (${lidContact.id}) → phone ${phoneJid} (${phoneContactId})`,
              )

              // Merge: phone is primary, LID is secondary
              const { error: mergeError } = await supabase.rpc('merge_whatsapp_contacts', {
                p_user_id: user.id,
                p_primary_contact_id: phoneContactId,
                p_secondary_contact_ids: [lidContact.id],
              })

              if (mergeError) {
                console.error(`[dedupe-lid] Merge error for ${lid}:`, mergeError)
              } else {
                // Carry over push_name / avatar from LID contact if phone had none
                const phoneContact = phoneContactById.get(phoneContactId)
                const carryOver: Record<string, string | null> = {}
                if (!phoneContact?.push_name && lidContact.push_name) {
                  carryOver.push_name = lidContact.push_name
                }
                if (!phoneContact?.profile_picture_url && lidContact.profile_picture_url) {
                  carryOver.profile_picture_url = lidContact.profile_picture_url
                }
                if (Object.keys(carryOver).length > 0) {
                  await supabase
                    .from('whatsapp_contacts')
                    .update(carryOver)
                    .eq('id', phoneContactId)
                }

                // Upsert contact_identity to prevent future duplicates
                const { data: existingIdentity } = await supabase
                  .from('contact_identity')
                  .select('id')
                  .eq('instance_id', integration.id)
                  .eq('canonical_phone', canonicalPhone)
                  .maybeSingle()

                if (existingIdentity) {
                  await supabase
                    .from('contact_identity')
                    .update({ lid_jid: lid, phone_jid: phoneJid })
                    .eq('id', existingIdentity.id)
                } else {
                  await supabase.from('contact_identity').insert({
                    instance_id: integration.id,
                    user_id: user.id,
                    canonical_phone: canonicalPhone,
                    phone_jid: phoneJid,
                    lid_jid: lid,
                    display_name: lidContact.push_name ?? null,
                  })
                }

                merged++
              }
            } else {
              console.log(`[dedupe-lid] No phone match found for LID ${lid}`)
            }
          } catch (err) {
            console.error(`[dedupe-lid] Error processing LID ${lid}:`, err)
          }

          processed++
          if (processed % 5 === 0) {
            await supabase
              .from('import_jobs')
              .update({ processed_items: processed })
              .eq('id', job!.id)
          }
        }

        console.log(`[dedupe-lid] Done: ${processed} processed, ${merged} merged`)
        await supabase
          .from('import_jobs')
          .update({ status: 'completed', processed_items: processed })
          .eq('id', job!.id)
      } catch (err) {
        console.error('[dedupe-lid] Background job failed:', err)
        await supabase
          .from('import_jobs')
          .update({ status: 'failed' })
          .eq('id', job!.id)
      }
    }

    if (
      typeof (globalThis as any).EdgeRuntime !== 'undefined' &&
      typeof (globalThis as any).EdgeRuntime.waitUntil === 'function'
    ) {
      ;(globalThis as any).EdgeRuntime.waitUntil(runDedupe())
    } else {
      runDedupe().catch(console.error)
    }

    return new Response(JSON.stringify({ success: true, job_id: job!.id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
