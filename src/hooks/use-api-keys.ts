import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from './use-auth'
import { UserAPIKey } from '@/lib/types'
import { toast } from 'sonner'

export const useAPIKeys = () => {
  const { user } = useAuth()
  const [apiKeys, setAPIKeys] = useState<UserAPIKey[]>([])
  const [loading, setLoading] = useState(true)

  const fetchAPIKeys = useCallback(async () => {
    if (!user) return
    setLoading(true)
    const { data, error } = await supabase
      .from('user_api_keys')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Error fetching API keys:', error)
      toast.error('Failed to load API keys')
    } else if (data) {
      setAPIKeys(data as UserAPIKey[])
    }
    setLoading(false)
  }, [user])

  useEffect(() => {
    fetchAPIKeys()
  }, [fetchAPIKeys])

  const createAPIKey = async (apiKey: Partial<UserAPIKey>) => {
    if (!user) return
    const { data, error } = await supabase
      .from('user_api_keys')
      .insert({
        user_id: user.id,
        name: apiKey.name!,
        key: apiKey.key!,
        provider: apiKey.provider || 'openrouter',
        key_type: apiKey.key_type || 'ai',
      })
      .select()
      .single()

    if (error) {
      console.error('Error creating API key:', error)
      toast.error('Failed to create API key')
      throw error
    }

    setAPIKeys((prev) => [data as UserAPIKey, ...prev])
    return data as UserAPIKey
  }

  const deleteAPIKey = async (id: string) => {
    if (!user) return
    const { error } = await supabase.from('user_api_keys').delete().eq('id', id).eq('user_id', user.id)

    if (error) {
      console.error('Error deleting API key:', error)
      toast.error('Failed to delete API key')
      throw error
    }

    toast.success('API key deleted successfully')
    setAPIKeys((prev) => prev.filter((k) => k.id !== id))
  }

  const audioKeys = apiKeys.filter((k) => k.key_type === 'audio')
  const aiKeys = apiKeys.filter((k) => k.key_type !== 'audio')

  return {
    apiKeys,
    aiKeys,
    audioKeys,
    loading,
    refetch: fetchAPIKeys,
    createAPIKey,
    deleteAPIKey,
  }
}
