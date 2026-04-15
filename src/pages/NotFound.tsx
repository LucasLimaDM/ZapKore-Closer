import { useLocation, Link } from 'react-router-dom'
import { useEffect } from 'react'
import { useLanguage } from '@/hooks/use-language'

const NotFound = () => {
  const location = useLocation()
  const { t } = useLanguage()

  useEffect(() => {
    console.error(`404 Error: ${t('not_found_desc')} ${location.pathname}`)
  }, [location.pathname, t])

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background font-sans">
      <div className="text-center space-y-4">
        <h1 className="text-6xl font-bold tracking-tighter text-foreground">404</h1>
        <p className="text-xl text-muted-foreground font-medium">{t('page_not_found')}</p>
        <Link
          to="/"
          className="inline-block mt-4 text-primary hover:text-primary/80 font-semibold transition-colors"
        >
          {t('return_home')}
        </Link>
      </div>
    </div>
  )
}

export default NotFound
