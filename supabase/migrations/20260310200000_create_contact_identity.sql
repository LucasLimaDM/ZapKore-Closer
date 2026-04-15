CREATE TABLE public.contact_identity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id UUID REFERENCES public.user_integrations(id) ON DELETE CASCADE NOT NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    canonical_phone TEXT,
    phone_jid TEXT,
    lid_jid TEXT,
    display_name TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_contact_identity_instance_phone ON public.contact_identity (instance_id, canonical_phone);
CREATE INDEX idx_contact_identity_lid_jid ON public.contact_identity (lid_jid);
CREATE INDEX idx_contact_identity_phone_jid ON public.contact_identity (phone_jid);

ALTER TABLE public.contact_identity ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own contact identities"
ON public.contact_identity
FOR ALL
USING (auth.uid() = user_id);
