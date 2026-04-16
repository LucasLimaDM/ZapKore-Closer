# Import LID Contacts Without Phone — Implementation Plan

> **For agentic workers:** This plan is meant to be executed by a fresh Sonnet session with no prior context. Each task is self-contained — file paths, exact code, and validation commands are spelled out. Steps use checkbox (`- [ ]`) syntax.
>
> **No test framework exists** in this repo (`package.json` has `"test": "echo \"there are no tests for this project\" && exit 0"`). Replace "run test" with the SQL/curl validation commands shown in each task.

**Goal:** Stop silently dropping WhatsApp `@lid` (corporate) contacts during sync. Import them with `phone_number = null`, render them gracefully in the UI, and merge them into phone-based contacts automatically when WhatsApp later reveals the phone number via `remoteJidAlt`.

**Architecture:**

1. **Edge functions** stop using `continue` to discard unresolved LIDs. They insert the contact with `remote_jid = <lid>@lid`, `phone_number = null`, `push_name` from Evolution.
2. **Shared helper** `_shared/contact-linking.ts` centralizes the LID↔phone merge logic. Called by webhook (when an inbound message arrives with `remoteJidAlt`), AI handler (when Evolution resolves the LID on send), and any future code that discovers a LID's phone.
3. **Frontend** falls back to a friendly `"Número desconhecido"` label when `phone_number` is null, preventing the raw LID number from leaking into the UI.
4. **Database migration** adds a partial unique index `contact_identity(instance_id, lid_jid) WHERE lid_jid IS NOT NULL` to prevent duplicate identity rows for the same LID.

**Tech Stack:**

- Supabase (Postgres + Edge Functions on Deno) — project ID `fckenwdyghisdebqauxy`
- Evolution API (WhatsApp gateway, self-hosted), credentials stored in `user_integrations`
- Vite + React 19 + TypeScript on the frontend
- Package manager: **pnpm** (see `pnpm-lock.yaml`)
- Linter: `pnpm lint` (oxlint)
- Deploy edge function: `supabase functions deploy <name> --no-verify-jwt --project-ref fckenwdyghisdebqauxy`
  - **`--no-verify-jwt` is mandatory** — see `CLAUDE.md` and the project memory; the gateway rejects the project's ES256 tokens otherwise.

**Background context the executor needs:**

- **What is `@lid`?** WhatsApp's new identity scheme for accounts (typically business / corporate ones) where the phone number is hidden from the sender. The LID is a stable opaque ID like `238246130929810@lid`. The phone JID is the conventional `<phone>@s.whatsapp.net` format.
- **The phone is sometimes recoverable.** When a `@lid` contact sends you a message, the WhatsApp server attaches `remoteJidAlt` (the resolved phone JID) inside `message.key`. When YOU send a message to a LID, no `remoteJidAlt` is attached. So phone resolution depends on inbound traffic existing.
- **Existing helpers in the repo** (do not reinvent):
  - `supabase/functions/_shared/utils.ts`
    - `extractCanonicalPhone(data)` — returns digits-only phone or null
    - `normalizeJid(jid)` — normalizes phone JIDs
    - `resolveLidToPhone(...)` — calls Evolution `/chat/findContacts`. Confirmed in debug to return null for most LIDs. Keep it as a fallback but **do not depend on it**.
  - `merge_whatsapp_contacts(p_user_id, p_primary_contact_id, p_secondary_contact_ids[])` — Postgres RPC that moves all messages from `secondary` contacts to `primary`, then deletes the secondaries. Already deployed.
- **Current bug** is in two places:
  - `supabase/functions/evolution-sync-contacts/index.ts:136-139` — `if (jid.includes('@lid') && !canonicalPhone) { processed++; continue }`
  - `supabase/functions/evolution-sync-messages/index.ts:130` — `if (jid.includes('@lid') && !canonicalPhone) continue`
  - These two `continue`s discard ~50% of all corporate contacts silently.
- **DB schema** (relevant tables):
  - `whatsapp_contacts` — `UNIQUE(user_id, remote_jid)`, `phone_number nullable`. Index on `(user_id, phone_number)`.
  - `contact_identity` — `instance_id`, `canonical_phone`, `lid_jid`, `phone_jid`, `display_name`. Existing `UNIQUE INDEX idx_contact_identity_instance_phone(instance_id, canonical_phone)` — note this allows multiple NULLs (Postgres NULL semantics).

---

## File Map

| Path                                                              | Action | Responsibility                                                                              |
| ----------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| `supabase/migrations/20260416120000_add_lid_jid_unique_index.sql` | Create | Partial unique index on `contact_identity(instance_id, lid_jid)`                            |
| `supabase/functions/_shared/contact-linking.ts`                   | Create | `linkLidToPhone()` — single source of truth for LID↔phone merge                             |
| `supabase/functions/evolution-sync-contacts/index.ts`             | Modify | Remove silent `continue` at line 136-139; insert `@lid` contacts with `phone_number = null` |
| `supabase/functions/evolution-sync-messages/index.ts`             | Modify | Remove silent `continue` at line 130; allow message processing for `@lid` contacts          |
| `supabase/functions/evolution-webhook/index.ts`                   | Modify | When inbound message has `remoteJidAlt`, call `linkLidToPhone()`                            |
| `supabase/functions/evolution-webhook/ai-handler.ts`              | Modify | Replace inline LID-link logic (lines ~185-222) with call to `linkLidToPhone()`              |
| `src/lib/format.ts`                                               | Create | `getContactDisplayName(contact)`, `getContactDisplaySubtitle(contact)`                      |
| `src/components/dashboard/ContactFeed.tsx`                        | Modify | Use display helpers (line 64, 69, 72)                                                       |
| `src/pages/Contacts.tsx`                                          | Modify | Use display helpers (line 126, 144, 147-149)                                                |
| `src/pages/Chat.tsx`                                              | Modify | Use display helpers (line 196, 201, 204-206, 269)                                           |
| `src/pages/Pipeline.tsx`                                          | Modify | Use display helpers (line 151, 155, 158)                                                    |
| `src/pages/Dashboard.tsx`                                         | Modify | Use display helpers (line 356, 361)                                                         |

