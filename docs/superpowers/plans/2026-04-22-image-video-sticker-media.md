# Image / Video / Sticker Media Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `imageMessage`, `videoMessage`, and `stickerMessage` in the chat view — showing instant thumbnails from the raw payload, loading full media on demand (images via IntersectionObserver, video on click, stickers eagerly), with an image lightbox.

**Architecture:** A new `useMediaLoader` hook manages on-demand fetching via the existing `evolution-get-media` edge function, keeping a concurrent queue (max 3 parallel fetches) and an in-memory blob URL cache. Four new components (`ImageMessage`, `VideoMessage`, `StickerMessage`, `MediaLightbox`) consume the hook. No storage, no pre-fetch — lazy by default, eager only for stickers.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, shadcn/ui, IntersectionObserver API, Blob URLs.

---

## File Map

| Action | File                                              | Responsibility                                                      |
| ------ | ------------------------------------------------- | ------------------------------------------------------------------- |
| Create | `src/hooks/use-media-loader.ts`                   | On-demand fetch hook, concurrent queue, blob cache                  |
| Create | `src/components/chat/ImageMessage.tsx`            | Thumbnail → full image, IntersectionObserver trigger, lightbox open |
| Create | `src/components/chat/VideoMessage.tsx`            | Thumbnail + play overlay, fetch on click, `<video>` player          |
| Create | `src/components/chat/StickerMessage.tsx`          | Eager fetch on mount, renders webp sticker                          |
| Create | `src/components/chat/MediaLightbox.tsx`           | Full-screen image overlay                                           |
| Modify | `src/lib/message-types.ts`                        | Add image/video/sticker to `HANDLED_TYPES`                          |
| Modify | `supabase/functions/evolution-get-media/index.ts` | Remove hardcoded `audio/ogg` fallback mimetype                      |
| Modify | `src/pages/Chat.tsx`                              | Wire hook + new components, add lightbox state                      |

---

## Task 1: `useMediaLoader` hook

**Files:**

- Create: `src/hooks/use-media-loader.ts`

The hook exposes `mediaMap` (read-only) and `request(messageId, contactId)`. Internally it maintains a concurrent queue with `MAX_CONCURRENT = 3`. Adding to the queue sets status to `'loading'` immediately for optimistic UI. Cleanup revokes all blob URLs on unmount.

- [ ] **Step 1: Create the hook**

```ts
// src/hooks/use-media-loader.ts
import { useEffect, useRef, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase/client'

export type MediaStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface MediaEntry {
  status: MediaStatus
  blobUrl: string | null
}

const MAX_CONCURRENT = 3

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string

interface QueueItem {
  messageId: string
  contactId: string
}

export function useMediaLoader(): {
  mediaMap: Map<string, MediaEntry>
  request: (messageId: string, contactId: string) => void
} {
  const mapRef = useRef<Map<string, MediaEntry>>(new Map())
  const activeRef = useRef(0)
  const queueRef = useRef<QueueItem[]>([])
  const [, forceUpdate] = useState(0)

  const processQueue = useCallback(async () => {
    while (activeRef.current < MAX_CONCURRENT && queueRef.current.length > 0) {
      const item = queueRef.current.shift()!
      activeRef.current++
      ;(async () => {
        try {
          const {
            data: { session },
          } = await supabase.auth.getSession()
          const token = session?.access_token
          if (!token) throw new Error('no token')

          const res = await fetch(`${supabaseUrl}/functions/v1/evolution-get-media`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              apikey: supabaseAnonKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ messageId: item.messageId, contactId: item.contactId }),
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const blob = await res.blob()
          const blobUrl = URL.createObjectURL(blob)
          mapRef.current.set(item.messageId, { status: 'ready', blobUrl })
        } catch {
          mapRef.current.set(item.messageId, { status: 'error', blobUrl: null })
        } finally {
          activeRef.current--
          forceUpdate((n) => n + 1)
          processQueue()
        }
      })()
    }
  }, [])

  const request = useCallback(
    (messageId: string, contactId: string) => {
      const current = mapRef.current.get(messageId)
      if (current && current.status !== 'idle') return
      mapRef.current.set(messageId, { status: 'loading', blobUrl: null })
      queueRef.current.push({ messageId, contactId })
      forceUpdate((n) => n + 1)
      processQueue()
    },
    [processQueue],
  )

  useEffect(() => {
    return () => {
      for (const entry of mapRef.current.values()) {
        if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl)
      }
      mapRef.current.clear()
      queueRef.current = []
    }
  }, [])

  return { mediaMap: mapRef.current, request }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/hooks/use-media-loader.ts
git commit -m "feat: add useMediaLoader hook with concurrent queue and blob cache"
```

