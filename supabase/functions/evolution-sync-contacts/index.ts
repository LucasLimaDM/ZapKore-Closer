import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import { extractCanonicalPhone, normalizeJid, resolveLidToPhone } from '../_shared/utils.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing Authorization header')

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })

    const {
      data: { user },
      error: userError,
    } = await supabaseClient.auth.getUser()
    if (userError || !user) throw new Error('Unauthorized')

    const { data: integration, error: integrationError } = await supabaseClient
      .from('user_integrations')
      .select('*')
      .eq('user_id', user.id)
      .single()

    if (integrationError || !integration || !integration.instance_name) {
      throw new Error('Integration not found or not connected')
    }

    const evoUrlRaw = integration.evolution_api_url || Deno.env.get('EVOLUTION_API_URL')
    const evoUrl = evoUrlRaw ? evoUrlRaw.replace(/\/$/, '') : ''
    const evoKey = integration.evolution_api_key || Deno.env.get('EVOLUTION_API_KEY')

    if (!evoUrl || !evoKey) throw new Error('Evolution API config missing')

    const { data: job, error: jobError } = await supabaseClient
      .from('import_jobs')
      .insert({
        user_id: user.id,
        type: 'contact_sync',
        status: 'running',
        total_items: 0,
        processed_items: 0,
      })
      .select()
      .single()

    if (jobError) throw new Error(`Failed to create import job: ${jobError.message}`)

    const runSync = async () => {
      try {
        const webhookUrl = `${supabaseUrl}/functions/v1/evolution-webhook`
        const webhookRes = await fetch(`${evoUrl}/webhook/set/${integration.instance_name}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: evoKey },
          body: JSON.stringify({
            webhook: {
              enabled: true,
              url: webhookUrl,
              events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'CONTACTS_UPSERT'],
            },
          }),
        })

        if (webhookRes.ok) {
          await supabaseClient
            .from('user_integrations')
            .update({ is_webhook_enabled: true } as any)
            .eq('id', integration.id)
        }

        let url = `${evoUrl}/chat/findChats/${integration.instance_name}`
        let response = await fetch(url, {
          method: 'POST',
          headers: { apikey: evoKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ where: {}, sort: 'desc', page: 1, offset: 0 }),
        })

        let chatsData: any = null
        let chats: any[] = []

        if (response.ok) {
          chatsData = await response.json()
          if (Array.isArray(chatsData)) chats = chatsData
          else if (chatsData && Array.isArray(chatsData.records)) chats = chatsData.records
          else if (chatsData && Array.isArray(chatsData.data)) chats = chatsData.data
          else if (chatsData && Array.isArray(chatsData.chats)) chats = chatsData.chats
        }

        const validChats = chats
          .filter((c: any) => {
            const jid = c.remoteJid || c.jid || c.id
            return jid && !jid.includes('@g.us') && !jid.includes('status@broadcast')
          })
          .slice(0, 100)

        const { data: existingContacts } = await supabaseClient
          .from('whatsapp_contacts')
          .select('*')
          .eq('user_id', user.id)

        let processed = 0
        await supabaseClient
          .from('import_jobs')
          .update({ total_items: validChats.length })
          .eq('id', job.id)

        for (const c of validChats) {
          let jid = c.remoteJid || c.jid || c.id

          let canonicalPhone = extractCanonicalPhone(c)

          // Extract phone from remoteJidAlt (avoids extra API call for LID contacts)
          if (!canonicalPhone && jid && jid.includes('@lid')) {
            const altJid = c.lastMessage?.key?.remoteJidAlt
            if (altJid && altJid.includes('@s.whatsapp.net')) {
              const altPhone = altJid.split('@')[0].replace(/\D/g, '')
              if (/^\d{8,15}$/.test(altPhone)) canonicalPhone = altPhone
            }
          }

          if (jid && jid.includes('@lid') && !canonicalPhone && evoUrl && evoKey) {
            canonicalPhone = await resolveLidToPhone(evoUrl, evoKey, integration.instance_name, jid)
          }

          let phoneJid = jid && jid.includes('@s.whatsapp.net') ? normalizeJid(jid) : null
          let lidJid = jid && jid.includes('@lid') ? jid : null

          if (!phoneJid && canonicalPhone) {
            phoneJid = `${canonicalPhone}@s.whatsapp.net`
          }

          const rawPushName =
            c.pushName ||
            c.name ||
            c.verifiedName ||
            c.contactName ||
            c.profileName ||
            c.displayName
          // Evolution retorna o próprio número/LID como pushName quando não há nome salvo — descartar
          const pushName =
            rawPushName && !/^\d+$/.test(String(rawPushName).trim()) ? rawPushName : null

          if (canonicalPhone) {
            const { data: existingIdentity } = await supabaseClient
              .from('contact_identity')
              .select('*')
              .eq('instance_id', integration.id)
              .eq('canonical_phone', canonicalPhone)
              .maybeSingle()

            if (existingIdentity) {
              const updates: any = {}
              if (lidJid && existingIdentity.lid_jid !== lidJid) updates.lid_jid = lidJid
              if (phoneJid && existingIdentity.phone_jid !== phoneJid) updates.phone_jid = phoneJid
              if (pushName && !existingIdentity.display_name)
                updates.display_name = pushName
              if (Object.keys(updates).length > 0) {
                await supabaseClient
                  .from('contact_identity')
                  .update(updates)
                  .eq('id', existingIdentity.id)
              }
            } else {
              await supabaseClient.from('contact_identity').insert({
                instance_id: integration.id,
                user_id: user.id,
                canonical_phone: canonicalPhone,
                phone_jid: phoneJid,
                lid_jid: lidJid,
                display_name: pushName,
              })
            }
          }

          let lastMsgAt = null
          if (c.conversationTimestamp) {
            const ts =
              typeof c.conversationTimestamp === 'number'
                ? c.conversationTimestamp
                : parseInt(c.conversationTimestamp, 10)
            lastMsgAt = new Date(ts * 1000).toISOString()
          } else if (c.updatedAt) {
            lastMsgAt = new Date(c.updatedAt).toISOString()
          }

          let effectivePhone = canonicalPhone || c.phoneNumber || null
          let effectiveJid = normalizeJid(phoneJid || jid)

          const matches = (existingContacts || []).filter((db) => {
            if (effectivePhone && db.phone_number === effectivePhone) return true
            if (db.remote_jid === effectiveJid) return true
            if (lidJid && db.remote_jid === lidJid) return true
            return false
          })

          if (matches.length > 0) {
            const primary =
              matches.find((m) => m.remote_jid.includes('@s.whatsapp.net')) || matches[0]
            const secondaries = matches.filter((m) => m.id !== primary.id)

            if (secondaries.length > 0) {
              await supabaseClient.rpc('merge_whatsapp_contacts', {
                p_user_id: user.id,
                p_primary_contact_id: primary.id,
                p_secondary_contact_ids: secondaries.map((s) => s.id),
              })
              secondaries.forEach((s) => {
                const idx = existingContacts!.findIndex((e) => e.id === s.id)
                if (idx > -1) existingContacts!.splice(idx, 1)
              })
            }

            const updatePayload: any = {}
            if (pushName && !/^\d+$/.test(pushName) && pushName !== primary.push_name)
              updatePayload.push_name = pushName
            if (c.profilePictureUrl && c.profilePictureUrl !== primary.profile_picture_url)
              updatePayload.profile_picture_url = c.profilePictureUrl
            if (effectivePhone && effectivePhone !== primary.phone_number)
              updatePayload.phone_number = effectivePhone
            if (
              lastMsgAt &&
              (!primary.last_message_at || new Date(lastMsgAt) > new Date(primary.last_message_at))
            ) {
              updatePayload.last_message_at = lastMsgAt
            }

            if (Object.keys(updatePayload).length > 0) {
              await supabaseClient
                .from('whatsapp_contacts')
                .update(updatePayload)
                .eq('id', primary.id)
              Object.assign(primary, updatePayload)
            }
          } else {
            const { data: newContact } = await supabaseClient
              .from('whatsapp_contacts')
              .insert({
                user_id: user.id,
                remote_jid: effectiveJid,
                phone_number: effectivePhone,
                push_name: pushName || null,
                profile_picture_url: c.profilePictureUrl || c.profilePicUrl || null,
                last_message_at: lastMsgAt,
              })
              .select()
              .single()

            if (newContact) {
              existingContacts!.push(newContact)
            }
          }

          processed++
          if (processed % 10 === 0) {
            await supabaseClient
              .from('import_jobs')
              .update({ processed_items: processed })
              .eq('id', job.id)
          }
        }

        await supabaseClient
          .from('import_jobs')
          .update({
            processed_items: processed,
            status: 'completed',
          })
          .eq('id', job.id)

        await supabaseClient.functions.invoke('evolution-sync-messages', {})
      } catch (jobError) {
        console.error('[Background] Sync failed:', jobError)
        await supabaseClient.from('import_jobs').update({ status: 'failed' }).eq('id', job.id)
      }
    }

    if (
      typeof (globalThis as any).EdgeRuntime !== 'undefined' &&
      typeof (globalThis as any).EdgeRuntime.waitUntil === 'function'
    ) {
      ;(globalThis as any).EdgeRuntime.waitUntil(runSync())
    } else {
      runSync().catch(console.error)
    }

    return new Response(JSON.stringify({ success: true, job_id: job.id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
