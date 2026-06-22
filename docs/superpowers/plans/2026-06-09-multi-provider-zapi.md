# Multi-Provider WhatsApp (Evolution + Z-API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Z-API as a second selectable WhatsApp provider alongside Evolution, using a shared adapter layer in `_shared/providers/`, toggled by `integration.provider`.

**Architecture:** `WhatsAppProvider` interface + `EvolutionProvider`/`ZapiProvider` adapters live in `_shared/providers/`. A `getProvider(integration)` factory selects by `integration.provider`. Existing functions shed their inline API calls and delegate to the adapter. Two webhook ingress functions (existing `evolution-webhook`, new `zapi-webhook`) converge on a shared `persistInboundMessage` helper then the same `processAiResponse`. Everything downstream of `whatsapp_messages` is untouched.

**Tech Stack:** Deno/TypeScript, Supabase Edge Functions (no test runner — verify via `pnpm build:dev` + lint + smoke tests after each deploy), Z-API REST, Evolution API REST.

---

## File Map

**New files:**

- `supabase/migrations/20260609000001_add_provider_columns.sql`
- `supabase/functions/_shared/providers/types.ts` — interface + normalized types
- `supabase/functions/_shared/providers/evolution.ts` — `EvolutionProvider`
- `supabase/functions/_shared/providers/zapi.ts` — `ZapiProvider`
- `supabase/functions/_shared/providers/factory.ts` — `getProvider()`
- `supabase/functions/_shared/webhook-persistence.ts` — `persistInboundMessage()`
- `supabase/functions/zapi-webhook/index.ts` — Z-API ingress
- `supabase/functions/zapi-webhook/deno.json`

**Modified files:**

- `src/lib/supabase/types.ts` — regenerated after migration
- `supabase/functions/evolution-webhook/index.ts` — import `persistInboundMessage`
- `supabase/functions/evolution-webhook/ai-handler.ts` — replace inline `fetch` with `provider.sendText`
- `supabase/functions/evolution-send-message/index.ts`
- `supabase/functions/evolution-get-qr/index.ts`
- `supabase/functions/evolution-create-instance/index.ts`
- `supabase/functions/evolution-disconnect/index.ts`
- `supabase/functions/evolution-sync-contacts/index.ts`
- `supabase/functions/evolution-sync-messages/index.ts`
- `supabase/functions/evolution-get-media/index.ts`
- `supabase/functions/evolution-transcribe-message/index.ts`
- `supabase/functions/evolution-credentials/index.ts`
- `src/pages/Settings.tsx`
- `src/pages/Onboarding.tsx`

---

## Phase 1 — Schema + Provider Infrastructure

### Task 1: Schema migration + regenerate TypeScript types

**Files:**

- Create: `supabase/migrations/20260609000001_add_provider_columns.sql`
- Modify: `src/lib/supabase/types.ts` (regenerated)

- [ ] **Step 1: Write migration**

```sql
ALTER TABLE public.user_integrations
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'evolution',
  ADD COLUMN IF NOT EXISTS zapi_instance_id TEXT,
  ADD COLUMN IF NOT EXISTS zapi_instance_token TEXT,
  ADD COLUMN IF NOT EXISTS zapi_client_token TEXT;

COMMENT ON COLUMN public.user_integrations.provider IS 'WhatsApp provider: evolution | zapi';
```

- [ ] **Step 2: Apply migration**

```bash
supabase db push
```

Expected: "Applying migration 20260609000001_add_provider_columns.sql"

- [ ] **Step 3: Regenerate TypeScript types**

```bash
supabase gen types typescript --project-id fckenwdyghisdebqauxy > src/lib/supabase/types.ts
```

Expected: file updated, `user_integrations.Row` now includes `provider: string`, `zapi_instance_id: string | null`, `zapi_instance_token: string | null`, `zapi_client_token: string | null`.

- [ ] **Step 4: Verify build**

```bash
pnpm build:dev
```

Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260609000001_add_provider_columns.sql src/lib/supabase/types.ts
git commit -m "feat: add provider + zapi credential columns to user_integrations"
```

---

### Task 2: Provider interface + normalized types + factory

**Files:**

- Create: `supabase/functions/_shared/providers/types.ts`
- Create: `supabase/functions/_shared/providers/factory.ts`

- [ ] **Step 1: Create `types.ts`**

```typescript
// supabase/functions/_shared/providers/types.ts

export interface NormalizedInbound {
  remoteJid: string // canonical <phone>@s.whatsapp.net
  pushName: string | null
  text: string | null
  timestamp: string // ISO-8601
  messageId: string
  mediaUrl: string | null // direct URL (Z-API) or null (Evolution — fetched separately)
  lid: string | null // @lid JID if known
  fromMe: boolean
  type: string // 'text' | 'audioMessage' | 'imageMessage' | etc.
  raw: unknown // original provider payload
}

export interface NormalizedContact {
  remoteJid: string // canonical @s.whatsapp.net
  pushName: string | null
  canonicalPhone: string | null
  lastMessageAt?: string
}

export interface NormalizedMessage {
  messageId: string
  remoteJid: string
  fromMe: boolean
  text: string | null
  timestamp: string
  type: string
  mediaUrl?: string | null
  raw: unknown
}

export interface WhatsAppProvider {
  /** Send text to JID (canonical @s.whatsapp.net or bare phone). */
  sendText(toJid: string, text: string): Promise<{ messageId: string; raw: unknown }>

  /** Poll for QR code. Returns { base64 } while pairing, { connected: true } when connected. */
  getQrCode(): Promise<{ base64: string } | { connected: true }>

  /** Current connection status. */
  getStatus(): Promise<'CONNECTED' | 'WAITING_QR' | 'DISCONNECTED'>

  /** Point the provider's webhook to callbackUrl. Returns true on success. */
  configureWebhook(callbackUrl: string): Promise<boolean>

  /** Disconnect/logout the WhatsApp session. */
  disconnect(): Promise<void>

  /** List all chats as normalized contacts. */
  syncChats(): Promise<NormalizedContact[]>

  /** Fetch message history for a chat (chatId = remoteJid or bare phone). */
  syncMessages(chatId: string): Promise<NormalizedMessage[]>

  /** Parse a raw webhook payload into a NormalizedInbound. Returns null if not a message. */
  parseInbound(payload: unknown): NormalizedInbound | null

  /**
   * Fetch media for a message.
   * Z-API: returns the direct URL from rawPayload.audio.audioUrl / image.imageUrl.
   * Evolution: calls getBase64FromMediaMessage, returns base64 data string.
   */
  fetchMedia(options: { messageId?: string; rawPayload?: unknown }): Promise<string | null>
}
```

- [ ] **Step 2: Create `factory.ts`**

```typescript
// supabase/functions/_shared/providers/factory.ts
import { EvolutionProvider } from './evolution.ts'
import { ZapiProvider } from './zapi.ts'
import type { WhatsAppProvider } from './types.ts'

export interface ProviderIntegration {
  provider?: string | null
  // Evolution
  evolution_api_url?: string | null
  evolution_api_key?: string | null
  instance_name?: string | null
  // Z-API
  zapi_instance_id?: string | null
  zapi_instance_token?: string | null
  zapi_client_token?: string | null
}

export function getProvider(integration: ProviderIntegration): WhatsAppProvider {
  const provider = integration.provider ?? 'evolution'

  if (provider === 'zapi') {
    if (
      !integration.zapi_instance_id ||
      !integration.zapi_instance_token ||
      !integration.zapi_client_token
    ) {
      throw new Error(
        'Z-API credentials not configured (zapi_instance_id, zapi_instance_token, zapi_client_token required)',
      )
    }
    return new ZapiProvider({
      instanceId: integration.zapi_instance_id,
      instanceToken: integration.zapi_instance_token,
      clientToken: integration.zapi_client_token,
    })
  }

  const url = (integration.evolution_api_url || Deno.env.get('EVOLUTION_API_URL') || '').replace(
    /\/$/,
    '',
  )
  const key = integration.evolution_api_key || Deno.env.get('EVOLUTION_API_KEY') || ''
  const instance = integration.instance_name || ''
  if (!url || !key || !instance) throw new Error('Evolution credentials not configured')
  return new EvolutionProvider({ url, key, instance })
}
```

- [ ] **Step 3: Verify (types.ts and factory.ts exist — EvolutionProvider and ZapiProvider don't yet, so compilation happens in Task 3/5)**

Confirm the files exist:

```bash
ls supabase/functions/_shared/providers/
```

Expected: `factory.ts  types.ts`

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/_shared/providers/
git commit -m "feat: add WhatsAppProvider interface, normalized types, and provider factory"
```

---

### Task 3: EvolutionProvider (core methods — stubs for sync/qr until later tasks)

**Files:**

- Create: `supabase/functions/_shared/providers/evolution.ts`

- [ ] **Step 1: Create `evolution.ts`**

