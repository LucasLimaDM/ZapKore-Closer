import { createClient } from 'jsr:@supabase/supabase-js@2'
import OpenAI from 'npm:openai'
import { linkLidToPhone } from '../_shared/contact-linking.ts'

export async function processAiResponse(
  userId: string,
  initialContactId: string,
  supabaseUrl: string,
  supabaseKey: string,
  triggerVersion: number,
  lidJid?: string,
) {
  const t0 = Date.now()
  const elapsed = () => `${Date.now() - t0}ms`

  let contactId = initialContactId

  console.log(
    `[AI Handler] START userId=${userId} contactId=${contactId} triggerVersion=${triggerVersion}${lidJid ? ` lidJid=${lidJid}` : ''}`,
  )
  try {
    const supabase = createClient(supabaseUrl, supabaseKey)

    let { data: contact, error: contactError } = await supabase
      .from('whatsapp_contacts')
      .select('ai_agent_id, remote_jid, pipeline_stage, msg_count_hour')
      .eq('id', contactId)
      .single()

    // Scenario 1 recovery: LID contact was deleted by a concurrent merge.
    // Use lidJid to find the surviving phone contact via contact_identity.
    if ((contactError || !contact) && lidJid?.includes('@lid')) {
      const { data: identity } = await supabase
        .from('contact_identity')
        .select('phone_jid')
        .eq('user_id', userId)
        .eq('lid_jid', lidJid)
        .maybeSingle()

      if (identity?.phone_jid) {
        const { data: recovered, error: recoveredErr } = await supabase
          .from('whatsapp_contacts')
          .select('id, ai_agent_id, remote_jid, pipeline_stage, msg_count_hour')
          .eq('user_id', userId)
          .eq('remote_jid', identity.phone_jid)
          .single()

        if (!recoveredErr && recovered) {
          contact = recovered
          contactId = recovered.id
          contactError = null
          console.log(
            `[AI Handler] lid_merge_recovery_contact lidJid=${lidJid} recoveredId=${contactId} remote_jid=${contact.remote_jid}`,
          )
        }
      }
    }

    if (contactError || !contact) {
      console.error(
        `[AI Handler] EXIT contact_not_found contactId=${initialContactId} supabase_code=${contactError?.code} supabase_message=${contactError?.message}`,
      )
      return
    }

    if (!contact.ai_agent_id) {
      console.log(
        `[AI Handler] EXIT no_agent_assigned contactId=${contactId} remote_jid=${contact.remote_jid}`,
      )
      return
    }

    if (contact.pipeline_stage === 'Contato Humano') {
      console.log(
        `[AI Handler] EXIT handoff_active contactId=${contactId} remote_jid=${contact.remote_jid} pipeline_stage=${contact.pipeline_stage}`,
      )
      return
    }

    const { data: integration, error: integError } = await supabase
      .from('user_integrations')
      .select('*')
      .eq('user_id', userId)
      .single()

    if (integError || !integration || !integration.instance_name) {
      console.error(
        `[AI Handler] EXIT integration_missing userId=${userId} instance_name=${integration?.instance_name ?? 'NULL'} ` +
        `supabase_code=${integError?.code ?? 'none'} supabase_message=${integError?.message ?? 'none'}`,
      )
      return
    }

    const evoUrl = (
      integration.evolution_api_url ||
      Deno.env.get('EVOLUTION_API_URL') ||
      ''
    ).replace(/\/$/, '')
    const evoKey = integration.evolution_api_key || Deno.env.get('EVOLUTION_API_KEY')

    if (!evoUrl) {
      console.error(
        `[AI Handler] EXIT evolution_url_missing userId=${userId} — save Evolution API URL in Settings > Credenciais`,
      )
      return
    }
    if (!evoKey) {
      console.error(
        `[AI Handler] EXIT evolution_key_missing userId=${userId} — save Evolution API Key in Settings > Credenciais`,
      )
      return
    }

    console.log(
      `[AI Handler] evolution_ok url=${evoUrl.slice(0, 50)}... instance=${integration.instance_name} elapsed=${elapsed()}`,
    )

    // Rate limit: msg/hour check
    if (
      integration.rate_limit_enabled &&
      contact.msg_count_hour >= (integration.rate_limit_msg_per_hour ?? 200)
    ) {
      console.log(
        `[AI Handler] rate_limit_msg_hit contactId=${contactId} count=${contact.msg_count_hour} limit=${integration.rate_limit_msg_per_hour}`,
      )
      await fetch(`${evoUrl}/message/sendText/${integration.instance_name}`, {
        method: 'POST',
        headers: { apikey: evoKey as string, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          number: contact.remote_jid,
          text: integration.rate_limit_message ?? 'Identificamos um volume elevado de mensagens e transferiremos seu atendimento para um de nossos atendentes. Em breve você será atendido!',
        }),
      }).catch((err: any) =>
        console.error(`[AI Handler] rate_limit_msg_send_failed contactId=${contactId}:`, err),
      )
      await supabase
        .from('whatsapp_contacts')
        .update({ pipeline_stage: 'Contato Humano', last_message_at: new Date().toISOString() })
        .eq('id', contactId)
      return
    }

    const { data: agent, error: agentError } = await supabase
      .from('ai_agents')
      .select('*, user_api_keys!ai_agents_api_key_id_fkey(*)')
      .eq('id', contact.ai_agent_id)
      .eq('is_active', true)
      .single()

    if (agentError || !agent) {
      console.error(
        `[AI Handler] EXIT agent_load_failed agent_id=${contact.ai_agent_id} supabase_code=${agentError?.code} supabase_message=${agentError?.message} hint=${agentError?.hint ?? 'none'}`,
      )
      return
    }

    console.log(
      `[AI Handler] agent_loaded id=${agent.id} model=${agent.model_id ?? 'NULL'} delay=${agent.message_delay} ` +
      `api_key_id=${agent.api_key_id ?? 'NULL'} linked_key_present=${!!agent.user_api_keys?.key} ` +
      `system_prompt_len=${agent.system_prompt?.length ?? 0} memory_limit=${agent.memory_limit} elapsed=${elapsed()}`,
    )

    if (!agent.model_id) {
      console.error(
        `[AI Handler] EXIT model_not_configured agent_id=${agent.id} — set a model in Agentes > edit agent`,
      )
      return
    }

    if (!agent.system_prompt || agent.system_prompt.trim().length === 0) {
      console.warn(`[AI Handler] WARN system_prompt_empty agent_id=${agent.id} — agent will reply without instructions`)
    }

    const messageDelay = agent.message_delay ?? 0

    if (messageDelay > 0) {
      console.log(`[AI Handler] debounce_sleep delay=${messageDelay}s contactId=${contactId} triggerVersion=${triggerVersion}`)
      await new Promise((resolve) => setTimeout(resolve, messageDelay * 1000))
    }

    // Cancellation check 1: was a newer message received during the sleep?
    const { data: contactVersion, error: versionCheckError } = await supabase
      .from('whatsapp_contacts')
      .select('ai_trigger_version')
      .eq('id', contactId)
      .single()

    if (versionCheckError) {
      console.error(
        `[AI Handler] EXIT version_check_failed contactId=${contactId} supabase_code=${versionCheckError?.code} supabase_message=${versionCheckError?.message}`,
      )
      return
    }

    if (contactVersion?.ai_trigger_version !== triggerVersion) {
      console.log(
        `[AI Handler] EXIT debounce_superseded contactId=${contactId} expected_v=${triggerVersion} current_v=${contactVersion?.ai_trigger_version}`,
      )
      return
    }

    console.log(`[AI Handler] version_ok v=${triggerVersion} elapsed=${elapsed()}`)

    // Get API Key: linked key → legacy gemini_api_key column → env
    const apiKey = agent.user_api_keys?.key || agent.gemini_api_key || Deno.env.get('GEMINI_API_KEY')

    if (!apiKey) {
      console.error(
        `[AI Handler] EXIT api_key_missing agent_id=${agent.id} api_key_id=${agent.api_key_id ?? 'NULL'} ` +
        `linked_key_row_present=${agent.user_api_keys !== null} — add an OpenRouter key in Agentes > Chaves de API`,
      )
      return
    }

    console.log(`[AI Handler] api_key_ok source=${agent.user_api_keys?.key ? 'linked_key' : agent.gemini_api_key ? 'legacy_column' : 'env'} prefix=${apiKey.slice(0, 10)}... length=${apiKey.length}`)

    const HANDOFF_INSTRUCTION = agent.human_handoff_enabled
      ? 'REGRA PRIORITÁRIA — TRANSBORDO PARA HUMANO:\nSempre que o cliente pedir para falar com um humano, atendente, pessoa real, ou quando a situação exigir atenção humana que você não consiga resolver, você DEVE incluir a tag <transferir_humano> ao final da sua resposta. NUNCA diga que não consegue transferir ou que só existe você. Exemplo correto: "Claro! Vou te transferir para um atendente agora. <transferir_humano>". A tag é removida automaticamente antes de chegar ao cliente.\n\n'
      : ''
    const effectiveSystemPrompt = HANDOFF_INSTRUCTION + (agent.system_prompt || '')

    const modelId = agent.model_id
    const memoryLimit = agent.memory_limit ?? 20

    // Over-fetch so filtered-out messages (media without caption, deleted) don't shrink context.
    // Secondary sort by created_at breaks timestamp ties in message bursts (WhatsApp UNIX seconds = low precision).
    const fetchLimit = Math.min(memoryLimit * 3, 200)

    let { data: messages, error: messagesError } = await supabase
      .from('whatsapp_messages')
      .select('text, from_me, type, transcript, timestamp')
      .eq('contact_id', contactId)
      .order('timestamp', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(fetchLimit)

    if (messagesError) {
      console.error(
        `[AI Handler] EXIT messages_query_failed contactId=${contactId} supabase_code=${messagesError?.code} supabase_message=${messagesError?.message}`,
      )
      return
    }

    // Scenario 2 recovery: contact exists but messages were migrated to phone contact during a concurrent merge.
    if ((!messages || messages.length === 0) && contact.remote_jid.includes('@lid')) {
      const { data: identity } = await supabase
        .from('contact_identity')
        .select('phone_jid')
        .eq('user_id', userId)
        .eq('lid_jid', contact.remote_jid)
        .maybeSingle()

      if (identity?.phone_jid) {
        const { data: phoneContact } = await supabase
          .from('whatsapp_contacts')
          .select('id')
          .eq('user_id', userId)
          .eq('remote_jid', identity.phone_jid)
          .maybeSingle()

        if (phoneContact) {
          contactId = phoneContact.id
          const { data: retriedMsgs } = await supabase
            .from('whatsapp_messages')
            .select('text, from_me, type, transcript, timestamp')
            .eq('contact_id', contactId)
            .order('timestamp', { ascending: false })
            .order('created_at', { ascending: false })
            .limit(fetchLimit)

          if (retriedMsgs?.length) {
            messages = retriedMsgs
            console.log(
              `[AI Handler] lid_merge_recovery_messages lidJid=${contact.remote_jid} contactId=${contactId} msgs=${messages.length}`,
            )
          }
        }
      }
    }

    if (!messages || (messages.length === 0 && memoryLimit > 0)) {
      console.log(
        `[AI Handler] EXIT no_messages contactId=${contactId} remote_jid=${contact.remote_jid}`,
      )
      return
    }

    // Most recent message timestamp — used later to ensure AI response appears after it in history.
    const lastMsgTimestamp = messages[0]?.timestamp

    const AUDIO_FALLBACK = '[Áudio recebido. Você ainda não consegue transcrever áudios - informe o cliente.]'

    const history = memoryLimit > 0
      ? messages
          .reverse() // chronological order
          .reduce<{ role: string; content: string }[]>((acc, m) => {
            const isAudio = m.type === 'audioMessage' || m.type === 'pttMessage'
            const content = isAudio
              ? (m.transcript || AUDIO_FALLBACK)
              : (m.text || '')
            // Skip empty messages: deleted (protocolMessage), media without caption, etc.
            if (!content.trim()) return acc
            acc.push({ role: m.from_me ? 'assistant' : 'user', content })
            return acc
          }, [])
          .slice(-memoryLimit) // keep the most recent memoryLimit *meaningful* messages
      : []

    const userMsgs = history.filter(m => m.role === 'user').length
    const assistantMsgs = history.filter(m => m.role === 'assistant').length
    console.log(
      `[AI Handler] openrouter_call_start model=${modelId} history_len=${history.length} user_msgs=${userMsgs} assistant_msgs=${assistantMsgs} fetched=${messages.length} elapsed=${elapsed()}`,
    )

    const openai = new OpenAI({
      apiKey: apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "https://zapkore-closer.com",
        "X-Title": "ZapKore Closer",
      }
    })

    let completion
    try {
      completion = await openai.chat.completions.create({
        model: modelId,
        messages: [
          { role: 'system', content: effectiveSystemPrompt },
          ...history
        ],
        temperature: 0.7,
        max_tokens: 800,
      })
      console.log(
        `[AI Handler] openrouter_ok model=${modelId} finish_reason=${completion.choices[0]?.finish_reason} ` +
        `prompt_tokens=${completion.usage?.prompt_tokens} completion_tokens=${completion.usage?.completion_tokens} elapsed=${elapsed()}`,
      )
    } catch (openrouterErr: any) {
      // Capture full OpenRouter error including provider metadata
      const errBody = openrouterErr?.error ?? openrouterErr?.response?.data ?? null
      const providerName = errBody?.metadata?.provider_name ?? openrouterErr?.metadata?.provider_name ?? 'unknown'
      const rawMsg = errBody?.metadata?.raw ?? openrouterErr?.metadata?.raw ?? ''
      console.error(
        `[AI Handler] EXIT openrouter_error model=${modelId} ` +
        `http_status=${openrouterErr?.status ?? 'none'} code=${openrouterErr?.code ?? 'none'} ` +
        `message="${openrouterErr?.message}" provider=${providerName} provider_raw="${rawMsg}" ` +
        `full_error=${JSON.stringify(errBody ?? { message: openrouterErr?.message })} elapsed=${elapsed()}`,
      )
      return
    }

    const responseText = completion.choices[0]?.message?.content?.trim()

    if (!responseText) {
      console.error(
        `[AI Handler] EXIT empty_llm_response model=${modelId} finish_reason=${completion.choices[0]?.finish_reason} choices=${JSON.stringify(completion.choices)}`,
      )
      return
    }

    console.log(`[AI Handler] llm_response_ok length=${responseText.length} preview="${responseText.slice(0, 80)}${responseText.length > 80 ? '…' : ''}"`)

    // Detect and strip <transferir_humano> tag (self-closing, open-only, or paired)
    const handoffDetected = agent.human_handoff_enabled && /<transferir_humano\s*(?:\/>|>[\s\S]*?<\/transferir_humano>|>)/g.test(responseText)
    const cleanText = responseText.replace(/<transferir_humano\s*(?:\/>|>[\s\S]*?<\/transferir_humano>|>)/g, '').trim()

    if (handoffDetected) {
      console.log(`[AI Handler] handoff_tag_detected contactId=${contactId} — transferring to human`)
    }

    // Token rate limit: count prompt + completion tokens
    const totalTokens =
      (completion.usage?.prompt_tokens ?? 0) + (completion.usage?.completion_tokens ?? 0)
    let tokenLimitHit = false

    if (integration.rate_limit_enabled && totalTokens > 0) {
      const { data: newTokenTotal } = await supabase.rpc('add_contact_tokens', {
        p_contact_id: contactId,
        p_tokens: totalTokens,
        p_window_secs: 86400,
      })
      tokenLimitHit = (newTokenTotal ?? 0) >= (integration.rate_limit_tokens_per_day ?? 2000000)
      console.log(
        `[AI Handler] token_usage contactId=${contactId} added=${totalTokens} daily_total=${newTokenTotal ?? 0} limit=${integration.rate_limit_tokens_per_day} limit_hit=${tokenLimitHit}`,
      )
    }

    // Cancellation check 2: was a newer message received during the OpenRouter call?
    const { data: contactVersionBeforeSend } = await supabase
      .from('whatsapp_contacts')
      .select('ai_trigger_version')
      .eq('id', contactId)
      .single()

    if (contactVersionBeforeSend?.ai_trigger_version !== triggerVersion) {
      console.log(
        `[AI Handler] EXIT debounce_superseded_post_llm contactId=${contactId} expected_v=${triggerVersion} current_v=${contactVersionBeforeSend?.ai_trigger_version}`,
      )
      return
    }

    if (handoffDetected) {
      const { error: handoffStageErr } = await supabase
        .from('whatsapp_contacts')
        .update({ pipeline_stage: 'Contato Humano' })
        .eq('id', contactId)
      if (handoffStageErr) {
        console.error(`[AI Handler] WARN handoff_stage_update_failed contactId=${contactId} supabase_message=${handoffStageErr.message}`)
      } else {
        console.log(`[AI Handler] handoff_stage_set contactId=${contactId}`)
      }
    }

    const textToSend =
      integration.captions_enabled && agent.name
        ? `*[${agent.name}]*\n${cleanText}`
        : cleanText

    console.log(`[AI Handler] send_start dest=${contact.remote_jid} instance=${integration.instance_name} elapsed=${elapsed()}`)

    const sendRes = await fetch(`${evoUrl}/message/sendText/${integration.instance_name}`, {
      method: 'POST',
      headers: {
        apikey: evoKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        number: contact.remote_jid,
        text: textToSend,
      }),
    })

    if (!sendRes.ok) {
      const errText = await sendRes.text()
      console.error(
        `[AI Handler] EXIT sendtext_failed http_status=${sendRes.status} ` +
        `url=${evoUrl}/message/sendText/${integration.instance_name} ` +
        `dest=${contact.remote_jid} body=${errText.slice(0, 400)} elapsed=${elapsed()}`,
      )
      return
    }

    console.log(`[AI Handler] send_ok http_status=${sendRes.status} elapsed=${elapsed()}`)

    if (tokenLimitHit) {
      console.log(`[AI Handler] token_limit_hit contactId=${contactId} — sending rate limit message and handoffing`)
      await fetch(`${evoUrl}/message/sendText/${integration.instance_name}`, {
        method: 'POST',
        headers: { apikey: evoKey as string, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          number: contact.remote_jid,
          text: integration.rate_limit_message ?? 'Identificamos um volume elevado de mensagens e transferiremos seu atendimento para um de nossos atendentes. Em breve você será atendido!',
        }),
      }).catch((err: any) =>
        console.error(`[AI Handler] token_limit_msg_send_failed contactId=${contactId}:`, err),
      )
    }

    const result = await sendRes.json()
    const messageId = result?.key?.id || result?.id || crypto.randomUUID()
    const actualRemoteJid = result?.key?.remoteJid

    // If Evolution resolved the LID to a phone JID, merge LID and phone contacts.
    if (
      actualRemoteJid &&
      actualRemoteJid.includes('@s.whatsapp.net') &&
      contact.remote_jid.includes('@lid')
    ) {
      const canonicalPhone = actualRemoteJid.split('@')[0]
      if (/^\d{8,15}$/.test(canonicalPhone)) {
        console.log(`[AI Handler] Linking LID ${contact.remote_jid} → phone ${actualRemoteJid}`)
        try {
          await linkLidToPhone(supabase, {
            userId,
            instanceId: integration.id,
            lidJid: contact.remote_jid,
            phoneJid: actualRemoteJid,
            canonicalPhone,
          })
        } catch (linkErr) {
          console.error(`[AI Handler] linkLidToPhone failed:`, linkErr)
        }
      }
    }

    // After a possible merge, ensure contactId points at the surviving row.
    if (
      actualRemoteJid &&
      actualRemoteJid.includes('@s.whatsapp.net') &&
      contact.remote_jid.includes('@lid')
    ) {
      const { data: surviving } = await supabase
        .from('whatsapp_contacts')
        .select('id')
        .eq('user_id', userId)
        .eq('remote_jid', actualRemoteJid)
        .maybeSingle()
      if (surviving) contactId = surviving.id
    }

    // Ensure AI timestamp is always after the last user message.
    // WhatsApp timestamps are UNIX seconds; server clock may be behind WhatsApp — causing
    // the AI reply to sort before the message it's responding to.
    const lastMsgMs = lastMsgTimestamp ? new Date(lastMsgTimestamp).getTime() : 0
    const aiTimestamp = new Date(Math.max(Date.now(), lastMsgMs + 1000)).toISOString()

    const { error: upsertError } = await supabase.from('whatsapp_messages').upsert(
      {
        user_id: userId,
        contact_id: contactId,
        message_id: messageId,
        from_me: true,
        text: cleanText,
        type: 'text',
        timestamp: aiTimestamp,
        raw: result,
      },
      { onConflict: 'user_id,message_id' },
    )

    if (upsertError) {
      console.error(
        `[AI Handler] WARN message_save_failed messageId=${messageId} contactId=${contactId} ` +
        `supabase_code=${upsertError.code} supabase_message=${upsertError.message}`,
      )
    }

    const { error: contactUpdateError } = await supabase
      .from('whatsapp_contacts')
      .update({
        pipeline_stage: (handoffDetected || tokenLimitHit) ? 'Contato Humano' : 'Em Conversa',
        last_message_at: new Date().toISOString(),
      })
      .eq('id', contactId)

    if (contactUpdateError) {
      console.error(
        `[AI Handler] WARN contact_update_failed contactId=${contactId} ` +
        `supabase_code=${contactUpdateError.code} supabase_message=${contactUpdateError.message}`,
      )
    }

    console.log(`[AI Handler] DONE contactId=${contactId} messageId=${messageId} total_elapsed=${elapsed()}`)
  } catch (error: any) {
    console.error(
      `[AI Handler] EXIT unhandled_exception userId=${userId} contactId=${contactId} ` +
      `error="${error?.message}" stack=${error?.stack?.split('\n')[1]?.trim() ?? 'none'}`,
    )
  }
}
