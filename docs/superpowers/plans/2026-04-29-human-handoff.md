# Human Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI agent detects `<transferir_humano>` tag in its own response, strips it from visible text, moves contact to `pipeline_stage = 'Contato Humano'`, and blocks further AI replies until operator manually moves contact out of that stage.

**Architecture:** One DB column (`human_handoff_enabled` on `ai_agents`) gates the feature per agent. The AI handler reads `pipeline_stage` on early entry and exits immediately if already in handoff. When LLM response contains the tag, handler strips it, sends clean text, and updates the stage. Pipeline page gets a new amber "Contato Humano" column. Agent settings page gets a toggle.

**Tech Stack:** Supabase (Postgres migration + Edge Function Deno), React 19 + TypeScript, Tailwind + shadcn/ui.

---

## File Map

| File                                                                 | Action     | Responsibility                                |
| -------------------------------------------------------------------- | ---------- | --------------------------------------------- |
| `supabase/migrations/20260429000001_add_human_handoff_to_agents.sql` | Create     | Add `human_handoff_enabled` column            |
| `src/lib/supabase/types.ts`                                          | Regenerate | Auto-gen after migration                      |
| `src/lib/types.ts`                                                   | Modify     | Add field to `AIAgent` interface              |
| `supabase/functions/evolution-webhook/ai-handler.ts`                 | Modify     | Gate + tag detection + stage update           |
| `src/pages/Pipeline.tsx`                                             | Modify     | Add "Contato Humano" Kanban column            |
| `src/hooks/use-agents.ts`                                            | Modify     | Pass `human_handoff_enabled` in create/update |
| `src/pages/Agents.tsx`                                               | Modify     | Add toggle UI to agent form                   |

---

### Task 1: DB Migration

**Files:**

- Create: `supabase/migrations/20260429000001_add_human_handoff_to_agents.sql`

- [ ] **Step 1: Write migration**

```sql
ALTER TABLE public.ai_agents
  ADD COLUMN IF NOT EXISTS human_handoff_enabled BOOLEAN NOT NULL DEFAULT false;
```

- [ ] **Step 2: Push migration**

```bash
supabase db push
```

Expected: migration applied with no errors. If `relation already exists` → safe to ignore (IF NOT EXISTS guard).

- [ ] **Step 3: Regenerate TypeScript types**

```bash
supabase gen types typescript --project-id fckenwdyghisdebqauxy > src/lib/supabase/types.ts
```

Expected: `src/lib/supabase/types.ts` now has `human_handoff_enabled: boolean` in `ai_agents` Row/Insert/Update.

- [ ] **Step 4: Update `AIAgent` interface in `src/lib/types.ts`**

Add `human_handoff_enabled: boolean` after `message_delay`:

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
  memory_limit: number
  message_delay: number
  human_handoff_enabled: boolean // <-- add this line
  is_active: boolean
  is_default?: boolean
  created_at: string
  updated_at: string
}
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260429000001_add_human_handoff_to_agents.sql src/lib/supabase/types.ts src/lib/types.ts
git commit -m "feat: add human_handoff_enabled column to ai_agents"
```

---

### Task 2: AI Handler — Gate + Tag Detection + Stage Update

**Files:**

- Modify: `supabase/functions/evolution-webhook/ai-handler.ts`

The handler currently:

1. Loads contact (selects `ai_agent_id, remote_jid`) — line 21–32
2. Loads agent — line 41–53
3. Debounce sleep — line 72–77
4. Version check 1 — line 80–98
5. Builds history + calls LLM — line 118–200
6. Sends to Evolution — line 267–288
7. Saves message to DB with `text: responseText` — line 333–367
8. Updates contact `pipeline_stage = 'Em Conversa'` — line 354–367

Changes needed:

- Step A: Also select `pipeline_stage` from contact query
- Step B: Early-exit gate right after contact load
- Step C: Also select `human_handoff_enabled` from agent query
- Step D: Inject handoff instruction into system prompt when enabled
- Step E: After LLM response, detect/strip tag → `cleanText`
- Step F: If tag found, update `pipeline_stage = 'Contato Humano'` before sending
- Step G: Send `cleanText` (not `responseText`) to Evolution
- Step H: Save `cleanText` to DB (not `responseText`)

- [ ] **Step 1: Update contact select to include `pipeline_stage` (line 22)**

Change:

```typescript
const { data: contact, error: contactError } = await supabase
  .from('whatsapp_contacts')
  .select('ai_agent_id, remote_jid')
  .eq('id', contactId)
  .single()
```

To:

```typescript
const { data: contact, error: contactError } = await supabase
  .from('whatsapp_contacts')
  .select('ai_agent_id, remote_jid, pipeline_stage')
  .eq('id', contactId)
  .single()
