# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev          # Start dev server on port 8080
pnpm build        # Production build (dist/)
pnpm build:dev    # Dev build with sourcemaps (dev-dist/)
pnpm lint         # oxlint src
pnpm lint:fix     # oxlint src --fix
pnpm format       # oxfmt (formatter)
pnpm format:check # oxfmt --check
```

No test suite exists (`test` script is a no-op).

To deploy an edge function:

```bash
supabase functions deploy <function-name>
```

## Architecture

### Frontend

**React 19 + Vite (rolldown-vite) + TypeScript + Tailwind CSS + shadcn/ui**

Two root layouts defined in `App.tsx`:

- `Layout` — wraps public routes (`/`, `/auth`)
- `DashboardLayout` — wraps all `/app/*` and `/settings` routes; enforces auth and onboarding gate

**Route guard logic** (`src/components/DashboardLayout.tsx`): unauthenticated → `/auth`; authenticated but `integration.is_setup_completed = false` → `/app/onboarding`; setup complete + on onboarding → `/app`.

**Global context providers** (nested in `App.tsx`, outermost first):

1. `LanguageProvider` — i18n via `src/lib/i18n/translations.ts`
2. `AuthProvider` — Supabase auth session (`use-auth.tsx`)
3. `IntegrationProvider` — fetches/creates `user_integrations` row on login, subscribes to realtime updates (`use-integration.ts`)

**Path alias**: `@/` → `src/`

**Shared types**: `src/lib/types.ts` (app domain types). `src/lib/supabase/types.ts` is **auto-generated** — never edit it directly; regenerate with `supabase gen types typescript`.

### Backend — Supabase Edge Functions (Deno)

All functions live in `supabase/functions/`. Each has its own `deno.json`. Shared utilities are in `supabase/functions/_shared/`.

Key functions:
| Function | Purpose |
|---|---|
| `evolution-webhook` | Main ingress for Evolution API webhook events |
| `evolution-webhook/ai-handler.ts` | Background Gemini 2.5 Flash response processor |
| `evolution-create-instance` | Creates WhatsApp instance in Evolution API |
| `evolution-get-qr` | Fetches QR code for pairing |
| `evolution-send-message` | Sends a message via Evolution API |
| `evolution-sync-contacts` | Bulk-syncs contacts from Evolution API |
| `evolution-sync-messages` | Bulk-syncs messages from Evolution API |
| `evolution-disconnect` | Disconnects a WhatsApp instance |
| `ai-classify-contacts` | Bulk AI classification of contacts |
| `ai-pipeline-monitor` | AI-driven pipeline stage monitoring |

All edge functions use `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS) and have `verify_jwt = false`.

### Data Model

**`user_integrations`**: One row per user. `instance_name` is always set to the user's UUID. `status`: `DISCONNECTED` | `WAITING_QR` | `CONNECTED`. `is_setup_completed` gates the onboarding flow.

**`whatsapp_contacts`**: Keyed by `(user_id, remote_jid)`. `remote_jid` uses canonical form `<phone>@s.whatsapp.net`. Has `pipeline_stage` (default `'Em Espera'`) and `ai_agent_id` FK.

**`contact_identity`**: Resolves WhatsApp @lid JIDs (business accounts) to canonical phone numbers. Indexed by `(instance_id, canonical_phone)`, `lid_jid`, and `phone_jid`. The webhook upserts into this table to keep JID ↔ phone mappings fresh.

**`whatsapp_messages`**: Keyed by `(user_id, message_id)`. `raw` stores the full Evolution API payload as JSONB.

**`ai_agents`**: Per-user Gemini agents. DB trigger `ensure_single_default_agent` enforces only one `is_default = true` per user. Trigger `route_contact_to_agent` auto-assigns the default agent to new contacts.

### Webhook Flow (`evolution-webhook`)

1. Lookup `user_integrations` by `instance_name` to resolve `user_id`
2. `connection.update` → update `status` in `user_integrations`
3. `messages.upsert` → resolve JID via `contact_identity` → upsert `whatsapp_contacts` → upsert `whatsapp_messages` → if inbound text and `ai_agent_id` set: fire `processAiResponse` via `EdgeRuntime.waitUntil`

`processAiResponse` fetches last 12 messages → calls Gemini 2.5 Flash → sends reply via Evolution API → saves reply to DB. AI processing is skipped if `ai_agent_id` is null on the contact.

### JID Deduplication Pattern

WhatsApp can represent the same contact as either a phone JID (`<phone>@s.whatsapp.net`) or a LID JID (`<lid>@lid`). The webhook resolves these through `contact_identity` before looking up `whatsapp_contacts`, preventing duplicate contact rows. If a LID is seen, `resolveLidToPhone` queries Evolution API's `/chat/findContacts` endpoint.