---

## Task 1: Add partial unique index for `lid_jid`

**Why:** Without a unique constraint on `(instance_id, lid_jid)`, repeated syncs may create duplicate `contact_identity` rows for the same LID. We use a _partial_ index (with `WHERE lid_jid IS NOT NULL`) so the existing rows where `lid_jid` is null are not affected.

**Files:**

- Create: `supabase/migrations/20260416120000_add_lid_jid_unique_index.sql`

- [ ] **Step 1: Write the migration**

Create file `supabase/migrations/20260416120000_add_lid_jid_unique_index.sql` with:

```sql
-- Ensures one contact_identity row per (instance, LID).
-- Partial: rows where lid_jid IS NULL are unaffected (most identities only have phone_jid).
CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_identity_instance_lid
ON public.contact_identity (instance_id, lid_jid)
WHERE lid_jid IS NOT NULL;
```

- [ ] **Step 2: Apply the migration**

Run from the repo root:

```bash
supabase db push --project-ref fckenwdyghisdebqauxy
```

Expected output: includes a line for `20260416120000_add_lid_jid_unique_index.sql` being applied.

- [ ] **Step 3: Validate the index exists**

Use the Supabase MCP tool `mcp__claude_ai_Supabase__execute_sql` (or psql / SQL editor) on project `fckenwdyghisdebqauxy`:

```sql
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'contact_identity'
  AND indexname = 'idx_contact_identity_instance_lid';
```

Expected: one row returned with `indexdef` containing `WHERE (lid_jid IS NOT NULL)`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260416120000_add_lid_jid_unique_index.sql
git commit -m "feat(db): add partial unique index on contact_identity(instance_id, lid_jid)"
```

---

## Task 2: Create the shared `linkLidToPhone` helper

**Why:** The webhook, AI handler, and (in the future) any backfill job all need the same logic to merge a LID-only contact with a phone-based contact when WhatsApp finally reveals the phone. Today the logic is inlined and partial in `ai-handler.ts:185-222`. We centralize it.

**Behavior contract:**

`linkLidToPhone(supabase, { userId, instanceId, lidJid, phoneJid, canonicalPhone, displayName? })`:

1. Upsert `contact_identity` keyed by `(instance_id, canonical_phone)` — sets/updates `lid_jid`, `phone_jid`, `display_name`.
2. Find the `whatsapp_contacts` row for this user matching the LID (`remote_jid = lidJid`).
3. Find the `whatsapp_contacts` row for this user matching the phone (`remote_jid = phoneJid` OR `phone_number = canonicalPhone`).
4. **Both exist:** call RPC `merge_whatsapp_contacts(user_id, primary=phone_contact_id, secondary=[lid_contact_id])`. Phone wins because it's the more "real" identity once known.
5. **Only LID exists:** UPDATE the LID row to set `remote_jid = phoneJid`, `phone_number = canonicalPhone`. Wrap in try/catch — if a phone contact appears between our SELECT and UPDATE (unique constraint violation on `remote_jid`), retry the merge path.
6. **Only phone exists:** no-op for `whatsapp_contacts` (identity already updated in step 1).
7. **Neither exists:** no-op (caller is expected to have created at least one).

**Files:**

- Create: `supabase/functions/_shared/contact-linking.ts`

- [ ] **Step 1: Write the helper file**

Create `supabase/functions/_shared/contact-linking.ts`:

```ts
// Centralizes the merge of a LID contact into its phone-based counterpart
// once WhatsApp reveals the phone (via remoteJidAlt or other resolution).
// Idempotent: safe to call repeatedly with the same args.

import { normalizeJid } from './utils.ts'

export interface LinkLidArgs {
  userId: string
  instanceId: string
  lidJid: string
  phoneJid: string
  canonicalPhone: string
  displayName?: string | null
}

