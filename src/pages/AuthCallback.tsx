import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { Loader2 } from 'lucide-react'

export default function AuthCallback() {
  const navigate = useNavigate()
  const done = useRef(false)

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (done.current) return
      if (event === 'SIGNED_IN' && session) {
        done.current = true
        navigate('/app', { replace: true })
      }
    })

    // Session may already be set if detectSessionInUrl completed synchronously
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (done.current) return
      if (session) {
        done.current = true
        navigate('/app', { replace: true })
      }
    })

    // Fallback: if no auth event fires (e.g. expired/invalid code), redirect to login
    const timer = setTimeout(() => {
      if (!done.current) {
        done.current = true
        navigate('/auth', { replace: true })
      }
    }, 8000)

    return () => {
      subscription.unsubscribe()
      clearTimeout(timer)
    }
  }, [navigate])

  return (
    <div className="flex h-screen w-full items-center justify-center bg-background">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  )
}
