# Draft Mode — Agent Setting

**Date:** 2026-05-11
**Status:** Design approved, ready for plan

## Summary

Add a per-agent toggle that switches the AI from auto-sending replies to producing **drafts** that appear as suggestions in the operator's chat input. Operator reviews/edits/sends manually. Reuses existing debounce, memory, and handoff machinery.

## Motivation

Today every agent reply is sent automatically to the customer. For high-stakes or sensitive conversations, operators want the AI to *propose* a reply they can vet before it goes out. Toggle keeps the workflow opt-in per agent — no behavior change for existing agents.

## User-facing behavior

- New switch in agent edit form: **"Modo rascunho"**. When ON, agent never auto-sends; it generates a draft.
- Each inbound customer message triggers the AI handler exactly as today (debounce + memory delay apply). Instead of calling `sendText`, handler writes the response text to `whatsapp_contacts.draft_response`.
- A new customer message during the debounce window cancels the in-flight draft (existing `ai_trigger_version` mechanism) and regenerates a fresh draft with the full updated history. **Previous draft is overwritten** — there is always at most one active draft per contact.
- Frontend chat UI (`src/pages/Chat.tsx`) shows the draft as a **suggestion chip above the message input** with two actions:
  - **Aceitar** — copies suggestion into input (`newMessage` state), operator can edit before sending.
  - **Descartar (✕)** — clears `draft_response` column without sending.
- Suggestion persists across page reloads and contact switches until cleared.
- Suggestion only disappears when the operator **sends a message** (any text, not necessarily the draft). On successful send, clear `draft_response` and `draft_updated_at`.
- If pipeline stage is `Contato Humano`, AI handler exits early (existing guard) — no draft generated. Handoff tag `<transferir_humano>` detection skips draft save and moves pipeline to `Contato Humano`.

## Data model

Migration `supabase/migrations/20260511XXXXXX_add_draft_mode.sql`:

```sql
ALTER TABLE ai_agents
  ADD COLUMN IF NOT EXISTS draft_mode_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE whatsapp_contacts
  ADD COLUMN IF NOT EXISTS draft_response TEXT,
  ADD COLUMN IF NOT EXISTS draft_updated_at TIMESTAMPTZ;

ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_contacts;
```

Rationale: 1:1 draft per contact (always overwritten) → column on `whatsapp_contacts` is simpler than separate table. No history kept (YAGNI).

## Backend — `supabase/functions/evolution-webhook/ai-handler.ts`

Insert new branch immediately after `cancellation check 2` (after the post-LLM debounce guard at ~line 420), before the existing `sendText` call (~line 443):

```typescript
if (agent.draft_mode_enabled) {
  if (handoffDetected) {
    // Handoff wins over draft — set pipeline, skip draft save
    await supabase
      .from('whatsapp_contacts')
      .update({ pipeline_stage: 'Contato Humano' })
      .eq('id', contactId)
    console.log(`[AI Handler] DRAFT_SKIPPED_FOR_HANDOFF contactId=${contactId}`)
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
    console.error(`[AI Handler] EXIT draft_save_failed contactId=${contactId} code=${draftErr.code} message=${draftErr.message}`)
    return
  }
  console.log(`[AI Handler] DRAFT_SAVED contactId=${contactId} len=${cleanText.length} total_elapsed=${elapsed()}`)
  return
}
// existing sendText flow continues unchanged below
```

Reused-as-is (no change needed):
- `pipeline_stage === 'Contato Humano'` guard (line ~73) — stops draft generation after handoff.
- `message_delay` debounce + `ai_trigger_version` checks (lines ~178-206, ~409-420) — new inbound message during delay cancels in-flight draft.
- Memory limit, model fallback chain, system prompt, handoff instruction injection — all apply identically.

Draft mode does **not** write to `whatsapp_messages` (no fake outbound row). Draft is invisible to customer.

## Frontend

### Agent settings — `src/pages/Agents.tsx`

Add a `Switch` for `draft_mode_enabled` adjacent to the existing `human_handoff_enabled` switch. Save through the same agent update mutation.

### Chat — `src/pages/Chat.tsx`

1. **Fetch contact with new fields** — include `draft_response, draft_updated_at` in contact fetch.

