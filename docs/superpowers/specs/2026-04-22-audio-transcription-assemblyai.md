# Audio Transcription — AssemblyAI Integration

**Date:** 2026-04-22  
**Status:** Approved

## Overview

Automatic audio transcription via AssemblyAI for incoming WhatsApp audio messages. Transcript persists in DB, feeds the AI agent as text input, and renders in chat below the audio player as a collapsible drawer.

---

## Database

### Migration 1 — `user_api_keys`

Add `key_type TEXT NOT NULL DEFAULT 'ai'` with check constraint `IN ('ai', 'audio')`.  
All existing rows default to `'ai'` — no data migration needed.

### Migration 2 — `ai_agents`

Add `audio_api_key_id UUID REFERENCES user_api_keys(id) ON DELETE SET NULL`.  
Nullable — absence means fallback mode is active for that agent.

### Migration 3 — `whatsapp_messages`

Add `transcript TEXT` column. Null when not yet transcribed or not applicable. Populated after AssemblyAI returns a completed result. Never overwritten once set (idempotent — skip if already exists).

---

## Backend — `evolution-webhook`

### Audio message flow (`messages.upsert` with type `audioMessage`)

1. Save message to DB as usual (type `audio`, transcript `null`)
2. Inside `EdgeRuntime.waitUntil`, call `processAudioMessage(...)` in background
3. `processAudioMessage`:
   a. Fetch agent row — check `audio_api_key_id`
   b. If key exists:
      - Download audio blob via existing `evolution-get-media` logic
      - Upload blob to `https://api.assemblyai.com/v2/upload`
      - Submit transcript job: `POST /v2/transcript` with `{ audio_url, language_detection: true, speech_models: ['universal-3-pro', 'universal-2'] }`
      - Poll `GET /v2/transcript/:id` every 3s until `completed` or `error`
      - On `completed`: `UPDATE whatsapp_messages SET transcript = result.text WHERE id = ...`
      - Use `transcript` as text input for `processAiResponse`
   c. If no key:
      - Inject synthetic text: `"[Áudio recebido. Você ainda não consegue transcrever áudios - informe o cliente.]"`
      - Use this synthetic text as input for `processAiResponse`
4. `processAiResponse` receives the text string (real or synthetic) — existing memory/delay logic unchanged

### Idempotency

Before transcribing, check `whatsapp_messages.transcript IS NOT NULL` — if already set, skip AssemblyAI call entirely.

### AssemblyAI key retrieval

Fetch from `user_api_keys` where `id = agent.audio_api_key_id AND key_type = 'audio'`. Use `key` field as the `authorization` header value.

---

## Frontend

### Agents page — "Conexões de IA" tab

Split into two visual sub-sections:

**"Modelos de IA"** — existing cards, existing "Nova Conexão" button (creates `key_type = 'ai'`)

**"Áudio & Transcrição"** — new section with separator, new "Nova Chave de Áudio" button  
- Dialog mirrors the existing connection dialog  
- Provider fixed to AssemblyAI (`provider = 'assemblyai'`, `key_type = 'audio'`)  
- No provider selector — single option  
- Link to `https://www.assemblyai.com/app/account` for key retrieval  
- Cards show microphone icon instead of key icon

### Agent create/edit dialog

Add field below `api_key_id`:

```
Label: "Transcrição de Áudio (Opcional)"
Select: filtered to apiKeys where key_type === 'audio'
Placeholder: "Sem transcrição"
```

Agent `formData` gains `audio_api_key_id: ''` field. Saved to DB on create/update.

### `useAPIKeys` hook

Add `audioKeys` derived from existing `apiKeys` filtered by `key_type === 'audio'`.  
`createAPIKey` accepts `key_type` param (defaults to `'ai'` to preserve existing behavior).

### `AIAgent` type (`src/lib/types.ts`)

Add `audio_api_key_id: string | null`.

### `AudioPlayer.tsx` — transcript drawer

If `message.transcript` is non-null and non-empty:

- Render below the player a collapsible section
- Default state: **expanded**
- Toggle button: `ChevronUp` / `ChevronDown` icon, small, right-aligned
- Transcript text: italic, `text-muted-foreground`, left border `border-l-2 border-border pl-3`
- Label above text: `"Transcrição"` in `text-[10px] uppercase tracking-widest font-semibold text-muted-foreground`

`AudioPlayer` must receive `transcript?: string | null` as prop. `Chat.tsx` passes it from the message object.

---

## Data Flow Summary

```
WhatsApp audio arrives
  → webhook saves message (transcript: null)
  → background: download audio → AssemblyAI → save transcript
  → background: use transcript (or fallback) → AI agent → reply sent
  → frontend: AudioPlayer renders transcript drawer below player
```

---

## Out of Scope

- Manual "re-transcribe" button
- Multiple audio providers (Deepgram, Whisper, etc.) — architecture supports it via `key_type`, but UI/logic not built
- Transcript editing by user
- Transcription for video or sticker messages
