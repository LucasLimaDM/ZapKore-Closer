import { useRef, useState, useEffect } from 'react'
import { Play, Pause, Loader2, MicOff, ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'

interface AudioPlayerProps {
  blobUrl: string | null
  isLoading: boolean
  fromMe: boolean
  transcript?: string | null
}

const SPEED_CYCLE = [1, 1.25, 1.5, 2] as const
type PlaybackRate = (typeof SPEED_CYCLE)[number]

function formatTime(seconds: number): string {
  if (!isFinite(seconds)) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function AudioPlayer({ blobUrl, isLoading, fromMe, transcript }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [speed, setSpeed] = useState<PlaybackRate>(1)
  const [transcriptCollapsed, setTranscriptCollapsed] = useState(false)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const onTimeUpdate = () => setCurrentTime(audio.currentTime)
    const onDurationChange = () => setDuration(audio.duration)
    const onLoadedMetadata = () => setDuration(audio.duration)
    const onEnded = () => {
      setIsPlaying(false)
      setCurrentTime(0)
    }

    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('durationchange', onDurationChange)
    audio.addEventListener('loadedmetadata', onLoadedMetadata)
    audio.addEventListener('ended', onEnded)

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('durationchange', onDurationChange)
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('ended', onEnded)
    }
  }, [blobUrl])

  const togglePlay = () => {
    const audio = audioRef.current
    if (!audio || !blobUrl) return
    if (isPlaying) {
      audio.pause()
      setIsPlaying(false)
    } else {
      audio.play()
      setIsPlaying(true)
    }
  }

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current
    if (!audio) return
    const value = parseFloat(e.target.value)
    audio.currentTime = value
    setCurrentTime(value)
  }

  const cycleSpeed = () => {
    const audio = audioRef.current
    const idx = SPEED_CYCLE.indexOf(speed)
    const next = SPEED_CYCLE[(idx + 1) % SPEED_CYCLE.length]
    setSpeed(next)
    if (audio) audio.playbackRate = next
  }

  const isReady = !isLoading && !!blobUrl
  const isError = !isLoading && !blobUrl

  return (
    <div className="flex flex-col gap-1.5 min-w-[240px] max-w-full">
      <div
        className={cn(
          'flex items-center gap-2.5 px-3 py-2.5 rounded-[1.25rem] sm:rounded-[1.5rem] shadow-sm',
          fromMe
            ? 'bg-primary text-primary-foreground rounded-br-sm'
            : 'bg-card border border-border/60 text-foreground rounded-bl-sm',
        )}
      >
        {blobUrl && <audio ref={audioRef} src={blobUrl} preload="metadata" />}

        <button
          onClick={togglePlay}
          disabled={!isReady}
          className={cn(
            'shrink-0 flex items-center justify-center h-9 w-9 rounded-full transition-colors',
            fromMe
              ? 'bg-white/20 hover:bg-white/30 disabled:opacity-50'
              : 'bg-primary/10 hover:bg-primary/20 disabled:opacity-50',
          )}
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : isError ? (
            <MicOff className="h-4 w-4 opacity-60" />
          ) : isPlaying ? (
            <Pause className="h-4 w-4" />
          ) : (
            <Play className="h-4 w-4 ml-0.5" />
          )}
        </button>

        <div className="flex flex-col gap-1 flex-1 min-w-0">
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={currentTime}
            onChange={handleSeek}
            disabled={!isReady}
            className={cn(
              'w-full h-1 rounded-full appearance-none cursor-pointer disabled:cursor-not-allowed',
              'bg-current opacity-30',
              '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3',
              '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-current [&::-webkit-slider-thumb]:opacity-100',
            )}
          />
          <div className="flex justify-between text-[10px] font-bold opacity-60 tabular-nums">
            <span>{formatTime(currentTime)}</span>
            <span>{isLoading ? '...' : formatTime(duration)}</span>
          </div>
        </div>

        <button
          onClick={cycleSpeed}
          disabled={!isReady}
          className={cn(
            'shrink-0 text-[10px] font-extrabold tabular-nums w-8 text-center',
            'opacity-70 hover:opacity-100 transition-opacity disabled:opacity-30',
          )}
        >
          {speed === 1 ? '1x' : `${speed}x`}
        </button>
      </div>

      {transcript && (
        <div
          className={cn(
            'rounded-xl border px-3 py-2 text-xs',
            fromMe
              ? 'bg-primary/10 border-primary/20 text-primary-foreground/80'
              : 'bg-muted/40 border-border/40 text-muted-foreground',
          )}
        >
          <button
            type="button"
            onClick={() => setTranscriptCollapsed((v) => !v)}
            className="flex items-center justify-between w-full mb-1 opacity-70 hover:opacity-100 transition-opacity"
          >
            <span className="text-[10px] uppercase tracking-widest font-semibold">Transcrição</span>
            {transcriptCollapsed ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronUp className="h-3 w-3" />
            )}
          </button>
          {!transcriptCollapsed && (
            <p className="italic border-l-2 border-current pl-2 opacity-80 leading-relaxed">
              {transcript}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
