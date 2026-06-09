import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import { getProvider } from '../_shared/providers/factory.ts'

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
    if (!integ) throw new Error('Missing configuration')

    // Evolution: ensure instance_name = user_id
    if ((integ.provider ?? 'evolution') !== 'zapi' && integ.instance_name !== integ.user_id) {
      await supabase
        .from('user_integrations')
        .update({ instance_name: integ.user_id })
        .eq('id', integrationId)
      integ.instance_name = integ.user_id
    }

    const provider = getProvider(integ)

    let result: { base64: string } | { connected: true }
    try {
      result = await provider.getQrCode()
    } catch (err: any) {
      if (err.message === 'qr_not_ready_yet') {
        return new Response(JSON.stringify({ error: 'qr_not_ready_yet' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      throw err
    }

    if ('connected' in result) {
      const webhookUrl =
        (integ.provider ?? 'evolution') === 'zapi'
          ? `${supabaseUrl}/functions/v1/zapi-webhook/${integ.user_id}`
          : `${supabaseUrl}/functions/v1/evolution-webhook`

      const webhookOk = await provider.configureWebhook(webhookUrl)

      await supabase
        .from('user_integrations')
        .update({ status: 'CONNECTED', is_webhook_enabled: webhookOk } as any)
        .eq('id', integrationId)

      return new Response(JSON.stringify({ connected: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    await supabase
      .from('user_integrations')
      .update({ status: 'WAITING_QR' } as any)
      .eq('id', integrationId)

    return new Response(JSON.stringify({ base64: result.base64 }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
