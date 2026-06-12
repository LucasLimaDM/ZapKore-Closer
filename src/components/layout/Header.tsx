import { useAuth } from '@/hooks/use-auth'
import { useIntegration } from '@/hooks/use-integration'
import { useLanguage } from '@/hooks/use-language'
import { useNotifications } from '@/hooks/use-notifications'
import { LanguageSwitcher } from '@/components/LanguageSwitcher'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { LogOut, Settings, Bell, AlertCircle } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'
import closerLogo from '@/assets/closer_logo-fcd09.png'
import { formatDistanceToNow } from 'date-fns'
import { ptBR } from 'date-fns/locale'

export function Header() {
  const { user, signOut } = useAuth()
  const { integration } = useIntegration()
  const { t } = useLanguage()
  const navigate = useNavigate()
  const { notifications, unreadCount, markAllRead } = useNotifications()

  const handleSignOut = async () => {
    await signOut()
    navigate('/')
  }

  const getStatusColor = (status?: string) => {
    if (status === 'CONNECTED') return 'bg-primary'
    if (status === 'WAITING_QR') return 'bg-blue-500 animate-pulse'
    return 'bg-muted-foreground'
  }

  return (
    <header className="sticky top-0 z-30 flex h-20 items-center justify-between border-b border-border bg-background/80 backdrop-blur-2xl px-6 md:px-10 transition-all">
      <div className="flex items-center gap-5">
        <div className="flex items-center md:hidden -mt-[17px]">
          <img src={closerLogo} alt="Closer" className="h-12 w-auto object-contain" />
        </div>
        <div className="flex items-center gap-2.5 text-xs font-bold text-foreground bg-muted/50 px-4 py-2 rounded-full border border-border shadow-subtle">
          <div className={cn('h-2.5 w-2.5 rounded-full', getStatusColor(integration?.status))} />
          <span className="hidden sm:inline-block tracking-tight uppercase">
            {integration?.status === 'CONNECTED'
              ? t('connected')
              : integration?.status === 'WAITING_QR'
                ? t('waiting_qr')
                : t('disconnected')}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <LanguageSwitcher />

        {/* Notification bell */}
        <DropdownMenu onOpenChange={(open) => { if (open && unreadCount > 0) markAllRead() }}>
          <DropdownMenuTrigger className="outline-none relative">
            <div className="flex items-center justify-center h-11 w-11 rounded-full border-2 border-border bg-card shadow-subtle hover:scale-105 transition-transform duration-300 cursor-pointer">
              <Bell className="h-4 w-4 text-foreground" />
              {unreadCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 h-4 w-4 flex items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-white leading-none">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </div>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-80 rounded-2xl shadow-elevation border border-border p-2 max-h-[480px] overflow-y-auto"
          >
            <div className="px-4 py-3 mb-1 border-b border-border flex items-center justify-between">
              <span className="text-[13px] font-bold text-foreground">Alertas do Agente</span>
              {notifications.length > 0 && (
                <span className="text-[11px] font-semibold text-muted-foreground">{notifications.length} alerta{notifications.length !== 1 ? 's' : ''}</span>
              )}
            </div>

            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <Bell className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
                <p className="text-[13px] font-semibold text-muted-foreground">Nenhum alerta</p>
              </div>
            ) : (
              notifications.map((n) => (
                <div
                  key={n.id}
                  className={cn(
                    'rounded-xl px-4 py-3 my-1 flex gap-3 items-start transition-colors',
                    !n.read_at ? 'bg-destructive/5 border border-destructive/20' : 'bg-muted/30',
                    n.contact_id && 'cursor-pointer hover:bg-muted/60',
                  )}
                  onClick={() => {
                    if (n.contact_id) navigate(`/app/chat/${n.contact_id}`)
                  }}
                >
                  <AlertCircle className={cn('h-4 w-4 mt-0.5 shrink-0', !n.read_at ? 'text-destructive' : 'text-muted-foreground')} />
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-bold text-foreground leading-tight">{n.title}</p>
                    {n.body && (
                      <p className="text-[11px] font-medium text-muted-foreground mt-0.5 leading-relaxed break-words">{n.body}</p>
                    )}
                    <p className="text-[10px] font-semibold text-muted-foreground/60 mt-1">
                      {formatDistanceToNow(new Date(n.created_at), { addSuffix: true, locale: ptBR })}
                    </p>
                  </div>
                </div>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger className="outline-none">
            <Avatar className="h-11 w-11 border-2 border-border shadow-subtle cursor-pointer hover:scale-105 transition-transform duration-300">
              <AvatarFallback className="bg-muted text-foreground font-bold text-sm">
                {user?.email?.charAt(0).toUpperCase() || 'U'}
              </AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-60 rounded-2xl shadow-elevation border border-border p-2"
          >
            <div className="px-4 py-3 mb-1 text-[13px] font-semibold text-muted-foreground truncate border-b border-border">
              {user?.email}
            </div>
            <DropdownMenuItem
              asChild
              className="rounded-xl cursor-pointer my-1 focus:bg-muted py-2.5"
            >
              <Link to="/settings" className="flex items-center gap-3 font-semibold">
                <Settings className="h-4 w-4 text-muted-foreground" /> {t('settings_nav')}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={handleSignOut}
              className="cursor-pointer text-destructive focus:text-destructive focus:bg-destructive/10 rounded-xl flex items-center gap-3 font-semibold py-2.5"
            >
              <LogOut className="h-4 w-4" /> {t('logout')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
