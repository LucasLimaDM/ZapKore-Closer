ALTER TABLE ai_agents
  ADD COLUMN IF NOT EXISTS fallback_model_ids TEXT[] NOT NULL DEFAULT '{}';
