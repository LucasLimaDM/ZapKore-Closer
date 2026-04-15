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

    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })

    const {
      data: { user },
      error: userError,
    } = await supabaseClient.auth.getUser()
    if (userError || !user) throw new Error('Unauthorized')

    const { contactId, text } = await req.json()
    if (!contactId || !text) throw new Error('Missing contactId or text')

    const { data: integration } = await supabaseClient
      .from('user_integrations')
      .select('*')
      .eq('user_id', user.id)
      .single()

    if (!integration || !integration.instance_name) {
      throw new Error('Integration not found or not connected')
    }

    const evoUrlRaw = integration.evolution_api_url || Deno.env.get('EVOLUTION_API_URL')
    const evoUrl = evoUrlRaw ? evoUrlRaw.replace(/\/$/, '') : ''
    const evoKey = integration.evolution_api_key || Deno.env.get('EVOLUTION_API_KEY')

    const { data: contact } = await supabaseClient
      .from('whatsapp_contacts')
      .select('remote_jid')
      .eq('id', contactId)
      .eq('user_id', user.id)
      .single()

    if (!contact || !contact.remote_jid) throw new Error('Contact not found')

    const response = await fetch(`${evoUrl}/message/sendText/${integration.instance_name}`, {
      method: 'POST',
      headers: {
        apikey: evoKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        number: contact.remote_jid,
        text: text,
      }),
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Evolution API error: ${errText}`)
    }

    const result = await response.json()
    const messageId = result?.key?.id || result?.id || crypto.randomUUID()
    const timestamp = new Date().toISOString()

    // Optimistically save the message
    await supabaseClient.from('whatsapp_messages').upsert(
      {
        user_id: user.id,
        contact_id: contactId,
        message_id: messageId,
        from_me: true,
        text: text,
        type: 'text',
        timestamp: timestamp,
        raw: result,
      },
      { onConflict: 'user_id,message_id' },
    )

    // Update contact pipeline stage
    await supabaseClient
      .from('whatsapp_contacts')
      .update({
        pipeline_stage: 'Em Conversa',
        last_message_at: timestamp,
      })
      .eq('id', contactId)

    return new Response(JSON.stringify({ success: true, messageId }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