---

## Task 2: `MediaLightbox` component

**Files:**

- Create: `src/components/chat/MediaLightbox.tsx`

Full-screen overlay. Click backdrop or X closes. `e.stopPropagation()` on the image prevents accidental close.

- [ ] **Step 1: Create the component**

```tsx
// src/components/chat/MediaLightbox.tsx
import { useEffect } from 'react'
import { X } from 'lucide-react'

interface MediaLightboxProps {
  blobUrl: string
  caption?: string | null
  onClose: () => void
}

export function MediaLightbox({ blobUrl, caption, onClose }: MediaLightboxProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 text-white/80 hover:text-white transition-colors"
        aria-label="Close"
      >
        <X className="h-6 w-6" />
      </button>
      <img
        src={blobUrl}
        className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
      {caption && (
        <p className="absolute bottom-6 left-0 right-0 text-center text-white text-sm px-8 drop-shadow">
          {caption}
        </p>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/chat/MediaLightbox.tsx
git commit -m "feat: add MediaLightbox full-screen image overlay"
```

---

## Task 3: `ImageMessage` component

**Files:**

- Create: `src/components/chat/ImageMessage.tsx`

Shows `jpegThumbnail` (base64 from `raw`) immediately with a blur effect. `IntersectionObserver` fires `request()` when the bubble enters viewport (200px margin). Transitions to full image when ready. Clicking full image opens lightbox.

- [ ] **Step 1: Create the component**

```tsx
// src/components/chat/ImageMessage.tsx
import { useRef, useEffect } from 'react'
import { ImageIcon, AlertCircle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MediaEntry } from '@/hooks/use-media-loader'
import { WhatsAppMessage } from '@/lib/types'

interface ImageMessageProps {
  msg: WhatsAppMessage
  entry: MediaEntry | undefined
  request: (messageId: string, contactId: string) => void
  fromMe: boolean
  onOpenLightbox: (blobUrl: string, caption: string | null) => void
}

function getThumbnailDataUrl(raw: any): string | null {
  const b64 = raw?.message?.imageMessage?.jpegThumbnail
  if (!b64) return null
  return `data:image/jpeg;base64,${b64}`
}

function getCaption(raw: any): string | null {
  return raw?.message?.imageMessage?.caption ?? null
}

export function ImageMessage({ msg, entry, request, fromMe, onOpenLightbox }: ImageMessageProps) {
  const ref = useRef<HTMLDivElement>(null)
  const requested = useRef(false)

  const thumbnail = getThumbnailDataUrl(msg.raw)
  const caption = getCaption(msg.raw)
  const status = entry?.status ?? 'idle'
  const blobUrl = entry?.blobUrl ?? null

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !requested.current) {
          requested.current = true
          request(msg.message_id, msg.contact_id)
        }
      },
      { rootMargin: '200px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [msg.message_id, msg.contact_id, request])

  const handleClick = () => {
    if (blobUrl) onOpenLightbox(blobUrl, caption)
  }

  return (
    <div ref={ref} className="flex flex-col gap-1.5 max-w-[240px]">
      <div
        className={cn(
          'relative w-full rounded-xl overflow-hidden bg-muted',
          'aspect-[4/3]',
          blobUrl && 'cursor-pointer',
        )}
        onClick={handleClick}
      >
        {/* Thumbnail always shown as background */}
        {thumbnail && (
          <img
            src={thumbnail}
            className={cn(
              'absolute inset-0 w-full h-full object-cover transition-all duration-300',
              status !== 'ready' ? 'blur-md scale-105' : 'blur-0 scale-100',
            )}
          />
        )}

        {/* Full image on top when ready */}
        {blobUrl && <img src={blobUrl} className="absolute inset-0 w-full h-full object-cover" />}

        {/* Loading overlay */}
        {status === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/20">
            <Loader2 className="h-6 w-6 text-white animate-spin" />
          </div>
        )}

        {/* Error state (no thumbnail either) */}
        {status === 'error' && !thumbnail && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-muted-foreground">
            <AlertCircle className="h-5 w-5 opacity-50" />
            <ImageIcon className="h-4 w-4 opacity-30" />
          </div>
        )}

        {/* Placeholder when no thumbnail and not yet started */}
        {status === 'idle' && !thumbnail && (
          <div className="absolute inset-0 flex items-center justify-center bg-muted">
            <ImageIcon className="h-6 w-6 text-muted-foreground opacity-40" />
          </div>
        )}
      </div>

      {caption && (
        <span
          className={cn(
            'text-[13px] leading-snug px-0.5',
            fromMe ? 'text-primary-foreground/90' : 'text-foreground/80',
          )}
        >
          {caption}
        </span>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/chat/ImageMessage.tsx
git commit -m "feat: add ImageMessage with IntersectionObserver lazy load and thumbnail"
```

