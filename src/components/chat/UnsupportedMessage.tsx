import { getMessageTypeConfig } from '@/lib/message-types'
import { useLanguage } from '@/hooks/use-language'

interface UnsupportedMessageProps {
  type: string
}

export function UnsupportedMessage({ type }: UnsupportedMessageProps) {
  const { t } = useLanguage()
  const config = getMessageTypeConfig(type)
  const Icon = config.icon

  return (
    <div className="flex items-center gap-2.5">
      <Icon className="h-4 w-4 text-muted-foreground opacity-50 shrink-0" />
      <span className="text-muted-foreground italic text-[13px] sm:text-[14px] leading-relaxed">
        {t(config.translationKey)}
      </span>
    </div>
  )
}