```

- [ ] **Step 2: Add early-exit gate after `no_agent_assigned` check (after line 39)**

After the block:

```typescript
if (!contact.ai_agent_id) {
  console.log(
    `[AI Handler] EXIT no_agent_assigned contactId=${contactId} remote_jid=${contact.remote_jid}`,
  )
  return
}
```

Add:

```typescript
if (contact.pipeline_stage === 'Contato Humano') {
  console.log(
    `[AI Handler] EXIT handoff_active contactId=${contactId} remote_jid=${contact.remote_jid} pipeline_stage=${contact.pipeline_stage}`,
  )
  return
}
```

- [ ] **Step 3: Update agent select to include `human_handoff_enabled` (line 43)**

Change:

```typescript
      .select('*, user_api_keys!ai_agents_api_key_id_fkey(*)')
```

The `*` already covers all columns so no change needed — `human_handoff_enabled` will be included automatically. Verify `agent.human_handoff_enabled` is accessible after this (it will be since `*` is used).

No file change needed for step 3.

- [ ] **Step 4: Build effective system prompt with handoff injection (after line 113, before LLM call)**

After the `console.log api_key_ok` line (line 113) and before the messages query (line 118), add:

```typescript
const HANDOFF_INSTRUCTION = agent.human_handoff_enabled
  ? '\n\nQuando o cliente pedir explicitamente para falar com um atendente humano, ou quando a situação exigir atenção humana que você não consiga resolver, inclua a tag <transferir_humano> no final da sua resposta. Exemplo: "Claro, vou transferir você para um de nossos atendentes! <transferir_humano>". Remova a tag do texto visível — ela é processada automaticamente.'
  : ''
const effectiveSystemPrompt = (agent.system_prompt || '') + HANDOFF_INSTRUCTION
```

- [ ] **Step 5: Use `effectiveSystemPrompt` in the LLM call (line 178)**

Change:

```typescript
          { role: 'system', content: agent.system_prompt },
```

To:

```typescript
          { role: 'system', content: effectiveSystemPrompt },
```

- [ ] **Step 6: Add tag detection function and strip after LLM response (after line 211)**

After the `llm_response_ok` log (line 211), add:

```typescript
// Strip <transferir_humano> tag (self-closing, open-only, or with content)
const HANDOFF_TAG_RE = /<transferir_humano\s*(?:\/>|>[\s\S]*?<\/transferir_humano>|>)/g
const handoffDetected = agent.human_handoff_enabled && HANDOFF_TAG_RE.test(responseText)
const cleanText = responseText
  .replace(/<transferir_humano\s*(?:\/>|>[\s\S]*?<\/transferir_humano>|>)/g, '')
  .trim()

if (handoffDetected) {
  console.log(`[AI Handler] handoff_tag_detected contactId=${contactId} — transferring to human`)
}
```

Note: `HANDOFF_TAG_RE` is used once with `.test()` (advances lastIndex), then a fresh inline regex is used for `.replace()` to avoid state issues.

- [ ] **Step 7: Update contact `pipeline_stage` to `'Contato Humano'` before send if handoff detected**

After the version check 2 block (after line 263) and before the `send_start` log (line 265), add:

```typescript
if (handoffDetected) {
  const { error: handoffStageErr } = await supabase
    .from('whatsapp_contacts')
    .update({ pipeline_stage: 'Contato Humano' })
    .eq('id', contactId)
  if (handoffStageErr) {
    console.error(
      `[AI Handler] WARN handoff_stage_update_failed contactId=${contactId} supabase_message=${handoffStageErr.message}`,
    )
  } else {
    console.log(`[AI Handler] handoff_stage_set contactId=${contactId}`)
  }
}
```

- [ ] **Step 8: Send `cleanText` instead of `responseText` to Evolution (line 274)**

Change:

```typescript
        text: responseText,
```

To:

```typescript
        text: cleanText,
```

- [ ] **Step 9: Save `cleanText` to `whatsapp_messages` instead of `responseText` (line 338)**

Change:

```typescript
        text: responseText,
```

To:

```typescript
        text: cleanText,
```

Note: There are two `text: responseText` usages — one in the Evolution send body (Step 8) and one in the `supabase.from('whatsapp_messages').upsert(...)` call. Make sure to change both.

- [ ] **Step 10: Update final contact stage update to skip `'Em Conversa'` when handoff was set (line 354-367)**

Change the existing contact update block:

```typescript
const { error: contactUpdateError } = await supabase
  .from('whatsapp_contacts')
  .update({
    pipeline_stage: 'Em Conversa',
    last_message_at: new Date().toISOString(),
  })
  .eq('id', contactId)
