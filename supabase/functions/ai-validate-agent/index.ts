import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'
const ASSEMBLYAI_BASE = 'https://api.assemblyai.com'

interface ValidationResult {
  ok: boolean
  error?: string
  detail?: string
}

async function testOpenRouter(apiKey: string, modelId: string): Promise<ValidationResult> {
  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'Say hi' }],
        temperature: 0.7,
      }),
    })

    const body = await res.json()

    if (!res.ok) {
      const errorData = body?.error || body
      const providerName = errorData?.metadata?.provider_name ?? 'unknown'
      const rawMsg =
        errorData?.metadata?.raw ||
        (typeof errorData?.message === 'string' ? errorData.message : JSON.stringify(errorData))

      console.error(`[ai-validate-agent] OpenRouter Error:`, JSON.stringify(errorData))

      return {
        ok: false,
        error: `Erro no provedor ${providerName}: ${rawMsg}`,
        detail: JSON.stringify(errorData).slice(0, 500),
      }
    }

    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: `Network error: ${err.message}` }
  }
}

async function testAssemblyAI(apiKey: string): Promise<ValidationResult> {
  try {
    const res = await fetch(`${ASSEMBLYAI_BASE}/v2/account`, {
      headers: { authorization: apiKey },
    })

    if (res.status === 401) {
      return { ok: false, error: 'Chave inválida (401 Unauthorized)' }
    }
    if (!res.ok) {
      const body = await res.text()
      return { ok: false, error: `HTTP ${res.status}`, detail: body.slice(0, 200) }
    }

    const account = await res.json()
    return { ok: true, detail: `account_id=${account?.id ?? 'ok'}` }
  } catch (err: any) {
    return { ok: false, error: `Network error: ${err.message}` }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing Authorization header')

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser()
    if (userError || !user) throw new Error('Unauthorized')

    const { api_key_id, model_id, audio_api_key_id } = await req.json()

    const admin = createClient(supabaseUrl, supabaseServiceKey)
    const results: { openrouter?: ValidationResult; assemblyai?: ValidationResult } = {}

    // --- OpenRouter ---
    if (api_key_id && model_id) {
      const { data: keyRow, error: keyErr } = await admin
        .from('user_api_keys')
        .select('key')
        .eq('id', api_key_id)
        .eq('user_id', user.id)
        .single()

      if (keyErr || !keyRow) {
        console.error(
          `[ai-validate-agent] key_not_found api_key_id=${api_key_id} user_id=${user.id}`,
        )
        results.openrouter = { ok: false, error: 'Chave de IA não encontrada' }
      } else {
        console.log(`[ai-validate-agent] testing openrouter model=${model_id} user=${user.id}`)
        results.openrouter = await testOpenRouter(keyRow.key, model_id)
        if (!results.openrouter.ok) {
          console.error(
            `[ai-validate-agent] OPENROUTER_FAIL user=${user.id} model=${model_id} ` +
              `error="${results.openrouter.error}" detail="${results.openrouter.detail}"`,
          )
        } else {
          console.log(`[ai-validate-agent] openrouter_ok model=${model_id} user=${user.id}`)
        }
      }
    } else if (!api_key_id) {
      results.openrouter = { ok: false, error: 'Chave OpenRouter não configurada' }
    } else {
      results.openrouter = { ok: false, error: 'Modelo não selecionado' }
    }

    // --- AssemblyAI ---
    if (audio_api_key_id) {
      const { data: audioKeyRow, error: audioKeyErr } = await admin
        .from('user_api_keys')
        .select('key')
        .eq('id', audio_api_key_id)
        .eq('user_id', user.id)
        .single()

      if (audioKeyErr || !audioKeyRow) {
        console.error(
          `[ai-validate-agent] audio_key_not_found audio_api_key_id=${audio_api_key_id}`,
        )
        results.assemblyai = { ok: false, error: 'Chave AssemblyAI não encontrada' }
      } else {
        console.log(`[ai-validate-agent] testing assemblyai user=${user.id}`)
        results.assemblyai = await testAssemblyAI(audioKeyRow.key)
        if (!results.assemblyai.ok) {
          console.error(
            `[ai-validate-agent] ASSEMBLYAI_FAIL user=${user.id} ` +
              `error="${results.assemblyai.error}" detail="${results.assemblyai.detail}"`,
          )
        } else {
          console.log(
            `[ai-validate-agent] assemblyai_ok user=${user.id} ${results.assemblyai.detail ?? ''}`,
          )
        }
      }
    }

    return new Response(JSON.stringify({ results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err: any) {
    console.error(`[ai-validate-agent] error="${err.message}"`)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
