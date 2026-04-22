import { useEffect } from 'react'
import { Smile, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MediaEntry } from '@/hooks/use-media-loader'
import { WhatsAppMessage } from '@/lib/types'

interface StickerMessageProps {
  msg: WhatsAppMessage
  entry: MediaEntry | undefined
  request: (messageId: string, contactId: string) => void
}

function getThumbnailDataUrl(raw: any): string | null {
  const b64 = raw?.message?.stickerMessage?.jpegThumbnail
  if (!b64) return null
  return `data:image/jpeg;base64,${b64}`
}

export function StickerMessage({ msg, entry, request }: StickerMessageProps) {
  const thumbnail = getThumbnailDataUrl(msg.raw)
  const status = entry?.status ?? 'idle'
  const blobUrl = entry?.blobUrl ?? null

  useEffect(() => {
    request(msg.message_id, msg.contact_id)
  }, [msg.message_id, msg.contact_id, request])

  return (
    <div className="relative w-[160px] h-[160px]">
      {thumbnail && !blobUrl && (
        <img
          src={thumbnail}
          className={cn(
            'absolute inset-0 w-full h-full object-contain',
            status === 'loading' && 'blur-sm scale-105',
          )}
        />
      )}

      {blobUrl && (
        <img src={blobUrl} className="absolute inset-0 w-full h-full object-contain" />
      )}

      {status === 'loading' && !thumbnail && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="h-8 w-8 text-muted-foreground animate-spin" />
        </div>
      )}

      {status === 'error' && !thumbnail && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-muted-foreground">
          <Smile className="h-8 w-8 opacity-30" />
        </div>
      )}
    </div>
  )
}
