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

    const evoUrl = (integ?.evolution_api_url || Deno.env.get('EVOLUTION_API_URL') || '').replace(
      /\/$/,
      '',
    )
    const evoKey = integ?.evolution_api_key || Deno.env.get('EVOLUTION_API_KEY') || ''
    const instance = integ?.instance_name || ''

    if (!evoUrl || !instance) {
      return new Response(
        JSON.stringify(
          {
            debug: {
              integration: integ,
              env_evo_url: Deno.env.get('EVOLUTION_API_URL') ? 'SET' : 'NOT SET',
              env_evo_key: Deno.env.get('EVOLUTION_API_KEY') ? 'SET' : 'NOT SET',
              resolved_url: evoUrl,
              resolved_instance: instance,
            },
          },
          null,
          2,
        ),
        { headers: { 'Content-Type': 'application/json' } },
      )
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
    } else if (endpoint === 'setWebhook') {
      const webhookUrl = `${supabaseUrl}/functions/v1/evolution-webhook`
      apiUrl = `${evoUrl}/webhook/set/${instance}`
      body = {
        webhook: {
          enabled: true,
          url: webhookUrl,
          events: [
            'MESSAGES_UPSERT',
            'MESSAGES_UPDATE',
            'MESSAGES_DELETE',
            'CONNECTION_UPDATE',
            'CONTACTS_UPSERT',
          ],
        },
      }
    } else if (endpoint === 'test-send') {
      const number = url.searchParams.get('number') || '5511936207809@s.whatsapp.net'
      const text = url.searchParams.get('text') || '[supabase test-send debug]'
      const sendRes = await fetch(`${evoUrl}/message/sendText/${instance}`, {
        method: 'POST',
        headers: { apikey: evoKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ number, text }),
      })
      const sendStatus = sendRes.status
      const sendBody = await sendRes.text()
      return new Response(
        JSON.stringify(
          { ok: sendRes.ok, http_status: sendStatus, body: sendBody.slice(0, 500) },
          null,
          2,
        ),
        { headers: { 'Content-Type': 'application/json' } },
      )
    } else if (endpoint === 'test-ai-real') {
      // Full AI handler dry-run for Lucas Dias contact — traces each step
      const LUCAS_CONTACT_ID = '65e6a55e-6755-46dc-ba3b-955282f50b18'
      const steps: any[] = []
      const userId = integ?.user_id

      const { data: contact, error: cErr } = await supabase
        .from('whatsapp_contacts')
        .select('ai_agent_id, remote_jid, pipeline_stage, msg_count_hour, ai_trigger_version')
        .eq('id', LUCAS_CONTACT_ID)
        .single()
      steps.push({
        step: 'contact',
        ok: !!contact,
        pipeline_stage: contact?.pipeline_stage,
        ai_agent_id: contact?.ai_agent_id,
        version: contact?.ai_trigger_version,
        err: cErr?.message,
      })
      if (!contact || !contact.ai_agent_id)
        return new Response(JSON.stringify({ steps }), {
          headers: { 'Content-Type': 'application/json' },
        })
      if (contact.pipeline_stage === 'Contato Humano')
        return new Response(JSON.stringify({ steps, EXIT: 'handoff_active' }), {
          headers: { 'Content-Type': 'application/json' },
        })

      const { data: agent, error: aErr } = await supabase
        .from('ai_agents')
        .select('*, user_api_keys!ai_agents_api_key_id_fkey(*)')
        .eq('id', contact.ai_agent_id)
        .eq('is_active', true)
        .single()
      steps.push({
        step: 'agent',
        ok: !!agent,
        model: agent?.model_id,
        has_key: !!agent?.user_api_keys?.key,
        err: aErr?.message,
        hint: aErr?.hint,
      })
      if (!agent)
        return new Response(JSON.stringify({ steps, EXIT: 'agent_load_failed' }), {
          headers: { 'Content-Type': 'application/json' },
        })

      const apiKey =
        agent.user_api_keys?.key || agent.gemini_api_key || Deno.env.get('GEMINI_API_KEY')
      steps.push({ step: 'api_key', ok: !!apiKey, prefix: apiKey?.slice(0, 10) })
      if (!apiKey)
        return new Response(JSON.stringify({ steps, EXIT: 'api_key_missing' }), {
          headers: { 'Content-Type': 'application/json' },
        })

      // Test OpenRouter call
      const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://zapkore-closer.com',
          'X-Title': 'ZapKore Closer',
        },
        body: JSON.stringify({
          model: agent.model_id,
          messages: [
            { role: 'system', content: agent.system_prompt || '' },
            { role: 'user', content: 'oi' },
          ],
          max_tokens: 50,
        }),
      })
      const orBody = await orRes.text()
      const orJson = JSON.parse(orBody)
      const responseText = orJson?.choices?.[0]?.message?.content?.trim()
      steps.push({
        step: 'openrouter',
        ok: orRes.ok,
        status: orRes.status,
        response_preview: responseText?.slice(0, 80),
        err: !orRes.ok ? orBody.slice(0, 200) : null,
      })
      if (!responseText)
        return new Response(JSON.stringify({ steps, EXIT: 'empty_llm_response' }), {
          headers: { 'Content-Type': 'application/json' },
        })

      // Test sendText
      const sendRes = await fetch(`${evoUrl}/message/sendText/${instance}`, {
        method: 'POST',
        headers: { apikey: evoKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          number: contact.remote_jid,
          text: `[AI debug test] ${responseText.slice(0, 50)}`,
        }),
      })
      const sendBody = await sendRes.text()
      steps.push({
        step: 'sendText',
        ok: sendRes.ok,
        status: sendRes.status,
        body_preview: sendBody.slice(0, 200),
      })

      return new Response(
        JSON.stringify({ steps, RESULT: sendRes.ok ? 'SUCCESS' : 'SEND_FAILED' }, null, 2),
        { headers: { 'Content-Type': 'application/json' } },
      )
    } else if (endpoint === 'getWebhook') {
      const getRes = await fetch(`${evoUrl}/webhook/find/${instance}`, {
        method: 'GET',
        headers: { apikey: evoKey },
      })
      const getData = await getRes.json()
      return new Response(
        JSON.stringify(
          { _meta: { endpoint, instance, status: getRes.status }, data: getData },
          null,
          2,
        ),
        { headers: { 'Content-Type': 'application/json' } },
      )
    } else if (endpoint === 'test-ai') {
      // Dry-run smoke test: verifies AI handler DB wiring without sending any message.
      // Checks: agent loads, FK join resolves, API key present, Evolution credentials set.
      const userId = integ?.user_id
      if (!userId) {
        return new Response(
          JSON.stringify({ ok: false, error: 'No real user integration found' }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }

      const { data: contacts, error: contactsErr } = await supabase
        .from('whatsapp_contacts')
        .select('id, ai_agent_id, remote_jid')
        .eq('user_id', userId)
        .not('ai_agent_id', 'is', null)
        .limit(1)

      if (contactsErr || !contacts?.length) {
        return new Response(
          JSON.stringify({
            ok: false,
            step: 'contact_lookup',
            error: contactsErr?.message || 'No contacts with ai_agent_id assigned',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }

      const contact = contacts[0]
      const { data: agent, error: agentErr } = await supabase
        .from('ai_agents')
        .select('*, user_api_keys!ai_agents_api_key_id_fkey(*)')
        .eq('id', contact.ai_agent_id)
        .eq('is_active', true)
        .single()

      if (agentErr || !agent) {
        return new Response(
          JSON.stringify({
            ok: false,
            step: 'agent_load',
            error: agentErr?.message || 'Agent not found or inactive',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }

      const apiKey =
        agent.user_api_keys?.key || agent.gemini_api_key || Deno.env.get('GEMINI_API_KEY')
      const evoUrlOk = !!(integ?.evolution_api_url || Deno.env.get('EVOLUTION_API_URL'))
      const evoKeyOk = !!(integ?.evolution_api_key || Deno.env.get('EVOLUTION_API_KEY'))

      return new Response(
        JSON.stringify(
          {
            ok: !!(apiKey && evoUrlOk && evoKeyOk),
            checks: {
              contact_found: true,
              contact_jid: contact.remote_jid,
              agent_loaded: true,
              agent_id: agent.id,
              agent_model: agent.model_id,
              agent_active: agent.is_active,
              fk_join_ok: true,
              api_key_present: !!apiKey,
              api_key_source: agent.user_api_keys?.key
                ? 'linked_key'
                : agent.gemini_api_key
                  ? 'gemini_api_key_column'
                  : 'env',
              evolution_url_ok: evoUrlOk,
              evolution_key_ok: evoKeyOk,
            },
          },
          null,
          2,
        ),
        { headers: { 'Content-Type': 'application/json' } },
      )
    } else if (endpoint === 'test-openrouter') {
      const userId = integ?.user_id
      const { data: contacts } = await supabase
        .from('whatsapp_contacts')
        .select('id, ai_agent_id')
        .eq('user_id', userId)
        .not('ai_agent_id', 'is', null)
        .limit(1)
      const contact = contacts?.[0]
      if (!contact)
        return new Response(JSON.stringify({ ok: false, error: 'no contact with agent' }), {
          headers: { 'Content-Type': 'application/json' },
        })

      const { data: agent } = await supabase
        .from('ai_agents')
        .select('*, user_api_keys!ai_agents_api_key_id_fkey(*)')
        .eq('id', contact.ai_agent_id)
        .eq('is_active', true)
        .single()
      if (!agent)
        return new Response(JSON.stringify({ ok: false, error: 'agent not loaded' }), {
          headers: { 'Content-Type': 'application/json' },
        })

      const apiKey = agent.user_api_keys?.key || agent.gemini_api_key
      const overrideModel = url.searchParams.get('model')
      const modelId = overrideModel || agent.model_id || 'google/gemini-2.0-flash-lite:free'

      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://zapkore-closer.com',
          'X-Title': 'ZapKore Closer',
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'say OK' }],
          max_tokens: 10,
        }),
      })
      const bodyText = await res.text()
      return new Response(
        JSON.stringify(
          {
            ok: res.ok,
            status: res.status,
            model: modelId,
            key_prefix: apiKey?.slice(0, 10),
            key_length: apiKey?.length,
            response_preview: bodyText.slice(0, 500),
          },
          null,
          2,
        ),
        { headers: { 'Content-Type': 'application/json' } },
      )
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
