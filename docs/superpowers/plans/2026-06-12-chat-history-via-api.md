# Chat History via Provider API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load chat message history directly from Z-API/Evolution API instead of from the DB; simplify `evolution-sync-messages` to only update `last_message_at` per contact (no bulk message storage).

**Architecture:** New `get-chat-messages` edge function proxies message history from the provider API to the frontend. `Chat.tsx` calls this function instead of querying `whatsapp_messages` directly. Realtime subscription on `whatsapp_messages` stays — webhook messages still insert to DB for AI context and real-time display. `evolution-sync-messages` Z-API path replaces bulk message storage with a lightweight `getLastMessage` call per contact.

**Tech Stack:** Deno edge functions, Supabase JS client, React 19, TypeScript, Z-API + Evolution API providers.

---

## File Map

| File | Action | What changes |
|---|---|---|
| `supabase/functions/_shared/providers/types.ts` | Modify | Add `getChatMessages` + `getLastMessage` to `WhatsAppProvider` interface |
| `supabase/functions/_shared/providers/zapi.ts` | Modify | Implement both new methods |
| `supabase/functions/_shared/providers/evolution.ts` | Modify | Implement both new methods |
| `supabase/functions/get-chat-messages/index.ts` | Create | New edge fn — auth, lookup contact+integration, call provider, return messages |
| `supabase/functions/get-chat-messages/deno.json` | Create | Deno config for new fn |
| `supabase/functions/evolution-sync-messages/index.ts` | Modify | Z-API path: replace bulk upsert with `getLastMessage` → update `last_message_at` only |
| `src/pages/Chat.tsx` | Modify | Initial load via `get-chat-messages` fn; pagination via fn page param; fix realtime dedup |

---

## Task 1: Extend `WhatsAppProvider` interface

**Files:**
- Modify: `supabase/functions/_shared/providers/types.ts`

- [ ] **Step 1: Add two methods to the interface**

Replace the entire file content:

```typescript
export interface NormalizedInbound {
  remoteJid: string
  pushName: string | null
  text: string | null
  timestamp: string
  messageId: string
  mediaUrl: string | null
  lid: string | null
  fromMe: boolean
  type: string
  raw: unknown
}

export interface NormalizedContact {
  remoteJid: string
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
  sendText(toJid: string, text: string): Promise<{ messageId: string; raw: unknown }>
  getQrCode(): Promise<{ base64: string } | { connected: true }>
  getStatus(): Promise<'CONNECTED' | 'WAITING_QR' | 'DISCONNECTED'>
  configureWebhook(callbackUrl: string): Promise<boolean>
  disconnect(): Promise<void>
  syncChats(): Promise<NormalizedContact[]>
  syncMessages(chatId: string): Promise<NormalizedMessage[]>
  getChatMessages(chatId: string, opts?: { page?: number; limit?: number }): Promise<NormalizedMessage[]>
  getLastMessage(chatId: string): Promise<{ messageId: string; timestamp: string } | null>
  parseInbound(payload: unknown): NormalizedInbound | null
  fetchMedia(options: { messageId?: string; rawPayload?: unknown }): Promise<string | null>
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/providers/types.ts
git commit -m "feat: add getChatMessages and getLastMessage to WhatsAppProvider interface"
```

---

## Task 2: Implement new methods in `ZapiProvider`

**Files:**
- Modify: `supabase/functions/_shared/providers/zapi.ts`

- [ ] **Step 1: Add `getChatMessages` method**

Add after the closing brace of `syncMessages` (before `parseInbound`):

```typescript
  async getChatMessages(chatId: string, opts?: { page?: number; limit?: number }): Promise<NormalizedMessage[]> {
    const phone = this.toPhone(chatId)
    const limit = opts?.limit ?? 50
    const page = opts?.page ?? 1

    const r = await fetch(`${this.base}/chat-messages/${phone}`, {
      headers: { 'Client-Token': this.clientToken },
    })
    if (!r.ok) {
      console.warn(`[ZapiProvider] getChatMessages failed for ${phone}: ${await r.text()}`)
      return []
    }
    const raw: any[] = await r.json()
    if (!Array.isArray(raw)) return []

    // Sort descending by timestamp (newest first), then paginate
    const sorted = [...raw].sort((a, b) => {
      const ta = a.momment ?? a.timestamp ?? 0
      const tb = b.momment ?? b.timestamp ?? 0
      return tb - ta
    })
    const offset = (page - 1) * limit
    const slice = sorted.slice(offset, offset + limit)

    return slice.map((m) => {
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
        type: m.audio ? 'audioMessage' : m.image ? 'imageMessage' : 'conversation',
        mediaUrl: m.audio?.audioUrl ?? m.image?.imageUrl ?? null,
        raw: m,
      }
    })
  }
```

