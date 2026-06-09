ALTER TABLE public.user_integrations
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'evolution',
  ADD COLUMN IF NOT EXISTS zapi_instance_id TEXT,
  ADD COLUMN IF NOT EXISTS zapi_instance_token TEXT,
  ADD COLUMN IF NOT EXISTS zapi_client_token TEXT;

COMMENT ON COLUMN public.user_integrations.provider IS 'WhatsApp provider: evolution | zapi';
