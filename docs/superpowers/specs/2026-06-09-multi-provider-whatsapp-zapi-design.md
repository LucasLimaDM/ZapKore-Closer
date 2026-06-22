# Multi-Provider WhatsApp Integration (Evolution + Z-API) — Design

**Date:** 2026-06-09
**Status:** Approved design, pending implementation plan
**Approach:** Hybrid adapter layer (Abordagem 3)

## Problem

The system supports exactly one WhatsApp provider: Evolution API. The provider is
hardcoded across ~12 edge functions — each builds Evolution-specific URLs, headers,
and payloads inline, and the webhook parses Baileys-specific payload shapes. We want
a second provider, **Z-API**, selectable per integration via a toggle at integration
setup time, without forking the whole system.

## Goal

A single point of change selects the provider. Adding/swapping a provider touches one
adapter, not the whole system. Everything downstream of message ingestion (DB schema,
AI handler, pipeline, contact resolution, UI) stays provider-agnostic and unchanged.

Scope for v1 — **full parity** on both providers: connect (QR) + status, receive
(webhook), send, and sync history + media + transcription.

## Diagnosis of current coupling

No provider abstraction exists today. Evolution is coupled in these functions, each
doing inline: read `evolution_api_url`/`evolution_api_key` from the integration row,
build Evolution URL paths, send `apikey` header, build/parse Evolution payloads.

| Function                          | Evolution API surface                                                |
| --------------------------------- | -------------------------------------------------------------------- |
| `evolution-send-message`          | `POST /message/sendText/{instance}`                                  |
| `evolution-webhook/index.ts`      | parses Baileys `messages.upsert`/`messages.update`/`messages.delete` |
| `evolution-webhook/ai-handler.ts` | `POST /message/sendText/{instance}` (AI reply)                       |
| `evolution-create-instance`       | `POST /instance/create` + `POST /webhook/set/{instance}`             |
| `evolution-get-qr`                | `GET /instance/connectionState/{instance}` + `POST /webhook/set`     |
| `evolution-disconnect`            | `GET /instance/logout/{instance}`                                    |
| `evolution-sync-contacts`         | `GET /chat/findChats/{instance}`                                     |
| `evolution-sync-messages`         | `GET /chat/findChats` + `POST /chat/findMessages/{instance}`         |
| `evolution-get-media`             | `POST /chat/getBase64FromMediaMessage/{instance}`                    |
| `evolution-transcribe-message`    | `POST /chat/getBase64FromMediaMessage/{instance}`                    |
| `evolution-credentials`           | get/save `url` + `api_key`                                           |

**Good news:** everything downstream of normalized `whatsapp_messages`/`whatsapp_contacts`
(AI handler logic, pipeline, contact resolution, UI) is already provider-agnostic. The
coupling is concentrated at the API edges — send, receive, instance lifecycle — which is
exactly where a provider adapter belongs.

## Z-API model (from developer.z-api.io)

- **Base URL**: `https://api.z-api.io/instances/{instanceId}/token/{instanceToken}/{endpoint}` —
  credentials live in the URL path, not a configurable host.
- **Auth**: three credentials — `instanceId` + `instanceToken` (URL path) + **`Client-Token`**
  header (account-level, required on all requests). Evolution uses two (url + `apikey` header).
- **Send text**: `POST .../send-text` body `{ phone, message }` → `{ zaapId, messageId, id }`.
  `phone` is bare digits (`5544999999999`), **not** a JID.
- **QR**: `GET .../qr-code/image` → base64 image. WhatsApp invalidates QR every ~20s; poll 10–20s.
- **Status**: `GET .../status` → `{ connected, smartphoneConnected, error }`.
- **Disconnect**: `GET .../disconnect`.
- **Webhook config (API)**: `update-every-webhooks` body `{ value: <url> }` points all callbacks
  to one URL.
- **Chats/history**: `GET .../chats`, `GET .../chat-messages/{phone}` (shallower history than Evolution).
- **Provisioning (chosen)**: instance is created in the Z-API panel by the user; the user pastes
  `instanceId` + `instanceToken` + `clientToken` into the app. (Partner API auto-creation is out
  of scope for v1.)

### Inbound webhook payload (Z-API, flat — differs entirely from Baileys)

