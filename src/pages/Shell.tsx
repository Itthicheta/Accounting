import { createContext, useContext, useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { sb, type Branch } from '../lib/supabase'

const BranchesCtx = createContext<Branch[]>([])
export const useBranches = () => useContext(BranchesCtx)

export default function Shell() {
  const [branches, setBranches] = useState<Branch[]>([])

  useEffect(() => {
    sb.from('branches').select('*').eq('is_active', true).order('code')
      .then(({ data }) => setBranches((data as Branch[]) ?? []))
  }, [])

  return (
    <BranchesCtx.Provider value={branches}>
      <div className="shell">
        <nav className="nav">
          <div className="brand">Mamapook<br />Accounting</div>
          <NavLink to="/" end>หน้าหลัก</NavLink>
          <NavLink to="/grab">Grab — Dashboard</NavLink>
          <NavLink to="/catering">Catering / Event</NavLink>
          <NavLink to="/peak">Peak — Export</NavLink>
          <button className="ghost" style={{ marginTop: 24 }} onClick={() => sb.auth.signOut()}>ออกจากระบบ</button>
        </nav>
        <main className="main">
          <Outlet />
        </main>
      </div>
    </BranchesCtx.Provider>
  )
}