```

To:

```typescript
const { error: contactUpdateError } = await supabase
  .from('whatsapp_contacts')
  .update({
    pipeline_stage: handoffDetected ? 'Contato Humano' : 'Em Conversa',
    last_message_at: new Date().toISOString(),
  })
  .eq('id', contactId)
```

(The pre-send update in Step 7 is a "best effort" early update. This final update is the authoritative one — it also sets `last_message_at`.)

- [ ] **Step 11: Update log message at end if desired**

The `DONE` log at line 369 is fine as-is.

- [ ] **Step 12: Commit**

```bash
git add supabase/functions/evolution-webhook/ai-handler.ts
git commit -m "feat: detect <transferir_humano> tag, strip from message, gate AI on handoff stage"
```

---

### Task 3: Pipeline Page — "Contato Humano" Column

**Files:**

- Modify: `src/pages/Pipeline.tsx`

- [ ] **Step 1: Add `UserCheck` import from lucide-react (line 18)**

Change:

```typescript
import { Clock, MessageSquare, AlertCircle, CheckCircle2, XCircle } from 'lucide-react'
```

To:

```typescript
import { Clock, MessageSquare, AlertCircle, CheckCircle2, XCircle, UserCheck } from 'lucide-react'
```

- [ ] **Step 2: Add `'Contato Humano'` to `STAGES` array (line 23–28)**

Change:

```typescript
const STAGES = [
  { id: 'Em Conversa', icon: MessageSquare, color: 'text-foreground', bg: 'bg-muted/80' },
  { id: 'Em Espera', icon: Clock, color: 'text-muted-foreground', bg: 'bg-muted/40' },
  { id: 'Resolvido', icon: CheckCircle2, color: 'text-muted-foreground', bg: 'bg-muted/40' },
  { id: 'Perdido', icon: XCircle, color: 'text-muted-foreground', bg: 'bg-muted/40' },
]
```

To:

```typescript
const STAGES = [
  { id: 'Em Conversa', icon: MessageSquare, color: 'text-foreground', bg: 'bg-muted/80' },
  {
    id: 'Contato Humano',
    icon: UserCheck,
    color: 'text-amber-600',
    bg: 'bg-amber-50 dark:bg-amber-950/30',
  },
  { id: 'Em Espera', icon: Clock, color: 'text-muted-foreground', bg: 'bg-muted/40' },
  { id: 'Resolvido', icon: CheckCircle2, color: 'text-muted-foreground', bg: 'bg-muted/40' },
  { id: 'Perdido', icon: XCircle, color: 'text-muted-foreground', bg: 'bg-muted/40' },
]
```

- [ ] **Step 3: Add `'Contato Humano'` key to `groupedContacts` initial value (line 68–74)**

Change:

```typescript
const grp: Record<string, typeof contacts> = {
  'Em Conversa': [],
  'Em Espera': [],
  Resolvido: [],
  Perdido: [],
}
```

To:

```typescript
const grp: Record<string, typeof contacts> = {
  'Em Conversa': [],
  'Contato Humano': [],
  'Em Espera': [],
  Resolvido: [],
  Perdido: [],
}
```

- [ ] **Step 4: Commit**

```bash
git add src/pages/Pipeline.tsx
git commit -m "feat: add 'Contato Humano' Kanban column with amber styling"
```

---

### Task 4: Agent Settings — Toggle UI + Hook

**Files:**

- Modify: `src/hooks/use-agents.ts`
- Modify: `src/pages/Agents.tsx`

- [ ] **Step 1: Add `human_handoff_enabled` to `createAgent` in `use-agents.ts` (line 38–50)**

Change the insert object to include:

```typescript
      .insert({
        user_id: user.id,
        name: agent.name!,
        description: agent.description,
        system_prompt: agent.system_prompt!,
        api_key_id: agent.api_key_id,
        audio_api_key_id: agent.audio_api_key_id || null,
        model_id: agent.model_id || null,
        memory_limit: agent.memory_limit ?? 20,
        message_delay: agent.message_delay ?? 0,
        human_handoff_enabled: agent.human_handoff_enabled ?? false,
        is_active: agent.is_active,
        is_default: agent.is_default,
      })
```

- [ ] **Step 2: Add `human_handoff_enabled` to `updateAgent` in `use-agents.ts` (line 72–85)**

Change the update object to include:

```typescript
      .update({
        name: agent.name,
        description: agent.description,
        system_prompt: agent.system_prompt,
        api_key_id: agent.api_key_id,
        audio_api_key_id: agent.audio_api_key_id ?? null,
        model_id: agent.model_id,
        memory_limit: agent.memory_limit,
        message_delay: agent.message_delay,
        human_handoff_enabled: agent.human_handoff_enabled,
        is_active: agent.is_active,
        is_default: agent.is_default,
        updated_at: new Date().toISOString(),
      })
