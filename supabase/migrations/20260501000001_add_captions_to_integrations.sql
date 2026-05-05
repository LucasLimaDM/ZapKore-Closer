ALTER TABLE public.user_integrations
  ADD COLUMN IF NOT EXISTS captions_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS user_display_name TEXT;
