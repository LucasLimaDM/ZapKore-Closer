# Audio Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receive `pttMessage`/`audioMessage` from Evolution API and display a WhatsApp-style audio player with preloading in the chat UI.

**Architecture:** A new edge function `evolution-get-media` proxies audio binary from the Evolution API on demand. The frontend hook `useAudioPreloader` eagerly fetches all audio blobs when a chat opens. The `AudioPlayer` component renders play/pause, seekable progress bar, duration, and playback speed (1x→1.25x→1.5x→2x).

**Tech Stack:** Deno edge function (same pattern as `evolution-send-message`), React 19, Tailwind CSS, native `<audio>` API, `URL.createObjectURL`, raw `fetch` for binary response.

**Note:** No test suite exists in this project — skip TDD steps. Verification is manual via the running dev server.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `supabase/functions/evolution-get-media/index.ts` | Proxy: auth → DB lookup → Evolution API download → binary response |
| Create | `supabase/functions/evolution-get-media/deno.json` | Deno imports config (copy of other functions) |
| Create | `src/hooks/use-audio-preloader.ts` | Eager parallel preload of audio blobs on chat open |
| Create | `src/components/chat/AudioPlayer.tsx` | Audio player UI: play/pause, seek, speed |
| Modify | `src/pages/Chat.tsx` | Wire hook + render AudioPlayer for audio message types |

---

## Task 1: Edge Function — `evolution-get-media`

**Files:**
- Create: `supabase/functions/evolution-get-media/deno.json`
- Create: `supabase/functions/evolution-get-media/index.ts`

- [ ] **Step 1: Create `deno.json`**

```json
{
  "imports": {
    "jsr:@supabase/functions-js": "jsr:@supabase/functions-js@^2.4.1",
    "jsr:@supabase/supabase-js": "jsr:@supabase/supabase-js@^2.45.4"
  }
}
```

- [ ] **Step 2: Create `index.ts`**

```ts
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing Authorization header')

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser()
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { messageId, contactId } = await req.json()
    if (!messageId || !contactId) {
      return new Response(JSON.stringify({ error: 'Missing messageId or contactId' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Fetch message — also validates ownership (RLS enforces user_id)
    const { data: message, error: msgError } = await supabaseClient
      .from('whatsapp_messages')
      .select('raw, contact_id')
      .eq('message_id', messageId)
      .eq('contact_id', contactId)
      .single()

    if (msgError || !message) {
      return new Response(JSON.stringify({ error: 'Message not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Fetch integration for Evolution API credentials
    const { data: integration } = await supabaseClient
      .from('user_integrations')
      .select('instance_name, evolution_api_url, evolution_api_key')
      .eq('user_id', user.id)
      .single()

    if (!integration) {
      return new Response(JSON.stringify({ error: 'Integration not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const evoUrlRaw = integration.evolution_api_url || Deno.env.get('EVOLUTION_API_URL')
    const evoUrl = evoUrlRaw ? evoUrlRaw.replace(/\/$/, '') : ''
    const evoKey = integration.evolution_api_key || Deno.env.get('EVOLUTION_API_KEY')

    const evoRes = await fetch(
      `${evoUrl}/message/download-media/${integration.instance_name}`,
      {
        method: 'POST',
        headers: { apikey: evoKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message.raw }),
      },
    )

    if (!evoRes.ok) {
      const errText = await evoRes.text()
      console.error('[evolution-get-media] Evolution API error:', errText)
      return new Response(JSON.stringify({ error: 'Media download failed', detail: errText }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { base64, mimetype } = await evoRes.json()

    if (!base64) {
      return new Response(JSON.stringify({ error: 'No base64 data returned' }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Decode base64 → binary
    const binaryStr = atob(base64)
    const bytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i)
    }

    return new Response(bytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': mimetype || 'audio/ogg',
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch (error: any) {
    console.error('[evolution-get-media] Error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
```

- [ ] **Step 3: Deploy the edge function**

```bash
supabase functions deploy evolution-get-media --no-verify-jwt
```

Expected: `Deployed evolution-get-media`

- [ ] **Step 4: Smoke-test via curl**

Find a `message_id` and `contact_id` from `whatsapp_messages` where `type = 'pttMessage'` using the Supabase dashboard. Then (replace `<TOKEN>`, `<PROJECT_URL>`, `<MSG_ID>`, `<CONTACT_ID>`):

```bash
curl -X POST https://<PROJECT_URL>/functions/v1/evolution-get-media \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"messageId":"<MSG_ID>","contactId":"<CONTACT_ID>"}' \
  --output test-audio.ogg
```

