import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from './use-auth'
import { AIAgent } from '@/lib/types'
import { toast } from 'sonner'

export const useAgents = () => {
  const { user } = useAuth()
  const [agents, setAgents] = useState<AIAgent[]>([])
  const [loading, setLoading] = useState(true)

  const fetchAgents = useCallback(async () => {
    if (!user) return
    setLoading(true)
    const { data, error } = await supabase
      .from('ai_agents')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Error fetching agents:', error)
      toast.error('Failed to load AI agents')
    } else if (data) {
      setAgents(data as AIAgent[])
    }
    setLoading(false)
  }, [user])

  useEffect(() => {
    fetchAgents()
  }, [fetchAgents])

  const createAgent = async (agent: Partial<AIAgent>) => {
    if (!user) return
    const { data, error } = await supabase
      .from('ai_agents')
      .insert({
        user_id: user.id,
        name: agent.name!,
        description: agent.description,
        system_prompt: agent.system_prompt!,
        api_key_id: agent.api_key_id,
        audio_api_key_id: agent.audio_api_key_id || null,
        model_id: agent.model_id || null,
        memory_limit: agent.memory_limit ?? 20,
        message_delay: agent.message_delay ?? 0,
        human_handoff_enabled: agent.human_handoff_enabled ?? false,
        is_active: agent.is_active,
        is_default: agent.is_default,
      })
      .select()
      .single()

    if (error) {
      console.error('Error creating agent:', error)
      toast.error('Failed to create agent')
      throw error
    }

    toast.success('Agent created successfully')
    if (agent.is_default) {
      setAgents((prev) => [data as AIAgent, ...prev.map((a) => ({ ...a, is_default: false }))])
    } else {
      setAgents((prev) => [data as AIAgent, ...prev])
    }
    return data
  }

  const updateAgent = async (id: string, agent: Partial<AIAgent>) => {
    if (!user) return
    const { data, error } = await supabase
      .from('ai_agents')
      .update({
        name: agent.name,
        description: agent.description,
        system_prompt: agent.system_prompt,
        api_key_id: agent.api_key_id,
        audio_api_key_id: agent.audio_api_key_id ?? null,
        model_id: agent.model_id,
        memory_limit: agent.memory_limit,
        message_delay: agent.message_delay,
        human_handoff_enabled: agent.human_handoff_enabled,
        is_active: agent.is_active,
        is_default: agent.is_default,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('user_id', user.id)
      .select()
      .single()

    if (error) {
      console.error('Error updating agent:', error)
      toast.error('Failed to update agent')
      throw error
    }

    toast.success('Agent updated successfully')
    if (agent.is_default) {
      setAgents((prev) =>
        prev.map((a) => (a.id === id ? (data as AIAgent) : { ...a, is_default: false })),
      )
    } else {
      setAgents((prev) => prev.map((a) => (a.id === id ? (data as AIAgent) : a)))
    }
    return data
  }
  const deleteAgent = async (id: string) => {
    if (!user) return
    const { error } = await supabase.from('ai_agents').delete().eq('id', id).eq('user_id', user.id)

    if (error) {
      console.error('Error deleting agent:', error)
      toast.error('Failed to delete agent')
      throw error
    }

    toast.success('Agent deleted successfully')
    setAgents((prev) => prev.filter((a) => a.id !== id))
  }

  const toggleAgentStatus = async (id: string, currentStatus: boolean) => {
    if (!user) return
    const newStatus = !currentStatus
    const { error } = await supabase
      .from('ai_agents')
      .update({ is_active: newStatus, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', user.id)

    if (error) {
      console.error('Error toggling agent status:', error)
      toast.error('Failed to update status')
      throw error
    }

    setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, is_active: newStatus } : a)))
  }

  const setAsDefault = async (id: string) => {
    if (!user) return
    const { error } = await supabase
      .from('ai_agents')
      .update({ is_default: true, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', user.id)

    if (error) {
      console.error('Error setting default agent:', error)
      toast.error('Failed to set default agent')
      throw error
    }

    toast.success('Default agent updated')
    setAgents((prev) =>
      prev.map((a) => ({
        ...a,
        is_default: a.id === id,
      })),
    )
  }

  return {
    agents,
    loading,
    refetch: fetchAgents,
    createAgent,
    updateAgent,
    deleteAgent,
    toggleAgentStatus,
    setAsDefault,
  }
}
