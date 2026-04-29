import { useLanguage } from '@/hooks/use-language'

interface ReactionMessageProps {
  raw: any
}

export function ReactionMessage({ raw }: ReactionMessageProps) {
  const { t } = useLanguage()
  const emoji = raw?.message?.reactionMessage?.text

  // Empty string means the reaction was removed — treat as unsupported stub
  if (!emoji) {
    return (
      <span className="text-muted-foreground italic text-[13px] sm:text-[14px] leading-relaxed">
        {t('reaction_removed')}
      </span>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-[22px] leading-none">{emoji}</span>
      <span className="text-muted-foreground italic text-[13px] sm:text-[14px] leading-relaxed">
        {t('reaction_to_message')}
      </span>
    </div>
  )
}
