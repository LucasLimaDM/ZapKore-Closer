import { Image, Video, FileText, MapPin, Contact2, Smile, File, type LucideIcon } from 'lucide-react'
import { type TranslationKey } from '@/hooks/use-language'

export type MessageTypeInfo = {
  label: string
  translationKey: TranslationKey
  icon: LucideIcon
}

export const messageTypeConfig: Record<string, MessageTypeInfo> = {
  imageMessage: {
    label: 'image',
    translationKey: 'message_type_image',
    icon: Image,
  },
  videoMessage: {
    label: 'video',
    translationKey: 'message_type_video',
    icon: Video,
  },
  documentMessage: {
    label: 'document',
    translationKey: 'message_type_document',
    icon: FileText,
  },
  documentWithCaptionMessage: {
    label: 'document',
    translationKey: 'message_type_document',
    icon: FileText,
  },
  locationMessage: {
    label: 'location',
    translationKey: 'message_type_location',
    icon: MapPin,
  },
  contactMessage: {
    label: 'contact',
    translationKey: 'message_type_contact',
    icon: Contact2,
  },
  stickerMessage: {
    label: 'sticker',
    translationKey: 'message_type_sticker',
    icon: Smile,
  },
}

// Types that are rendered by their own dedicated components (not the generic unsupported fallback)
const HANDLED_TYPES = new Set([
  'text',
  'conversation',
  'extendedTextMessage',
  'audioMessage',
  'pttMessage',
  'reactionMessage',
  'protocolMessage',
  'imageMessage',
  'videoMessage',
  'stickerMessage',
])

export const isUnsupportedMessageType = (type: string | null): boolean => {
  if (type === null) return false
  return !HANDLED_TYPES.has(type)
}

// WhatsApp protocol/coordination messages with no user-visible content.
// albumMessage = grouping signal sent when multiple images are sent at once (actual images arrive as imageMessage).
// associatedChildMessage = album child coordination message.
// placeholderMessage = internal placeholder with no content.
export const SILENT_MESSAGE_TYPES = new Set([
  'albumMessage',
  'associatedChildMessage',
  'placeholderMessage',
])

// Sentinel string the webhook stores when it can't extract readable text from a message.
// Historical data contains this literal; new data should use null (see evolution-webhook).
export const UNSUPPORTED_TEXT_SENTINEL = '[Media/Unsupported]'

// True when a "text-type" message has no displayable content and should fall back
// to the generic unsupported-media UI instead of rendering raw text.
export const hasUnrenderableText = (text: string | null | undefined): boolean => {
  if (text === null || text === undefined) return true
  const trimmed = text.trim()
  return trimmed === '' || trimmed === UNSUPPORTED_TEXT_SENTINEL
}

export const getMessageTypeConfig = (type: string): MessageTypeInfo => {
  return messageTypeConfig[type] ?? {
    label: 'media',
    translationKey: 'message_type_media',
    icon: File,
  }
}
