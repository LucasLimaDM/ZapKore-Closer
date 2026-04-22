import { useRef, useEffect } from 'react'
import { ImageIcon, AlertCircle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MediaEntry } from '@/hooks/use-media-loader'
import { WhatsAppMessage } from '@/lib/types'

interface ImageMessageProps {
  msg: WhatsAppMessage
  entry: MediaEntry | undefined
  request: (messageId: string, contactId: string) => void
  fromMe: boolean
  onOpenLightbox: (blobUrl: string, caption: string | null) => void
}

function getThumbnailDataUrl(raw: any): string | null {
  const b64 = raw?.message?.imageMessage?.jpegThumbnail
  if (!b64) return null
  return `data:image/jpeg;base64,${b64}`
}

function getCaption(raw: any): string | null {
  return raw?.message?.imageMessage?.caption ?? null
}

export function ImageMessage({ msg, entry, request, fromMe, onOpenLightbox }: ImageMessageProps) {
  const ref = useRef<HTMLDivElement>(null)
  const requested = useRef(false)

  const thumbnail = getThumbnailDataUrl(msg.raw)
  const caption = getCaption(msg.raw)
  const status = entry?.status ?? 'idle'
  const blobUrl = entry?.blobUrl ?? null

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !requested.current) {
          requested.current = true
          request(msg.message_id, msg.contact_id)
        }
      },
      { rootMargin: '200px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [msg.message_id, msg.contact_id, request])

  const handleClick = () => {
    if (blobUrl) onOpenLightbox(blobUrl, caption)
  }

  return (
    <div ref={ref} className="flex flex-col gap-1.5 w-[240px] sm:w-[280px]">
      <div
        className={cn(
          'relative w-full rounded-xl overflow-hidden bg-muted',
          'aspect-[4/3]',
          blobUrl && 'cursor-pointer',
        )}
        onClick={handleClick}
      >
        {thumbnail && (
          <img
            src={thumbnail}
            className={cn(
              'absolute inset-0 w-full h-full object-cover transition-all duration-300',
              status !== 'ready' ? 'blur-md scale-105' : 'blur-0 scale-100',
            )}
          />
        )}

        {blobUrl && (
          <img src={blobUrl} className="absolute inset-0 w-full h-full object-cover" />
        )}

        {status === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/25">
            <Loader2 className="h-10 w-10 text-white animate-spin" />
          </div>
        )}

        {status === 'error' && !thumbnail && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <AlertCircle className="h-8 w-8 opacity-50" />
            <ImageIcon className="h-6 w-6 opacity-30" />
          </div>
        )}

        {status === 'idle' && !thumbnail && (
          <div className="absolute inset-0 flex items-center justify-center bg-muted">
            <ImageIcon className="h-12 w-12 text-muted-foreground opacity-30" />
          </div>
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