```json
{
  "type": "ReceivedCallback",
  "instanceId": "A20DA9...",
  "messageId": "A20DA9...",
  "phone": "5544999999999",
  "senderLid": "81896604192873@lid",
  "connectedPhone": "554499999999",
  "fromMe": false,
  "momment": 1632228638000,
  "senderName": "name",
  "chatName": "name",
  "isGroup": false,
  "text": { "message": "teste" },
  "audio": { "audioUrl": "https://", "mimeType": "audio/ogg; codecs=opus", "ptt": true },
  "image": { "imageUrl": "https://", "caption": "", "mimeType": "image/jpeg" }
}
```

### Premises Z-API breaks

| #   | Current premise                                                | Z-API reality                                                                                                              |
| --- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | `instance_name = user_id`; webhook finds integration by it     | Z-API assigns its own `instanceId`. Resolve user by embedding `user_id` in the webhook URL instead                         |
| 2   | Baileys `messages.upsert` envelope + lid/jid duality           | Z-API flat object: `text.message`, `phone`, `fromMe`, `momment` (ms), `senderName`, `senderLid`, `type:"ReceivedCallback"` |
| 3   | Media decrypted via `getBase64FromMediaMessage`                | Z-API gives direct `audioUrl`/`imageUrl` (hosted 30 days) — simpler                                                        |
| 4   | `contact_identity` resolves lid→phone via `/chat/findContacts` | Z-API usually gives resolved `phone` + separate `senderLid`; WhatsApp does not map lid↔phone                               |
| 5   | Header `apikey`, body `{number,text}`, JID destination         | Z-API: `Client-Token` header, `{phone,message}`, bare phone                                                                |

## Architecture — hybrid adapter layer

Each existing function today mixes two things: business logic (fetch contact, build text,
save message, update pipeline) and API conversation (build URL/header/body, `fetch`). The
business half is provider-agnostic; the API half is what differs. The adapter extracts only
the API half. Functions keep their business logic and call the adapter for I/O.

### New module: `supabase/functions/_shared/providers/`

- `types.ts` — `WhatsAppProvider` interface + normalized types.
- `evolution.ts` — `EvolutionProvider implements WhatsAppProvider`.
- `zapi.ts` — `ZapiProvider implements WhatsAppProvider`.
- `factory.ts` — `getProvider(integration)` selects the adapter by `integration.provider`.

### Interface contract

```ts
interface WhatsAppProvider {
  sendText(toJid: string, text: string): Promise<{ messageId: string; raw: unknown }>
  getQrCode(): Promise<{ base64: string } | { connected: true }>
  getStatus(): Promise<'CONNECTED' | 'WAITING_QR' | 'DISCONNECTED'>
  configureWebhook(callbackUrl: string): Promise<boolean>
  disconnect(): Promise<void>
  syncChats(): Promise<NormalizedContact[]>
  syncMessages(chatId: string): Promise<NormalizedMessage[]>
  parseInbound(payload: unknown): NormalizedInbound | null
  fetchMediaUrl(message: NormalizedMessage | unknown): Promise<string | null>
}
```

Normalized types are the shared language. `NormalizedInbound` carries `remoteJid`
(canonical `<phone>@s.whatsapp.net`), `pushName`, `text`, `timestamp` (ISO), `messageId`,
`mediaUrl`, `lid`, `fromMe`, `type`. Both adapters return these; persistence code is written
once and never branches on provider.

### The factory is the toggle

```ts
export function getProvider(integration): WhatsAppProvider {
  switch (integration.provider) {
    case 'zapi':
      return new ZapiProvider(integration)
    case 'evolution':
    default:
      return new EvolutionProvider(integration)
  }
}
```

Each adapter takes the `user_integrations` row in its constructor and holds its own
credentials. All URL/header/payload differences live inside the adapter.

## Schema changes

Migration (`IF NOT EXISTS` guards), then regenerate `src/lib/supabase/types.ts`:

- `provider TEXT NOT NULL DEFAULT 'evolution'` — the toggle.
- `zapi_instance_id TEXT`, `zapi_instance_token TEXT`, `zapi_client_token TEXT`.
- Evolution columns unchanged. Default `'evolution'` means existing rows are untouched.
- `instance_name`: Evolution keeps `= user_id`; Z-API ignores it (routing via webhook URL).

## Webhook flow

Two separate ingress functions converging on one normalizer → one persistence path → one
`processAiResponse`. AI/pipeline/UI unchanged.

```
Evolution → POST /evolution-webhook          (instance_name=user_id in payload)
                 └─ EvolutionProvider.parseInbound ─┐
                                                     ├─→ NormalizedInbound → upsert DB → processAiResponse
Z-API     → POST /zapi-webhook/{user_id}      (user_id in URL)
                 └─ ZapiProvider.parseInbound ──────┘
```

