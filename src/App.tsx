import { useEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { sb } from './lib/supabase'
import Login from './pages/Login'
import Shell from './pages/Shell'
import Home from './pages/Home'
import PosSales from './pages/PosSales'
import GrabDashboard from './pages/GrabDashboard'
import PeakExport from './pages/PeakExport'
import CateringList from './pages/CateringList'
import CateringForm from './pages/CateringForm'
import Config from './pages/Config'

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  if (loading) return <div className="login-wrap"><div className="muted">กำลังโหลด…</div></div>
  if (!session) return <Login />

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route path="/" element={<Home />} />
        <Route path="/pos" element={<PosSales />} />
        <Route path="/grab" element={<GrabDashboard />} />
        <Route path="/peak" element={<PeakExport />} />
        <Route path="/catering" element={<CateringList />} />
        <Route path="/catering/new" element={<CateringForm />} />
        <Route path="/catering/:id" element={<CateringForm />} />
        <Route path="/config" element={<Config />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
