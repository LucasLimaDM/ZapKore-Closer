# Fix templateMessage Text Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract readable text from WhatsApp `templateMessage` payloads so business/API messages (iFood, banks, logistics) show their content instead of `[Media/Unsupported]`.

**Architecture:** Two text-extraction sites need patching — the sync function (`evolution-sync-messages`) and the real-time webhook (`evolution-webhook`). Both share the same pattern: a chain of `||` fallbacks that stops before `templateMessage`. We add `templateMessage` extraction to both chains. No shared utility is warranted — these are two isolated 1-line changes.

**Tech Stack:** Deno / TypeScript, Supabase Edge Functions

---

## Files to Modify

| File | Change |
|---|---|
| `supabase/functions/evolution-sync-messages/index.ts` | Add templateMessage fallback in text extractor (line ~305-308) |
| `supabase/functions/evolution-webhook/index.ts` | Add templateMessage fallback in text extractor (line ~124-131) |

No new files. No migrations. No DB schema changes.

---

### Task 1: Fix text extraction in evolution-sync-messages

**Files:**
- Modify: `supabase/functions/evolution-sync-messages/index.ts:305-308`

**Context — current code (lines 305-308):**
```ts
const text =
  m.message?.conversation ||
  m.message?.extendedTextMessage?.text ||
  '[Media/Unsupported]'
```

`templateMessage` payloads look like:
```json
{
  "templateMessage": {
    "hydratedTemplate": {
      "hydratedTitleText": "Chegou!",
      "hydratedContentText": "Quem trouxe seu pedido chegou ao seu endereço."
    }
  }
}
```

The body is in `hydratedContentText`; the title is in `hydratedTitleText`. We want the body; fall back to title only if body is absent.

- [ ] **Step 1: Open the file and locate the text extractor**

File: `supabase/functions/evolution-sync-messages/index.ts`, ~line 305.

Confirm you see:
```ts
const text =
  m.message?.conversation ||
  m.message?.extendedTextMessage?.text ||
  '[Media/Unsupported]'
```

- [ ] **Step 2: Replace the text extractor with the expanded version**

Replace those 3 lines with:
```ts
const text =
  m.message?.conversation ||
  m.message?.extendedTextMessage?.text ||
  m.message?.templateMessage?.hydratedTemplate?.hydratedContentText ||
  m.message?.templateMessage?.hydratedTemplate?.hydratedTitleText ||
  '[Media/Unsupported]'
```

- [ ] **Step 3: Verify the file compiles (no syntax errors)**

```bash
cd supabase/functions/evolution-sync-messages
deno check index.ts
```

Expected: no errors printed.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/evolution-sync-messages/index.ts
git commit -m "fix(sync-messages): extract text from templateMessage payloads"
```

---

### Task 2: Fix text extraction in evolution-webhook

**Files:**
- Modify: `supabase/functions/evolution-webhook/index.ts:124-131`

**Context — current code (lines 124-131):**
```ts
text =
  content.conversation ||
  content.extendedTextMessage?.text ||
  content.imageMessage?.caption ||
  content.videoMessage?.caption ||
  content.documentMessage?.caption ||
  msgObj.text ||
  '[Media/Unsupported]'
```

- [ ] **Step 1: Open the file and locate the text extractor**

File: `supabase/functions/evolution-webhook/index.ts`, ~line 124.

Confirm you see the block above inside the `else if (content && typeof content === 'object')` branch.

- [ ] **Step 2: Replace the text extractor with the expanded version**

Replace those 8 lines with:
```ts
text =
  content.conversation ||
  content.extendedTextMessage?.text ||
  content.imageMessage?.caption ||
  content.videoMessage?.caption ||
  content.documentMessage?.caption ||
  content.templateMessage?.hydratedTemplate?.hydratedContentText ||
  content.templateMessage?.hydratedTemplate?.hydratedTitleText ||
  msgObj.text ||
  '[Media/Unsupported]'
```

- [ ] **Step 3: Verify the file compiles**

```bash
cd supabase/functions/evolution-webhook
deno check index.ts
```

Expected: no errors printed.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/evolution-webhook/index.ts
git commit -m "fix(webhook): extract text from templateMessage payloads"
```

---

### Task 3: Deploy both edge functions

- [ ] **Step 1: Deploy evolution-sync-messages**

```bash
supabase functions deploy evolution-sync-messages
```

Expected output: `Deployed Function evolution-sync-messages` (no errors).

- [ ] **Step 2: Deploy evolution-webhook**

```bash
supabase functions deploy evolution-webhook
```

Expected output: `Deployed Function evolution-webhook` (no errors).

---

### Task 4: Verify the fix

These are manual verification steps — no automated test suite exists.

- [ ] **Step 1: Re-sync a contact that had [Media/Unsupported] messages**

In the app, navigate to a contact known to receive templateMessage notifications (e.g. a business/iFood contact). Trigger a message sync (or wait for the next webhook event). Confirm the message body now shows the actual text instead of `[Media/Unsupported]`.

- [ ] **Step 2: Verify existing media messages still show [Media/Unsupported]**

Check a message that is actually an image or video (no caption). It should still show `[Media/Unsupported]` — confirm the fallback still works.

- [ ] **Step 3: Check Supabase logs for any errors**

```bash
supabase functions logs evolution-sync-messages --tail 50
supabase functions logs evolution-webhook --tail 50
```

Expected: no new ERROR lines related to text extraction.
