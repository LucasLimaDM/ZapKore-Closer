alter table ai_agents
  add column if not exists audio_api_key_id uuid references user_api_keys(id) on delete set null;
