import { useEffect } from 'react'
import { X } from 'lucide-react'

interface MediaLightboxProps {
  blobUrl: string
  caption?: string | null
  onClose: () => void
}

export function MediaLightbox({ blobUrl, caption, onClose }: MediaLightboxProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 text-white/80 hover:text-white transition-colors"
        aria-label="Close"
      >
        <X className="h-6 w-6" />
      </button>
      <img
        src={blobUrl}
        className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
      {caption && (
        <p className="absolute bottom-6 left-0 right-0 text-center text-white text-sm px-8 drop-shadow">
          {caption}
        </p>
      )}
    </div>
  )
}
