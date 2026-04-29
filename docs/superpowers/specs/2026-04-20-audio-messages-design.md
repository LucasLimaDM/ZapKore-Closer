# Audio Messages — Design Spec

**Date:** 2026-04-20  
**Status:** Approved

## Problem

Audio messages (`audioMessage`, `pttMessage`) received via the Evolution API webhook are currently stored with `text = '[Media/Unsupported]'` and rendered as plain text in the chat UI. There is no playback experience.

## Scope

- Support inbound `pttMessage` (WhatsApp voice notes) and `audioMessage` (uploaded audio files)
- Display a WhatsApp-style audio player in the chat UI
- Preload audio blobs eagerly on chat open to minimize perceived latency
- No schema changes, no Supabase Storage usage

---

## Architecture

### 1. Backend — `evolution-get-media` Edge Function

**File:** `supabase/functions/evolution-get-media/index.ts`

**Purpose:** On-demand media proxy. Fetches audio binary from the Evolution API and streams it back to the browser.

**Input:** `POST { messageId: string, contactId: string }`  
(JWT-authenticated via the standard Supabase auth header)

**Flow:**
1. Validate caller JWT → resolve `user_id`
2. Fetch `whatsapp_messages` row where `message_id = messageId` and `contact_id = contactId`, assert `user_id` matches → prevents cross-user access
3. Fetch `user_integrations` for `user_id` → get `instance_name`, `evolution_api_url`, `evolution_api_key`
4. Call Evolution API: `POST {evoUrl}/message/download-media/{instanceName}` with body `{ message: row.raw }`
5. Evolution returns `{ base64: string, mimetype: string }`
6. Decode base64 → `Uint8Array`, return as `Response` with correct `Content-Type` header (e.g. `audio/ogg; codecs=opus`, `audio/mp4`, `audio/mpeg`)

**Error cases:**
- Message not found or wrong owner → 404
- Evolution API failure → 502 with JSON error body
- Missing integration → 404

**Deploy:** `supabase functions deploy evolution-get-media --no-verify-jwt` (auth is handled manually inside the function using the JWT)

---

### 2. Frontend — `useAudioPreloader` Hook

**File:** `src/hooks/use-audio-preloader.ts`

**Purpose:** When a chat opens, immediately start fetching all audio blobs for the loaded messages in parallel. Tracks status per message.

**Signature:**
```ts
type AudioEntry = { status: 'loading' | 'ready' | 'error'; blobUrl: string | null }
function useAudioPreloader(messages: WhatsAppMessage[]): Map<string, AudioEntry>
```

**Behavior:**
- Filters messages where `type === 'audioMessage' || type === 'pttMessage'`
- For each audio message not yet in the map: fires `supabase.functions.invoke('evolution-get-media', { body: { messageId: msg.message_id, contactId: msg.contact_id } })`
- On success: the `supabase.functions.invoke` call must be made via raw `fetch` (not the SDK helper) to get a binary `Response` — the SDK returns parsed JSON by default. Use `fetch` with the Supabase anon key + auth header, then `response.blob()` → `URL.createObjectURL(blob)`, sets status `'ready'`
- On failure: sets status `'error'`, `blobUrl: null`
- Calls are parallel (no sequential awaiting)
- On unmount: revokes all blob URLs via `URL.revokeObjectURL` to prevent memory leaks
- Re-runs when `messages` array length changes (new messages arriving via realtime)

**State management:** Internal `useRef<Map>` + `useState` counter to force re-renders on map updates (avoids stale closure issues with Map).

---

### 3. Frontend — `AudioPlayer` Component

**File:** `src/components/chat/AudioPlayer.tsx`

**Props:**
```ts
interface AudioPlayerProps {
  blobUrl: string | null
  isLoading: boolean
  fromMe: boolean
}
```

**Layout:**
```
[ ▶/⏸ ]  [————progress————]  0:12 / 0:47  [ 1.5x ]
```

**States:**
- `isLoading = true` → play button shows `Loader2` spinner; range input disabled
- `blobUrl = null && !isLoading` → play button shows error icon; label "Áudio indisponível"
- `ready` → fully interactive

**Controls:**

| Control | Implementation |
|---|---|
| Play / Pause | `useRef<HTMLAudioElement>` + `audio.play()` / `audio.pause()` |
| Progress bar | `<input type="range" min=0 max=duration step=0.1>` synced with `timeupdate` event; `onChange` calls `audio.currentTime = value` |
| Time display | `currentTime` / `duration` formatted as `m:ss` |
| Speed button | Cycles `1 → 1.25 → 1.5 → 2 → 1`; applies via `audio.playbackRate` |

**Hidden `<audio>` element:** `ref={audioRef}`, `src={blobUrl}`, `onEnded` resets play state.

**Styling:**
- Width: matches text bubble max-width (`max-w-[85%] sm:max-w-[70%]`)
- `fromMe = true` → `bg-primary text-primary-foreground`; range track tinted white/50
- `fromMe = false` → `bg-card border border-border/60 text-foreground`; range track tinted primary/40
- Minimum width: `240px` to prevent the layout from collapsing on short audios

---

### 4. Integration in `Chat.tsx`

**Hook usage** (near top of component, after `messages` state):
```tsx
const audioMap = useAudioPreloader(messages)
```

**Message render bifurcation** (replaces line 459):
```tsx
const isAudio = msg.type === 'audioMessage' || msg.type === 'pttMessage'

{isAudio ? (
  <AudioPlayer
    blobUrl={audioMap.get(msg.message_id)?.blobUrl ?? null}
    isLoading={(audioMap.get(msg.message_id)?.status ?? 'loading') === 'loading'}
    fromMe={msg.from_me}
  />
) : (
  <span className="whitespace-pre-wrap break-words">{msg.text}</span>
)}
```

The `text` field value (`'[Media/Unsupported]'`) is intentionally ignored for audio messages — no DB schema change required.

---

## Data Flow (end-to-end)

```
WhatsApp user sends voice note
  → Evolution API webhook fires → evolution-webhook stores message (type='pttMessage', text='[Media/Unsupported]', raw=full payload)
  → Supabase realtime pushes new message to Chat.tsx
  → useAudioPreloader detects new audio message
  → calls evolution-get-media → Evolution API /download-media → base64 response
  → Blob URL stored in memory map
  → AudioPlayer switches from spinner to ready state
```

---

## Error Handling

| Scenario | Behavior |
|---|---|
| Evolution API returns error on download | `status = 'error'`, player shows "Áudio indisponível" |
| Network timeout | Same as above |
| User navigates away before preload completes | `useEffect` cleanup cancels pending state updates; blob URLs revoked |
| Audio codec unsupported by browser | Browser's native error event → player shows error state |

---

## Out of Scope

- Uploading audio (sending voice notes from the UI)
- Waveform visualization (static progress bar only, no real waveform rendering)
- Persisting audio to Supabase Storage
- Group/broadcast audio messages (already filtered out by webhook)
