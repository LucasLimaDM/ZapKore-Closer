import { Link, useLocation } from 'react-router-dom'
import { useLanguage } from '@/hooks/use-language'
import { LayoutDashboard, Users, Settings as SettingsIcon, Bot, Columns } from 'lucide-react'
import { cn } from '@/lib/utils'
import closerLogo from '@/assets/closer_logo-fcd09.png'

export function Sidebar() {
  const location = useLocation()
  const { t } = useLanguage()

  const navItems = [
    { name: t('overview_nav') || 'Overview', path: '/app', icon: LayoutDashboard },
    { name: t('pipeline_nav') || 'Pipeline', path: '/app/pipeline', icon: Columns },
    { name: t('contacts_nav') || 'Contacts', path: '/app/contacts', icon: Users },
    { name: 'AI Agents', path: '/app/agents', icon: Bot },
    { name: t('settings_nav') || 'Settings', path: '/settings', icon: SettingsIcon },
  ]

  return (
    <aside className="hidden w-64 flex-col border-r border-border bg-background md:flex z-20">
      <div className="flex flex-col pt-7 pb-5 px-7">
        <div className="flex items-center py-1 -mt-[17px]">
          <img src={closerLogo} alt="Closer" className="h-12 w-auto object-contain" />
        </div>
      </div>
      <nav className="flex-1 space-y-2 p-5">
        {navItems.map((item) => {
          const isActive =
            location.pathname === item.path ||
            (item.path !== '/app' && location.pathname.startsWith(item.path))
          return (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                'flex items-center gap-3.5 rounded-2xl px-4 py-3.5 text-[15px] font-semibold transition-all duration-300',
                isActive
                  ? 'bg-card text-foreground shadow-subtle border border-border'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground border border-transparent',
              )}
            >
              <item.icon className="h-5 w-5" />
              {item.name}
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
