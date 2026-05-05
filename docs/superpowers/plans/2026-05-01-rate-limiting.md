# Rate Limiting & Spam Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce per-contact limits (200 msg/hour, 2M tokens/day) with automatic handoff to human and a configurable "technical problem" message when limits are exceeded.

**Architecture:** Atomic Postgres RPCs manage rolling-window counters on `whatsapp_contacts`. Settings live on `user_integrations`. The webhook increments the msg counter for every inbound message. The ai-handler checks the msg limit and counts tokens, triggering handoff if either limit is exceeded. The existing `pipeline_stage = 'Contato Humano'` gate blocks all subsequent AI processing.

**Tech Stack:** Supabase Postgres (migration + RPCs), Deno Edge Functions, React 19 + TypeScript, Tailwind + shadcn/ui.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `supabase/migrations/20260501000001_add_rate_limiting.sql` | Create | Schema columns + 2 RPCs |
| `src/lib/supabase/types.ts` | Regenerate | Auto-gen after migration |
| `src/lib/types.ts` | Modify | Add rate limit fields to `UserIntegration` |
| `supabase/functions/evolution-webhook/index.ts` | Modify | Call `increment_contact_msg` for all inbound messages |
| `supabase/functions/evolution-webhook/ai-handler.ts` | Modify | Move integration fetch early; add msg limit check; add token counting + limit check |
| `src/pages/Settings.tsx` | Modify | New "Proteção contra Spam" card |

---

### Task 1: DB Migration

**Files:**
- Create: `supabase/migrations/20260501000001_add_rate_limiting.sql`

- [ ] **Step 1: Write migration**

```sql
-- Rate limit settings on user_integrations (per operator)
ALTER TABLE public.user_integrations
  ADD COLUMN IF NOT EXISTS rate_limit_enabled        BOOLEAN   NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS rate_limit_msg_per_hour   INTEGER   NOT NULL DEFAULT 200,
  ADD COLUMN IF NOT EXISTS rate_limit_tokens_per_day INTEGER   NOT NULL DEFAULT 2000000,
  ADD COLUMN IF NOT EXISTS rate_limit_message        TEXT      NOT NULL DEFAULT 'Identificamos um volume elevado de mensagens e transferiremos seu atendimento para um de nossos atendentes. Em breve você será atendido!';

-- Rolling-window counters on whatsapp_contacts (per contact)
ALTER TABLE public.whatsapp_contacts
  ADD COLUMN IF NOT EXISTS msg_count_hour   INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS msg_window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS token_count_day  BIGINT      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS token_day_start  TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- RPC: increment msg counter, reset window if expired, return new count
CREATE OR REPLACE FUNCTION public.increment_contact_msg(
  p_contact_id  UUID,
  p_window_secs INT DEFAULT 3600
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_count INTEGER;
BEGIN
  UPDATE public.whatsapp_contacts
  SET
    msg_count_hour   = CASE
                         WHEN EXTRACT(EPOCH FROM (NOW() - msg_window_start)) > p_window_secs
                         THEN 1
                         ELSE msg_count_hour + 1
                       END,
    msg_window_start = CASE
                         WHEN EXTRACT(EPOCH FROM (NOW() - msg_window_start)) > p_window_secs
                         THEN NOW()
                         ELSE msg_window_start
                       END
  WHERE id = p_contact_id
  RETURNING msg_count_hour INTO v_new_count;

  RETURN COALESCE(v_new_count, 0);
END;
$$;

-- RPC: add tokens to daily counter, reset window if expired, return new total
CREATE OR REPLACE FUNCTION public.add_contact_tokens(
  p_contact_id  UUID,
  p_tokens      INT,
  p_window_secs INT DEFAULT 86400
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_total BIGINT;
BEGIN
  UPDATE public.whatsapp_contacts
  SET
    token_count_day = CASE
                        WHEN EXTRACT(EPOCH FROM (NOW() - token_day_start)) > p_window_secs
                        THEN p_tokens
                        ELSE token_count_day + p_tokens
                      END,
    token_day_start = CASE
                        WHEN EXTRACT(EPOCH FROM (NOW() - token_day_start)) > p_window_secs
                        THEN NOW()
                        ELSE token_day_start
                      END
  WHERE id = p_contact_id
  RETURNING token_count_day INTO v_new_total;

  RETURN COALESCE(v_new_total, 0);
END;
$$;
```

