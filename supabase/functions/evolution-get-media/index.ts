import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import { getProvider } from '../_shared/providers/factory.ts'

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
      .select('contact_id, raw')
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
      .select('*')
      .eq('user_id', user.id)
      .single()

    if (!integration) {
      return new Response(JSON.stringify({ error: 'Integration not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const provider = getProvider(integration)
    const mediaResult = await provider.fetchMedia({ messageId, rawPayload: message.raw })

    if (!mediaResult) {
      return new Response(JSON.stringify({ error: 'No media data returned' }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Z-API returns a direct URL; Evolution returns base64
    if (mediaResult.startsWith('http')) {
      const upstream = await fetch(mediaResult)
      if (!upstream.ok) {
        return new Response(JSON.stringify({ error: 'Media fetch failed' }), {
          status: 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      const contentType = upstream.headers.get('content-type') || 'application/octet-stream'
      return new Response(upstream.body, {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': contentType, 'Cache-Control': 'private, max-age=3600' },
      })
    }

    const binaryStr = atob(mediaResult)
    const bytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i)
    }

    return new Response(bytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/octet-stream',
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
