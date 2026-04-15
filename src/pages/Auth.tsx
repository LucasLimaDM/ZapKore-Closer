import { useState } from 'react'
import { useAuth } from '@/hooks/use-auth'
import { useLanguage } from '@/hooks/use-language'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { LanguageSwitcher } from '@/components/LanguageSwitcher'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useNavigate, Navigate } from 'react-router-dom'
import closerLogo from '@/assets/closer_logo-fcd09.png'

export default function Auth() {
  const [isSignUp, setIsSignUp] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const { signIn, signUp, user, loading: authLoading } = useAuth()
  const { t } = useLanguage()
  const navigate = useNavigate()

  if (!authLoading && user) {
    return <Navigate to="/app" replace />
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)

    const action = isSignUp ? signUp : signIn
    const { error } = await action(email, password)

    setLoading(false)
    if (error) {
      toast.error(error.message)
    } else {
      toast.success(isSignUp ? t('account_created') : t('welcome_back'))
      navigate('/app')
    }
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4 pt-20 font-sans relative">
      <div className="absolute top-6 right-6">
        <LanguageSwitcher />
      </div>
      <Card className="w-full max-w-md shadow-elevation border border-border/40 rounded-[2rem] bg-white animate-in fade-in slide-in-from-bottom-8 duration-500 ease-apple">
        <CardHeader className="space-y-4 text-center pb-6 pt-10 px-8">
          <div className="mx-auto mb-4 flex justify-center">
            <img src={closerLogo} alt="Closer" className="h-10 w-auto object-contain" />
          </div>
          <CardTitle className="text-3xl font-semibold tracking-tight">
            {isSignUp ? t('create_account') : t('welcome_back')}
          </CardTitle>
          <CardDescription className="text-base font-medium">
            {isSignUp ? t('email_create_desc') : t('email_signin_desc')}
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-6 px-10">
            <div className="space-y-3">
              <Label htmlFor="email" className="font-medium text-foreground">
                {t('email')}
              </Label>
              <Input
                id="email"
                type="email"
                placeholder="m@example.com"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-12 rounded-xl bg-transparent border-border/60 focus-visible:ring-1 focus-visible:ring-primary/50 font-medium"
              />
            </div>
            <div className="space-y-3">
              <Label htmlFor="password" className="font-medium text-foreground">
                {t('password')}
              </Label>
              <Input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-12 rounded-xl bg-transparent border-border/60 focus-visible:ring-1 focus-visible:ring-primary/50 font-medium"
              />
            </div>
          </CardContent>
          <CardFooter className="flex flex-col gap-6 px-10 pb-10 pt-4">
            <Button
              type="submit"
              className="w-full h-12 rounded-xl font-semibold shadow-subtle transition-all"
              disabled={loading}
            >
              {loading && <Loader2 className="mr-2 h-5 w-5 animate-spin" />}
              {isSignUp ? t('sign_up') : t('sign_in')}
            </Button>
            <div className="text-sm text-center text-muted-foreground font-medium">
              {isSignUp ? t('already_have_account') : t('dont_have_account')}
              <button
                type="button"
                onClick={() => setIsSignUp(!isSignUp)}
                className="ml-1.5 text-primary hover:text-primary/80 font-semibold transition-colors"
              >
                {isSignUp ? t('sign_in') : t('sign_up')}
              </button>
            </div>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
