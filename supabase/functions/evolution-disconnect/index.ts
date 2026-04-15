import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { integrationId } = await req.json()
    if (!integrationId) throw new Error('Missing integrationId')

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

    const supabase = createClient(supabaseUrl, supabaseKey)

    const { data: integ } = await supabase
      .from('user_integrations')
      .select('*')
      .eq('id', integrationId)
      .single()
    if (!integ) throw new Error('Integration not found')

    const evolutionApiUrlRaw = integ.evolution_api_url || Deno.env.get('EVOLUTION_API_URL') || ''
    const evolutionApiUrl = evolutionApiUrlRaw.replace(/\/$/, '')
    const evolutionApiKey = integ.evolution_api_key || Deno.env.get('EVOLUTION_API_KEY') || ''
    const instanceName = integ.instance_name

    if (instanceName && evolutionApiUrl && evolutionApiKey) {
      const response = await fetch(`${evolutionApiUrl}/instance/logout/${instanceName}`, {
        method: 'DELETE',
        headers: { apikey: evolutionApiKey },
      })

      if (!response.ok) {
        const text = await response.text()
        console.warn(
          'Failed to logout instance cleanly, proceeding to set as DISCONNECTED anyway. Details:',
          text,
        )
      }
    }

    await supabase
      .from('user_integrations')
      .update({ status: 'DISCONNECTED' })
      .eq('id', integrationId)

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
