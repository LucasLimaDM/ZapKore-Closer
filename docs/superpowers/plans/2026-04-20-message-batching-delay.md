# Message Batching Delay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurable debounce delay per AI agent so that bursts of quick messages are batched and answered once, instead of triggering individual AI responses per message.

**Architecture:** A `ai_trigger_version` integer column on `whatsapp_contacts` acts as a generation counter — each inbound message increments it atomically via a Postgres RPC. The AI handler receives the captured version, sleeps for `agent.message_delay` seconds, then checks the version twice (after sleep, before sending) to decide whether to proceed or cancel.

**Tech Stack:** Supabase Edge Functions (Deno), Supabase JS v2, React 19, TypeScript, Tailwind CSS / shadcn/ui

---

## File Map

| File | Action |
|---|---|
| `supabase/migrations/20260420000000_message_delay.sql` | Create — adds `ai_trigger_version` column, `message_delay` column, `increment_ai_trigger_version` RPC |
| `supabase/functions/evolution-webhook/ai-handler.ts` | Modify — add `triggerVersion` param, sleep, 2 cancellation checks |
| `supabase/functions/evolution-webhook/index.ts` | Modify — call RPC to increment version, pass `myVersion` to `processAiResponse` |
| `src/lib/types.ts` | Modify — add `message_delay: number` to `AIAgent` interface |
| `src/hooks/use-agents.ts` | Modify — include `message_delay` in `createAgent` and `updateAgent` |
| `src/pages/Agents.tsx` | Modify — add `message_delay` field to `formData` state and dialog UI |

---

## Task 1: DB Migration

**Files:**
- Create: `supabase/migrations/20260420000000_message_delay.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- supabase/migrations/20260420000000_message_delay.sql

-- Debounce generation counter per contact
ALTER TABLE whatsapp_contacts
  ADD COLUMN IF NOT EXISTS ai_trigger_version INTEGER NOT NULL DEFAULT 0;

-- Configurable delay per agent (seconds), same pattern as memory_limit
ALTER TABLE ai_agents
  ADD COLUMN IF NOT EXISTS message_delay INTEGER NOT NULL DEFAULT 0;

-- Atomic increment RPC — returns the new version number
CREATE OR REPLACE FUNCTION increment_ai_trigger_version(p_contact_id UUID)
RETURNS INTEGER
LANGUAGE SQL
SECURITY DEFINER
AS $$
  UPDATE whatsapp_contacts
  SET ai_trigger_version = ai_trigger_version + 1
  WHERE id = p_contact_id
  RETURNING ai_trigger_version;
$$;
```

- [ ] **Step 2: Apply the migration via Supabase MCP**

Use `mcp__claude_ai_Supabase__apply_migration` with the SQL above, or run:
```bash
supabase db push
```

Expected: migration applies without error; columns exist on both tables; function `increment_ai_trigger_version` is callable.

- [ ] **Step 3: Verify columns exist**

Run in Supabase SQL Editor:
```sql
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name IN ('whatsapp_contacts', 'ai_agents')
  AND column_name IN ('ai_trigger_version', 'message_delay');
```

Expected: 2 rows — `ai_trigger_version` integer default 0 on `whatsapp_contacts`, `message_delay` integer default 0 on `ai_agents`.

- [ ] **Step 4: Verify RPC works**

```sql
-- Pick any existing contact id from your DB
SELECT increment_ai_trigger_version('<any-contact-uuid>');
```

