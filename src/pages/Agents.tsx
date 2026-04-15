import { useState } from 'react'
import { useAgents } from '@/hooks/use-agents'
import { useLanguage } from '@/hooks/use-language'
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
import { Label } from '@/components/ui/label'
import { Plus, Trash2, Edit2, Loader2, Star } from 'lucide-react'
import { AIAgent } from '@/lib/types'

export default function Agents() {
  const {
    agents,
    loading,
    createAgent,
    updateAgent,
    deleteAgent,
    toggleAgentStatus,
    setAsDefault,
  } = useAgents()
  const { t } = useLanguage()

  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editingAgent, setEditingAgent] = useState<AIAgent | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const [formData, setFormData] = useState({
    name: '',
    description: '',
    system_prompt: '',
    gemini_api_key: '',
    is_active: true,
    is_default: false,
  })

  const handleOpenDialog = (agent?: AIAgent) => {
    if (agent) {
      setEditingAgent(agent)
      setFormData({
        name: agent.name,
        description: agent.description || '',
        system_prompt: agent.system_prompt,
        gemini_api_key: agent.gemini_api_key,
        is_active: agent.is_active,
        is_default: agent.is_default || false,
      })
    } else {
      setEditingAgent(null)
      setFormData({
        name: '',
        description: '',
        system_prompt: t('default_system_prompt'),
        gemini_api_key: '',
        is_active: true,
        is_default: agents.length === 0,
      })
    }
    setIsDialogOpen(true)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    try {
      if (editingAgent) {
        await updateAgent(editingAgent.id, formData)
      } else {
        await createAgent(formData)
      }
      setIsDialogOpen(false)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="max-w-7xl mx-auto space-y-10 p-6 md:p-12 animate-in fade-in slide-in-from-bottom-4 duration-700 ease-apple min-h-full bg-background">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
        <div>
          <h2 className="text-4xl font-bold tracking-tight text-foreground flex items-center gap-3">
            {t('agents_title')}
          </h2>
          <p className="text-muted-foreground mt-2 font-medium text-base">{t('agents_desc')}</p>
        </div>
        <Button
          onClick={() => handleOpenDialog()}
          className="rounded-full shadow-subtle px-6 h-12 font-semibold"
        >
          <Plus className="mr-2 h-5 w-5" />
          {t('create_agent')}
        </Button>
      </div>

      {loading ? (
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
                      <CardDescription className="text-xs font-semibold mt-0.5 uppercase tracking-wider">
                        {agent.is_active ? t('active') : t('inactive')}
                      </CardDescription>
                    </div>
                  </div>
                  <Switch
                    checked={agent.is_active}
                    onCheckedChange={() => toggleAgentStatus(agent.id, agent.is_active)}
                  />
                </div>
              </CardHeader>
              <CardContent className="flex-1 pb-6">
                <p className="text-sm text-muted-foreground line-clamp-3 leading-relaxed">
                  {agent.description || t('no_description')}
                </p>
                <div className="mt-4 p-3 bg-muted/50 rounded-xl border border-border/50">
                  <p className="text-xs font-mono text-muted-foreground line-clamp-2 leading-relaxed opacity-70">
                    {agent.system_prompt}
                  </p>
                </div>
              </CardContent>
              <div className="border-t border-border/40 bg-muted/10 p-4 flex justify-between items-center gap-2 shrink-0">
                <div>
                  {agent.is_default ? (
                    <div className="flex items-center text-xs font-semibold text-amber-500 bg-amber-500/10 px-3 py-1.5 rounded-full">
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
              <div className="space-y-3">
                <Label htmlFor="api_key" className="font-semibold">
                  {t('gemini_api_key')}
                </Label>
                <Input
                  id="api_key"
                  type="password"
                  required
                  value={formData.gemini_api_key}
                  onChange={(e) => setFormData({ ...formData, gemini_api_key: e.target.value })}
                  placeholder="AIzaSy..."
                  className="rounded-xl h-12 font-mono text-sm"
                />
                <p className="text-[11px] text-muted-foreground font-medium">{t('api_key_help')}</p>
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
                  className="rounded-xl min-h-[160px] resize-none font-mono text-sm leading-relaxed p-4"
                />
                <p className="text-[11px] text-muted-foreground font-medium">
                  {t('system_prompt_help')}
                </p>
              </div>
              <div className="flex items-center justify-between p-4 bg-muted/40 rounded-2xl border border-border/60">
                <div className="space-y-0.5">
                  <Label className="font-semibold">{t('agent_status')}</Label>
                  <p className="text-xs text-muted-foreground">{t('agent_status_help')}</p>
                </div>
                <Switch
                  checked={formData.is_active}
                  onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
                />
              </div>
              <div className="flex items-center justify-between p-4 bg-muted/40 rounded-2xl border border-border/60">
                <div className="space-y-0.5">
                  <Label className="font-semibold">Default Agent</Label>
                  <p className="text-xs text-muted-foreground">
                    Automatically assign this agent to new contacts.
                  </p>
                </div>
                <Switch
                  checked={formData.is_default}
                  onCheckedChange={(checked) => setFormData({ ...formData, is_default: checked })}
                />
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
                disabled={isSubmitting}
                className="rounded-full px-8 shadow-subtle"
              >
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {editingAgent ? t('save_changes') : t('create_agent')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
