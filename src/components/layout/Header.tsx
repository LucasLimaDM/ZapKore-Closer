import { useAuth } from '@/hooks/use-auth'
import { useIntegration } from '@/hooks/use-integration'
import { useLanguage } from '@/hooks/use-language'
import { LanguageSwitcher } from '@/components/LanguageSwitcher'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { LogOut, Settings } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'
import closerLogo from '@/assets/closer_logo-fcd09.png'

export function Header() {
  const { user, signOut } = useAuth()
  const { integration } = useIntegration()
  const { t } = useLanguage()
  const navigate = useNavigate()

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
