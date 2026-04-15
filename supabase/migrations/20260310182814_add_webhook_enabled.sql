ALTER TABLE public.user_integrations ADD COLUMN IF NOT EXISTS is_webhook_enabled BOOLEAN NOT NULL DEFAULT false;
