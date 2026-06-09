# Captions Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject a sender caption (`*[Name]*\n`) into outbound WhatsApp messages when captions are enabled — identifying whether the AI agent or human operator sent each message.

**Architecture:** Two new columns on `user_integrations` (`captions_enabled`, `user_display_name`) drive behaviour. Both send paths — `evolution-send-message` (human) and `ai-handler.ts` (AI) — prepend the caption to the Evolution API payload only. The DB stores clean text so the CRM UI and AI context remain unaffected.

**Tech Stack:** TypeScript, React 19, Supabase Edge Functions (Deno), shadcn/ui, Tailwind CSS

---

### Task 1: DB migration

**Files:**

- Create: `supabase/migrations/20260501000001_add_captions_to_integrations.sql`

- [ ] **Step 1: Write migration**

```sql
ALTER TABLE public.user_integrations
  ADD COLUMN IF NOT EXISTS captions_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS user_display_name TEXT;
```

Save to `supabase/migrations/20260501000001_add_captions_to_integrations.sql`.

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260501000001_add_captions_to_integrations.sql
git commit -m "feat: add captions_enabled and user_display_name to user_integrations"
```

---

### Task 2: Update TypeScript types

**Files:**

- Modify: `src/lib/supabase/types.ts:197-234` (user_integrations Row/Insert/Update)

- [ ] **Step 1: Add fields to Row type** (inside `user_integrations.Row`)

Add after `created_at`:

```typescript
captions_enabled: boolean
user_display_name: string | null
```

- [ ] **Step 2: Add fields to Insert type** (inside `user_integrations.Insert`)

Add after `created_at`:

```typescript
captions_enabled?: boolean
user_display_name?: string | null
```

- [ ] **Step 3: Add fields to Update type** (inside `user_integrations.Update`)

Add after `created_at`:

```typescript
captions_enabled?: boolean
user_display_name?: string | null
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/supabase/types.ts
git commit -m "feat: add captions columns to user_integrations types"
```

---

### Task 3: Settings UI — Legendas card

**Files:**

- Modify: `src/pages/Settings.tsx`

The current Settings page has two cards: Evolution API and WhatsApp Connection. Add a third card "Legendas" below them.

State needed:

- `captionsEnabled: boolean` — controlled toggle
- `userDisplayName: string` — text input
- `savingCaptions: boolean` — loading state

Load from `integration` (already available via `useIntegration()`). Save via direct Supabase update.

- [ ] **Step 1: Add state declarations** after line 33 (`const [savingCreds, setSavingCreds] = useState(false)`):

```typescript
const [captionsEnabled, setCaptionsEnabled] = useState(false)
const [userDisplayName, setUserDisplayName] = useState('')
const [savingCaptions, setSavingCaptions] = useState(false)
```

- [ ] **Step 2: Seed state from integration** — add a new `useEffect` after the existing `useEffect` blocks (after line 54):

```typescript
useEffect(() => {
  if (integration) {
    setCaptionsEnabled(integration.captions_enabled ?? false)
    setUserDisplayName(integration.user_display_name ?? '')
  }
}, [integration?.id])
```

- [ ] **Step 3: Add save handler** after `handleCancelEdit` function (after line 84):

```typescript
const handleSaveCaptions = async () => {
  setSavingCaptions(true)
  try {
    const { error } = await supabase
      .from('user_integrations')
      .update({
        captions_enabled: captionsEnabled,
        user_display_name: userDisplayName.trim() || null,
      })
      .eq('user_id', integration!.user_id)
    if (error) throw error
    toast.success('Configurações de legendas salvas')
  } catch (e: any) {
    toast.error(e.message || 'Erro ao salvar legendas')
  } finally {
    setSavingCaptions(false)
  }
}
```

- [ ] **Step 4: Add Lucide icon import** — add `Tag` to the existing icon import on line 18:

```typescript
import { Loader2, MessageCircle, Plug, Unplug, CheckCircle2, KeyRound, Tag } from 'lucide-react'
```

- [ ] **Step 5: Add shadcn Switch import** — add after the existing shadcn imports:

```typescript
import { Switch } from '@/components/ui/switch'
```

- [ ] **Step 6: Add Legendas card** — insert after the closing `</Card>` of the WhatsApp Connection card (after line 393), before the closing `</div>` of the cards container:

```tsx
{
  /* Legendas Card */
}
;<Card className="shadow-subtle border border-border/40 rounded-[2rem] bg-card overflow-hidden">
  <CardHeader className="pb-4 pt-8 px-8">
    <CardTitle className="flex items-center gap-3 text-xl tracking-tight">
      <div className="bg-primary/10 text-primary p-2.5 rounded-2xl">
        <Tag className="h-5 w-5" />
      </div>
      Legendas
    </CardTitle>
    <CardDescription className="font-medium text-sm text-muted-foreground max-w-sm">
      Identifica quem enviou cada mensagem no WhatsApp
    </CardDescription>
  </CardHeader>

  <CardContent className="px-8 pb-8 space-y-6">
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-foreground">Ativar legendas</span>
        <span className="text-xs font-medium text-muted-foreground">
          Inclui o nome do remetente no início de cada mensagem enviada
        </span>
      </div>
      <Switch checked={captionsEnabled} onCheckedChange={setCaptionsEnabled} />
    </div>

    {captionsEnabled && (
      <div className="flex flex-col gap-2 animate-in fade-in slide-in-from-top-1 duration-200">
        <Label htmlFor="settings-display-name">Seu nome</Label>
        <Input
          id="settings-display-name"
          type="text"
          placeholder="Ex: Lucas"
          value={userDisplayName}
          onChange={(e) => setUserDisplayName(e.target.value)}
          disabled={savingCaptions}
          className="max-w-xs"
        />
        <p className="text-xs text-muted-foreground font-medium">
          Aparece quando você envia mensagens manualmente. O nome do agente IA é definido nas
          configurações do agente.
        </p>
      </div>
    )}

    <Button
      onClick={handleSaveCaptions}
      disabled={savingCaptions}
      className="rounded-full px-6 h-10 font-semibold"
    >
      {savingCaptions ? (
        <>
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Salvando...
        </>
      ) : (
        'Salvar'
      )}
    </Button>
  </CardContent>
