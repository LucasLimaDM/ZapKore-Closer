import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'

Deno.serve(async (req: Request) => {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const supabase = createClient(supabaseUrl, supabaseKey)

    // Pega instância real (ignora user fake de demo)
    const { data: integrations } = await supabase
      .from('user_integrations')
      .select('*')
      .neq('user_id', '11111111-1111-1111-1111-111111111111')
      .limit(1)

    const integ = integrations?.[0]

    const evoUrl = (integ?.evolution_api_url || Deno.env.get('EVOLUTION_API_URL') || '').replace(/\/$/, '')
    const evoKey = integ?.evolution_api_key || Deno.env.get('EVOLUTION_API_KEY') || ''
    const instance = integ?.instance_name || ''

    if (!evoUrl || !instance) {
      return new Response(JSON.stringify({
        debug: {
          integration: integ,
          env_evo_url: Deno.env.get('EVOLUTION_API_URL') ? 'SET' : 'NOT SET',
          env_evo_key: Deno.env.get('EVOLUTION_API_KEY') ? 'SET' : 'NOT SET',
          resolved_url: evoUrl,
          resolved_instance: instance,
        }
      }, null, 2), { headers: { 'Content-Type': 'application/json' } })
    }

    const url = new URL(req.url)
    const endpoint = url.searchParams.get('endpoint') || 'findChats'
    const limitParam = parseInt(url.searchParams.get('limit') || '15')

    let apiUrl = ''
    let body: any = {}

    if (endpoint === 'findChats') {
      apiUrl = `${evoUrl}/chat/findChats/${instance}`
      body = { where: {}, sort: 'desc', page: 1, offset: 0 }
    } else if (endpoint === 'findContacts') {
      apiUrl = `${evoUrl}/chat/findContacts/${instance}`
      body = { where: {} }
    } else if (endpoint === 'findMessages') {
      const jid = url.searchParams.get('jid') || ''
      apiUrl = `${evoUrl}/chat/findMessages/${instance}`
      body = { where: { key: { remoteJid: jid } }, sort: 'desc', page: 1, limit: limitParam }
    }

    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { apikey: evoKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const raw = await res.json()

    // Limita resultado para não explodir o browser
    const preview = Array.isArray(raw) ? raw.slice(0, limitParam) : raw

    return new Response(
      JSON.stringify({ _meta: { endpoint, instance, status: res.status }, data: preview }, null, 2),
      { headers: { 'Content-Type': 'application/json' } },
    )
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
