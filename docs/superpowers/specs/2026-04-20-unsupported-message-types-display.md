# Unsupported Message Types Display

**Date:** 2026-04-20  
**Status:** Design approved

## Overview

Display user-friendly "not yet supported" messages for message types that Evolution API sends but the app doesn't yet render (images, videos, documents, locations, contacts, stickers, etc). Audio messages are already supported via `AudioPlayer` and excluded from this feature.

## Architecture

### Type Registry (`messageTypeConfig`)

A centralized configuration object mapping Evolution API message types to their UI representation:

```typescript
// src/lib/message-types.ts
export const messageTypeConfig: Record<string, MessageTypeInfo> = {
  imageMessage: { 
    label: 'image',
    translationKey: 'message_type_image',
    icon: Image 
  },
  videoMessage: { 
    label: 'video',
    translationKey: 'message_type_video',
    icon: Video 
  },
  documentMessage: { 
    label: 'document',
    translationKey: 'message_type_document',
    icon: FileText 
  },
  locationMessage: { 
    label: 'location',
    translationKey: 'message_type_location',
    icon: MapPin 
  },
  contactMessage: { 
    label: 'contact',
    translationKey: 'message_type_contact',
    icon: Contact 
  },
  stickerMessage: { 
    label: 'sticker',
    translationKey: 'message_type_sticker',
    icon: Smile 
  },
}

export type MessageTypeInfo = {
  label: string
  translationKey: TranslationKey
  icon: LucideIcon
}

export const isUnsupportedMessageType = (type: string | null): boolean => {
  return type !== null && type !== 'text' && type !== 'audioMessage' && type !== 'pttMessage' && type in messageTypeConfig
}
```

### Component: `UnsupportedMessage`

New component (`src/components/chat/UnsupportedMessage.tsx`) renders unsupported message types:

```typescript
interface UnsupportedMessageProps {
  type: string
  fromMe: boolean
}

export function UnsupportedMessage({ type, fromMe }: UnsupportedMessageProps) {
  const { t } = useLanguage()
  const config = messageTypeConfig[type]
  
  if (!config) return null
  
  const Icon = config.icon
  
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-muted-foreground opacity-60" />
      <span className="text-muted-foreground italic text-sm">
        {config.label} — {t(config.translationKey)}
      </span>
    </div>
  )
}
```

### Integration in Chat.tsx

Modify message rendering logic (lines 463-470) to check for unsupported types:

```typescript
{msg.type === 'audioMessage' || msg.type === 'pttMessage' ? (
  <AudioPlayer ... />
) : isUnsupportedMessageType(msg.type) ? (
  <UnsupportedMessage type={msg.type} fromMe={msg.from_me} />
) : (
  <span className="whitespace-pre-wrap break-words">{msg.text}</span>
)}
```

### Translations

Add keys to `src/lib/i18n/translations.ts`:

```typescript
message_type_image: {
  pt: 'Imagem ainda não suportada',
  en: 'Image not yet supported',
}
message_type_video: {
  pt: 'Vídeo ainda não suportado',
  en: 'Video not yet supported',
}
// ... etc for all types
```

## Files to Create/Modify

1. **Create:** `src/lib/message-types.ts` — type registry
2. **Create:** `src/components/chat/UnsupportedMessage.tsx` — component
3. **Modify:** `src/pages/Chat.tsx` — rendering logic
4. **Modify:** `src/lib/i18n/translations.ts` — translations

## Success Criteria

- When a message with type `imageMessage`, `videoMessage`, etc arrives, it displays "Imagem ainda não suportada" (or appropriate type/language)
- Audio messages (`audioMessage`, `pttMessage`) continue to use `AudioPlayer`
- Text messages render normally
- Type info is centralized and easy to extend
- Supports both Portuguese and English
