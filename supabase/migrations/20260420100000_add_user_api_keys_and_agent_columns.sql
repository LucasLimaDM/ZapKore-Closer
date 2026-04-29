-- user_api_keys was created without a tracked migration. Adding IF NOT EXISTS guard.
CREATE TABLE IF NOT EXISTS public.user_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  key TEXT NOT NULL,
  provider TEXT NOT NULL,
  settings JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.user_api_keys ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'user_api_keys' AND policyname = 'Users can manage their own API keys'
  ) THEN
    CREATE POLICY "Users can manage their own API keys"
      ON public.user_api_keys
      FOR ALL
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- ai_agents: api_key_id, model_id, memory_limit were added without a tracked migration.
ALTER TABLE public.ai_agents
  ADD COLUMN IF NOT EXISTS api_key_id UUID REFERENCES public.user_api_keys(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS model_id TEXT NOT NULL DEFAULT 'google/gemini-2.0-flash-lite:free',
  ADD COLUMN IF NOT EXISTS memory_limit INTEGER NOT NULL DEFAULT 20;
