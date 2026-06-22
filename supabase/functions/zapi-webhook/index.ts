import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { ZapiProvider } from '../_shared/providers/zapi.ts'
import { processAiResponse } from '../evolution-webhook/ai-handler.ts'
import { processAudioMessage } from '../evolution-webhook/audio-handler.ts'

Deno.serve(async (req: Request) => {
  try {
    const url = new URL(req.url)
    const pathParts = url.pathname.split('/')
    const userId = pathParts[pathParts.length - 1]

    if (!userId || userId === 'zapi-webhook') {
      return new Response('Missing userId in path', { status: 400 })
    }

    const payload = await req.json()
    console.log('[ZAPI-WEBHOOK] INGRESS:', JSON.stringify(payload).slice(0, 300))

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    const supabase = createClient(supabaseUrl, supabaseKey)

    const { data: integ } = await supabase
      .from('user_integrations')
      .select('*')
      .eq('user_id', userId)
      .eq('provider', 'zapi')
      .single()

    if (!integ) {
      console.log(`[ZAPI-WEBHOOK] No Z-API integration for user ${userId}`)
      return new Response('Integration not found', { status: 200 })
    }

    // Connection status events
    if (payload.type === 'ConnectedCallback') {
      await supabase.from('user_integrations').update({ status: 'CONNECTED' }).eq('user_id', userId)
      console.log(`[ZAPI-WEBHOOK] User ${userId} connected`)
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }

    if (payload.type === 'DisconnectedCallback') {
      await supabase
        .from('user_integrations')
        .update({ status: 'DISCONNECTED' })
        .eq('user_id', userId)
      console.log(`[ZAPI-WEBHOOK] User ${userId} disconnected`)
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }

    const provider = new ZapiProvider({
      instanceId: integ.zapi_instance_id!,
      instanceToken: integ.zapi_instance_token!,
      clientToken: integ.zapi_client_token!,
    })

    const normalized = provider.parseInbound(payload)
    if (!normalized) {
      console.log(`[ZAPI-WEBHOOK] Ignored non-inbound payload type=${payload.type}`)
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }

    console.log(`[ZAPI-WEBHOOK] Inbound from ${normalized.remoteJid} type=${normalized.type}`)

    const { remoteJid, pushName, messageId, fromMe, text, type, timestamp, raw, mediaUrl } =
      normalized
    const effectivePhone = remoteJid.replace(/@[\w.]+$/, '')

    // Upsert contact
    let contact: any = null
    const { data: existing } = await supabase
      .from('whatsapp_contacts')
      .select('id, phone_number, push_name, pipeline_stage, ai_agent_id')
      .eq('user_id', userId)
      .eq('remote_jid', remoteJid)
      .maybeSingle()
    contact = existing

    if (!contact && effectivePhone) {
      const { data: byPhone } = await supabase
        .from('whatsapp_contacts')
        .select('id, phone_number, push_name, pipeline_stage, ai_agent_id')
        .eq('user_id', userId)
        .eq('phone_number', effectivePhone)
        .limit(1)
        .maybeSingle()
      if (byPhone) contact = byPhone
    }

    if (!contact) {
      if (fromMe) return new Response(JSON.stringify({ success: true }), { status: 200 })
      const { data: newContact } = await supabase
        .from('whatsapp_contacts')
        .insert({
          user_id: userId,
          remote_jid: remoteJid,
          phone_number: effectivePhone,
          push_name: pushName && !/^\d+$/.test(pushName) ? pushName : null,
          last_message_at: timestamp,
          pipeline_stage: 'Em Conversa',
        })
        .select('id, phone_number, push_name, pipeline_stage, ai_agent_id')
        .single()
      contact = newContact
    } else {
      const upd: any = { last_message_at: timestamp }
      if (contact.pipeline_stage !== 'Contato Humano') upd.pipeline_stage = 'Em Conversa'
      if (
        !fromMe &&
        pushName &&
        !/^\d+$/.test(pushName) &&
        (!contact.push_name || /^\d+$/.test(contact.push_name))
      ) {
        upd.push_name = pushName
      }
      if (effectivePhone && !contact.phone_number) upd.phone_number = effectivePhone
      await supabase.from('whatsapp_contacts').update(upd).eq('id', contact.id)
    }

    if (!contact || !messageId) {
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }

    // Upsert message
    await supabase.from('whatsapp_messages').upsert(
      {
        user_id: userId,
        contact_id: contact.id,
        message_id: messageId,
        from_me: fromMe,
        text,
        type,
        timestamp,
        raw,
      },
      { onConflict: 'user_id,message_id' },
    )

    // AI dispatch
    if (!fromMe) {
      if (type === 'audioMessage' && mediaUrl) {
        const { data: newVersion } = await supabase.rpc('increment_ai_trigger_version', {
          p_contact_id: contact.id,
        })
        if (newVersion != null) {
          // For Z-API, pass direct audio URL in evoUrl slot; audio-handler adapted in Task 13
          const audioTask = processAudioMessage(
            userId,
            contact.id,
            messageId,
            supabaseUrl,
            supabaseKey,
            newVersion as number,
            mediaUrl,
            '',
            '',
          )
          if (typeof (globalThis as any).EdgeRuntime?.waitUntil === 'function') {
            ;(globalThis as any).EdgeRuntime.waitUntil(audioTask)
          }
        }
      } else if (type === 'conversation' || type === 'text') {
        const { data: newVersion } = await supabase.rpc('increment_ai_trigger_version', {
          p_contact_id: contact.id,
        })
        if (newVersion != null) {
          if (typeof (globalThis as any).EdgeRuntime?.waitUntil === 'function') {
            ;(globalThis as any).EdgeRuntime.waitUntil(
              processAiResponse(userId, contact.id, supabaseUrl, supabaseKey, newVersion as number),
            )
          }
        }
      }
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error: any) {
    console.error('[ZAPI-WEBHOOK] Error:', error)
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  }
})
