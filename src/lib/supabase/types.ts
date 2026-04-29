export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      ai_agents: {
        Row: {
          api_key_id: string | null
          audio_api_key_id: string | null
          created_at: string | null
          description: string | null
          id: string
          is_active: boolean | null
          is_default: boolean
          memory_limit: number
          message_delay: number
          model_id: string | null
          name: string
          system_prompt: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          api_key_id?: string | null
          audio_api_key_id?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          is_default?: boolean
          memory_limit?: number
          message_delay?: number
          model_id?: string | null
          name: string
          system_prompt: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          api_key_id?: string | null
          audio_api_key_id?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          is_default?: boolean
          memory_limit?: number
          message_delay?: number
          model_id?: string | null
          name?: string
          system_prompt?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agents_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "user_api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_agents_audio_api_key_id_fkey"
            columns: ["audio_api_key_id"]
            isOneToOne: false
            referencedRelation: "user_api_keys"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_identity: {
        Row: {
          canonical_phone: string | null
          created_at: string | null
          display_name: string | null
          id: string
          instance_id: string
          lid_jid: string | null
          phone_jid: string | null
          user_id: string
        }
        Insert: {
          canonical_phone?: string | null
          created_at?: string | null
          display_name?: string | null
          id?: string
          instance_id: string
          lid_jid?: string | null
          phone_jid?: string | null
          user_id: string
        }
        Update: {
          canonical_phone?: string | null
          created_at?: string | null
          display_name?: string | null
          id?: string
          instance_id?: string
          lid_jid?: string | null
          phone_jid?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_identity_instance_id_fkey"
            columns: ["instance_id"]
            isOneToOne: false
            referencedRelation: "user_integrations"
            referencedColumns: ["id"]
          },
        ]
      }
      import_jobs: {
        Row: {
          created_at: string | null
          id: string
          processed_items: number | null
          status: string | null
          total_items: number | null
          type: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          processed_items?: number | null
          status?: string | null
          total_items?: number | null
          type: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          processed_items?: number | null
          status?: string | null
          total_items?: number | null
          type?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_api_keys: {
        Row: {
          created_at: string | null
          id: string
          key: string
          key_type: string
          name: string
          provider: string | null
          settings: Json | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          key: string
          key_type?: string
          name: string
          provider?: string | null
          settings?: Json | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          key?: string
          key_type?: string
          name?: string
          provider?: string | null
          settings?: Json | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_integrations: {
        Row: {
          created_at: string | null
          evolution_api_key: string | null
          evolution_api_url: string | null
          id: string
          instance_name: string | null
          is_setup_completed: boolean
          is_webhook_enabled: boolean
          status: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          evolution_api_key?: string | null
          evolution_api_url?: string | null
          id?: string
          instance_name?: string | null
          is_setup_completed?: boolean
          is_webhook_enabled?: boolean
          status?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          evolution_api_key?: string | null
          evolution_api_url?: string | null
          id?: string
          instance_name?: string | null
          is_setup_completed?: boolean
          is_webhook_enabled?: boolean
          status?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      whatsapp_contacts: {
        Row: {
          ai_agent_id: string | null
          ai_analysis_summary: string | null
          ai_trigger_version: number
          classification: string | null
          created_at: string | null
          custom_name: string | null
          custom_phone: string | null
          id: string
          last_message_at: string | null
          phone_number: string | null
          pipeline_stage: string | null
          profile_picture_url: string | null
          push_name: string | null
          remote_jid: string
          score: number | null
          user_id: string
        }
        Insert: {
          ai_agent_id?: string | null
          ai_analysis_summary?: string | null
          ai_trigger_version?: number
          classification?: string | null
          created_at?: string | null
          custom_name?: string | null
          custom_phone?: string | null
          id?: string
          last_message_at?: string | null
          phone_number?: string | null
          pipeline_stage?: string | null
          profile_picture_url?: string | null
          push_name?: string | null
          remote_jid: string
          score?: number | null
          user_id: string
        }
        Update: {
          ai_agent_id?: string | null
          ai_analysis_summary?: string | null
          ai_trigger_version?: number
          classification?: string | null
          created_at?: string | null
          custom_name?: string | null
          custom_phone?: string | null
          id?: string
          last_message_at?: string | null
          phone_number?: string | null
          pipeline_stage?: string | null
          profile_picture_url?: string | null
          push_name?: string | null
          remote_jid?: string
          score?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_contacts_ai_agent_id_fkey"
            columns: ["ai_agent_id"]
            isOneToOne: false
            referencedRelation: "ai_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_messages: {
        Row: {
          contact_id: string | null
          created_at: string | null
          from_me: boolean | null
          id: string
          message_id: string
          raw: Json | null
          text: string | null
          timestamp: string | null
          transcript: string | null
          type: string | null
          user_id: string
        }
        Insert: {
          contact_id?: string | null
          created_at?: string | null
          from_me?: boolean | null
          id?: string
          message_id: string
          raw?: Json | null
          text?: string | null
          timestamp?: string | null
          transcript?: string | null
          type?: string | null
          user_id: string
        }
        Update: {
          contact_id?: string | null
          created_at?: string | null
          from_me?: boolean | null
          id?: string
          message_id?: string
          raw?: Json | null
          text?: string | null
          timestamp?: string | null
          transcript?: string | null
          type?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_messages_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_contacts"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      increment_ai_trigger_version: {
        Args: { p_contact_id: string }
        Returns: number
      }
      merge_whatsapp_contacts: {
        Args: {
          p_primary_contact_id: string
          p_secondary_contact_ids: string[]
          p_user_id: string
        }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