- [ ] **Step 2: Add `getLastMessage` method**

Add immediately after `getChatMessages`:

```typescript
  async getLastMessage(chatId: string): Promise<{ messageId: string; timestamp: string } | null> {
    const messages = await this.getChatMessages(chatId, { page: 1, limit: 1 })
    if (messages.length === 0) return null
    return { messageId: messages[0].messageId, timestamp: messages[0].timestamp }
  }
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/providers/zapi.ts
git commit -m "feat: implement getChatMessages and getLastMessage in ZapiProvider"
```

---

## Task 3: Implement new methods in `EvolutionProvider`

**Files:**
- Modify: `supabase/functions/_shared/providers/evolution.ts`

- [ ] **Step 1: Add `getChatMessages` method**

Add after the closing brace of `syncMessages` (before `fetchMedia`):

```typescript
  async getChatMessages(chatId: string, opts?: { page?: number; limit?: number }): Promise<NormalizedMessage[]> {
    const page = opts?.page ?? 1
    const limit = opts?.limit ?? 50
    const r = await fetch(`${this.url}/chat/findMessages/${this.instance}`, {
      method: 'POST',
      headers: { apikey: this.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        where: { key: { remoteJid: chatId } },
        sort: 'desc',
        page,
        limit,
      }),
    })
    if (!r.ok) {
      console.warn(`[EvolutionProvider] getChatMessages failed for ${chatId}: ${await r.text()}`)
      return []
    }
    const data = await r.json()
    const messages: any[] = Array.isArray(data)
      ? data
      : data?.messages?.records ?? data?.messages ?? data?.records ?? []
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

- [ ] **Step 2: Add `getLastMessage` method**

Add immediately after `getChatMessages`:

```typescript
  async getLastMessage(chatId: string): Promise<{ messageId: string; timestamp: string } | null> {
    const messages = await this.getChatMessages(chatId, { page: 1, limit: 1 })
    if (messages.length === 0) return null
    return { messageId: messages[0].messageId, timestamp: messages[0].timestamp }
  }
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/providers/evolution.ts
git commit -m "feat: implement getChatMessages and getLastMessage in EvolutionProvider"
```

---

## Task 4: Create `get-chat-messages` edge function

**Files:**
- Create: `supabase/functions/get-chat-messages/deno.json`
- Create: `supabase/functions/get-chat-messages/index.ts`

- [ ] **Step 1: Create `deno.json`**

```json
{
  "imports": {
    "supabase": "jsr:@supabase/functions-js@2.4.1",
    "cors": "../_shared/cors.ts"
  }
}
```

- [ ] **Step 2: Create `index.ts`**

```typescript
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import { getProvider } from '../_shared/providers/factory.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing Authorization header')

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: userError } = await userClient.auth.getUser()
    if (userError || !user) throw new Error('Unauthorized')

    const body = await req.json()
    const { contactId, page = 1 } = body as { contactId?: string; page?: number }
    if (!contactId) throw new Error('contactId required')

    const adminClient = createClient(supabaseUrl, supabaseServiceKey)

    const { data: contact } = await adminClient
      .from('whatsapp_contacts')
      .select('id, remote_jid, phone_number, user_id')
      .eq('id', contactId)
      .eq('user_id', user.id)
      .single()

    if (!contact) throw new Error('Contact not found')

    const { data: integration } = await adminClient
      .from('user_integrations')
      .select('*')
      .eq('user_id', user.id)
      .single()

    if (!integration) throw new Error('Integration not found')

    const provider = getProvider(integration)
    const chatId = contact.phone_number
      ? `${contact.phone_number}@s.whatsapp.net`
      : contact.remote_jid

    const LIMIT = 50
    const messages = await provider.getChatMessages(chatId, { page, limit: LIMIT })

    // Shape messages to match WhatsAppMessage interface expected by Chat.tsx
    const shaped = messages.map((m) => ({
      id: m.messageId,
      message_id: m.messageId,
      contact_id: contactId,
      user_id: user.id,
      from_me: m.fromMe,
      text: m.text,
      type: m.type,
      transcript: null,
      timestamp: m.timestamp,
      raw: m.raw,
    }))

    return new Response(
      JSON.stringify({ messages: shaped, hasMore: messages.length === LIMIT }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
```

- [ ] **Step 3: Deploy**

```bash
supabase functions deploy get-chat-messages --no-verify-jwt
```

Expected output: `Deployed Functions on project fckenwdyghisdebqauxy: get-chat-messages`

- [ ] **Step 4: Smoke test**

The function requires a valid JWT — test via the app after Chat.tsx is updated. At this step, just confirm the deploy succeeded with no error.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/get-chat-messages/
git commit -m "feat: add get-chat-messages edge function — proxies chat history from provider API"
```

---

## Task 5: Simplify `evolution-sync-messages` — Z-API path

**Files:**
- Modify: `supabase/functions/evolution-sync-messages/index.ts`

The Z-API path currently iterates DB contacts, calls `syncMessages` (fetches all messages), and upserts everything into `whatsapp_messages`. Replace this with: call `getLastMessage` per contact → update `last_message_at` on the contact row. No `whatsapp_messages` inserts.

- [ ] **Step 1: Replace the Z-API block**

In `evolution-sync-messages/index.ts`, find and replace the entire `if (isZapi) { ... return }` block (lines 64–109) with:

```typescript
        // Z-API: update last_message_at per contact — no message storage
        if (isZapi) {
          const { data: dbContacts } = await supabaseClient
            .from('whatsapp_contacts')
            .select('id, remote_jid, phone_number')
            .eq('user_id', user.id)

          const contacts = dbContacts || []
          await supabaseClient
            .from('import_jobs')
            .update({ total_items: contacts.length })
            .eq('id', job.id)

          let processed = 0
          for (const contact of contacts) {
            try {
              const chatId = contact.phone_number
                ? `${contact.phone_number}@s.whatsapp.net`
                : contact.remote_jid
              const last = await provider.getLastMessage(chatId)
              if (last) {
                await supabaseClient
                  .from('whatsapp_contacts')
                  .update({ last_message_at: last.timestamp })
                  .eq('id', contact.id)
              }
            } catch (contactErr) {
              console.error(`[ZAPI-SYNC] getLastMessage failed for ${contact.remote_jid}:`, contactErr)
            }
            processed++
            if (processed % 10 === 0 || processed === contacts.length) {
              await supabaseClient
                .from('import_jobs')
                .update({ processed_items: processed })
                .eq('id', job.id)
            }
          }

          await supabaseClient
            .from('import_jobs')
            .update({ processed_items: contacts.length, status: 'completed' })
            .eq('id', job.id)
          return
        }
```

- [ ] **Step 2: Deploy**

```bash
supabase functions deploy evolution-sync-messages --no-verify-jwt
```

Expected output: `Deployed Functions on project fckenwdyghisdebqauxy: evolution-sync-messages`

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/evolution-sync-messages/index.ts
git commit -m "feat: simplify evolution-sync-messages Z-API path — update last_message_at only, no message storage"
```

---

## Task 6: Update `Chat.tsx` — load history via edge function

**Files:**
- Modify: `src/pages/Chat.tsx`

Three changes:
1. Replace the initial `fetchChat` DB message query with a call to `get-chat-messages`
2. Update `loadMoreMessages` to call the edge function with incrementing page
3. Fix realtime dedup to use `message_id` (not `id`, which differs between API messages and DB rows)

- [ ] **Step 1: Add page tracking state**

After the existing state declarations (around line 62), add:

```typescript
  const currentPageRef = useRef(1)
```

- [ ] **Step 2: Replace `fetchChat` message query**

Inside the `fetchChat` async function (starting at line 79), replace the messages section:

```typescript
// OLD — remove these lines:
      const { data: messagesData } = await supabase
        .from('whatsapp_messages')
        .select('*')
        .eq('contact_id', id)
        .order('timestamp', { ascending: false })
        .limit(PAGE_SIZE)

      if (messagesData) {
        setMessages([...messagesData].reverse())
        setHasMore(messagesData.length === PAGE_SIZE)
      } else {
        setHasMore(false)
      }
```

```typescript
// NEW — replace with:
      currentPageRef.current = 1
      const { data: msgData, error: msgError } = await supabase.functions.invoke('get-chat-messages', {
        body: { contactId: id, page: 1 },
      })
      if (!msgError && msgData?.messages) {
        setMessages(msgData.messages)
        setHasMore(msgData.hasMore ?? false)
      } else {
        setHasMore(false)
      }
```

- [ ] **Step 3: Replace `loadMoreMessages`**

Replace the entire `loadMoreMessages` callback (lines 177–206) with:

```typescript
  const loadMoreMessages = useCallback(async () => {
    if (isLoadingMoreRef.current || !hasMore || !id) return
    isLoadingMoreRef.current = true
    setIsLoadingMore(true)
    prevScrollHeightRef.current = messagesContainerRef.current?.scrollHeight ?? 0

    try {
      const nextPage = currentPageRef.current + 1
      const { data: msgData, error: msgError } = await supabase.functions.invoke('get-chat-messages', {
        body: { contactId: id, page: nextPage },
      })
      if (!msgError && msgData?.messages && msgData.messages.length > 0) {
        currentPageRef.current = nextPage
        setMessages((prev) => {
          const existingIds = new Set(prev.map((m) => m.message_id))
          const newMsgs = msgData.messages.filter((m: any) => !existingIds.has(m.message_id))
          return [...newMsgs, ...prev]
        })
        setHasMore(msgData.hasMore ?? false)
      } else {
        setHasMore(false)
      }
    } finally {
      isLoadingMoreRef.current = false
      setIsLoadingMore(false)
    }
  }, [hasMore, id])
```

- [ ] **Step 4: Fix realtime dedup**

In the realtime `postgres_changes` handler inside `fetchChat` effect (around line 117), replace:

```typescript
// OLD:
          if (prev.find((m) => m.id === payload.new.id)) return prev
```

```typescript
// NEW:
          if (prev.find((m) => m.message_id === payload.new.message_id)) return prev
```

- [ ] **Step 5: Verify build**

```bash
pnpm build 2>&1 | tail -20
```

Expected: no TypeScript errors related to `Chat.tsx`. Pre-existing type warnings in edge functions are unrelated.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Chat.tsx
git commit -m "feat: load chat history from provider API via get-chat-messages edge fn"
```

---

## Task 7: Run the message sync and verify

- [ ] **Step 1: Trigger sync via app**

Open the app and run the message sync (sync button in the UI). This will now call the simplified Z-API path.

- [ ] **Step 2: Verify `last_message_at` updated**

```bash
supabase db query --linked "SELECT id, remote_jid, phone_number, last_message_at FROM whatsapp_contacts WHERE phone_number = '551150395890' OR remote_jid LIKE '%1150395890%'"
```

Expected: `last_message_at` is now populated.

- [ ] **Step 3: Verify chat history loads**

Open the contact `+551150395890` in the app. Messages should now load from Z-API directly.

- [ ] **Step 4: Verify realtime still works**

Send a test message to the WhatsApp number. Confirm it appears in the chat view without page refresh.

---

## Notes

- `whatsapp_messages` table continues to receive inserts from webhooks. The AI handler (`ai-handler.ts`) and audio handler are unchanged — they still read from this table for LLM context.
- The `get-chat-messages` edge function always fetches fresh from the provider. No caching. If provider is temporarily unreachable, chat history shows empty (realtime messages still display).
- Evolution path in `evolution-sync-messages` is unchanged — it was not the user's active provider and has separate complexity around LID resolution. Tackle separately if needed.
- Z-API `/chat-messages/{phone}` returns all messages per chat. Server-side pagination is done client-side in `getChatMessages` via sort+slice. For contacts with thousands of messages, the first API call is heavier than needed. This is an acceptable tradeoff until Z-API exposes native pagination params.
