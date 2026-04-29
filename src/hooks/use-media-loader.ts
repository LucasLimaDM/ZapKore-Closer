import { useEffect, useRef, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase/client'

export type MediaStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface MediaEntry {
  status: MediaStatus
  blobUrl: string | null
}

const MAX_CONCURRENT = 3

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string

interface QueueItem {
  messageId: string
  contactId: string
}

export function useMediaLoader(): {
  mediaMap: Map<string, MediaEntry>
  request: (messageId: string, contactId: string) => void
} {
  const mapRef = useRef<Map<string, MediaEntry>>(new Map())
  const activeRef = useRef(0)
  const queueRef = useRef<QueueItem[]>([])
  const [, forceUpdate] = useState(0)

  const processQueue = useCallback(async () => {
    while (activeRef.current < MAX_CONCURRENT && queueRef.current.length > 0) {
      const item = queueRef.current.shift()!
      activeRef.current++

      ;(async () => {
        try {
          const {
            data: { session },
          } = await supabase.auth.getSession()
          const token = session?.access_token
          if (!token) throw new Error('no token')

          const res = await fetch(`${supabaseUrl}/functions/v1/evolution-get-media`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              apikey: supabaseAnonKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ messageId: item.messageId, contactId: item.contactId }),
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const blob = await res.blob()
          const blobUrl = URL.createObjectURL(blob)
          mapRef.current.set(item.messageId, { status: 'ready', blobUrl })
        } catch {
          mapRef.current.set(item.messageId, { status: 'error', blobUrl: null })
        } finally {
          activeRef.current--
          forceUpdate((n) => n + 1)
          processQueue()
        }
      })()
    }
  }, [])

  const request = useCallback(
    (messageId: string, contactId: string) => {
      const current = mapRef.current.get(messageId)
      if (current && current.status !== 'idle') return
      mapRef.current.set(messageId, { status: 'loading', blobUrl: null })
      queueRef.current.push({ messageId, contactId })
      forceUpdate((n) => n + 1)
      processQueue()
    },
    [processQueue],
  )

  useEffect(() => {
    return () => {
      for (const entry of mapRef.current.values()) {
        if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl)
      }
      mapRef.current.clear()
      queueRef.current = []
    }
  }, [])

  return { mediaMap: mapRef.current, request }
}
