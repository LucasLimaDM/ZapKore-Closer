import { createClient } from 'jsr:@supabase/supabase-js@2'
import { transcribeAudio } from './assemblyai.ts'
import { processAiResponse } from './ai-handler.ts'

export async function processAudioMessage(
  userId: string,
  contactId: string,
  messageId: string,
  supabaseUrl: string,
  supabaseKey: string,
  triggerVersion: number,
  evoUrl: string,
  evoKey: string,
  instanceName: string,
) {
  console.log(`[Audio Handler] Starting for message ${messageId}, contact ${contactId}`)
  const supabase = createClient(supabaseUrl, supabaseKey)

  try {
    const { data: contact } = await supabase
      .from('whatsapp_contacts')
      .select('ai_agent_id')
      .eq('id', contactId)
      .single()

    if (!contact?.ai_agent_id) {
      console.log(`[Audio Handler] No agent assigned to contact ${contactId}, skipping`)
      return
    }

    // Idempotency: skip transcription if already done
    const { data: msg } = await supabase
      .from('whatsapp_messages')
      .select('transcript')
      .eq('message_id', messageId)
      .eq('user_id', userId)
      .single()

    if (!msg?.transcript) {
      const { data: agent } = await supabase
        .from('ai_agents')
        .select('audio_api_key_id')
        .eq('id', contact.ai_agent_id)
        .single()

      if (agent?.audio_api_key_id) {
        const { data: audioKey } = await supabase
          .from('user_api_keys')
          .select('key')
          .eq('id', agent.audio_api_key_id)
          .eq('key_type', 'audio')
          .single()

        if (audioKey?.key) {
          const evoRes = await fetch(
            `${evoUrl}/chat/getBase64FromMediaMessage/${instanceName}`,
            {
              method: 'POST',
              headers: { apikey: evoKey, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                message: { key: { id: messageId } },
                convertToMp4: false,
              }),
            },
          )

          if (evoRes.ok) {
            const { base64 } = await evoRes.json()
            if (base64) {
              const binaryStr = atob(base64)
              const audioBytes = new Uint8Array(binaryStr.length)
              for (let i = 0; i < binaryStr.length; i++) {
                audioBytes[i] = binaryStr.charCodeAt(i)
              }

              const transcript = await transcribeAudio(audioBytes, audioKey.key)
              if (transcript) {
                await supabase
                  .from('whatsapp_messages')
                  .update({ transcript })
                  .eq('message_id', messageId)
                  .eq('user_id', userId)
                console.log(`[Audio Handler] Transcript saved for message ${messageId}`)
              }
            }
          } else {
            console.error('[Audio Handler] Failed to download audio from Evolution:', evoRes.status)
          }
        }
      }
    } else {
      console.log(`[Audio Handler] Message ${messageId} already transcribed, skipping`)
    }

    await processAiResponse(userId, contactId, supabaseUrl, supabaseKey, triggerVersion)
  } catch (err) {
    console.error('[Audio Handler] Unexpected error:', err)
  }
}
