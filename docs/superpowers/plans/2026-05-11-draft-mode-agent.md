# Draft Mode Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-agent toggle that, when enabled, makes the AI write its response into a `draft_response` column on the contact instead of sending it via Evolution API. The chat UI shows the draft as a suggestion chip above the input; operator clicks "Aceitar e editar" to prefill the input, and any send by the operator clears the draft. Memory delay (debounce) and `Contato Humano` handoff already-existing behaviors apply unchanged.

**Architecture:** Single-column flag on `ai_agents` (`draft_mode_enabled`) + two new columns on `whatsapp_contacts` (`draft_response`, `draft_updated_at`). The `evolution-webhook/ai-handler.ts` branches before `sendText` — if draft mode is on, it UPDATEs the contact row and returns. Frontend subscribes to `whatsapp_contacts` realtime channel (new publication entry) and renders a suggestion chip. Operator send clears the draft. Reuses existing `ai_trigger_version` debounce and `pipeline_stage === 'Contato Humano'` guard with no changes.

**Tech Stack:** Supabase Postgres, Supabase Realtime, Supabase Edge Functions (Deno), React 19, Vite, TypeScript, shadcn/ui (`Switch`), oxlint, oxfmt. Repo has no test suite (CLAUDE.md: `pnpm test` is no-op) — verification is manual smoke testing + the `evolution-debug` smoke endpoint after edge-function deploys.

**Spec:** `docs/superpowers/specs/2026-05-11-draft-mode-agent-design.md`

---

## Task 1: Database migration

**Files:**
- Create: `supabase/migrations/20260511120000_add_draft_mode.sql`

- [ ] **Step 1: Write migration file**

Create `supabase/migrations/20260511120000_add_draft_mode.sql` with:

```sql
-- Per-agent toggle: when true, AI handler writes draft instead of sending
ALTER TABLE public.ai_agents
  ADD COLUMN IF NOT EXISTS draft_mode_enabled BOOLEAN NOT NULL DEFAULT false;

-- Per-contact draft slot (1:1, overwritten on each regeneration)
ALTER TABLE public.whatsapp_contacts
  ADD COLUMN IF NOT EXISTS draft_response TEXT,
  ADD COLUMN IF NOT EXISTS draft_updated_at TIMESTAMPTZ;

-- Enable realtime on whatsapp_contacts so frontend can subscribe to draft updates.
-- Same pattern as 20260310173815_enable_realtime_for_messages.sql.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'whatsapp_contacts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.whatsapp_contacts;
  END IF;
END$$;
```

- [ ] **Step 2: Apply migration**

Run:
```bash
supabase db push
```
Expected: migration `20260511120000_add_draft_mode.sql` listed as applied. If `supabase db push` is not configured locally, apply via Supabase dashboard SQL editor by pasting the file contents.

- [ ] **Step 3: Verify columns and publication exist**

Run via Supabase SQL editor (or psql):
```sql
SELECT column_name FROM information_schema.columns
  WHERE table_schema='public' AND table_name='ai_agents' AND column_name='draft_mode_enabled';
SELECT column_name FROM information_schema.columns
  WHERE table_schema='public' AND table_name='whatsapp_contacts'
    AND column_name IN ('draft_response','draft_updated_at');
SELECT tablename FROM pg_publication_tables
  WHERE pubname='supabase_realtime' AND tablename='whatsapp_contacts';
```
Expected: 1 row, 2 rows, 1 row respectively.

- [ ] **Step 4: Regenerate TypeScript types**