Expected: returns an integer (the incremented version).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260420000000_message_delay.sql
git commit -m "feat: add ai_trigger_version + message_delay columns and RPC"
```

---

## Task 2: Update AI Handler — Sleep + Cancellation Checks

**Files:**
- Modify: `supabase/functions/evolution-webhook/ai-handler.ts`

Context: `processAiResponse` currently takes `(userId, contactId, supabaseUrl, supabaseKey)`. We add a fifth parameter `triggerVersion: number`. Inside, after loading the agent we read `message_delay`, sleep, then check the version twice.

- [ ] **Step 1: Update the function signature**

Find the current signature at the top of `ai-handler.ts`:
```typescript
export async function processAiResponse(
  userId: string,
  contactId: string,
  supabaseUrl: string,
  supabaseKey: string,
) {
```

Replace with:
```typescript
export async function processAiResponse(
  userId: string,
  contactId: string,
  supabaseUrl: string,
  supabaseKey: string,
  triggerVersion: number,
) {
```

- [ ] **Step 2: Add sleep + first cancellation check after agent is loaded**

The agent is loaded at line ~38 with:
```typescript
if (agentError || !agent) {
  console.log(...)
  return
}
```

Immediately after that block (after the `if (agentError || !agent)` guard), insert:

```typescript
    const messageDelay = agent.message_delay ?? 0

    if (messageDelay > 0) {
      console.log(`[AI Handler] Debounce: sleeping ${messageDelay}s for contact ${contactId} (triggerVersion: ${triggerVersion})`)
      await new Promise((resolve) => setTimeout(resolve, messageDelay * 1000))
    }

    // Cancellation check 1: was a newer message received during the sleep?
    const { data: contactVersion } = await supabase
      .from('whatsapp_contacts')
      .select('ai_trigger_version')
      .eq('id', contactId)
      .single()

    if (contactVersion?.ai_trigger_version !== triggerVersion) {
      console.log(`[AI Handler] Debounce: newer message arrived during delay, aborting (contact ${contactId}, expected v${triggerVersion}, got v${contactVersion?.ai_trigger_version})`)
      return
    }
```

- [ ] **Step 3: Add second cancellation check before sending**

Find the line that sends the message via Evolution API:
```typescript
    const sendRes = await fetch(`${evoUrl}/message/sendText/${integration.instance_name}`, {
```

Immediately **before** that `fetch` call, insert:

```typescript
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
```

- [ ] **Step 4: Verify the full modified ai-handler.ts reads correctly**

The logical flow should now be:
1. Load contact → check ai_agent_id
2. Load agent → check active
3. Sleep if message_delay > 0
4. **Check 1:** version matches → continue, else abort
5. Load messages → call OpenRouter
6. **Check 2:** version matches → continue, else discard
7. Send via Evolution API → save to DB

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/evolution-webhook/ai-handler.ts
git commit -m "feat: add debounce sleep and dual cancellation checks to AI handler"
```

---

## Task 3: Update Webhook — Increment Version + Pass to Handler

**Files:**
- Modify: `supabase/functions/evolution-webhook/index.ts`

Context: The webhook currently calls `processAiResponse(userId, contact.id, supabaseUrl, supabaseKey)` without a version. We need to (a) call the RPC to increment `ai_trigger_version` and get back `myVersion`, and (b) pass `myVersion` to `processAiResponse`.

- [ ] **Step 1: Replace the AI trigger block in index.ts**

Find the existing AI dispatch section (around line 338–354):
```typescript
          } else {
            console.log(
              `[WEBHOOK] Triggering background AI task for contact ${contact.id} (remoteJid: ${effectiveJid})`,
            )
            if (
              typeof (globalThis as any).EdgeRuntime !== 'undefined' &&
              typeof (globalThis as any).EdgeRuntime.waitUntil === 'function'
            ) {
              ;(globalThis as any).EdgeRuntime.waitUntil(
                processAiResponse(userId, contact.id, supabaseUrl, supabaseKey),
              )
            } else {
              processAiResponse(userId, contact.id, supabaseUrl, supabaseKey).catch((err: any) =>
                console.error('[WEBHOOK] Background AI task failed:', err),
              )
            }
          }
```

Replace with:
```typescript
          } else {
            const { data: newVersion, error: versionError } = await supabase
              .rpc('increment_ai_trigger_version', { p_contact_id: contact.id })

            if (versionError || newVersion === null || newVersion === undefined) {
              console.error(`[WEBHOOK] Failed to increment ai_trigger_version for contact ${contact.id}:`, versionError)
            } else {
              const myVersion = newVersion as number
              console.log(
                `[WEBHOOK] Triggering background AI task for contact ${contact.id} (remoteJid: ${effectiveJid}, triggerVersion: ${myVersion})`,
              )
              if (
                typeof (globalThis as any).EdgeRuntime !== 'undefined' &&
                typeof (globalThis as any).EdgeRuntime.waitUntil === 'function'
              ) {
                ;(globalThis as any).EdgeRuntime.waitUntil(
                  processAiResponse(userId, contact.id, supabaseUrl, supabaseKey, myVersion),
                )
              } else {
                processAiResponse(userId, contact.id, supabaseUrl, supabaseKey, myVersion).catch((err: any) =>
                  console.error('[WEBHOOK] Background AI task failed:', err),
                )
              }
            }
          }
```

- [ ] **Step 2: Verify no other callers of processAiResponse exist**

```bash
grep -r "processAiResponse" supabase/
```

Expected: only called in `index.ts`, defined in `ai-handler.ts`. Update any other call sites found to also pass `triggerVersion`.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/evolution-webhook/index.ts
git commit -m "feat: increment ai_trigger_version and pass to processAiResponse"
```

---

## Task 4: Update Frontend — Types + Hook

**Files:**
- Modify: `src/lib/types.ts` — add `message_delay` to `AIAgent`
- Modify: `src/hooks/use-agents.ts` — include `message_delay` in create/update

- [ ] **Step 1: Add message_delay to AIAgent type**

In `src/lib/types.ts`, find the `AIAgent` interface (line 24):
```typescript
export interface AIAgent {
  id: string
  user_id: string
  name: string
  description: string | null
  system_prompt: string
  api_key_id: string | null
  model_id: string
  memory_limit: number
  is_active: boolean
  is_default?: boolean
  created_at: string
  updated_at: string
}
```

Replace with:
```typescript
export interface AIAgent {
  id: string
  user_id: string
  name: string
  description: string | null
  system_prompt: string
  api_key_id: string | null
  model_id: string
  memory_limit: number
  message_delay: number
  is_active: boolean
  is_default?: boolean
  created_at: string
  updated_at: string
}
```

- [ ] **Step 2: Include message_delay in createAgent**

In `src/hooks/use-agents.ts`, find the `createAgent` insert payload (around line 38–48):
```typescript
    const { data, error } = await supabase
      .from('ai_agents')
      .insert({
        user_id: user.id,
        name: agent.name!,
        description: agent.description,
        system_prompt: agent.system_prompt!,
        api_key_id: agent.api_key_id,
        model_id: agent.model_id || 'google/gemini-2.0-flash-lite:free',
        memory_limit: agent.memory_limit ?? 20,
        is_active: agent.is_active,
        is_default: agent.is_default,
      })
```

Replace with:
```typescript
    const { data, error } = await supabase
      .from('ai_agents')
      .insert({
        user_id: user.id,
        name: agent.name!,
        description: agent.description,
        system_prompt: agent.system_prompt!,
        api_key_id: agent.api_key_id,
        model_id: agent.model_id || 'google/gemini-2.0-flash-lite:free',
        memory_limit: agent.memory_limit ?? 20,
        message_delay: agent.message_delay ?? 0,
        is_active: agent.is_active,
        is_default: agent.is_default,
      })
```

- [ ] **Step 3: Include message_delay in updateAgent**

In `src/hooks/use-agents.ts`, find the `updateAgent` update payload (around line 70–81):
```typescript
    const { data, error } = await supabase
      .from('ai_agents')
      .update({
        name: agent.name,
        description: agent.description,
        system_prompt: agent.system_prompt,
        api_key_id: agent.api_key_id,
        model_id: agent.model_id,
        memory_limit: agent.memory_limit,
        is_active: agent.is_active,
        is_default: agent.is_default,
        updated_at: new Date().toISOString(),
      })
```

Replace with:
```typescript
    const { data, error } = await supabase
      .from('ai_agents')
      .update({
        name: agent.name,
        description: agent.description,
        system_prompt: agent.system_prompt,
        api_key_id: agent.api_key_id,
        model_id: agent.model_id,
        memory_limit: agent.memory_limit,
        message_delay: agent.message_delay,
        is_active: agent.is_active,
        is_default: agent.is_default,
        updated_at: new Date().toISOString(),
      })
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/hooks/use-agents.ts
git commit -m "feat: add message_delay to AIAgent type and hook"
```

---

## Task 5: Update Agents UI — message_delay Field

**Files:**
- Modify: `src/pages/Agents.tsx`

- [ ] **Step 1: Add message_delay to formData initial state**

Find the `formData` useState (around line 92–101):
```typescript
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    system_prompt: '',
    api_key_id: '',
    model_id: 'google/gemini-2.0-flash-lite:free',
    memory_limit: 20,
    is_active: true,
    is_default: false,
  })
```

Replace with:
```typescript
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    system_prompt: '',
    api_key_id: '',
    model_id: 'google/gemini-2.0-flash-lite:free',
    memory_limit: 20,
    message_delay: 0,
    is_active: true,
    is_default: false,
  })
