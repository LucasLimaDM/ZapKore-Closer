# Chat Infinite Scroll — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the chat page loading only the oldest 1000 messages by loading the 200 most recent messages initially, then prepending 50 older messages whenever the user scrolls to the top.

**Architecture:** Replace the unbounded `select('*')` query with a DESC-ordered `.limit(200)` fetch (reversed for display). A sentinel `<div>` at the top of the list is watched by an `IntersectionObserver`; when visible it triggers a cursor-based query (`.lt('timestamp', oldest)`). A `useLayoutEffect` preserves scroll position after prepending so the view does not jump.

**Tech Stack:** React 19, Supabase JS v2, TypeScript, Tailwind CSS. No test framework — verification is manual via the dev server.

---

## Root Cause (context)

`whatsapp_messages` for the "Mãe" contact has 1 796 rows. The previous query had no `.limit()`, so PostgREST's default cap of 1 000 rows returned only the *oldest* 1 000 messages (up to 2026-02-17). Messages from Feb 17 → today were silently dropped. New messages only appeared because the realtime subscription appended them on arrival.

---

## Files

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `src/pages/Chat.tsx` | All pagination logic lives here |

No new files required.

---

## Task 1 — Refactor initial fetch + add pagination state

**Files:**
- Modify: `src/pages/Chat.tsx`

### What changes

Replace the unbounded ascending query with a DESC-ordered, 200-row query that is reversed before being stored in state. Add the three state variables and two refs that the rest of the tasks depend on.

- [ ] **Step 1: Add imports**

In `src/pages/Chat.tsx`, update the React import line (line 1) to include `useCallback` and `useLayoutEffect`:

```tsx
import { useEffect, useState, useRef, useCallback, useLayoutEffect } from 'react'
```

- [ ] **Step 2: Add pagination state + refs after the existing refs (after line 38 `const messagesEndRef`)**

```tsx
const messagesContainerRef = useRef<HTMLDivElement>(null)
const topSentinelRef = useRef<HTMLDivElement>(null)
const prevScrollHeightRef = useRef<number>(0)
const loadMoreFnRef = useRef<() => void>(() => {})

const [hasMore, setHasMore] = useState(true)
const [isLoadingMore, setIsLoadingMore] = useState(false)
```

- [ ] **Step 3: Replace the messages fetch inside `fetchChat` (lines 58–64)**

Old code:
```tsx
const { data: messagesData } = await supabase
  .from('whatsapp_messages')
  .select('*')
  .eq('contact_id', id)
  .order('timestamp', { ascending: true })

if (messagesData) setMessages(messagesData)
```

New code:
```tsx
const { data: messagesData } = await supabase
  .from('whatsapp_messages')
  .select('*')
  .eq('contact_id', id)
  .order('timestamp', { ascending: false })
  .limit(200)

if (messagesData) {
  setMessages([...messagesData].reverse())
  setHasMore(messagesData.length === 200)
}
```

- [ ] **Step 4: Start dev server and verify initial load**

```bash
pnpm dev
```

Open the "Mãe" contact chat. Expected:
- The 26 messages from today are visible.
- Messages from yesterday and recent days are also visible.
- No console errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Chat.tsx
git commit -m "fix(chat): load 200 most recent messages instead of oldest 1000"
```

---

## Task 2 — Implement `loadMoreMessages` (cursor-based pagination)

**Files:**
- Modify: `src/pages/Chat.tsx`

### What changes

Add a `useCallback` function that queries the 50 messages older than the current oldest visible message, prepends them to state, and updates `hasMore`. It stores the pre-prepend scroll height so Task 3 can restore the position.

- [ ] **Step 1: Add `loadMoreMessages` after the `scrollToBottom` function**

```tsx
const loadMoreMessages = useCallback(async () => {
  if (isLoadingMore || !hasMore || !messages.length || !id) return

  setIsLoadingMore(true)
  prevScrollHeightRef.current = messagesContainerRef.current?.scrollHeight ?? 0

  const oldest = messages[0].timestamp

  const { data } = await supabase
    .from('whatsapp_messages')
    .select('*')
    .eq('contact_id', id)
    .lt('timestamp', oldest)
    .order('timestamp', { ascending: false })
    .limit(50)

  if (data) {
    setMessages((prev) => [...[...data].reverse(), ...prev])
    setHasMore(data.length === 50)
  }

  setIsLoadingMore(false)
}, [isLoadingMore, hasMore, messages, id])
```

- [ ] **Step 2: Keep `loadMoreFnRef` current**

Add this `useEffect` right after the `loadMoreMessages` definition:

```tsx
useEffect(() => {
  loadMoreFnRef.current = loadMoreMessages
}, [loadMoreMessages])
```

This lets the IntersectionObserver (set up once, no deps) always call the latest version of `loadMoreMessages` without recreating the observer on every render.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Chat.tsx
git commit -m "feat(chat): add cursor-based loadMoreMessages for infinite scroll"
```

---

## Task 3 — Scroll position preservation

**Files:**
- Modify: `src/pages/Chat.tsx`

