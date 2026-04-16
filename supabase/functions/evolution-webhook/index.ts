import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { extractCanonicalPhone, normalizeJid, resolveLidToPhone } from '../_shared/utils.ts'
import { linkLidToPhone } from '../_shared/contact-linking.ts'
import { processAiResponse } from './ai-handler.ts'

Deno.serve(async (req: Request) => {
  try {
    const payload = await req.json()

    // Feature: Webhook Ingress Logging
    console.log('[WEBHOOK] INGRESS PAYLOAD:', JSON.stringify(payload))

    const instanceName = payload.instance
    const event = payload.event?.toLowerCase()

    if (!instanceName) {
      console.log('[WEBHOOK] Ignored: No instance provided in payload')
      return new Response('No instance provided', { status: 200 })
    }

    console.log(`[WEBHOOK] Processing event: ${event} for instance: ${instanceName}`)

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

    const supabase = createClient(supabaseUrl, supabaseKey)

    const { data: integ } = await supabase
      .from('user_integrations')
      .select('id, user_id, evolution_api_url, evolution_api_key')
      .eq('instance_name', instanceName)
      .single()
    if (!integ) {
      console.log(`[WEBHOOK] Ignored: Integration not found for instance: ${instanceName}`)
      return new Response('Integration not found', { status: 200 })
    }
    const userId = integ.user_id

    if (event === 'connection.update') {
      const state = payload.data?.state
      if (state === 'open') {
        console.log(`[WEBHOOK] Instance ${instanceName} connected.`)
        await supabase
          .from('user_integrations')
          .update({ status: 'CONNECTED' })
          .eq('user_id', userId)
      } else if (state === 'close') {
        console.log(`[WEBHOOK] Instance ${instanceName} disconnected.`)
        await supabase
          .from('user_integrations')
          .update({ status: 'DISCONNECTED' })
          .eq('user_id', userId)
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (event === 'messages.upsert') {
      let msgObj = payload.data

      if (Array.isArray(msgObj)) {
        msgObj = msgObj[0]
      } else if (msgObj && Array.isArray(msgObj.messages)) {
        msgObj = msgObj.messages[0]
      }

      if (msgObj && !msgObj.key && msgObj.message && msgObj.message.key) {
        msgObj = msgObj.message
      }

      if (!msgObj) {
        console.log('[WEBHOOK] Ignored: No valid message object found in payload.')
        return new Response('No message data', { status: 200 })
      }

      const key = msgObj.key || {}
      const remoteJid = key.remoteJid || msgObj.remoteJid || msgObj.jid
      const messageId = key.id || msgObj.id
      const fromMe = key.fromMe !== undefined ? key.fromMe : msgObj.fromMe || false
      const remoteJidAlt: string | undefined = key.remoteJidAlt

      if (!remoteJid) {
        console.log(
          `[WEBHOOK] Ignored: No remoteJid found in message data (instance: ${instanceName})`,
        )
        return new Response('Ignored - No remoteJid', { status: 200 })
      }

      if (remoteJid === 'status@broadcast' || remoteJid.includes('@g.us')) {
        console.log(
          `[WEBHOOK] Ignored: Message from Broadcast or Group (remoteJid: ${remoteJid}, instance: ${instanceName})`,
        )
        return new Response('Ignored - Broadcast/Group', { status: 200 })
      }

      if (!messageId) {
        console.log(
          `[WEBHOOK] Ignored: No messageId found for remoteJid ${remoteJid} (instance: ${instanceName})`,
        )
        return new Response('Ignored - No messageId', { status: 200 })
      }

      const pushName = msgObj.pushName || msgObj.verifiedName || msgObj.name || 'Unknown'
      let canonicalPhone = extractCanonicalPhone({ remoteJid, ...msgObj, ...key })

      const evoUrlRaw = integ.evolution_api_url || Deno.env.get('EVOLUTION_API_URL')
      const evoUrl = evoUrlRaw ? evoUrlRaw.replace(/\/$/, '') : ''
      const evoKey = integ.evolution_api_key || Deno.env.get('EVOLUTION_API_KEY')

      if (remoteJid && remoteJid.includes('@lid') && !canonicalPhone && evoUrl && evoKey) {
        canonicalPhone = await resolveLidToPhone(evoUrl, evoKey, instanceName, remoteJid)
      }

      let type = 'text'
      let text = '[Media/Unsupported]'

      const content = msgObj.message
      if (typeof content === 'string') {
        text = content
      } else if (content && typeof content === 'object') {
        text =
          content.conversation ||
          content.extendedTextMessage?.text ||
          content.imageMessage?.caption ||
          content.videoMessage?.caption ||
          content.documentMessage?.caption ||
          msgObj.text ||
          '[Media/Unsupported]'

        type = Object.keys(content).filter((k: string) => k !== 'messageContextInfo')[0] || 'text'
      } else if (msgObj.text) {
        text = msgObj.text
      }

      const ts = msgObj.messageTimestamp || msgObj.timestamp
      let timestamp = new Date().toISOString()
      if (ts) {
        const numTs = typeof ts === 'string' ? parseInt(ts, 10) : ts
        if (numTs > 0) {
          timestamp = new Date(numTs < 100000000000 ? numTs * 1000 : numTs).toISOString()
        }
      }

      let identity = null
      if (canonicalPhone) {
        const { data } = await supabase
          .from('contact_identity')
          .select('*')
          .eq('instance_id', integ.id)
          .eq('canonical_phone', canonicalPhone)
          .maybeSingle()
        identity = data
      }

      if (!identity && remoteJid) {
        const { data } = await supabase
          .from('contact_identity')
          .select('*')
          .eq('instance_id', integ.id)
          .or(`lid_jid.eq.${remoteJid},phone_jid.eq.${remoteJid}`)
          .limit(1)
          .maybeSingle()
        identity = data
      }

      if (!identity && canonicalPhone) {
        const phoneJid = remoteJid.includes('@s.whatsapp.net')
          ? remoteJid
          : `${canonicalPhone}@s.whatsapp.net`
        const lidJid = remoteJid.includes('@lid') ? remoteJid : null
        const { data: newId } = await supabase
          .from('contact_identity')
          .insert({
            instance_id: integ.id,
            user_id: userId,
            canonical_phone: canonicalPhone,
            phone_jid: phoneJid,
            lid_jid: lidJid,
            display_name: pushName,
          })
          .select()
          .single()
        identity = newId
      } else if (identity) {
        const updates: any = {}
        if (remoteJid.includes('@lid') && identity.lid_jid !== remoteJid)
          updates.lid_jid = remoteJid
        if (remoteJid.includes('@s.whatsapp.net') && identity.phone_jid !== remoteJid)
          updates.phone_jid = remoteJid
        if (Object.keys(updates).length > 0) {
          await supabase.from('contact_identity').update(updates).eq('id', identity.id)
        }
      }

      const effectivePhone = identity?.canonical_phone || canonicalPhone
      const rawEffectiveJid =
        (identity as any)?.phone_jid || (effectivePhone ? `${effectivePhone}@s.whatsapp.net` : remoteJid)
      const effectiveJid = normalizeJid(rawEffectiveJid)

      let { data: contact } = await supabase
        .from('whatsapp_contacts')
        .select('id, phone_number, push_name')
        .eq('user_id', userId)
        .eq('remote_jid', effectiveJid)
        .maybeSingle()

      if (!contact && effectivePhone) {
        const { data: contactByPhone } = await supabase
          .from('whatsapp_contacts')
          .select('id, phone_number, push_name')
          .eq('user_id', userId)
          .eq('phone_number', effectivePhone)
          .limit(1)
          .maybeSingle()
        if (contactByPhone) contact = contactByPhone
      }

      if (!contact && remoteJid !== effectiveJid) {
        const { data: contactByJid } = await supabase
          .from('whatsapp_contacts')
          .select('id, phone_number, push_name')
          .eq('user_id', userId)
          .eq('remote_jid', remoteJid)
          .limit(1)
          .maybeSingle()
        if (contactByJid) contact = contactByJid
      }

      if (!contact) {
        // Não criar novo contato para mensagens fromMe em JIDs desconhecidos.
        // Evita duplicatas quando o webhook recebe o eco de mensagens enviadas
        // pelo sistema para contatos @lid (Evolution resolve para phone JID).
        if (fromMe) {
          console.log(
            `[WEBHOOK] Skip: fromMe message for unknown JID ${effectiveJid}, not creating contact.`,
          )
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        const { data: newContact } = await supabase
          .from('whatsapp_contacts')
          .insert({
            user_id: userId,
            remote_jid: effectiveJid,
            phone_number: effectivePhone,
            push_name: pushName,
            last_message_at: timestamp,
            pipeline_stage: 'Em Conversa',
          })
          .select('id, phone_number, push_name')
          .single()
        contact = newContact
      } else {
        const updatePayload: any = { last_message_at: timestamp, pipeline_stage: 'Em Conversa' }
        if (
          !fromMe &&
          pushName &&
          pushName !== 'Unknown' &&
          (!contact.push_name || contact.push_name === 'Unknown' || /^\d+$/.test(contact.push_name))
        ) {
          updatePayload.push_name = pushName
        }
        if (effectivePhone && !contact.phone_number) {
          updatePayload.phone_number = effectivePhone
        }
        if (Object.keys(updatePayload).length > 0) {
          await supabase.from('whatsapp_contacts').update(updatePayload).eq('id', contact.id)
        }
      }

      if (contact && messageId) {
        const { error: insertError } = await supabase.from('whatsapp_messages').upsert(
          {
            user_id: userId,
            contact_id: contact.id,
            message_id: messageId,
            from_me: fromMe,
            text: text,
            type: type,
            timestamp: timestamp,
            raw: msgObj,
          },
          { onConflict: 'user_id,message_id' },
        )

        if (insertError) {
          console.error(`[WEBHOOK] Error inserting message ${messageId}:`, insertError)
        } else {
          console.log(
            `[WEBHOOK] Successfully saved message ${messageId} for contact ${contact.id} (remoteJid: ${effectiveJid})`,
          )

          // If the inbound message reveals the phone number for an @lid contact,
          // link them via the shared helper so future messages and the UI converge.
          if (
            !fromMe &&
            remoteJid?.includes('@lid') &&
            remoteJidAlt?.includes('@s.whatsapp.net')
          ) {
            const altPhone = remoteJidAlt.split('@')[0].replace(/\D/g, '')
            if (/^\d{8,15}$/.test(altPhone)) {
              const linkPromise = linkLidToPhone(supabase, {
                userId,
                instanceId: integ.id,
                lidJid: remoteJid,
                phoneJid: remoteJidAlt,
                canonicalPhone: altPhone,
                displayName: pushName !== 'Unknown' ? pushName : null,
              }).catch((err) =>
                console.error(`[WEBHOOK] linkLidToPhone failed for ${remoteJid}:`, err),
              )

              if (
                typeof (globalThis as any).EdgeRuntime !== 'undefined' &&
                typeof (globalThis as any).EdgeRuntime.waitUntil === 'function'
              ) {
                ;(globalThis as any).EdgeRuntime.waitUntil(linkPromise)
              }
              // else: linkPromise runs detached; Deno will await before isolate teardown
            }
          }

          if (fromMe) {
            console.log(
              `[WEBHOOK] Skip AI processing: Message is from me (remoteJid: ${effectiveJid}, instance: ${instanceName})`,
            )
          } else if (!['text', 'conversation', 'extendedTextMessage'].includes(type)) {
            console.log(
              `[WEBHOOK] Skip AI processing: Message type is not text/conversation (type: ${type}, remoteJid: ${effectiveJid}, instance: ${instanceName})`,
            )
          } else {
            console.log(
              `[WEBHOOK] Triggering background AI task for contact ${contact.id} (remoteJid: ${effectiveJid})`,
            )
            if (
              typeof (globalThis as any).EdgeRuntime !== 'undefined' &&
              typeof (globalThis as any).EdgeRuntime.waitUntil === 'function'
            ) {
              ;(globalThis as any).EdgeRuntime.waitUntil(
                processAiResponse(userId, contact.id, supabaseUrl, supabaseKey),
              )
            } else {
              processAiResponse(userId, contact.id, supabaseUrl, supabaseKey).catch((err: any) =>
                console.error('[WEBHOOK] Background AI task failed:', err),
              )
            }
          }
        }
      }
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error: any) {
    console.error('[WEBHOOK] Critical Webhook error:', error)
    return new Response('Webhook Error', { status: 500 })
  }
})