```

- [ ] **Step 2: Populate message_delay when editing an existing agent**

Find the `handleOpenDialog` branch for editing (around line 110–121):
```typescript
    if (agent) {
      setEditingAgent(agent)
      setFormData({
        name: agent.name,
        description: agent.description || '',
        system_prompt: agent.system_prompt,
        api_key_id: agent.api_key_id || '',
        model_id: agent.model_id || 'google/gemini-2.0-flash-lite:free',
        memory_limit: agent.memory_limit ?? 20,
        is_active: agent.is_active,
        is_default: agent.is_default || false,
      })
```

Replace with:
```typescript
    if (agent) {
      setEditingAgent(agent)
      setFormData({
        name: agent.name,
        description: agent.description || '',
        system_prompt: agent.system_prompt,
        api_key_id: agent.api_key_id || '',
        model_id: agent.model_id || 'google/gemini-2.0-flash-lite:free',
        memory_limit: agent.memory_limit ?? 20,
        message_delay: agent.message_delay ?? 0,
        is_active: agent.is_active,
        is_default: agent.is_default || false,
      })
```

- [ ] **Step 3: Also populate message_delay for new agent dialog**

Find the `else` branch in `handleOpenDialog` (creating a new agent, around line 122–133):
```typescript
    } else {
      setEditingAgent(null)
      setFormData({
        name: '',
        description: '',
        system_prompt: t('default_system_prompt'),
        api_key_id: apiKeys.length > 0 ? apiKeys[0].id : '',
        model_id: 'google/gemini-2.0-flash-lite:free',
        memory_limit: 20,
        is_active: true,
        is_default: agents.length === 0,
      })
```

Replace with:
```typescript
    } else {
      setEditingAgent(null)
      setFormData({
        name: '',
        description: '',
        system_prompt: t('default_system_prompt'),
        api_key_id: apiKeys.length > 0 ? apiKeys[0].id : '',
        model_id: 'google/gemini-2.0-flash-lite:free',
        memory_limit: 20,
        message_delay: 0,
        is_active: true,
        is_default: agents.length === 0,
      })
```

- [ ] **Step 4: Add the message_delay input field in the dialog UI**

Find the `memory_limit` field block in the dialog (around line 532–551):
```typescript
              <div className="space-y-3">
                <Label htmlFor="memory_limit" className="font-semibold flex items-center justify-between">
                  {t('memory_limit_label')}
                  <span className="text-[10px] text-primary font-bold bg-primary/10 px-2 py-0.5 rounded-full">
                    {formData.memory_limit} mensagens
                  </span>
                </Label>
                <Input
                  id="memory_limit"
                  type="number"
                  min="0"
                  max="100"
                  value={formData.memory_limit}
                  onChange={(e) => setFormData({ ...formData, memory_limit: parseInt(e.target.value) || 0 })}
                  className="rounded-xl h-12"
                />
                <p className="text-[11px] text-muted-foreground font-medium">
                  {t('memory_limit_help')}
                </p>
              </div>
```

Replace with:
```typescript
              <div className="space-y-3">
                <Label htmlFor="memory_limit" className="font-semibold flex items-center justify-between">
                  {t('memory_limit_label')}
                  <span className="text-[10px] text-primary font-bold bg-primary/10 px-2 py-0.5 rounded-full">
                    {formData.memory_limit} mensagens
                  </span>
                </Label>
                <Input
                  id="memory_limit"
                  type="number"
                  min="0"
                  max="100"
                  value={formData.memory_limit}
                  onChange={(e) => setFormData({ ...formData, memory_limit: parseInt(e.target.value) || 0 })}
                  className="rounded-xl h-12"
                />
                <p className="text-[11px] text-muted-foreground font-medium">
                  {t('memory_limit_help')}
                </p>
              </div>

              <div className="space-y-3">
                <Label htmlFor="message_delay" className="font-semibold flex items-center justify-between">
                  Delay entre mensagens
                  <span className="text-[10px] text-primary font-bold bg-primary/10 px-2 py-0.5 rounded-full">
                    {formData.message_delay}s
                  </span>
                </Label>
                <Input
                  id="message_delay"
                  type="number"
                  min="0"
                  max="30"
                  step="1"
                  value={formData.message_delay}
                  onChange={(e) => setFormData({ ...formData, message_delay: parseInt(e.target.value) || 0 })}
                  className="rounded-xl h-12"
                />
                <p className="text-[11px] text-muted-foreground font-medium">
                  Tempo de espera após cada mensagem antes de responder. Se outra mensagem chegar dentro desse tempo, o timer reinicia.
                </p>
              </div>
```

- [ ] **Step 5: Commit**

```bash
git add src/pages/Agents.tsx
git commit -m "feat: add message_delay field to agent settings UI"
```

---

## Task 6: Deploy + Manual Verification

- [ ] **Step 1: Deploy the updated edge function**

```bash
supabase functions deploy evolution-webhook --no-verify-jwt
```

Expected: `Deployed evolution-webhook successfully.`

- [ ] **Step 2: Set message_delay = 3 on a test agent via UI**

Open the app → Agents → edit your test agent → set "Delay entre mensagens" to 3 → save.

- [ ] **Step 3: Send a burst of 3 messages from WhatsApp**

Send quickly: "Oi" → "Tudo bem?" → "Preciso de ajuda". Wait at least 5 seconds.

Expected in Supabase Edge Function logs:
- 3 `[WEBHOOK] Triggering background AI task` entries with triggerVersions 1, 2, 3
- 2 `[AI Handler] Debounce: newer message arrived during delay, aborting` entries (for versions 1 and 2)
- 1 AI response sent (for version 3)

Expected in WhatsApp: exactly 1 reply from the agent covering all 3 messages.

- [ ] **Step 4: Verify message_delay = 0 still works (backward compat)**

Set message_delay = 0 on the agent. Send a single message. Verify AI responds normally and no debounce log entries appear.

- [ ] **Step 5: Verify cancellation during LLM call**

Set message_delay = 0. Send one message → immediately send another before the AI response arrives. Check logs: one of the two background tasks should log `discarding response` for check 2.

Note: this scenario is harder to trigger manually since the LLM usually responds in ~2s; try sending the second message very quickly after the first.