Run:
```bash
supabase gen types typescript --project-id fckenwdyghisdebqauxy > src/lib/supabase/types.ts
```
Expected: `src/lib/supabase/types.ts` now contains `draft_mode_enabled: boolean` in `ai_agents` Row/Insert/Update, and `draft_response: string | null`, `draft_updated_at: string | null` in `whatsapp_contacts`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260511120000_add_draft_mode.sql src/lib/supabase/types.ts
git commit -m "feat(db): add draft_mode_enabled + draft_response columns and realtime publication"
```

---

## Task 2: Update domain types

**Files:**
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Add draft fields to `AIAgent` and `WhatsAppContact`**

In `src/lib/types.ts`, modify the `AIAgent` interface (currently ends at line 48) to add `draft_mode_enabled` right after `human_handoff_enabled`:

```typescript
export interface AIAgent {
  id: string
  user_id: string
  name: string
  description: string | null
  system_prompt: string
  api_key_id: string | null
  audio_api_key_id: string | null
  model_id: string
  fallback_model_ids: string[]
  memory_limit: number
  message_delay: number
  human_handoff_enabled: boolean
  draft_mode_enabled: boolean
  is_active: boolean
  is_default?: boolean
  created_at: string
  updated_at: string
}
```

Modify `WhatsAppContact` (currently ends at line 66) to add the two draft fields after `created_at`:

```typescript
export interface WhatsAppContact {
  id: string
  user_id: string
  remote_jid: string
  phone_number: string | null
  push_name: string | null
  profile_picture_url: string | null
  last_message_at: string | null
  classification: string | null
  score: number | null
  ai_analysis_summary: string | null
  ai_agent_id: string | null
  pipeline_stage?: string | null
  custom_name?: string | null
  custom_phone?: string | null
  created_at: string
  draft_response?: string | null
  draft_updated_at?: string | null
}
```

The two new contact fields are optional (`?`) so existing fetches that don't select them stay type-compatible.

- [ ] **Step 2: Verify build still compiles**

Run:
```bash
pnpm build:dev
```
Expected: build succeeds. Any TS error about missing property → fix the caller; do not relax the new type.

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(types): add draft_mode_enabled and draft fields to domain types"
```

---

## Task 3: Edge function — draft branch in ai-handler

**Files:**
- Modify: `supabase/functions/evolution-webhook/ai-handler.ts` (insert new branch around line 422-443)

- [ ] **Step 1: Locate insertion point**

Open `supabase/functions/evolution-webhook/ai-handler.ts`. Find the block starting at line ~408 (`// Cancellation check 2`) through line ~443 (`const sendRes = await fetch(...)`).

The new branch must run **after** the post-LLM debounce guard (the `contactVersionBeforeSend` check ~line 415-420) and **before** the existing handoff `pipeline_stage` update (~line 422-434) and `sendText` (~line 443). This ensures:
1. Cancellation already checked
2. `handoffDetected` already computed (line ~383)
3. `cleanText` already stripped of tags (line ~386)

- [ ] **Step 2: Insert the draft branch**

Locate this block (around line 415-420):

```typescript
    if (contactVersionBeforeSend?.ai_trigger_version !== triggerVersion) {
      console.log(
        `[AI Handler] EXIT debounce_superseded_post_llm contactId=${contactId} expected_v=${triggerVersion} current_v=${contactVersionBeforeSend?.ai_trigger_version}`,
      )
      return
    }
```

Immediately AFTER that `return` block (before the `if (handoffDetected) { ... update pipeline_stage ...}` block at line ~422), add:

```typescript
    if (agent.draft_mode_enabled) {
      if (handoffDetected) {
        const { error: handoffStageErr } = await supabase
          .from('whatsapp_contacts')
          .update({
            pipeline_stage: 'Contato Humano',
            draft_response: null,
            draft_updated_at: null,
          })
          .eq('id', contactId)
        if (handoffStageErr) {
          console.error(
            `[AI Handler] WARN draft_handoff_update_failed contactId=${contactId} supabase_message=${handoffStageErr.message}`,
          )
        }
        console.log(
          `[AI Handler] DRAFT_SKIPPED_FOR_HANDOFF contactId=${contactId} total_elapsed=${elapsed()}`,
        )
        return
      }

      const { error: draftErr } = await supabase
        .from('whatsapp_contacts')
        .update({
          draft_response: cleanText,
          draft_updated_at: new Date().toISOString(),
        })
        .eq('id', contactId)

      if (draftErr) {
        console.error(
          `[AI Handler] EXIT draft_save_failed contactId=${contactId} supabase_code=${draftErr.code} supabase_message=${draftErr.message}`,
        )
        return
      }

      console.log(
        `[AI Handler] DRAFT_SAVED contactId=${contactId} len=${cleanText.length} total_elapsed=${elapsed()}`,
      )
      return
    }
```