</Card>
```

- [ ] **Step 7: Run lint to verify no errors**

```bash
pnpm lint
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/pages/Settings.tsx
git commit -m "feat: add Legendas settings card with captions toggle and display name"
```

---

### Task 4: Inject caption in human send path

**Files:**

- Modify: `supabase/functions/evolution-send-message/index.ts`

Caption is injected into the Evolution API payload only. DB stores the original text.

- [ ] **Step 1: Add caption injection** — after `integration` is fetched and validated (after line ~35, before the Evolution API call), find the block that builds the fetch body and replace:

Find:

```typescript
body: JSON.stringify({
  number: contact.remote_jid,
  text: text,
}),
```

Replace with:

```typescript
const textToSend =
  integration.captions_enabled && integration.user_display_name
    ? `*[${integration.user_display_name}]*\n${text}`
    : text

body: JSON.stringify({
  number: contact.remote_jid,
  text: textToSend,
}),
```

The DB upsert keeps `text: text` (original, no caption).

- [ ] **Step 2: Deploy function**

```bash
supabase functions deploy evolution-send-message --no-verify-jwt
```

Expected: `Deployed` with no errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/evolution-send-message/index.ts
git commit -m "feat: inject caption prefix in human send path when captions_enabled"
```

---

### Task 5: Inject caption in AI send path

**Files:**

- Modify: `supabase/functions/evolution-webhook/ai-handler.ts`

Caption injected into Evolution payload only. DB stores `cleanText` unchanged so AI context on next turn is not polluted.

- [ ] **Step 1: Add caption injection** — after `integration` is fetched and validated (after the `if (integError || !integration ...)` guard around line 315), before the `sendRes` fetch at line 375.

Find the block:

```typescript
console.log(
  `[AI Handler] send_start dest=${contact.remote_jid} instance=${integration.instance_name} elapsed=${elapsed()}`,
)

const sendRes = await fetch(`${evoUrl}/message/sendText/${integration.instance_name}`, {
  method: 'POST',
  headers: {
    apikey: evoKey,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    number: contact.remote_jid,
    text: cleanText,
  }),
})
```

Replace with:

```typescript
const textToSend =
  integration.captions_enabled && agent.name ? `*[${agent.name}]*\n${cleanText}` : cleanText

console.log(
  `[AI Handler] send_start dest=${contact.remote_jid} instance=${integration.instance_name} elapsed=${elapsed()}`,
)

const sendRes = await fetch(`${evoUrl}/message/sendText/${integration.instance_name}`, {
  method: 'POST',
  headers: {
    apikey: evoKey,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    number: contact.remote_jid,
    text: textToSend,
  }),
})
```

The `supabase.from('whatsapp_messages').upsert(...)` call keeps `text: cleanText` — unchanged.

- [ ] **Step 2: Deploy both affected functions**

```bash
supabase functions deploy evolution-webhook --no-verify-jwt
```

Expected: `Deployed` with no errors.

- [ ] **Step 3: Run AI smoke test**

```bash
curl "https://fckenwdyghisdebqauxy.supabase.co/functions/v1/evolution-debug?endpoint=test-ai" \
  -H "Authorization: Bearer <service_role_key>"
```

Expected: `"ok": true` and all checks `true`.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/evolution-webhook/ai-handler.ts
git commit -m "feat: inject caption prefix in AI send path when captions_enabled"
```

---

### Task 6: Apply migration to remote DB

- [ ] **Step 1: Push migration**

The migration must be applied to the remote Supabase project. Either:

- Via Supabase dashboard SQL editor: run the SQL from Task 1
- Or via CLI: `supabase db push` (if remote linking is configured)

SQL to run:

```sql
ALTER TABLE public.user_integrations
  ADD COLUMN IF NOT EXISTS captions_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS user_display_name TEXT;
```

- [ ] **Step 2: Verify columns exist**

In Supabase dashboard → Table Editor → `user_integrations`: confirm `captions_enabled` and `user_display_name` columns appear.

---

### Task 7: End-to-end verification

- [ ] **Step 1: Start dev server**

```bash
pnpm dev --port 8085
```

- [ ] **Step 2: Open Settings page** at `http://localhost:8085/app/settings`

Verify: "Legendas" card appears below WhatsApp Connection card. Toggle is OFF by default. No "Seu nome" input visible.

- [ ] **Step 3: Enable captions**

Toggle ON. Verify: "Seu nome" input appears with animation.

- [ ] **Step 4: Enter display name and save**

Type a name, click Salvar. Verify: toast "Configurações de legendas salvas" appears.

- [ ] **Step 5: Reload page**

Verify: toggle is still ON, display name persists.

- [ ] **Step 6: Send a manual message from Chat**

Open any contact chat. Send a message. Verify on the WhatsApp recipient device: message arrives as `*[Your Name]*\nMensagem`. Verify in platform chat: message shows without caption prefix (clean text).

- [ ] **Step 7: Verify AI message (if agent configured)**

Send a message that triggers the AI. Verify on recipient device: AI reply arrives as `*[Agent Name]*\nResposta`. Verify in platform chat: shows clean text.
