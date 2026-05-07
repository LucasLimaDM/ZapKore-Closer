import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import { transcribeAudio } from '../evolution-webhook/assemblyai.ts'

const BATCH_SIZE = 5

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing Authorization header')

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const {
      data: { user },
    } = await anonClient.auth.getUser()
    if (!user) throw new Error('Unauthorized')

    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const { data: integ } = await supabase
      .from('user_integrations')
      .select('evolution_api_url, evolution_api_key, instance_name')
      .eq('user_id', user.id)
      .single()

    if (!integ?.evolution_api_url || !integ?.instance_name) {
      throw new Error('Integration not configured')
    }

    const evoUrl = integ.evolution_api_url.replace(/\/$/, '')
    const evoKey = integ.evolution_api_key ?? ''
    const instanceName = integ.instance_name

    const { data: pending } = await supabase
      .from('whatsapp_messages')
      .select('message_id, contact_id')
      .eq('user_id', user.id)
      .in('type', ['audioMessage', 'pttMessage'])
      .is('transcript', null)
      .order('timestamp', { ascending: false })
      .limit(BATCH_SIZE)

    if (!pending?.length) {
      return new Response(JSON.stringify({ processed: 0, remaining: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    let processed = 0

    for (const msg of pending) {
      const { data: contact } = await supabase
        .from('whatsapp_contacts')
        .select('ai_agent_id')
        .eq('id', msg.contact_id)
        .single()

      if (!contact?.ai_agent_id) continue

      const { data: agent } = await supabase
        .from('ai_agents')
        .select('audio_api_key_id')
        .eq('id', contact.ai_agent_id)
        .single()

      if (!agent?.audio_api_key_id) continue

      const { data: audioKey } = await supabase
        .from('user_api_keys')
        .select('key')
        .eq('id', agent.audio_api_key_id)
        .eq('key_type', 'audio')
        .single()

      if (!audioKey?.key) continue

      const evoRes = await fetch(`${evoUrl}/chat/getBase64FromMediaMessage/${instanceName}`, {
        method: 'POST',
        headers: { apikey: evoKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: { key: { id: msg.message_id } },
          convertToMp4: false,
        }),
      })

      if (!evoRes.ok) {
        console.error(
          `[Transcribe Pending] Failed to download audio ${msg.message_id}:`,
          evoRes.status,
        )
        continue
      }

      const { base64 } = await evoRes.json()
      if (!base64) continue

      const binaryStr = atob(base64)
      const audioBytes = new Uint8Array(binaryStr.length)
      for (let i = 0; i < binaryStr.length; i++) {
        audioBytes[i] = binaryStr.charCodeAt(i)
      }

      const transcript = await transcribeAudio(audioBytes, audioKey.key)
      if (transcript) {
        await supabase
          .from('whatsapp_messages')
          .update({ transcript })
          .eq('message_id', msg.message_id)
          .eq('user_id', user.id)
        processed++
        console.log(`[Transcribe Pending] Transcribed ${msg.message_id}`)
      }
    }

    const { count: remaining } = await supabase
      .from('whatsapp_messages')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .in('type', ['audioMessage', 'pttMessage'])
      .is('transcript', null)

    return new Response(JSON.stringify({ processed, remaining: remaining ?? 0 }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err: any) {
    console.error('[Transcribe Pending] Error:', err)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
