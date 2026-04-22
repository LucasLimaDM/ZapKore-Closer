import { PlayCircle, Loader2, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MediaEntry } from '@/hooks/use-media-loader'
import { WhatsAppMessage } from '@/lib/types'

interface VideoMessageProps {
  msg: WhatsAppMessage
  entry: MediaEntry | undefined
  request: (messageId: string, contactId: string) => void
  fromMe: boolean
}

function getThumbnailDataUrl(raw: any): string | null {
  const b64 = raw?.message?.videoMessage?.jpegThumbnail
  if (!b64) return null
  return `data:image/jpeg;base64,${b64}`
}

function getCaption(raw: any): string | null {
  return raw?.message?.videoMessage?.caption ?? null
}

export function VideoMessage({ msg, entry, request, fromMe }: VideoMessageProps) {
  const thumbnail = getThumbnailDataUrl(msg.raw)
  const caption = getCaption(msg.raw)
  const status = entry?.status ?? 'idle'
  const blobUrl = entry?.blobUrl ?? null

  const handlePlayClick = () => {
    if (status === 'idle') request(msg.message_id, msg.contact_id)
  }

  return (
    <div className="flex flex-col gap-1.5 w-[240px] sm:w-[280px]">
      <div className="relative w-full rounded-xl overflow-hidden bg-muted aspect-[4/3]">
        {thumbnail && !blobUrl && (
          <img src={thumbnail} className="absolute inset-0 w-full h-full object-cover" />
        )}

        {blobUrl && (
          <video
            src={blobUrl}
            controls
            autoPlay
            className="absolute inset-0 w-full h-full object-cover"
          />
        )}

        {!blobUrl && (
          <div
            className={cn(
              'absolute inset-0 flex items-center justify-center',
              'bg-black/30',
              status === 'idle' && 'cursor-pointer hover:bg-black/40 transition-colors',
            )}
            onClick={handlePlayClick}
          >
            {status === 'loading' ? (
              <Loader2 className="h-10 w-10 text-white animate-spin" />
            ) : status === 'error' ? (
              <AlertCircle className="h-8 w-8 text-white/70" />
            ) : (
              <PlayCircle className="h-12 w-12 text-white drop-shadow-lg" />
            )}
          </div>
        )}

        {!thumbnail && !blobUrl && status === 'idle' && (
          <div className="absolute inset-0 bg-muted" />
        )}
      </div>

      {caption && (
        <span
          className={cn(
            'text-[13px] leading-snug px-0.5',
            fromMe ? 'text-primary-foreground/90' : 'text-foreground/80',
          )}
        >
          {caption}
        </span>
      )}
    </div>
  )
}
