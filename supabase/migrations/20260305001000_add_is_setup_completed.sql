ALTER TABLE public.user_integrations ADD COLUMN is_setup_completed BOOLEAN NOT NULL DEFAULT false;

UPDATE public.user_integrations 
SET is_setup_completed = true 
WHERE status = 'CONNECTED' OR EXISTS (
  SELECT 1 FROM public.whatsapp_contacts WHERE whatsapp_contacts.user_id = user_integrations.user_id
);
