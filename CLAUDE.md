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
supabase functions deploy <function-name> --no-verify-jwt
```
**Always use `--no-verify-jwt`** — omitting it resets `verify_jwt` to `true` (Supabase default), causing the API gateway to return 401 before the function runs.

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

### Evolution API — Comportamento e Armadilhas

**Dois JIDs para o mesmo contato (causa raiz de duplicatas)**

WhatsApp representa o mesmo contato de duas formas:
- `<phone>@s.whatsapp.net` — JID canônico com número de telefone
- `<lid>@lid` — JID opaco para contas business/API (não contém telefone)

A Evolution API retorna **ambos como chats separados** em `/chat/findChats`. Se o código não cruzar as duas representações antes de criar contatos, o mesmo cliente aparece duplicado — um com número desconhecido (LID) e outro com telefone.

**Tabela `contact_identity` — a fonte da verdade**

Armazena o mapeamento `lid_jid ↔ phone_jid ↔ canonical_phone` por `instance_id`. Todo código que cria contatos **deve** consultar essa tabela antes de tentar resolver um LID. A sequência correta:

1. `extractCanonicalPhone(data)` — extrai do payload se já houver campo de telefone
2. Consultar `contact_identity` por `lid_jid` — usa o mapeamento já aprendido
3. `resolveLidToPhone(evoUrl, evoKey, instance, lid)` — chama `/chat/findContacts` na Evolution API como último recurso
4. Se ainda sem phone: gravar o contato com `remote_jid = lid` e `phone_number = null` (temporário)

**`evolution-sync-contacts` vs `evolution-sync-messages`**

Ambas criam contatos. `sync-messages` carrega `contact_identity` em um `identityMap` no início e o usa para resolver LIDs. **`sync-contacts` não faz isso** — é a causa de duplicatas quando Evolution retorna ambos os JIDs na lista de chats. Ao modificar qualquer uma, garantir que ambas usem `identityMap` de `contact_identity`.

**`contact_identity` — quando é populada**

- Pelo webhook (`evolution-webhook`) ao receber `messages.upsert` com um LID resolvido
- Por `linkLidToPhone` (`_shared/contact-linking.ts`) quando `remoteJidAlt` revela o telefone
- Pelo `sync-contacts` ao processar chats com `canonicalPhone` resolvido

**Resolução de LID no webhook**

`evolution-webhook` resolve LIDs na ordem:
1. `extractCanonicalPhone` nos campos do payload (incluindo `remoteJidAlt`)
2. `resolveLidToPhone` via Evolution API
3. Busca em `contact_identity` por `lid_jid` ou `phone_jid`
4. Se `identity` encontrada: usa `identity.phone_jid` como `effectiveJid` → evita criar contato com JID LID
5. Se `remoteJidAlt` presente na mensagem inbound: dispara `linkLidToPhone` em background via `EdgeRuntime.waitUntil`

**Campos inconsistentes da Evolution API**

O payload de `messages.upsert` pode ter estruturas diferentes. O webhook normaliza:
```
payload.data → array ou objeto → msgObj
msgObj.key.remoteJid | msgObj.remoteJid | msgObj.jid
msgObj.pushName | msgObj.verifiedName | msgObj.name
msgObj.messageTimestamp | msgObj.timestamp
msgObj.message.conversation | .extendedTextMessage.text | .templateMessage...
```
`findChats` retorna `remoteJid | jid | id` e `pushName | name | verifiedName | contactName | profileName | displayName`. Evolution às vezes retorna o próprio número/LID como `pushName` — sempre filtrar com `!/^\d+$/.test(pushName)`.

**`merge_whatsapp_contacts` RPC**

Quando duplicatas são detectadas (LID + phone para o mesmo contato), `_shared/contact-linking.ts:linkLidToPhone` chama `merge_whatsapp_contacts(p_user_id, p_primary_contact_id, p_secondary_contact_ids[])` — migra mensagens e deleta o contato secundário. O primário é sempre o JID `@s.whatsapp.net`.
