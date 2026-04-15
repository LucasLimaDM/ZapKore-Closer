-- Enable logical replication for realtime on whatsapp_messages
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'whatsapp_messages'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.whatsapp_messages;
    END IF;
END $$;

-- Enable logical replication for realtime on whatsapp_contacts
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'whatsapp_contacts'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.whatsapp_contacts;
    END IF;
END $$;
