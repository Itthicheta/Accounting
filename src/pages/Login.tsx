import { useState } from 'react'
import { sb } from '../lib/supabase'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    const { error } = await sb.auth.signInWithPassword({ email, password })
    if (error) setErr('เข้าสู่ระบบไม่สำเร็จ: ' + error.message)
    setBusy(false)
  }

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <h1>Mamapook Accounting</h1>
        <p className="muted">เข้าสู่ระบบด้วยบัญชีพนักงาน</p>
        <label>อีเมล</label>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} required />
        <label>รหัสผ่าน</label>
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} required />
        {err && <div className="banner bad">{err}</div>}
        <button className="primary" disabled={busy}>{busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}</button>
      </form>
    </div>
  )
}
