import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const geminiApiKey = Deno.env.get('GEMINI_API_KEY')

    if (!geminiApiKey) throw new Error('GEMINI_API_KEY is missing')

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
            .map((m: any) => `${m.from_me ? 'Me' : 'Contact'}: ${m.text}`)
            .join('\n')

          const prompt = `
You are an AI assistant managing a CRM pipeline for WhatsApp conversations.
The following conversation has been inactive for a while.
Analyze the history and decide if the conversation was RESOLVED (the user's questions were answered, a deal was closed, a meeting was booked, or the chat reached a natural conclusion) or LOST/ABANDONED (the contact stopped responding without a conclusion, showed no interest, or declined).

Return ONLY a valid JSON object:
{
  "stage": "Resolvido" | "Perdido",
  "reasoning": "brief explanation"
}

CONVERSATION:
${history}
          `

          const aiUrl = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`
          const aiRes = await fetch(aiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
            }),
          })

          if (aiRes.ok) {
            const aiData = await aiRes.json()
            const textResponse = aiData.candidates?.[0]?.content?.parts?.[0]?.text
            if (textResponse) {
              const result = JSON.parse(textResponse)
              stage = result.stage === 'Resolvido' ? 'Resolvido' : 'Perdido'
              reasoning = result.reasoning || ''
            }
          } else {
            console.error(`Gemini Error for contact ${contact.id}:`, await aiRes.text())
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
