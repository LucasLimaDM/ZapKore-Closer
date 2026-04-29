# Evolution API Per-User Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Evolution API credentials from shared env vars to per-user storage in `user_integrations`, with UI to set/update them in onboarding and settings.

**Architecture:** New edge function `evolution-credentials` handles all credential operations server-side — the full API key never reaches the frontend (only first-3 + *** + last-3 mask). Onboarding gains a step 0 (credential form before QR). Settings gains a card to view/edit credentials. Two existing functions (`evolution-create-instance`, `evolution-get-qr`) are fixed to read from DB instead of env-only.

**Tech Stack:** Deno/Supabase Edge Functions, React 19, TypeScript, Tailwind, shadcn/ui

---

## File Map

| File | Action |
|---|---|
| `supabase/functions/evolution-credentials/index.ts` | Create |
| `supabase/functions/evolution-credentials/deno.json` | Create |
| `supabase/functions/evolution-create-instance/index.ts` | Modify — fix credential resolution |
| `supabase/functions/evolution-get-qr/index.ts` | Modify — fix credential resolution |
| `src/pages/Onboarding.tsx` | Modify — add step 0 |
| `src/pages/Settings.tsx` | Modify — add credentials card |

---

### Task 1: Create `evolution-credentials` edge function

**Files:**
- Create: `supabase/functions/evolution-credentials/deno.json`
- Create: `supabase/functions/evolution-credentials/index.ts`

The function accepts two actions via POST body:
- `{ action: 'get' }` → returns masked credentials
- `{ action: 'save', url: string, api_key: string }` → validates against Evolution API then saves

Auth: reads JWT from `Authorization` header, resolves `user_id` via `supabaseClient.auth.getUser()`.

- [ ] **Step 1: Create deno.json**

```json
{
  "imports": {
    "jsr:@supabase/functions-js": "jsr:@supabase/functions-js@^2.4.1",
    "jsr:@supabase/supabase-js": "jsr:@supabase/supabase-js@^2.45.4"
  }
}
```

Save to `supabase/functions/evolution-credentials/deno.json`.

- [ ] **Step 2: Create index.ts**

```ts
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

function maskKey(key: string): string {
  if (key.length <= 6) return '***'
  return key.slice(0, 3) + '***' + key.slice(-3)
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing Authorization header')

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser()
    if (userError || !user) throw new Error('Unauthorized')

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey)

    const { action, url, api_key } = await req.json()

    if (action === 'get') {
      const { data: integ } = await supabaseAdmin
        .from('user_integrations')
        .select('evolution_api_url, evolution_api_key')
        .eq('user_id', user.id)
        .single()

      return new Response(
        JSON.stringify({
          url: integ?.evolution_api_url ?? null,
          api_key_masked: integ?.evolution_api_key ? maskKey(integ.evolution_api_key) : null,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (action === 'save') {
      if (!url || !api_key) throw new Error('url and api_key are required')

      let parsedUrl: URL
      try {
        parsedUrl = new URL(url)
      } catch {
        throw new Error('Invalid URL format')
      }
      const cleanUrl = parsedUrl.toString().replace(/\/$/, '')

      const testRes = await fetch(`${cleanUrl}/instance/fetchInstances`, {
        method: 'GET',
        headers: { apikey: api_key },
      })

      if (!testRes.ok) {
        const body = await testRes.text()
        throw new Error(`Evolution API validation failed (${testRes.status}): ${body.slice(0, 200)}`)
      }

      await supabaseAdmin
        .from('user_integrations')
        .update({ evolution_api_url: cleanUrl, evolution_api_key: api_key })
        .eq('user_id', user.id)

      return new Response(
        JSON.stringify({
          url: cleanUrl,
          api_key_masked: maskKey(api_key),
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    throw new Error(`Unknown action: ${action}`)
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
```

Save to `supabase/functions/evolution-credentials/index.ts`.

- [ ] **Step 3: Deploy function**

```bash
supabase functions deploy evolution-credentials --no-verify-jwt
```