---

## Task 4: `VideoMessage` component

**Files:**

- Create: `src/components/chat/VideoMessage.tsx`

Shows `jpegThumbnail` + play-button overlay. Clicking the play button triggers `request()`. Once `blobUrl` is ready, renders `<video controls autoPlay>`.

- [ ] **Step 1: Create the component**

```tsx
// src/components/chat/VideoMessage.tsx
import { PlayCircle, Loader2, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MediaEntry } from '@/hooks/use-media-loader'
import { WhatsAppMessage } from '@/lib/types'

interface VideoMessageProps {
  msg: WhatsAppMessage
  entry: MediaEntry | undefined
  request: (messageId: string, contactId: string) => void
  fromMe: boolean
}

function getThumbnailDataUrl(raw: any): string | null {
  const b64 = raw?.message?.videoMessage?.jpegThumbnail
  if (!b64) return null
  return `data:image/jpeg;base64,${b64}`
}

function getCaption(raw: any): string | null {
  return raw?.message?.videoMessage?.caption ?? null
}

export function VideoMessage({ msg, entry, request, fromMe }: VideoMessageProps) {
  const thumbnail = getThumbnailDataUrl(msg.raw)
  const caption = getCaption(msg.raw)
  const status = entry?.status ?? 'idle'
  const blobUrl = entry?.blobUrl ?? null

  const handlePlayClick = () => {
    if (status === 'idle') request(msg.message_id, msg.contact_id)
  }

  return (
    <div className="flex flex-col gap-1.5 max-w-[240px]">
      <div className="relative w-full rounded-xl overflow-hidden bg-muted aspect-[4/3]">
        {/* Thumbnail */}
        {thumbnail && !blobUrl && (
          <img src={thumbnail} className="absolute inset-0 w-full h-full object-cover" />
        )}

        {/* Video player once loaded */}
        {blobUrl && (
          <video
            src={blobUrl}
            controls
            autoPlay
            className="absolute inset-0 w-full h-full object-cover"
          />
        )}

        {/* Overlay: play button or loading */}
        {!blobUrl && (
          <div
            className={cn(
              'absolute inset-0 flex items-center justify-center',
              'bg-black/30',
              status === 'idle' && 'cursor-pointer hover:bg-black/40 transition-colors',
            )}
            onClick={handlePlayClick}
          >
            {status === 'loading' ? (
              <Loader2 className="h-10 w-10 text-white animate-spin" />
            ) : status === 'error' ? (
              <AlertCircle className="h-8 w-8 text-white/70" />
            ) : (
              <PlayCircle className="h-12 w-12 text-white drop-shadow-lg" />
            )}
          </div>
        )}

        {/* Empty state */}
        {!thumbnail && !blobUrl && status === 'idle' && (
          <div className="absolute inset-0 bg-muted" />
        )}
      </div>

      {caption && (
        <span
          className={cn(
            'text-[13px] leading-snug px-0.5',
            fromMe ? 'text-primary-foreground/90' : 'text-foreground/80',
          )}
        >
          {caption}
        </span>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/chat/VideoMessage.tsx
git commit -m "feat: add VideoMessage with click-to-load and thumbnail poster"
```

---

## Task 5: `StickerMessage` component

**Files:**

- Create: `src/components/chat/StickerMessage.tsx`

Stickers are small (~50–150 KB webp). Eager-loads on mount via `request()`. Shows blurred `jpegThumbnail` until ready, then renders transparent webp at 160×160px (WhatsApp Web sizing). No bubble background, no border — stickers float freely.

- [ ] **Step 1: Create the component**

