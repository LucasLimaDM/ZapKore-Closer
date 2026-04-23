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
    if (!integ) {
      throw new Error('Integration not found')
    }

    const evolutionApiUrlRaw = integ.evolution_api_url || Deno.env.get('EVOLUTION_API_URL') || ''
    const evolutionApiUrl = evolutionApiUrlRaw.replace(/\/$/, '')
    const evolutionApiKey = integ.evolution_api_key || Deno.env.get('EVOLUTION_API_KEY') || ''

    if (!evolutionApiUrl || !evolutionApiKey) {
      throw new Error('Evolution API credentials not configured.')
    }

    const instanceName = integ.user_id

    if (integ.instance_name !== instanceName) {
      await supabase
        .from('user_integrations')
        .update({ instance_name: instanceName })
        .eq('id', integrationId)
    }

    const response = await fetch(`${evolutionApiUrl}/instance/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: evolutionApiKey,
      },
      body: JSON.stringify({
        instanceName: instanceName,
        token: instanceName,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      console.warn('Evolution API returned error on create:', text)

      if (
        response.status === 409 ||
        text.includes('already exists') ||
        text.includes('Duplicated instance')
      ) {
        const stateRes = await fetch(
          `${evolutionApiUrl}/instance/connectionState/${instanceName}`,
          {
            method: 'GET',
            headers: { apikey: evolutionApiKey },
          },
        )

        if (stateRes.ok) {
          const stateData = await stateRes.json()
          if (stateData.instance?.state === 'open' || stateData.state === 'open') {
            const webhookUrl = `${supabaseUrl}/functions/v1/evolution-webhook`
            const hookRes = await fetch(`${evolutionApiUrl}/webhook/set/${instanceName}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', apikey: evolutionApiKey },
              body: JSON.stringify({
                webhook: {
                  enabled: true,
                  url: webhookUrl,
                  events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'MESSAGES_DELETE', 'CONNECTION_UPDATE', 'CONTACTS_UPSERT'],
                },
              }),
            })
            const isWebhookEnabled = hookRes.ok

            await supabase
              .from('user_integrations')
              .update({
                status: 'CONNECTED',
                is_webhook_enabled: isWebhookEnabled,
              } as any)
              .eq('id', integrationId)

            if (hookRes.ok) console.log(`[WEBHOOK] Proactively configured for ${instanceName}`)
            else console.warn(`[WEBHOOK] Failed for ${instanceName}:`, await hookRes.text())

            return new Response(JSON.stringify({ success: true, connected: true }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
          }
        }
      }

      return new Response(
        JSON.stringify({ error: `Evolution Create failed (${response.status}): ${text}` }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      )
    }

    // After successfully creating instance, configure webhook
    const webhookUrl = `${supabaseUrl}/functions/v1/evolution-webhook`
    const webhookRes = await fetch(`${evolutionApiUrl}/webhook/set/${instanceName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: evolutionApiKey },
      body: JSON.stringify({
        webhook: {
          enabled: true,
          url: webhookUrl,
          events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'MESSAGES_DELETE', 'CONNECTION_UPDATE', 'CONTACTS_UPSERT'],
        },
      }),
    })

    let isWebhookEnabled = false
    if (webhookRes.ok) {
      isWebhookEnabled = true
      console.log(`[WEBHOOK] Configured successfully for ${instanceName}`)
    } else {
      console.warn(`[WEBHOOK] Failed to set webhook for ${instanceName}:`, await webhookRes.text())
    }

    await supabase
      .from('user_integrations')
      .update({
        status: 'WAITING_QR',
        is_webhook_enabled: isWebhookEnabled,
      } as any)
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
