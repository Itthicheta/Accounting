import { useEffect, useState } from 'react'
import { sb, fetchAll, bkkToday } from '../lib/supabase'
import type { PosViewRow } from '../lib/peakExport'
import { reconByBranch, COMPANY } from '../lib/grabCalc'
import { dbToGrabRow } from '../lib/grabIngest'
import { useBranches } from './Shell'

const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

type Cell = { bills: number; amount: number }
type BranchBlock = {
  branchCode: string
  store: Map<string, Cell>       // storefront (dine_in + take_away) by method key
  storeOther: Map<string, Cell>  // future methods (alipay, wechat, …) by name
  grabTransfer: Cell             // bills from POS; amount = โอนเข้าธนาคาร (คำนวณ) from Grab report
  grabTct: Cell                  // bills from POS delivery×TCT; amount = เข้าถุงเงิน from Grab report
  deliveryOther: Map<string, Cell>
  internal: Cell
  grabHasReport?: boolean
}

const blank = (): Cell => ({ bills: 0, amount: 0 })
const add = (c: Cell, bills: number, amount: number) => { c.bills += bills; c.amount += amount }

export default function PosSales() {
  const branches = useBranches()
  const [day, setDay] = useState(bkkToday())
  const [branch, setBranch] = useState('')
  const [blocks, setBlocks] = useState<BranchBlock[]>([])
  const [freshness, setFreshness] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const byLocation = new Map(branches.filter(b => b.pos_location_id).map(b => [b.pos_location_id!, b.code]))
  const byStoreId = new Map(branches.filter(b => b.grab_store_id).map(b => [b.grab_store_id!, b.code]))
  const nameOf = (code: string) => branches.find(b => b.code === code)?.name_en ?? code
  const posBranches = branches.filter(b => b.pos_location_id)

  async function load() {
    setBusy(true); setError('')
    try {
      const data = await fetchAll<PosViewRow>((f, t) => {
        let query = sb.from('pos_channel_payment').select('*').eq('business_date', day)
        const loc = branches.find(b => b.code === branch)?.pos_location_id
        if (branch && loc) query = query.eq('location_id', loc)
        return query.order('location_id').range(f, t)
      })
      const byBranch = new Map<string, BranchBlock>()
      for (const r of data) {
        const code = byLocation.get(r.location_id)
        if (!code) continue
        if (!byBranch.has(code)) {
          byBranch.set(code, {
            branchCode: code, store: new Map(), storeOther: new Map(),
            grabTransfer: blank(), grabTct: blank(), deliveryOther: new Map(), internal: blank(),
          })
        }
        const b = byBranch.get(code)!
        const bills = Number(r.bills)
        const amount = Number(r.amount_thb)
        if (r.method_group === 'internal') { add(b.internal, bills, amount); continue }
        if (r.method_group === 'platform') { b.grabTransfer.bills += bills; continue }
        if (r.channel === 'delivery') {
          if (r.method_code === 'thai_chuai_thai') b.grabTct.bills += bills
          else {
            if (!b.deliveryOther.has(r.method_name)) b.deliveryOther.set(r.method_name, blank())
            add(b.deliveryOther.get(r.method_name)!, bills, amount)
          }
          continue
        }
        // storefront: dine_in + take_away combined
        if (['bank_transfer', 'cash', 'thai_chuai_thai'].includes(r.method_code)) {
          if (!b.store.has(r.method_code)) b.store.set(r.method_code, blank())
          add(b.store.get(r.method_code)!, bills, amount)
        } else {
          if (!b.storeOther.has(r.method_name)) b.storeOther.set(r.method_name, blank())
          add(b.storeOther.get(r.method_name)!, bills, amount)
        }
      }
      // Grab section AMOUNTS come from the Grab report (settlement), not POS:
      // เงินโอน = โอนเข้าธนาคาร (คำนวณ), ไทยช่วยไทย = เข้าถุงเงิน (TCT).
      // POS keeps only the bill counts (used for the count reconcile).
      const grabDb = await fetchAll<Record<string, unknown>>((f, t) => sb.from('grab_rows')
        .select('*').eq('business_date', day).order('id').range(f, t))
      const grabRows = grabDb.map(dbToGrabRow).filter(r => r.category !== 'ยกเลิก')
      const recon = grabRows.length
        ? reconByBranch({ rows: grabRows, payouts: [], periodStart: day, periodEnd: day, declaredStart: day, declaredEnd: day, warnings: [] })
        : []
      for (const rb of recon) {
        if (rb.store === COMPANY) continue
        const code = byStoreId.get(rb.grabStoreId)
        if (!code) continue
        if (!byBranch.has(code)) {
          byBranch.set(code, {
            branchCode: code, store: new Map(), storeOther: new Map(),
            grabTransfer: blank(), grabTct: blank(), deliveryOther: new Map(), internal: blank(),
          })
        }
        const b = byBranch.get(code)!
        b.grabTransfer.amount = rb.bankPayoutCalc
        b.grabTct.amount = rb.walletReceive
        b.grabHasReport = true
      }
      setBlocks([...byBranch.values()].sort((a, z) => a.branchCode.localeCompare(z.branchCode)))
      const { data: log } = await sb.from('pos_refresh_log')
        .select('ran_at,status').eq('status', 'ok').order('id', { ascending: false }).limit(1)
      if (log?.length) {
        const parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit', hour12: false,
        }).formatToParts(new Date(log[0].ran_at as string))
          .reduce<Record<string, string>>((a, x) => (a[x.type] = x.value, a), {})
        setFreshness(`ข้อมูล POS อัปเดตล่าสุด ${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute} (รีเฟรชอัตโนมัติทุก 30 นาที)`)
      }
    } catch (err) {
      setError((err as Error).message)
    }
    setBusy(false)
  }

  useEffect(() => { if (branches.length) load() }, [branches.length, day, branch])

  const grand = blocks.reduce((s, b) => {
    const store = [...b.store.values(), ...b.storeOther.values()]
    const grab = [b.grabTransfer, b.grabTct, ...b.deliveryOther.values()]
    return s + [...store, ...grab].reduce((x, c) => x + c.amount, 0)
  }, 0)

  return (
    <div>
      <h1>POS Sales</h1>
      <div className="card row">
        <div><label>วันที่</label><input type="date" value={day} onChange={e => setDay(e.target.value)} /></div>
        <div><label>สาขา</label>
          <select value={branch} onChange={e => setBranch(e.target.value)}>
            <option value="">ทุกสาขา</option>
            {posBranches.map(b => <option key={b.code} value={b.code}>{b.name_en}</option>)}
          </select>
        </div>
        {busy && <span className="muted">กำลังโหลด…</span>}
        {freshness && <span className="muted">{freshness}</span>}
      </div>
      {error && <div className="banner bad">{error}</div>}

      {blocks.map(b => {
        const rows: { label: string; cell?: Cell; kind: 'section' | 'row' | 'total' }[] = []
        rows.push({ label: 'Dine-in & Takeaway', kind: 'section' })
        const storeOrder: [string, string][] = [['bank_transfer', 'เงินโอน'], ['cash', 'เงินสด'], ['thai_chuai_thai', 'ไทยช่วยไทย']]
        for (const [code, label] of storeOrder) {
          rows.push({ label, cell: b.store.get(code) ?? blank(), kind: 'row' })
        }
        for (const [name, cell] of b.storeOther) rows.push({ label: `อื่นๆ — ${name}`, cell, kind: 'row' })
        rows.push({ label: 'Grab (จำนวนเงินจากรายงาน Grab)', kind: 'section' })
        rows.push({ label: 'เงินโอน — โอนเข้าธนาคาร (คำนวณ)', cell: b.grabTransfer, kind: 'row' })
        rows.push({ label: 'ไทยช่วยไทย — เข้าถุงเงิน (TCT)', cell: b.grabTct, kind: 'row' })
        for (const [name, cell] of b.deliveryOther) rows.push({ label: `อื่นๆ (delivery) — ${name}`, cell, kind: 'row' })
        const all = rows.filter(r => r.cell).map(r => r.cell!)
        const total: Cell = { bills: all.reduce((s, c) => s + c.bills, 0), amount: all.reduce((s, c) => s + c.amount, 0) }

        return (
          <div className="card scroll-x" key={b.branchCode}>
            <h2>{nameOf(b.branchCode)}</h2>
            <table className="data" style={{ maxWidth: 520 }}>
              <thead>
                <tr><th style={{ textAlign: 'left' }}>ช่องทาง</th><th>บิล</th><th>จำนวนเงิน</th></tr>
              </thead>
              <tbody>
                {rows.map((r, i) => r.kind === 'section'
                  ? <tr className="section" key={i}><td colSpan={3}>{r.label}</td></tr>
                  : <tr key={i}>
                      <td style={{ textAlign: 'left', paddingLeft: 20 }}>{r.label}</td>
                      <td>{r.cell!.bills || '—'}</td>
                      <td>{r.cell!.amount ? fmt(r.cell!.amount) : '—'}</td>
                    </tr>)}
                <tr className="total">
                  <td style={{ textAlign: 'left' }}>Total</td>
                  <td>{total.bills}</td>
                  <td>{fmt(total.amount)}</td>
                </tr>
                {!b.grabHasReport && (b.grabTransfer.bills > 0 || b.grabTct.bills > 0) && (
                  <tr><td className="muted" colSpan={3} style={{ textAlign: 'left' }}>⚠ มีบิล Grab ใน POS แต่ยังไม่อัปโหลดรายงาน Grab ของวันนี้ — จำนวนเงินจึงยังไม่แสดง</td></tr>
                )}
                {b.internal.bills > 0 && (
                  <tr><td className="muted" style={{ textAlign: 'left' }}>internal (staff meal ฯลฯ) — ไม่นับเป็นยอดขาย</td>
                    <td className="muted">{b.internal.bills}</td><td className="muted">{fmt(b.internal.amount)}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )
      })}

      {blocks.length > 1 && (
        <div className="kpis"><div className="kpi"><div className="v">{fmt(grand)}</div><div className="l">รวมทุกสาขา</div></div></div>
      )}
      {blocks.length === 0 && !busy && !error && (
        <div className="banner warn">ไม่มีข้อมูล POS สำหรับวันที่นี้ (สาขาที่ sync แล้ว: Gaysorn, Sathorn Square)</div>
      )}
    </div>
  )
}
