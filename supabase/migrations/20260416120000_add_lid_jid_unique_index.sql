-- Ensures one contact_identity row per (instance, LID).
-- Partial: rows where lid_jid IS NULL are unaffected (most identities only have phone_jid).
CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_identity_instance_lid
ON public.contact_identity (instance_id, lid_jid)
WHERE lid_jid IS NOT NULL;
