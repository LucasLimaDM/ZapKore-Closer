import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import { extractCanonicalPhone, normalizeJid, resolveLidToPhone } from '../_shared/utils.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

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
        type: 'messages_sync',
        status: 'running',
        total_items: 0,
        processed_items: 0,
      })
      .select()
      .single()

    if (jobError) throw new Error(`Failed to create import job: ${jobError.message}`)

    const runSync = async () => {
      try {
        const chatsUrl = `${evoUrl}/chat/findChats/${integration.instance_name}`
        const chatsRes = await fetch(chatsUrl, {
          method: 'POST',
          headers: { apikey: evoKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ where: {}, sort: 'desc', page: 1, offset: 0 }),
        })

        const jids = new Set<string>()
        let cList: any[] = []
        if (chatsRes.ok) {
          const rawChats = await chatsRes.json()
          if (Array.isArray(rawChats)) cList = rawChats
          else if (rawChats?.records && Array.isArray(rawChats.records)) cList = rawChats.records
          else if (rawChats?.data && Array.isArray(rawChats.data)) cList = rawChats.data
          else if (rawChats?.chats && Array.isArray(rawChats.chats)) cList = rawChats.chats

          cList.forEach((c: any) => {
            const jid = c.remoteJid || c.jid || c.id
            if (jid) jids.add(jid)
          })
        }

        const validJids = Array.from(jids)
          .filter((jid) => jid && !jid.includes('@g.us') && !jid.includes('status@broadcast'))
          .slice(0, 100)

        const { data: dbContacts } = await supabaseClient
          .from('whatsapp_contacts')
          .select('id, remote_jid, phone_number, push_name')
          .eq('user_id', user.id)

        const contactMap = new Map<string, string>()
        const phoneMap = new Map<string, string>()

        ;(dbContacts || []).forEach((c) => {
          if (c.remote_jid) contactMap.set(c.remote_jid, c.id)
          if (c.phone_number) phoneMap.set(c.phone_number, c.id)
        })

        const { data: identities } = await supabaseClient
          .from('contact_identity')
          .select('canonical_phone, lid_jid, phone_jid')
          .eq('instance_id', integration.id)

        const identityMap = new Map<string, string>()
        ;(identities || []).forEach((id) => {
          if (id.lid_jid && id.canonical_phone) identityMap.set(id.lid_jid, id.canonical_phone)
          if (id.phone_jid && id.canonical_phone) identityMap.set(id.phone_jid, id.canonical_phone)
        })

        const missingJids = []
        for (const jid of validJids) {
          let canonicalPhone = identityMap.get(jid) || extractCanonicalPhone({ remoteJid: jid })

          // Extract phone from remoteJidAlt (avoids extra API call for LID contacts)
          if (!canonicalPhone && jid.includes('@lid')) {
            const chat = cList.find((c: any) => (c.remoteJid || c.jid || c.id) === jid)
            const altJid = chat?.lastMessage?.key?.remoteJidAlt
            if (altJid && altJid.includes('@s.whatsapp.net')) {
              const altPhone = altJid.split('@')[0].replace(/\D/g, '')
              if (/^\d{8,15}$/.test(altPhone)) {
                canonicalPhone = altPhone
                identityMap.set(jid, canonicalPhone)
              }
            }
          }

          if (!canonicalPhone && jid.includes('@lid') && evoUrl && evoKey) {
            canonicalPhone = await resolveLidToPhone(evoUrl, evoKey, integration.instance_name, jid)
            if (canonicalPhone) identityMap.set(jid, canonicalPhone)
          }
          let skip = false
          if (contactMap.has(jid)) skip = true
          else if (canonicalPhone && phoneMap.has(canonicalPhone)) skip = true
          else if (jid.includes('@s.whatsapp.net')) {
            const phone = jid.split('@')[0]
            if (phoneMap.has(phone)) skip = true
          }
          if (!skip) missingJids.push(jid)
        }

        if (missingJids.length > 0) {
          const newContacts = missingJids.map((jid) => {
            const chat = cList.find((c) => (c.remoteJid || c.jid || c.id) === jid)
            const canonicalPhone =
              identityMap.get(jid) || extractCanonicalPhone({ remoteJid: jid, ...chat })
            const rawPushName =
              chat?.pushName ||
              chat?.name ||
              chat?.verifiedName ||
              chat?.contactName ||
              chat?.profileName ||
              chat?.displayName
            // Evolution retorna o próprio número/LID como pushName quando não há nome salvo — descartar
            const pushName =
              rawPushName && !/^\d+$/.test(String(rawPushName).trim()) ? rawPushName : null

            const phone = canonicalPhone || null
            // For unresolved LIDs, keep the LID as remote_jid; phone stays null.
            const effJid = canonicalPhone
              ? `${canonicalPhone}@s.whatsapp.net`
              : (jid?.includes('@lid') ? jid : normalizeJid(jid))

            return {
              user_id: user.id,
              remote_jid: effJid,
              phone_number: phone,
              push_name: pushName || null,
            }
          })
          for (let i = 0; i < newContacts.length; i += 50) {
            const chunk = newContacts.slice(i, i + 50)
            const { data: inserted } = await supabaseClient
              .from('whatsapp_contacts')
              .upsert(chunk, { onConflict: 'user_id,remote_jid' })
              .select('id, remote_jid, phone_number')
            if (inserted) {
              inserted.forEach((c) => {
                if (c.remote_jid) contactMap.set(c.remote_jid, c.id)
                if (c.phone_number) phoneMap.set(c.phone_number, c.id)
              })
            }
          }
        }

        let totalItems = validJids.length
        let totalProcessed = 0

        await supabaseClient
          .from('import_jobs')
          .update({
            total_items: totalItems,
            processed_items: totalProcessed,
          })
          .eq('id', job.id)

        for (const jid of validJids) {
          try {
            let canonicalPhone = identityMap.get(jid) || extractCanonicalPhone({ remoteJid: jid })

            // Extract phone from remoteJidAlt (avoids extra API call for LID contacts)
            if (!canonicalPhone && jid.includes('@lid')) {
              const chat = cList.find((c: any) => (c.remoteJid || c.jid || c.id) === jid)
              const altJid = chat?.lastMessage?.key?.remoteJidAlt
              if (altJid && altJid.includes('@s.whatsapp.net')) {
                const altPhone = altJid.split('@')[0].replace(/\D/g, '')
                if (/^\d{8,15}$/.test(altPhone)) {
                  canonicalPhone = altPhone
                  identityMap.set(jid, canonicalPhone)
                }
              }
            }

            if (!canonicalPhone && jid.includes('@lid') && evoUrl && evoKey) {
              canonicalPhone = await resolveLidToPhone(
                evoUrl,
                evoKey,
                integration.instance_name,
                jid,
              )
              if (canonicalPhone) identityMap.set(jid, canonicalPhone)
            }

            let contactId = contactMap.get(jid)
            if (!contactId && canonicalPhone) {
              contactId = phoneMap.get(canonicalPhone)
            }
            if (!contactId && jid.includes('@s.whatsapp.net')) {
              contactId = phoneMap.get(jid.split('@')[0])
            }

            if (!contactId) {
              totalProcessed++
              continue
            }

            let page = 1
            let hasMore = true
            let allMessages: any[] = []

            while (hasMore) {
              const messagesUrl = `${evoUrl}/chat/findMessages/${integration.instance_name}`
              const msgRes = await fetch(messagesUrl, {
                method: 'POST',
                headers: { apikey: evoKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  where: { key: { remoteJid: jid } },
                  sort: 'desc',
                  page: page,
                  limit: 1000,
                }),
              })

              if (!msgRes.ok) {
                break
              }

              const msgData = await msgRes.json()
              let messages: any[] = []
              if (Array.isArray(msgData)) messages = msgData
              else if (msgData?.messages && Array.isArray(msgData.messages))
                messages = msgData.messages
              else if (msgData?.messages?.records && Array.isArray(msgData.messages.records))
                messages = msgData.messages.records
              else if (msgData?.data && Array.isArray(msgData.data)) messages = msgData.data
              else if (msgData?.records && Array.isArray(msgData.records))
                messages = msgData.records

              if (!messages || messages.length === 0) {
                hasMore = false
                break
              }

              allMessages.push(...messages)

              if (messages.length < 1000) {
                hasMore = false
              } else {
                page++
              }
            }

            if (allMessages.length === 0) {
              totalProcessed++
              continue
            }

            const currentContactName = dbContacts?.find((c) => c.id === contactId)?.push_name
            const isUnknownOrNumber =
              !currentContactName ||
              currentContactName === 'Unknown' ||
              /^\d+$/.test(currentContactName)

            if (isUnknownOrNumber) {
              const incomingMsg = allMessages.find(
                (m) =>
                  !m.key?.fromMe &&
                  m.pushName &&
                  !/^\d+$/.test(String(m.pushName).trim()),
              )
              if (incomingMsg?.pushName) {
                await supabaseClient
                  .from('whatsapp_contacts')
                  .update({ push_name: incomingMsg.pushName })
                  .eq('id', contactId)
              }
            }

            const mappedMessages = allMessages
              .map((m: any) => {
                const messageId = m.key?.id
                if (!messageId) return null
                const text =
                  m.message?.conversation ||
                  m.message?.extendedTextMessage?.text ||
                  '[Media/Unsupported]'
                let timestamp = new Date().toISOString()
                if (m.messageTimestamp) {
                  const ts =
                    typeof m.messageTimestamp === 'number'
                      ? m.messageTimestamp
                      : parseInt(m.messageTimestamp, 10)
                  timestamp = new Date(ts * 1000).toISOString()
                }
                return {
                  user_id: user.id,
                  contact_id: contactId,
                  message_id: messageId,
                  from_me: m.key?.fromMe ?? false,
                  text,
                  type: m.message
                    ? Object.keys(m.message).filter((k) => k !== 'messageContextInfo')[0] || 'text'
                    : m.messageType || 'text',
                  timestamp,
                  raw: m,
                }
              })
              .filter(Boolean)

            for (let i = 0; i < mappedMessages.length; i += 100) {
              const chunk = mappedMessages.slice(i, i + 100)
              await supabaseClient
                .from('whatsapp_messages')
                .upsert(chunk, { onConflict: 'user_id,message_id' })
            }
          } catch (contactErr) {
            console.error(`[ERROR] Failed processing messages for contact ${jid}`, contactErr)
          }

          totalProcessed++
          if (totalProcessed % 5 === 0 || totalProcessed === totalItems) {
            await supabaseClient
              .from('import_jobs')
              .update({
                processed_items: totalProcessed,
              })
              .eq('id', job.id)
          }
        }

        await supabaseClient
          .from('import_jobs')
          .update({
            status: 'completed',
            processed_items: totalProcessed,
          })
          .eq('id', job.id)

        await supabaseClient.functions.invoke('ai-classify-contacts', {})
      } catch (jobError) {
        console.error('[Background] Message sync failed:', jobError)
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
