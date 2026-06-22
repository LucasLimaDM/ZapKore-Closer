import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from './use-auth'

export interface AgentNotification {
  id: string
  user_id: string
  type: string
  code: string
  title: string
  body: string | null
  contact_id: string | null
  read_at: string | null
  created_at: string
}

export function useNotifications() {
  const { user } = useAuth()
  const [notifications, setNotifications] = useState<AgentNotification[]>([])

  const fetch = useCallback(async () => {
    if (!user) return
    const { data } = await supabase
      .from('agent_notifications')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50)
    if (data) setNotifications(data as AgentNotification[])
  }, [user])

  useEffect(() => {
    if (!user) return
    fetch()

    const channel = supabase
      .channel('agent_notifications_changes')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'agent_notifications',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          setNotifications((prev) => [payload.new as AgentNotification, ...prev])
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [user, fetch])

  const markAllRead = useCallback(async () => {
    if (!user) return
    const now = new Date().toISOString()
    await supabase
      .from('agent_notifications')
      .update({ read_at: now })
      .eq('user_id', user.id)
      .is('read_at', null)
    setNotifications((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? now })))
  }, [user])

  const unreadCount = notifications.filter((n) => !n.read_at).length

  return { notifications, unreadCount, markAllRead }
}
