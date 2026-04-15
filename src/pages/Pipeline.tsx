import { useEffect, useMemo, useState } from 'react'
import { useContacts } from '@/hooks/use-contacts'
import { supabase } from '@/lib/supabase/client'
import { Card } from '@/components/ui/card'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatDistanceToNow } from 'date-fns'
import { ptBR, enUS } from 'date-fns/locale'
import { useLanguage } from '@/hooks/use-language'
import { Clock, MessageSquare, AlertCircle, CheckCircle2, XCircle } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

const STAGES = [
  { id: 'Em Conversa', icon: MessageSquare, color: 'text-foreground', bg: 'bg-muted/80' },
  { id: 'Em Espera', icon: Clock, color: 'text-muted-foreground', bg: 'bg-muted/40' },
  { id: 'Resolvido', icon: CheckCircle2, color: 'text-muted-foreground', bg: 'bg-muted/40' },
  { id: 'Perdido', icon: XCircle, color: 'text-muted-foreground', bg: 'bg-muted/40' },
]

export default function Pipeline() {
  const { contacts } = useContacts()
  const { t, language } = useLanguage()
  const dateLocale = language === 'pt' ? ptBR : enUS
  const navigate = useNavigate()
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)

  useEffect(() => {
    const int = setInterval(() => {
      const now = Date.now()
      contacts.forEach((c) => {
        if (c.pipeline_stage === 'Em Conversa' && c.last_message_at) {
          if (now - new Date(c.last_message_at).getTime() > 5 * 60 * 1000) {
            supabase
              .from('whatsapp_contacts')
              .update({ pipeline_stage: 'Em Espera' })
              .eq('id', c.id)
              .then()
          }
        }
      })
    }, 15000)
    return () => clearInterval(int)
  }, [contacts])

  useEffect(() => {
    const int = setInterval(() => supabase.functions.invoke('ai-pipeline-monitor'), 60000)
    return () => clearInterval(int)
  }, [])

  const handleMoveContact = async (contactId: string, newStage: string) => {
    if (contacts.find((c) => c.id === contactId)?.pipeline_stage === newStage) return
    const prom = supabase
      .from('whatsapp_contacts')
      .update({ pipeline_stage: newStage })
      .eq('id', contactId)
      .then(({ error }) => {
        if (error) throw error
      })
    toast.promise(prom, { loading: 'Atualizando...', success: 'Sucesso!', error: 'Erro ao mover.' })
  }

  const groupedContacts = useMemo(() => {
    const grp: Record<string, typeof contacts> = {
      'Em Conversa': [],
      'Em Espera': [],
      Resolvido: [],
      Perdido: [],
    }
    contacts.forEach((c) => {
      if (c.last_message_at) grp[c.pipeline_stage || 'Em Espera']?.push(c)
    })
    Object.values(grp).forEach((arr) =>
      arr.sort(
        (a, b) => new Date(b.last_message_at!).getTime() - new Date(a.last_message_at!).getTime(),
      ),
    )
    return grp
  }, [contacts])

  return (
    <div className="flex flex-col h-full min-h-[calc(100vh-80px)] bg-background p-6 pb-24 md:p-8 animate-in fade-in">
      <div className="mb-8 shrink-0">
        <h2 className="text-3xl font-bold tracking-tight">{t('pipeline_nav') || 'Pipeline'}</h2>
        <p className="text-muted-foreground mt-1 font-medium">
          Acompanhe e gerencie contatos num fluxo Kanban automatizado.
        </p>
      </div>

      <div className="flex flex-1 gap-6 overflow-x-auto pb-4 snap-x snap-mandatory">
        {STAGES.map((stage) => {
          const list = groupedContacts[stage.id] || []
          return (
            <div
              key={stage.id}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOverColumn(stage.id)
              }}
              onDragLeave={() => setDragOverColumn(null)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOverColumn(null)
                handleMoveContact(e.dataTransfer.getData('contactId'), stage.id)
              }}
              className={cn(
                'flex flex-col w-[320px] md:w-[340px] shrink-0 snap-center bg-muted/30 rounded-[2rem] border border-border/60 overflow-hidden transition-all duration-200',
                dragOverColumn === stage.id && 'bg-muted/60 ring-2 ring-primary/20 scale-[1.01]',
              )}
            >
              <div className="flex items-center justify-between p-5 border-b border-border/50 bg-card/50">
                <div className="flex items-center gap-3">
                  <div className={cn('p-2.5 rounded-xl', stage.bg)}>
                    <stage.icon className={cn('h-5 w-5', stage.color)} />
                  </div>
                  <h3 className="font-bold">{stage.id}</h3>
                </div>
                <Badge variant="secondary" className="px-3 rounded-full font-bold">
                  {list.length}
                </Badge>
              </div>

              <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
                {list.map((c) => (
                  <Card
                    key={c.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('contactId', c.id)
                      setDraggingId(c.id)
                    }}
                    onDragEnd={() => setDraggingId(null)}
                    className={cn(
                      'p-5 flex flex-col min-h-[120px] cursor-grab active:cursor-grabbing hover:-translate-y-1 transition-all group',
                      draggingId === c.id && 'opacity-50 ring-2 ring-primary scale-95',
                    )}
                    onClick={() => navigate(`/app/chat/${c.id}`)}
                  >
                    <div className="flex items-start gap-3.5 flex-1 mb-4">
                      <Avatar className="h-11 w-11 border">
                        <AvatarImage src={c.profile_picture_url || ''} />
                        <AvatarFallback>{c.push_name?.charAt(0) || '#'}</AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <h4 className="font-bold text-[15px] truncate group-hover:text-primary transition-colors">
                          {c.push_name || 'Desconhecido'}
                        </h4>
                        <p className="text-[13px] font-medium text-muted-foreground truncate">
                          {c.phone_number ? `+${c.phone_number}` : c.remote_jid.split('@')[0]}
                        </p>
                        {c.classification && (
                          <Badge variant="outline" className="text-[10px] px-2 py-0.5 mt-1.5">
                            {c.classification}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center justify-between mt-auto pt-3 border-t border-border/40">
                      <div onClick={(e) => e.stopPropagation()}>
                        <Select
                          value={c.pipeline_stage || 'Em Espera'}
                          onValueChange={(val) => handleMoveContact(c.id, val)}
                        >
                          <SelectTrigger className="h-7 text-[11px] w-[130px] font-semibold bg-muted/20 hover:bg-muted/40">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {STAGES.map((s) => (
                              <SelectItem
                                key={s.id}
                                value={s.id}
                                className="text-[12px] font-medium"
                              >
                                {s.id}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground font-semibold">
                        <Clock className="h-3 w-3" />
                        {c.last_message_at
                          ? formatDistanceToNow(new Date(c.last_message_at), {
                              addSuffix: true,
                              locale: dateLocale,
                            })
                          : 'Novo'}
                      </div>
                    </div>
                  </Card>
                ))}
                {list.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-16 text-muted-foreground text-center">
                    <div className="bg-background rounded-full p-4 mb-4 shadow-sm border">
                      <AlertCircle className="h-6 w-6 opacity-40" />
                    </div>
                    <p className="text-[15px] font-bold opacity-80">Nenhum contato</p>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