Do not modify any other code in this file. The existing `sendText` branch, handoff update branch, message upsert, contact update, and LID merge logic all stay exactly as they are — they only run when `draft_mode_enabled` is false.

- [ ] **Step 3: Deploy edge function**

Run:
```bash
supabase functions deploy evolution-webhook --no-verify-jwt
```
Expected: function deployed. The `--no-verify-jwt` flag is required (CLAUDE.md: omitting resets `verify_jwt = true` causing 401s).

- [ ] **Step 4: Run AI smoke test**

Get the service role key (it should already be in your local env or available from Supabase dashboard → Project Settings → API). Then run:

```bash
curl "https://fckenwdyghisdebqauxy.supabase.co/functions/v1/evolution-debug?endpoint=test-ai" \
  -H "Authorization: Bearer <service_role_key>"
```

Expected: JSON response with `"ok": true` and every check `true`. Specifically `fk_join_ok` and `api_key_present` must both be `true`. If any check is false, do NOT proceed — the AI handler will silently fail in production. Logs at: https://supabase.com/dashboard/project/fckenwdyghisdebqauxy/functions

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/evolution-webhook/ai-handler.ts
git commit -m "feat(ai-handler): branch to draft_response column when agent.draft_mode_enabled"
```

---

## Task 4: Agent settings UI — toggle

**Files:**
- Modify: `src/pages/Agents.tsx` (formData state, dialog open/reset, form section)

- [ ] **Step 1: Add `draft_mode_enabled` to `formData` initial state**

In `src/pages/Agents.tsx`, find the `useState` for `formData` at line 115 and add `draft_mode_enabled: false` right after `human_handoff_enabled: false`:

```typescript
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    system_prompt: '',
    api_key_id: '',
    audio_api_key_id: '__none__',
    model_id: 'z-ai/glm-4.5-air:free',
    memory_limit: 20,
    message_delay: 0,
    human_handoff_enabled: false,
    draft_mode_enabled: false,
    is_active: true,
    is_default: false,
  })
```

- [ ] **Step 2: Populate field when editing an existing agent**

At line ~183 inside `handleOpenDialog`, where `human_handoff_enabled: agent.human_handoff_enabled ?? false,` is set, add a similar line right after:

```typescript
        human_handoff_enabled: agent.human_handoff_enabled ?? false,
        draft_mode_enabled: agent.draft_mode_enabled ?? false,
```

- [ ] **Step 3: Reset field when opening dialog for a new agent**

At line ~199, where the "new agent" branch sets `human_handoff_enabled: false,`, add right after:

```typescript
        human_handoff_enabled: false,
        draft_mode_enabled: false,
```

- [ ] **Step 4: Render the toggle in the dialog form**

Find the "Transferência para Humano" toggle block (lines 996-1021). Directly AFTER its closing `</div>` (after line 1021), insert a new `<div className="space-y-3">` block with the same shape:

```tsx
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Label className="font-semibold">Modo Rascunho</Label>
                    <p className="text-[11px] text-muted-foreground font-medium">
                      Em vez de enviar automaticamente, a IA gera um rascunho que aparece como
                      sugestão no campo de resposta do chat. O operador revisa, edita e envia
                      manualmente.
                    </p>
                  </div>
                  <Switch
                    checked={formData.draft_mode_enabled}
                    onCheckedChange={(checked) =>
                      setFormData({ ...formData, draft_mode_enabled: checked })
                    }
                  />
                </div>
              </div>
