# Message Batching Delay — Design Spec

**Date:** 2026-04-20  
**Status:** Approved  

## Problem

When a contact sends multiple messages in quick succession ("Boa tarde" / "Tudo certo?" / "Consegue falar agora?"), the AI agent responds to each one individually. This produces fragmented, unnatural replies and wastes API calls.

## Goal

Introduce a configurable debounce window per AI agent. After each inbound message, the system waits N seconds before invoking the AI. If a new message arrives within the window, the timer resets. The AI only responds once — after the burst ends — with full context of all messages.

## Approach: Sleep + Generation Counter (Option A)

Stateless Edge Functions cannot share in-memory state between invocations. The solution uses a `ai_trigger_version` integer column on `whatsapp_contacts` as a lightweight generation counter. Each inbound message increments it atomically; background tasks compare their captured version against the current DB value to decide whether to proceed or cancel.

## Data Model

### Migration

```sql
-- Debounce generation counter per contact
ALTER TABLE whatsapp_contacts
  ADD COLUMN ai_trigger_version INTEGER NOT NULL DEFAULT 0;

-- Configurable delay per agent (seconds), same pattern as memory_limit
ALTER TABLE ai_agents
  ADD COLUMN message_delay INTEGER NOT NULL DEFAULT 0;
```

### Backward Compatibility

`message_delay = 0` (default) means no sleep — behavior is identical to current. Existing agents are unaffected.

## Flow

```
Inbound message arrives
  → webhook saves message to DB
  → UPDATE whatsapp_contacts SET ai_trigger_version = ai_trigger_version + 1
      WHERE id = $contactId RETURNING ai_trigger_version  (atomic)
  → captures myVersion from RETURNING
  → spawns background task via EdgeRuntime.waitUntil

Background task:
  → sleep(agent.message_delay seconds)
  → SELECT ai_trigger_version FROM whatsapp_contacts WHERE id = $contactId
  → if current_version != myVersion → CANCEL (newer message arrived, newer task will handle it)
  → if current_version == myVersion → call OpenRouter

After OpenRouter returns:
  → SELECT ai_trigger_version again
  → if current_version != myVersion → DISCARD response (new message arrived during LLM call)
  → if current_version == myVersion → send via Evolution API + save to DB
```

## Components Changed

| File | Change |
|---|---|
| `supabase/migrations/20260420_message_delay.sql` | New migration adding both columns |
| `supabase/functions/evolution-webhook/index.ts` | Increment `ai_trigger_version`, pass `myVersion` to background task |
| `supabase/functions/evolution-webhook/ai-handler.ts` | Accept `triggerVersion` param, add 2 cancellation checks |
| Agent settings UI | Add `message_delay` field (0–30s) alongside `memory_limit` |

## AI Handler Signature Change

```typescript
// Before
export async function processAiResponse(
  userId: string,
  contactId: string,
  supabaseUrl: string,
  supabaseKey: string,
): Promise<void>

// After
export async function processAiResponse(
  userId: string,
  contactId: string,
  supabaseUrl: string,
  supabaseKey: string,
  triggerVersion: number,  // new param
  messageDelay: number,    // new param (seconds)
): Promise<void>
```

## Cancellation Points

1. **After sleep** — check `ai_trigger_version` vs `myVersion`. Abort if changed.
2. **Before sending** — check `ai_trigger_version` again after OpenRouter returns. Discard response if changed.

## Edge Cases

| Scenario | Behavior |
|---|---|
| 5 messages in burst | 5 background tasks sleep; only the last passes check 1; 4 tasks exit with a single lightweight query |
| Message arrives during OpenRouter call | Webhook increments version; after LLM returns, check 2 detects the change and discards; new task fires AI again with full context |
| `message_delay = 0` | `setTimeout(0)` returns immediately; 2 extra DB reads per message (negligible) |
| UPDATE fails | Webhook logs error and does NOT spawn background task — message is saved, agent skips responding this round |
| Two webhooks hit same contact simultaneously | Postgres serializes the UPDATE per row; versions increment correctly (1→2); only the highest-version task survives |
| Edge Function timeout | Max delay 30s + OpenRouter ~10s + overhead << 150s wall time limit |

## UI

Add `message_delay` field to the agent settings page (same location as `memory_limit`):
- Input type: number, min 0, max 30, step 1
- Label: "Delay entre mensagens (segundos)"
- Default: 0

## Out of Scope

- Per-contact delay override
- Cancelling already-sent messages
- Grouping media messages (only text debouncing)