```typescript
// supabase/functions/_shared/providers/evolution.ts
import type {
  NormalizedContact,
  NormalizedInbound,
  NormalizedMessage,
  WhatsAppProvider,
} from './types.ts'

interface EvolutionCredentials {
  url: string // already stripped of trailing slash
  key: string
  instance: string
}

export class EvolutionProvider implements WhatsAppProvider {
  private url: string
  private key: string
  private instance: string

  constructor(creds: EvolutionCredentials) {
    this.url = creds.url
    this.key = creds.key
    this.instance = creds.instance
  }

  async sendText(toJid: string, text: string): Promise<{ messageId: string; raw: unknown }> {
    const r = await fetch(`${this.url}/message/sendText/${this.instance}`, {
      method: 'POST',
      headers: { apikey: this.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: toJid, text }),
    })
    if (!r.ok) throw new Error(`Evolution sendText failed (${r.status}): ${await r.text()}`)
    const j = await r.json()
    return { messageId: j?.key?.id ?? j?.id ?? crypto.randomUUID(), raw: j }
  }

  async getStatus(): Promise<'CONNECTED' | 'WAITING_QR' | 'DISCONNECTED'> {
    const r = await fetch(`${this.url}/instance/connectionState/${this.instance}`, {
      headers: { apikey: this.key },
    })
    if (!r.ok) return 'DISCONNECTED'
    const j = await r.json()
    return j.instance?.state === 'open' || j.state === 'open' ? 'CONNECTED' : 'WAITING_QR'
  }

  async configureWebhook(callbackUrl: string): Promise<boolean> {
    const r = await fetch(`${this.url}/webhook/set/${this.instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: this.key },
      body: JSON.stringify({
        webhook: {
          enabled: true,
          url: callbackUrl,
          events: [
            'MESSAGES_UPSERT',
            'MESSAGES_UPDATE',
            'MESSAGES_DELETE',
            'CONNECTION_UPDATE',
            'CONTACTS_UPSERT',
          ],
        },
      }),
    })
    return r.ok
  }

  async disconnect(): Promise<void> {
    const r = await fetch(`${this.url}/instance/logout/${this.instance}`, {
      method: 'DELETE',
      headers: { apikey: this.key },
    })
    if (!r.ok) console.warn(`[EvolutionProvider] disconnect failed: ${await r.text()}`)
  }

  // Implemented in Task 8
  async getQrCode(): Promise<{ base64: string } | { connected: true }> {
    throw new Error('[EvolutionProvider] getQrCode not yet implemented')
  }

  // Implemented in Task 11
  async syncChats(): Promise<NormalizedContact[]> {
    throw new Error('[EvolutionProvider] syncChats not yet implemented')
  }

  // Implemented in Task 12
  async syncMessages(_chatId: string): Promise<NormalizedMessage[]> {
    throw new Error('[EvolutionProvider] syncMessages not yet implemented')
  }

  // Implemented in Task 13
  async fetchMedia(_options: { messageId?: string; rawPayload?: unknown }): Promise<string | null> {
    throw new Error('[EvolutionProvider] fetchMedia not yet implemented')
  }

  // Not used by Evolution (Evolution-webhook handles Baileys parsing directly)
  parseInbound(_payload: unknown): NormalizedInbound | null {
    return null
  }
}
```

- [ ] **Step 2: Verify build**

```bash
pnpm build:dev 2>&1 | tail -5
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/providers/evolution.ts
git commit -m "feat: add EvolutionProvider adapter (sendText, getStatus, configureWebhook, disconnect)"
```

---

## Phase 2 — Shared Webhook Persistence

### Task 4: Extract `persistInboundMessage` + refactor evolution-webhook to use it

The `messages.upsert` handler in `evolution-webhook/index.ts` (lines ~135–610) contains the contact resolution + message upsert + AI dispatch. We extract the **final upsert + AI dispatch** (the part starting after `effectiveJid` is resolved, i.e., after line ~291) into a shared helper. This lets `zapi-webhook` reuse the same persistence logic.

The shared function receives an already-resolved `effectiveJid`, contact data, and a pre-parsed message. It:

1. Upserts the contact row.
2. Upserts the message row.
3. Dispatches `processAiResponse` or `processAudioMessage` via `EdgeRuntime.waitUntil`.

**Files:**

- Create: `supabase/functions/_shared/webhook-persistence.ts`
- Modify: `supabase/functions/evolution-webhook/index.ts`

- [ ] **Step 1: Create `_shared/webhook-persistence.ts`**

```typescript
// supabase/functions/_shared/webhook-persistence.ts
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'

export interface InboundMessage {
  effectiveJid: string // canonical @s.whatsapp.net JID
  effectivePhone: string | null
  pushName: string
  messageId: string
  fromMe: boolean
  text: string | null
  type: string
  timestamp: string
  raw: unknown
  // Extra Evolution fields for audio processing
  evoUrl?: string
  evoKey?: string
  instanceName?: string
  remoteJidLidHint?: string // @lid JID if contact is lid-only
}

export interface PersistResult {
  contactId: string | null
  agentId: string | null
  contactObj: any
}