```tsx
// src/components/chat/StickerMessage.tsx
import { useEffect } from 'react'
import { Smile, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MediaEntry } from '@/hooks/use-media-loader'
import { WhatsAppMessage } from '@/lib/types'

interface StickerMessageProps {
  msg: WhatsAppMessage
  entry: MediaEntry | undefined
  request: (messageId: string, contactId: string) => void
}

function getThumbnailDataUrl(raw: any): string | null {
  const b64 = raw?.message?.stickerMessage?.jpegThumbnail
  if (!b64) return null
  return `data:image/jpeg;base64,${b64}`
}

export function StickerMessage({ msg, entry, request }: StickerMessageProps) {
  const thumbnail = getThumbnailDataUrl(msg.raw)
  const status = entry?.status ?? 'idle'
  const blobUrl = entry?.blobUrl ?? null

  useEffect(() => {
    request(msg.message_id, msg.contact_id)
  }, [msg.message_id, msg.contact_id, request])

  return (
    <div className="relative w-[160px] h-[160px]">
      {/* Blurred thumbnail until full loads */}
      {thumbnail && !blobUrl && (
        <img
          src={thumbnail}
          className="absolute inset-0 w-full h-full object-contain blur-sm scale-105"
        />
      )}

      {/* Full webp sticker */}
      {blobUrl && <img src={blobUrl} className="absolute inset-0 w-full h-full object-contain" />}

      {/* Loading spinner (only when no thumbnail available) */}
      {status === 'loading' && !thumbnail && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="h-8 w-8 text-muted-foreground animate-spin" />
        </div>
      )}

      {/* Error fallback */}
      {status === 'error' && !thumbnail && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-muted-foreground">
          <Smile className="h-8 w-8 opacity-30" />
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/chat/StickerMessage.tsx
git commit -m "feat: add StickerMessage with eager load and thumbnail placeholder"
```

---

## Task 6: Update `message-types.ts`

**Files:**

- Modify: `src/lib/message-types.ts`

Add `imageMessage`, `videoMessage`, `stickerMessage` to `HANDLED_TYPES` so they don't fall through to `<UnsupportedMessage>`.

- [ ] **Step 1: Edit the file**

Replace the `HANDLED_TYPES` set:

```ts
// src/lib/message-types.ts  (only this set changes)
const HANDLED_TYPES = new Set([
  'text',
  'conversation',
  'extendedTextMessage',
  'audioMessage',
  'pttMessage',
  'reactionMessage',
  'protocolMessage',
  'imageMessage',
  'videoMessage',
  'stickerMessage',
])
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/message-types.ts
git commit -m "feat: mark image/video/sticker as handled message types"
```

---

## Task 7: Fix `evolution-get-media` mimetype fallback

**Files:**

- Modify: `supabase/functions/evolution-get-media/index.ts:106`

Remove the hardcoded `'audio/ogg'` fallback so image/video responses get the correct `Content-Type` from the Evolution API.

- [ ] **Step 1: Edit the edge function**

Find the response at the end of the function (around line 104) and change:

```ts
// BEFORE
headers: {
  ...corsHeaders,
  'Content-Type': mimetype || 'audio/ogg',
  'Cache-Control': 'private, max-age=3600',
},
```

```ts
// AFTER
headers: {
  ...corsHeaders,
  'Content-Type': mimetype || 'application/octet-stream',
  'Cache-Control': 'private, max-age=3600',
},
```

- [ ] **Step 2: Deploy the edge function**

```bash
supabase functions deploy evolution-get-media --no-verify-jwt
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/evolution-get-media/index.ts
git commit -m "fix: use application/octet-stream as fallback mimetype in evolution-get-media"
```

---

## Task 8: Wire everything into `Chat.tsx`

**Files:**

- Modify: `src/pages/Chat.tsx`

Add `useMediaLoader`, lightbox state, and update the message render branch to route image/video/sticker to their new components. The lightbox renders at root level of the page (outside the message list).

- [ ] **Step 1: Add imports** (top of file, after existing imports)

```ts
import { useMediaLoader } from '@/hooks/use-media-loader'
import { ImageMessage } from '@/components/chat/ImageMessage'
import { VideoMessage } from '@/components/chat/VideoMessage'
import { StickerMessage } from '@/components/chat/StickerMessage'
import { MediaLightbox } from '@/components/chat/MediaLightbox'
```

- [ ] **Step 2: Add hook call and lightbox state** (inside `Chat()`, after the `audioMap` line at line 55)

```ts
const { mediaMap, request } = useMediaLoader()
const [lightbox, setLightbox] = useState<{ blobUrl: string; caption: string | null } | null>(null)
```

- [ ] **Step 3: Replace the message render branch**

Find the block starting at `{msg.type === 'audioMessage' || msg.type === 'pttMessage' ?` (around line 467) and replace the entire conditional:

