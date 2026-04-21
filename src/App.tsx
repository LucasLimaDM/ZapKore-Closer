import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster as Sonner } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AuthProvider, useAuth } from '@/hooks/use-auth'
import { LanguageProvider } from '@/hooks/use-language'
import { IntegrationProvider, useIntegration } from '@/hooks/use-integration'
import { SplashScreen } from '@/components/SplashScreen'

import Layout from './components/Layout'
import DashboardLayout from './components/DashboardLayout'
import Index from './pages/Index'
import Auth from './pages/Auth'
import Dashboard from './pages/Dashboard'
import Contacts from './pages/Contacts'
import Pipeline from './pages/Pipeline'
import Settings from './pages/Settings'
import Chat from './pages/Chat'
import Agents from './pages/Agents'
import NotFound from './pages/NotFound'
import Onboarding from './pages/Onboarding'
import AuthCallback from './pages/AuthCallback'

function AppRoutes() {
  const { loading: authLoading } = useAuth()
  const { loading: integrationLoading } = useIntegration()

  if (authLoading || integrationLoading) return <SplashScreen />

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Index />} />
        <Route path="/auth" element={<Auth />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
      </Route>

      <Route path="/app" element={<DashboardLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="onboarding" element={<Onboarding />} />
        <Route path="pipeline" element={<Pipeline />} />
        <Route path="contacts" element={<Contacts />} />
        <Route path="chat/:id" element={<Chat />} />
        <Route path="agents" element={<Agents />} />
      </Route>

      <Route path="/settings" element={<DashboardLayout />}>
        <Route index element={<Settings />} />
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}

const App = () => (
  <LanguageProvider>
    <BrowserRouter>
      <AuthProvider>
        <IntegrationProvider>
          <TooltipProvider>
            <Sonner position="top-right" richColors />
            <AppRoutes />
          </TooltipProvider>
        </IntegrationProvider>
      </AuthProvider>
    </BrowserRouter>
  </LanguageProvider>
)

export default App
