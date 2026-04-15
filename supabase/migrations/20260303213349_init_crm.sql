-- Enable pgcrypto for password hashing
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Create Core Tables
CREATE TABLE IF NOT EXISTS public.user_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  evolution_api_url TEXT,
  evolution_api_key TEXT,
  openai_api_key TEXT,
  instance_name TEXT,
  status TEXT DEFAULT 'DISCONNECTED',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE TABLE IF NOT EXISTS public.whatsapp_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  remote_jid TEXT NOT NULL,
  push_name TEXT,
  profile_picture_url TEXT,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, remote_jid)
);

CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  contact_id UUID REFERENCES public.whatsapp_contacts(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  from_me BOOLEAN DEFAULT FALSE,
  text TEXT,
  type TEXT,
  timestamp TIMESTAMPTZ,
  raw JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, message_id)
);

CREATE TABLE IF NOT EXISTS public.import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  type TEXT NOT NULL,
  status TEXT DEFAULT 'running',
  total_items INTEGER DEFAULT 0,
  processed_items INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.user_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_jobs ENABLE ROW LEVEL SECURITY;

-- Create Policies
CREATE POLICY "Users can manage their own integrations" ON public.user_integrations FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users can manage their own contacts" ON public.whatsapp_contacts FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users can manage their own messages" ON public.whatsapp_messages FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users can manage their own import jobs" ON public.import_jobs FOR ALL USING (auth.uid() = user_id);

-- Seed Demo Data
DO $$
DECLARE
  demo_user_id UUID := '11111111-1111-1111-1111-111111111111'::uuid;
  contact1_id UUID := gen_random_uuid();
  contact2_id UUID := gen_random_uuid();
BEGIN
  -- Insert demo user if not exists
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = demo_user_id) THEN
    INSERT INTO auth.users (
      id, instance_id, email, encrypted_password, email_confirmed_at,
      created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
      is_super_admin, role, aud,
      confirmation_token, recovery_token, email_change_token_new,
      email_change, email_change_token_current,
      phone, phone_change, phone_change_token, reauthentication_token
    ) VALUES (
      demo_user_id, '00000000-0000-0000-0000-000000000000', 'demo@warmmarket.app', crypt('Demo1234!', gen_salt('bf')), NOW(), NOW(), NOW(), '{"provider": "email", "providers": ["email"]}', '{"name": "Demo User"}', false, 'authenticated', 'authenticated',
      '', '', '', '', '', NULL, '', '', ''
    );
    
    -- Insert Mock Integration
    INSERT INTO public.user_integrations (user_id, instance_name, status)
    VALUES (demo_user_id, 'demo_instance', 'CONNECTED');

    -- Insert Mock Contacts
    INSERT INTO public.whatsapp_contacts (id, user_id, remote_jid, push_name, profile_picture_url, last_message_at)
    VALUES 
      (contact1_id, demo_user_id, '5511999999999@s.whatsapp.net', 'Alex (Lead)', 'https://img.usecurling.com/ppl/thumbnail?seed=1', NOW() - INTERVAL '10 minutes'),
      (contact2_id, demo_user_id, '5511888888888@s.whatsapp.net', 'Sarah Designer', 'https://img.usecurling.com/ppl/thumbnail?seed=2', NOW() - INTERVAL '2 hours');

    -- Insert Mock Messages
    INSERT INTO public.whatsapp_messages (user_id, contact_id, message_id, from_me, text, timestamp)
    VALUES
      (demo_user_id, contact1_id, 'MSG1', false, 'Hey, are we still on for tomorrow?', NOW() - INTERVAL '10 minutes'),
      (demo_user_id, contact1_id, 'MSG2', true, 'Yes! I will send the link.', NOW() - INTERVAL '5 minutes'),
      (demo_user_id, contact2_id, 'MSG3', false, 'Here is the new logo draft.', NOW() - INTERVAL '2 hours');
  END IF;
END $$;
