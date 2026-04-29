import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import OpenAI from 'npm:openai'
import { corsHeaders } from '../_shared/cors.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const systemApiKey = Deno.env.get('OPENROUTER_API_KEY') || Deno.env.get('GEMINI_API_KEY')

    const supabase = createClient(supabaseUrl, supabaseKey)

    // Find contacts in 'Em Espera' that haven't had a message in 20 minutes
    const twentyMinsAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString()

    const { data: contacts, error: contactsError } = await supabase
      .from('whatsapp_contacts')
      .select('id, user_id, remote_jid, last_message_at, ai_analysis_summary')
      .eq('pipeline_stage', 'Em Espera')
      .lt('last_message_at', twentyMinsAgo)
      .limit(20)

    if (contactsError) throw contactsError
    if (!contacts || contacts.length === 0) {
      return new Response(JSON.stringify({ success: true, message: 'No contacts to process' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    console.log(`[AI Pipeline Monitor] Found ${contacts.length} contacts to process.`)

    for (const contact of contacts) {
      try {
        // Fetch the user's default agent for each contact to get their specific connection
        const { data: agent } = await supabase
          .from('ai_agents')
          .select('*, user_api_keys(*)')
          .eq('user_id', contact.user_id)
          .eq('is_default', true)
          .maybeSingle()

        const apiKey = agent?.user_api_keys?.key || systemApiKey
        const modelId = agent?.model_id || 'google/gemini-2.0-flash-lite:free'

        if (!apiKey) {
          console.warn(`[AI Pipeline Monitor] No API key found for user ${contact.user_id}. Skipping.`)
          continue
        }

        const { data: messages } = await supabase
          .from('whatsapp_messages')
          .select('text, from_me')
          .eq('contact_id', contact.id)
          .order('timestamp', { ascending: false })
          .limit(20)

        let stage = 'Perdido'
        let reasoning = 'No messages found.'

        if (messages && messages.length > 0) {
          const history = messages
            .reverse()
            .map((m: any) => ({
              role: m.from_me ? 'assistant' : 'user',
              content: m.text || ''
            }))

          const openai = new OpenAI({
            apiKey: apiKey,
            baseURL: "https://openrouter.ai/api/v1",
            defaultHeaders: {
              "HTTP-Referer": "https://zapkore-closer.com",
              "X-Title": "ZapKore Closer - Pipeline Monitor",
            }
          })

          const completion = await openai.chat.completions.create({
            model: modelId,
            messages: [
              {
                role: 'system',
                content: `You are an AI assistant managing a CRM pipeline for WhatsApp conversations. Analyze the history and decide if the conversation was RESOLVED or LOST/ABANDONED. Return JSON with 'stage' ("Resolvido" | "Perdido") and 'reasoning' (brief string).`
              },
              ...history as any
            ],
            response_format: { type: 'json_object' },
            temperature: 0.2,
          })

          const textResponse = completion.choices[0]?.message?.content
          if (textResponse) {
            const result = JSON.parse(textResponse)
            stage = result.stage === 'Resolvido' ? 'Resolvido' : 'Perdido'
            reasoning = result.reasoning || ''
          }
        }

        const newSummary = reasoning
          ? contact.ai_analysis_summary
            ? `${contact.ai_analysis_summary}\n[Pipeline]: ${reasoning}`
            : reasoning
          : contact.ai_analysis_summary

        await supabase
          .from('whatsapp_contacts')
          .update({
            pipeline_stage: stage,
            ai_analysis_summary: newSummary,
          })
          .eq('id', contact.id)
      } catch (err) {
        console.error(`[AI Pipeline Monitor] Error processing contact ${contact.id}:`, err)
      }
    }

    return new Response(JSON.stringify({ success: true, processed: contacts.length }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})

