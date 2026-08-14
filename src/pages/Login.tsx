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
    // staff type a plain id (e.g. "account"); map to the internal email form
    const fullEmail = email.includes('@') ? email : `${email.trim()}@mamapook.test`
    const { error } = await sb.auth.signInWithPassword({ email: fullEmail, password })
    if (error) setErr('เข้าสู่ระบบไม่สำเร็จ: ' + error.message)
    setBusy(false)
  }

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <h1>Mamapook Accounting</h1>
        <p className="muted">เข้าสู่ระบบด้วยบัญชีพนักงาน</p>
        <label>ไอดี</label>
        <input type="text" value={email} onChange={e => setEmail(e.target.value)} autoCapitalize="none" required />
        <label>รหัสผ่าน</label>
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} required />
        {err && <div className="banner bad">{err}</div>}
        <button className="primary" disabled={busy}>{busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}</button>
      </form>
    </div>
  )
}
