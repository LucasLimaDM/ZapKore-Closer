import { createClient } from 'jsr:@supabase/supabase-js@2'
import OpenAI from 'npm:openai'
import { linkLidToPhone } from '../_shared/contact-linking.ts'

export async function processAiResponse(
  userId: string,
  contactId: string,
  supabaseUrl: string,
  supabaseKey: string,
  triggerVersion: number,
) {
  console.log(
    `[AI Handler] Starting processAiResponse for userId: ${userId}, contactId: ${contactId}`,
  )
  try {
    const supabase = createClient(supabaseUrl, supabaseKey)

    const { data: contact, error: contactError } = await supabase
      .from('whatsapp_contacts')
      .select('ai_agent_id, remote_jid')
      .eq('id', contactId)
      .single()

    if (contactError || !contact) {
      console.error(
        `[AI Handler] Exiting: Contact not found or error loading (contactId: ${contactId}). Error:`,
        contactError,
      )
      return
    }

    if (!contact.ai_agent_id) {
      console.log(
        `[AI Handler] Exiting: AI agent is disabled by default for contact ${contactId}. No ai_agent_id assigned.`,
      )
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
        `[AI Handler] Exiting: Assigned agent ${contact.ai_agent_id} is either inactive, deleted, or error loading. agentError:`,
        agentError,
      )
      return
    }

    console.log(`[AI Handler] Agent loaded: id=${agent.id} model=${agent.model_id} delay=${agent.message_delay} api_key_id=${agent.api_key_id} linked_key_present=${!!agent.user_api_keys?.key}`)

    const messageDelay = agent.message_delay ?? 0

    if (messageDelay > 0) {
      console.log(`[AI Handler] Debounce: sleeping ${messageDelay}s for contact ${contactId} (triggerVersion: ${triggerVersion})`)
      await new Promise((resolve) => setTimeout(resolve, messageDelay * 1000))
    }

    // Cancellation check 1: was a newer message received during the sleep?
    const { data: contactVersion, error: versionCheckError } = await supabase
      .from('whatsapp_contacts')
      .select('ai_trigger_version')
      .eq('id', contactId)
      .single()

    if (versionCheckError) {
      console.error(`[AI Handler] Exiting: Failed to read ai_trigger_version for contact ${contactId}:`, versionCheckError)
      return
    }

    if (contactVersion?.ai_trigger_version !== triggerVersion) {
      console.log(`[AI Handler] Debounce: newer message arrived during delay, aborting (contact ${contactId}, expected v${triggerVersion}, got v${contactVersion?.ai_trigger_version})`)
      return
    }

    console.log(`[AI Handler] Version check passed (v${triggerVersion}), proceeding with AI call`)

    // Get API Key: Try the linked key first, then fallback to the old gemini_api_key column, then env
    let apiKey = agent.user_api_keys?.key || agent.gemini_api_key || Deno.env.get('GEMINI_API_KEY')

    if (!apiKey) {
      console.error(
        `[AI Handler] Exiting: API Key missing. api_key_id=${agent.api_key_id} user_api_keys=${JSON.stringify(agent.user_api_keys)}`,
      )
      return
    }

    console.log(`[AI Handler] API key resolved (length=${apiKey.length}, prefix=${apiKey.slice(0, 8)}...)`)

    const modelId = agent.model_id || 'google/gemini-2.0-flash-lite:free'
    const memoryLimit = agent.memory_limit ?? 20

    const { data: messages } = await supabase
      .from('whatsapp_messages')
      .select('text, from_me, type, transcript')
      .eq('contact_id', contactId)
      .order('timestamp', { ascending: false })
      .limit(memoryLimit)

    if (!messages || (messages.length === 0 && memoryLimit > 0)) {
      console.log(
        `[AI Handler] Exiting: No messages found for contact ${contactId} (remote_jid: ${contact.remote_jid}).`,
      )
      return
    }

    const AUDIO_FALLBACK = '[Áudio recebido. Você ainda não consegue transcrever áudios - informe o cliente.]'

    const history = memoryLimit > 0
      ? messages
          .reverse()
          .map((m) => {
            const isAudio = m.type === 'audioMessage' || m.type === 'pttMessage'
            const content = isAudio
              ? (m.transcript || AUDIO_FALLBACK)
              : (m.text || '')
            return { role: m.from_me ? 'assistant' : 'user', content }
          })
      : []

    console.log(`[AI Handler] Calling OpenRouter: model=${modelId} history_len=${history.length}`)

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
          { role: 'system', content: agent.system_prompt },
          ...history
        ],
        temperature: 0.7,
        max_tokens: 800,
      })
      console.log(`[AI Handler] OpenRouter responded: finish_reason=${completion.choices[0]?.finish_reason} usage=${JSON.stringify(completion.usage)}`)
    } catch (openrouterErr: any) {
      console.error(`[AI Handler] Exiting: OpenRouter threw an error: ${openrouterErr?.message} status=${openrouterErr?.status} code=${openrouterErr?.code}`)
      return
    }

    const responseText = completion.choices[0]?.message?.content?.trim()

    if (!responseText) {
      console.error(
        `[AI Handler] Exiting: Empty response from OpenRouter. choices=${JSON.stringify(completion.choices)}`,
      )
      return
    }

    console.log(`[AI Handler] AI generated text: "${responseText}"`)


    const { data: integration } = await supabase
      .from('user_integrations')
      .select('*')
      .eq('user_id', userId)
      .single()

    if (!integration || !integration.instance_name) {
      console.error(
        `[AI Handler] Exiting: Missing integration details or instance_name for user ${userId}.`,
      )
      return
    }

    const evoUrl = (
      integration.evolution_api_url ||
      Deno.env.get('EVOLUTION_API_URL') ||
      ''
    ).replace(/\/$/, '')
    const evoKey = integration.evolution_api_key || Deno.env.get('EVOLUTION_API_KEY')

    console.log(
      `[AI Handler] Evolution API: url=${evoUrl ? evoUrl.slice(0, 40) + '...' : 'EMPTY'} key_present=${!!evoKey} instance=${integration.instance_name}`,
    )

    // Cancellation check 2: was a newer message received during the OpenRouter call?
    const { data: contactVersionBeforeSend } = await supabase
      .from('whatsapp_contacts')
      .select('ai_trigger_version')
      .eq('id', contactId)
      .single()

    if (contactVersionBeforeSend?.ai_trigger_version !== triggerVersion) {
      console.log(`[AI Handler] Debounce: newer message arrived during LLM call, discarding response (contact ${contactId}, expected v${triggerVersion}, got v${contactVersionBeforeSend?.ai_trigger_version})`)
      return
    }

    console.log(`[AI Handler] Sending to ${evoUrl}/message/sendText/${integration.instance_name} → number=${contact.remote_jid}`)

    const sendRes = await fetch(`${evoUrl}/message/sendText/${integration.instance_name}`, {
      method: 'POST',
      headers: {
        apikey: evoKey || '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        number: contact.remote_jid,
        text: responseText,
      }),
    })

    if (!sendRes.ok) {
      const errText = await sendRes.text()
      console.error(
        `[AI Handler] Exiting: sendText failed. status=${sendRes.status} url=${evoUrl}/message/sendText/${integration.instance_name} body=${errText}`,
      )
      return
    }

    console.log(`[AI Handler] sendText OK (status=${sendRes.status})`)

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

    await supabase.from('whatsapp_messages').upsert(
      {
        user_id: userId,
        contact_id: contactId,
        message_id: messageId,
        from_me: true,
        text: responseText,
        type: 'text',
        timestamp: new Date().toISOString(),
        raw: result,
      },
      { onConflict: 'user_id,message_id' },
    )

    await supabase
      .from('whatsapp_contacts')
      .update({
        pipeline_stage: 'Em Conversa',
        last_message_at: new Date().toISOString(),
      })
      .eq('id', contactId)

    console.log(`[AI Handler] Successfully auto-responded to contact ${contactId} and saved to DB.`)
  } catch (error) {
    console.error('[AI Handler] Unhandled exception in processAiResponse:', error)
  }
}
