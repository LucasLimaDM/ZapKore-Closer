import { Link, useLocation } from 'react-router-dom'
import { useLanguage } from '@/hooks/use-language'
import { LayoutDashboard, Users, Settings as SettingsIcon, Columns } from 'lucide-react'
import { cn } from '@/lib/utils'

export function BottomNav() {
  const location = useLocation()
  const { t } = useLanguage()

  const navItems = [
    { name: t('overview_nav') || 'Overview', path: '/app', icon: LayoutDashboard },
    { name: t('pipeline_nav') || 'Pipeline', path: '/app/pipeline', icon: Columns },
    { name: t('contacts_nav') || 'Contacts', path: '/app/contacts', icon: Users },
    { name: t('settings_nav') || 'Settings', path: '/settings', icon: SettingsIcon },
  ]

  return (
    <nav className="fixed bottom-0 left-0 z-40 w-full border-t border-border bg-background/90 backdrop-blur-2xl pb-safe md:hidden">
      <div className="flex h-20 justify-around items-center px-2">
        {navItems.map((item) => {
          const isActive =
            location.pathname === item.path ||
            (item.path !== '/app' && location.pathname.startsWith(item.path))
          return (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                'flex flex-col items-center justify-center w-full h-full gap-1.5 text-[11px] font-bold transition-all duration-300',
                isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <item.icon
                className={cn(
                  'h-6 w-6 mb-0.5 transition-colors duration-300',
                  isActive ? 'text-foreground' : 'text-muted-foreground',
                )}
              />
              <span className="truncate max-w-full px-1">{item.name}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
