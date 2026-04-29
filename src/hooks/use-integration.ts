import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from './use-auth'
import { UserIntegration } from '@/lib/types'

interface IntegrationContextType {
  integration: UserIntegration | null
  loading: boolean
  setIntegration: React.Dispatch<React.SetStateAction<UserIntegration | null>>
}

const IntegrationContext = createContext<IntegrationContextType | undefined>(undefined)

export const useIntegration = () => {
  const context = useContext(IntegrationContext)
  if (!context) throw new Error('useIntegration must be used within an IntegrationProvider')
  return context
}

export const IntegrationProvider = ({ children }: { children: ReactNode }) => {
  const { user } = useAuth()
  const [integration, setIntegration] = useState<UserIntegration | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) {
      setIntegration(null)
      setLoading(false)
      return
    }

    setLoading(true)

    const fetchIntegration = async () => {
      const { data, error } = await supabase
        .from('user_integrations')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle()

      if (!data) {
        const newIntegration = {
          user_id: user.id,
          instance_name: user.id,
          status: 'DISCONNECTED',
          is_setup_completed: false,
          is_webhook_enabled: false,
        }
        const { data: inserted } = await supabase
          .from('user_integrations')
          .insert(newIntegration as any)
          .select()
          .single()

        if (inserted) setIntegration(inserted as UserIntegration)
      } else if (data.instance_name !== user.id) {
        const { data: updated } = await supabase
          .from('user_integrations')
          .update({ instance_name: user.id } as any)
          .eq('id', data.id)
          .select()
          .single()

        if (updated) setIntegration(updated as UserIntegration)
      } else {
        setIntegration(data as UserIntegration)
      }
      setLoading(false)
    }

    fetchIntegration()

    const channel = supabase
      .channel('integration_changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'user_integrations',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          setIntegration((prev) => {
            // Merge with previous to prevent wiping optimistic local UI updates (like base64 fetch)
            return { ...(prev || {}), ...(payload.new as UserIntegration) }
          })
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [user])

  return React.createElement(
    IntegrationContext.Provider,
    { value: { integration, loading, setIntegration } },
    children,
  )
}
