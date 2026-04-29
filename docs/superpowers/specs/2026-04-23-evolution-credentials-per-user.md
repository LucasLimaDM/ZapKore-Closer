# Evolution API Per-User Credentials

**Date:** 2026-04-23  
**Status:** Approved

## Problem

Evolution API URL and key are currently read from shared Supabase env vars. No user has working credentials via env. Migration goal: each user stores their own credentials in `user_integrations`, managed via UI.

## Database

No migration required. `user_integrations` already has:
- `evolution_api_url text | null`
- `evolution_api_key text | null`

## Architecture Decision

All credential operations go through a new edge function `evolution-credentials`. The full API key never reaches the frontend — only a masked representation (`sk-***...abc`: first 3 + `***` + last 3 chars).

## New Edge Function: `evolution-credentials`

**Path:** `supabase/functions/evolution-credentials/index.ts`

Resolves `user_id` from the Supabase JWT in the `Authorization` header.

### GET
Returns masked credentials for display:
```json
{ "url": "https://api.example.com", "api_key_masked": "sk-***abc" }
```
If no credentials set: `{ "url": null, "api_key_masked": null }`.

### POST `{ url: string, api_key: string }`
1. Basic validation: url must be a valid URL, api_key non-empty.
2. Call `GET /instance/fetchInstances` on the Evolution API using the provided credentials.
3. If Evolution API returns non-2xx → return error, do not save.
4. If ok → `UPDATE user_integrations SET evolution_api_url = url, evolution_api_key = api_key WHERE user_id = <resolved_user_id>`.
5. Return `{ url, api_key_masked }`.

On validation failure the response is a 400 with `{ error: "..." }`. The UI must not close the form on error.

## Onboarding Changes (`Onboarding.tsx`)

Steps go from 2 → 3. New step 0 inserted before QR scan.

**On mount:** call `evolution-credentials` GET. If `api_key_masked` is non-null → skip step 0, start at step 1.

**Step 0 UI:**
- Icon: `KeyRound` in progress indicator (added before `Smartphone` and `BrainCircuit`)
- Form: URL field + API Key field (both required)
- Button "Verificar e continuar": calls POST, shows loading spinner, disables fields during request
- On error: toast + form stays open
- On success: advance to step 1 (QR scan)

## Settings Changes (`Settings.tsx`)

New card above existing WhatsApp Connection card.

**Display state:**
- Loads via `evolution-credentials` GET on mount
- Shows: URL (plaintext) + API Key masked (`sk-***abc`)
- Button "Editar"

**Edit state (inline, no modal):**
- Two blank input fields (URL + API Key)
- Buttons: "Salvar" / "Cancelar"
- "Salvar" calls POST with same validation flow
- On error: toast, fields stay open
- On success: returns to display state with updated masked values

## Edge Function Fixes

`evolution-create-instance` and `evolution-get-qr` currently read only from env vars and throw if env is unset. Both already query `user_integrations` — change credential resolution to:

```ts
const evoUrlRaw = integ.evolution_api_url || Deno.env.get('EVOLUTION_API_URL') || ''
const evolutionApiKey = integ.evolution_api_key || Deno.env.get('EVOLUTION_API_KEY') || ''
if (!evoUrlRaw || !evolutionApiKey) throw new Error('Evolution API credentials not configured.')
```

This matches the pattern already used in `evolution-sync-contacts`, `evolution-sync-messages`, `evolution-send-message`, `evolution-disconnect`, and `evolution-get-media`.

## Onboarding Gate

No changes to `DashboardLayout.tsx`. Gate logic unchanged: `is_setup_completed = false` → `/app/onboarding`. Step 0 in onboarding handles the credential gate internally.

## Affected Files

| File | Change |
|---|---|
| `supabase/functions/evolution-credentials/index.ts` | New |
| `src/pages/Onboarding.tsx` | Add step 0 |
| `src/pages/Settings.tsx` | Add credentials card |
| `supabase/functions/evolution-create-instance/index.ts` | Fix credential resolution |
| `supabase/functions/evolution-get-qr/index.ts` | Fix credential resolution |

## Out of Scope

- Encryption at rest for `evolution_api_key` (Supabase service role + RLS provides sufficient isolation)
- Auto-migration from env vars (no users rely on them)
- Multi-instance support (one integration per user)