Expected: `Deployed evolution-credentials`

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/evolution-credentials/
git commit -m "feat: add evolution-credentials edge function (masked get + validate-and-save)"
```

---

### Task 2: Fix `evolution-create-instance` credential resolution

**Files:**
- Modify: `supabase/functions/evolution-create-instance/index.ts`

Currently reads credentials from env only (lines 14–20). Must read from `user_integrations` first (already fetched at line 24), fall back to env.

- [ ] **Step 1: Replace the credential block**

Find this block (lines 12–20):
```ts
const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const evolutionApiUrlRaw = Deno.env.get('EVOLUTION_API_URL') || ''
const evolutionApiUrl = evolutionApiUrlRaw.replace(/\/$/, '')
const evolutionApiKey = Deno.env.get('EVOLUTION_API_KEY') || ''

if (!evolutionApiUrl || !evolutionApiKey) {
  throw new Error('Evolution API is not globally configured.')
}
```

Replace with:
```ts
const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
```

Then after `const { data: integ } = await supabase.from('user_integrations')...single()` and `if (!integ)` check, add:
```ts
const evolutionApiUrlRaw = integ.evolution_api_url || Deno.env.get('EVOLUTION_API_URL') || ''
const evolutionApiUrl = evolutionApiUrlRaw.replace(/\/$/, '')
const evolutionApiKey = integ.evolution_api_key || Deno.env.get('EVOLUTION_API_KEY') || ''

if (!evolutionApiUrl || !evolutionApiKey) {
  throw new Error('Evolution API credentials not configured.')
}
```

- [ ] **Step 2: Deploy**

```bash
supabase functions deploy evolution-create-instance --no-verify-jwt
```

Expected: `Deployed evolution-create-instance`

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/evolution-create-instance/index.ts
git commit -m "fix: evolution-create-instance reads credentials from user_integrations DB"
```

---

### Task 3: Fix `evolution-get-qr` credential resolution

**Files:**
- Modify: `supabase/functions/evolution-get-qr/index.ts`

Same issue as Task 2 — credentials read from env only (lines 14–20).

- [ ] **Step 1: Replace the credential block**

Find this block (lines 12–20):
```ts
const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const evolutionApiUrlRaw = Deno.env.get('EVOLUTION_API_URL') || ''
const evolutionApiUrl = evolutionApiUrlRaw.replace(/\/$/, '')
const evolutionApiKey = Deno.env.get('EVOLUTION_API_KEY') || ''

if (!evolutionApiUrl || !evolutionApiKey) {
  throw new Error('Evolution API is not globally configured.')
}
```

Replace with:
```ts
const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
```

Then after `if (!integ) throw new Error('Missing configuration')`, add:
```ts
const evolutionApiUrlRaw = integ.evolution_api_url || Deno.env.get('EVOLUTION_API_URL') || ''
const evolutionApiUrl = evolutionApiUrlRaw.replace(/\/$/, '')
const evolutionApiKey = integ.evolution_api_key || Deno.env.get('EVOLUTION_API_KEY') || ''

if (!evolutionApiUrl || !evolutionApiKey) {
  throw new Error('Evolution API credentials not configured.')
}
```

- [ ] **Step 2: Deploy**

```bash
supabase functions deploy evolution-get-qr --no-verify-jwt
```

Expected: `Deployed evolution-get-qr`

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/evolution-get-qr/index.ts
git commit -m "fix: evolution-get-qr reads credentials from user_integrations DB"
```

---

### Task 4: Add step 0 to Onboarding

**Files:**
- Modify: `src/pages/Onboarding.tsx`

Steps go 2→3. Step 0 = credential form. On mount, call `evolution-credentials` GET — if `api_key_masked` is non-null, skip to step 1. Progress indicator gets a third icon (`KeyRound` before `Smartphone`).

- [ ] **Step 1: Replace full `Onboarding.tsx`**

```tsx
import { useState, useEffect, useRef } from 'react'
import { useIntegration } from '@/hooks/use-integration'
import { useLanguage } from '@/hooks/use-language'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Loader2, Smartphone, BrainCircuit, CheckCircle2, KeyRound } from 'lucide-react'
import { supabase } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { useNavigate } from 'react-router-dom'

