import { createClient } from 'jsr:@supabase/supabase-js@2'

export async function processAiResponse(
  userId: string,
  contactId: string,
  supabaseUrl: string,
  supabaseKey: string,
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

    // REQUIREMENT: AI Agent must be explicitly assigned to the contact. Disabled by default.
    if (!contact.ai_agent_id) {
      console.log(
        `[AI Handler] Exiting: AI agent is disabled by default for contact ${contactId}. No ai_agent_id assigned.`,
      )
      return
    }

    console.log(
      `[AI Handler] Contact has agent assigned: ${contact.ai_agent_id}. Checking if active...`,
    )
    const { data: agent, error: agentError } = await supabase
      .from('ai_agents')
      .select('*')
      .eq('id', contact.ai_agent_id)
      .eq('is_active', true)
      .single()

    if (agentError || !agent) {
      console.log(
        `[AI Handler] Exiting: Assigned agent ${contact.ai_agent_id} is either inactive, deleted, or error loading.`,
      )
      return
    }

    console.log(
      `[AI Handler] Agent selected: ${agent.id} (Name: "${agent.name}", is_active: ${agent.is_active})`,
    )

    const apiKey = agent.gemini_api_key || Deno.env.get('GEMINI_API_KEY')
    if (!apiKey) {
      console.error(
        `[AI Handler] Exiting: GEMINI_API_KEY missing from agent and environment secrets.`,
      )
      return
    }

    const { data: messages } = await supabase
      .from('whatsapp_messages')
      .select('text, from_me')
      .eq('contact_id', contactId)
      .order('timestamp', { ascending: false })
      .limit(12)

    if (!messages || messages.length === 0) {
      console.log(
        `[AI Handler] Exiting: No messages found for contact ${contactId} (remote_jid: ${contact.remote_jid}).`,
      )
      return
    }

    console.log(`[AI Handler] Retrieved ${messages.length} messages for context.`)

    const history = messages
      .reverse()
      .map((m) => `${m.from_me ? 'Me' : 'Contact'}: ${m.text}`)
      .join('\n')

    const prompt = `
System Instructions:
${agent.system_prompt}

You are acting as "Me" in the following conversation.
Read the conversation history carefully.
Respond ONLY with the exact text of your next reply. Do not use quotes, explanations, or the prefix "Me:".

CONVERSATION HISTORY:
${history}
`

    const apiUrl = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${apiKey}`
    console.log(`[AI Handler] Calling Gemini API at v1/models/gemini-2.5-flash...`)

    const aiRes = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 800,
        },
      }),
    })

    if (!aiRes.ok) {
      const errText = await aiRes.text()
      console.error(
        `[AI Handler] Exiting: Gemini API error for contact ${contactId} (remote_jid: ${contact.remote_jid}): Status ${aiRes.status} - Details:`,
        errText,
      )
      return
    }

    const aiData = await aiRes.json()
    const responseText = aiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim()

    if (!responseText) {
      console.error(
        `[AI Handler] Exiting: Empty response from Gemini API for contact ${contactId}. Raw response:`,
        JSON.stringify(aiData),
      )
      return
    }

    console.log(`[AI Handler] Gemini generated text: "${responseText}"`)

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
      `[AI Handler] Attempting to send message to Evolution API. Phone: ${contact.remote_jid}`,
    )

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
        `[AI Handler] Exiting: Failed to send message via Evolution API. HTTP Response: ${sendRes.status} Error:`,
        errText,
      )
      return
    }

    const result = await sendRes.json()
    const messageId = result?.key?.id || result?.id || crypto.randomUUID()
    const actualRemoteJid = result?.key?.remoteJid

    // Se enviamos para um @lid e a Evolution resolveu para um phone JID,
    // atualiza o contato e contact_identity para evitar duplicatas futuras
    if (
      actualRemoteJid &&
      actualRemoteJid.includes('@s.whatsapp.net') &&
      contact.remote_jid.includes('@lid')
    ) {
      const canonicalPhone = actualRemoteJid.split('@')[0]
      if (/^\d{8,15}$/.test(canonicalPhone)) {
        console.log(`[AI Handler] Linking LID ${contact.remote_jid} → phone JID ${actualRemoteJid}`)
        await supabase
          .from('whatsapp_contacts')
          .update({ remote_jid: actualRemoteJid, phone_number: canonicalPhone })
          .eq('id', contactId)

        const { data: existingIdentity } = await supabase
          .from('contact_identity')
          .select('id')
          .eq('instance_id', integration.id)
          .eq('canonical_phone', canonicalPhone)
          .maybeSingle()

        if (existingIdentity) {
          await supabase
            .from('contact_identity')
            .update({ phone_jid: actualRemoteJid, lid_jid: contact.remote_jid })
            .eq('id', existingIdentity.id)
        } else {
          await supabase.from('contact_identity').insert({
            instance_id: integration.id,
            user_id: userId,
            canonical_phone: canonicalPhone,
            phone_jid: actualRemoteJid,
            lid_jid: contact.remote_jid,
          })
        }
      }
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