export async function persistInboundMessage(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  msg: InboundMessage,
  processAiResponseFn: (
    userId: string,
    contactId: string,
    supabaseUrl: string,
    supabaseKey: string,
    version: number,
    lidHint?: string,
  ) => Promise<void>,
  processAudioMessageFn: (
    userId: string,
    contactId: string,
    messageId: string,
    supabaseUrl: string,
    supabaseKey: string,
    version: number,
    evoUrl: string,
    evoKey: string,
    instanceName: string,
    lidHint?: string,
  ) => Promise<void>,
  supabaseUrl: string,
  supabaseKey: string,
): Promise<PersistResult> {
  const {
    effectiveJid,
    effectivePhone,
    pushName,
    messageId,
    fromMe,
    text,
    type,
    timestamp,
    raw,
    evoUrl = '',
    evoKey = '',
    instanceName = '',
    remoteJidLidHint,
  } = msg

  // 1. Find or create contact
  let contact: any = null

  const { data: existing } = await supabase
    .from('whatsapp_contacts')
    .select('id, phone_number, push_name, pipeline_stage, ai_agent_id')
    .eq('user_id', userId)
    .eq('remote_jid', effectiveJid)
    .maybeSingle()
  contact = existing

  if (!contact && effectivePhone) {
    const { data: byPhone } = await supabase
      .from('whatsapp_contacts')
      .select('id, phone_number, push_name, pipeline_stage, ai_agent_id')
      .eq('user_id', userId)
      .eq('phone_number', effectivePhone)
      .limit(1)
      .maybeSingle()
    if (byPhone) contact = byPhone
  }

  if (!contact) {
    if (fromMe) return { contactId: null, agentId: null, contactObj: null }
    const { data: newContact } = await supabase
      .from('whatsapp_contacts')
      .insert({
        user_id: userId,
        remote_jid: effectiveJid,
        phone_number: effectivePhone,
        push_name: pushName !== 'Unknown' ? pushName : null,
        last_message_at: timestamp,
        pipeline_stage: 'Em Conversa',
      })
      .select('id, phone_number, push_name, pipeline_stage, ai_agent_id')
      .single()
    contact = newContact
  } else {
    const upd: any = { last_message_at: timestamp }
    if (contact.pipeline_stage !== 'Contato Humano') upd.pipeline_stage = 'Em Conversa'
    if (
      !fromMe &&
      pushName &&
      pushName !== 'Unknown' &&
      !/^\d+$/.test(pushName) &&
      (!contact.push_name || contact.push_name === 'Unknown' || /^\d+$/.test(contact.push_name))
    ) {
      upd.push_name = pushName
    }
    if (effectivePhone && !contact.phone_number) upd.phone_number = effectivePhone
    await supabase.from('whatsapp_contacts').update(upd).eq('id', contact.id)
  }

  if (!contact) return { contactId: null, agentId: null, contactObj: null }

  // 2. Upsert message
  const { error: insertError } = await supabase.from('whatsapp_messages').upsert(
    {
      user_id: userId,
      contact_id: contact.id,
      message_id: messageId,
      from_me: fromMe,
      text,
      type,
      timestamp,
      raw,
    },
    { onConflict: 'user_id,message_id' },
  )

  if (insertError) {
    console.error(`[persistence] Error inserting message ${messageId}:`, insertError)
    return { contactId: contact.id, agentId: contact.ai_agent_id, contactObj: contact }
  }

  // 3. Rate limit counter
  if (!fromMe) {
    const msgCountPromise = supabase
      .rpc('increment_contact_msg', { p_contact_id: contact.id, p_window_secs: 3600 })
      .then(() => {})
      .catch((err: any) => console.error(`[persistence] increment_contact_msg failed:`, err))
    if (typeof (globalThis as any).EdgeRuntime?.waitUntil === 'function') {
      ;(globalThis as any).EdgeRuntime.waitUntil(msgCountPromise)
    }
  }

  // 4. AI dispatch
  if (fromMe) return { contactId: contact.id, agentId: contact.ai_agent_id, contactObj: contact }

  if (type === 'audioMessage' || type === 'pttMessage') {
    const { data: newVersion } = await supabase.rpc('increment_ai_trigger_version', {
      p_contact_id: contact.id,
    })
    if (newVersion != null) {
      const audioTask = processAudioMessageFn(
        userId,
        contact.id,
        messageId,
        supabaseUrl,
        supabaseKey,
        newVersion as number,
        evoUrl,
        evoKey,
        instanceName,
        remoteJidLidHint,
      )
      if (typeof (globalThis as any).EdgeRuntime?.waitUntil === 'function') {
        ;(globalThis as any).EdgeRuntime.waitUntil(audioTask)
      } else {
        audioTask.catch((e: any) => console.error('[persistence] audio task failed:', e))
      }
    }
  } else if (['text', 'conversation', 'extendedTextMessage'].includes(type)) {
    const { data: newVersion } = await supabase.rpc('increment_ai_trigger_version', {
      p_contact_id: contact.id,
    })
    if (newVersion != null) {
      const aiTask = processAiResponseFn(
        userId,
        contact.id,
        supabaseUrl,
        supabaseKey,
        newVersion as number,
        remoteJidLidHint,
      )
      if (typeof (globalThis as any).EdgeRuntime?.waitUntil === 'function') {
        ;(globalThis as any).EdgeRuntime.waitUntil(aiTask)
      } else {
        aiTask.catch((e: any) => console.error('[persistence] AI task failed:', e))
      }
    }
  }

  return { contactId: contact.id, agentId: contact.ai_agent_id, contactObj: contact }
}
```

- [ ] **Step 2: Refactor `evolution-webhook/index.ts` to use `persistInboundMessage`**

In `supabase/functions/evolution-webhook/index.ts`, add the import at the top (after existing imports):

```typescript
import { persistInboundMessage } from '../_shared/webhook-persistence.ts'
```

Then find the block starting at line ~455 (`if (contact && messageId) {`) down to line ~610 (just before the final `return new Response`). Replace that block with:

```typescript
if (contact && messageId) {
  // Revoke/edit handlers above this point are unchanged.
  // Delegate upsert + AI dispatch to shared helper.
  await persistInboundMessage(
    supabase,
    userId,
    {
      effectiveJid,
      effectivePhone,
      pushName,
      messageId,
      fromMe,
      text,
      type,
      timestamp,
      raw: msgObj,
      evoUrl,
      evoKey: evoKey || '',
      instanceName,
      remoteJidLidHint: effectiveJid.includes('@lid') ? effectiveJid : undefined,
    },
    processAiResponse,
    processAudioMessage,
    supabaseUrl,
    supabaseKey,
  )
}
```

> **Note:** the contact upsert logic that was in the original block (lines ~293–366) was about _creating/updating the contact row_. That code remains ABOVE this replacement — the shared helper also does a contact upsert, but it re-queries the same row. For this step, the simplest correct path is: **delete the original `if (contact && messageId)` block completely and replace with the call above**. The shared helper re-does the contact upsert idempotently.

Actually, to avoid double-upserting the contact, instead **replace only the message upsert + AI dispatch section** (lines 455–610, starting with `if (contact && messageId) {`). The contact resolution (lines 293–453) stays exactly as-is. Pass the already-resolved `contact` object into a lighter call:

```typescript
if (contact && messageId) {
  // Upsert message
  const { error: insertError } = await supabase.from('whatsapp_messages').upsert(
    {
      user_id: userId,
      contact_id: contact.id,
      message_id: messageId,
      from_me: fromMe,
      text,
      type,
      timestamp,
      raw: msgObj,
    },
    { onConflict: 'user_id,message_id' },
  )

  if (insertError) {
    console.error(`[WEBHOOK] Error inserting message ${messageId}:`, insertError)
  } else {
    console.log(`[WEBHOOK] Saved message ${messageId} for contact ${contact.id}`)

    // Rate limit counter
    if (!fromMe) {
      const msgCountPromise = supabase
        .rpc('increment_contact_msg', { p_contact_id: contact.id, p_window_secs: 3600 })
        .then(() => {})
        .catch((err: any) => console.error('[WEBHOOK] increment_contact_msg failed:', err))
      if (typeof (globalThis as any).EdgeRuntime?.waitUntil === 'function') {
        ;(globalThis as any).EdgeRuntime.waitUntil(msgCountPromise)
      }
    }

    // lid → phone link background task
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
        }).catch((err) => console.error(`[WEBHOOK] linkLidToPhone failed:`, err))
        if (typeof (globalThis as any).EdgeRuntime?.waitUntil === 'function') {
          ;(globalThis as any).EdgeRuntime.waitUntil(linkPromise)
        }
      }
    }

    // AI / audio dispatch
    if (!fromMe) {
      if (type === 'audioMessage' || type === 'pttMessage') {
        const { data: newVersion } = await supabase.rpc('increment_ai_trigger_version', {
          p_contact_id: contact.id,
        })
        if (newVersion != null) {
          const lidHint = effectiveJid.includes('@lid') ? effectiveJid : undefined
          const audioTask = processAudioMessage(
            userId,
            contact.id,
            messageId,
            supabaseUrl,
            supabaseKey,
            newVersion as number,
            evoUrl,
            evoKey || '',
            instanceName,
            lidHint,
          )
          if (typeof (globalThis as any).EdgeRuntime?.waitUntil === 'function') {
            ;(globalThis as any).EdgeRuntime.waitUntil(audioTask)
          } else {
            audioTask.catch((e: any) => console.error('[WEBHOOK] audio task failed:', e))
          }
        }
      } else if (['text', 'conversation', 'extendedTextMessage'].includes(type)) {
        const { data: newVersion } = await supabase.rpc('increment_ai_trigger_version', {
          p_contact_id: contact.id,
        })
        if (newVersion != null) {
          const lidHint = effectiveJid.includes('@lid') ? effectiveJid : undefined
          if (typeof (globalThis as any).EdgeRuntime?.waitUntil === 'function') {
            ;(globalThis as any).EdgeRuntime.waitUntil(
              processAiResponse(
                userId,
                contact.id,
                supabaseUrl,
                supabaseKey,
                newVersion as number,
                lidHint,
              ),
            )
          } else {
            processAiResponse(
              userId,
              contact.id,
              supabaseUrl,
              supabaseKey,
              newVersion as number,
            ).catch((e: any) => console.error('[WEBHOOK] AI task failed:', e))
          }
        }
      }
    }
  }
}
```

This replaces lines 455–610 of evolution-webhook/index.ts (the original `if (contact && messageId)` block). The contact upsert block above it (lines 293–453) is **unchanged**.

- [ ] **Step 3: Deploy evolution-webhook and verify Evolution still works**

```bash
supabase functions deploy evolution-webhook --no-verify-jwt
```

- [ ] **Step 4: Smoke test — Evolution AI still responding**

```bash
curl "https://fckenwdyghisdebqauxy.supabase.co/functions/v1/evolution-debug?endpoint=test-ai" \
  -H "Authorization: Bearer $(supabase secrets list --project-ref fckenwdyghisdebqauxy | grep SERVICE_ROLE | awk '{print $2}')"
```

Expected: `"ok": true` and all checks `true`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/webhook-persistence.ts supabase/functions/evolution-webhook/index.ts
git commit -m "refactor: extract shared webhook persistence helper, Evolution-webhook delegates to it"
```

---

## Phase 3 — Z-API Adapter + Webhook

### Task 5: ZapiProvider

**Files:**

- Create: `supabase/functions/_shared/providers/zapi.ts`

- [ ] **Step 1: Create `zapi.ts`**

