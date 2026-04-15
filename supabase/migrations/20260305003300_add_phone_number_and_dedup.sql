-- Add phone_number column
ALTER TABLE public.whatsapp_contacts ADD COLUMN phone_number TEXT;

-- Create an index for faster lookups by phone number
CREATE INDEX IF NOT EXISTS whatsapp_contacts_phone_number_idx ON public.whatsapp_contacts USING btree (user_id, phone_number);

-- Backfill phone numbers for standard JIDs
UPDATE public.whatsapp_contacts
SET phone_number = split_part(remote_jid, '@', 1)
WHERE remote_jid LIKE '%@s.whatsapp.net' AND phone_number IS NULL;

-- Create helper function for deduplication to ensure data integrity of messages
CREATE OR REPLACE FUNCTION public.merge_whatsapp_contacts(
    p_user_id UUID,
    p_primary_contact_id UUID,
    p_secondary_contact_ids UUID[]
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Re-assign messages to the primary contact
    UPDATE public.whatsapp_messages
    SET contact_id = p_primary_contact_id
    WHERE user_id = p_user_id
      AND contact_id = ANY(p_secondary_contact_ids);

    -- Delete the secondary duplicate contacts
    DELETE FROM public.whatsapp_contacts
    WHERE user_id = p_user_id
      AND id = ANY(p_secondary_contact_ids);
END;
$$;
