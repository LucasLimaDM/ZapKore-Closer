import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from '@supabase/supabase-js'
import { corsHeaders } from '../_shared/cors.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing Auth')

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const geminiApiKey = Deno.env.get('GEMINI_API_KEY')

    if (!geminiApiKey) throw new Error('System Gemini API key missing')

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })

    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) throw new Error('Unauthorized')

    const { data: integ } = await supabase
      .from('user_integrations')
      .select('*')
      .eq('user_id', user.id)
      .single()

    const { data: job, error: jobError } = await supabase
      .from('import_jobs')
      .insert({
        user_id: user.id,
        type: 'ai_classification',
        status: 'running',
        total_items: 0,
        processed_items: 0,
      })
      .select()
      .single()

    if (jobError) throw new Error(`Failed to create job: ${jobError.message}`)

    const runClassification = async () => {
      try {
        const evoUrlRaw = integ?.evolution_api_url || Deno.env.get('EVOLUTION_API_URL')
        const evoUrl = evoUrlRaw ? evoUrlRaw.replace(/\/$/, '') : ''
        const evoKey = integ?.evolution_api_key || Deno.env.get('EVOLUTION_API_KEY')
        const instanceName = integ?.instance_name

        let validJids: string[] = []

        if (evoUrl && evoKey && instanceName) {
          const chatsUrl = `${evoUrl}/chat/findChats/${instanceName}`
          const chatsRes = await fetch(chatsUrl, {
            method: 'POST',
            headers: { apikey: evoKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ where: {}, sort: 'desc', page: 1, offset: 0 }),
          })

          if (chatsRes.ok) {
            const rawChats = await chatsRes.json()
            let cList: any[] = []
            if (Array.isArray(rawChats)) cList = rawChats
            else if (rawChats?.records && Array.isArray(rawChats.records)) cList = rawChats.records
            else if (rawChats?.data && Array.isArray(rawChats.data)) cList = rawChats.data
            else if (rawChats?.chats && Array.isArray(rawChats.chats)) cList = rawChats.chats

            validJids = cList
              .map((c: any) => c.remoteJid || c.jid || c.id)
              .filter(
                (jid: string) => jid && !jid.includes('@g.us') && !jid.includes('status@broadcast'),
              )
              .slice(0, 100)
          }
        }

        if (validJids.length === 0) {
          await supabase
            .from('import_jobs')
            .update({ status: 'completed', total_items: 0, processed_items: 0 })
            .eq('id', job.id)
          return
        }

        const { data: contacts } = await supabase
          .from('whatsapp_contacts')
          .select('id, remote_jid')
          .eq('user_id', user.id)
          .in('remote_jid', validJids)

        if (!contacts || contacts.length === 0) {
          await supabase
            .from('import_jobs')
            .update({ status: 'completed', total_items: 0, processed_items: 0 })
            .eq('id', job.id)
          return
        }

        await supabase.from('import_jobs').update({ total_items: contacts.length }).eq('id', job.id)

        let processed = 0

        for (const contact of contacts) {
          const { data: messages } = await supabase
            .from('whatsapp_messages')
            .select('text, from_me')
            .eq('contact_id', contact.id)
            .order('timestamp', { ascending: false })
            .limit(100)

          if (!messages || messages.length === 0) {
            await supabase
              .from('whatsapp_contacts')
              .update({
                classification: 'Cold',
                score: 0,
                ai_analysis_summary: 'No message history',
              })
              .eq('id', contact.id)
          } else {
            const conversation = messages
              .reverse()
              .map((m: any) => `${m.from_me ? 'Me' : 'Contact'}: ${m.text}`)
              .join('\n')

            const prompt = `
You are an expert Warm Market analyst. Your job is to analyze a WhatsApp conversation between "Me" (the user) and "Contact" to determine how suitable this Contact is for a warm market approach.

Warm Market = people with whom there is an existing relationship of trust, making them more receptive to business opportunities, referrals, or product/service recommendations.

## ANALYSIS FRAMEWORK

Analyze the conversation evaluating the following signal categories. Each signal detected adds or subtracts from the score (starts at 0, capped at 0–100).

### RELATIONSHIP QUALITY SIGNALS
- **proximidade_pessoal** (+12): Shares personal life details, family matters, emotions, or confides in Me. Indicates trust and closeness.
- **reciprocidade** (+10): Both parties initiate conversations, ask about each other, and show mutual interest. The relationship is not one-sided.
- **historico_positivo** (+8): References to past shared experiences, inside jokes, long-standing friendship, or collaborative history.
- **tom_caloroso** (+6): Uses affectionate language, nicknames, emojis, voice notes, or shows genuine warmth.

### ENGAGEMENT & AVAILABILITY SIGNALS
- **frequencia_interacao** (+10): Regular and consistent communication pattern (not sporadic or dying out).
- **respostas_rapidas** (+6): Contact responds promptly and with substance (not just "ok" or "👍").
- **disponibilidade** (+8): Contact shows willingness to meet, call, or spend time. Suggests openness.
- **recencia_7d** (+8): Last meaningful interaction within the past 7 days.
- **recencia_30d** (+4): Last meaningful interaction within 8–30 days.

### BUSINESS OPPORTUNITY SIGNALS
- **interesse_profissional** (+15): Contact discusses career goals, side income, financial aspirations, or dissatisfaction with current job/income.
- **dor_ou_necessidade** (+12): Expresses a problem, frustration, or need that your product/service/opportunity could address.
- **abertura_a_sugestoes** (+10): Contact has previously accepted recommendations, asked for advice, or shown they value Me's opinion.
- **autoridade_decisao** (+8): Indicates they make their own financial/business decisions (not dependent on others for approval).
- **perfil_empreendedor** (+10): Shows entrepreneurial mindset, talks about business, investments, or personal growth.
- **rede_influente** (+8): Contact appears well-connected, mentions many people, or is a community/group leader.

### DIRECT INTENT SIGNALS
- **intencao_compra** (+20): Explicitly expresses interest in buying, trying, or learning about a product/service.
- **pedido_indicacao** (+12): Contact asks Me for recommendations or referrals (shows trust in Me's judgment).
- **abertura_reuniao** (+15): Willing or eager to schedule a meeting, call, or demo.

### NEGATIVE SIGNALS
- **conversa_morta** (-8): Conversation has died out. Contact stopped responding or only gives minimal replies.
- **desinteresse_explicito** (-15): Contact has explicitly said they're not interested in business topics or opportunities.
- **rejeicao** (-25): Contact has declined a previous offer, pitch, or meeting request.
- **incomodo** (-60): Contact has expressed annoyance, asked to stop being contacted, or shown hostility. This is a HARD negative — almost always results in "Do Not Contact".
- **relacao_unilateral** (-10): Only Me initiates conversations. Contact never reaches out first. Low reciprocity.
- **respostas_secas** (-6): Contact consistently responds with very short, low-effort messages ("ok", "hmm", "👍").
- **bloqueio_ou_silencio** (-40): Evidence of being blocked, muted, or completely ignored for an extended period.

## SCORING RULES

1. Start at **0 points**.
2. Add/subtract based on ALL detected signals.
3. A single signal can only be counted ONCE (no double-counting).
4. Cap the final score between **0 and 100**.
5. If multiple negative signals stack, the Contact may fall to "Do Not Contact" even with some positives.

## CATEGORIES

| Category         | Criteria |
|-----------------|----------|
| **Hot**          | Score >= 75. Strong relationship + clear business opportunity signals. High-priority contact. |
| **Warm**         | Score 50–74. Good relationship with some openness to opportunities. Worth nurturing. |
| **Lukewarm**     | Score 25–49. Relationship exists but engagement is moderate. Needs warming up before any approach. |
| **Cold**         | Score 10–24. Weak or dormant relationship. Low engagement. Not ready for approach. |
| **Do Not Contact** | Score < 10, OR any detection of **incomodo** or **bloqueio_ou_silencio**. Respect boundaries — do not approach. |

## IMPORTANT GUIDELINES

- Focus on the RELATIONSHIP QUALITY first, business signals second. A strong relationship is the foundation of warm market.
- Consider the OVERALL TONE of the conversation, not just individual messages.
- If the conversation is too short (< 5 messages), note this as a limitation and be conservative with scoring.
- Cultural context matters: in Brazilian Portuguese conversations, informal language and playful tone are normal and indicate closeness.
- When in doubt, score LOWER. It's better to warm up a contact gradually than to approach too aggressively.

## OUTPUT FORMAT

Return ONLY a valid JSON object with no additional text:

{
  "score": <number 0-100>,
  "category": "Hot" | "Warm" | "Lukewarm" | "Cold" | "Do Not Contact",
  "signals_detected": ["signal_1", "signal_2", ...],
  "relationship_strength": "strong" | "moderate" | "weak" | "nonexistent",
  "recommended_action": "<one-line suggestion on best next step>",
  "reasoning": "<2-3 sentence explanation of the classification>"
}
`

            try {
              // Ensure we use a stable and valid endpoint to avoid 404s
              const aiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${geminiApiKey}`
              console.log(
                `[AI Classifier] Calling Gemini API at v1beta/models/gemini-3.1-flash-lite-preview...`,
              )
              const aiRes = await fetch(aiUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  contents: [
                    {
                      role: 'user',
                      parts: [
                        { text: `${prompt}\n\n## CONVERSATION TO ANALYZE:\n${conversation}` },
                      ],
                    },
                  ],
                  generationConfig: {
                    responseMimeType: 'application/json',
                    temperature: 0.2,
                  },
                }),
              })

              if (aiRes.ok) {
                const aiData = await aiRes.json()
                const textResponse = aiData.candidates?.[0]?.content?.parts?.[0]?.text

                if (textResponse) {
                  const result = JSON.parse(textResponse)
                  await supabase
                    .from('whatsapp_contacts')
                    .update({
                      classification: result.category,
                      score: result.score,
                      ai_analysis_summary: result.reasoning,
                    })
                    .eq('id', contact.id)
                }
              } else {
                console.error(
                  `Gemini API Error for contact ${contact.id}: Status ${aiRes.status} -`,
                  await aiRes.text(),
                )
              }
            } catch (e) {
              console.error('Failed to classify contact', contact.id, e)
            }
          }

          processed++

          if (processed % 5 === 0 || processed === contacts.length) {
            await supabase
              .from('import_jobs')
              .update({ processed_items: processed })
              .eq('id', job.id)
          }
        }

        await supabase
          .from('import_jobs')
          .update({ status: 'completed', processed_items: processed })
          .eq('id', job.id)
      } catch (jobError) {
        console.error('[Background] AI Classification failed:', jobError)
        await supabase.from('import_jobs').update({ status: 'failed' }).eq('id', job.id)
      }
    }

    if (
      typeof (globalThis as any).EdgeRuntime !== 'undefined' &&
      typeof (globalThis as any).EdgeRuntime.waitUntil === 'function'
    ) {
      ;(globalThis as any).EdgeRuntime.waitUntil(runClassification())
    } else {
      runClassification().catch(console.error)
    }

    return new Response(JSON.stringify({ success: true, job_id: job.id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
