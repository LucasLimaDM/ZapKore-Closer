ALTER TABLE public.user_integrations ALTER COLUMN evolution_api_url DROP NOT NULL;
ALTER TABLE public.user_integrations ALTER COLUMN evolution_api_key DROP NOT NULL;

COMMENT ON COLUMN public.user_integrations.evolution_api_url IS 'Deprecated: Configuration moved to Edge Function Secrets.';
COMMENT ON COLUMN public.user_integrations.evolution_api_key IS 'Deprecated: Configuration moved to Edge Function Secrets.';
