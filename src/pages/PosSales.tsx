import { useEffect, useState } from 'react'
import { sb, fetchAll, bkkToday } from '../lib/supabase'
import type { PosViewRow } from '../lib/peakExport'
import { useBranches } from './Shell'

const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

type Row = {
  branchCode: string
  methodName: string
  methodCode: string
  methodGroup: string
  storefront: { bills: number; amount: number }   // dine_in + take_away combined
  delivery: { bills: number; amount: number }
}

export default function PosSales() {
  const branches = useBranches()
  const [day, setDay] = useState(bkkToday())
  const [branch, setBranch] = useState('')       // '' = all branches
  const [rows, setRows] = useState<Row[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const byLocation = new Map(branches.filter(b => b.pos_location_id).map(b => [b.pos_location_id!, b.code]))
  const nameOf = (code: string) => branches.find(b => b.code === code)?.name_en ?? code
  const posBranches = branches.filter(b => b.pos_location_id)

  async function load() {
    setBusy(true); setError('')
    try {
      let q = (f: number, t: number) => {
        let query = sb.from('pos_channel_payment').select('*').eq('business_date', day)
        const loc = branches.find(b => b.code === branch)?.pos_location_id
        if (branch && loc) query = query.eq('location_id', loc)
        return query.order('location_id').range(f, t)
      }
      const data = await fetchAll<PosViewRow>(q)
      const agg = new Map<string, Row>()
      for (const r of data) {
        const code = byLocation.get(r.location_id)
        if (!code) continue
        const key = `${code}|${r.method_code}`
        if (!agg.has(key)) {
          agg.set(key, {
            branchCode: code, methodName: r.method_name, methodCode: r.method_code,
            methodGroup: r.method_group,
            storefront: { bills: 0, amount: 0 }, delivery: { bills: 0, amount: 0 },
          })
        }
        const a = agg.get(key)!
        const slot = r.channel === 'delivery' ? a.delivery : a.storefront
        slot.bills += Number(r.bills)
        slot.amount += Number(r.amount_thb)
      }
      setRows([...agg.values()].sort((a, z) =>
        a.branchCode.localeCompare(z.branchCode) ||
        (z.storefront.amount + z.delivery.amount) - (a.storefront.amount + a.delivery.amount)))
    } catch (err) {
      setError((err as Error).message)
    }
    setBusy(false)
  }

  useEffect(() => { if (branches.length) load() }, [branches.length, day, branch])

  const branchesInData = [...new Set(rows.map(r => r.branchCode))]
  const totalAmount = rows.reduce((s, r) => s + r.storefront.amount + r.delivery.amount, 0)
  const totalBills = rows.reduce((s, r) => s + r.storefront.bills + r.delivery.bills, 0)

  return (
    <div>
      <h1>POS Sales</h1>
      <p className="muted">ยอดขายจาก POS ตามช่องทางจ่ายเงิน (dine-in + take-away รวมกัน · delivery แยกไว้เพื่อกระทบยอดกับ Grab)</p>
      <div className="card row">
        <div><label>วันที่</label><input type="date" value={day} onChange={e => setDay(e.target.value)} /></div>
        <div><label>สาขา</label>
          <select value={branch} onChange={e => setBranch(e.target.value)}>
            <option value="">ทุกสาขา</option>
            {posBranches.map(b => <option key={b.code} value={b.code}>{b.name_en}</option>)}
          </select>
        </div>
        {busy && <span className="muted">กำลังโหลด…</span>}
      </div>
      {error && <div className="banner bad">{error}</div>}

      {branchesInData.map(bc => {
        const brRows = rows.filter(r => r.branchCode === bc)
        const brTotal = brRows.reduce((s, r) => s + r.storefront.amount + r.delivery.amount, 0)
        return (
          <div className="card scroll-x" key={bc}>
            <h2>{nameOf(bc)} — {fmt(brTotal)}</h2>
            <table className="data">
              <thead>
                <tr><th>ช่องทางจ่ายเงิน</th><th>บิลหน้าร้าน</th><th>ยอดหน้าร้าน</th><th>บิล delivery</th><th>ยอด delivery</th><th>รวม</th></tr>
              </thead>
              <tbody>
                {brRows.map((r, i) => (
                  <tr key={i}>
                    <td style={{ textAlign: 'left' }}>
                      {r.methodName}
                      {r.methodGroup === 'internal' && <span className="pct"> (internal — ไม่เข้า Peak)</span>}
                      {r.methodGroup === 'platform' && <span className="pct"> (เงินมาจากรอบโอน Grab)</span>}
                    </td>
                    <td>{r.storefront.bills || '—'}</td>
                    <td>{r.storefront.amount ? fmt(r.storefront.amount) : '—'}</td>
                    <td>{r.delivery.bills || '—'}</td>
                    <td>{r.delivery.amount ? fmt(r.delivery.amount) : '—'}</td>
                    <td>{fmt(r.storefront.amount + r.delivery.amount)}</td>
                  </tr>
                ))}
                <tr className="total">
                  <td style={{ textAlign: 'left' }}>รวม</td>
                  <td>{brRows.reduce((s, r) => s + r.storefront.bills, 0)}</td>
                  <td>{fmt(brRows.reduce((s, r) => s + r.storefront.amount, 0))}</td>
                  <td>{brRows.reduce((s, r) => s + r.delivery.bills, 0)}</td>
                  <td>{fmt(brRows.reduce((s, r) => s + r.delivery.amount, 0))}</td>
                  <td>{fmt(brTotal)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )
      })}

      {rows.length > 0 && !branch && (
        <div className="kpis">
          <div className="kpi"><div className="v">{fmt(totalAmount)}</div><div className="l">รวมทุกสาขา</div></div>
          <div className="kpi"><div className="v">{totalBills}</div><div className="l">บิลทั้งหมด</div></div>
        </div>
      )}
      {rows.length === 0 && !busy && !error && (
        <div className="banner warn">ไม่มีข้อมูล POS สำหรับวันที่นี้ (สาขาที่ sync แล้ว: Gaysorn, Sathorn Square)</div>
      )}
    </div>
  )
}
