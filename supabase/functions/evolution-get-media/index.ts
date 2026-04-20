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

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser()
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { messageId, contactId } = await req.json()
    if (!messageId || !contactId) {
      return new Response(JSON.stringify({ error: 'Missing messageId or contactId' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { data: message, error: msgError } = await supabaseClient
      .from('whatsapp_messages')
      .select('raw, contact_id')
      .eq('message_id', messageId)
      .eq('contact_id', contactId)
      .single()

    if (msgError || !message) {
      return new Response(JSON.stringify({ error: 'Message not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { data: integration } = await supabaseClient
      .from('user_integrations')
      .select('instance_name, evolution_api_url, evolution_api_key')
      .eq('user_id', user.id)
      .single()

    if (!integration) {
      return new Response(JSON.stringify({ error: 'Integration not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const evoUrlRaw = integration.evolution_api_url || Deno.env.get('EVOLUTION_API_URL')
    const evoUrl = evoUrlRaw ? evoUrlRaw.replace(/\/$/, '') : ''
    const evoKey = integration.evolution_api_key || Deno.env.get('EVOLUTION_API_KEY')

    const evoRes = await fetch(
      `${evoUrl}/message/download-media/${integration.instance_name}`,
      {
        method: 'POST',
        headers: { apikey: evoKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message.raw }),
      },
    )

    if (!evoRes.ok) {
      const errText = await evoRes.text()
      console.error('[evolution-get-media] Evolution API error:', errText)
      return new Response(JSON.stringify({ error: 'Media download failed', detail: errText }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { base64, mimetype } = await evoRes.json()

    if (!base64) {
      return new Response(JSON.stringify({ error: 'No base64 data returned' }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const binaryStr = atob(base64)
    const bytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i)
    }

    return new Response(bytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': mimetype || 'audio/ogg',
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch (error: any) {
    console.error('[evolution-get-media] Error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
