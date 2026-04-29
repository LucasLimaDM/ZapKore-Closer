# CLAUDE.md

Guidance for Claude Code when working in this repo.

## Commands

```bash
pnpm dev --port 8085  # Start dev server — always use port 8085
pnpm build        # Production build (dist/)
pnpm build:dev    # Dev build with sourcemaps (dev-dist/)
pnpm lint         # oxlint src
pnpm lint:fix     # oxlint src --fix
pnpm format       # oxfmt (formatter)
pnpm format:check # oxfmt --check
```

No test suite (`test` script no-op).

To deploy an edge function:

```bash
# a) Write migration with IF NOT EXISTS guards in supabase/migrations/
# b) Regenerate TypeScript types:
supabase gen types typescript --project-id fckenwdyghisdebqauxy > src/lib/supabase/types.ts
```
**Every schema change without a migration is technical debt that breaks AI and other features on the next FK-touching deploy. Always write the migration first.**

### 2. Edge function changes
Deploy EVERY modified function:
```bash
supabase functions deploy <function-name> --no-verify-jwt
```
**Always use `--no-verify-jwt`** — omitting resets `verify_jwt` to `true`, causing 401 before function runs.

Functions that touch `ai_agents` or `user_api_keys` → run AI smoke test after deploy (step 3).

### 3. AI agent smoke test (after any change touching evolution-webhook, ai-handler, ai_agents, user_api_keys)
```bash
curl "https://fckenwdyghisdebqauxy.supabase.co/functions/v1/evolution-debug?endpoint=test-ai" \
  -H "Authorization: Bearer <service_role_key>"
```
Expected: `"ok": true` and all checks `true`. If `fk_join_ok` is missing or `api_key_present: false`, the AI handler will silently exit — **AI appears broken with no visible error in the webhook response**.

AI failures are SILENT: `evolution-webhook` always returns `200 OK`. Errors only appear in Supabase function logs. Check logs at: https://supabase.com/dashboard/project/fckenwdyghisdebqauxy/functions

### 4. Commit and push
```bash
git add -A && git commit -m "..."
git push
```

## FK Joins on ai_agents — Critical Pattern

`ai_agents` has TWO foreign keys to `user_api_keys`:
- `api_key_id` → FK name: `ai_agents_api_key_id_fkey` (AI/OpenRouter key)
- `audio_api_key_id` → FK name: `ai_agents_audio_api_key_id_fkey` (AssemblyAI key)

**Never use** `.select('*, user_api_keys(*)')` — ambiguous FK, PostgREST error → `agentError` set → AI silently stops.

**Always use explicit FK hint:**
```typescript
.select('*, user_api_keys!ai_agents_api_key_id_fkey(*)')   // AI key
.select('*, user_api_keys!ai_agents_audio_api_key_id_fkey(*)')  // audio key
```

Adding any new FK from `ai_agents` → `user_api_keys` requires updating this hint or fetching keys separately.

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

**Shared types**: `src/lib/types.ts` (app domain types). `src/lib/supabase/types.ts` **auto-generated** — never edit directly; regenerate with `supabase gen types typescript`.

### Backend — Supabase Edge Functions (Deno)

All functions in `supabase/functions/`. Each has own `deno.json`. Shared utilities in `supabase/functions/_shared/`.

Key functions:
| Function | Purpose |
|---|---|
| `evolution-webhook` | Main ingress for Evolution API webhook events |
| `evolution-webhook/ai-handler.ts` | Background Gemini 2.5 Flash response processor |
| `evolution-create-instance` | Creates WhatsApp instance in Evolution API |
| `evolution-get-qr` | Fetches QR code for pairing |
| `evolution-send-message` | Sends message via Evolution API |
| `evolution-sync-contacts` | Bulk-syncs contacts from Evolution API |
| `evolution-sync-messages` | Bulk-syncs messages from Evolution API |
| `evolution-disconnect` | Disconnects WhatsApp instance |
| `ai-classify-contacts` | Bulk AI classification of contacts |
| `ai-pipeline-monitor` | AI-driven pipeline stage monitoring |