export default function Onboarding() {
  const { integration, setIntegration } = useIntegration()
  const { t } = useLanguage()
  const navigate = useNavigate()

  const [step, setStep] = useState<0 | 1 | 2>(0)
  const [checkingCredentials, setCheckingCredentials] = useState(true)
  const [qrCode, setQrCode] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState<string>('')
  const [progress, setProgress] = useState(0)
  const syncStarted = useRef(false)

  // Credentials form state
  const [credUrl, setCredUrl] = useState('')
  const [credKey, setCredKey] = useState('')
  const [savingCredentials, setSavingCredentials] = useState(false)

  useEffect(() => {
    if (integration?.is_setup_completed) {
      navigate('/app', { replace: true })
    }
  }, [integration?.is_setup_completed, navigate])

  // Check if credentials already exist — skip step 0 if so
  useEffect(() => {
    const checkCredentials = async () => {
      try {
        const { data, error } = await supabase.functions.invoke('evolution-credentials', {
          body: { action: 'get' },
        })
        if (!error && data?.api_key_masked) {
          setStep(1)
        }
      } catch {
        // No credentials set — stay on step 0
      } finally {
        setCheckingCredentials(false)
      }
    }
    checkCredentials()
  }, [])

  const handleSaveCredentials = async () => {
    if (!credUrl.trim() || !credKey.trim()) {
      toast.error('URL e API Key são obrigatórios')
      return
    }
    setSavingCredentials(true)
    try {
      const { data, error } = await supabase.functions.invoke('evolution-credentials', {
        body: { action: 'save', url: credUrl.trim(), api_key: credKey.trim() },
      })
      if (error || data?.error) throw new Error(data?.error || error?.message || 'Erro ao salvar')
      setStep(1)
    } catch (e: any) {
      toast.error(e.message || 'Credenciais inválidas. Verifique a URL e a API Key.')
    } finally {
      setSavingCredentials(false)
    }
  }

  useEffect(() => {
    let interval: NodeJS.Timeout
    if (step === 1 && integration?.status !== 'CONNECTED') {
      const fetchQR = async () => {
        if (!integration?.id) return
        try {
          const { data } = await supabase.functions.invoke('evolution-get-qr', {
            body: { integrationId: integration.id },
          })
          if (data?.base64) {
            setQrCode(data.base64)
            if (integration.status !== 'WAITING_QR') {
              setIntegration((prev: any) => (prev ? { ...prev, status: 'WAITING_QR' } : null))
            }
          }
          if (data?.connected) {
            setIntegration((prev: any) => (prev ? { ...prev, status: 'CONNECTED' } : null))
            setStep(2)
          }
        } catch {
          // Silent catch
        }
      }
      fetchQR()
      interval = setInterval(fetchQR, 5000)
    } else if (step === 1 && integration?.status === 'CONNECTED') {
      setStep(2)
    }
    return () => { if (interval) clearInterval(interval) }
  }, [step, integration?.id, integration?.status, setIntegration])

  useEffect(() => {
    if (step === 2 && !syncStarted.current) {
      syncStarted.current = true
      handleSync()
    }
  }, [step])

  const pollJob = async (jobId: string, maxSeconds: number = 10) => {
    return new Promise<void>((resolve) => {
      let attempts = 0
      const maxAttempts = Math.ceil(maxSeconds / 2)
      const interval = setInterval(async () => {
        attempts++
        const { data, error } = await supabase
          .from('import_jobs')
          .select('status')
          .eq('id', jobId)
          .single()
        if (error || data?.status === 'failed' || data?.status === 'completed' || attempts >= maxAttempts) {
          clearInterval(interval)
          resolve()
        }
      }, 2000)
    })
  }

  const handleSync = async () => {
    const currentIntegrationId = integration?.id

    const completeSetup = async () => {
      try {
        if (currentIntegrationId) {
          const { error } = await supabase
            .from('user_integrations')
            .update({ is_setup_completed: true })
            .eq('id', currentIntegrationId)

          if (!error) {
            const { data } = await supabase
              .from('user_integrations')
              .select('is_setup_completed')
              .eq('id', currentIntegrationId)
              .single()

            if (data?.is_setup_completed) {
              setIntegration((prev: any) => (prev ? { ...prev, is_setup_completed: true } : null))
            }
          }
        }
      } catch {
        setIntegration((prev: any) => (prev ? { ...prev, is_setup_completed: true } : null))
      } finally {
        navigate('/app', { replace: true })
      }
    }

    try {
      setSyncStatus(t('downloading_contacts'))
      setProgress(20)
      const { data: cData } = await supabase.functions.invoke('evolution-sync-contacts')
      if (cData?.job_id) await pollJob(cData.job_id, 10)

      setSyncStatus(t('downloading_messages'))
      setProgress(60)
      const { data: mData } = await supabase.functions.invoke('evolution-sync-messages')
      if (mData?.job_id) await pollJob(mData.job_id, 10)

      setSyncStatus('Removendo duplicatas...')
      setProgress(85)
      const { data: dData } = await supabase.functions.invoke('dedupe-lid-contacts')
      if (dData?.job_id) await pollJob(dData.job_id, 10)

      setProgress(100)
      setSyncStatus(t('setup_complete') || 'Integração concluída! Redirecionando para o CRM...')
      toast.success(t('onboarding_complete'))
      setTimeout(completeSetup, 1000)
    } catch (err: any) {
      toast.error(err.message || t('sync_failed_onboarding'))
      setSyncStatus(t('error_setup'))
      setTimeout(completeSetup, 1500)
    }
  }

  if (checkingCredentials) {
    return (
      <div className="w-full max-w-lg mx-auto p-4 flex justify-center pt-20">
        <Loader2 className="animate-spin h-8 w-8 text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="w-full max-w-lg mx-auto p-4">
      <Card className="shadow-elevation border border-border/40 rounded-[2.5rem] bg-card">
        <CardHeader className="text-center space-y-6 pb-6 pt-12">
          <div className="flex justify-center mb-2">
            <div className="flex items-center gap-3">
              <div
                className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all ${step >= 0 ? 'bg-primary text-primary-foreground shadow-md' : 'bg-muted text-muted-foreground'}`}
              >
                <KeyRound size={20} />
              </div>
              <div className={`w-10 h-0.5 transition-colors ${step >= 1 ? 'bg-primary' : 'bg-border'}`} />
              <div
                className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all ${step >= 1 ? 'bg-primary text-primary-foreground shadow-md' : 'bg-muted text-muted-foreground'}`}
              >
                <Smartphone size={20} />
              </div>
              <div className={`w-10 h-0.5 transition-colors ${step >= 2 ? 'bg-primary' : 'bg-border'}`} />
              <div
                className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all ${step >= 2 ? 'bg-primary text-primary-foreground shadow-md' : 'bg-muted text-muted-foreground'}`}
              >
                <BrainCircuit size={20} />
              </div>
            </div>
          </div>
          <div className="space-y-2">
            <CardTitle className="text-3xl font-semibold tracking-tight">
              {step === 0 && 'Configurar Evolution API'}
              {step === 1 && t('link_whatsapp')}
              {step === 2 && t('setting_up_crm')}
            </CardTitle>
            <CardDescription className="text-[15px] font-medium px-4 text-muted-foreground">
              {step === 0 && 'Informe a URL e a API Key da sua instância Evolution API'}
              {step === 1 && t('scan_qr_desc')}
              {step === 2 && t('please_wait_sync')}
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent className="px-10 pb-12">
          {step === 0 && (
            <div className="flex flex-col gap-5 animate-in fade-in duration-300">
              <div className="flex flex-col gap-2">
                <Label htmlFor="evo-url">URL da Evolution API</Label>
                <Input
                  id="evo-url"
                  type="url"
                  placeholder="https://api.seudominio.com"
                  value={credUrl}
                  onChange={(e) => setCredUrl(e.target.value)}
                  disabled={savingCredentials}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="evo-key">API Key</Label>
                <Input
                  id="evo-key"
                  type="password"
                  placeholder="Sua API Key"
                  value={credKey}
                  onChange={(e) => setCredKey(e.target.value)}
                  disabled={savingCredentials}
                />
              </div>
              <Button
                onClick={handleSaveCredentials}
                disabled={savingCredentials}
                className="rounded-full h-11 font-semibold mt-2"
              >
                {savingCredentials ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Verificando...</>
                ) : (
                  'Verificar e continuar'
                )}
              </Button>
            </div>
          )}

          {step === 1 && (
            <div className="flex flex-col items-center py-4 space-y-8">
              {qrCode ? (
                <div className="p-4 bg-white rounded-3xl shadow-elevation border border-border/40 animate-in fade-in zoom-in-95 duration-500">
                  <img
                    src={qrCode.startsWith('data:') ? qrCode : `data:image/png;base64,${qrCode}`}
                    alt="WhatsApp QR"
                    className="w-56 h-56 rounded-xl"
                  />
                </div>
              ) : (
                <div className="w-64 h-64 bg-muted/50 flex items-center justify-center rounded-3xl border border-dashed border-border">
                  <Loader2 className="animate-spin h-10 w-10 text-muted-foreground" />
                </div>
              )}
              <p className="text-[13px] text-muted-foreground font-medium text-center max-w-xs leading-relaxed">
                {t('open_whatsapp_scan')}
              </p>
            </div>
          )}

          {step === 2 && (
            <div className="py-10 space-y-8 text-center animate-in fade-in duration-500">
              <Progress value={progress} className="h-2" />
              <div className="flex items-center justify-center gap-3 text-lg font-semibold text-foreground">
                {progress >= 100 ? (
                  <CheckCircle2 className="h-5 w-5 text-primary" />
                ) : (
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                )}
                {syncStatus}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm build 2>&1 | head -30
```

Expected: no errors related to `Onboarding.tsx`.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Onboarding.tsx
git commit -m "feat: add credentials step 0 to onboarding before QR scan"
```

---

### Task 5: Add credentials card to Settings

**Files:**
- Modify: `src/pages/Settings.tsx`

New card above the existing WhatsApp Connection card. Loads masked credentials via `evolution-credentials` GET on mount. Shows URL + masked key. Edit mode opens blank input fields inline; save calls POST.

- [ ] **Step 1: Replace full `Settings.tsx`**

```tsx
import { useState, useEffect } from 'react'
import { useIntegration } from '@/hooks/use-integration'
import { useLanguage } from '@/hooks/use-language'
import { supabase } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardFooter,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { Loader2, MessageCircle, Plug, Unplug, CheckCircle2, KeyRound } from 'lucide-react'

export default function Settings() {
  const { integration, setIntegration, loading: integrationLoading } = useIntegration()
  const { t } = useLanguage()

  const [qrCode, setQrCode] = useState<string | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)

  // Credentials state
  const [credUrl, setCredUrl] = useState<string | null>(null)
  const [credMasked, setCredMasked] = useState<string | null>(null)
  const [credLoading, setCredLoading] = useState(true)
  const [editingCreds, setEditingCreds] = useState(false)
  const [editUrl, setEditUrl] = useState('')
  const [editKey, setEditKey] = useState('')
  const [savingCreds, setSavingCreds] = useState(false)

  useEffect(() => {
    if (integration?.status === 'CONNECTED') setQrCode(null)
  }, [integration?.status])

  useEffect(() => {
    const loadCredentials = async () => {
      try {
        const { data, error } = await supabase.functions.invoke('evolution-credentials', {
          body: { action: 'get' },
        })
        if (!error && data) {
          setCredUrl(data.url)
          setCredMasked(data.api_key_masked)
        }
      } finally {
        setCredLoading(false)
      }
    }
    loadCredentials()
  }, [])

  const handleSaveCreds = async () => {
    if (!editUrl.trim() || !editKey.trim()) {
      toast.error('URL e API Key são obrigatórios')
      return
    }
    setSavingCreds(true)
    try {
      const { data, error } = await supabase.functions.invoke('evolution-credentials', {
        body: { action: 'save', url: editUrl.trim(), api_key: editKey.trim() },
      })
      if (error || data?.error) throw new Error(data?.error || error?.message || 'Erro ao salvar')
      setCredUrl(data.url)
      setCredMasked(data.api_key_masked)
      setEditingCreds(false)
      setEditUrl('')
      setEditKey('')
      toast.success('Credenciais atualizadas com sucesso')
    } catch (e: any) {
      toast.error(e.message || 'Credenciais inválidas. Verifique a URL e a API Key.')
    } finally {
      setSavingCreds(false)
    }
  }

  const handleCancelEdit = () => {
    setEditingCreds(false)
    setEditUrl('')
    setEditKey('')
  }

  const handleConnect = async () => {
    if (!integration) return
    setIsConnecting(true)
    setQrCode(null)

    let retries = 0
    const fetchQr = async () => {
      try {
        const { data, error } = await supabase.functions.invoke('evolution-get-qr', {
          body: { integrationId: integration.id },
        })

        if (error) throw error

        if (data?.base64) {
          setQrCode(data.base64)
          if (integration.status !== 'WAITING_QR') {
            setIntegration((prev: any) => (prev ? { ...prev, status: 'WAITING_QR' } : null))
          }
          setIsConnecting(false)
        } else if (data?.connected) {
          if (integration.status !== 'CONNECTED') {
            setIntegration((prev: any) => (prev ? { ...prev, status: 'CONNECTED' } : null))
          }
          toast.success(t('already_connected'))
          setIsConnecting(false)
        } else if ((data?.error === 'qr_not_ready_yet' || data?.creating) && retries < 5) {
          if (integration.status !== 'WAITING_QR') {
            setIntegration((prev: any) => (prev ? { ...prev, status: 'WAITING_QR' } : null))
          }
          retries++
          setTimeout(fetchQr, 2000)
        } else {
          toast.error(data?.error || t('failed_init'))
          setIsConnecting(false)
        }
      } catch (e: any) {
        toast.error(e.message || t('error_connect'))
        setIsConnecting(false)
      }
    }

    fetchQr()
  }

  const handleDisconnect = async () => {
    if (!integration) return
    setIsConnecting(true)
    try {
      const { error } = await supabase.functions.invoke('evolution-disconnect', {
        body: { integrationId: integration.id },
      })
      if (error) throw error
      toast.success(t('disconnected_success'))
      setQrCode(null)
      setIntegration((prev: any) => (prev ? { ...prev, status: 'DISCONNECTED' } : null))
    } catch (e: any) {
      toast.error(e.message || t('error_disconnect'))
    } finally {
      setIsConnecting(false)
    }
  }

  if (integrationLoading) {
    return (
      <div className="p-20 text-center">
        <Loader2 className="animate-spin h-8 w-8 mx-auto text-muted-foreground" />
      </div>
    )
  }

  const isConnected = integration?.status === 'CONNECTED'
  const isWaiting = integration?.status === 'WAITING_QR'

  return (
    <div className="max-w-3xl mx-auto space-y-8 p-4 md:p-10 animate-in fade-in slide-in-from-bottom-4 duration-500 ease-apple min-h-full">
      <div>
        <h2 className="text-3xl font-bold tracking-tight text-foreground">{t('settings')}</h2>
        <p className="text-muted-foreground mt-1 font-medium">{t('settings_desc')}</p>
      </div>

      <div className="space-y-6">
        {/* Evolution API Credentials Card */}
        <Card className="shadow-subtle border border-border/40 rounded-[2rem] bg-card overflow-hidden">
          <CardHeader className="pb-4 pt-8 px-8">
            <CardTitle className="flex items-center gap-3 text-xl tracking-tight">
              <div className="bg-primary/10 text-primary p-2.5 rounded-2xl">
                <KeyRound className="h-5 w-5" />
              </div>
              Evolution API
            </CardTitle>
            <CardDescription className="font-medium text-sm text-muted-foreground max-w-sm">
              URL e credenciais da sua instância Evolution API
            </CardDescription>
          </CardHeader>

          <CardContent className="px-8 pb-8 space-y-4">
            {credLoading ? (
              <Loader2 className="animate-spin h-5 w-5 text-muted-foreground" />
            ) : editingCreds ? (
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="settings-evo-url">URL da Evolution API</Label>
                  <Input
                    id="settings-evo-url"
                    type="url"
                    placeholder="https://api.seudominio.com"
                    value={editUrl}
                    onChange={(e) => setEditUrl(e.target.value)}
                    disabled={savingCreds}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="settings-evo-key">API Key</Label>
                  <Input
                    id="settings-evo-key"
                    type="password"
                    placeholder="Nova API Key"
                    value={editKey}
                    onChange={(e) => setEditKey(e.target.value)}
                    disabled={savingCreds}
                  />
                </div>
                <div className="flex gap-3">
                  <Button
                    onClick={handleSaveCreds}
                    disabled={savingCreds}
                    className="rounded-full px-6 h-10 font-semibold"
                  >
                    {savingCreds ? (
                      <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Verificando...</>
                    ) : (
                      'Salvar'
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleCancelEdit}
                    disabled={savingCreds}
                    className="rounded-full px-6 h-10 font-semibold"
                  >
                    Cancelar
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="bg-muted/40 border border-border/60 rounded-2xl p-4 flex flex-col gap-3">
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">URL</span>
                    <span className="text-sm font-medium text-foreground truncate">
                      {credUrl || <span className="text-muted-foreground italic">Não configurado</span>}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">API Key</span>
                    <span className="text-sm font-mono font-medium text-foreground">
                      {credMasked || <span className="text-muted-foreground italic">Não configurado</span>}
                    </span>
                  </div>
                </div>
                <Button
                  variant="outline"
                  onClick={() => setEditingCreds(true)}
                  className="rounded-full px-6 h-10 font-semibold"
                >
                  Editar
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* WhatsApp Connection Card */}
        <Card className="shadow-subtle border border-border/40 rounded-[2rem] bg-card overflow-hidden">
          <CardHeader className="pb-6 pt-8 px-8 flex flex-col sm:flex-row sm:items-start justify-between gap-4">
            <div className="space-y-2">
              <CardTitle className="flex items-center gap-3 text-xl tracking-tight">
                <div className="bg-green-500/10 text-green-500 p-2.5 rounded-2xl">
                  <MessageCircle className="h-5 w-5" />
                </div>
                {t('whatsapp_connection')}
              </CardTitle>
              <CardDescription className="font-medium text-sm text-muted-foreground max-w-sm">
                {t('whatsapp_connection_desc')}
              </CardDescription>
            </div>
            <div className="flex flex-col gap-2 items-end">
              <div
                className={cn(
                  'self-start sm:self-auto px-3 py-1.5 rounded-full text-xs font-bold uppercase tracking-wide border whitespace-nowrap',
                  isConnected
                    ? 'bg-green-500/10 text-green-600 border-green-500/20'
                    : isWaiting
                      ? 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20'
                      : 'bg-muted text-muted-foreground border-border',
                )}
              >
                {isConnected ? t('connected') : isWaiting ? t('waiting_qr') : t('disconnected')}
              </div>
            </div>
          </CardHeader>

          <CardContent className="space-y-6 px-8">
            <div className="bg-muted/40 border border-border/60 rounded-2xl p-5 flex flex-col gap-3">
              <h4 className="text-sm font-semibold text-foreground tracking-tight uppercase">
                System Instance Details
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Instance Name
                  </span>
                  <span className="text-sm font-medium text-foreground bg-background px-3 py-1.5 rounded-lg border border-border/50 truncate">
                    {integration?.instance_name || 'Not created yet'}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Setup Status
                  </span>
                  <div className="text-sm font-medium text-foreground bg-background px-3 py-1.5 rounded-lg border border-border/50 flex items-center gap-2">
                    {integration?.is_setup_completed ? (
                      <><CheckCircle2 className="w-4 h-4 text-green-500" /> Completed</>
                    ) : (
                      'Pending'
                    )}
                  </div>
                </div>
              </div>
            </div>

            {qrCode && isWaiting && (
              <div className="flex flex-col items-center justify-center p-8 border border-border/60 rounded-3xl bg-muted/20 animate-in fade-in zoom-in-95 duration-300">
                <div className="bg-white p-4 rounded-2xl shadow-sm mb-4 relative">
                  <img
                    src={qrCode.startsWith('data:') ? qrCode : `data:image/png;base64,${qrCode}`}
                    alt="WhatsApp QR Code"
                    className="w-56 h-56"
                  />
                  {isConnecting && (
                    <div className="absolute inset-0 bg-white/60 flex items-center justify-center rounded-2xl backdrop-blur-[1px]">
                      <Loader2 className="h-8 w-8 animate-spin text-primary" />
                    </div>
                  )}
                </div>
                <h4 className="font-semibold text-foreground mb-1">{t('scan_to_connect')}</h4>
                <p className="text-sm font-medium text-muted-foreground text-center max-w-[250px]">
                  {t('scan_desc')}
                </p>
              </div>
            )}
          </CardContent>

          <CardFooter className="bg-muted/30 border-t border-border/40 py-5 px-8 flex flex-col sm:flex-row gap-4 sm:justify-between sm:items-center">
            <div className="text-sm font-medium text-muted-foreground text-center sm:text-left">
              {isConnected ? t('actively_connected') : t('configure_instance')}
            </div>
            <div className="w-full sm:w-auto">
              {isConnected ? (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={handleDisconnect}
                  disabled={isConnecting}
                  className="rounded-full px-6 h-11 w-full sm:w-auto font-semibold"
                >
                  {isConnecting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Unplug className="mr-2 h-4 w-4" />
                  )}
                  {t('disconnect_instance')}
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={handleConnect}
                  disabled={isConnecting}
                  className="rounded-full px-6 h-11 w-full sm:w-auto font-semibold"
                >
                  {isConnecting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Plug className="mr-2 h-4 w-4" />
                  )}
                  {isWaiting && !qrCode
                    ? t('generating')
                    : isWaiting
                      ? t('refresh_qr')
                      : t('connect_whatsapp')}
                </Button>
              )}
            </div>
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm build 2>&1 | head -30
```

Expected: no errors related to `Settings.tsx`.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Settings.tsx
git commit -m "feat: add Evolution API credentials card to settings page"
```

---

### Task 6: Final verification

- [ ] **Step 1: Run lint**

```bash
pnpm lint
```

Expected: no errors.

- [ ] **Step 2: Run build**

```bash
pnpm build
```

Expected: exits 0.

- [ ] **Step 3: Start dev server and manually test onboarding flow**

```bash
pnpm dev --port 8085
```

Open `http://localhost:8085`. Log in as a user with no credentials set.

Expected:
1. Redirected to `/app/onboarding`
2. Step 0 shows credential form (KeyRound icon active)
3. Submitting bad credentials → toast error, form stays open
4. Submitting good credentials → advances to QR scan (step 1)

- [ ] **Step 4: Manually test Settings page**

Open Settings page.

Expected:
1. Evolution API card loads masked URL + key
2. "Editar" button shows blank input fields
3. Bad credentials → toast error, fields stay open
4. Good credentials → display updates with new masked values

- [ ] **Step 5: Final commit if any cleanup needed**

```bash
git add -p
git commit -m "chore: cleanup after evolution credentials migration"
```
