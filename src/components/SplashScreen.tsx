import { Loader2 } from 'lucide-react'
import closerLogo from '@/assets/closer_logo-fcd09.png'

export function SplashScreen() {
  return (
    <div className="flex h-screen w-full flex-col items-center justify-center gap-6 bg-background">
      <img src={closerLogo} alt="Closer" className="h-10 w-auto object-contain" />
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  )
}
