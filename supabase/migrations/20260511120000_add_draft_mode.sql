-- Per-agent toggle: when true, AI handler writes draft instead of sending
ALTER TABLE public.ai_agents
  ADD COLUMN IF NOT EXISTS draft_mode_enabled BOOLEAN NOT NULL DEFAULT false;

-- Per-contact draft slot (1:1, overwritten on each regeneration)
ALTER TABLE public.whatsapp_contacts
  ADD COLUMN IF NOT EXISTS draft_response TEXT,
  ADD COLUMN IF NOT EXISTS draft_updated_at TIMESTAMPTZ;

-- Enable realtime on whatsapp_contacts so frontend can subscribe to draft updates.
-- Same pattern as 20260310173815_enable_realtime_for_messages.sql.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'whatsapp_contacts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.whatsapp_contacts;
  END IF;
END$$;
