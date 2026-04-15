DO $$
BEGIN
    ALTER TABLE public.ai_agents ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;
EXCEPTION
    WHEN duplicate_column THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.handle_default_agent()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.is_default = true THEN
        UPDATE public.ai_agents
        SET is_default = false
        WHERE user_id = NEW.user_id AND id != NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ensure_single_default_agent ON public.ai_agents;
CREATE TRIGGER ensure_single_default_agent
BEFORE INSERT OR UPDATE OF is_default ON public.ai_agents
FOR EACH ROW
WHEN (NEW.is_default = true)
EXECUTE FUNCTION public.handle_default_agent();

CREATE OR REPLACE FUNCTION public.route_new_contact_to_default_agent()
RETURNS TRIGGER AS $$
DECLARE
    default_agent_id uuid;
BEGIN
    IF NEW.ai_agent_id IS NULL THEN
        SELECT id INTO default_agent_id
        FROM public.ai_agents
        WHERE user_id = NEW.user_id AND is_default = true
        LIMIT 1;

        IF default_agent_id IS NOT NULL THEN
            NEW.ai_agent_id := default_agent_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS route_contact_to_agent ON public.whatsapp_contacts;
CREATE TRIGGER route_contact_to_agent
BEFORE INSERT ON public.whatsapp_contacts
FOR EACH ROW
EXECUTE FUNCTION public.route_new_contact_to_default_agent();