```typescript
// supabase/functions/_shared/providers/zapi.ts
import type {
  NormalizedContact,
  NormalizedInbound,
  NormalizedMessage,
  WhatsAppProvider,
} from './types.ts'

interface ZapiCredentials {
  instanceId: string
  instanceToken: string
  clientToken: string
}

export class ZapiProvider implements WhatsAppProvider {
  private base: string
  private clientToken: string

  constructor(creds: ZapiCredentials) {
    this.base = `https://api.z-api.io/instances/${creds.instanceId}/token/${creds.instanceToken}`
    this.clientToken = creds.clientToken
  }

  private get headers(): Record<string, string> {
    return { 'Client-Token': this.clientToken, 'Content-Type': 'application/json' }
  }

  /** Strip @s.whatsapp.net (and any other @suffix) to get bare phone digits. */
  private toPhone(jid: string): string {
    return jid.replace(/@[\w.]+$/, '')
  }

  async sendText(toJid: string, text: string): Promise<{ messageId: string; raw: unknown }> {
    const r = await fetch(`${this.base}/send-text`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ phone: this.toPhone(toJid), message: text }),
    })
    if (!r.ok) throw new Error(`Z-API sendText failed (${r.status}): ${await r.text()}`)
    const j = await r.json()
    return { messageId: j.messageId ?? j.zaapId ?? j.id ?? crypto.randomUUID(), raw: j }
  }

  async getStatus(): Promise<'CONNECTED' | 'WAITING_QR' | 'DISCONNECTED'> {
    const r = await fetch(`${this.base}/status`, {
      headers: { 'Client-Token': this.clientToken },
    })
    if (!r.ok) return 'DISCONNECTED'
    const j = await r.json()
    return j.connected === true ? 'CONNECTED' : 'WAITING_QR'
  }

  async getQrCode(): Promise<{ base64: string } | { connected: true }> {
    const status = await this.getStatus()
    if (status === 'CONNECTED') return { connected: true }

    const r = await fetch(`${this.base}/qr-code/image`, {
      headers: { 'Client-Token': this.clientToken },
    })
    if (!r.ok) throw new Error(`Z-API getQrCode failed (${r.status}): ${await r.text()}`)
    const j = await r.json()
    // Z-API returns base64 image in `value` or `qrCode` field
    const base64 = j.value ?? j.qrCode ?? j.base64
    if (!base64) throw new Error('Z-API getQrCode: no base64 in response')
    return { base64 }
  }

  async configureWebhook(callbackUrl: string): Promise<boolean> {
    const r = await fetch(`${this.base}/update-every-webhooks`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ value: callbackUrl }),
    })
    return r.ok
  }

  async disconnect(): Promise<void> {
    const r = await fetch(`${this.base}/disconnect`, {
      headers: { 'Client-Token': this.clientToken },
    })
    if (!r.ok) console.warn(`[ZapiProvider] disconnect failed: ${await r.text()}`)
  }

  async syncChats(): Promise<NormalizedContact[]> {
    const r = await fetch(`${this.base}/chats`, {
      headers: { 'Client-Token': this.clientToken },
    })
    if (!r.ok) throw new Error(`Z-API syncChats failed (${r.status}): ${await r.text()}`)
    const chats: any[] = await r.json()
    return chats
      .filter((c) => c.phone && !String(c.phone).includes('@g.us'))
      .map((c) => {
        const phone = String(c.phone).replace(/@[\w.]+$/, '')
        return {
          remoteJid: `${phone}@s.whatsapp.net`,
          pushName: c.name ?? c.chatName ?? null,
          canonicalPhone: phone,
          lastMessageAt: c.lastMessageTime
            ? new Date(
                c.lastMessageTime < 10000000000 ? c.lastMessageTime * 1000 : c.lastMessageTime,
              ).toISOString()
            : undefined,
        }
      })
  }

  async syncMessages(chatId: string): Promise<NormalizedMessage[]> {
    const phone = this.toPhone(chatId)
    const r = await fetch(`${this.base}/chat-messages/${phone}`, {
      headers: { 'Client-Token': this.clientToken },
    })
    if (!r.ok) {
      console.warn(`[ZapiProvider] syncMessages failed for ${phone}: ${await r.text()}`)
      return []
    }
    const messages: any[] = await r.json()
    return messages.map((m) => {
      const p = m.phone ?? phone
      const cleanPhone = String(p).replace(/@[\w.]+$/, '')
      const ts = m.momment ?? m.timestamp ?? m.messageTimestamp
      return {
        messageId: m.messageId ?? m.id,
        remoteJid: `${cleanPhone}@s.whatsapp.net`,
        fromMe: m.fromMe ?? false,
        text: m.text?.message ?? m.body ?? null,
        timestamp: ts
          ? new Date(ts < 10000000000 ? ts * 1000 : ts).toISOString()
          : new Date().toISOString(),
        type: m.audio ? 'audioMessage' : m.image ? 'imageMessage' : 'text',
        mediaUrl: m.audio?.audioUrl ?? m.image?.imageUrl ?? null,
        raw: m,
      }
    })
  }

  parseInbound(payload: unknown): NormalizedInbound | null {
    const p = payload as Record<string, any>

    // Z-API connection events
    if (p.type === 'ConnectedCallback') return null // handled separately in zapi-webhook
    if (p.type === 'DisconnectedCallback') return null

    if (p.type !== 'ReceivedCallback') return null
    if (p.fromMe) return null
    if (p.isGroup) return null

    const rawPhone = String(p.phone ?? '')
    // If phone is already a @lid (Z-API privacy mode), keep as-is; webhook will handle fallback
    const phone = rawPhone.includes('@') ? rawPhone.replace(/@[\w.]+$/, '') : rawPhone
    const remoteJid = `${phone}@s.whatsapp.net`

    const text = p.text?.message ?? null
    const type = p.audio
      ? 'audioMessage'
      : p.image
        ? 'imageMessage'
        : p.document
          ? 'documentMessage'
          : p.video
            ? 'videoMessage'
            : p.sticker
              ? 'stickerMessage'
              : text
                ? 'conversation'
                : 'unknown'
    const mediaUrl =
      p.audio?.audioUrl ?? p.image?.imageUrl ?? p.document?.documentUrl ?? p.video?.videoUrl ?? null

    const ts = p.momment ?? p.timestamp
    const timestamp = ts
      ? new Date(ts < 10000000000 ? ts * 1000 : ts).toISOString()
      : new Date().toISOString()

    return {
      remoteJid,
      pushName: p.senderName ?? p.chatName ?? null,
      text,
      timestamp,
      messageId: p.messageId ?? p.id,
      mediaUrl,
      lid: p.senderLid ?? null,
      fromMe: false,
      type,
      raw: payload,
    }
  }

  async fetchMedia(options: { messageId?: string; rawPayload?: unknown }): Promise<string | null> {
    const p = options.rawPayload as Record<string, any> | undefined
    if (!p) return null
    return (
      p.audio?.audioUrl ?? p.image?.imageUrl ?? p.document?.documentUrl ?? p.video?.videoUrl ?? null
    )
  }
}
```

- [ ] **Step 2: Verify build**

```bash
pnpm build:dev 2>&1 | tail -5
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/providers/zapi.ts
git commit -m "feat: add ZapiProvider adapter (full interface implementation)"
```

---

### Task 6: `zapi-webhook` function

**Files:**

- Create: `supabase/functions/zapi-webhook/index.ts`
- Create: `supabase/functions/zapi-webhook/deno.json`

- [ ] **Step 1: Create `deno.json`**

```json
{
  "imports": {
    "jsr:@supabase/functions-js/": "jsr:@supabase/functions-js@^2.4.1",
    "jsr:@supabase/supabase-js@2": "jsr:@supabase/supabase-js@^2.45.4"
  }
}
```

- [ ] **Step 2: Create `index.ts`**

```typescript
// supabase/functions/zapi-webhook/index.ts
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { ZapiProvider } from '../_shared/providers/zapi.ts'
import { processAiResponse } from '../evolution-webhook/ai-handler.ts'
import { processAudioMessage } from '../evolution-webhook/audio-handler.ts'

