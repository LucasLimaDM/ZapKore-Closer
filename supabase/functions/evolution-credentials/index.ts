import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import { ZapiProvider } from '../_shared/providers/zapi.ts'

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

    const {
      data: { user },
      error: userError,
    } = await supabaseClient.auth.getUser()
    if (userError || !user) throw new Error('Unauthorized')

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey)

    const body = await req.json()
    const { action } = body

    if (action === 'get') {
      const { data: integ } = await supabaseAdmin
        .from('user_integrations')
        .select('evolution_api_url, evolution_api_key, provider, zapi_instance_id, zapi_instance_token, zapi_client_token')
        .eq('user_id', user.id)
        .single()

      return new Response(
        JSON.stringify({
          provider: integ?.provider ?? 'evolution',
          url: integ?.evolution_api_url ?? null,
          api_key_masked: integ?.evolution_api_key ? maskKey(integ.evolution_api_key) : null,
          zapi_instance_id: integ?.zapi_instance_id ?? null,
          zapi_instance_token_masked: integ?.zapi_instance_token ? maskKey(integ.zapi_instance_token) : null,
          zapi_client_token_masked: integ?.zapi_client_token ? maskKey(integ.zapi_client_token) : null,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (action === 'save') {
      const { url, api_key } = body
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
        throw new Error(
          `Evolution API validation failed (${testRes.status}): ${body.slice(0, 200)}`,
        )
      }

      await supabaseAdmin
        .from('user_integrations')
        .update({ evolution_api_url: cleanUrl, evolution_api_key: api_key, provider: 'evolution' })
        .eq('user_id', user.id)

      return new Response(
        JSON.stringify({ url: cleanUrl, api_key_masked: maskKey(api_key) }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (action === 'save_zapi') {
      const { zapi_instance_id, zapi_instance_token, zapi_client_token } = body
      if (!zapi_instance_id || !zapi_instance_token || !zapi_client_token) {
        throw new Error('zapi_instance_id, zapi_instance_token, and zapi_client_token are required')
      }

      const provider = new ZapiProvider({
        instanceId: zapi_instance_id,
        instanceToken: zapi_instance_token,
        clientToken: zapi_client_token,
      })

      let status: string
      try {
        status = await provider.getStatus()
      } catch (err: any) {
        throw new Error(`Z-API validation failed: ${err.message}`)
      }

      await supabaseAdmin
        .from('user_integrations')
        .update({
          zapi_instance_id,
          zapi_instance_token,
          zapi_client_token,
          provider: 'zapi',
          status: status === 'CONNECTED' ? 'CONNECTED' : 'DISCONNECTED',
        })
        .eq('user_id', user.id)

      // Pre-register webhook so ConnectedCallback is received when user scans QR
      try {
        const webhookUrl = `${supabaseUrl}/functions/v1/zapi-webhook/${user.id}`
        await provider.configureWebhook(webhookUrl)
      } catch {
        // Non-fatal — webhook also configured on first successful QR poll
      }

      return new Response(
        JSON.stringify({
          zapi_instance_id,
          zapi_instance_token_masked: maskKey(zapi_instance_token),
          zapi_client_token_masked: maskKey(zapi_client_token),
          status,
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
