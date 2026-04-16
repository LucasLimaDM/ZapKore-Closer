// Test function: trace sync-messages logic for a single contact, return full debug.
// Synchronous (no background) so we can read the result inline.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'

Deno.serve(async (req: Request) => {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const supabase = createClient(supabaseUrl, supabaseKey)

    const url = new URL(req.url)
    const targetJid = url.searchParams.get('jid') || '5521992467919@s.whatsapp.net'

    const trace: any = { steps: [] }
    const log = (label: string, data: any) =>
      trace.steps.push({ step: trace.steps.length + 1, label, data })

    // Get integration
    const { data: integ } = await supabase
      .from('user_integrations')
      .select('*')
      .neq('user_id', '11111111-1111-1111-1111-111111111111')
      .limit(1)
      .single()

    const userId = integ.user_id
    const evoUrl = (integ.evolution_api_url || Deno.env.get('EVOLUTION_API_URL') || '').replace(/\/$/, '')
    const evoKey = integ.evolution_api_key || Deno.env.get('EVOLUTION_API_KEY') || ''

    log('integration', { userId, instance: integ.instance_name, evoUrl: evoUrl ? 'SET' : 'MISSING' })

    // Find contact by jid
    const { data: contact } = await supabase
      .from('whatsapp_contacts')
      .select('id, remote_jid, phone_number, push_name')
      .eq('user_id', userId)
      .eq('remote_jid', targetJid)
      .maybeSingle()

    log('db_contact', contact)

    // Call Evolution findMessages
    const msgUrl = `${evoUrl}/chat/findMessages/${integ.instance_name}`
    const msgRes = await fetch(msgUrl, {
      method: 'POST',
      headers: { apikey: evoKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        where: { key: { remoteJid: targetJid } },
        sort: 'desc',
        page: 1,
        limit: 1000,
      }),
    })

    log('findMessages_status', { status: msgRes.status })

    const msgData = await msgRes.json()

    log('findMessages_shape', {
      isArray: Array.isArray(msgData),
      hasMessages: !!msgData?.messages,
      messagesIsArray: Array.isArray(msgData?.messages),
      hasMessagesRecords: !!msgData?.messages?.records,
      recordsIsArray: Array.isArray(msgData?.messages?.records),
      total: msgData?.messages?.total,
      recordsLength: msgData?.messages?.records?.length,
      keys: typeof msgData === 'object' ? Object.keys(msgData) : null,
    })

    // Try to extract messages using same logic as sync-messages
    let messages: any[] = []
    if (Array.isArray(msgData)) messages = msgData
    else if (msgData?.messages && Array.isArray(msgData.messages)) messages = msgData.messages
    else if (msgData?.messages?.records && Array.isArray(msgData.messages.records))
      messages = msgData.messages.records
    else if (msgData?.data && Array.isArray(msgData.data)) messages = msgData.data
    else if (msgData?.records && Array.isArray(msgData.records)) messages = msgData.records

    log('parsed_messages', { count: messages.length, firstMsgId: messages[0]?.key?.id })

    if (!contact || messages.length === 0) {
      return new Response(JSON.stringify(trace, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Try mapping like sync-messages does
    const mapped = messages
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
          user_id: userId,
          contact_id: contact.id,
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

    log('mapped_messages', { count: mapped.length, sample: mapped[0] })

    // Dedupe by message_id (same fix as evolution-sync-messages)
    const dedupMap = new Map<string, any>()
    for (const row of mapped as any[]) dedupMap.set(row.message_id, row)
    const deduped = Array.from(dedupMap.values())

    log('dedupe', { before: mapped.length, after: deduped.length, removed: mapped.length - deduped.length })

    // Try to insert deduped chunk
    const testChunk = deduped.slice(0, 50)
    const { data: inserted, error: insertError, status, statusText } = await supabase
      .from('whatsapp_messages')
      .upsert(testChunk, { onConflict: 'user_id,message_id' })
      .select()

    log('insert_result', {
      requestedCount: testChunk.length,
      insertedCount: inserted?.length,
      status,
      statusText,
      error: insertError,
    })

    return new Response(JSON.stringify(trace, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message, stack: err.stack }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