- [ ] **Step 2: Push migration**

```bash
supabase db push
```

Expected: migration applied with no errors.

- [ ] **Step 3: Regenerate TypeScript types**

```bash
supabase gen types typescript --project-id fckenwdyghisdebqauxy > src/lib/supabase/types.ts
```

Expected: `src/lib/supabase/types.ts` now has `rate_limit_enabled`, `rate_limit_msg_per_hour`, `rate_limit_tokens_per_day`, `rate_limit_message` in `user_integrations` Row/Insert/Update, and `msg_count_hour`, `msg_window_start`, `token_count_day`, `token_day_start` in `whatsapp_contacts`.

- [ ] **Step 4: Update `UserIntegration` interface in `src/lib/types.ts`**

Add 4 fields after `is_webhook_enabled`:

```typescript
export interface UserIntegration {
  id: string
  user_id: string
  evolution_api_url: string | null
  evolution_api_key: string | null
  instance_name: string | null
  status: 'DISCONNECTED' | 'WAITING_QR' | 'CONNECTED'
  is_setup_completed?: boolean
  is_webhook_enabled?: boolean
  captions_enabled?: boolean
  user_display_name?: string | null
  rate_limit_enabled: boolean
  rate_limit_msg_per_hour: number
  rate_limit_tokens_per_day: number
  rate_limit_message: string
  created_at: string
}
```

Note: `captions_enabled` and `user_display_name` should already be in the interface from a previous feature — keep them, just add the 4 new fields.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260501000001_add_rate_limiting.sql src/lib/supabase/types.ts src/lib/types.ts
git commit -m "feat: add rate limiting schema — columns on user_integrations and whatsapp_contacts, RPCs increment_contact_msg and add_contact_tokens"
```

---

### Task 2: Webhook — Increment Msg Counter

**Files:**
- Modify: `supabase/functions/evolution-webhook/index.ts`

The goal: call `increment_contact_msg` for every inbound message (not `fromMe`), fire-and-forget via `waitUntil`.

The insertion point is inside the `if (contact && messageId)` block, right after the message upsert success log and before the `if (fromMe)` branch. Look for the comment `// If the inbound message reveals...` (around line 392) — add the increment block right before that.

- [ ] **Step 1: Add increment call after message save**

In `supabase/functions/evolution-webhook/index.ts`, inside the `else {` block of `if (insertError)` (the success path), find the line:

```typescript
          // If the inbound message reveals the phone number for an @lid contact,
```

Add the following block immediately BEFORE that comment:

```typescript
          // Rate limiting: increment msg counter for all inbound messages
          if (!fromMe && contact?.id) {
            const msgCountPromise = supabase
              .rpc('increment_contact_msg', { p_contact_id: contact.id, p_window_secs: 3600 })
              .then(() => {})
              .catch((err: any) =>
                console.error(`[WEBHOOK] increment_contact_msg failed for contact ${contact.id}:`, err),
              )
            if (
              typeof (globalThis as any).EdgeRuntime !== 'undefined' &&
              typeof (globalThis as any).EdgeRuntime.waitUntil === 'function'
            ) {
              ;(globalThis as any).EdgeRuntime.waitUntil(msgCountPromise)
            }
          }

```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/evolution-webhook/index.ts
git commit -m "feat: increment msg rate limit counter for all inbound messages in webhook"
```

---

### Task 3: ai-handler — Rate Limit Checks + Token Counting

**Files:**
- Modify: `supabase/functions/evolution-webhook/ai-handler.ts`

This task has 4 sub-changes:

**A** — Move the `user_integrations` fetch from line ~309 to right after the handoff gate (line 78).  
**B** — Add msg rate limit check immediately after the early integration fetch.  
**C** — Add token counting after the OpenRouter call.  
**D** — Handle token limit: send rate limit message after the normal response.

- [ ] **Step 1: Move integration fetch to early position**

Find the block currently at ~line 309 (after `handoffDetected`/`cleanText`):

```typescript
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
```

**Remove** this entire block from its current location (around line 309–345).

**Add** it (verbatim, same code) immediately after the handoff gate exit block. The handoff gate currently ends at:

```typescript
    if (contact.pipeline_stage === 'Contato Humano') {
      console.log(
        `[AI Handler] EXIT handoff_active contactId=${contactId} remote_jid=${contact.remote_jid} pipeline_stage=${contact.pipeline_stage}`,
      )
      return
    }