- `zapi-webhook` is a new function; `user_id` path segment resolves the integration (no
  lookup-by-instanceId needed).
- `ZapiProvider.configureWebhook(url)` calls `update-every-webhooks` with
  `.../zapi-webhook/{user_id}`.
- Z-API `ConnectedCallback`/`DisconnectedCallback` map to `status` CONNECTED/DISCONNECTED.
- The shared persistence + AI-dispatch logic currently inside `evolution-webhook/index.ts`
  is extracted to a shared helper so both webhooks reuse it.

## Function-by-function migration map

Each function keeps its business logic; the API block becomes a `getProvider(integration)`
call.

| Function                       | Moves to adapter                               | Z-API behavior                                                              |
| ------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------- |
| `evolution-send-message`       | `sendText`                                     | `POST /send-text {phone,message}`                                           |
| `evolution-webhook/ai-handler` | `sendText`                                     | same                                                                        |
| `evolution-get-qr`             | `getQrCode` + `getStatus` + `configureWebhook` | `GET /status` + `GET /qr-code/image` + `update-every-webhooks`              |
| `evolution-create-instance`    | `configureWebhook` + `getStatus`               | no instance creation (user pasted creds) → configure webhook + check status |
| `evolution-disconnect`         | `disconnect`                                   | `GET /disconnect`                                                           |
| `evolution-sync-contacts`      | `syncChats`                                    | `GET /chats`                                                                |
| `evolution-sync-messages`      | `syncChats` + `syncMessages`                   | `GET /chats` + `GET /chat-messages/{phone}`                                 |
| `evolution-get-media`          | `fetchMediaUrl`                                | direct `image.imageUrl` from payload                                        |
| `evolution-transcribe-message` | `fetchMediaUrl`                                | direct `audio.audioUrl`                                                     |
| `evolution-credentials`        | branch by provider                             | get/save Z-API trio                                                         |

`contact_identity` and `merge_whatsapp_contacts` logic stay. Z-API rarely needs
`resolveLidToPhone` (phone usually pre-resolved); when `phone` arrives as `@lid`, the
existing temporary-contact fallback applies.

## Frontend

- Onboarding + Settings: a "Evolution | Z-API" toggle at the top of the connection config
  writes `provider`.
- Conditional credential fields: Evolution = url + key (existing); Z-API = instanceId +
  instanceToken + clientToken.
- `evolution-credentials` gains a Z-API branch (saves/reads the trio, validates via
  `GET /status`).
- ConnectionCard QR/status/disconnect calls are unchanged — they invoke the same functions,
  which now use the adapter internally.

## Z-API specifics handled in design

- **Media simpler**: direct URLs (30-day hosted) → transcription/media without decrypt.
- **LID**: Z-API gives resolved `phone` + separate `senderLid`. `contact_identity` retained;
  `@lid`-only payloads use the existing temporary-contact fallback.
- **Shallower sync**: Z-API retroactive history is more limited than Evolution. Accepted.
- **Phone format**: adapter converts DB JID ↔ Z-API bare phone on both ends.

## Migration order (incremental — Evolution always up)

1. Migration + regenerate types + scaffold `_shared/providers/` (interface +
   `EvolutionProvider` extracted + `factory`). Evolution runs through the adapter with
   identical behavior — validates the refactor before Z-API exists.
2. `ZapiProvider` + `zapi-webhook` + credentials branch.
3. Frontend toggle + conditional fields.
4. Migrate remaining functions one at a time (send → qr → disconnect → sync → media →
   transcribe), testing Evolution after each deploy.
5. AI smoke test on both providers.

## Testing strategy

- After each function migration: Evolution AI smoke test
  (`evolution-debug?endpoint=test-ai`) must stay green.
- Z-API: manual connect (paste creds → QR → CONNECTED), send a text, receive a text
  (verify AI reply), send/receive audio (verify transcription), run sync.
- Webhook routing: confirm `zapi-webhook/{user_id}` resolves the right integration.

## Out of scope (v1)

- Z-API Partner API auto-provisioning (user pastes credentials instead).
- Groups, communities, newsletters, catalog/business, interactive buttons, status/stories.
- Migrating an existing integration between providers (toggle is set at setup).

## Risks

- **FK/webhook regressions on Evolution** during refactor → mitigated by incremental order
  and per-step smoke tests.
- **Z-API `phone` as `@lid`** in privacy-restricted chats → temporary-contact fallback,
  same as Evolution today.
- **Deploy hygiene**: every modified function deployed with `--no-verify-jwt`; schema change
  ships with a migration first (per CLAUDE.md).