export async function linkLidToPhone(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  args: LinkLidArgs,
): Promise<void> {
  const { userId, instanceId, lidJid, canonicalPhone, displayName } = args
  const phoneJid = normalizeJid(args.phoneJid)

  if (!lidJid.includes('@lid') || !phoneJid.includes('@s.whatsapp.net')) {
    console.warn(`[linkLidToPhone] Skipped: invalid args lidJid=${lidJid} phoneJid=${phoneJid}`)
    return
  }

  // 1. Upsert contact_identity keyed by (instance_id, canonical_phone)
  const { data: existingIdentity } = await supabase
    .from('contact_identity')
    .select('id, lid_jid, phone_jid, display_name')
    .eq('instance_id', instanceId)
    .eq('canonical_phone', canonicalPhone)
    .maybeSingle()

  if (existingIdentity) {
    const updates: Record<string, string> = {}
    if (existingIdentity.lid_jid !== lidJid) updates.lid_jid = lidJid
    if (existingIdentity.phone_jid !== phoneJid) updates.phone_jid = phoneJid
    if (displayName && !existingIdentity.display_name) updates.display_name = displayName
    if (Object.keys(updates).length > 0) {
      await supabase.from('contact_identity').update(updates).eq('id', existingIdentity.id)
    }
  } else {
    await supabase.from('contact_identity').insert({
      instance_id: instanceId,
      user_id: userId,
      canonical_phone: canonicalPhone,
      lid_jid: lidJid,
      phone_jid: phoneJid,
      display_name: displayName ?? null,
    })
  }

  // 2 & 3. Find LID and phone contacts
  const { data: lidContact } = await supabase
    .from('whatsapp_contacts')
    .select('id, push_name, profile_picture_url, last_message_at, pipeline_stage')
    .eq('user_id', userId)
    .eq('remote_jid', lidJid)
    .maybeSingle()

  const { data: phoneContact } = await supabase
    .from('whatsapp_contacts')
    .select('id, push_name, profile_picture_url, last_message_at')
    .eq('user_id', userId)
    .or(`remote_jid.eq.${phoneJid},phone_number.eq.${canonicalPhone}`)
    .maybeSingle()

  // 4. Both exist -> merge LID into phone
  if (lidContact && phoneContact && lidContact.id !== phoneContact.id) {
    console.log(
      `[linkLidToPhone] Merging LID ${lidJid} (id=${lidContact.id}) into phone ${phoneJid} (id=${phoneContact.id})`,
    )
    await supabase.rpc('merge_whatsapp_contacts', {
      p_user_id: userId,
      p_primary_contact_id: phoneContact.id,
      p_secondary_contact_ids: [lidContact.id],
    })

    // Carry over display fields and push_name if phone contact had nothing
    const carryOver: Record<string, string | null> = {}
    if (!phoneContact.push_name && lidContact.push_name) {
      carryOver.push_name = lidContact.push_name
    }
    if (!phoneContact.profile_picture_url && lidContact.profile_picture_url) {
      carryOver.profile_picture_url = lidContact.profile_picture_url
    }
    if (Object.keys(carryOver).length > 0) {
      await supabase.from('whatsapp_contacts').update(carryOver).eq('id', phoneContact.id)
    }
    return
  }

  // 5. Only LID exists -> promote it to phone
  if (lidContact && !phoneContact) {
    console.log(`[linkLidToPhone] Promoting LID contact ${lidContact.id} to phone ${phoneJid}`)
    const { error } = await supabase
      .from('whatsapp_contacts')
      .update({ remote_jid: phoneJid, phone_number: canonicalPhone })
      .eq('id', lidContact.id)

    // If a phone contact was created concurrently, we now have a unique-constraint conflict.
    // Re-query and merge.
    if (error && (error.code === '23505' || error.message?.includes('duplicate'))) {
      console.log(`[linkLidToPhone] Concurrent phone contact appeared; retrying as merge`)
      const { data: phoneContact2 } = await supabase
        .from('whatsapp_contacts')
        .select('id')
        .eq('user_id', userId)
        .eq('remote_jid', phoneJid)
        .maybeSingle()
      if (phoneContact2 && phoneContact2.id !== lidContact.id) {
        await supabase.rpc('merge_whatsapp_contacts', {
          p_user_id: userId,
          p_primary_contact_id: phoneContact2.id,
          p_secondary_contact_ids: [lidContact.id],
        })
      }
    } else if (error) {
      console.error(`[linkLidToPhone] Unexpected update error:`, error)
    }
    return
  }

  // 6 & 7. Only phone exists, or neither — nothing more to do.
  console.log(
    `[linkLidToPhone] No contact merge needed (lidContact=${!!lidContact} phoneContact=${!!phoneContact})`,
  )
}
```

- [ ] **Step 2: Lint check on the helper file**

Run from `ZapKore-Closer/`:

```bash
pnpm lint
```

Expected: no new errors involving `_shared/contact-linking.ts`. (Pre-existing warnings elsewhere are OK.)

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/contact-linking.ts
git commit -m "feat(edge): add shared linkLidToPhone helper for LID-to-phone merging"
```

---

## Task 3: Stop discarding `@lid` contacts in `evolution-sync-contacts`

**Why:** Currently this function silently skips LIDs whose phone could not be resolved. After this change, those LIDs are imported with `phone_number = null` so they appear in the CRM and can later be merged when their phone is discovered.

**Files:**

- Modify: `supabase/functions/evolution-sync-contacts/index.ts`

- [ ] **Step 1: Replace the LID skip block**

Open `supabase/functions/evolution-sync-contacts/index.ts`. Locate this block (around lines 134-139):

```ts
// Se ainda não resolvemos o phone de um LID, não criar contato lixo
// (evita duplicatas quando o mesmo contato aparece também com JID de telefone)
if (jid && jid.includes('@lid') && !canonicalPhone) {
  processed++
  continue
}
```

**Delete it entirely.** Do not leave the `continue`.

- [ ] **Step 2: Adjust `effectiveJid` / `effectivePhone` to handle phone-less LIDs**

In the same file, locate (around lines 202-204):

```ts
let effectivePhone = canonicalPhone || c.phoneNumber || null
let effectiveJid = normalizeJid(phoneJid || jid)
```

Replace with:

```ts
// For unresolved LIDs we keep the LID as remote_jid; phone stays null.
let effectivePhone = canonicalPhone || c.phoneNumber || null
let effectiveJid = phoneJid ? normalizeJid(phoneJid) : jid || ''
```

