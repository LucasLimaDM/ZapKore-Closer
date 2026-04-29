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
    if (!integ) throw new Error('Missing configuration')

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

    // 1. Check if instance exists via connectionState
    const stateRes = await fetch(`${evolutionApiUrl}/instance/connectionState/${instanceName}`, {
      method: 'GET',
      headers: { apikey: evolutionApiKey },
    })

    let needsCreation = false

    if (stateRes.status === 404) {
      needsCreation = true
    } else if (!stateRes.ok) {
      const errorText = await stateRes.text()
      console.warn('Evolution connectionState failed:', errorText)
      return new Response(
        JSON.stringify({ error: `Evolution State failed (${stateRes.status}): ${errorText}` }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      )
    } else {
      const stateData = await stateRes.json()
      if (stateData.instance?.state === 'open' || stateData.state === 'open') {
        let isWebhookEnabled = (integ as any).is_webhook_enabled

        if (!isWebhookEnabled) {
          const webhookUrl = `${supabaseUrl}/functions/v1/evolution-webhook`
          const hookRes = await fetch(`${evolutionApiUrl}/webhook/set/${instanceName}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: evolutionApiKey },
            body: JSON.stringify({
              webhook: {
                enabled: true,
                url: webhookUrl,
                events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'CONTACTS_UPSERT'],
              },
            }),
          })
          isWebhookEnabled = hookRes.ok
          if (hookRes.ok) console.log(`[WEBHOOK] Proactively configured for ${instanceName}`)
          else console.warn(`[WEBHOOK] Failed for ${instanceName}:`, await hookRes.text())
        }

        await supabase
          .from('user_integrations')
          .update({
            status: 'CONNECTED',
            is_webhook_enabled: isWebhookEnabled,
          } as any)
          .eq('id', integrationId)

        return new Response(JSON.stringify({ connected: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
    }

    // Proactive webhook check if instance exists but not connected
    if (!needsCreation && !(integ as any).is_webhook_enabled) {
      const webhookUrl = `${supabaseUrl}/functions/v1/evolution-webhook`
      const webhookRes = await fetch(`${evolutionApiUrl}/webhook/set/${instanceName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: evolutionApiKey },
        body: JSON.stringify({
          webhook: {
            enabled: true,
            url: webhookUrl,
            events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'CONTACTS_UPSERT'],
          },
        }),
      })
      if (webhookRes.ok) {
        console.log(`[WEBHOOK] Proactively configured for ${instanceName}`)
        await supabase
          .from('user_integrations')
          .update({ is_webhook_enabled: true } as any)
          .eq('id', integrationId)
        ;(integ as any).is_webhook_enabled = true
      } else {
        console.warn(
          `[WEBHOOK] Failed to proactively set webhook for ${instanceName}:`,
          await webhookRes.text(),
        )
      }
    }

    // 2. If needs creation, create it
    if (needsCreation) {
      const createRes = await fetch(`${evolutionApiUrl}/instance/create`, {
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

      if (!createRes.ok) {
        const errorText = await createRes.text()
        console.warn('Evolution create failed:', errorText)

        // Handle race conditions where it might be created in the meantime
        if (
          createRes.status === 409 ||
          errorText.includes('already exists') ||
          errorText.includes('Duplicated instance')
        ) {
          // It exists now, let's continue to getting the QR code
        } else {
          return new Response(
            JSON.stringify({
              error: `Evolution Create failed (${createRes.status}): ${errorText}`,
            }),
            {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            },
          )
        }
      } else {
        const createData = await createRes.json()

        const webhookUrl = `${supabaseUrl}/functions/v1/evolution-webhook`
        const webhookRes = await fetch(`${evolutionApiUrl}/webhook/set/${instanceName}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: evolutionApiKey },
          body: JSON.stringify({
            webhook: {
              enabled: true,
              url: webhookUrl,
              events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'CONTACTS_UPSERT'],
            },
          }),
        })

        let isWebhookEnabled = false
        if (webhookRes.ok) {
          isWebhookEnabled = true
          console.log(`[WEBHOOK] Configured successfully for ${instanceName}`)
        } else {
          console.warn(
            `[WEBHOOK] Failed to set webhook for ${instanceName}:`,
            await webhookRes.text(),
          )
        }

        await supabase
          .from('user_integrations')
          .update({
            status: 'WAITING_QR',
            is_webhook_enabled: isWebhookEnabled,
          } as any)
          .eq('id', integrationId)

        if (createData.qrcode && createData.qrcode.base64) {
          return new Response(JSON.stringify({ base64: createData.qrcode.base64 }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          })
        }

        return new Response(JSON.stringify({ error: 'qr_not_ready_yet', creating: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
    }

    // 3. Instance exists but is not connected, get connect (returns QR)
    const connectRes = await fetch(`${evolutionApiUrl}/instance/connect/${instanceName}`, {
      method: 'GET',
      headers: { apikey: evolutionApiKey },
    })

    if (!connectRes.ok) {
      const errorText = await connectRes.text()
      console.warn('Evolution connect failed:', errorText)
      return new Response(
        JSON.stringify({ error: `Evolution Connect failed (${connectRes.status}): ${errorText}` }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      )
    }

    const connectData = await connectRes.json()

    if (connectData.instance?.state === 'open' || connectData.state === 'open') {
      let isWebhookEnabled = (integ as any).is_webhook_enabled
      if (!isWebhookEnabled) {
        const webhookUrl = `${supabaseUrl}/functions/v1/evolution-webhook`
        const webhookRes = await fetch(`${evolutionApiUrl}/webhook/set/${instanceName}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: evolutionApiKey },
          body: JSON.stringify({
            webhook: {
              enabled: true,
              url: webhookUrl,
              events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'CONTACTS_UPSERT'],
            },
          }),
        })
        isWebhookEnabled = webhookRes.ok
      }
      await supabase
        .from('user_integrations')
        .update({
          status: 'CONNECTED',
          is_webhook_enabled: isWebhookEnabled,
        } as any)
        .eq('id', integrationId)

      return new Response(JSON.stringify({ connected: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Update status to WAITING_QR so the UI can reflect the disconnected state accurately
    await supabase
      .from('user_integrations')
      .update({
        status: 'WAITING_QR',
      } as any)
      .eq('id', integrationId)

    const base64 = connectData.base64
    if (!base64) {
      return new Response(JSON.stringify({ error: 'qr_not_ready_yet' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ base64 }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
