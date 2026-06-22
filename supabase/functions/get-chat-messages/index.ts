import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import { getProvider } from '../_shared/providers/factory.ts'

const LIMIT = 50

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing Authorization header')

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser()
    if (userError || !user) throw new Error('Unauthorized')

    const body = await req.json()
    const { contactId, page = 1 } = body as { contactId?: string; page?: number }
    if (!contactId) throw new Error('contactId required')

    const adminClient = createClient(supabaseUrl, supabaseServiceKey)

    const { data: contact } = await adminClient
      .from('whatsapp_contacts')
      .select('id, remote_jid, phone_number, user_id')
      .eq('id', contactId)
      .eq('user_id', user.id)
      .single()

    if (!contact) throw new Error('Contact not found')

    const { data: integration } = await adminClient
      .from('user_integrations')
      .select('*')
      .eq('user_id', user.id)
      .single()

    if (!integration) throw new Error('Integration not found')

    const isZapi = (integration.provider ?? 'evolution') === 'zapi'

    // Z-API multi-device does not expose a message history REST endpoint.
    // Fall back to whatsapp_messages (webhook-received messages in DB).
    if (isZapi) {
      const offset = (page - 1) * LIMIT
      const { data: dbMessages } = await adminClient
        .from('whatsapp_messages')
        .select('*')
        .eq('contact_id', contactId)
        .order('timestamp', { ascending: false })
        .range(offset, offset + LIMIT - 1)

      const rows = dbMessages ?? []
      return new Response(
        JSON.stringify({ messages: [...rows].reverse(), hasMore: rows.length === LIMIT }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // Evolution: fetch directly from provider API
    const provider = getProvider(integration)
    const chatId = contact.phone_number
      ? `${contact.phone_number}@s.whatsapp.net`
      : contact.remote_jid

    const messages = await provider.getChatMessages(chatId, { page, limit: LIMIT })

    const shaped = messages.map((m) => ({
      id: m.messageId,
      message_id: m.messageId,
      contact_id: contactId,
      user_id: user.id,
      from_me: m.fromMe,
      text: m.text,
      type: m.type,
      transcript: null,
      timestamp: m.timestamp,
      raw: m.raw,
    }))

    return new Response(JSON.stringify({ messages: shaped, hasMore: messages.length === LIMIT }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