```tsx
{
  msg.type === 'audioMessage' || msg.type === 'pttMessage' ? (
    <AudioPlayer
      blobUrl={audioMap.get(msg.message_id)?.blobUrl ?? null}
      isLoading={(audioMap.get(msg.message_id)?.status ?? 'loading') === 'loading'}
      fromMe={msg.from_me}
    />
  ) : msg.type === 'imageMessage' ? (
    <ImageMessage
      msg={msg}
      entry={mediaMap.get(msg.message_id)}
      request={request}
      fromMe={msg.from_me}
      onOpenLightbox={(blobUrl, caption) => setLightbox({ blobUrl, caption })}
    />
  ) : msg.type === 'videoMessage' ? (
    <VideoMessage
      msg={msg}
      entry={mediaMap.get(msg.message_id)}
      request={request}
      fromMe={msg.from_me}
    />
  ) : msg.type === 'stickerMessage' ? (
    <StickerMessage msg={msg} entry={mediaMap.get(msg.message_id)} request={request} />
  ) : msg.type === 'reactionMessage' ? (
    <ReactionMessage raw={msg.raw} />
  ) : msg.type === 'protocolMessage' ? (
    <ProtocolMessage raw={msg.raw} />
  ) : isUnsupportedMessageType(msg.type) ? (
    <UnsupportedMessage type={msg.type!} />
  ) : hasUnrenderableText(msg.text) ? (
    <UnsupportedMessage type="unknown" />
  ) : (
    <span className="whitespace-pre-wrap break-words">{msg.text}</span>
  )
}
```

- [ ] **Step 4: Add lightbox and sticker bubble overrides**

The existing bubble wrapper applies `px-4 py-2.5` padding and a rounded background to every message. For stickers, this looks wrong — stickers should float without a bubble. The cleanest approach is to skip the bubble wrapper for stickers.

Find the bubble `<div>` (around line 459, the one with `relative px-4 sm:px-5 py-2.5`). It needs to conditionally not apply styles for stickers.

Change the className on that `<div>`:

```tsx
<div
  className={cn(
    'relative flex flex-col shadow-sm text-[14px] sm:text-[15px] leading-relaxed font-medium',
    msg.type !== 'stickerMessage' && 'px-4 sm:px-5 py-2.5 sm:py-3 rounded-[1.25rem] sm:rounded-[1.5rem]',
    msg.type !== 'stickerMessage' && (
      isMe
        ? 'bg-primary text-primary-foreground rounded-br-sm'
        : 'bg-card border border-border/60 text-foreground rounded-bl-sm'
    ),
  )}
>
```

- [ ] **Step 5: Render lightbox at end of page JSX**

Find the closing `</div>` of the root return (after the message list and send bar). Add lightbox just before it:

```tsx
{
  lightbox && (
    <MediaLightbox
      blobUrl={lightbox.blobUrl}
      caption={lightbox.caption}
      onClose={() => setLightbox(null)}
    />
  )
}
```

- [ ] **Step 6: Commit**

```bash
git add src/pages/Chat.tsx
git commit -m "feat: wire image/video/sticker components and lightbox into Chat"
```

---

## Self-Review

**Spec coverage:**

- ✅ No storage — blobs live only in memory, fetched from Evolution via edge function
- ✅ Thumbnail from payload — `jpegThumbnail` base64 used immediately in all 3 types
- ✅ Images load on IntersectionObserver — `ImageMessage` uses 200px margin observer
- ✅ Video load on click — `VideoMessage` gates fetch behind play button
- ✅ Stickers eager-load — `StickerMessage` calls `request()` on mount
- ✅ Lightbox — `MediaLightbox`, opens on image click, Escape closes
- ✅ Concurrency limit — `MAX_CONCURRENT = 3` in `useMediaLoader`
- ✅ Cleanup — blob URLs revoked on hook unmount
- ✅ Edge function mimetype fix — `audio/ogg` → `application/octet-stream`
- ✅ No pre-fetch — no eager batch fetching on chat open

**Type consistency:**

- `MediaEntry { status: MediaStatus; blobUrl: string | null }` — defined in `use-media-loader.ts`, imported by all 3 components ✅
- `request: (messageId: string, contactId: string) => void` — signature consistent across hook definition and all component props ✅
- `onOpenLightbox: (blobUrl: string, caption: string | null) => void` — matches `setLightbox` call in Chat.tsx ✅

**Placeholder scan:** No TBDs, no "similar to Task N", all code blocks complete. ✅
