import { useState, useMemo } from 'react'
import { useAgents } from '@/hooks/use-agents'
import { useAPIKeys } from '@/hooks/use-api-keys'
import { useLanguage } from '@/hooks/use-language'
import { supabase } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import { Label } from '@/components/ui/label'
import { Plus, Trash2, Edit2, Loader2, Star, Check, Key, Globe, ShieldCheck, ChevronsUpDown, Mic, RefreshCw } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import { AIAgent, UserAPIKey } from '@/lib/types'
import { cn } from '@/lib/utils'

const AI_MODELS = [
  { id: 'z-ai/glm-4.5-air:free', name: 'GLM 4.5 Air (Free)' },
  { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B (Free)' },
  { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
  { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' },
  { id: 'openai/gpt-4o', name: 'GPT-4o' },
  { id: 'openai/o3-mini', name: 'OpenAI o3-mini' },
  { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
  { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5' },
  { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3' },
  { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1' },
  { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B' },
  { id: 'x-ai/grok-3', name: 'Grok 3' },
  { id: 'mistralai/mistral-large-2512', name: 'Mistral Large' },
]

const AI_PROVIDERS = [
  { id: 'openrouter', name: 'OpenRouter (Recomendado)', url: 'https://openrouter.ai/keys' },
  { id: 'openai', name: 'OpenAI', url: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', name: 'Anthropic', url: 'https://console.anthropic.com/settings/keys' },
  { id: 'google', name: 'Google Gemini', url: 'https://aistudio.google.com/app/apikey' },
]

export default function Agents() {
  const {
    agents,
    loading: agentsLoading,
    createAgent,
    updateAgent,
    deleteAgent,
    toggleAgentStatus,
    setAsDefault,
  } = useAgents()
  const { apiKeys, aiKeys, audioKeys, loading: keysLoading, createAPIKey, deleteAPIKey } = useAPIKeys()
  const { t } = useLanguage()

  const [activeTab, setActiveTab] = useState('agents')
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isKeyDialogOpen, setIsKeyDialogOpen] = useState(false)
  const [isAudioKeyDialogOpen, setIsAudioKeyDialogOpen] = useState(false)
  const [editingAgent, setEditingAgent] = useState<AIAgent | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isModelPopoverOpen, setIsModelPopoverOpen] = useState(false)
  
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    system_prompt: '',
    api_key_id: '',
    audio_api_key_id: '__none__',
    model_id: 'z-ai/glm-4.5-air:free',
    memory_limit: 20,
    message_delay: 0,
    human_handoff_enabled: false,
    is_active: true,
    is_default: false,
  })

  const [keyFormData, setKeyFormData] = useState({
    name: '',
    key: '',
    provider: 'openrouter',
  })

  const [audioKeyFormData, setAudioKeyFormData] = useState({
    name: '',
    key: '',
  })

  const [isTranscribingPending, setIsTranscribingPending] = useState(false)
  const [isValidating, setIsValidating] = useState(false)
  const [validationErrors, setValidationErrors] = useState<{ openrouter?: string; assemblyai?: string } | null>(null)

  const handleTranscribePending = async () => {
    setIsTranscribingPending(true)
    try {
      const { data, error } = await supabase.functions.invoke('evolution-transcribe-pending')
      if (error) throw error
      const { processed, remaining } = data as { processed: number; remaining: number }
      if (processed === 0 && remaining === 0) {
        toast.success('Nenhum áudio pendente encontrado')
      } else if (processed > 0) {
        toast.success(
          remaining > 0
            ? `${processed} áudio(s) transcritos. ${remaining} restante(s) — clique novamente para continuar.`
            : `${processed} áudio(s) transcritos com sucesso!`
        )
      } else {
        toast.info('Nenhum áudio pôde ser transcrito nesta rodada.')
      }
    } catch (err: any) {
      toast.error('Erro ao transcrever: ' + (err?.message ?? 'Erro desconhecido'))
    } finally {
      setIsTranscribingPending(false)
    }
  }

  const handleOpenDialog = (agent?: AIAgent) => {
    if (agent) {
      setEditingAgent(agent)
      setFormData({
        name: agent.name,
        description: agent.description || '',
        system_prompt: agent.system_prompt,
        api_key_id: agent.api_key_id || '',
        audio_api_key_id: agent.audio_api_key_id || '__none__',
        model_id: agent.model_id || 'z-ai/glm-4.5-air:free',
        memory_limit: agent.memory_limit ?? 20,
        message_delay: agent.message_delay ?? 0,
        human_handoff_enabled: agent.human_handoff_enabled ?? false,
        is_active: agent.is_active,
        is_default: agent.is_default || false,
      })
    } else {
      setEditingAgent(null)
      setFormData({
        name: '',
        description: '',
        system_prompt: t('default_system_prompt'),
        api_key_id: aiKeys.length > 0 ? aiKeys[0].id : '',
        audio_api_key_id: '__none__',
        model_id: 'z-ai/glm-4.5-air:free',
        memory_limit: 20,
        message_delay: 0,
        human_handoff_enabled: false,
        is_active: true,
        is_default: agents.length === 0,
      })
    }
    setValidationErrors(null)
    setIsDialogOpen(true)
  }

  const handleOpenKeyDialog = () => {
    setKeyFormData({
      name: '',
      key: '',
      provider: 'openrouter',
    })
    setIsKeyDialogOpen(true)
  }

  const handleOpenAudioKeyDialog = () => {
    setAudioKeyFormData({ name: '', key: '' })
    setIsAudioKeyDialogOpen(true)
  }

  const handleAudioKeySubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    try {
      await createAPIKey({
        name: audioKeyFormData.name,
        key: audioKeyFormData.key,
        provider: 'assemblyai',
        key_type: 'audio',
      })
      setIsAudioKeyDialogOpen(false)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setValidationErrors(null)

    const audioKeyId = formData.audio_api_key_id === '__none__' ? null : formData.audio_api_key_id || null
    const payload = { ...formData, audio_api_key_id: audioKeyId }

    const needsValidation = !editingAgent
      || editingAgent.model_id !== formData.model_id
      || editingAgent.api_key_id !== formData.api_key_id
      || editingAgent.audio_api_key_id !== audioKeyId

    // Validate FIRST — keep modal open while testing
    if (needsValidation && formData.api_key_id) {
      setIsValidating(true)
      try {
        const { data, error } = await supabase.functions.invoke('ai-validate-agent', {
          body: {
            api_key_id: formData.api_key_id,
            model_id: formData.model_id,
            audio_api_key_id: audioKeyId,
          },
        })
        if (error) throw error

        const { results } = data as {
          results: {
            openrouter?: { ok: boolean; error?: string }
            assemblyai?: { ok: boolean; error?: string }
          }
        }

        const errors: { openrouter?: string; assemblyai?: string } = {}
        if (results.openrouter && !results.openrouter.ok) errors.openrouter = results.openrouter.error
        if (results.assemblyai && !results.assemblyai.ok) errors.assemblyai = results.assemblyai.error

        if (Object.keys(errors).length > 0) {
          setValidationErrors(errors)
          return // Stay in modal — do NOT save
        }
      } catch (err: any) {
        setValidationErrors({ openrouter: 'Falha na validação: ' + (err?.message ?? 'erro desconhecido') })
        return
      } finally {
        setIsValidating(false)
      }
    }

    // Validation passed (or not needed) — save
    setIsSubmitting(true)
    try {
      if (editingAgent) {
        await updateAgent(editingAgent.id, payload)
      } else {
        await createAgent(payload)
      }
      setIsDialogOpen(false)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleKeySubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    try {
      const newKey = await createAPIKey({ ...keyFormData, key_type: 'ai' })
      if (newKey && !formData.api_key_id) {
        setFormData({ ...formData, api_key_id: newKey.id })
      }
      setIsKeyDialogOpen(false)
    } finally {
      setIsSubmitting(false)
    }
  }

  const selectedApiKey = useMemo(() =>
    aiKeys.find((key) => key.id === formData.api_key_id),
  [aiKeys, formData.api_key_id])

  return (
    <div className="max-w-7xl mx-auto space-y-10 p-6 md:p-12 animate-in fade-in slide-in-from-bottom-4 duration-700 ease-apple min-h-full bg-background">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
        <div>
          <h2 className="text-4xl font-bold tracking-tight text-foreground flex items-center gap-3">
            {t('agents_title')}
          </h2>
          <p className="text-muted-foreground mt-2 font-medium text-base">{t('agents_desc')}</p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full space-y-8">
        <TabsList className="bg-muted/50 p-1 rounded-full border border-border/40">
          <TabsTrigger value="agents" className="rounded-full px-8 py-2 data-[state=active]:bg-background data-[state=active]:shadow-subtle">
            {t('agents_title')}
          </TabsTrigger>
          <TabsTrigger value="connections" className="rounded-full px-8 py-2 data-[state=active]:bg-background data-[state=active]:shadow-subtle">
            Conexões de IA
          </TabsTrigger>
        </TabsList>

        <TabsContent value="agents" className="space-y-8 outline-none">
          <div className="flex justify-end">
            <Button
              onClick={() => handleOpenDialog()}
              className="rounded-full shadow-subtle px-6 h-12 font-semibold"
            >
              <Plus className="mr-2 h-5 w-5" />
              {t('create_agent')}
            </Button>
          </div>

          {agentsLoading ? (
            <div className="flex justify-center p-24">
              <Loader2 className="h-10 w-10 animate-spin text-muted-foreground/50" />
            </div>
          ) : agents.length === 0 ? (
            <Card className="border-dashed border-border bg-transparent shadow-none">
              <CardContent className="flex flex-col items-center justify-center p-20 text-center">
                <h3 className="text-xl font-bold text-foreground mb-2">{t('no_agents_title')}</h3>
                <p className="text-muted-foreground max-w-sm mb-6">{t('no_agents_desc')}</p>
                <Button onClick={() => handleOpenDialog()} variant="outline" className="rounded-full">
                  {t('create_agent')}
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
              {agents.map((agent) => (
                <Card
                  key={agent.id}
                  className="shadow-subtle border border-border/40 rounded-[2rem] overflow-hidden flex flex-col group transition-all duration-300 hover:shadow-elevation"
                >
                  <CardHeader className="pb-4">
                    <div className="flex justify-between items-start">
                      <div className="flex items-center gap-3">
                        <div>
                          <CardTitle className="text-lg tracking-tight line-clamp-1">
                            {agent.name}
                          </CardTitle>
                          <CardDescription className="text-xs font-semibold mt-0.5 uppercase tracking-wider flex items-center gap-2">
                            {agent.is_active ? (
                              <span className="flex items-center gap-1.5 text-emerald-500">
                                <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
                                {t('active')}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">{t('inactive')}</span>
                            )}
                          </CardDescription>
                        </div>
                      </div>
                      <Switch
                        checked={agent.is_active}
                        onCheckedChange={() => toggleAgentStatus(agent.id, agent.is_active)}
                      />
                    </div>
                  </CardHeader>
                  <CardContent className="flex-1 pb-6 space-y-4">
                    <p className="text-sm text-muted-foreground line-clamp-2 leading-relaxed h-10">
                      {agent.description || t('no_description')}
                    </p>
                    
                    <div className="flex flex-wrap gap-2">
                      <div className="px-2.5 py-1 bg-primary/5 border border-primary/10 rounded-lg text-[10px] font-bold text-primary uppercase tracking-tight">
                        {agent.model_id.split('/').pop()}
                      </div>
                      <div className="px-2.5 py-1 bg-muted/50 border border-border/40 rounded-lg text-[10px] font-medium text-muted-foreground uppercase tracking-tight flex items-center gap-1">
                        <Key className="h-3 w-3" />
                        {aiKeys.find(k => k.id === agent.api_key_id)?.name || 'Sem Conexão'}
                      </div>
                    </div>

                    <div className="p-3 bg-muted/30 rounded-xl border border-border/40">
                      <p className="text-xs font-mono text-muted-foreground line-clamp-2 leading-relaxed opacity-70 italic">
                        "{agent.system_prompt}"
                      </p>
                    </div>
                  </CardContent>
                  <div className="border-t border-border/40 bg-muted/10 p-4 flex justify-between items-center gap-2 shrink-0">
                    <div>
                      {agent.is_default ? (
                        <div className="flex items-center text-xs font-semibold text-amber-500 bg-amber-500/10 px-3 py-1.5 rounded-full border border-amber-500/20">
                          <Star className="h-3.5 w-3.5 mr-1.5 fill-current" />
                          Default Agent
                        </div>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="rounded-full text-xs h-8 text-muted-foreground hover:text-foreground"
                          onClick={() => setAsDefault(agent.id)}
                        >
                          Set as Default
                        </Button>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="rounded-full font-semibold h-8 w-8 p-0"
                        onClick={() => handleOpenDialog(agent)}
                      >
                        <Edit2 className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="rounded-full text-destructive hover:text-destructive hover:bg-destructive/10 h-8 w-8 p-0"
                        onClick={() => deleteAgent(agent.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="connections" className="space-y-10 outline-none">
          {/* AI Model Keys */}
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold tracking-tight flex items-center gap-2">
                  <Key className="h-5 w-5 text-primary" />
                  Modelos de IA
                </h3>
                <p className="text-sm text-muted-foreground mt-0.5">Chaves de API para provedores de linguagem (OpenRouter, OpenAI, etc.)</p>
              </div>
              <Button
                onClick={handleOpenKeyDialog}
                className="rounded-full shadow-subtle px-6 h-12 font-semibold"
              >
                <Plus className="mr-2 h-5 w-5" />
                Nova Conexão
              </Button>
            </div>

            {keysLoading ? (
              <div className="flex justify-center p-12">
                <Loader2 className="h-10 w-10 animate-spin text-muted-foreground/50" />
              </div>
            ) : aiKeys.length === 0 ? (
              <Card className="border-dashed border-border bg-transparent shadow-none">
                <CardContent className="flex flex-col items-center justify-center p-16 text-center">
                  <div className="h-14 w-14 bg-muted rounded-3xl flex items-center justify-center mb-5">
                    <Key className="h-7 w-7 text-muted-foreground" />
                  </div>
                  <h3 className="text-lg font-bold text-foreground mb-2">Nenhuma conexão de IA configurada</h3>
                  <p className="text-muted-foreground max-w-sm mb-5 text-sm">
                    Adicione uma chave de API para conectar seus agentes à inteligência artificial.
                  </p>
                  <Button onClick={handleOpenKeyDialog} variant="outline" className="rounded-full">
                    Adicionar Primeira Conexão
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {aiKeys.map((key) => (
                  <Card
                    key={key.id}
                    className="shadow-subtle border border-border/40 rounded-[2rem] overflow-hidden group hover:shadow-elevation transition-all duration-300"
                  >
                    <CardHeader className="pb-4">
                      <div className="flex justify-between items-start">
                        <div className="h-12 w-12 bg-primary/5 rounded-2xl flex items-center justify-center text-primary border border-primary/10">
                          <Key className="h-6 w-6" />
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="rounded-full text-destructive hover:text-destructive hover:bg-destructive/10 h-8 w-8 p-0"
                          onClick={() => deleteAPIKey(key.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="mt-4">
                        <CardTitle className="text-lg tracking-tight">{key.name}</CardTitle>
                        <CardDescription className="text-xs font-semibold mt-1 uppercase tracking-wider flex items-center gap-2">
                          <Globe className="h-3 w-3" />
                          {key.provider}
                        </CardDescription>
                      </div>
                    </CardHeader>
                    <CardContent className="pb-6">
                      <div className="p-3 bg-muted/40 rounded-xl border border-border/40 font-mono text-xs text-muted-foreground flex items-center justify-between">
                        <span className="truncate max-w-[140px]">
                          {key.key.substring(0, 8)}••••••••••••••••
                        </span>
                        <ShieldCheck className="h-4 w-4 text-emerald-500/50 shrink-0" />
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-3 font-medium">
                        Criada em {new Date(key.created_at).toLocaleDateString()}
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>

          <Separator />

          {/* Audio Transcription Keys */}
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold tracking-tight flex items-center gap-2">
                  <Mic className="h-5 w-5 text-primary" />
                  Áudio & Transcrição
                </h3>
                <p className="text-sm text-muted-foreground mt-0.5">Chave AssemblyAI para transcrição automática de mensagens de voz</p>
              </div>
              <div className="flex items-center gap-3">
                {audioKeys.length > 0 && (
                  <Button
                    variant="outline"
                    onClick={handleTranscribePending}
                    disabled={isTranscribingPending}
                    className="rounded-full px-5 h-10 font-semibold text-sm"
                  >
                    {isTranscribingPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-2 h-4 w-4" />
                    )}
                    Transcrever Pendentes
                  </Button>
                )}
                <Button
                  onClick={handleOpenAudioKeyDialog}
                  className="rounded-full shadow-subtle px-6 h-12 font-semibold"
                >
                  <Plus className="mr-2 h-5 w-5" />
                  Nova Chave de Áudio
                </Button>
              </div>
            </div>

            {keysLoading ? (
              <div className="flex justify-center p-12">
                <Loader2 className="h-10 w-10 animate-spin text-muted-foreground/50" />
              </div>
            ) : audioKeys.length === 0 ? (
              <Card className="border-dashed border-border bg-transparent shadow-none">
                <CardContent className="flex flex-col items-center justify-center p-16 text-center">
                  <div className="h-14 w-14 bg-muted rounded-3xl flex items-center justify-center mb-5">
                    <Mic className="h-7 w-7 text-muted-foreground" />
                  </div>
                  <h3 className="text-lg font-bold text-foreground mb-2">Nenhuma chave de áudio configurada</h3>
                  <p className="text-muted-foreground max-w-sm mb-5 text-sm">
                    Adicione sua chave AssemblyAI para habilitar transcrição automática de áudios do WhatsApp.
                  </p>
                  <Button onClick={handleOpenAudioKeyDialog} variant="outline" className="rounded-full">
                    Configurar AssemblyAI
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {audioKeys.map((key) => (
                  <Card
                    key={key.id}
                    className="shadow-subtle border border-border/40 rounded-[2rem] overflow-hidden group hover:shadow-elevation transition-all duration-300"
                  >
                    <CardHeader className="pb-4">
                      <div className="flex justify-between items-start">
                        <div className="h-12 w-12 bg-violet-500/10 rounded-2xl flex items-center justify-center text-violet-500 border border-violet-500/20">
                          <Mic className="h-6 w-6" />
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="rounded-full text-destructive hover:text-destructive hover:bg-destructive/10 h-8 w-8 p-0"
                          onClick={() => deleteAPIKey(key.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="mt-4">
                        <CardTitle className="text-lg tracking-tight">{key.name}</CardTitle>
                        <CardDescription className="text-xs font-semibold mt-1 uppercase tracking-wider flex items-center gap-2">
                          <Mic className="h-3 w-3" />
                          AssemblyAI
                        </CardDescription>
                      </div>
                    </CardHeader>
                    <CardContent className="pb-6">
                      <div className="p-3 bg-muted/40 rounded-xl border border-border/40 font-mono text-xs text-muted-foreground flex items-center justify-between">
                        <span className="truncate max-w-[140px]">
                          {key.key.substring(0, 8)}••••••••••••••••
                        </span>
                        <ShieldCheck className="h-4 w-4 text-emerald-500/50 shrink-0" />
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-3 font-medium">
                        Criada em {new Date(key.created_at).toLocaleDateString()}
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* AGENT DIALOG */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="sm:max-w-[600px] rounded-[2rem] p-0 overflow-hidden border-border/60">
          <form onSubmit={handleSubmit} className="flex flex-col h-full max-h-[90vh]">
            <DialogHeader className="p-6 md:p-8 pb-4 border-b border-border/40 bg-muted/20">
              <DialogTitle className="text-2xl">
                {editingAgent ? t('edit_agent') : t('create_agent')}
              </DialogTitle>
              <DialogDescription>{t('agent_dialog_desc')}</DialogDescription>
            </DialogHeader>
            <div className="p-6 md:p-8 space-y-6 overflow-y-auto">
              <div className="space-y-3">
                <Label htmlFor="name" className="font-semibold">
                  {t('agent_name')}
                </Label>
                <Input
                  id="name"
                  required
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder={t('agent_name_placeholder')}
                  className="rounded-xl h-12"
                />
              </div>
              <div className="space-y-3">
                <Label htmlFor="description" className="font-semibold">
                  {t('description')}
                </Label>
                <Input
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder={t('agent_desc_placeholder')}
                  className="rounded-xl h-12"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-3">
                  <Label htmlFor="model_id" className="font-semibold">
                    {t('model_label')}
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="model_id"
                      value={formData.model_id}
                      onChange={(e) => setFormData({ ...formData, model_id: e.target.value })}
                      placeholder={t('model_placeholder')}
                      className="rounded-xl h-12 flex-1"
                    />
                    <Popover open={isModelPopoverOpen} onOpenChange={setIsModelPopoverOpen}>
                      <PopoverTrigger asChild>
                        <Button variant="outline" className="h-12 w-12 p-0 rounded-xl shrink-0 border-border/60">
                          <ChevronsUpDown className="h-4 w-4 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-[300px] p-0 rounded-xl" align="end">
                        <Command>
                          <CommandInput placeholder="Buscar modelo..." />
                          <CommandList>
                            <CommandEmpty>Nenhum modelo encontrado.</CommandEmpty>
                            <CommandGroup heading="Sugestões">
                              {AI_MODELS.map((model) => (
                                <CommandItem
                                  key={model.id}
                                  value={model.id}
                                  onSelect={() => {
                                    setFormData({ ...formData, model_id: model.id })
                                    setIsModelPopoverOpen(false)
                                  }}
                                  className="rounded-lg"
                                >
                                  <Check
                                    className={cn(
                                      "mr-2 h-4 w-4",
                                      formData.model_id === model.id ? "opacity-100" : "opacity-0"
                                    )}
                                  />
                                  {model.name}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>
                
                <div className="space-y-3">
                  <Label className="font-semibold flex justify-between items-center">
                    {t('api_key_label')}
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0 text-[11px] font-bold text-primary"
                      onClick={handleOpenKeyDialog}
                    >
                      + Nova Conexão
                    </Button>
                  </Label>
                  <Select
                    value={formData.api_key_id}
                    onValueChange={(value) => setFormData({ ...formData, api_key_id: value })}
                  >
                    <SelectTrigger className="rounded-xl h-12 shadow-sm border-border/60">
                      <SelectValue placeholder="Selecione uma conexão" />
                    </SelectTrigger>
                    <SelectContent className="rounded-xl">
                      {aiKeys.length === 0 && (
                        <div className="p-4 text-center">
                          <p className="text-xs text-muted-foreground mb-2">Sem conexões salvas</p>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="w-full rounded-full h-8 text-[10px]"
                            onClick={handleOpenKeyDialog}
                          >
                            Configurar Agora
                          </Button>
                        </div>
                      )}
                      {aiKeys.map((key) => (
                        <SelectItem key={key.id} value={key.id} className="rounded-lg">
                          {key.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-3">
                  <Label className="font-semibold flex justify-between items-center">
                    <span className="flex items-center gap-1.5"><Mic className="h-3.5 w-3.5" /> Transcrição de Áudio</span>
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0 text-[11px] font-bold text-primary"
                      onClick={handleOpenAudioKeyDialog}
                    >
                      + Nova Chave
                    </Button>
                  </Label>
                  <Select
                    value={formData.audio_api_key_id}
                    onValueChange={(value) => setFormData({ ...formData, audio_api_key_id: value })}
                  >
                    <SelectTrigger className="rounded-xl h-12 shadow-sm border-border/60">
                      <SelectValue placeholder="Sem transcrição (opcional)" />
                    </SelectTrigger>
                    <SelectContent className="rounded-xl">
                      <SelectItem value="__none__" className="rounded-lg text-muted-foreground">
                        Sem transcrição
                      </SelectItem>
                      {audioKeys.map((key) => (
                        <SelectItem key={key.id} value={key.id} className="rounded-lg">
                          {key.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-3">
                <Label htmlFor="memory_limit" className="font-semibold flex items-center justify-between">
                  {t('memory_limit_label')}
                  <span className="text-[10px] text-primary font-bold bg-primary/10 px-2 py-0.5 rounded-full">
                    {formData.memory_limit} mensagens
                  </span>
                </Label>
                <Input
                  id="memory_limit"
                  type="number"
                  min="0"
                  max="100"
                  value={formData.memory_limit}
                  onChange={(e) => setFormData({ ...formData, memory_limit: parseInt(e.target.value) || 0 })}
                  className="rounded-xl h-12"
                />
                <p className="text-[11px] text-muted-foreground font-medium">
                  {t('memory_limit_help')}
                </p>
              </div>

              <div className="space-y-3">
                <Label htmlFor="message_delay" className="font-semibold flex items-center justify-between">
                  Delay entre mensagens
                  <span className="text-[10px] text-primary font-bold bg-primary/10 px-2 py-0.5 rounded-full">
                    {formData.message_delay}s
                  </span>
                </Label>
                <Input
                  id="message_delay"
                  type="number"
                  min="0"
                  max="30"
                  step="1"
                  value={formData.message_delay}
                  onChange={(e) => setFormData({ ...formData, message_delay: parseInt(e.target.value) || 0 })}
                  className="rounded-xl h-12"
                />
                <p className="text-[11px] text-muted-foreground font-medium">
                  Tempo de espera após cada mensagem antes de responder. Se outra mensagem chegar dentro desse tempo, o timer reinicia.
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Label className="font-semibold">Transferência para Humano</Label>
                    <p className="text-[11px] text-muted-foreground font-medium">
                      Permite que a IA transfira o atendimento emitindo a tag{' '}
                      <code className="font-mono bg-muted px-1 rounded text-[10px]">&lt;transferir_humano&gt;</code>.
                    </p>
                  </div>
                  <Switch
                    checked={formData.human_handoff_enabled}
                    onCheckedChange={(checked) =>
                      setFormData({ ...formData, human_handoff_enabled: checked })
                    }
                  />
                </div>
                {formData.human_handoff_enabled && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400 font-medium">
                    Atenção: modelos gratuitos com baixa capacidade podem não respeitar a instrução da tag.
                  </p>
                )}
              </div>

              <div className="space-y-3">
                <Label htmlFor="prompt" className="font-semibold">
                  {t('system_prompt')}
                </Label>
                <Textarea
                  id="prompt"
                  required
                  value={formData.system_prompt}
                  onChange={(e) => setFormData({ ...formData, system_prompt: e.target.value })}
                  placeholder={t('system_prompt_placeholder')}
                  className="rounded-xl min-h-[160px] resize-none font-mono text-sm leading-relaxed p-4 border-border/60"
                />
                <p className="text-[11px] text-muted-foreground font-medium">
                  {t('system_prompt_help')}
                </p>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex items-center justify-between p-4 bg-muted/30 rounded-2xl border border-border/40">
                  <div className="space-y-0.5">
                    <Label className="font-semibold text-xs">{t('agent_status')}</Label>
                    <p className="text-[10px] text-muted-foreground">Ativar automação</p>
                  </div>
                  <Switch
                    checked={formData.is_active}
                    onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
                  />
                </div>
                <div className="flex items-center justify-between p-4 bg-muted/30 rounded-2xl border border-border/40">
                  <div className="space-y-0.5">
                    <Label className="font-semibold text-xs">Padrão</Label>
                    <p className="text-[10px] text-muted-foreground">Auto-atribuir novos leads</p>
                  </div>
                  <Switch
                    checked={formData.is_default}
                    onCheckedChange={(checked) => setFormData({ ...formData, is_default: checked })}
                  />
                </div>
              </div>
            </div>
            <DialogFooter className="p-6 md:p-8 pt-4 border-t border-border/40 bg-muted/20">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setIsDialogOpen(false)}
                className="rounded-full"
              >
                {t('cancel')}
              </Button>
              <Button
                type="submit"
                disabled={isSubmitting || isValidating}
                className="rounded-full px-8 shadow-subtle bg-primary text-primary-foreground hover:opacity-90"
              >
                {(isSubmitting || isValidating) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {isValidating ? 'Testando conexão...' : editingAgent ? t('save_changes') : t('create_agent')}
              </Button>
            </DialogFooter>
            {validationErrors && (
              <div className="px-8 pb-6 space-y-2">
                {validationErrors.openrouter && (
                  <div className="flex items-start gap-2 rounded-xl bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
                    <span className="font-semibold shrink-0">Modelo IA:</span>
                    <span>{validationErrors.openrouter}</span>
                  </div>
                )}
                {validationErrors.assemblyai && (
                  <div className="flex items-start gap-2 rounded-xl bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
                    <span className="font-semibold shrink-0">AssemblyAI:</span>
                    <span>{validationErrors.assemblyai}</span>
                  </div>
                )}
              </div>
            )}
          </form>
        </DialogContent>
      </Dialog>

      {/* AUDIO KEY DIALOG */}
      <Dialog open={isAudioKeyDialogOpen} onOpenChange={setIsAudioKeyDialogOpen}>
        <DialogContent className="sm:max-w-[560px] rounded-[2.5rem] p-0 overflow-hidden border-border/60 shadow-2xl">
          <form onSubmit={handleAudioKeySubmit} className="flex flex-col">
            <DialogHeader className="p-8 md:p-10 pb-6 border-b border-border/40 bg-muted/20 relative">
              <div className="h-14 w-14 bg-violet-500/10 rounded-2xl flex items-center justify-center text-violet-500 shadow-lg mb-6 border border-violet-500/20">
                <Mic className="h-7 w-7" />
              </div>
              <DialogTitle className="text-3xl font-bold tracking-tight">
                Configurar AssemblyAI
              </DialogTitle>
              <DialogDescription className="text-base">
                Adicione sua chave de API do AssemblyAI para habilitar transcrição automática de áudios.
              </DialogDescription>
            </DialogHeader>

            <div className="p-8 md:p-10 grid grid-cols-1 md:grid-cols-5 gap-10">
              <div className="md:col-span-3 space-y-8">
                <div className="space-y-3">
                  <Label htmlFor="audio_key_name" className="font-bold text-sm uppercase tracking-wider text-muted-foreground">
                    Nome da Chave
                  </Label>
                  <Input
                    id="audio_key_name"
                    required
                    value={audioKeyFormData.name}
                    onChange={(e) => setAudioKeyFormData({ ...audioKeyFormData, name: e.target.value })}
                    placeholder="Ex: AssemblyAI Principal"
                    className="rounded-2xl h-14 text-lg border-border/60 bg-muted/10"
                  />
                </div>

                <div className="space-y-3">
                  <Label htmlFor="audio_api_key_value" className="font-bold text-sm uppercase tracking-wider text-muted-foreground">
                    Chave de API
                  </Label>
                  <Input
                    id="audio_api_key_value"
                    type="password"
                    required
                    value={audioKeyFormData.key}
                    onChange={(e) => setAudioKeyFormData({ ...audioKeyFormData, key: e.target.value })}
                    placeholder="94db1a5a..."
                    className="rounded-2xl h-14 font-mono text-base border-border/60 bg-muted/10"
                  />
                </div>
              </div>

              <div className="md:col-span-2">
                <div className="bg-violet-500/5 rounded-[2rem] p-6 border border-violet-500/10 h-full">
                  <h4 className="font-bold text-violet-600 flex items-center gap-2 mb-4">
                    <Star className="h-4 w-4 fill-current" />
                    Como obter?
                  </h4>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-6">
                    Acesse o painel da AssemblyAI e copie sua chave de API na seção Account.
                  </p>
                  <a
                    href="https://www.assemblyai.com/app/account"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between p-3 bg-background rounded-xl border border-border/40 hover:border-violet-500/40 transition-colors group"
                  >
                    <span className="text-xs font-semibold">Obter Chave</span>
                    <Plus className="h-3 w-3 rotate-45 group-hover:rotate-0 transition-transform" />
                  </a>
                  <div className="mt-6 p-4 bg-amber-500/5 rounded-2xl border border-amber-500/10">
                    <p className="text-[10px] font-medium text-amber-600/80 leading-relaxed">
                      Sua chave é criptografada e nunca será compartilhada com terceiros.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <DialogFooter className="p-8 md:p-10 pt-4 bg-muted/20 border-t border-border/40">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setIsAudioKeyDialogOpen(false)}
                className="rounded-full h-12 px-6"
              >
                {t('cancel')}
              </Button>
              <Button
                type="submit"
                disabled={isSubmitting}
                className="rounded-full px-10 h-12 shadow-elevation bg-violet-600 text-white hover:bg-violet-700 font-bold"
              >
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Salvar Chave
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* NEW CONNECTION DIALOG - POPUP MAIOR */}
      <Dialog open={isKeyDialogOpen} onOpenChange={setIsKeyDialogOpen}>
        <DialogContent className="sm:max-w-[700px] rounded-[2.5rem] p-0 overflow-hidden border-border/60 shadow-2xl">
          <form onSubmit={handleKeySubmit} className="flex flex-col">
            <DialogHeader className="p-8 md:p-10 pb-6 border-b border-border/40 bg-muted/20 relative">
              <div className="h-14 w-14 bg-primary rounded-2xl flex items-center justify-center text-primary-foreground shadow-lg mb-6">
                <Globe className="h-7 w-7" />
              </div>
              <DialogTitle className="text-3xl font-bold tracking-tight">
                Configurar Nova Conexão de IA
              </DialogTitle>
              <DialogDescription className="text-base">
                Conecte sua conta a um provedor de modelos de linguagem para habilitar a inteligência artificial.
              </DialogDescription>
            </DialogHeader>
            
            <div className="p-8 md:p-10 grid grid-cols-1 md:grid-cols-5 gap-10">
              <div className="md:col-span-3 space-y-8">
                <div className="space-y-3">
                  <Label htmlFor="key_name" className="font-bold text-sm uppercase tracking-wider text-muted-foreground">
                    Nome da Conexão
                  </Label>
                  <Input
                    id="key_name"
                    required
                    value={keyFormData.name}
                    onChange={(e) => setKeyFormData({ ...keyFormData, name: e.target.value })}
                    placeholder="Ex: OpenRouter Principal ou Minha Chave Pessoal"
                    className="rounded-2xl h-14 text-lg border-border/60 bg-muted/10"
                  />
                </div>

                <div className="space-y-3">
                  <Label htmlFor="provider" className="font-bold text-sm uppercase tracking-wider text-muted-foreground">
                    Provedor de IA
                  </Label>
                  <Select
                    value={keyFormData.provider}
                    onValueChange={(value) => setKeyFormData({ ...keyFormData, provider: value })}
                  >
                    <SelectTrigger className="rounded-2xl h-14 text-lg border-border/60 bg-muted/10">
                      <SelectValue placeholder="Selecione um provedor" />
                    </SelectTrigger>
                    <SelectContent className="rounded-2xl">
                      {AI_PROVIDERS.map((provider) => (
                        <SelectItem key={provider.id} value={provider.id} className="py-3 rounded-xl">
                          <span className="font-semibold">{provider.name}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-3">
                  <Label htmlFor="api_key_value" className="font-bold text-sm uppercase tracking-wider text-muted-foreground">
                    Chave de API (API Key)
                  </Label>
                  <Input
                    id="api_key_value"
                    type="password"
                    required
                    value={keyFormData.key}
                    onChange={(e) => setKeyFormData({ ...keyFormData, key: e.target.value })}
                    placeholder="sk-..."
                    className="rounded-2xl h-14 font-mono text-base border-border/60 bg-muted/10"
                  />
                </div>
              </div>

              <div className="md:col-span-2 space-y-6">
                <div className="bg-primary/5 rounded-[2rem] p-6 border border-primary/10 h-full">
                  <h4 className="font-bold text-primary flex items-center gap-2 mb-4">
                    <Star className="h-4 w-4 fill-current" />
                    Como obter?
                  </h4>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-6">
                    Você pode criar e gerenciar suas chaves de API diretamente no painel do provedor selecionado.
                  </p>
                  
                  <div className="space-y-4">
                    <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Links Oficiais</p>
                    <a 
                      href={AI_PROVIDERS.find(p => p.id === keyFormData.provider)?.url} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="flex items-center justify-between p-3 bg-background rounded-xl border border-border/40 hover:border-primary/40 transition-colors group"
                    >
                      <span className="text-xs font-semibold">Obter Chave</span>
                      <Plus className="h-3 w-3 rotate-45 group-hover:rotate-0 transition-transform" />
                    </a>
                  </div>

                  <div className="mt-10 p-4 bg-amber-500/5 rounded-2xl border border-amber-500/10">
                    <p className="text-[10px] font-medium text-amber-600/80 leading-relaxed">
                      Segurança: Suas chaves são criptografadas e nunca serão compartilhadas com terceiros.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <DialogFooter className="p-8 md:p-10 pt-4 bg-muted/20 border-t border-border/40">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setIsKeyDialogOpen(false)}
                className="rounded-full h-12 px-6"
              >
                {t('cancel')}
              </Button>
              <Button
                type="submit"
                disabled={isSubmitting}
                className="rounded-full px-10 h-12 shadow-elevation bg-primary text-primary-foreground font-bold"
              >
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Salvar Conexão
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
