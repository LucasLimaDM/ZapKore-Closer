import { useEffect, useState, useRef } from 'react'
import { getContactDisplayName, getContactDisplaySubtitle } from '@/lib/format'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { useAgents } from '@/hooks/use-agents'
import { useLanguage, TranslationKey } from '@/hooks/use-language'
import { WhatsAppContact, WhatsAppMessage } from '@/lib/types'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ArrowLeft, Send, Sparkles, Loader2, Edit2, Check, X } from 'lucide-react'
import { toast } from 'sonner'
import { format, isToday, isYesterday } from 'date-fns'
import { ptBR, enUS } from 'date-fns/locale'
import { cn } from '@/lib/utils'

export default function Chat() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { agents } = useAgents()
  const { t, language } = useLanguage()
  const dateLocale = language === 'pt' ? ptBR : enUS

  const [contact, setContact] = useState<WhatsAppContact | null>(null)
  const [messages, setMessages] = useState<WhatsAppMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [newMessage, setNewMessage] = useState('')
  const [isSending, setIsSending] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Editing contact state
  const [isEditingContact, setIsEditingContact] = useState(false)
  const [editedName, setEditedName] = useState('')
  const [editedPhone, setEditedPhone] = useState('')
  const [isUpdatingContact, setIsUpdatingContact] = useState(false)

  useEffect(() => {
    if (!user || !id) return

    const fetchChat = async () => {
      const { data: contactData } = await supabase
        .from('whatsapp_contacts')
        .select('*')
        .eq('id', id)
        .single()

      if (contactData) setContact(contactData)

      const { data: messagesData } = await supabase
        .from('whatsapp_messages')
        .select('*')
        .eq('contact_id', id)
        .order('timestamp', { ascending: true })

      if (messagesData) setMessages(messagesData)
      setLoading(false)
      scrollToBottom()
    }

    fetchChat()

    const channel = supabase
      .channel(`chat_${id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'whatsapp_messages',
          filter: `contact_id=eq.${id}`,
        },
        (payload) => {
          setMessages((prev) => {
            if (payload.eventType === 'UPDATE') {
              return prev.map((m) => (m.id === payload.new.id ? (payload.new as WhatsAppMessage) : m))
            }
            if (prev.find((m) => m.id === payload.new.id)) return prev
            return [...prev, payload.new as WhatsAppMessage]
          })
          scrollToBottom()
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [user, id])

  const scrollToBottom = () => {
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, 100)
  }

  const startEditing = () => {
    setIsEditingContact(true)
    setEditedName(contact?.custom_name || contact?.push_name || '')
    setEditedPhone(contact?.custom_phone || contact?.phone_number || contact?.remote_jid?.split('@')[0] || '')
  }

  const saveContactEdits = async () => {
    if (!contact) return
    setIsUpdatingContact(true)
    const { error } = await supabase
      .from('whatsapp_contacts')
      .update({
        custom_name: editedName.trim() || null,
        custom_phone: editedPhone.replace(/\D/g, '') || null,
      })
      .eq('id', contact.id)

    if (error) {
      toast.error(t('error_save' as TranslationKey) || 'Failed to save changes')
    } else {
      setContact((prev) => (prev ? { ...prev, custom_name: editedName, custom_phone: editedPhone } : null))
      toast.success(t('contact_updated' as TranslationKey) || 'Contact updated')
      setIsEditingContact(false)
    }
    setIsUpdatingContact(false)
  }

  const handleAgentChange = async (value: string) => {
    // Treat 'none_disable' as a proxy for no agent assigned (null in database)
    const newAgentId = value === 'none_disable' ? null : value
    const { error } = await supabase
      .from('whatsapp_contacts')
      .update({ ai_agent_id: newAgentId })
      .eq('id', id)

    if (error) {
      toast.error(t('error_save' as TranslationKey) || 'Failed to save changes')
    } else {
      setContact((prev) => (prev ? { ...prev, ai_agent_id: newAgentId } : null))
      toast.success(
        newAgentId
          ? t('agent_assigned' as TranslationKey) || 'Agent assigned'
          : t('agent_removed' as TranslationKey) || 'Agent removed',
      )
    }
  }

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newMessage.trim() || !contact) return

    const text = newMessage.trim()
    setNewMessage('')
    setIsSending(true)

    try {
      const { data, error } = await supabase.functions.invoke('evolution-send-message', {
        body: { contactId: contact.id, text },
      })
      if (error) throw error
      if (data?.error) throw new Error(data.error)
    } catch (err: any) {
      toast.error(err.message || 'Failed to send message')
    } finally {
      setIsSending(false)
    }
  }

  const formatMessageTime = (dateStr: string) => {
    const date = new Date(dateStr)
    return format(date, 'HH:mm')
  }

  const formatMessageDate = (dateStr: string) => {
    const date = new Date(dateStr)
    if (isToday(date)) return language === 'pt' ? 'Hoje' : 'Today'
    if (isYesterday(date)) return language === 'pt' ? 'Ontem' : 'Yesterday'
    return format(date, 'dd/MM/yyyy', { locale: dateLocale })
  }

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground/50" />
      </div>
    )
  }

  if (!contact) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-12">
        <p className="text-muted-foreground font-medium">{t('no_contacts_found')}</p>
        <Button
          variant="outline"
          onClick={() => navigate('/app/contacts')}
          className="rounded-full"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('return_home')}
        </Button>
      </div>
    )
  }

  const groupedMessages: { [key: string]: WhatsAppMessage[] } = {}
  messages.forEach((msg) => {
    const dateStr = formatMessageDate(msg.timestamp || msg.created_at || new Date().toISOString())
    if (!groupedMessages[dateStr]) groupedMessages[dateStr] = []
    groupedMessages[dateStr].push(msg)
  })

  return (
    <div className="max-w-5xl mx-auto h-[calc(100vh-theme(spacing.20))] sm:h-[calc(100vh-theme(spacing.24))] p-4 sm:p-8 animate-in fade-in slide-in-from-bottom-4 duration-700 ease-apple">
      <div className="w-full h-full flex flex-col bg-card border border-border/60 shadow-elevation rounded-[2rem] sm:rounded-[2.5rem] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 sm:px-6 sm:py-5 bg-background/50 backdrop-blur-xl border-b border-border/40 z-10 shrink-0">
          <div className="flex items-center gap-3 sm:gap-4">
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full shrink-0 -ml-2 hover:bg-muted"
              onClick={() => navigate('/app/contacts')}
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <Avatar className="h-10 w-10 sm:h-12 sm:w-12 border border-border shadow-sm">
              <AvatarImage src={contact.profile_picture_url || ''} />
              <AvatarFallback className="bg-muted text-foreground font-bold text-lg">
                {getContactDisplayName(contact, '').charAt(0) || '#'}
              </AvatarFallback>
            </Avatar>
            <div className="flex flex-col max-w-[180px] sm:max-w-[260px] gap-0.5">
              {isEditingContact ? (
                <div className="flex flex-col gap-2">
                  <Input
                    value={editedName}
                    onChange={(e) => setEditedName(e.target.value)}
                    className="h-7 text-sm px-2 rounded-md"
                    placeholder={t('agent_name_placeholder') || 'Name'}
                  />
                  <Input
                    value={editedPhone}
                    onChange={(e) => setEditedPhone(e.target.value)}
                    className="h-7 text-sm px-2 rounded-md"
                    placeholder="Phone"
                  />
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="font-bold text-[15px] sm:text-[17px] tracking-tight truncate text-foreground leading-tight">
                    {getContactDisplayName(contact, t('unknown'))}
                  </span>
                  <button onClick={startEditing} className="hover:text-primary transition-colors">
                    <Edit2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                </div>
              )}
              {!isEditingContact && (
                <span className="text-[12px] sm:text-[13px] font-semibold text-muted-foreground truncate">
                  {getContactDisplaySubtitle(contact, t('unknownNumber'))}
                </span>
              )}
              {isEditingContact && (
                <div className="flex gap-1 mt-1">
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0 rounded-full" onClick={() => setIsEditingContact(false)}>
                    <X className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0 rounded-full text-primary" onClick={saveContactEdits} disabled={isUpdatingContact}>
                    {isUpdatingContact ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  </Button>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 bg-muted/30 p-1 sm:p-1.5 rounded-full border border-border/40 shrink-0">
            <div className="hidden sm:flex items-center justify-center h-8 w-8 rounded-full bg-primary/10 text-primary shrink-0 ml-1">
              <Sparkles className="h-4 w-4" />
            </div>
            <Select value={contact.ai_agent_id || 'none_disable'} onValueChange={handleAgentChange}>
              <SelectTrigger className="w-[120px] sm:w-[160px] h-8 sm:h-9 rounded-full bg-transparent border-transparent shadow-none font-bold text-[11px] sm:text-[13px] hover:bg-muted/60 transition-colors focus:ring-0 focus:ring-offset-0 px-3">
                <SelectValue placeholder={t('no_agent' as TranslationKey) || 'No Agent'} />
              </SelectTrigger>
              <SelectContent className="rounded-2xl border-border/60 shadow-elevation">
                <SelectItem
                  value="none_disable"
                  className="font-bold text-muted-foreground text-xs sm:text-sm cursor-pointer hover:bg-accent focus:bg-accent rounded-xl py-2.5"
                >
                  {t('no_agent' as TranslationKey) || 'No Agent'}
                </SelectItem>
                {agents.map((agent) => (
                  <SelectItem
                    key={agent.id}
                    value={agent.id}
                    className="font-bold text-foreground text-xs sm:text-sm cursor-pointer hover:bg-accent focus:bg-accent rounded-xl py-2.5"
                  >
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 bg-zinc-50/30 dark:bg-background/30 scrollbar-thin">
          {Object.entries(groupedMessages).map(([date, msgs]) => (
            <div key={date} className="space-y-6">
              <div className="flex justify-center my-4">
                <span className="bg-card border border-border/40 text-muted-foreground text-[11px] font-bold px-3 py-1 rounded-full shadow-sm tracking-tight">
                  {date}
                </span>
              </div>
              {msgs.map((msg, i) => {
                const isMe = msg.from_me
                const showAvatar = !isMe && (i === 0 || msgs[i - 1].from_me !== isMe)
                return (
                  <div
                    key={msg.id}
                    className={cn('flex w-full', isMe ? 'justify-end' : 'justify-start')}
                  >
                    <div
                      className={cn(
                        'flex max-w-[85%] sm:max-w-[70%] gap-2.5',
                        isMe ? 'flex-row-reverse' : 'flex-row',
                      )}
                    >
                      {!isMe && (
                        <div className="shrink-0 w-8 sm:w-10 flex flex-col justify-end">
                          {showAvatar && (
                            <Avatar className="h-8 w-8 border border-border/40 shadow-sm mb-1">
                              <AvatarImage src={contact.profile_picture_url || ''} />
                              <AvatarFallback className="bg-muted text-[10px] text-foreground font-bold">
                                {getContactDisplayName(contact, '').charAt(0) || '#'}
                              </AvatarFallback>
                            </Avatar>
                          )}
                        </div>
                      )}
                      <div
                        className={cn(
                          'relative px-4 sm:px-5 py-2.5 sm:py-3 rounded-[1.25rem] sm:rounded-[1.5rem] flex flex-col shadow-sm text-[14px] sm:text-[15px] leading-relaxed font-medium',
                          isMe
                            ? 'bg-primary text-primary-foreground rounded-br-sm'
                            : 'bg-card border border-border/60 text-foreground rounded-bl-sm',
                        )}
                      >
                        <span className="whitespace-pre-wrap break-words">{msg.text}</span>
                        <span
                          className={cn(
                            'text-[10px] sm:text-[11px] mt-1.5 self-end font-bold opacity-70 tracking-tight',
                            isMe ? 'text-primary-foreground' : 'text-muted-foreground',
                          )}
                        >
                          {formatMessageTime(
                            msg.timestamp || msg.created_at || new Date().toISOString(),
                          )}
                        </span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="p-3 sm:p-5 bg-background/50 backdrop-blur-xl border-t border-border/40 shrink-0 z-10">
          <form onSubmit={handleSendMessage} className="flex gap-2.5 sm:gap-3 items-end">
            <div className="relative flex-1">
              <Input
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                placeholder={t('type_message' as TranslationKey) || 'Type a message...'}
                className="w-full bg-card border-border shadow-sm rounded-2xl sm:rounded-full h-12 sm:h-14 px-5 sm:px-6 text-[14px] sm:text-[15px] font-medium pr-12 focus-visible:ring-primary/20 transition-all"
              />
            </div>
            <Button
              type="submit"
              disabled={isSending || !newMessage.trim()}
              size="icon"
              className="h-12 w-12 sm:h-14 sm:w-14 rounded-2xl sm:rounded-full shrink-0 shadow-subtle hover:scale-105 transition-all duration-300"
            >
              {isSending ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Send className="h-5 w-5 ml-0.5" />
              )}
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}
