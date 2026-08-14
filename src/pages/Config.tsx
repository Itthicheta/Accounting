import { useEffect, useState } from 'react'
import { sb, type Branch } from '../lib/supabase'
import { DEFAULT_PEAK_CONFIG } from '../lib/peakExport'

type Editable = Pick<Branch, 'peak_customer' | 'peak_bank_sub' | 'tungngern_peak_sub' | 'peak_class' | 'grab_store_id'>
const FIELDS: { key: keyof Editable; label: string; width?: number }[] = [
  { key: 'peak_customer', label: 'ลูกค้า (E)', width: 90 },
  { key: 'peak_bank_sub', label: 'บัญชีธนาคาร (R)', width: 100 },
  { key: 'tungngern_peak_sub', label: 'บัญชีถุงเงิน (R)', width: 100 },
  { key: 'peak_class', label: 'กลุ่มจัดประเภท (T)', width: 100 },
  { key: 'grab_store_id', label: 'Grab store id', width: 260 },
]

const SETTING_META: { key: string; label: string }[] = [
  { key: 'peak_revenue_account', label: 'บัญชีรายได้ (K)' },
  { key: 'peak_vat_rate', label: 'อัตราภาษี (P)' },
  { key: 'peak_price_type', label: 'ประเภทราคา (I): 1=แยกภาษี 2=รวมภาษี 3=ไม่มีภาษี' },
  { key: 'peak_tax_invoice', label: 'ออกใบกำกับภาษี (H): 1=ออก 2=ไม่ออก' },
  { key: 'peak_qty', label: 'จำนวน (M) — คงที่' },
]

export default function Config() {
  const [rows, setRows] = useState<Branch[]>([])
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  async function load() {
    const [{ data: br, error: be }, { data: st, error: se }] = await Promise.all([
      sb.from('branches').select('*').order('code'),
      sb.from('app_settings').select('*'),
    ])
    if (be || se) { setErr((be ?? se)!.message); return }
    setRows((br as Branch[]) ?? [])
    const s: Record<string, string> = {}
    for (const r of (st as { key: string; value: string }[]) ?? []) s[r.key] = r.value
    setSettings(s)
  }
  useEffect(() => { load() }, [])

  function setField(code: string, key: keyof Editable, value: string) {
    setRows(rs => rs.map(r => r.code === code ? { ...r, [key]: value } : r))
  }

  async function save() {
    setBusy(true); setMsg(''); setErr('')
    try {
      for (const r of rows) {
        const patch: Record<string, string | null> = {}
        for (const f of FIELDS) patch[f.key] = (r[f.key] as string | null)?.trim() || null
        const { error } = await sb.from('branches').update(patch).eq('code', r.code)
        if (error) throw error
      }
      for (const m of SETTING_META) {
        const value = (settings[m.key] ?? '').trim()
        if (!value) continue
        const { error } = await sb.from('app_settings').upsert({ key: m.key, value }, { onConflict: 'key' })
        if (error) throw error
      }
      setMsg('บันทึกการตั้งค่าแล้ว — มีผลกับไฟล์ Peak ที่สร้างครั้งถัดไปทันที')
      setEditing(false)
    } catch (e) {
      setErr((e as Error).message)
    }
    setBusy(false)
  }

  return (
    <div>
      <h1>ตั้งค่า Peak</h1>
      <p className="muted">แผนที่สาขา → รหัสใน Peak และค่าคงที่ของไฟล์ Import_Receipt — แก้ที่นี่ ไม่ต้องแก้โค้ด</p>

      <div className="card scroll-x">
        <h2>สาขา</h2>
        <table className="data">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>สาขา</th>
              {FIELDS.map(f => <th key={f.key} style={{ textAlign: 'left' }}>{f.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.code}>
                <td style={{ textAlign: 'left', fontWeight: 500 }}>{r.name_en}{!r.is_active && <span className="pct"> (inactive)</span>}</td>
                {FIELDS.map(f => (
                  <td key={f.key} style={{ textAlign: 'left' }}>
                    <input
                      style={{ width: f.width ?? 110, padding: '4px 6px', fontSize: 13, opacity: editing ? 1 : 0.75, background: editing ? '#fff' : 'transparent', borderColor: editing ? 'var(--border)' : 'transparent' }}
                      value={(r[f.key] as string | null) ?? ''}
                      disabled={!editing}
                      onChange={e => setField(r.code, f.key, e.target.value)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted" style={{ marginTop: 8 }}>
          บัญชีถุงเงิน: เว้นว่างสำหรับสาขาที่ไม่ได้เข้าร่วมไทยชวยไทย (Rama 9, Sathorn, All Seasons) —
          ระบบจะเตือนแทนที่จะใส่บรรทัดผิดบัญชี
        </p>
      </div>

      <div className="card">
        <h2>ค่าคงที่ของไฟล์ Peak</h2>
        <div className="row">
          {SETTING_META.map(m => (
            <div key={m.key}>
              <label>{m.label}</label>
              <input
                style={{ width: 150, opacity: editing ? 1 : 0.75, background: editing ? '#fff' : 'transparent', borderColor: editing ? 'var(--border)' : 'transparent' }}
                disabled={!editing}
                value={settings[m.key] ?? ''}
                placeholder={String(DEFAULT_PEAK_CONFIG[
                  m.key === 'peak_revenue_account' ? 'revenueAccount'
                    : m.key === 'peak_vat_rate' ? 'vatRate'
                      : m.key === 'peak_price_type' ? 'priceType' : 'taxInvoice'])}
                onChange={e => setSettings(s => ({ ...s, [m.key]: e.target.value }))}
              />
            </div>
          ))}
        </div>
      </div>

      {msg && <div className="banner ok">{msg}</div>}
      {err && <div className="banner bad">{err}</div>}
      {!editing
        ? <button className="primary" onClick={() => { setMsg(''); setErr(''); setEditing(true) }}>แก้ไข</button>
        : <>
            <button className="primary" onClick={save} disabled={busy}>{busy ? 'กำลังบันทึก…' : 'บันทึกการตั้งค่า'}</button>
            <button className="ghost" style={{ marginLeft: 8 }} onClick={() => { setEditing(false); load() }}>ยกเลิก</button>
          </>}
    </div>
  )
}
