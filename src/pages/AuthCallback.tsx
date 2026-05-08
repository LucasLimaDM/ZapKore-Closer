import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import type { EmailOtpType } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase/client'
import { Loader2 } from 'lucide-react'

export default function AuthCallback() {
  const navigate = useNavigate()
  const done = useRef(false)

  useEffect(() => {
    // Handle token_hash links from Send Email Hook (query string, not fragment)
    const params = new URLSearchParams(window.location.search)
    const token_hash = params.get('token_hash')
    const type = params.get('type') as EmailOtpType | null
    if (token_hash && type) {
      supabase.auth.verifyOtp({ token_hash, type }).then(({ error }) => {
        if (done.current) return
        done.current = true
        navigate(error ? '/auth' : '/app', { replace: true })
      })
      return
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
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