```

Insert the moved block right after that `return\n    }` line.

- [ ] **Step 2: Add msg rate limit check after the early integration block**

Immediately after the `console.log('[AI Handler] evolution_ok ...')` line (which is now early in the function), add:

```typescript
    // Rate limit: msg/hour check
    if (
      integration.rate_limit_enabled &&
      contact.msg_count_hour >= (integration.rate_limit_msg_per_hour ?? 200)
    ) {
      console.log(
        `[AI Handler] rate_limit_msg_hit contactId=${contactId} count=${contact.msg_count_hour} limit=${integration.rate_limit_msg_per_hour}`,
      )
      // Send rate limit message and handoff
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
```

- [ ] **Step 3: Add token counting after the OpenRouter call**

Find the line right after the `handoffDetected`/`cleanText` block (the two const lines at ~line 302-303):

```typescript
    const handoffDetected = agent.human_handoff_enabled && /<transferir_humano\s*(?:\/>|>[\s\S]*?<\/transferir_humano>|>)/g.test(responseText)
    const cleanText = responseText.replace(/<transferir_humano\s*(?:\/>|>[\s\S]*?<\/transferir_humano>|>)/g, '').trim()

    if (handoffDetected) {
      console.log(`[AI Handler] handoff_tag_detected contactId=${contactId} — transferring to human`)
    }
```

Add after `handoffDetected` log block:

```typescript
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
```

- [ ] **Step 4: Send rate limit message after normal send when token limit is hit**

Find the `console.log('[AI Handler] send_ok ...')` line (around line 402). Immediately after it, add:

```typescript
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
```

- [ ] **Step 5: Set handoff stage when token limit hit**

Find the final contact update block at the bottom of the function:

```typescript
    const { error: contactUpdateError } = await supabase
      .from('whatsapp_contacts')
      .update({
        pipeline_stage: handoffDetected ? 'Contato Humano' : 'Em Conversa',
        last_message_at: new Date().toISOString(),
      })
      .eq('id', contactId)
```

Change the `pipeline_stage` ternary to also include `tokenLimitHit`:

```typescript
    const { error: contactUpdateError } = await supabase
      .from('whatsapp_contacts')
      .update({
        pipeline_stage: (handoffDetected || tokenLimitHit) ? 'Contato Humano' : 'Em Conversa',
        last_message_at: new Date().toISOString(),
      })
      .eq('id', contactId)
```

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/evolution-webhook/ai-handler.ts
git commit -m "feat: add rate limiting to ai-handler — msg/hour gate, token/day tracking, auto handoff on limit hit"
```

---

### Task 4: Settings UI — Proteção contra Spam Card

**Files:**
- Modify: `src/pages/Settings.tsx`

Follow the exact same pattern as the existing "Legendas" card: local state, `useEffect` to sync from integration, dedicated save handler, card UI.

- [ ] **Step 1: Add Shield import from lucide-react**

In `src/pages/Settings.tsx`, find the lucide-react import line:

```typescript
import { Loader2, MessageCircle, Plug, Unplug, CheckCircle2, KeyRound, Tag } from 'lucide-react'
```

Change to:

```typescript
import { Loader2, MessageCircle, Plug, Unplug, CheckCircle2, KeyRound, Tag, Shield } from 'lucide-react'
```

- [ ] **Step 2: Add Textarea import**

Find the shadcn/ui imports block. Add `Textarea` to the imports:

```typescript
import { Textarea } from '@/components/ui/textarea'
```

If `Textarea` is not yet installed, install it:

```bash
npx shadcn@latest add textarea
```

- [ ] **Step 3: Add rate limit state variables**

After the `savingCaptions` state declaration (around line 37), add:

```typescript
  const [rateLimitEnabled, setRateLimitEnabled] = useState(true)
  const [rateLimitMsgPerHour, setRateLimitMsgPerHour] = useState(200)
  const [rateLimitTokensPerDay, setRateLimitTokensPerDay] = useState(2000000)
  const [rateLimitMessage, setRateLimitMessage] = useState(
    'Identificamos um volume elevado de mensagens e transferiremos seu atendimento para um de nossos atendentes. Em breve você será atendido!',
  )
  const [savingRateLimit, setSavingRateLimit] = useState(false)
```

- [ ] **Step 4: Sync state from integration in existing useEffect**

Find the `useEffect` that loads captions from integration (the one with `integration?.id` dependency):

```typescript
  useEffect(() => {
    if (integration) {
      setCaptionsEnabled(integration.captions_enabled ?? false)
      setUserDisplayName(integration.user_display_name ?? '')
    }
  }, [integration?.id])
```

Add rate limit fields inside the same effect:

```typescript
  useEffect(() => {
    if (integration) {
      setCaptionsEnabled(integration.captions_enabled ?? false)
      setUserDisplayName(integration.user_display_name ?? '')
      setRateLimitEnabled(integration.rate_limit_enabled ?? true)
      setRateLimitMsgPerHour(integration.rate_limit_msg_per_hour ?? 200)
      setRateLimitTokensPerDay(integration.rate_limit_tokens_per_day ?? 2000000)
      setRateLimitMessage(
        integration.rate_limit_message ??
          'Identificamos um volume elevado de mensagens e transferiremos seu atendimento para um de nossos atendentes. Em breve você será atendido!',
      )
    }
  }, [integration?.id])
```

- [ ] **Step 5: Add save handler**

After `handleSaveCaptions` function, add:

```typescript
  const handleSaveRateLimit = async () => {
    setSavingRateLimit(true)
    try {
      const { error } = await supabase
        .from('user_integrations')
        .update({
          rate_limit_enabled: rateLimitEnabled,
          rate_limit_msg_per_hour: rateLimitMsgPerHour,
          rate_limit_tokens_per_day: rateLimitTokensPerDay,
          rate_limit_message: rateLimitMessage.trim(),
        })
        .eq('user_id', integration!.user_id)
      if (error) throw error
      toast.success('Configurações de proteção salvas')
    } catch (e: any) {
      toast.error(e.message || 'Erro ao salvar proteção')
    } finally {
      setSavingRateLimit(false)
    }
  }
```

- [ ] **Step 6: Add the card to JSX**

Find the closing tag of the Legendas card (look for `{/* Legendas Card */}` and the card that ends after the save button). Add the new card immediately after it:

```tsx
        {/* Proteção contra Spam Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Proteção contra Spam
            </CardTitle>
            <CardDescription>
              Limites automáticos por contato para evitar abusos e loops de IA.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label className="font-semibold">Proteção ativa</Label>
                <p className="text-xs text-muted-foreground">
                  Ativa os limites de mensagens e tokens por contato.
                </p>
              </div>
              <Switch
                checked={rateLimitEnabled}
                onCheckedChange={setRateLimitEnabled}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rl-msg">Mensagens por hora (por contato)</Label>
              <Input
                id="rl-msg"
                type="number"
                min={1}
                max={10000}
                value={rateLimitMsgPerHour}
                onChange={(e) => setRateLimitMsgPerHour(Number(e.target.value))}
                disabled={!rateLimitEnabled}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rl-tokens">Tokens por dia (por contato)</Label>
              <Input
                id="rl-tokens"
                type="number"
                min={1000}
                max={10000000}
                value={rateLimitTokensPerDay}
                onChange={(e) => setRateLimitTokensPerDay(Number(e.target.value))}
                disabled={!rateLimitEnabled}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rl-message">Mensagem enviada ao atingir o limite</Label>
              <Textarea
                id="rl-message"
                rows={3}
                value={rateLimitMessage}
                onChange={(e) => setRateLimitMessage(e.target.value)}
                disabled={!rateLimitEnabled}
              />
            </div>
          </CardContent>
          <CardFooter>
            <Button onClick={handleSaveRateLimit} disabled={savingRateLimit}>
              {savingRateLimit ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Salvando...
                </>
              ) : (
                'Salvar proteção'
              )}
            </Button>
          </CardFooter>
        </Card>
```

- [ ] **Step 7: Commit**

```bash
git add src/pages/Settings.tsx
git commit -m "feat: add Proteção contra Spam settings card with rate limit config"
```

---

### Task 5: Deploy + Smoke Test

- [ ] **Step 1: Deploy edge functions**

```bash
supabase functions deploy evolution-webhook --no-verify-jwt
```

Expected: "Deployed Function evolution-webhook" with no errors.

- [ ] **Step 2: Run AI smoke test**

```bash
curl "https://fckenwdyghisdebqauxy.supabase.co/functions/v1/evolution-debug?endpoint=test-ai" \
  -H "Authorization: Bearer <service_role_key>"
```

Expected: `"ok": true`, all checks `true`.

- [ ] **Step 3: Verify Settings UI renders**

```bash
pnpm dev --port 8085
```

Open `http://localhost:8085/settings`. Verify:
- "Proteção contra Spam" card visible after "Legendas" card
- Toggle ON by default, inputs enabled
- Toggle OFF → inputs grey out
- Change values, save → `toast.success` appears
- Reload page → values persist

- [ ] **Step 4: Verify DB defaults**

Run in Supabase SQL editor:

```sql
SELECT rate_limit_enabled, rate_limit_msg_per_hour, rate_limit_tokens_per_day
FROM user_integrations
LIMIT 5;
```

Expected: all rows show `true`, `200`, `2000000`.

- [ ] **Step 5: Test msg rate limit manually**

In Supabase SQL editor, set a test contact's msg counter above the limit:

```sql
UPDATE whatsapp_contacts
SET msg_count_hour = 201, msg_window_start = NOW()
WHERE id = '<test_contact_id>';
```

Send a WhatsApp message from that contact. Check Supabase function logs:
Expected: `[AI Handler] rate_limit_msg_hit` log, contact receives rate limit message, contact moved to "Contato Humano" in Pipeline Kanban.

- [ ] **Step 6: Reset test contact**

```sql
UPDATE whatsapp_contacts
SET msg_count_hour = 0, msg_window_start = NOW() - INTERVAL '2 hours',
    pipeline_stage = 'Em Conversa'
WHERE id = '<test_contact_id>';
```

- [ ] **Step 7: Push**

```bash
git push
```

---

## Self-Review

**Spec coverage:**

| Requirement | Task |
|---|---|
| 200 msg/hour per contact, rolling window | Task 1 (RPC), Task 2 (webhook increment), Task 3 (ai-handler check) |
| 2M tokens/day per contact, rolling window | Task 1 (RPC), Task 3 (add_contact_tokens call) |
| Auto handoff on limit hit | Task 3 (pipeline_stage update) |
| Send rate limit message when limit hit | Task 3 (Evolution fetch call in both gates) |
| Settings configurable (toggle, limits, message) | Task 4 |
| Defaults: enabled, 200 msg, 2M tokens, pre-written message | Task 1 (DEFAULT in migration) |
| Count ALL inbound messages (not just AI-active) | Task 2 (webhook, before fromMe branch) |
| Contact stays in Contato Humano until operator moves | Reuses existing handoff gate — no change needed |

**Placeholder scan:** None. All steps contain complete code.

**Type consistency:**
- `increment_contact_msg` called with `{ p_contact_id, p_window_secs }` in Task 2 and defined with same params in Task 1. ✅
- `add_contact_tokens` called with `{ p_contact_id, p_tokens, p_window_secs }` in Task 3 and defined with same params in Task 1. ✅
- `integration.rate_limit_enabled`, `integration.rate_limit_msg_per_hour`, `integration.rate_limit_tokens_per_day`, `integration.rate_limit_message` used in Task 3 and defined in `UserIntegration` in Task 1 Step 4. ✅
- `tokenLimitHit` declared in Task 3 Step 3 and used in Steps 4 and 5. ✅
- `contact.msg_count_hour` available because contact select already includes `pipeline_stage` (from existing handoff feature) — confirm `msg_count_hour` is included after regenerating types. The contact select at ai-handler line 26 uses `.select('ai_agent_id, remote_jid, pipeline_stage')` — **must add `msg_count_hour`** to that select. Add to Task 3 Step 1.

**Gap found — contact select missing `msg_count_hour`:**

In Task 3 Step 1, before moving the integration block, first update the contact select at line 26 to include the new counter fields:

Change:
```typescript
      .select('ai_agent_id, remote_jid, pipeline_stage')
```

To:
```typescript
      .select('ai_agent_id, remote_jid, pipeline_stage, msg_count_hour')
```

Also update the recovery select at line 43:

Change:
```typescript
        .select('id, ai_agent_id, remote_jid, pipeline_stage')
```

To:
```typescript
        .select('id, ai_agent_id, remote_jid, pipeline_stage, msg_count_hour')
```

Add this as **Step 0** in Task 3 before moving the integration block.