Expected: `test-audio.ogg` file is created and is playable.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/evolution-get-media/
git commit -m "feat: add evolution-get-media edge function for audio proxy"
```

---

## Task 2: Frontend Hook — `useAudioPreloader`

**Files:**
- Create: `src/hooks/use-audio-preloader.ts`

- [ ] **Step 1: Create the hook**

```ts
import { useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { WhatsAppMessage } from '@/lib/types'

export type AudioStatus = 'loading' | 'ready' | 'error'

export interface AudioEntry {
  status: AudioStatus
  blobUrl: string | null
}

const AUDIO_TYPES = new Set(['audioMessage', 'pttMessage'])

export function useAudioPreloader(messages: WhatsAppMessage[]): Map<string, AudioEntry> {
  const mapRef = useRef<Map<string, AudioEntry>>(new Map())
  const [, forceUpdate] = useState(0)

  useEffect(() => {
    const audioMessages = messages.filter(
      (m) => m.type && AUDIO_TYPES.has(m.type) && !mapRef.current.has(m.message_id),
    )

    if (audioMessages.length === 0) return

    // Mark all as loading immediately so UI shows spinners
    for (const msg of audioMessages) {
      mapRef.current.set(msg.message_id, { status: 'loading', blobUrl: null })
    }
    forceUpdate((n) => n + 1)

    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
    const supabaseAnonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string

    let cancelled = false

    const fetchAll = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token || cancelled) return

      await Promise.allSettled(
        audioMessages.map(async (msg) => {
          try {
            const res = await fetch(
              `${supabaseUrl}/functions/v1/evolution-get-media`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${token}`,
                  apikey: supabaseAnonKey,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  messageId: msg.message_id,
                  contactId: msg.contact_id,
                }),
              },
            )

            if (!res.ok) throw new Error(`HTTP ${res.status}`)

            const blob = await res.blob()
            const blobUrl = URL.createObjectURL(blob)

            if (!cancelled) {
              mapRef.current.set(msg.message_id, { status: 'ready', blobUrl })
              forceUpdate((n) => n + 1)
            } else {
              URL.revokeObjectURL(blobUrl)
            }
          } catch {
            if (!cancelled) {
              mapRef.current.set(msg.message_id, { status: 'error', blobUrl: null })
              forceUpdate((n) => n + 1)
            }
          }
        }),
      )
    }

    fetchAll()

    return () => {
      cancelled = true
    }
  }, [messages.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup all blob URLs on full unmount
  useEffect(() => {
    return () => {
      for (const entry of mapRef.current.values()) {
        if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl)
      }
      mapRef.current.clear()
    }
  }, [])

  return mapRef.current
}
```

- [ ] **Step 2: Commit**

```bash
git add src/hooks/use-audio-preloader.ts
git commit -m "feat: add useAudioPreloader hook for eager audio blob preloading"
```

---

## Task 3: Frontend Component — `AudioPlayer`

**Files:**
- Create: `src/components/chat/AudioPlayer.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useRef, useState, useEffect } from 'react'
import { Play, Pause, Loader2, MicOff } from 'lucide-react'
import { cn } from '@/lib/utils'

interface AudioPlayerProps {
  blobUrl: string | null
  isLoading: boolean
  fromMe: boolean
}

const SPEED_CYCLE = [1, 1.25, 1.5, 2] as const
type PlaybackRate = (typeof SPEED_CYCLE)[number]

function formatTime(seconds: number): string {
  if (!isFinite(seconds)) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function AudioPlayer({ blobUrl, isLoading, fromMe }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [speed, setSpeed] = useState<PlaybackRate>(1)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const onTimeUpdate = () => setCurrentTime(audio.currentTime)
    const onDurationChange = () => setDuration(audio.duration)
    const onEnded = () => setIsPlaying(false)
    const onLoadedMetadata = () => setDuration(audio.duration)

    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('durationchange', onDurationChange)
    audio.addEventListener('loadedmetadata', onLoadedMetadata)
    audio.addEventListener('ended', onEnded)

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('durationchange', onDurationChange)
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('ended', onEnded)
    }
  }, [blobUrl])

  const togglePlay = () => {
    const audio = audioRef.current
    if (!audio || !blobUrl) return
    if (isPlaying) {
      audio.pause()
      setIsPlaying(false)
    } else {
      audio.play()
      setIsPlaying(true)
    }
  }

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current
    if (!audio) return
    const value = parseFloat(e.target.value)
    audio.currentTime = value
    setCurrentTime(value)
  }

  const cycleSpeed = () => {
    const audio = audioRef.current
    const idx = SPEED_CYCLE.indexOf(speed)
    const next = SPEED_CYCLE[(idx + 1) % SPEED_CYCLE.length]
    setSpeed(next)
    if (audio) audio.playbackRate = next
  }

  const isReady = !isLoading && !!blobUrl
  const isError = !isLoading && !blobUrl

  return (
    <div
      className={cn(
        'flex items-center gap-2.5 px-3 py-2.5 rounded-[1.25rem] sm:rounded-[1.5rem] shadow-sm',
        'min-w-[240px] max-w-full',
        fromMe
          ? 'bg-primary text-primary-foreground rounded-br-sm'
          : 'bg-card border border-border/60 text-foreground rounded-bl-sm',
      )}
    >
      {/* Hidden audio element */}
      {blobUrl && <audio ref={audioRef} src={blobUrl} preload="metadata" />}

      {/* Play / Pause / Loading / Error button */}
      <button
        onClick={togglePlay}
        disabled={!isReady}
        className={cn(
          'shrink-0 flex items-center justify-center h-9 w-9 rounded-full transition-colors',
          fromMe
            ? 'bg-white/20 hover:bg-white/30 disabled:opacity-50'
            : 'bg-primary/10 hover:bg-primary/20 disabled:opacity-50',
        )}
      >
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : isError ? (
          <MicOff className="h-4 w-4 opacity-60" />
        ) : isPlaying ? (
          <Pause className="h-4 w-4" />
        ) : (
          <Play className="h-4 w-4 ml-0.5" />
        )}
      </button>

      {/* Progress + time */}
      <div className="flex flex-col gap-1 flex-1 min-w-0">
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={currentTime}
          onChange={handleSeek}
          disabled={!isReady}
          className={cn(
            'w-full h-1 rounded-full appearance-none cursor-pointer disabled:cursor-not-allowed',
            'bg-current opacity-30',
            '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3',
            '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-current [&::-webkit-slider-thumb]:opacity-100',
          )}
        />
        <div className="flex justify-between text-[10px] font-bold opacity-60 tabular-nums">
          <span>{formatTime(currentTime)}</span>
          <span>{isLoading ? '...' : formatTime(duration)}</span>
        </div>
      </div>

      {/* Speed button */}
      <button
        onClick={cycleSpeed}
        disabled={!isReady}
        className={cn(
          'shrink-0 text-[10px] font-extrabold tabular-nums w-8 text-center',
          'opacity-70 hover:opacity-100 transition-opacity disabled:opacity-30',
        )}
      >
        {speed === 1 ? '1x' : `${speed}x`}
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/chat/AudioPlayer.tsx
git commit -m "feat: add AudioPlayer component with seek, speed control, and loading states"
```

---

## Task 4: Integrate into `Chat.tsx`

**Files:**
- Modify: `src/pages/Chat.tsx`

- [ ] **Step 1: Add imports at the top of `Chat.tsx`**

Add after the existing imports (after line `import { cn } from '@/lib/utils'`):

```tsx
import { useAudioPreloader } from '@/hooks/use-audio-preloader'
import { AudioPlayer } from '@/components/chat/AudioPlayer'
```

- [ ] **Step 2: Wire the hook**

Inside the `Chat` component function body, after the existing state declarations (after `const [isLoadingMore, setIsLoadingMore] = useState(false)`), add:

```tsx
const audioMap = useAudioPreloader(messages)
```

- [ ] **Step 3: Replace the message text render**

Find this line in the JSX (currently line 459):

```tsx
<span className="whitespace-pre-wrap break-words">{msg.text}</span>
```

Replace with:

```tsx
{msg.type === 'audioMessage' || msg.type === 'pttMessage' ? (
  <AudioPlayer
    blobUrl={audioMap.get(msg.message_id)?.blobUrl ?? null}
    isLoading={(audioMap.get(msg.message_id)?.status ?? 'loading') === 'loading'}
    fromMe={msg.from_me}
  />
) : (
  <span className="whitespace-pre-wrap break-words">{msg.text}</span>
)}
```

- [ ] **Step 4: Verify it builds without errors**

```bash
pnpm build
```

Expected: build completes with no TypeScript errors.

- [ ] **Step 5: Start dev server and manually test**

```bash
pnpm dev
```

Open `http://localhost:8080`, navigate to the chat with Lucas Dias (+5511936207809), confirm:
1. The previously unsupported audio message now shows the player UI with a spinner
2. After 1–2 seconds the spinner disappears and a play button appears
3. Clicking play plays the audio
4. The progress bar moves and is seekable
5. Clicking the speed button cycles 1x → 1.25x → 1.5x → 2x → 1x
6. Text messages in the same chat still render normally

- [ ] **Step 6: Commit**

```bash
git add src/pages/Chat.tsx
git commit -m "feat: integrate AudioPlayer and useAudioPreloader into Chat"
```

---

## Self-Review Checklist

- **Spec coverage:**
  - ✅ `evolution-get-media` edge function — Task 1
  - ✅ Eager preloading on chat open — Task 2
  - ✅ Loading spinner state — Task 2 + AudioPlayer `isLoading` prop
  - ✅ Play/pause — AudioPlayer
  - ✅ Seekable progress bar — AudioPlayer
  - ✅ Playback speed 1x/1.25x/1.5x/2x — AudioPlayer `cycleSpeed`
  - ✅ Supports both `pttMessage` and `audioMessage` — hook filter + Chat.tsx render check
  - ✅ `fromMe` color adaptation — AudioPlayer prop
  - ✅ Blob URL cleanup on unmount — hook cleanup effect
  - ✅ Error state ("Áudio indisponível") — AudioPlayer `isError` branch
  - ✅ No schema changes — text field remains `[Media/Unsupported]`, ignored by UI

- **Placeholder scan:** No TBDs, all code steps are complete.

- **Type consistency:** `AudioEntry`, `AudioStatus`, `AudioPlayerProps` defined in their own files and used consistently. `msg.message_id` used throughout (matches `WhatsAppMessage.message_id`).
