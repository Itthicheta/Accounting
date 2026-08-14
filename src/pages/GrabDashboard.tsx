import { useEffect, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { sb, fetchAll, bkkToday } from '../lib/supabase'
import { parseGrabWorkbook, type GrabParse, type GrabRow, type GrabPayout, type GrabCategory } from '../lib/grabParser'
import { reconByBranch, isBankSale, type BranchRecon } from '../lib/grabCalc'
import { saveGrabUploads, dbToGrabRow, type UploadItem } from '../lib/grabIngest'
import { buildPosLines, type PosViewRow } from '../lib/peakExport'
import { useBranches } from './Shell'
import ReconTable from './ReconTable'
import MonthCalendar from './MonthCalendar'

/** date -> storeId -> {earned, paid}; owe cell = paid − earned (Grab owes us => negative) */
type OweGrid = Map<string, Map<string, { earned: number; paid: number }>>

type DbRow = Record<string, unknown>


const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Render a stored timestamp in Bangkok time, Gregorian calendar: "12/08/2026 04:44" */
function formatBkk(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso)).reduce<Record<string, string>>((a, p) => (a[p.type] = p.value, a), {})
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`
}

export default function GrabDashboard() {
  const branches = useBranches()
  const [from, setFrom] = useState(bkkToday(7))
  const [to, setTo] = useState(bkkToday(0))
  const [recon, setRecon] = useState<BranchRecon[]>([])
  const [payouts, setPayouts] = useState<DbRow[]>([])
  const [owe, setOwe] = useState<OweGrid>(new Map())
  const [pending, setPending] = useState<UploadItem[]>([])
  const [uploadMsg, setUploadMsg] = useState('')
  const [uploadErr, setUploadErr] = useState('')
  const [savingUpload, setSavingUpload] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const [calRefresh, setCalRefresh] = useState(0)
  const [oweSummary, setOweSummary] = useState<DbRow[]>([])
  const [cancelled, setCancelled] = useState<GrabRow[]>([])
  const [billRecon, setBillRecon] = useState<{ branch: string; pos: number; grab: number; hasPos: boolean }[]>([])
  const [count, setCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const byStoreId = new Map(branches.filter(b => b.grab_store_id).map(b => [b.grab_store_id!, b]))
  const byLocation = new Map(branches.filter(b => b.pos_location_id).map(b => [b.pos_location_id!, b.code]))
  const branchName = (key: string) => byStoreId.get(key)?.name_en ?? key
  const branchNameByCode = (code: string) => branches.find(b => b.code === code)?.name_en ?? code

  async function load(fromArg?: string, toArg?: string) {
    const f0 = fromArg ?? from
    const t0 = toArg ?? to
    setBusy(true); setError('')
    try {
      const [rows, pos] = await Promise.all([
        fetchAll<DbRow>((f, t) => sb.from('grab_rows')
          .select('*').gte('business_date', f0).lte('business_date', t0)
          .order('id').range(f, t)),
        fetchAll<DbRow>((f, t) => sb.from('grab_payouts')
          .select('*')
          .gte('transferred_at', f0 + 'T00:00:00+07:00')
          .lte('transferred_at', t0 + 'T23:59:59+07:00')
          .order('id').range(f, t)),
      ])

      const grabRows = rows.map(dbToGrabRow)
      // payout totals must cover the payouts that PAY these rows (payout ids referenced by rows)
      const payoutIds = new Set(grabRows.map(r => r.payoutId).filter(Boolean))
      // cross-date payout check: a payout batch can include rows from other days,
      // so verify each payout against ALL its rows in the DB, not just this date range
      const [pos2, allPayoutRows] = payoutIds.size
        ? await Promise.all([
            fetchAll<DbRow>((f, t) => sb.from('grab_payouts')
              .select('*').in('payout_id', [...payoutIds]).order('id').range(f, t)),
            fetchAll<DbRow>((f, t) => sb.from('grab_rows')
              .select('payout_id,total,business_date').in('payout_id', [...payoutIds])
              .order('id').range(f, t)),
          ])
        : [[], []]
      const payoutRowSum = new Map<string, number>()
      for (const r of allPayoutRows) {
        const pid = r.payout_id as string
        payoutRowSum.set(pid, (payoutRowSum.get(pid) ?? 0) + Number(r.total ?? 0))
      }
      const payoutAmount = new Map<string, number>()
      for (const p of pos2) payoutAmount.set(p.payout_id as string, Number(p.amount ?? 0))

      const parse: GrabParse = {
        rows: grabRows,
        payouts: pos2.map((p): GrabPayout => ({
          payoutId: (p.payout_id as string) ?? '',
          storeName: '',
          grabStoreId: (p.grab_store_id as string) ?? '',
          amount: Number(p.amount ?? 0),
          transferredAt: (p.transferred_at as string) ?? null,
          bankStmtRef: (p.bank_stmt_ref as string) ?? '',
          bankName: (p.bank_name as string) ?? '',
          bankLast4: (p.bank_last4 as string) ?? '',
        })),
        periodStart: f0, periodEnd: t0, declaredStart: f0, declaredEnd: t0, warnings: [],
      }
      setCount(grabRows.length)
      setCancelled(grabRows.filter(r => r.category === 'ยกเลิก')
        .sort((a, z) => (z.businessDate + z.grabCreatedAt).localeCompare(a.businessDate + a.grabCreatedAt)))
      const recons = grabRows.length ? reconByBranch(parse) : []
      // override payout match: ✓ when every payout of the branch balances across ALL its DB rows
      const pidsByStore = new Map<string, Set<string>>()
      for (const r of grabRows) {
        if (!r.payoutId) continue
        const key = r.grabStoreId || r.storeName
        if (!pidsByStore.has(key)) pidsByStore.set(key, new Set())
        pidsByStore.get(key)!.add(r.payoutId)
      }
      const allPids = new Set([...pidsByStore.values()].flatMap(s => [...s]))
      for (const b of recons) {
        const pids = b.store === '__company__' ? allPids : (pidsByStore.get(b.grabStoreId || b.store) ?? new Set<string>())
        if (pids.size === 0) { b.payoutMatches = null; continue }
        let ok = true
        for (const pid of pids) {
          const amt = payoutAmount.get(pid)
          if (amt == null || Math.abs((payoutRowSum.get(pid) ?? 0) - amt) > 0.01) { ok = false; break }
        }
        b.payoutMatches = ok
      }
      setRecon(recons)
      setPayouts(pos)

      // bill-count reconcile: POS grab-origin bills vs Grab report rows (selected range)
      const posRows = await fetchAll<PosViewRow>((f2, t2) => sb.from('pos_channel_payment')
        .select('*').gte('business_date', f0).lte('business_date', t0)
        .order('location_id').range(f2, t2))
      const posAgg = buildPosLines(posRows, byLocation)
      const grabBillsByBranch = new Map<string, number>()
      for (const r of grabRows) {
        if (r.category !== 'ชำระเงิน') continue
        const code = byStoreId.get(r.grabStoreId)?.code ?? ''
        if (code) grabBillsByBranch.set(code, (grabBillsByBranch.get(code) ?? 0) + 1)
      }
      const posCovered = new Set(posRows.map(r => byLocation.get(r.location_id)).filter(Boolean))
      const codes = [...new Set([...posAgg.grabPosBills.keys(), ...grabBillsByBranch.keys()])].sort()
      setBillRecon(codes.map(c => ({
        branch: c,
        pos: posAgg.grabPosBills.get(c) ?? 0,
        grab: grabBillsByBranch.get(c) ?? 0,
        hasPos: posCovered.has(c),
      })))

      const { data: oweSum, error: oe } = await sb.from('grab_owe_summary').select('*')
      if (oe) throw oe
      setOweSummary((oweSum as DbRow[]) ?? [])

      // ---- Grab-Owe grid: earned (from rows) vs paid (payout sheet), per date × branch ----
      // attribute each payout to the business_date most common among its rows
      const payoutDateVotes = new Map<string, Map<string, number>>()
      for (const r of allPayoutRows) {
        const pid = r.payout_id as string
        const d = (r.business_date as string) ?? ''
        if (!d) continue
        if (!payoutDateVotes.has(pid)) payoutDateVotes.set(pid, new Map())
        const m = payoutDateVotes.get(pid)!
        m.set(d, (m.get(d) ?? 0) + 1)
      }
      const payoutDate = new Map<string, string>()
      for (const [pid, votes] of payoutDateVotes) {
        payoutDate.set(pid, [...votes.entries()].sort((a, z) => z[1] - a[1])[0][0])
      }
      const grid: OweGrid = new Map()
      const cell = (d: string, store: string) => {
        if (!grid.has(d)) grid.set(d, new Map())
        const m = grid.get(d)!
        if (!m.has(store)) m.set(store, { earned: 0, paid: 0 })
        return m.get(store)!
      }
      for (const r of grabRows) {
        if (!r.businessDate) continue
        const store = r.grabStoreId || r.storeName
        const bankAmt = r.category === 'ชำระเงิน' ? (isBankSale(r) ? r.total : 0) : r.total
        if (bankAmt !== 0) cell(r.businessDate, store).earned += bankAmt
      }
      for (const p of pos2) {
        const pid = p.payout_id as string
        const d = payoutDate.get(pid)
        if (!d || d < f0 || d > t0) continue
        cell(d, (p.grab_store_id as string) ?? '').paid += Number(p.amount ?? 0)
      }
      setOwe(grid)
    } catch (err) {
      setError((err as Error).message)
    }
    setBusy(false)
  }

  useEffect(() => { load() }, [])

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])]
    e.target.value = ''
    if (!files.length) return
    setUploadMsg(''); setUploadErr('')
    const items: UploadItem[] = []
    for (const f of files) {
      const wb = XLSX.read(await f.arrayBuffer())
      items.push({ filename: f.name, parse: parseGrabWorkbook(wb) })
    }
    setPending(items)
  }

  const pendingWarnings = pending.flatMap(it => it.parse.warnings.map(w => `${it.filename}: ${w}`))
  const pendingUnknownStores = [...new Set(pending.flatMap(it =>
    it.parse.rows.filter(r => r.grabStoreId && !byStoreId.has(r.grabStoreId)).map(r => r.storeName)))]
  const pendingBlocked = pendingUnknownStores.length > 0 ||
    pendingWarnings.some(w => w.includes('หมวดหมู่ไม่รู้จัก'))

  async function saveUploads() {
    setSavingUpload(true); setUploadErr('')
    try {
      const codeByStore = new Map(branches.filter(b => b.grab_store_id).map(b => [b.grab_store_id!, b.code]))
      const res = await saveGrabUploads(pending, codeByStore)
      setUploadMsg(`บันทึกแล้ว ${pending.length} ไฟล์ (${res.rows} รายการ, ${res.payouts} ยอดโอน)` + (res.duplicatesDropped ? ` — ข้ามรายการซ้ำ ${res.duplicatesDropped}` : '') + ' — ข้อมูลช่วงวันที่เดิมถูกแทนที่แบบ all-or-nothing')
      setPending([])
      setCalRefresh(k => k + 1)
      await load()
    } catch (err) {
      setUploadErr('บันทึกไม่สำเร็จ: ' + (err as Error).message)
    }
    setSavingUpload(false)
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h1 style={{ margin: 0 }}>Grab — Dashboard</h1>
        <div>
          <input ref={fileInput} type="file" accept=".xlsx" multiple style={{ display: 'none' }} onChange={onFiles} />
          <button className="primary" onClick={() => fileInput.current?.click()}>อัปโหลดรายงาน Grab</button>
        </div>
      </div>
      <MonthCalendar refreshKey={calRefresh} onPick={d => { setFrom(d); setTo(d); load(d, d) }} />
      <div className="card row">
        <div><label>ตั้งแต่วันที่ (วันขาย)</label><input type="date" value={from} onChange={e => setFrom(e.target.value)} /></div>
        <div><label>ถึงวันที่</label><input type="date" value={to} onChange={e => setTo(e.target.value)} /></div>
        <button className="primary" onClick={() => load()} disabled={busy}>{busy ? 'กำลังโหลด…' : 'แสดงผล'}</button>
        <span className="muted">{count} รายการ</span>
      </div>
      {error && <div className="banner bad">{error}</div>}

      {pending.length > 0 && (
        <div className="card">
          <h2>ไฟล์ที่เลือก ({pending.length})</h2>
          {pending.map((it, i) => (
            <div key={i} className="muted">
              {it.filename} — {it.parse.periodStart}{it.parse.periodEnd !== it.parse.periodStart ? ` ถึง ${it.parse.periodEnd}` : ''} · {it.parse.rows.length} รายการ · {it.parse.payouts.length} ยอดโอน
            </div>
          ))}
          {pendingWarnings.length > 0 && (
            <div className="banner warn" style={{ marginTop: 10 }}>
              <ul style={{ margin: '0 0 0 18px' }}>{pendingWarnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
          {pendingUnknownStores.length > 0 && (
            <div className="banner bad">ร้านที่ไม่รู้จัก (เพิ่ม grab_store_id ใน acc.branches ก่อน): {pendingUnknownStores.join(', ')}</div>
          )}
          <div style={{ marginTop: 10 }}>
            <button className="primary" onClick={saveUploads} disabled={savingUpload || pendingBlocked}>
              {savingUpload ? 'กำลังบันทึก…' : 'บันทึก (แทนที่ข้อมูลวันเดิม)'}
            </button>
            <button className="ghost" onClick={() => setPending([])} style={{ marginLeft: 8 }}>ยกเลิก</button>
          </div>
        </div>
      )}
      {uploadMsg && <div className="banner ok">{uploadMsg}</div>}
      {uploadErr && <div className="banner bad">{uploadErr}</div>}

      {recon.length > 0 && (
        <div className="card">
          <h2>กระทบยอดต่อสาขา ({from} → {to})</h2>
          <ReconTable recon={recon} branchName={branchName} />
        </div>
      )}
      {recon.length === 0 && !busy && <div className="banner warn">ไม่มีข้อมูลในช่วงวันที่นี้ — อัปโหลดรายงาน Grab ก่อน</div>}

      {billRecon.length > 0 && (
        <div className="card">
          <h2>กระทบยอดจำนวนบิล Grab (POS vs รายงาน Grab)</h2>
          <div className="scroll-x">
            <table className="data">
              <thead><tr><th>สาขา</th><th>บิลใน POS</th><th>บิลในรายงาน Grab</th><th>ผล</th></tr></thead>
              <tbody>
                {billRecon.map((r, i) => (
                  <tr key={i}>
                    <td style={{ textAlign: 'left' }}>{branchNameByCode(r.branch)}</td>
                    <td>{r.pos}</td>
                    <td>{r.grab}</td>
                    <td style={{ textAlign: 'left' }}>
                      {!r.hasPos
                        ? <span className="chip warn">ยังไม่มีข้อมูล POS สาขานี้ (sync ยังไม่ครอบคลุม)</span>
                        : r.pos === r.grab
                          ? <span className="chip ok">✓ ตรงกัน</span>
                          : <span className="chip bad">✗ ต่าง {Math.abs(r.pos - r.grab)} บิล{r.grab === 0 ? ' (ยังไม่อัปโหลดไฟล์ Grab?)' : r.pos > r.grab ? ' — POS เกิน อาจคีย์ซ้ำ' : ' — POS ขาด อาจลืมคีย์'}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(owe.size > 0 || oweSummary.length > 0) && (() => {
        const stores = branches.filter(b => b.grab_store_id &&
          [...owe.values()].some(m => m.has(b.grab_store_id!)))
        const dates = [...owe.keys()].sort()
        const oweOf = (d: string, sid: string) => {
          const c = owe.get(d)?.get(sid)
          return c ? c.paid - c.earned : 0
        }
        const branchTotal = (sid: string) => dates.reduce((s, d) => s + oweOf(d, sid), 0)
        const dateTotal = (d: string) => stores.reduce((s, b) => s + oweOf(d, b.grab_store_id!), 0)
        const grand = stores.reduce((s, b) => s + branchTotal(b.grab_store_id!), 0)
        const Cell = ({ v }: { v: number }) => {
          const clean = Math.abs(v) <= 0.005 ? 0 : v
          return (
            <td style={{ color: clean === 0 ? 'var(--muted)' : clean < 0 ? 'var(--danger)' : 'var(--warn)' }}>
              {clean.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </td>
          )
        }
        return (
          <div className="card">
            <h2>Mismatch</h2>
            <p className="muted">ติดลบ = Grab ค้างจ่ายเรา · บวก = เราค้าง Grab (จ่ายเกิน)</p>
            <div className="muted" style={{ fontWeight: 600, marginBottom: 4 }}>ยอดค้างสะสมทั้งหมด (ทุกวัน ไม่ขึ้นกับช่วงวันที่)</div>
            <div className="kpis">
              {oweSummary.map((r, i) => {
                const v = Number(r.owe ?? 0)
                return (
                  <div className="kpi" key={i}>
                    <div className="v" style={{ color: v < -0.01 ? 'var(--danger)' : v > 0.01 ? 'var(--warn)' : 'inherit' }}>{fmt(Math.abs(v) <= 0.005 ? 0 : v)}</div>
                    <div className="l">{branchName((r.grab_store_id as string) ?? '')}</div>
                  </div>
                )
              })}
              <div className="kpi">
                <div className="v" style={{ color: oweSummary.reduce((s2, r) => s2 + Number(r.owe ?? 0), 0) < -0.01 ? 'var(--danger)' : 'inherit' }}>
                  {fmt(oweSummary.reduce((s2, r) => s2 + Number(r.owe ?? 0), 0))}
                </div>
                <div className="l">รวมทุกสาขา</div>
              </div>
            </div>
            {dates.length > 0 && <div className="muted" style={{ fontWeight: 600, margin: '10px 0 4px' }}>รายวัน (ตามช่วงวันที่ที่เลือก)</div>}
            {dates.length > 0 && <div className="scroll-x">
              <table className="data">
                <thead>
                  <tr><th>วันที่ (วันขาย)</th>{stores.map(b => <th key={b.code}>{b.name_en}</th>)}<th>รวม</th></tr>
                </thead>
                <tbody>
                  {dates.map(d => (
                    <tr key={d}>
                      <td style={{ textAlign: 'left' }}>{d}</td>
                      {stores.map(b => <Cell key={b.code} v={oweOf(d, b.grab_store_id!)} />)}
                      <Cell v={dateTotal(d)} />
                    </tr>
                  ))}
                  <tr className="total">
                    <td style={{ textAlign: 'left' }}>รวม</td>
                    {stores.map(b => <Cell key={b.code} v={branchTotal(b.grab_store_id!)} />)}
                    <Cell v={grand} />
                  </tr>
                </tbody>
              </table>
            </div>}
          </div>
        )
      })()}

      {cancelled.length > 0 && (
        <div className="card">
          <h2>ออเดอร์ที่ถูกยกเลิก ({cancelled.length})</h2>
          <p className="muted">ตามช่วงวันที่ที่เลือก — ไม่มีผลต่อยอดเงิน เก็บไว้ดูสาเหตุและความถี่</p>
          <div className="scroll-x">
            <table className="data">
              <thead><tr><th>วันที่</th><th>สาขา</th><th>ออเดอร์</th><th>ยกเลิกโดย</th><th>สาเหตุ</th></tr></thead>
              <tbody>
                {cancelled.map((c, i) => (
                  <tr key={i}>
                    <td style={{ textAlign: 'left' }}>{c.businessDate}</td>
                    <td style={{ textAlign: 'left' }}>{branchName(c.grabStoreId || c.storeName)}</td>
                    <td style={{ textAlign: 'left' }}>{c.orderCode}</td>
                    <td style={{ textAlign: 'left' }}>{c.cancelledBy || '—'}</td>
                    <td style={{ textAlign: 'left' }}>{c.cancelReason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {payouts.length > 0 && (
        <div className="card">
          <h2>ยอดโอนเข้าธนาคาร (ตามวันที่โอน)</h2>
          <div className="scroll-x">
            <table className="data">
              <thead><tr><th>สาขา</th><th>Payout ID</th><th>ยอดโอน</th><th>วันที่โอน</th><th>บัญชี (4 ตัวท้าย)</th></tr></thead>
              <tbody>
                {payouts.map((p, i) => (
                  <tr key={i}>
                    <td>{branchName((p.grab_store_id as string) ?? '')}</td>
                    <td style={{ textAlign: 'left' }}>{p.payout_id as string}</td>
                    <td>{fmt(Number(p.amount ?? 0))}</td>
                    <td>{p.transferred_at ? formatBkk(p.transferred_at as string) : ''}</td>
                    <td>{p.bank_last4 as string}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
