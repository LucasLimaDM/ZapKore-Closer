import { Trash2, Pencil } from 'lucide-react'
import { useLanguage } from '@/hooks/use-language'

interface ProtocolMessageProps {
  raw: any
}

const PROTOCOL_REVOKE = 0
const PROTOCOL_EDIT = 14

export function ProtocolMessage({ raw }: ProtocolMessageProps) {
  const { t } = useLanguage()
  const protocol = raw?.message?.protocolMessage
  const pType = protocol?.type

  if (pType === PROTOCOL_REVOKE) {
    return (
      <div className="flex items-center gap-2.5">
        <Trash2 className="h-4 w-4 text-muted-foreground opacity-50 shrink-0" />
        <span className="text-muted-foreground italic text-[13px] sm:text-[14px] leading-relaxed">
          {t('message_deleted')}
        </span>
      </div>
    )
  }

  if (pType === PROTOCOL_EDIT) {
    const editedText =
      protocol?.editedMessage?.conversation ||
      protocol?.editedMessage?.extendedTextMessage?.text

    if (editedText) {
      return (
        <div className="flex flex-col gap-1">
          <span className="whitespace-pre-wrap break-words">{editedText}</span>
          <span className="flex items-center gap-1 text-[10px] sm:text-[11px] opacity-60">
            <Pencil className="h-2.5 w-2.5" />
            {t('message_edited')}
          </span>
        </div>
      )
    }
  }

  // Unknown protocol type — render nothing visible
  return (
    <div className="flex items-center gap-2.5">
      <Trash2 className="h-4 w-4 text-muted-foreground opacity-50 shrink-0" />
      <span className="text-muted-foreground italic text-[13px] sm:text-[14px] leading-relaxed">
        {t('message_deleted')}
      </span>
    </div>
  )
}