This ensures that when `phoneJid` is null (because we couldn't resolve the LID), we keep the original `@lid` JID as `remote_jid` instead of trying to normalize an undefined value.

- [ ] **Step 3: Skip the `contact_identity` insert when there is no `canonical_phone`**

The existing block (around lines 159-189) already wraps the `contact_identity` upsert in `if (canonicalPhone) { ... }`. **No change needed** — phone-less LIDs simply do not create an identity row. They will get one later when `linkLidToPhone()` is called from the webhook.

- [ ] **Step 4: Verify no other code path drops LIDs**

Search the file for other `@lid` early-returns:

```bash
grep -n "@lid" supabase/functions/evolution-sync-contacts/index.ts
```

Expected: only the `extractCanonicalPhone` lines and the `remoteJidAlt` extraction. No more `continue` statements gated on `@lid`.

- [ ] **Step 5: Deploy**

```bash
supabase functions deploy evolution-sync-contacts \
  --no-verify-jwt --project-ref fckenwdyghisdebqauxy
```

Expected: `Deployed Function evolution-sync-contacts on project fckenwdyghisdebqauxy`.

- [ ] **Step 6: Validate end-to-end with a manual sync**

Open the app in the browser, log in, and trigger a contact sync from the UI (Settings or Onboarding screen — whatever button calls `evolution-sync-contacts`). Then in the Supabase SQL editor (or via `mcp__claude_ai_Supabase__execute_sql`):

```sql
SELECT
  COUNT(*) FILTER (WHERE remote_jid LIKE '%@lid') AS lid_contacts,
  COUNT(*) FILTER (WHERE remote_jid LIKE '%@s.whatsapp.net') AS phone_contacts,
  COUNT(*) FILTER (WHERE phone_number IS NULL) AS no_phone_contacts
FROM whatsapp_contacts;
```

Expected after the fix: `lid_contacts > 0` (was 0 before). The previous baseline was `phone_contacts = 35`; you should now see roughly 80-90 total contacts (35 phone + ~50 LIDs from the corporate accounts that were previously dropped).

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/evolution-sync-contacts/index.ts
git commit -m "fix(sync-contacts): import @lid contacts with phone_number=null instead of dropping them"
```

---

## Task 4: Stop discarding `@lid` contacts in `evolution-sync-messages`

**Why:** Same root cause as Task 3, in the message-sync function. After Task 3, `@lid` contacts now exist in the DB; this task ensures their messages are also pulled.

**Files:**

- Modify: `supabase/functions/evolution-sync-messages/index.ts`

- [ ] **Step 1: Remove the LID skip in the contact-creation loop**

Locate this line (around line 130):

```ts
// LID sem phone resolvido — não criar contato lixo
if (jid.includes('@lid') && !canonicalPhone) continue
```

**Delete both lines.**

- [ ] **Step 2: Build the new-contact insert payload that handles missing phone**

In the same function, locate the block that builds `newContacts` (around lines 142-166). Replace it with:

```ts
const newContacts = missingJids.map((jid) => {
  const chat = cList.find((c) => (c.remoteJid || c.jid || c.id) === jid)
  const canonicalPhone = identityMap.get(jid) || extractCanonicalPhone({ remoteJid: jid, ...chat })
  const rawPushName =
    chat?.pushName ||
    chat?.name ||
    chat?.verifiedName ||
    chat?.contactName ||
    chat?.profileName ||
    chat?.displayName
  // Evolution returns the LID/phone digits as pushName when no real name exists — discard.
  const pushName = rawPushName && !/^\d+$/.test(String(rawPushName).trim()) ? rawPushName : null

  const phone = canonicalPhone || null
  // For unresolved LIDs, keep the LID as remote_jid; phone stays null.
  const effJid = canonicalPhone
    ? `${canonicalPhone}@s.whatsapp.net`
    : jid?.includes('@lid')
      ? jid
      : normalizeJid(jid)

  return {
    user_id: user.id,
    remote_jid: effJid,
    phone_number: phone,
    push_name: pushName || null,
  }
})
```

(The change vs. the existing code: the `let phone = ...` and `let effJid = ...` declarations are inlined and the `effJid` branches explicitly to handle LIDs without a resolved phone.)

- [ ] **Step 3: Allow message processing for phone-less LID contacts**

In the message-processing loop (around lines 220-231) the existing logic is:

```ts
let contactId = contactMap.get(jid)
if (!contactId && canonicalPhone) {
  contactId = phoneMap.get(canonicalPhone)
}
if (!contactId && jid.includes('@s.whatsapp.net')) {
  contactId = phoneMap.get(jid.split('@')[0])
}

if (!contactId) {
  totalProcessed++
  continue
}
```

This is correct — but `contactMap` is keyed by `remote_jid`, so a phone-less LID contact (whose `remote_jid` is the `@lid` string) will be found via `contactMap.get(jid)` because `jid` is the LID. **No change needed** — the upsert in Step 2 ensures `contactMap` is repopulated with the LID after insert.

Verify the upsert at line ~169 propagates LID rows back into `contactMap`:

```ts
if (inserted) {
  inserted.forEach((c) => {
    if (c.remote_jid) contactMap.set(c.remote_jid, c.id)
    if (c.phone_number) phoneMap.set(c.phone_number, c.id)
  })
}
```

This is already correct — `c.remote_jid` will be the `@lid` string for unresolved LIDs.

- [ ] **Step 4: Deploy**

```bash
supabase functions deploy evolution-sync-messages \
  --no-verify-jwt --project-ref fckenwdyghisdebqauxy
```

- [ ] **Step 5: Validate**

After Task 3 created the LID contacts, run a fresh sync (the app's UI will call `evolution-sync-contacts` which auto-invokes `evolution-sync-messages`). Then:

```sql
SELECT
  c.remote_jid,
  c.push_name,
  COUNT(m.id) AS msg_count
FROM whatsapp_contacts c
LEFT JOIN whatsapp_messages m ON m.contact_id = c.id
WHERE c.remote_jid LIKE '%@lid'
GROUP BY c.id, c.remote_jid, c.push_name
ORDER BY msg_count DESC
LIMIT 10;
```

Expected: at least some LID contacts have `msg_count > 0` (the ones where `findMessages` returns history). It is OK if some LIDs have `msg_count = 0` — Evolution's `findMessages` doesn't always return messages for `fromMe: true` chats indexed by LID. Those contacts still appear in the CRM.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/evolution-sync-messages/index.ts
git commit -m "fix(sync-messages): process @lid contacts with phone_number=null instead of skipping them"
```

---

## Task 5: Trigger `linkLidToPhone` in the webhook when `remoteJidAlt` arrives

**Why:** Inbound messages from `@lid` contacts include `key.remoteJidAlt` (the resolved phone JID). When the webhook sees this, we now have everything needed to merge the LID-only contact into a phone-based contact. This is the primary mechanism by which dangling LIDs eventually become "real" phone contacts.

**Files:**

- Modify: `supabase/functions/evolution-webhook/index.ts`

- [ ] **Step 1: Import the helper**

At the top of `supabase/functions/evolution-webhook/index.ts`, add:

```ts
import { linkLidToPhone } from '../_shared/contact-linking.ts'
```

(Place it next to the existing `import { extractCanonicalPhone, normalizeJid, resolveLidToPhone } from '../_shared/utils.ts'` import.)

- [ ] **Step 2: Capture `remoteJidAlt` from the incoming message key**

In the `messages.upsert` handler, locate the section (around lines 78-82) where `remoteJid`, `messageId`, and `fromMe` are extracted:

```ts
const key = msgObj.key || {}
const remoteJid = key.remoteJid || msgObj.remoteJid || msgObj.jid
const messageId = key.id || msgObj.id
const fromMe = key.fromMe !== undefined ? key.fromMe : msgObj.fromMe || false
```

Add immediately after:

```ts
const remoteJidAlt: string | undefined = key.remoteJidAlt
```

- [ ] **Step 3: Schedule the link in background after the message is saved**

After the message has been successfully upserted (look for the existing log line `[WEBHOOK] Successfully saved message ${messageId}` around line 292), add a new block immediately before the `if (fromMe) { ... } else if (...) { ... } else { processAiResponse } ...` block:

```ts
// If the inbound message reveals the phone number for an @lid contact,
// link them via the shared helper so future messages and the UI converge.
if (!fromMe && remoteJid?.includes('@lid') && remoteJidAlt?.includes('@s.whatsapp.net')) {
  const altPhone = remoteJidAlt.split('@')[0].replace(/\D/g, '')
  if (/^\d{8,15}$/.test(altPhone)) {
    const linkPromise = linkLidToPhone(supabase, {
      userId,
      instanceId: integ.id,
      lidJid: remoteJid,
      phoneJid: remoteJidAlt,
      canonicalPhone: altPhone,
      displayName: pushName !== 'Unknown' ? pushName : null,
    }).catch((err) => console.error(`[WEBHOOK] linkLidToPhone failed for ${remoteJid}:`, err))

    if (
      typeof (globalThis as any).EdgeRuntime !== 'undefined' &&
      typeof (globalThis as any).EdgeRuntime.waitUntil === 'function'
    ) {
      ;(globalThis as any).EdgeRuntime.waitUntil(linkPromise)
    }
    // else: linkPromise runs detached; Deno will await before isolate teardown
  }
}
```

This runs the merge in the background — the webhook still returns 200 quickly. `EdgeRuntime.waitUntil` keeps the isolate alive until it finishes.

- [ ] **Step 4: Deploy**

```bash
supabase functions deploy evolution-webhook \
  --no-verify-jwt --project-ref fckenwdyghisdebqauxy
```

- [ ] **Step 5: Validate**

The most reliable validation is to send a real message from a `@lid` contact and confirm the merge. Steps:

1. Pick one LID contact that exists in the DB after Task 3:
   ```sql
   SELECT id, remote_jid, push_name FROM whatsapp_contacts
   WHERE remote_jid LIKE '%@lid' LIMIT 5;
   ```
2. Ask one of those people to send you a WhatsApp message (or use the Evolution sandbox if available).
3. After ~30 seconds, re-query:

   ```sql
   SELECT id, remote_jid, phone_number FROM whatsapp_contacts
   WHERE id = '<the-id-from-step-1>';
   ```

   Expected: `remote_jid` is now `<phone>@s.whatsapp.net` and `phone_number` is set. (The original LID row was either UPDATEd in place or merged into a pre-existing phone contact.)

4. Also check the edge function logs for `[linkLidToPhone] Merging LID ...` or `Promoting LID contact ...`:
   ```
   Use mcp__claude_ai_Supabase__get_logs with service="edge-function"
   ```

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/evolution-webhook/index.ts
git commit -m "feat(webhook): merge @lid contact into phone contact when remoteJidAlt arrives"
```

---

## Task 6: Refactor `ai-handler.ts` to use `linkLidToPhone`

**Why:** When the AI sends a reply to a `@lid` contact, Evolution's response includes the resolved phone JID (`actualRemoteJid`). The current code (lines ~185-222) handles this inline with a copy of the merge logic. Using the shared helper guarantees consistent behavior.

**Files:**

- Modify: `supabase/functions/evolution-webhook/ai-handler.ts`

- [ ] **Step 1: Import the helper**

At the top of `supabase/functions/evolution-webhook/ai-handler.ts`, add:

```ts
import { linkLidToPhone } from '../_shared/contact-linking.ts'
```

- [ ] **Step 2: Replace the inline LID-resolution block**

Locate the block (currently around lines 184-222):

```ts
// Se enviamos para um @lid e a Evolution resolveu para um phone JID,
// atualiza o contato e contact_identity para evitar duplicatas futuras
if (
  actualRemoteJid &&
  actualRemoteJid.includes('@s.whatsapp.net') &&
  contact.remote_jid.includes('@lid')
) {
  const canonicalPhone = actualRemoteJid.split('@')[0]
  if (/^\d{8,15}$/.test(canonicalPhone)) {
    console.log(`[AI Handler] Linking LID ${contact.remote_jid} → phone JID ${actualRemoteJid}`)
    await supabase
      .from('whatsapp_contacts')
      .update({ remote_jid: actualRemoteJid, phone_number: canonicalPhone })
      .eq('id', contactId)

    const { data: existingIdentity } = await supabase
      .from('contact_identity')
      .select('id')
      .eq('instance_id', integration.id)
      .eq('canonical_phone', canonicalPhone)
      .maybeSingle()

    if (existingIdentity) {
      await supabase
        .from('contact_identity')
        .update({ phone_jid: actualRemoteJid, lid_jid: contact.remote_jid })
        .eq('id', existingIdentity.id)
    } else {
      await supabase.from('contact_identity').insert({
        instance_id: integration.id,
        user_id: userId,
        canonical_phone: canonicalPhone,
        phone_jid: actualRemoteJid,
        lid_jid: contact.remote_jid,
      })
    }
  }
}
```

Replace with:

```ts
// If Evolution resolved the LID to a phone JID, merge LID and phone contacts.
if (
  actualRemoteJid &&
  actualRemoteJid.includes('@s.whatsapp.net') &&
  contact.remote_jid.includes('@lid')
) {
  const canonicalPhone = actualRemoteJid.split('@')[0]
  if (/^\d{8,15}$/.test(canonicalPhone)) {
    console.log(`[AI Handler] Linking LID ${contact.remote_jid} → phone ${actualRemoteJid}`)
    try {
      await linkLidToPhone(supabase, {
        userId,
        instanceId: integration.id,
        lidJid: contact.remote_jid,
        phoneJid: actualRemoteJid,
        canonicalPhone,
      })
    } catch (linkErr) {
      console.error(`[AI Handler] linkLidToPhone failed:`, linkErr)
    }
  }
}
```

- [ ] **Step 3: Update the `contactId` reference for the subsequent message upsert**

The existing code at the end of `processAiResponse` does:

```ts
    await supabase.from('whatsapp_messages').upsert(
      {
        user_id: userId,
        contact_id: contactId,
        ...
      }
```

After `linkLidToPhone` runs, `contactId` may now point to a deleted row (if a merge happened). Handle this by re-resolving `contactId` from the resolved phone:

Immediately AFTER the `if (actualRemoteJid && ...)` block above, add:

```ts
// After a possible merge, ensure contactId points at the surviving row.
if (
  actualRemoteJid &&
  actualRemoteJid.includes('@s.whatsapp.net') &&
  contact.remote_jid.includes('@lid')
) {
  const { data: surviving } = await supabase
    .from('whatsapp_contacts')
    .select('id')
    .eq('user_id', userId)
    .eq('remote_jid', actualRemoteJid)
    .maybeSingle()
  if (surviving) contactId = surviving.id
}
```

(Note: this requires `contactId` to be `let`-declared, not `const`. If it is currently `const`, change the declaration at the top of the function.)

- [ ] **Step 4: Deploy**

```bash
supabase functions deploy evolution-webhook \
  --no-verify-jwt --project-ref fckenwdyghisdebqauxy
```

(`ai-handler.ts` is bundled with `evolution-webhook` since it is a sibling file, not its own function. Confirm by checking `supabase/functions/evolution-webhook/deno.json` — there should be no separate `ai-handler` function deploy.)

- [ ] **Step 5: Validate**

The AI handler triggers when an inbound message arrives for a contact that has `ai_agent_id` set. To validate end-to-end:

1. Assign an active AI agent to a `@lid` contact:
   ```sql
   UPDATE whatsapp_contacts
   SET ai_agent_id = (SELECT id FROM ai_agents WHERE is_active = true AND user_id = whatsapp_contacts.user_id LIMIT 1)
   WHERE remote_jid LIKE '%@lid'
     AND id = '<some-test-lid-contact-id>';
   ```
2. Have that LID contact send you a message.
3. After the AI replies, check edge function logs for `[AI Handler] Linking LID ... → phone ...` and verify the contact in the DB has `phone_number` set.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/evolution-webhook/ai-handler.ts
git commit -m "refactor(ai-handler): use shared linkLidToPhone helper for LID merging"
```

---

## Task 7: Frontend display helpers

**Why:** Today the UI does `contact.remote_jid.split('@')[0]` to render a "phone" subtitle. For `@lid` contacts that subtitle becomes the opaque LID number — confusing for users. We centralize the display fallback in two helpers and use them everywhere.

**Files:**

- Create: `src/lib/format.ts`

- [ ] **Step 1: Create the helpers**

Create `src/lib/format.ts`:

```ts
import { WhatsAppContact } from './types'

/**
 * Returns a user-friendly display name for a WhatsApp contact.
 * Falls back to a localized "Unknown" string when no push_name is available.
 */
export function getContactDisplayName(
  contact: Pick<WhatsAppContact, 'push_name'>,
  fallback: string = 'Contato sem nome',
): string {
  return contact.push_name?.trim() || fallback
}

/**
 * Returns the secondary line shown under the contact name (typically the phone).
 * - If we have a real phone_number, returns "+<phone>".
 * - If the contact is an unresolved @lid (no phone), returns a friendly placeholder.
 * - Otherwise (legacy phone JID without phone_number column populated), falls back
 *   to the digits portion of the remote_jid.
 */
export function getContactDisplaySubtitle(
  contact: Pick<WhatsAppContact, 'phone_number' | 'remote_jid'>,
  unknownLabel: string = 'Número desconhecido',
): string {
  if (contact.phone_number) return `+${contact.phone_number}`
  if (contact.remote_jid?.endsWith('@lid')) return unknownLabel
  return contact.remote_jid?.split('@')[0] ?? unknownLabel
}
```

- [ ] **Step 2: Lint**

```bash
pnpm lint
```

Expected: no new errors involving `src/lib/format.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/format.ts
git commit -m "feat(ui): add contact display helpers for unresolved @lid contacts"
```

---

## Task 8: Apply the helpers in all contact-rendering components

**Why:** Five components currently render `contact.remote_jid.split('@')[0]` or `contact.push_name || 'Unknown'`. Replace each with the helper.

**Files:**

- Modify: `src/components/dashboard/ContactFeed.tsx`
- Modify: `src/pages/Contacts.tsx`
- Modify: `src/pages/Chat.tsx`
- Modify: `src/pages/Pipeline.tsx`
- Modify: `src/pages/Dashboard.tsx`

- [ ] **Step 1: ContactFeed**

In `src/components/dashboard/ContactFeed.tsx`, add at the top:

```tsx
import { getContactDisplayName, getContactDisplaySubtitle } from '@/lib/format'
```

Find (around line 64):

```tsx
{
  contact.push_name ? contact.push_name.charAt(0).toUpperCase() : '#'
}
```

Replace with:

```tsx
{
  getContactDisplayName(contact, '').charAt(0).toUpperCase() || '#'
}
```

Find (around line 69):

```tsx
{
  contact.push_name || 'Unknown Contact'
}
```

Replace with:

```tsx
{
  getContactDisplayName(contact, 'Unknown Contact')
}
```

Find (around line 72):

```tsx
{
  contact.remote_jid.split('@')[0]
}
```

Replace with:

```tsx
{
  getContactDisplaySubtitle(contact, 'Unknown number')
}
```

- [ ] **Step 2: Contacts page**

In `src/pages/Contacts.tsx`, add to imports:

```tsx
import { getContactDisplayName, getContactDisplaySubtitle } from '@/lib/format'
```

Find (around line 126):

```tsx
{
  contact.push_name?.charAt(0) || '#'
}
```

Replace with:

```tsx
{
  getContactDisplayName(contact, '').charAt(0) || '#'
}
```

Find (around line 144):

```tsx
{
  contact.push_name || t('unknown')
}
```

Replace with:

```tsx
{
  getContactDisplayName(contact, t('unknown'))
}
```

Find (around lines 147-149):

```tsx
{
  contact.phone_number ? `+${contact.phone_number}` : contact.remote_jid.split('@')[0]
}
```

Replace with:

```tsx
{
  getContactDisplaySubtitle(contact, t('unknownNumber'))
}
```

- [ ] **Step 3: Chat page**

In `src/pages/Chat.tsx`, add to imports:

```tsx
import { getContactDisplayName, getContactDisplaySubtitle } from '@/lib/format'
```

Find (around line 196 — the header avatar fallback):

```tsx
{
  contact.push_name?.charAt(0) || '#'
}
```

Replace with:

```tsx
{
  getContactDisplayName(contact, '').charAt(0) || '#'
}
```

Find (around line 201):

```tsx
{
  contact.push_name || t('unknown')
}
```

Replace with:

```tsx
{
  getContactDisplayName(contact, t('unknown'))
}
```

Find (around lines 204-206):

```tsx
{
  contact.phone_number ? `+${contact.phone_number}` : contact.remote_jid.split('@')[0]
}
```

Replace with:

```tsx
{
  getContactDisplaySubtitle(contact, t('unknownNumber'))
}
```

Find (around line 269 — the inner avatar fallback inside message bubbles, if applicable):

```tsx
{
  contact.push_name?.charAt(0) || '#'
}
```

Replace with:

```tsx
{
  getContactDisplayName(contact, '').charAt(0) || '#'
}
```

- [ ] **Step 4: Pipeline page**

In `src/pages/Pipeline.tsx`, add to imports:

```tsx
import { getContactDisplayName, getContactDisplaySubtitle } from '@/lib/format'
```

Find (around line 151):

```tsx
<AvatarFallback>{c.push_name?.charAt(0) || '#'}</AvatarFallback>
```

Replace with:

```tsx
<AvatarFallback>{getContactDisplayName(c, '').charAt(0) || '#'}</AvatarFallback>
```

Find (around line 155):

```tsx
{
  c.push_name || 'Desconhecido'
}
```

Replace with:

```tsx
{
  getContactDisplayName(c, 'Desconhecido')
}
```

Find (around line 158):

```tsx
{
  c.phone_number ? `+${c.phone_number}` : c.remote_jid.split('@')[0]
}
```

Replace with:

```tsx
{
  getContactDisplaySubtitle(c, 'Número desconhecido')
}
```

- [ ] **Step 5: Dashboard page**

In `src/pages/Dashboard.tsx`, add to imports:

```tsx
import { getContactDisplayName } from '@/lib/format'
```

Find (around line 356):

```tsx
{
  contact.push_name?.charAt(0) || '#'
}
```

Replace with:

```tsx
{
  getContactDisplayName(contact, '').charAt(0) || '#'
}
```

Find (around line 361):

```tsx
{
  contact.push_name || t('unknown')
}
```

Replace with:

```tsx
{
  getContactDisplayName(contact, t('unknown'))
}
```

(Dashboard does not currently render a subtitle for these contacts. Skip the subtitle helper here.)

- [ ] **Step 6: Add `unknownNumber` translation key (if i18n is used)**

Check `src/lib/i18n/translations.ts`. If it exports a translation map with a key like `unknown`, also add `unknownNumber` to all locales:

```ts
// Example structure — adjust to actual file shape
{
  pt: { ..., unknownNumber: 'Número desconhecido' },
  en: { ..., unknownNumber: 'Unknown number' },
}
```

If `unknownNumber` is not added, the helper falls back to the default literal passed as the second argument — the UI still works.

- [ ] **Step 7: Build and lint**

```bash
pnpm lint
pnpm build
```

Expected: lint passes; build completes without errors.

- [ ] **Step 8: Manual UI smoke test**

```bash
pnpm dev
```

Open `http://localhost:8080`. Log in. Navigate to:

- **Dashboard** → contacts list shows real names (no "238246130929810" garbage)
- **Pipeline** → cards for `@lid` contacts show name + "Número desconhecido"
- **Contacts** → list renders LID and phone contacts side by side, both with friendly subtitles
- **Chat (open a LID contact)** → header shows name + "Número desconhecido"

If a LID contact's `push_name` is also missing, the fallback "Contato sem nome" / "Unknown Contact" / "Desconhecido" should appear (depending on the page).

- [ ] **Step 9: Commit**

```bash
git add src/components/dashboard/ContactFeed.tsx \
        src/pages/Contacts.tsx \
        src/pages/Chat.tsx \
        src/pages/Pipeline.tsx \
        src/pages/Dashboard.tsx \
        src/lib/i18n/translations.ts
git commit -m "feat(ui): use display helpers so @lid contacts render with friendly fallbacks"
```

(Omit `translations.ts` from the `git add` if you didn't change it.)

---

## Task 9: Final end-to-end validation

**Why:** Confirm the full pipeline works after all changes. This is the gate before declaring done.

- [ ] **Step 1: Trigger a fresh contact sync from the UI**

Open the app, navigate to wherever the "Sync contacts" / "Importar contatos" button lives (likely Settings or Onboarding). Click it. Wait for the import_jobs row to reach `status = 'completed'`:

```sql
SELECT id, type, status, total_items, processed_items, created_at
FROM import_jobs
ORDER BY created_at DESC
LIMIT 3;
```

- [ ] **Step 2: Verify the contact counts**

Compare against the pre-fix baseline (35 contacts, 0 LIDs):

```sql
SELECT
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE remote_jid LIKE '%@lid') AS lid,
  COUNT(*) FILTER (WHERE remote_jid LIKE '%@s.whatsapp.net') AS phone,
  COUNT(*) FILTER (WHERE phone_number IS NULL) AS no_phone
FROM whatsapp_contacts;
```

Expected (approximate, depends on the user's actual chat list):

- `total` ≈ 80–90 (was 35)
- `lid` > 0 (was 0)
- `no_phone` ≈ `lid` (most LIDs without resolved phone)

- [ ] **Step 3: Verify identity table integrity**

```sql
-- All identity rows for LIDs should have lid_jid set
SELECT COUNT(*) AS broken_identities
FROM contact_identity
WHERE lid_jid IS NULL AND phone_jid IS NULL;
-- Expected: 0
```

- [ ] **Step 4: Trigger a real LID-to-phone link**

Ask one of the imported LID contacts (a real corporate WhatsApp account) to send a message to your number. After ~30 seconds:

```sql
SELECT remote_jid, phone_number, push_name
FROM whatsapp_contacts
WHERE id = '<the-LID-contact-id-you-tested>';
```

Expected: `remote_jid` is now `<phone>@s.whatsapp.net`, `phone_number` is populated.

Also check the contact_identity row was updated:

```sql
SELECT * FROM contact_identity
WHERE lid_jid = '<original-LID-jid>';
```

Expected: row has both `lid_jid` AND `phone_jid` populated, plus `canonical_phone`.

- [ ] **Step 5: Confirm UI reflects the merge**

Without refreshing manually, the Realtime subscription in `use-contacts.ts` should re-fetch the contact list. Verify:

- The merged contact now shows `+<phone>` as subtitle (not "Número desconhecido")
- Old LID-only card is gone (was deleted by `merge_whatsapp_contacts`)
- Message history is intact (now under the merged phone contact)

- [ ] **Step 6: Edge function log audit**

Pull recent logs:

```
mcp__claude_ai_Supabase__get_logs with service="edge-function"
```

Look for:

- `[linkLidToPhone] Merging LID ...` or `Promoting LID contact ...` entries — proves the helper ran
- No 5xx errors from `evolution-webhook`, `evolution-sync-contacts`, or `evolution-sync-messages`

- [ ] **Step 7: Final commit (only if any tweaks were needed during validation)**

If validation surfaced any small fix, commit it as a separate `fix:` commit. Otherwise skip.

---

## Architectural Notes (FYI for the executor)

1. **Why the `merge_whatsapp_contacts` RPC instead of a manual UPDATE+DELETE?** The unique constraint `whatsapp_contacts(user_id, remote_jid)` makes UPDATE risky (race with INSERT). The RPC encapsulates the safe sequence: re-assign all `whatsapp_messages.contact_id` first, then delete the secondary contacts.

2. **Why partial unique index on `lid_jid`?** Many existing identity rows have `lid_jid IS NULL` (created from phone-only flows). A non-partial unique index would treat all NULLs as distinct (which is actually fine in Postgres) but the partial index is cleaner intent and avoids any edge-case planner surprises.

3. **What about `resolveLidToPhone` in `_shared/utils.ts`?** Leave it. It works for the rare LID where Evolution's `/chat/findContacts` actually returns a `linkedJid`. The sync functions still call it as a best-effort. After this plan, an unresolved LID is no longer a dead end — it just becomes a phone-less contact pending future inbound traffic.

4. **What about the `pipeline_stage` for new LID contacts?** The DB default `'Em Espera'` already applies on insert when not specified. The webhook still sets `'Em Conversa'` on first inbound message. No change needed.

5. **Backwards compatibility:** Any existing identity rows (only 1 has `lid_jid` set today) are unaffected. The new index is `IF NOT EXISTS` so re-applying is safe.

6. **What if the user runs sync many times?** Idempotent: `whatsapp_contacts` is upserted on `(user_id, remote_jid)` and `contact_identity` is keyed on `(instance_id, canonical_phone)` with the new partial index on `(instance_id, lid_jid)`. Re-runs do not duplicate.

---

## Done Criteria

- [ ] All 9 tasks completed and validated
- [ ] At least one real LID contact has been merged into a phone contact via the webhook (Task 9 Step 4)
- [ ] UI shows no raw LID numbers (e.g., `238246130929810`) anywhere in the contact list
- [ ] All commits pushed to the working branch