```

- [ ] **Step 5: Verify the save mutation picks up the new field**

Open `src/hooks/use-agents.ts` and confirm the save/update mutation passes the whole `formData` (or otherwise includes `draft_mode_enabled`) to the Supabase upsert call. If the mutation uses an explicit allowlist of fields, add `draft_mode_enabled` to that list. If it spreads `formData` directly, no change needed.

Run:
```bash
grep -nE "draft_mode_enabled|human_handoff_enabled" src/hooks/use-agents.ts
```
Expected: at least one match for `human_handoff_enabled`. If `human_handoff_enabled` is hardcoded in the upsert payload, add `draft_mode_enabled` in the same place. If the hook spreads `formData`, no change needed.

- [ ] **Step 6: Manual UI verification**

Run:
```bash
pnpm dev --port 8085
```
Open http://localhost:8085, log in, go to **Agentes**, edit an existing agent. Confirm:
1. New "Modo Rascunho" toggle is visible below "Transferência para Humano".
2. Toggle defaults to OFF for existing agents.
3. Toggle ON, save → verify in Supabase dashboard SQL editor: `SELECT name, draft_mode_enabled FROM ai_agents ORDER BY updated_at DESC LIMIT 5;` shows the updated value.
4. Reopen the edit dialog → toggle still ON.

- [ ] **Step 7: Commit**

```bash
git add src/pages/Agents.tsx src/hooks/use-agents.ts
git commit -m "feat(agents-ui): add Modo Rascunho toggle to agent settings"
```

(Omit `src/hooks/use-agents.ts` from the `git add` if step 5 didn't require changes.)

---

## Task 5: Chat UI — fetch draft + realtime subscription

**Files:**
- Modify: `src/pages/Chat.tsx`

- [ ] **Step 1: Update contact fetch to include draft fields**

The current fetch at line 80-84 uses `select('*')`, so `draft_response` and `draft_updated_at` already come down automatically. No change needed. Verify by adding a `console.log(contactData)` temporarily after line 84 in dev and confirming both fields are present in the response.

Remove the `console.log` before committing.

- [ ] **Step 2: Add a realtime subscription for the contact row**

In the `useEffect` at line 74-149, after the existing message channel subscribe (line 134, after `.subscribe()`), add a second channel for the contact:

```typescript
    const contactChannel = supabase
      .channel(`contact_${id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'whatsapp_contacts',
          filter: `id=eq.${id}`,
        },
        (payload) => {
          setContact((prev) =>
            prev ? { ...prev, ...(payload.new as Partial<WhatsAppContact>) } : prev,
          )
        },
      )
      .subscribe()
```

Then update the cleanup return at line 145-148 to remove BOTH channels:

```typescript
    return () => {
      supabase.removeChannel(channel)
      supabase.removeChannel(contactChannel)
      if (container) container.removeEventListener('scroll', handleScroll)
    }
```

- [ ] **Step 3: Manual realtime verification**

With `pnpm dev --port 8085` running, open the chat for any contact. In the Supabase SQL editor, run:

```sql
UPDATE whatsapp_contacts
  SET draft_response = 'TESTE RASCUNHO', draft_updated_at = NOW()
  WHERE id = '<the contact id from the URL>';
```

Open browser devtools console. The realtime event should fire — confirm via a temporary `console.log('contact update', payload.new)` inside the handler, OR by adding the UI in Task 6 first and visually confirming.

Clear the test draft after:
```sql
UPDATE whatsapp_contacts SET draft_response = NULL, draft_updated_at = NULL WHERE id = '<id>';
```

- [ ] **Step 4: Commit**

```bash
git add src/pages/Chat.tsx
git commit -m "feat(chat): subscribe to whatsapp_contacts realtime for draft updates"
```

---

## Task 6: Chat UI — suggestion chip + accept/discard

**Files:**
- Modify: `src/pages/Chat.tsx` (input section ~line 579-603, handleSendMessage ~line 280-299)

- [ ] **Step 1: Add Sparkles + X icon imports**

At the top of `src/pages/Chat.tsx`, find the lucide-react import line and add `Sparkles` and `X` (if not already imported). For example, if the existing line is:

```typescript
import { ArrowLeft, Loader2, Send } from 'lucide-react'
```

change it to:

```typescript
import { ArrowLeft, Loader2, Send, Sparkles, X } from 'lucide-react'
```

(Adjust to match the actual existing imports — keep all current icons, add the two new ones.)

- [ ] **Step 2: Add a `handleDiscardDraft` callback**

Add this function near `handleSendMessage` (around line 280, before it):

```typescript
  const handleDiscardDraft = async () => {
    if (!contact) return
    await supabase
      .from('whatsapp_contacts')
      .update({ draft_response: null, draft_updated_at: null })
      .eq('id', contact.id)
  }

  const handleAcceptDraft = () => {
    if (!contact?.draft_response) return
    setNewMessage(contact.draft_response)
  }
```

The realtime channel from Task 5 will propagate the cleared draft and remove the chip automatically.

- [ ] **Step 3: Clear draft on successful send**

Modify `handleSendMessage` at line 280-299. Replace the existing `try` block contents to clear the draft after a successful send:

```typescript
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newMessage.trim() || !contact) return

    const text = newMessage.trim()
    setNewMessage('')
    setIsSending(true)

    try {
      const { data, error } = await supabase.functions.invoke('evolution-send-message', {
        body: { contactId: contact.id, text },
      })
      if (error) throw error
      if (data?.error) throw new Error(data.error)

      if (contact.draft_response) {
        await supabase
          .from('whatsapp_contacts')
          .update({ draft_response: null, draft_updated_at: null })
          .eq('id', contact.id)
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to send message')
    } finally {
      setIsSending(false)
    }
  }
```

The `if (contact.draft_response)` guard avoids a redundant UPDATE when there was no draft.

- [ ] **Step 4: Render the suggestion chip above the input**

Find the input section starting at line 580 (`<div className="p-3 sm:p-5 bg-background/50 ...`). Replace its current contents (lines 580-603) with this version that includes the chip:

```tsx
        {/* Input */}
        <div className="p-3 sm:p-5 bg-background/50 backdrop-blur-xl border-t border-border/40 shrink-0 z-10">
          {contact.draft_response && (
            <div className="mb-3 rounded-2xl border border-primary/30 bg-primary/5 px-4 py-3 flex items-start gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
              <Sparkles className="h-4 w-4 text-primary mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-semibold text-primary mb-1">Sugestão da IA</p>
                <p className="text-[13px] text-foreground/90 whitespace-pre-wrap break-words">
                  {contact.draft_response}
                </p>
                <button
                  type="button"
                  onClick={handleAcceptDraft}
                  className="mt-2 text-[11px] font-semibold text-primary hover:underline"
                >
                  Aceitar e editar
                </button>
              </div>
              <button
                type="button"
                onClick={handleDiscardDraft}
                aria-label="Descartar sugestão"
                className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          <form onSubmit={handleSendMessage} className="flex gap-2.5 sm:gap-3 items-end">
            <div className="relative flex-1">
              <Input
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                placeholder={t('type_message' as TranslationKey) || 'Type a message...'}
                className="w-full bg-card border-border shadow-sm rounded-2xl sm:rounded-full h-12 sm:h-14 px-5 sm:px-6 text-[14px] sm:text-[15px] font-medium pr-12 focus-visible:ring-primary/20 transition-all"
              />
            </div>
            <Button
              type="submit"
              disabled={isSending || !newMessage.trim()}
              size="icon"
              className="h-12 w-12 sm:h-14 sm:w-14 rounded-2xl sm:rounded-full shrink-0 shadow-subtle hover:scale-105 transition-all duration-300"
            >
              {isSending ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Send className="h-5 w-5 ml-0.5" />
              )}
            </Button>
          </form>
        </div>
```

- [ ] **Step 5: Verify lint + format**

Run:
```bash
pnpm lint
pnpm format:check
```
Expected: no errors. If formatter complains, run `pnpm format`.

- [ ] **Step 6: Build**

Run:
```bash
pnpm build:dev
```
Expected: build succeeds with no TS errors.

- [ ] **Step 7: Commit**

```bash
git add src/pages/Chat.tsx
git commit -m "feat(chat): render AI draft suggestion chip with accept and discard"
```

---

## Task 7: End-to-end manual verification

**Files:** None modified — verification only.

- [ ] **Step 1: Set up a test agent in draft mode**

In the running app (`pnpm dev --port 8085`):
1. Go to **Agentes**, edit one agent (preferably the default), enable **Modo Rascunho**, save.
2. Confirm `SELECT name, draft_mode_enabled FROM ai_agents WHERE id = '<id>';` returns `true`.

- [ ] **Step 2: Trigger an inbound message**

Send a real WhatsApp message from a test number to the connected instance. Wait for the AI handler to process (memory delay + LLM latency, typically 5-15s).

- [ ] **Step 3: Verify draft appears (NOT sent)**

In Supabase logs (`evolution-webhook` function logs):
- Look for the line `[AI Handler] DRAFT_SAVED contactId=<id> len=<n>`.
- Confirm there is NO `[AI Handler] send_ok` or `send_start` line for this trigger.

In the database:
```sql
SELECT id, draft_response, draft_updated_at FROM whatsapp_contacts WHERE id = '<contact id>';
```
Expected: `draft_response` populated with AI text, `draft_updated_at` recent.

In WhatsApp (the customer side): NO message received from the agent.

- [ ] **Step 4: Verify chip appears in the chat UI**

Open the chat for this contact in the dashboard. The "Sugestão da IA" chip should be visible above the input with the draft text. Realtime should make it appear without a refresh.

- [ ] **Step 5: Test "Aceitar e editar"**

Click **Aceitar e editar**. The text should land in the input box. The chip should still be visible. Edit the text. Click send. Verify:
- The edited text is sent to the customer via Evolution (visible in WhatsApp + in the message list).
- The chip disappears (realtime).
- `SELECT draft_response FROM whatsapp_contacts WHERE id = '<id>';` returns NULL.

- [ ] **Step 6: Test debounce regeneration**

Send a second inbound message from the customer **during** the memory delay window (set `message_delay = 30` on the agent first to make this easy to time). Confirm in the logs:
- A new `[AI Handler] DRAFT_SAVED` line fires for the combined context.
- The chip in the UI updates to show the new draft (overwrites old).

Restore `message_delay` to its original value afterwards.

- [ ] **Step 7: Test handoff**

In the chat, manually change the contact's pipeline stage to `Contato Humano` (or use the existing UI control). Send another inbound message. Verify in logs:
- `[AI Handler] EXIT handoff_active` fires.
- NO new draft is saved.

- [ ] **Step 8: Test discard**

Generate a fresh draft (toggle pipeline back, send inbound). When chip appears, click the **✕**. Confirm:
- Chip disappears.
- `draft_response` is NULL in DB.
- No message sent to customer.

- [ ] **Step 9: Test toggle OFF — auto-send restored**

Edit the test agent, turn **Modo Rascunho** OFF, save. Send another inbound. Confirm:
- `[AI Handler] send_ok` fires (no `DRAFT_SAVED`).
- Customer receives the message in WhatsApp normally.

- [ ] **Step 10: Final commit if any fixes needed**

If any verification step uncovered a bug, fix it in the appropriate task's files and commit with a `fix:` prefix.

---

## Rollback

If anything goes wrong after deploy:

1. Toggle all agents' `draft_mode_enabled` to `false`:
   ```sql
   UPDATE ai_agents SET draft_mode_enabled = false;
   ```
   This restores auto-send behavior without redeploying.

2. If the edge function itself is broken (e.g., the new branch has a bug that throws before the early return), redeploy the previous version from git:
   ```bash
   git revert <commit-sha-of-task-3>
   supabase functions deploy evolution-webhook --no-verify-jwt
   ```

3. The migration is additive only — no need to revert columns. Leaving `draft_mode_enabled = false` and `draft_response = NULL` is a complete neutral state.

---

## Files Touched Summary

- `supabase/migrations/20260511120000_add_draft_mode.sql` (new)
- `supabase/functions/evolution-webhook/ai-handler.ts` (+~35 lines, draft branch only)
- `src/lib/supabase/types.ts` (regenerated)
- `src/lib/types.ts` (+3 lines)
- `src/pages/Agents.tsx` (+~20 lines)
- `src/pages/Chat.tsx` (+~50 lines: realtime channel, handlers, chip JSX)
- `src/hooks/use-agents.ts` (potentially +1 line if explicit field list)
