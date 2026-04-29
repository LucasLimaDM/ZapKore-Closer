-- Debounce generation counter per contact
ALTER TABLE whatsapp_contacts
  ADD COLUMN IF NOT EXISTS ai_trigger_version INTEGER NOT NULL DEFAULT 0;

-- Configurable delay per agent (seconds), same pattern as memory_limit
ALTER TABLE ai_agents
  ADD COLUMN IF NOT EXISTS message_delay INTEGER NOT NULL DEFAULT 0;

-- Atomic increment RPC — returns the new version number
CREATE OR REPLACE FUNCTION increment_ai_trigger_version(p_contact_id UUID)
RETURNS INTEGER
LANGUAGE SQL
SECURITY DEFINER
AS $$
  UPDATE whatsapp_contacts
  SET ai_trigger_version = ai_trigger_version + 1
  WHERE id = p_contact_id
  RETURNING ai_trigger_version;
$$;
