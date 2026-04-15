CREATE TABLE IF NOT EXISTS public.ai_agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    system_prompt TEXT NOT NULL,
    gemini_api_key TEXT NOT NULL,
    is_active BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.ai_agents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own AI agents"
    ON public.ai_agents
    FOR ALL
    USING (auth.uid() = user_id);

ALTER TABLE public.whatsapp_contacts
    ADD COLUMN ai_agent_id UUID REFERENCES public.ai_agents(id) ON DELETE SET NULL;
