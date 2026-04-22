export interface UserIntegration {
  id: string
  user_id: string
  evolution_api_url: string | null
  evolution_api_key: string | null
  instance_name: string | null
  status: 'DISCONNECTED' | 'WAITING_QR' | 'CONNECTED'
  is_setup_completed?: boolean
  is_webhook_enabled?: boolean
  created_at: string
}

export interface UserAPIKey {
  id: string
  user_id: string
  name: string
  key: string
  provider: string
  key_type: 'ai' | 'audio'
  settings?: any
  created_at: string
  updated_at: string
}

export interface AIAgent {
  id: string
  user_id: string
  name: string
  description: string | null
  system_prompt: string
  api_key_id: string | null
  audio_api_key_id: string | null
  model_id: string
  memory_limit: number
  message_delay: number
  is_active: boolean
  is_default?: boolean
  created_at: string
  updated_at: string
}

export interface WhatsAppContact {
  id: string
  user_id: string
  remote_jid: string
  phone_number: string | null
  push_name: string | null
  profile_picture_url: string | null
  last_message_at: string | null
  classification: string | null
  score: number | null
  ai_analysis_summary: string | null
  ai_agent_id: string | null
  pipeline_stage?: string | null
  custom_name?: string | null
  custom_phone?: string | null
  created_at: string
}

export interface WhatsAppMessage {
  id: string
  user_id: string
  contact_id: string
  message_id: string
  from_me: boolean
  text: string | null
  type: string | null
  transcript: string | null
  timestamp: string
  raw: any
}
