import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from './use-auth'
import { WhatsAppMessage } from '@/lib/types'

export const useMessages = (contactId: string | undefined) => {
  const { user } = useAuth()
  const [messages, setMessages] = useState<WhatsAppMessage[]>([])
  const [loading, setLoading] = useState(true)

  const fetchMessages = useCallback(async () => {
    if (!user || !contactId) return

    const { data, error } = await supabase
      .from('whatsapp_messages')
      .select('*')
      .eq('user_id', user.id)
      .eq('contact_id', contactId)
      .order('timestamp', { ascending: false })
      .limit(100)

    if (error) {
      console.error('[useMessages] Error fetching initial messages:', error)
    }

    if (data) setMessages(data as WhatsAppMessage[])
    setLoading(false)
  }, [user, contactId])

  useEffect(() => {
    if (!user || !contactId) return

    setLoading(true)
    fetchMessages()

    // ACCEPTANCE CRITERIA: Real-Time Integration & State Synchronization
    const channel = supabase
      .channel(`messages_${contactId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'whatsapp_messages',
          filter: `contact_id=eq.${contactId}`,
        },
        (payload) => {
          console.log('[useMessages] Realtime event received:', payload.eventType, payload.new?.id)

          if (payload.eventType === 'INSERT') {
            setMessages((prev) => {
              const newMsg = payload.new as WhatsAppMessage

              // Prevent state duplication locally if message was optimistically added or duplicate event fired
              if (prev.some((m) => m.id === newMsg.id || m.message_id === newMsg.message_id)) {
                return prev
              }

              // Ensure chronological sorting with newest first
              return [newMsg, ...prev].sort(
                (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
              )
            })
          } else if (payload.eventType === 'UPDATE') {
            setMessages((prev) => {
              const updatedMsg = payload.new as WhatsAppMessage
              return prev.map((m) => (m.id === updatedMsg.id ? { ...m, ...updatedMsg } : m))
            })
          } else if (payload.eventType === 'DELETE') {
            setMessages((prev) => prev.filter((m) => m.id !== payload.old.id))
          }
        },
      )
      .subscribe((status) => {
        console.log('[useMessages] Subscription status:', status)
      })

    return () => {
      console.log('[useMessages] Cleaning up subscription channel')
      supabase.removeChannel(channel)
    }
  }, [user, contactId, fetchMessages])

  return { messages, loading }
}
