import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import { transcribeAudio } from '../evolution-webhook/assemblyai.ts'

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      status: 200,
      headers: corsHeaders,
    })
  }

  console.log(`[Transcribe Message] ${req.method} request received`)

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      console.error('[Transcribe Message] Missing Authorization header')
      throw new Error('Missing Authorization header')
    }

    const body = await req.json()
    const { messageId, contactId } = body
    console.log(`[Transcribe Message] Params: messageId=${messageId}, contactId=${contactId}`)

    if (!messageId || !contactId) throw new Error('Missing messageId or contactId')

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const {
      data: { user },
      error: userError,
    } = await anonClient.auth.getUser()
    if (userError || !user) {
      console.error('[Transcribe Message] Auth error:', userError)
      throw new Error('Unauthorized')
    }
    console.log(`[Transcribe Message] User authenticated: ${user.id}`)

    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Check if transcript already exists
    const { data: existingMsg } = await supabase
      .from('whatsapp_messages')
      .select('transcript')
      .eq('message_id', messageId)
      .eq('user_id', user.id)
      .single()

    if (existingMsg?.transcript) {
      console.log('[Transcribe Message] Transcript already exists')
      return new Response(JSON.stringify({ transcript: existingMsg.transcript }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { data: integ, error: integError } = await supabase
      .from('user_integrations')
      .select('evolution_api_url, evolution_api_key, instance_name')
      .eq('user_id', user.id)
      .single()

    if (integError || !integ?.evolution_api_url || !integ?.instance_name) {
      console.error('[Transcribe Message] Integration error:', integError)
      throw new Error('Integration not configured')
    }

    const evoUrl = integ.evolution_api_url.replace(/\/$/, '')
    const evoKey = integ.evolution_api_key ?? ''
    const instanceName = integ.instance_name

    const { data: contact, error: contactError } = await supabase
      .from('whatsapp_contacts')
      .select('ai_agent_id')
      .eq('id', contactId)
      .single()

    if (contactError || !contact?.ai_agent_id) {
      console.error('[Transcribe Message] Contact/Agent error:', contactError)
      throw new Error('Contact agent not found')
    }

    const { data: agent, error: agentError } = await supabase
      .from('ai_agents')
      .select('audio_api_key_id')
      .eq('id', contact.ai_agent_id)
      .single()

    if (agentError || !agent?.audio_api_key_id) {
      console.error('[Transcribe Message] Agent audio key config error:', agentError)
      throw new Error('Agent audio key not configured')
    }

    const { data: audioKey, error: keyError } = await supabase
      .from('user_api_keys')
      .select('key')
      .eq('id', agent.audio_api_key_id)
      .eq('key_type', 'audio')
      .single()

    if (keyError || !audioKey?.key) {
      console.error('[Transcribe Message] API Key error:', keyError)
      throw new Error('Audio API key not found')
    }

    console.log('[Transcribe Message] Requesting audio from Evolution API...')
    const evoRes = await fetch(`${evoUrl}/chat/getBase64FromMediaMessage/${instanceName}`, {
      method: 'POST',
      headers: { apikey: evoKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: { key: { id: messageId } },
        convertToMp4: false,
      }),
    })

    if (!evoRes.ok) {
      const errorText = await evoRes.text()
      console.error(`[Transcribe Message] Evolution API error (${evoRes.status}):`, errorText)
      throw new Error(`Failed to download audio: ${evoRes.status}`)
    }

    const { base64 } = await evoRes.json()
    if (!base64) {
      console.error('[Transcribe Message] No base64 in Evolution response')
      throw new Error('No audio data received from Evolution API')
    }

    console.log('[Transcribe Message] Audio downloaded, starting transcription...')
    const binaryStr = atob(base64)
    const audioBytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) {
      audioBytes[i] = binaryStr.charCodeAt(i)
    }

    const transcript = await transcribeAudio(audioBytes, audioKey.key)
    if (transcript) {
      console.log('[Transcribe Message] Transcription successful')
      await supabase
        .from('whatsapp_messages')
        .update({ transcript })
        .eq('message_id', messageId)
        .eq('user_id', user.id)

      return new Response(JSON.stringify({ transcript }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    console.error('[Transcribe Message] Transcription failed (null result)')
    throw new Error('Transcription failed')
  } catch (err: any) {
    console.error('[Transcribe Message] Fatal error:', err.message)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