### What changes

When `loadMoreMessages` prepends rows, React re-renders and the browser resets `scrollTop`. A `useLayoutEffect` (fires synchronously after DOM mutation, before paint) corrects `scrollTop` by the difference in `scrollHeight`.

- [ ] **Step 1: Add `useLayoutEffect` after the `loadMoreFnRef` effect**

```tsx
useLayoutEffect(() => {
  if (prevScrollHeightRef.current > 0 && messagesContainerRef.current) {
    const newScrollHeight = messagesContainerRef.current.scrollHeight
    messagesContainerRef.current.scrollTop +=
      newScrollHeight - prevScrollHeightRef.current
    prevScrollHeightRef.current = 0
  }
}, [messages.length])
```

**Why `messages.length`:** fires whenever rows are added (either prepend or realtime append). The `prevScrollHeightRef.current > 0` guard makes it a no-op for realtime appends (we only set it > 0 in `loadMoreMessages`).

- [ ] **Step 2: Verify scroll preservation manually**

With the dev server running, open the "Mãe" chat and scroll to the very top. Expected: older messages load and the viewport stays at roughly the same message — it does not snap to the top.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Chat.tsx
git commit -m "feat(chat): preserve scroll position when prepending older messages"
```

---

## Task 4 — Wire IntersectionObserver + update JSX

**Files:**
- Modify: `src/pages/Chat.tsx`

### What changes

1. Set up a single `IntersectionObserver` on the top sentinel `<div>`.
2. Add `ref={messagesContainerRef}` to the scrollable container.
3. Render the sentinel and a loading spinner at the top of the message list.

- [ ] **Step 1: Add IntersectionObserver effect after the `useLayoutEffect`**

```tsx
useEffect(() => {
  const sentinel = topSentinelRef.current
  if (!sentinel) return

  const observer = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting) {
        loadMoreFnRef.current()
      }
    },
    { rootMargin: '120px', threshold: 0 },
  )

  observer.observe(sentinel)
  return () => observer.disconnect()
}, []) // intentionally empty — loadMoreFnRef stays current via the ref
```

`rootMargin: '120px'` triggers loading 120px before the sentinel actually enters the viewport, giving a smoother experience.

- [ ] **Step 2: Add `ref` to the scrollable container div (line 310)**

Old:
```tsx
<div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 bg-zinc-50/30 dark:bg-background/30 scrollbar-thin">
```

New:
```tsx
<div
  ref={messagesContainerRef}
  className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 bg-zinc-50/30 dark:bg-background/30 scrollbar-thin"
>
```

- [ ] **Step 3: Add sentinel + loading spinner as the first children of the scrollable container**

Insert immediately after the opening `<div ref={messagesContainerRef} ...>` tag (before `{Object.entries(groupedMessages).map(...)}`):

```tsx
{/* Infinite scroll sentinel — triggers loadMoreMessages when visible */}
<div ref={topSentinelRef} className="h-px w-full" />

{isLoadingMore && (
  <div className="flex justify-center py-3">
    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/50" />
  </div>
)}

{!hasMore && messages.length > 0 && (
  <div className="flex justify-center py-2">
    <span className="text-[11px] font-bold text-muted-foreground/40 tracking-tight">
      {language === 'pt' ? 'Início da conversa' : 'Start of conversation'}
    </span>
  </div>
)}
```

- [ ] **Step 4: Full end-to-end verification**

```bash
pnpm dev
```

Checklist:
- [ ] Mãe chat opens and shows today's messages immediately (not old Jan messages)
- [ ] Scrolling to the top triggers the spinner and loads 50 older messages
- [ ] After loading, scroll position holds — view does not jump to top
- [ ] Scrolling to the top again loads another 50, repeating until `hasMore = false`
- [ ] When all history is loaded, "Início da conversa" label appears
- [ ] New incoming messages still appear at the bottom via realtime
- [ ] Other contacts with few messages work normally (no regression)

- [ ] **Step 5: Commit**

```bash
git add src/pages/Chat.tsx
git commit -m "feat(chat): infinite scroll — sentinel, spinner, start-of-conversation label"
```

---

## Self-Review

**Spec coverage:**
- ✅ Load 200 most recent messages on open → Task 1
- ✅ Scroll up → load 50 older messages → Tasks 2 + 4
- ✅ Scroll position preserved → Task 3
- ✅ Loading indicator → Task 4
- ✅ "Start of conversation" end-state → Task 4
- ✅ Realtime still works (no regression) → not touched

**Placeholder scan:** No TBDs, no "handle edge cases" vagueness, all code blocks present.

**Type consistency:** `messages` stays `WhatsAppMessage[]` throughout. `hasMore: boolean`, `isLoadingMore: boolean`. All refs typed. No mismatches.

**Edge cases covered:**
- `hasMore = false` set when initial fetch returns < 200 rows (contacts with short history)
- Guard `if (isLoadingMore || !hasMore || !messages.length)` prevents duplicate fetches
- `prevScrollHeightRef.current > 0` guard prevents `useLayoutEffect` from running on realtime appends