2. **Realtime subscription** — new channel:
   ```typescript
   supabase
     .channel(`contact-draft:${contactId}`)
     .on('postgres_changes',
       { event: 'UPDATE', schema: 'public', table: 'whatsapp_contacts', filter: `id=eq.${contactId}` },
       (payload) => setContact(prev => ({ ...prev, ...payload.new }))
     )
     .subscribe()
   ```
   Unsubscribe on contact change / unmount. Same pattern as existing `whatsapp_messages` subscription.

3. **Suggestion UI** — above the message input row, render when `contact.draft_response` is non-null:
   ```
   ┌────────────────────────────────────────────────┐
   │ 💡 Sugestão da IA                          ✕  │
   │ <draft_response text>                          │
   │ [Aceitar e editar]                             │
   └────────────────────────────────────────────────┘
   ```
   - **Aceitar e editar** → `setNewMessage(contact.draft_response)`. Suggestion chip stays visible (doesn't clear) until message actually sent.
   - **✕ Descartar** → UPDATE `whatsapp_contacts SET draft_response=NULL, draft_updated_at=NULL WHERE id=contactId`. Realtime propagates → chip disappears.

4. **Send handler** — after successful send in `handleSend` (around line 282), clear draft:
   ```typescript
   await supabase
     .from('whatsapp_contacts')
     .update({ draft_response: null, draft_updated_at: null })
     .eq('id', contact.id)
   ```
   Runs unconditionally — if no draft existed, no-op.

### Types

- Regenerate `src/lib/supabase/types.ts` via `supabase gen types typescript --project-id fckenwdyghisdebqauxy`.
- Add `draft_mode_enabled: boolean` to `AiAgent` in `src/lib/types.ts`.
- Add `draft_response: string | null`, `draft_updated_at: string | null` to `WhatsAppContact`.

## Edge cases

| Case | Behavior |
|---|---|
| Customer sends 2nd message during delay | `ai_trigger_version` cancels in-flight draft, regenerates with full new history. Previous draft (if already saved) overwritten by new run. |
| Operator types own text while draft active | Suggestion chip stays visible; input is independent. Operator can ignore or click Aceitar to replace. |
| Operator sends manual text (not the draft) | Send succeeds, draft column cleared (per design — any send clears). |
| Operator switches contact | Draft persists in DB; reappears on return. |
| Pipeline → `Contato Humano` | Existing guard prevents new drafts. Stale draft on column stays until operator clears or sends. |
| Agent toggle turned OFF after drafts exist | Stale drafts remain on contacts until cleared. Future inbound messages take normal auto-send path. |
| Handoff tag `<transferir_humano>` in draft mode | Skip draft save, set `pipeline_stage = 'Contato Humano'`. Operator manually addresses customer. |
| Rate-limit hit (msg/hour) in draft mode | Existing rate-limit branch runs **before** draft branch — sends rate-limit message + sets handoff. Draft mode does not apply when rate-limited (consistent with auto-send behavior). |

## Out of scope (YAGNI)

- Draft history / multiple drafts per contact
- Drafts for non-text messages (audio/image suggestions)
- Push/email notification to operator when draft ready
- Per-contact draft mode override (only per-agent)
- Showing draft staleness (`draft_updated_at` exposed in DB for future use, not surfaced in UI)

## Files touched

- `supabase/migrations/20260511XXXXXX_add_draft_mode.sql` — new
- `supabase/functions/evolution-webhook/ai-handler.ts` — add draft branch
- `src/lib/supabase/types.ts` — regenerated
- `src/lib/types.ts` — `AiAgent`, `WhatsAppContact` extensions
- `src/pages/Agents.tsx` — new toggle in form
- `src/pages/Chat.tsx` — fetch new fields, realtime channel, suggestion UI, clear on send
- `src/hooks/use-agents.ts` — likely already covers via `*` select; verify type passthrough

## Deploy steps

1. Apply migration via Supabase CLI / dashboard.
2. Regenerate types.
3. Deploy edge function: `supabase functions deploy evolution-webhook --no-verify-jwt`.
4. AI smoke test (CLAUDE.md step 3).
5. Build + deploy frontend.
6. Manual verify: toggle draft mode on test agent → send inbound message → draft appears in chat input area → click send → draft clears.