Deno.serve(async (req: Request) => {
  try {
    const url = new URL(req.url)
    // URL pattern: /zapi-webhook/{userId}
    const pathParts = url.pathname.split('/')
    const userId = pathParts[pathParts.length - 1]

    if (!userId || userId === 'zapi-webhook') {
      return new Response('Missing userId in path', { status: 400 })
    }

    const payload = await req.json()
    console.log('[ZAPI-WEBHOOK] INGRESS:', JSON.stringify(payload).slice(0, 300))

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    const supabase = createClient(supabaseUrl, supabaseKey)

    // Fetch integration by user_id
    const { data: integ } = await supabase
      .from('user_integrations')
      .select('*')
      .eq('user_id', userId)
      .eq('provider', 'zapi')
      .single()

    if (!integ) {
      console.log(`[ZAPI-WEBHOOK] No Z-API integration for user ${userId}`)
      return new Response('Integration not found', { status: 200 })
    }

    // Connection status events
    if (payload.type === 'ConnectedCallback') {
      await supabase.from('user_integrations').update({ status: 'CONNECTED' }).eq('user_id', userId)
      console.log(`[ZAPI-WEBHOOK] User ${userId} connected`)
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }

    if (payload.type === 'DisconnectedCallback') {
      await supabase
        .from('user_integrations')
        .update({ status: 'DISCONNECTED' })
        .eq('user_id', userId)
      console.log(`[ZAPI-WEBHOOK] User ${userId} disconnected`)
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }

    // Parse inbound message
    const provider = new ZapiProvider({
      instanceId: integ.zapi_instance_id!,
      instanceToken: integ.zapi_instance_token!,
      clientToken: integ.zapi_client_token!,
    })

    const normalized = provider.parseInbound(payload)
    if (!normalized) {
      console.log(`[ZAPI-WEBHOOK] Ignored non-inbound payload type=${payload.type}`)
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }

    console.log(`[ZAPI-WEBHOOK] Inbound from ${normalized.remoteJid} type=${normalized.type}`)

    const { remoteJid, pushName, messageId, fromMe, text, type, timestamp, raw, mediaUrl } =
      normalized
    const effectivePhone = remoteJid.replace(/@[\w.]+$/, '')

    // Upsert contact
    let contact: any = null
    const { data: existing } = await supabase
      .from('whatsapp_contacts')
      .select('id, phone_number, push_name, pipeline_stage, ai_agent_id')
      .eq('user_id', userId)
      .eq('remote_jid', remoteJid)
      .maybeSingle()
    contact = existing

    if (!contact && effectivePhone) {
      const { data: byPhone } = await supabase
        .from('whatsapp_contacts')
        .select('id, phone_number, push_name, pipeline_stage, ai_agent_id')
        .eq('user_id', userId)
        .eq('phone_number', effectivePhone)
        .limit(1)
        .maybeSingle()
      if (byPhone) contact = byPhone
    }

    if (!contact) {
      if (fromMe) return new Response(JSON.stringify({ success: true }), { status: 200 })
      const { data: newContact } = await supabase
        .from('whatsapp_contacts')
        .insert({
          user_id: userId,
          remote_jid: remoteJid,
          phone_number: effectivePhone,
          push_name: pushName && !/^\d+$/.test(pushName) ? pushName : null,
          last_message_at: timestamp,
          pipeline_stage: 'Em Conversa',
        })
        .select('id, phone_number, push_name, pipeline_stage, ai_agent_id')
        .single()
      contact = newContact
    } else {
      const upd: any = { last_message_at: timestamp }
      if (contact.pipeline_stage !== 'Contato Humano') upd.pipeline_stage = 'Em Conversa'
      if (
        !fromMe &&
        pushName &&
        !/^\d+$/.test(pushName) &&
        (!contact.push_name || /^\d+$/.test(contact.push_name))
      ) {
        upd.push_name = pushName
      }
      if (effectivePhone && !contact.phone_number) upd.phone_number = effectivePhone
      await supabase.from('whatsapp_contacts').update(upd).eq('id', contact.id)
    }

    if (!contact || !messageId) {
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }

    // Upsert message
    await supabase.from('whatsapp_messages').upsert(
      {
        user_id: userId,
        contact_id: contact.id,
        message_id: messageId,
        from_me: fromMe,
        text,
        type,
        timestamp,
        raw,
      },
      { onConflict: 'user_id,message_id' },
    )

    // AI dispatch (only for inbound text/audio)
    if (!fromMe) {
      if (type === 'audioMessage') {
        // For Z-API, audio is a direct URL — audio-handler will need the URL
        // For now, pass mediaUrl as evoUrl stub; audio-handler Task 15 will handle
        const { data: newVersion } = await supabase.rpc('increment_ai_trigger_version', {
          p_contact_id: contact.id,
        })
        if (newVersion != null && mediaUrl) {
          const audioTask = processAudioMessage(
            userId,
            contact.id,
            messageId,
            supabaseUrl,
            supabaseKey,
            newVersion as number,
            mediaUrl, // Z-API: direct URL passed as evoUrl param (adapted in Task 15)
            '',
            '',
          )
          if (typeof (globalThis as any).EdgeRuntime?.waitUntil === 'function') {
            ;(globalThis as any).EdgeRuntime.waitUntil(audioTask)
          }
        }
      } else if (['conversation', 'text'].includes(type)) {
        const { data: newVersion } = await supabase.rpc('increment_ai_trigger_version', {
          p_contact_id: contact.id,
        })
        if (newVersion != null) {
          if (typeof (globalThis as any).EdgeRuntime?.waitUntil === 'function') {
            ;(globalThis as any).EdgeRuntime.waitUntil(
              processAiResponse(userId, contact.id, supabaseUrl, supabaseKey, newVersion as number),
            )
          }
        }
      }
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error: any) {
    console.error('[ZAPI-WEBHOOK] Error:', error)
    return new Response(JSON.stringify({ success: true }), { status: 200 }) // always 200 to Z-API
  }
})
```

- [ ] **Step 3: Deploy**

```bash
supabase functions deploy zapi-webhook --no-verify-jwt
```

Expected: "Deployed zapi-webhook"

- [ ] **Step 4: Smoke test — Evolution AI still works**

```bash
curl "https://fckenwdyghisdebqauxy.supabase.co/functions/v1/evolution-debug?endpoint=test-ai" \
  -H "Authorization: Bearer <service_role_key>"
```

Expected: `"ok": true`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/zapi-webhook/
git commit -m "feat: add zapi-webhook ingress function"
```

---

## Phase 4 — Function Migration

### Task 7: Migrate `evolution-send-message` + `ai-handler` send calls

**Files:**

- Modify: `supabase/functions/evolution-send-message/index.ts`
- Modify: `supabase/functions/evolution-webhook/ai-handler.ts`

- [ ] **Step 1: Migrate `evolution-send-message`**

In `evolution-send-message/index.ts`, add import at top:

```typescript
import { getProvider } from '../_shared/providers/factory.ts'
```

Replace lines 38–66 (the `evoUrlRaw`/`evoUrl`/`evoKey` setup + `fetch` call):

```typescript
const provider = getProvider(integration)

const textToSend =
  integration.captions_enabled && integration.user_display_name
    ? `*[${integration.user_display_name}]*\n${text}`
    : text

const { messageId, raw: result } = await provider.sendText(contact.remote_jid, textToSend)
const timestamp = new Date().toISOString()
```

Remove the now-unused `response.ok` check and `result` variable below it — `provider.sendText` throws on failure.

- [ ] **Step 2: Migrate `ai-handler.ts` send calls**

In `evolution-webhook/ai-handler.ts`, add import at top:

```typescript
import { getProvider } from '../_shared/providers/factory.ts'
```

Find the three `fetch(`${evoUrl}/message/sendText/...`)` calls (lines ~126, ~485, ~513). For the rate-limit send at line ~126:

Replace:

```typescript
    await fetch(`${evoUrl}/message/sendText/${integration.instance_name}`, {
      method: 'POST',
      headers: { apikey: evoKey as string, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        number: contact.remote_jid,
        text: integration.rate_limit_message ?? '...',
      }),
    }).catch(...)
```

With:

```typescript
const provider = getProvider(integration)
await provider
  .sendText(
    contact.remote_jid,
    integration.rate_limit_message ??
      'Identificamos um volume elevado de mensagens e transferiremos seu atendimento para um de nossos atendentes. Em breve você será atendido!',
  )
  .catch((err: any) =>
    console.error(`[AI Handler] rate_limit_msg_send_failed contactId=${contactId}:`, err),
  )
```

For the main AI reply send at line ~485, replace:

```typescript
const sendRes = await fetch(`${evoUrl}/message/sendText/${integration.instance_name}`, {
  method: 'POST',
  headers: { apikey: evoKey, 'Content-Type': 'application/json' },
  body: JSON.stringify({ number: contact.remote_jid, text: replyText }),
})
```

With:

```typescript
const provider = getProvider(integration)
let sendRes: { ok: boolean; text: () => Promise<string> }
let messageId: string | undefined
try {
  const sent = await provider.sendText(contact.remote_jid, replyText)
  messageId = sent.messageId
  sendRes = { ok: true, text: async () => '' }
} catch (err: any) {
  sendRes = { ok: false, text: async () => err.message }
}
```

For the fallback send at line ~513, replace similarly:

```typescript
    await fetch(`${evoUrl}/message/sendText/${integration.instance_name}`, {
      method: 'POST',
      headers: { apikey: evoKey as string, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: contact.remote_jid, text: fallbackText }),
    }).catch(...)
```

With:

```typescript
const providerFallback = getProvider(integration)
await providerFallback
  .sendText(contact.remote_jid, fallbackText)
  .catch((err: any) =>
    console.error(`[AI Handler] fallback_send_failed contactId=${contactId}:`, err),
  )
```

After these replacements, remove the `evoUrl`/`evoKey` lines in ai-handler (lines ~94–112) that previously checked for missing URL/key and returned early — those checks now belong in `getProvider()` which throws on missing credentials.

> Keep the `[AI Handler] evolution_ok` log line but change the message to `[AI Handler] provider_ok`.

- [ ] **Step 3: Deploy both functions**

```bash
supabase functions deploy evolution-send-message --no-verify-jwt
supabase functions deploy evolution-webhook --no-verify-jwt
```

- [ ] **Step 4: Smoke test**

```bash
curl "https://fckenwdyghisdebqauxy.supabase.co/functions/v1/evolution-debug?endpoint=test-ai" \
  -H "Authorization: Bearer <service_role_key>"
```

Expected: `"ok": true`, `api_key_present: true`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/evolution-send-message/index.ts supabase/functions/evolution-webhook/ai-handler.ts
git commit -m "feat: migrate send-message and ai-handler to use WhatsAppProvider.sendText"
```

---

### Task 8: EvolutionProvider `getQrCode` + migrate `evolution-get-qr`

**Files:**

- Modify: `supabase/functions/_shared/providers/evolution.ts` (add `getQrCode`)
- Modify: `supabase/functions/evolution-get-qr/index.ts`

- [ ] **Step 1: Add `getQrCode` to EvolutionProvider**

Replace the stub `getQrCode` method in `evolution.ts` with:

```typescript
  async getQrCode(): Promise<{ base64: string } | { connected: true }> {
    // 1. Check connection state
    const stateRes = await fetch(`${this.url}/instance/connectionState/${this.instance}`, {
      headers: { apikey: this.key },
    })

    if (stateRes.status === 404) {
      // Instance doesn't exist — create it
      const createRes = await fetch(`${this.url}/instance/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: this.key },
        body: JSON.stringify({
          instanceName: this.instance,
          token: this.instance,
          qrcode: true,
          integration: 'WHATSAPP-BAILEYS',
        }),
      })

      if (!createRes.ok) {
        const errText = await createRes.text()
        const isDuplicate = createRes.status === 409 || errText.includes('already exists') || errText.includes('Duplicated')
        if (!isDuplicate) throw new Error(`Evolution instance/create failed (${createRes.status}): ${errText}`)
        // Duplicate → fall through to connect endpoint below
      } else {
        const createData = await createRes.json()
        if (createData.qrcode?.base64) return { base64: createData.qrcode.base64 }
        // No QR in create response — fall through to connect endpoint
      }
    } else if (stateRes.ok) {
      const stateData = await stateRes.json()
      if (stateData.instance?.state === 'open' || stateData.state === 'open') {
        return { connected: true }
      }
    }

    // 2. Instance exists but not connected — call /instance/connect to get QR
    const connectRes = await fetch(`${this.url}/instance/connect/${this.instance}`, {
      method: 'GET',
      headers: { apikey: this.key },
    })

    if (!connectRes.ok) {
      throw new Error(`Evolution instance/connect failed (${connectRes.status}): ${await connectRes.text()}`)
    }

    const connectData = await connectRes.json()
    if (connectData.instance?.state === 'open' || connectData.state === 'open') {
      return { connected: true }
    }

    const base64 = connectData.base64
    if (!base64) throw new Error('qr_not_ready_yet')
    return { base64 }
  }
```

- [ ] **Step 2: Migrate `evolution-get-qr/index.ts`**

Add import:

```typescript
import { getProvider } from '../_shared/providers/factory.ts'
```

Replace the entire body of the try block (after fetching `integ`) — lines ~24–278 — with:

```typescript
const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const supabase = createClient(supabaseUrl, supabaseKey)

const { data: integ } = await supabase
  .from('user_integrations')
  .select('*')
  .eq('id', integrationId)
  .single()
if (!integ) throw new Error('Missing configuration')

// Ensure instance_name = user_id for Evolution
const instanceName = integ.user_id
if (integ.provider !== 'zapi' && integ.instance_name !== instanceName) {
  await supabase
    .from('user_integrations')
    .update({ instance_name: instanceName })
    .eq('id', integrationId)
  integ.instance_name = instanceName
}

const provider = getProvider(integ)

const result = await provider.getQrCode()

if ('connected' in result) {
  // Ensure webhook is configured
  const webhookUrl =
    integ.provider === 'zapi'
      ? `${supabaseUrl}/functions/v1/zapi-webhook/${integ.user_id}`
      : `${supabaseUrl}/functions/v1/evolution-webhook`
  const webhookOk = await provider.configureWebhook(webhookUrl)
  await supabase
    .from('user_integrations')
    .update({ status: 'CONNECTED', is_webhook_enabled: webhookOk })
    .eq('id', integrationId)
  return new Response(JSON.stringify({ connected: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// QR ready
await supabase.from('user_integrations').update({ status: 'WAITING_QR' }).eq('id', integrationId)

return new Response(JSON.stringify({ base64: result.base64 }), {
  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
})
```

- [ ] **Step 3: Deploy**

```bash
supabase functions deploy evolution-get-qr --no-verify-jwt
```

- [ ] **Step 4: Test — open the app, trigger QR flow, verify QR appears and CONNECTED state works**

- [ ] **Step 5: Smoke test AI**

```bash
curl "https://fckenwdyghisdebqauxy.supabase.co/functions/v1/evolution-debug?endpoint=test-ai" \
  -H "Authorization: Bearer <service_role_key>"
```

Expected: `"ok": true`.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/providers/evolution.ts supabase/functions/evolution-get-qr/index.ts
git commit -m "feat: add EvolutionProvider.getQrCode + migrate evolution-get-qr to use provider"
```

---

### Task 9: Migrate `evolution-create-instance`

**Files:**

- Modify: `supabase/functions/evolution-create-instance/index.ts`

This function is only called during onboarding. For Evolution, behavior stays the same (create instance + configure webhook). For Z-API, instance is pre-created by user — the function just configures the webhook and returns the current status.

- [ ] **Step 1: Add import + replace API block**

Add import:

```typescript
import { getProvider } from '../_shared/providers/factory.ts'
```

Replace lines 26–158 (the entire Evolution-specific block from `const evolutionApiUrlRaw` to the final success response) with:

```typescript
const instanceName = integ.user_id

if (integ.provider !== 'zapi' && integ.instance_name !== instanceName) {
  await supabase
    .from('user_integrations')
    .update({ instance_name: instanceName })
    .eq('id', integrationId)
  integ.instance_name = instanceName
}

const provider = getProvider(integ)
const webhookUrl =
  integ.provider === 'zapi'
    ? `${Deno.env.get('SUPABASE_URL')}/functions/v1/zapi-webhook/${integ.user_id}`
    : `${Deno.env.get('SUPABASE_URL')}/functions/v1/evolution-webhook`

if (integ.provider === 'zapi') {
  // Z-API: instance pre-exists. Check status + configure webhook.
  const status = await provider.getStatus()
  const webhookOk = await provider.configureWebhook(webhookUrl)
  await supabase
    .from('user_integrations')
    .update({
      status: status === 'CONNECTED' ? 'CONNECTED' : 'WAITING_QR',
      is_webhook_enabled: webhookOk,
    } as any)
    .eq('id', integrationId)
  return new Response(JSON.stringify({ success: true, connected: status === 'CONNECTED' }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// Evolution: original create + webhook flow via getQrCode (which creates if missing)
try {
  const qrResult = await provider.getQrCode()
  const webhookOk = await provider.configureWebhook(webhookUrl)
  const connected = 'connected' in qrResult
  await supabase
    .from('user_integrations')
    .update({
      status: connected ? 'CONNECTED' : 'WAITING_QR',
      is_webhook_enabled: webhookOk,
    } as any)
    .eq('id', integrationId)
  if (connected)
    return new Response(JSON.stringify({ success: true, connected: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
} catch (err: any) {
  return new Response(JSON.stringify({ error: err.message }), {
    status: 400,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
```

- [ ] **Step 2: Deploy**

```bash
supabase functions deploy evolution-create-instance --no-verify-jwt
```

- [ ] **Step 3: Smoke test**

```bash
curl "https://fckenwdyghisdebqauxy.supabase.co/functions/v1/evolution-debug?endpoint=test-ai" \
  -H "Authorization: Bearer <service_role_key>"
```

Expected: `"ok": true`.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/evolution-create-instance/index.ts
git commit -m "feat: migrate evolution-create-instance to use provider (Z-API skips create, configures webhook)"
```

---

### Task 10: Migrate `evolution-disconnect`

**Files:**

- Modify: `supabase/functions/evolution-disconnect/index.ts`

- [ ] **Step 1: Add import + replace API call**

Add import:

```typescript
import { getProvider } from '../_shared/providers/factory.ts'
```

In the try block, find the section that reads `evolution_api_url`/`evolution_api_key` and calls `fetch(...instance/logout...)`. Replace it with:

```typescript
const provider = getProvider(integ)
await provider.disconnect()
```

Keep all the Supabase status update (`update({ status: 'DISCONNECTED' })`) unchanged below it.

- [ ] **Step 2: Deploy**

```bash
supabase functions deploy evolution-disconnect --no-verify-jwt
```

- [ ] **Step 3: Smoke test AI**

```bash
curl "https://fckenwdyghisdebqauxy.supabase.co/functions/v1/evolution-debug?endpoint=test-ai" \
  -H "Authorization: Bearer <service_role_key>"
```

Expected: `"ok": true`.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/evolution-disconnect/index.ts
git commit -m "feat: migrate evolution-disconnect to use provider.disconnect()"
```

---

### Task 11: EvolutionProvider `syncChats` + migrate `evolution-sync-contacts`

**Files:**

- Modify: `supabase/functions/_shared/providers/evolution.ts` (add `syncChats`)
- Modify: `supabase/functions/evolution-sync-contacts/index.ts`

- [ ] **Step 1: Add `syncChats` to EvolutionProvider**

Replace the stub `syncChats` in `evolution.ts` with:

```typescript
  async syncChats(): Promise<NormalizedContact[]> {
    const r = await fetch(`${this.url}/chat/findChats/${this.instance}`, {
      method: 'GET',
      headers: { apikey: this.key, 'Content-Type': 'application/json' },
    })
    if (!r.ok) throw new Error(`Evolution findChats failed (${r.status}): ${await r.text()}`)
    const chats: any[] = await r.json()
    return chats
      .filter((c) => {
        const jid = c.remoteJid ?? c.jid ?? c.id ?? ''
        return jid && !jid.includes('@g.us') && !jid.includes('@broadcast')
      })
      .map((c) => {
        const jid = c.remoteJid ?? c.jid ?? c.id ?? ''
        const rawName = c.pushName ?? c.name ?? c.verifiedName ?? c.contactName ?? c.profileName ?? c.displayName ?? null
        const pushName = rawName && !/^\d+$/.test(rawName) ? rawName : null
        return {
          remoteJid: jid,
          pushName,
          canonicalPhone: null,  // resolved by sync-contacts with contact_identity
          lastMessageAt: c.lastMsgTimestamp
            ? new Date(c.lastMsgTimestamp * 1000).toISOString()
            : undefined,
        }
      })
  }
```

- [ ] **Step 2: Migrate `evolution-sync-contacts/index.ts`**

Add import:

```typescript
import { getProvider } from '../_shared/providers/factory.ts'
```

Read the current function to locate the `fetch(...chat/findChats...)` block (around line 80). Replace the `evoUrlRaw`/`evoUrl`/`evoKey` setup + `fetch` call + response parsing with:

```typescript
const provider = getProvider(integration)
const rawChats = await provider.syncChats()
// rawChats is NormalizedContact[]. For Evolution, remoteJid may be lid or phone JID.
// The existing contact_identity + identityMap logic below continues to apply.
const chats = rawChats.map((c) => ({
  remoteJid: c.remoteJid,
  jid: c.remoteJid,
  pushName: c.pushName,
  name: c.pushName,
}))
```

Then the rest of the function (identityMap, canonicalPhone resolution, upsert loop) continues unchanged with `chats` replacing the raw API response array.

> The identityMap / lid resolution block still runs for Evolution — `syncChats()` returns raw JIDs and the existing logic handles them. For Z-API, `syncChats()` returns already-resolved `@s.whatsapp.net` JIDs, so the identityMap lookups are no-ops.

- [ ] **Step 3: Deploy**

```bash
supabase functions deploy evolution-sync-contacts --no-verify-jwt
```

- [ ] **Step 4: Smoke test AI**

```bash
curl "https://fckenwdyghisdebqauxy.supabase.co/functions/v1/evolution-debug?endpoint=test-ai" \
  -H "Authorization: Bearer <service_role_key>"
```

Expected: `"ok": true`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/providers/evolution.ts supabase/functions/evolution-sync-contacts/index.ts
git commit -m "feat: add EvolutionProvider.syncChats + migrate evolution-sync-contacts"
```

---

### Task 12: EvolutionProvider `syncMessages` + migrate `evolution-sync-messages`

**Files:**

- Modify: `supabase/functions/_shared/providers/evolution.ts` (add `syncMessages`)
- Modify: `supabase/functions/evolution-sync-messages/index.ts`

- [ ] **Step 1: Add `syncMessages` to EvolutionProvider**

Replace the stub `syncMessages` in `evolution.ts` with:

```typescript
  async syncMessages(chatId: string): Promise<NormalizedMessage[]> {
    const r = await fetch(`${this.url}/chat/findMessages/${this.instance}`, {
      method: 'POST',
      headers: { apikey: this.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ where: { key: { remoteJid: chatId } }, limit: 50 }),
    })
    if (!r.ok) {
      console.warn(`[EvolutionProvider] findMessages failed for ${chatId}: ${await r.text()}`)
      return []
    }
    const data = await r.json()
    const messages: any[] = Array.isArray(data) ? data : data?.messages ?? []
    return messages.map((m) => {
      const key = m.key ?? {}
      const content = m.message ?? {}
      const ts = m.messageTimestamp ?? m.timestamp
      return {
        messageId: key.id ?? m.id,
        remoteJid: key.remoteJid ?? chatId,
        fromMe: key.fromMe ?? false,
        text: content.conversation ?? content.extendedTextMessage?.text ?? null,
        timestamp: ts
          ? new Date(ts < 100000000000 ? ts * 1000 : ts).toISOString()
          : new Date().toISOString(),
        type: Object.keys(content).filter((k) => k !== 'messageContextInfo')[0] ?? 'text',
        raw: m,
      }
    })
  }
```

- [ ] **Step 2: Migrate `evolution-sync-messages/index.ts`**

Add import:

```typescript
import { getProvider } from '../_shared/providers/factory.ts'
```

Locate the `evoUrlRaw`/fetch for `chat/findChats` (line ~36–62) and the `fetch` for `chat/findMessages` (line ~242–246).

Replace the `findChats` fetch with:

```typescript
const provider = getProvider(integration)
const rawChats = await provider.syncChats()
const chats = rawChats.map((c) => ({
  remoteJid: c.remoteJid,
  jid: c.remoteJid,
  pushName: c.pushName,
  name: c.pushName,
}))
```

Replace each `fetch(.../chat/findMessages/...)` + response parsing block with:

```typescript
const providerMessages = await provider.syncMessages(jid)
const messages = providerMessages.map((m) => ({
  key: { id: m.messageId, remoteJid: m.remoteJid, fromMe: m.fromMe },
  message: { conversation: m.text },
  messageTimestamp: new Date(m.timestamp).getTime() / 1000,
  raw: m.raw,
}))
```

The rest of the loop (upsert into `whatsapp_messages`) uses `messages` and stays unchanged.

- [ ] **Step 3: Deploy**

```bash
supabase functions deploy evolution-sync-messages --no-verify-jwt
```

- [ ] **Step 4: Smoke test AI**

```bash
curl "https://fckenwdyghisdebqauxy.supabase.co/functions/v1/evolution-debug?endpoint=test-ai" \
  -H "Authorization: Bearer <service_role_key>"
```

Expected: `"ok": true`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/providers/evolution.ts supabase/functions/evolution-sync-messages/index.ts
git commit -m "feat: add EvolutionProvider.syncMessages + migrate evolution-sync-messages"
```

---

### Task 13: EvolutionProvider `fetchMedia` + migrate `evolution-get-media` + `evolution-transcribe-message`

**Files:**

- Modify: `supabase/functions/_shared/providers/evolution.ts` (add `fetchMedia`)
- Modify: `supabase/functions/evolution-get-media/index.ts`
- Modify: `supabase/functions/evolution-transcribe-message/index.ts`

- [ ] **Step 1: Add `fetchMedia` to EvolutionProvider**

Replace the stub `fetchMedia` in `evolution.ts` with:

```typescript
  async fetchMedia(options: { messageId?: string; rawPayload?: unknown }): Promise<string | null> {
    const { messageId, rawPayload } = options
    if (!messageId) return null
    const r = await fetch(`${this.url}/chat/getBase64FromMediaMessage/${this.instance}`, {
      method: 'POST',
      headers: { apikey: this.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { key: { id: messageId } } }),
    })
    if (!r.ok) {
      console.warn(`[EvolutionProvider] getBase64FromMediaMessage failed: ${await r.text()}`)
      return null
    }
    const j = await r.json()
    return j.base64 ?? null
  }
```

- [ ] **Step 2: Migrate `evolution-get-media/index.ts`**

Add import:

```typescript
import { getProvider } from '../_shared/providers/factory.ts'
```

Replace lines ~54–78 (integration query + `evoUrlRaw`/`evoUrl`/`evoKey` setup + `evoRes fetch`) with:

```typescript
const { data: integration } = await supabase
  .from('user_integrations')
  .select('*')
  .eq('user_id', user.id)
  .single()
if (!integration) throw new Error('Integration not found')

const provider = getProvider(integration)

// For Z-API, rawPayload carries the direct URL; for Evolution, messageId triggers API fetch.
const result = await provider.fetchMedia({ messageId, rawPayload: message?.raw })

if (!result) throw new Error('Media not available')

// Z-API returns a URL; Evolution returns base64. Normalise to base64 for the frontend.
let base64: string
if (result.startsWith('http')) {
  const mediaRes = await fetch(result)
  if (!mediaRes.ok) throw new Error('Failed to download Z-API media')
  const buf = await mediaRes.arrayBuffer()
  const bytes = new Uint8Array(buf)
  base64 = btoa(String.fromCharCode(...bytes))
} else {
  base64 = result
}
```

Adjust the rest of the function to use `base64` instead of the original `evoRes` variable.

- [ ] **Step 3: Migrate `evolution-transcribe-message/index.ts`**

Add import:

```typescript
import { getProvider } from '../_shared/providers/factory.ts'
```

Replace lines ~66–120 (integration query + fetch `getBase64FromMediaMessage`) with:

```typescript
const { data: integ } = await supabase
  .from('user_integrations')
  .select('*')
  .eq('user_id', userId)
  .single()
if (!integ) throw new Error('Integration not found')

const provider = getProvider(integ)
const mediaResult = await provider.fetchMedia({ messageId, rawPayload: message?.raw })
if (!mediaResult) throw new Error('Media fetch returned null')

// Z-API returns direct URL; Evolution returns base64.
let audioBase64: string | null = null
let audioUrl: string | null = null
if (mediaResult.startsWith('http')) {
  audioUrl = mediaResult
} else {
  audioBase64 = mediaResult
}
```

Update the AssemblyAI call below to use `audioUrl` (Z-API) or `audioBase64` (Evolution). The AssemblyAI client accepts both — pass `audio_url: audioUrl` or `audio_data: audioBase64` depending on which is set.

- [ ] **Step 4: Deploy all three**

```bash
supabase functions deploy evolution-get-media --no-verify-jwt
supabase functions deploy evolution-transcribe-message --no-verify-jwt
```

- [ ] **Step 5: Smoke test AI**

```bash
curl "https://fckenwdyghisdebqauxy.supabase.co/functions/v1/evolution-debug?endpoint=test-ai" \
  -H "Authorization: Bearer <service_role_key>"
```

Expected: `"ok": true`.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/providers/evolution.ts supabase/functions/evolution-get-media/index.ts supabase/functions/evolution-transcribe-message/index.ts
git commit -m "feat: add EvolutionProvider.fetchMedia + migrate get-media and transcribe to use provider"
```

---

### Task 14: Z-API credentials branch in `evolution-credentials`

**Files:**

- Modify: `supabase/functions/evolution-credentials/index.ts`

- [ ] **Step 1: Add Z-API branch**

In `evolution-credentials/index.ts`, inside the `action === 'get'` branch, replace the current Evolution-only response:

```typescript
if (action === 'get') {
  const { data: integ } = await supabaseAdmin
    .from('user_integrations')
    .select(
      'provider, evolution_api_url, evolution_api_key, zapi_instance_id, zapi_instance_token, zapi_client_token',
    )
    .eq('user_id', user.id)
    .single()

  const provider = integ?.provider ?? 'evolution'

  if (provider === 'zapi') {
    return new Response(
      JSON.stringify({
        provider: 'zapi',
        zapi_instance_id: integ?.zapi_instance_id ?? null,
        zapi_instance_token_masked: integ?.zapi_instance_token
          ? maskKey(integ.zapi_instance_token)
          : null,
        zapi_client_token_masked: integ?.zapi_client_token
          ? maskKey(integ.zapi_client_token)
          : null,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  return new Response(
    JSON.stringify({
      provider: 'evolution',
      url: integ?.evolution_api_url ?? null,
      api_key_masked: integ?.evolution_api_key ? maskKey(integ.evolution_api_key) : null,
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  )
}
```

Inside the `action === 'save'` branch, detect Z-API saves:

```typescript
    if (action === 'save') {
      const { provider } = await req.json().catch(() => ({}))
      // re-parse to get all fields
      const body = await req.json().catch(() => ({}))
      // Note: req.json() was already consumed above. Pass all fields via the existing destructure.
      // Actually — restructure the save branch to read all fields at top of handler.
```

> **Implementation note:** The `req.json()` call at the top of the handler currently destructures `{ action, url, api_key }`. Change it to:

```typescript
const body = await req.json()
const { action } = body
```

Then in the `save` branch:

```typescript
if (action === 'save') {
  const {
    provider = 'evolution',
    url,
    api_key,
    zapi_instance_id,
    zapi_instance_token,
    zapi_client_token,
  } = body

  if (provider === 'zapi') {
    if (!zapi_instance_id || !zapi_instance_token || !zapi_client_token) {
      throw new Error('zapi_instance_id, zapi_instance_token, and zapi_client_token are required')
    }
    // Validate by calling /status
    const base = `https://api.z-api.io/instances/${zapi_instance_id}/token/${zapi_instance_token}`
    const testRes = await fetch(`${base}/status`, {
      headers: { 'Client-Token': zapi_client_token },
    })
    if (!testRes.ok) {
      throw new Error(`Z-API validation failed (${testRes.status}): ${await testRes.text()}`)
    }

    await supabaseAdmin
      .from('user_integrations')
      .update({
        provider: 'zapi',
        zapi_instance_id,
        zapi_instance_token,
        zapi_client_token,
      })
      .eq('user_id', user.id)

    return new Response(
      JSON.stringify({
        provider: 'zapi',
        zapi_instance_id,
        zapi_instance_token_masked: maskKey(zapi_instance_token),
        zapi_client_token_masked: maskKey(zapi_client_token),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  // Evolution save (existing logic, unchanged)
  if (!url || !api_key) throw new Error('url and api_key are required')
  // ... rest of existing Evolution save block unchanged ...
}
```

- [ ] **Step 2: Deploy**

```bash
supabase functions deploy evolution-credentials --no-verify-jwt
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/evolution-credentials/index.ts
git commit -m "feat: add Z-API branch to evolution-credentials (get/save/validate Z-API trio)"
```

---

## Phase 5 — Frontend + Validation

### Task 15: Frontend — provider toggle + conditional credential fields

**Files:**

- Modify: `src/pages/Settings.tsx`
- Modify: `src/pages/Onboarding.tsx`

- [ ] **Step 1: Read current Settings.tsx to understand exact component structure**

```bash
wc -l src/pages/Settings.tsx
```

Then read the file to find the Evolution credential card (around line 243 per earlier grep).

- [ ] **Step 2: Add provider toggle + Z-API fields to Settings.tsx**

In the Evolution credentials card section, add a provider selector above the credential fields:

```tsx
{
  /* Provider toggle */
}
;<div className="flex gap-2 mb-4">
  <Button
    variant={editProvider === 'evolution' ? 'default' : 'outline'}
    size="sm"
    onClick={() => setEditProvider('evolution')}
  >
    Evolution
  </Button>
  <Button
    variant={editProvider === 'zapi' ? 'default' : 'outline'}
    size="sm"
    onClick={() => setEditProvider('zapi')}
  >
    Z-API
  </Button>
</div>

{
  editProvider === 'evolution' ? (
    <>{/* existing Evolution url + api_key inputs — unchanged */}</>
  ) : (
    <>
      <div className="space-y-2">
        <Label htmlFor="settings-zapi-instance-id">Instance ID</Label>
        <Input
          id="settings-zapi-instance-id"
          value={zapiInstanceId}
          onChange={(e) => setZapiInstanceId(e.target.value)}
          placeholder="A20DA9C0183A2D35A260F53F5D2B9244"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="settings-zapi-token">Instance Token</Label>
        <Input
          id="settings-zapi-token"
          type="password"
          value={zapiInstanceToken}
          onChange={(e) => setZapiInstanceToken(e.target.value)}
          placeholder="Instance Token"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="settings-zapi-client-token">Client Token</Label>
        <Input
          id="settings-zapi-client-token"
          type="password"
          value={zapiClientToken}
          onChange={(e) => setZapiClientToken(e.target.value)}
          placeholder="F7...account-level token"
        />
      </div>
    </>
  )
}
```

Add state variables at the top of the component:

```tsx
const [editProvider, setEditProvider] = useState<'evolution' | 'zapi'>(
  (integration?.provider as any) ?? 'evolution',
)
const [zapiInstanceId, setZapiInstanceId] = useState('')
const [zapiInstanceToken, setZapiInstanceToken] = useState('')
const [zapiClientToken, setZapiClientToken] = useState('')
```

Update the save handler to call `evolution-credentials` with the correct payload:

```tsx
const body =
  editProvider === 'zapi'
    ? {
        action: 'save',
        provider: 'zapi',
        zapi_instance_id: zapiInstanceId,
        zapi_instance_token: zapiInstanceToken,
        zapi_client_token: zapiClientToken,
      }
    : { action: 'save', provider: 'evolution', url: editUrl.trim(), api_key: editKey.trim() }

const { data, error } = await supabase.functions.invoke('evolution-credentials', { body })
```

- [ ] **Step 3: Add Z-API credentials step to Onboarding.tsx**

In Onboarding step 0 (credentials setup), wrap the existing Evolution fields the same way — provider toggle with conditional Evolution/Z-API fields. The invoke call in step 1 (`evolution-credentials` save) passes the provider-specific body the same as Settings.tsx.

- [ ] **Step 4: Build + lint**

```bash
pnpm build:dev 2>&1 | tail -5
pnpm lint 2>&1 | tail -10
```

Expected: both exit 0.

- [ ] **Step 5: Start dev server and verify UI**

```bash
pnpm dev --port 8085
```

- Open `http://localhost:8085/settings`
- Toggle to Z-API — verify three fields appear
- Toggle back to Evolution — verify original two fields appear
- No console errors

- [ ] **Step 6: Commit**

```bash
git add src/pages/Settings.tsx src/pages/Onboarding.tsx
git commit -m "feat: add provider toggle and Z-API credential fields to Settings and Onboarding"
```

---

### Task 16: End-to-end validation

- [ ] **Step 1: Verify all functions deployed with `--no-verify-jwt`**

```bash
supabase functions list --project-ref fckenwdyghisdebqauxy
```

Confirm `zapi-webhook` appears in the list.

- [ ] **Step 2: Evolution smoke test (full AI pipeline)**

```bash
curl "https://fckenwdyghisdebqauxy.supabase.co/functions/v1/evolution-debug?endpoint=test-ai" \
  -H "Authorization: Bearer <service_role_key>"
```

Expected: `"ok": true`, `fk_join_ok: true`, `api_key_present: true`.

- [ ] **Step 3: Z-API manual connect test**

1. In Settings, toggle to Z-API, enter valid `instanceId` + `instanceToken` + `clientToken`, save.
2. Go to Onboarding or ConnectionCard — trigger QR.
3. Scan QR with WhatsApp phone.
4. Verify `integration.status` becomes `CONNECTED` in Supabase dashboard.
5. Verify `is_webhook_enabled = true`.

- [ ] **Step 4: Z-API inbound message test**

From a second phone, send a text to the connected Z-API number.

Expected:

- `zapi-webhook` receives `ReceivedCallback` → logs `[ZAPI-WEBHOOK] Inbound from 5544...`
- `whatsapp_contacts` row created/updated
- `whatsapp_messages` row created
- AI agent responds (if contact has `ai_agent_id`)

Check logs:

```
supabase functions logs zapi-webhook --project-ref fckenwdyghisdebqauxy
```

- [ ] **Step 5: Z-API outbound send test**

From the app Chat UI, send a text to the Z-API contact.

Expected: message delivered, `messageId` saved to `whatsapp_messages`, pipeline stage updated.

- [ ] **Step 6: Z-API sync test**

From the app, trigger contact sync.

Expected: contacts imported, no duplicates from lid/phone duality (Z-API resolves phone natively).

- [ ] **Step 7: Final build**

```bash
pnpm build
```

Expected: exits 0, no TypeScript errors.
