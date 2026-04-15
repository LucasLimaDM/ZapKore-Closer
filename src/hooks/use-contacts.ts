import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from './use-auth'
import { WhatsAppContact } from '@/lib/types'

export const useContacts = (searchQuery: string = '') => {
  const { user } = useAuth()
  const [contacts, setContacts] = useState<WhatsAppContact[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) return

    const fetchContacts = async () => {
      let query = supabase
        .from('whatsapp_contacts')
        .select('*')
        .eq('user_id', user.id)
        .order('score', { ascending: false, nullsFirst: false })
        .order('last_message_at', { ascending: false, nullsFirst: false })

      if (searchQuery) {
        query = query.or(
          `push_name.ilike.%${searchQuery}%,phone_number.ilike.%${searchQuery}%,remote_jid.ilike.%${searchQuery}%`,
        )
      }

      const { data } = await query
      if (data) setContacts(data as WhatsAppContact[])
      setLoading(false)
    }

    fetchContacts()

    const channel = supabase
      .channel('contacts_changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'whatsapp_contacts',
          filter: `user_id=eq.${user.id}`,
        },
        () => {
          fetchContacts()
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [user, searchQuery])

  return { contacts, loading }
}
