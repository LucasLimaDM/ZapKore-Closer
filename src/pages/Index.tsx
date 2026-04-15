import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '@/hooks/use-auth'
import { useLanguage } from '@/hooks/use-language'
import { LanguageSwitcher } from '@/components/LanguageSwitcher'
import { Button } from '@/components/ui/button'
import { Users, History, Zap } from 'lucide-react'
import closerLogo from '@/assets/closer_logo-fcd09.png'

export default function Index() {
  const { user, loading } = useAuth()
  const { t } = useLanguage()

  if (!loading && user) {
    return <Navigate to="/app" replace />
  }

  return (
    <div className="min-h-screen bg-background flex flex-col font-sans">
      <header className="border-b border-border/40 bg-white/80 backdrop-blur-xl px-6 py-4 flex items-center justify-between fixed top-0 w-full z-50 transition-all">
        <div className="flex items-center">
          <img src={closerLogo} alt="Closer" className="h-8 w-auto object-contain" />
        </div>
        <div className="flex gap-2 sm:gap-4 items-center">
          <LanguageSwitcher />
          <Button variant="ghost" className="rounded-full font-medium" asChild>
            <Link to="/auth">{t('sign_in')}</Link>
          </Button>
          <Button
            className="rounded-full shadow-subtle font-medium px-6 hidden sm:inline-flex"
            asChild
          >
            <Link to="/auth">{t('get_started')}</Link>
          </Button>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-4 py-32 text-center mt-12">
        <div className="max-w-4xl space-y-8 animate-in fade-in slide-in-from-bottom-8 duration-700 ease-apple">
          <h1 className="text-5xl md:text-7xl font-bold tracking-tighter text-foreground leading-[1.1]">
            {t('hero_title')}
            <br />
            <span className="text-muted-foreground">{t('hero_subtitle')}</span>
          </h1>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed font-medium">
            {t('hero_description')}
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center pt-8">
            <Button
              size="lg"
              className="h-14 px-10 text-lg rounded-full shadow-elevation hover:shadow-floating transition-all duration-300 ease-apple font-medium"
              asChild
            >
              <Link to="/auth">{t('start_free_trial')}</Link>
            </Button>
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-6 max-w-5xl mt-32 w-full">
          <div
            className="bg-white p-10 rounded-[2rem] shadow-subtle border border-border/40 flex flex-col items-center text-center gap-6 hover:shadow-floating transition-all duration-500 ease-apple animate-in fade-in slide-in-from-bottom-8"
            style={{ animationDelay: '100ms' }}
          >
            <div className="h-14 w-14 bg-primary/10 rounded-2xl flex items-center justify-center text-primary">
              <Users className="h-6 w-6" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-foreground tracking-tight mb-2">
                {t('auto_import')}
              </h3>
              <p className="text-muted-foreground font-medium text-sm leading-relaxed">
                {t('auto_import_desc')}
              </p>
            </div>
          </div>
          <div
            className="bg-white p-10 rounded-[2rem] shadow-subtle border border-border/40 flex flex-col items-center text-center gap-6 hover:shadow-floating transition-all duration-500 ease-apple animate-in fade-in slide-in-from-bottom-8"
            style={{ animationDelay: '200ms' }}
          >
            <div className="h-14 w-14 bg-primary/10 rounded-2xl flex items-center justify-center text-primary">
              <History className="h-6 w-6" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-foreground tracking-tight mb-2">
                {t('history_backup')}
              </h3>
              <p className="text-muted-foreground font-medium text-sm leading-relaxed">
                {t('history_backup_desc')}
              </p>
            </div>
          </div>
          <div
            className="bg-white p-10 rounded-[2rem] shadow-subtle border border-border/40 flex flex-col items-center text-center gap-6 hover:shadow-floating transition-all duration-500 ease-apple animate-in fade-in slide-in-from-bottom-8"
            style={{ animationDelay: '300ms' }}
          >
            <div className="h-14 w-14 bg-primary/10 rounded-2xl flex items-center justify-center text-primary">
              <Zap className="h-6 w-6" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-foreground tracking-tight mb-2">
                {t('realtime_sync')}
              </h3>
              <p className="text-muted-foreground font-medium text-sm leading-relaxed">
                {t('realtime_sync_desc')}
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