```

- [ ] **Step 3: Add `human_handoff_enabled` to formData initial state in `Agents.tsx` (line 97–108)**

Change:

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
  is_active: true,
  is_default: false,
})
```

To:

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
  is_active: true,
  is_default: false,
})
```

- [ ] **Step 4: Load `human_handoff_enabled` when editing an existing agent**

In `Agents.tsx`, find the block that populates `formData` from `editingAgent` (around line 155–161). Add:

```typescript
        human_handoff_enabled: agent.human_handoff_enabled ?? false,
```

alongside the other fields being set from `agent`.

- [ ] **Step 5: Add UI toggle to agent form in `Agents.tsx`**

Find the section in the Dialog form that has the `memory_limit` slider (around line 791). After the memory_limit section, add the following block inside the same form container:

```tsx
                <Separator />
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <Label className="font-semibold flex items-center gap-2">
                        Transferência para Humano
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Permite que a IA transfira o atendimento emitindo a tag{' '}
                        <code className="font-mono bg-muted px-1 rounded">&lt;transferir_humano&gt;</code>.
                      </p>
                    </div>
                    <Switch
                      checked={formData.human_handoff_enabled}
                      onCheckedChange={(checked) =>
                        setFormData({ ...formData, human_handoff_enabled: checked })
                      }
                    />
                  </div>
                  {formData.human_handoff_enabled && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      Atenção: modelos gratuitos com baixa capacidade podem não respeitar a instrução da tag.
                    </p>
                  )}
                </div>
```

- [ ] **Step 6: Pass `human_handoff_enabled` in the form submit calls**

Find where `createAgent` and `updateAgent` are called with `formData` spread. Since formData now contains `human_handoff_enabled`, it is included automatically if the call uses `...formData`. Verify both calls pass the full formData (they should, since the pattern is `createAgent({ ...formData, ... })`).

- [ ] **Step 7: Commit**

```bash
git add src/hooks/use-agents.ts src/pages/Agents.tsx
git commit -m "feat: add human handoff toggle to agent settings UI"
```

---

### Task 5: Deploy + Smoke Test

- [ ] **Step 1: Deploy edge function**

```bash
supabase functions deploy evolution-webhook --no-verify-jwt
```

Expected: "Deployed Function evolution-webhook" with no errors.

- [ ] **Step 2: Run AI smoke test**

```bash
curl "https://fckenwdyghisdebqauxy.supabase.co/functions/v1/evolution-debug?endpoint=test-ai" \
  -H "Authorization: Bearer <service_role_key>"
```

Expected: `"ok": true`, all checks `true`. If any check false, check function logs at https://supabase.com/dashboard/project/fckenwdyghisdebqauxy/functions

- [ ] **Step 3: Manual smoke test**

1. Open Agentes, edit any agent, enable "Transferência para Humano" toggle → Save
2. In the test WhatsApp chat, send a message like "quero falar com um humano"
3. Verify: (a) AI reply arrives without visible `<transferir_humano>` tag, (b) contact `pipeline_stage` = `'Contato Humano'` in DB (check Pipeline page — contact appears in amber "Contato Humano" column), (c) send another message → check Supabase function logs → should see `EXIT handoff_active`
4. Manually drag contact to "Em Espera" in Pipeline → send a message → AI responds again (gate is stage-based only)

- [ ] **Step 4: Push**

```bash
git push
```

---

## Self-Review

**Spec coverage:**

- ✅ Tag in middle of text → regex strips, trims surrounding whitespace
- ✅ Tag without closing (`<transferir_humano>` open-only) → regex handles via `|>` branch
- ✅ Self-closing (`<transferir_humano/>`) → regex handles via `\/>` branch
- ✅ History stores cleanText (saved to DB without tag → future history reads don't contain tag)
- ✅ 2 consecutive messages while already in handoff → gate exits before LLM call
- ✅ Auto re-activation when operator moves contact out of 'Contato Humano' → gate only checks current stage value
- ✅ Kanban column 'Contato Humano' with amber color
- ✅ `human_handoff_enabled` toggle with low-capacity model warning text
- ✅ Notification to operator: out of scope (Kanban visual indicator is the signal)

**Placeholder scan:** No TBDs. All code blocks complete.

**Type consistency:** `human_handoff_enabled: boolean` defined in Task 1, used in Tasks 2/4. `cleanText` defined in Task 2 Step 6, used in Steps 8–9. `handoffDetected` defined in Step 6, used in Steps 7, 10. Consistent.