All edge functions use `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS), `verify_jwt = false`.

### Data Model

**`user_integrations`**: One row per user. `instance_name` always = user UUID. `status`: `DISCONNECTED` | `WAITING_QR` | `CONNECTED`. `is_setup_completed` gates onboarding.

**`whatsapp_contacts`**: Keyed by `(user_id, remote_jid)`. `remote_jid` canonical form `<phone>@s.whatsapp.net`. Has `pipeline_stage` (default `'Em Espera'`) and `ai_agent_id` FK.

**`contact_identity`**: Resolves WhatsApp @lid JIDs (business accounts) to canonical phones. Indexed by `(instance_id, canonical_phone)`, `lid_jid`, `phone_jid`. Webhook upserts to keep JID ↔ phone mappings fresh.

**`whatsapp_messages`**: Keyed by `(user_id, message_id)`. `raw` stores full Evolution API payload as JSONB.

**`ai_agents`**: Per-user Gemini agents. DB trigger `ensure_single_default_agent` enforces one `is_default = true` per user. Trigger `route_contact_to_agent` auto-assigns default agent to new contacts.

### Webhook Flow (`evolution-webhook`)

1. Lookup `user_integrations` by `instance_name` → resolve `user_id`
2. `connection.update` → update `status` in `user_integrations`
3. `messages.upsert` → resolve JID via `contact_identity` → upsert `whatsapp_contacts` → upsert `whatsapp_messages` → if inbound text + `ai_agent_id` set: fire `processAiResponse` via `EdgeRuntime.waitUntil`

`processAiResponse` fetches last 12 messages → calls Gemini 2.5 Flash → sends reply via Evolution API → saves reply to DB. AI skipped if `ai_agent_id` null on contact.

### Evolution API — Comportamento e Armadilhas

**Dois JIDs para o mesmo contato (causa raiz de duplicatas)**

WhatsApp representa mesmo contato de duas formas:
- `<phone>@s.whatsapp.net` — JID canônico com número
- `<lid>@lid` — JID opaco para contas business/API (sem telefone)

Evolution API retorna **ambos como chats separados** em `/chat/findChats`. Sem cruzar representações antes de criar contatos, mesmo cliente aparece duplicado — um com número desconhecido (LID) e outro com telefone.

**Tabela `contact_identity` — fonte da verdade**

Armazena mapeamento `lid_jid ↔ phone_jid ↔ canonical_phone` por `instance_id`. Todo código que cria contatos **deve** consultar antes de resolver LID. Sequência correta:

1. `extractCanonicalPhone(data)` — extrai do payload se houver campo de telefone
2. Consultar `contact_identity` por `lid_jid` — usa mapeamento já aprendido
3. `resolveLidToPhone(evoUrl, evoKey, instance, lid)` — chama `/chat/findContacts` na Evolution API como último recurso
4. Se ainda sem phone: gravar contato com `remote_jid = lid` e `phone_number = null` (temporário)

**`evolution-sync-contacts` vs `evolution-sync-messages`**

Ambas criam contatos. `sync-messages` carrega `contact_identity` em `identityMap` no início e usa para resolver LIDs. **`sync-contacts` não faz isso** — causa duplicatas quando Evolution retorna ambos JIDs na lista de chats. Ao modificar qualquer uma, garantir que ambas usem `identityMap` de `contact_identity`.

**`contact_identity` — quando é populada**

- Webhook (`evolution-webhook`) ao receber `messages.upsert` com LID resolvido
- `linkLidToPhone` (`_shared/contact-linking.ts`) quando `remoteJidAlt` revela telefone
- `sync-contacts` ao processar chats com `canonicalPhone` resolvido

**Resolução de LID no webhook**

`evolution-webhook` resolve LIDs na ordem:
1. `extractCanonicalPhone` nos campos do payload (incluindo `remoteJidAlt`)
2. `resolveLidToPhone` via Evolution API
3. Busca em `contact_identity` por `lid_jid` ou `phone_jid`
4. Se `identity` encontrada: usa `identity.phone_jid` como `effectiveJid` → evita criar contato com JID LID
5. Se `remoteJidAlt` presente na mensagem inbound: dispara `linkLidToPhone` em background via `EdgeRuntime.waitUntil`

**Campos inconsistentes da Evolution API**

Payload de `messages.upsert` tem estruturas diferentes. Webhook normaliza:
```
payload.data → array ou objeto → msgObj
msgObj.key.remoteJid | msgObj.remoteJid | msgObj.jid
msgObj.pushName | msgObj.verifiedName | msgObj.name
msgObj.messageTimestamp | msgObj.timestamp
msgObj.message.conversation | .extendedTextMessage.text | .templateMessage...
```
`findChats` retorna `remoteJid | jid | id` e `pushName | name | verifiedName | contactName | profileName | displayName`. Evolution às vezes retorna próprio número/LID como `pushName` — sempre filtrar com `!/^\d+$/.test(pushName)`.

**`merge_whatsapp_contacts` RPC**

Quando duplicatas detectadas (LID + phone mesmo contato), `_shared/contact-linking.ts:linkLidToPhone` chama `merge_whatsapp_contacts(p_user_id, p_primary_contact_id, p_secondary_contact_ids[])` — migra mensagens, deleta contato secundário. Primário sempre JID `@s.whatsapp.net`.