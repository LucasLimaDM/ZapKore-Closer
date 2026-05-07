import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { Webhook } from 'npm:standardwebhooks@1.0.0'
import { corsHeaders } from '../_shared/cors.ts'
import { renderTemplate } from '../_shared/email-templates.ts'

interface HookPayload {
  user: { email: string; user_metadata?: Record<string, unknown> }
  email_data: {
    token: string
    token_hash: string
    redirect_to?: string
    email_action_type: string
    site_url: string
    token_new?: string
    token_hash_new?: string
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const rawSecret = Deno.env.get('SEND_EMAIL_HOOK_SECRET')
  if (!rawSecret)
    return new Response(
      JSON.stringify({ error: { http_code: 500, message: 'Hook secret not configured' } }),
      { status: 500 },
    )

  // Dashboard delivers "v1,whsec_<base64>" — standardwebhooks expects only the base64 part
  const secret = rawSecret.replace(/^v1,whsec_/, '')

  let payload: HookPayload
  try {
    const raw = await req.text()
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => {
      headers[k] = v
    })
    const wh = new Webhook(secret)
    payload = wh.verify(raw, headers) as HookPayload
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: { http_code: 401, message: `Signature verification failed: ${err}` },
      }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const { user, email_data } = payload
  const { subject, html } = renderTemplate(email_data)

  const from = Deno.env.get('EMAIL_FROM_FULL') ?? 'Zapkore <noreply@zapkore.com.br>'
  const apiKey = Deno.env.get('RESEND_API_KEY')
  if (!apiKey)
    return new Response(
      JSON.stringify({ error: { http_code: 500, message: 'RESEND_API_KEY not set' } }),
      { status: 500 },
    )

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: user.email, subject, html }),
  })

  if (!res.ok) {
    const body = await res.text()
    console.error(`Resend error ${res.status}:`, body)
    return new Response(JSON.stringify({ error: { http_code: res.status, message: body } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
})
