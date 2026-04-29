import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

function maskKey(key: string): string {
  if (key.length <= 6) return '***'
  return key.slice(0, 3) + '***' + key.slice(-3)
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing Authorization header')

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser()
    if (userError || !user) throw new Error('Unauthorized')

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey)

    const { action, url, api_key } = await req.json()

    if (action === 'get') {
      const { data: integ } = await supabaseAdmin
        .from('user_integrations')
        .select('evolution_api_url, evolution_api_key')
        .eq('user_id', user.id)
        .single()

      return new Response(
        JSON.stringify({
          url: integ?.evolution_api_url ?? null,
          api_key_masked: integ?.evolution_api_key ? maskKey(integ.evolution_api_key) : null,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (action === 'save') {
      if (!url || !api_key) throw new Error('url and api_key are required')

      let parsedUrl: URL
      try {
        parsedUrl = new URL(url)
      } catch {
        throw new Error('Invalid URL format')
      }
      const cleanUrl = parsedUrl.toString().replace(/\/$/, '')

      const testRes = await fetch(`${cleanUrl}/instance/fetchInstances`, {
        method: 'GET',
        headers: { apikey: api_key },
      })

      if (!testRes.ok) {
        const body = await testRes.text()
        throw new Error(`Evolution API validation failed (${testRes.status}): ${body.slice(0, 200)}`)
      }

      await supabaseAdmin
        .from('user_integrations')
        .update({ evolution_api_url: cleanUrl, evolution_api_key: api_key })
        .eq('user_id', user.id)

      return new Response(
        JSON.stringify({
          url: cleanUrl,
          api_key_masked: maskKey(api_key),
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    throw new Error(`Unknown action: ${action}`)
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
