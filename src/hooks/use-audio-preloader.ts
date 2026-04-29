import { useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { WhatsAppMessage } from '@/lib/types'

export type AudioStatus = 'loading' | 'ready' | 'error'

export interface AudioEntry {
  status: AudioStatus
  blobUrl: string | null
}

const AUDIO_TYPES = new Set(['audioMessage', 'pttMessage'])

export function useAudioPreloader(messages: WhatsAppMessage[]): Map<string, AudioEntry> {
  const mapRef = useRef<Map<string, AudioEntry>>(new Map())
  const [, forceUpdate] = useState(0)

  useEffect(() => {
    const audioMessages = messages.filter(
      (m) => m.type && AUDIO_TYPES.has(m.type) && !mapRef.current.has(m.message_id),
    )

    if (audioMessages.length === 0) return

    for (const msg of audioMessages) {
      mapRef.current.set(msg.message_id, { status: 'loading', blobUrl: null })
    }
    forceUpdate((n) => n + 1)

    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
    const supabaseAnonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string

    let cancelled = false

    const fetchAll = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token || cancelled) return

      await Promise.allSettled(
        audioMessages.map(async (msg) => {
          try {
            const res = await fetch(
              `${supabaseUrl}/functions/v1/evolution-get-media`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${token}`,
                  apikey: supabaseAnonKey,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  messageId: msg.message_id,
                  contactId: msg.contact_id,
                }),
              },
            )

            if (!res.ok) throw new Error(`HTTP ${res.status}`)

            const blob = await res.blob()
            const blobUrl = URL.createObjectURL(blob)

            if (!cancelled) {
              mapRef.current.set(msg.message_id, { status: 'ready', blobUrl })
              forceUpdate((n) => n + 1)
            } else {
              URL.revokeObjectURL(blobUrl)
            }
          } catch {
            if (!cancelled) {
              mapRef.current.set(msg.message_id, { status: 'error', blobUrl: null })
              forceUpdate((n) => n + 1)
            }
          }
        }),
      )
    }

    fetchAll()

    return () => {
      cancelled = true
    }
  }, [messages.length]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      for (const entry of mapRef.current.values()) {
        if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl)
      }
      mapRef.current.clear()
    }
  }, [])

  return mapRef.current
}
