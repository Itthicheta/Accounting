import { useEffect, useState } from 'react'
import { sb } from '../lib/supabase'
import type { GrabParse, GrabRow, GrabPayout, GrabCategory } from '../lib/grabParser'
import { reconByBranch, type BranchRecon } from '../lib/grabCalc'
import { useBranches } from './Shell'
import ReconTable from './ReconTable'

type DbRow = Record<string, unknown>

function dbToGrabRow(r: DbRow): GrabRow {
  return {
    storeName: (r.store_name as string) ?? '',
    grabStoreId: (r.grab_store_id as string) ?? '',
    category: r.category as GrabCategory,
    subitem: (r.subitem as string) ?? '',
    status: (r.status as string) ?? '',
    txnId: (r.txn_id as string) ?? '',
    relatedTxnId: (r.related_txn_id as string) ?? '',
    orderCode: (r.order_code as string) ?? '',
    longOrderId: (r.long_order_id as string) ?? '',
    orderType: (r.order_type as string) ?? '',
    paymentMethod: (r.payment_method as string) ?? '',
    payoutId: (r.payout_id as string) ?? '',
    grabCreatedAt: (r.grab_created_at as string) ?? null,
    transferredAt: (r.transferred_at as string) ?? null,
    businessDate: (r.business_date as string) ?? '',
    amount: Number(r.amount ?? 0),
    shopDiscount: Number(r.shop_discount ?? 0),
    deliveryDiscount: Number(r.delivery_discount ?? 0),
    netSales: Number(r.net_sales ?? 0),
    mdr: Number(r.mdr ?? 0),
    mdrVat: Number(r.mdr_vat ?? 0),
    grabFee: Number(r.grab_fee ?? 0),
    marketingFee: Number(r.marketing_fee ?? 0),
    commDelivery: Number(r.comm_delivery ?? 0),
    commPlatform: Number(r.comm_platform ?? 0),
    commOrder: Number(r.comm_order ?? 0),
    commOther: Number(r.comm_other ?? 0),
    wht: Number(r.wht ?? 0),
    total: Number(r.total ?? 0),
    commVat: Number(r.comm_vat ?? 0),
    description: (r.description as string) ?? '',
    cancelReason: (r.cancel_reason as string) ?? '',
    cancelledBy: (r.cancelled_by as string) ?? '',
    refundReason: (r.refund_reason as string) ?? '',
  }
}

const daysAgo = (n: number) => {
  const d = new Date(Date.now() - n * 86400_000)
  return d.toISOString().slice(0, 10)
}
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
  const [from, setFrom] = useState(daysAgo(7))
  const [to, setTo] = useState(daysAgo(0))
  const [recon, setRecon] = useState<BranchRecon[]>([])
  const [payouts, setPayouts] = useState<DbRow[]>([])
  const [count, setCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const byStoreId = new Map(branches.filter(b => b.grab_store_id).map(b => [b.grab_store_id!, b]))
  const branchName = (key: string) => byStoreId.get(key)?.name_en ?? key

  async function load() {
    setBusy(true); setError('')
    try {
      const { data: rows, error: re } = await sb.from('grab_rows')
        .select('*').gte('business_date', from).lte('business_date', to).limit(20000)
      if (re) throw re
      const { data: pos, error: pe } = await sb.from('grab_payouts')
        .select('*').gte('transferred_at', from + 'T00:00:00Z').lte('transferred_at', to + 'T23:59:59Z')
      if (pe) throw pe

      const grabRows = ((rows as DbRow[]) ?? []).map(dbToGrabRow)
      // payout totals must cover the payouts that PAY these rows (payout ids referenced by rows)
      const payoutIds = new Set(grabRows.map(r => r.payoutId).filter(Boolean))
      const { data: pos2, error: p2e } = payoutIds.size
        ? await sb.from('grab_payouts').select('*').in('payout_id', [...payoutIds])
        : { data: [], error: null }
      if (p2e) throw p2e
      // cross-date payout check: a payout batch can include rows from other days,
      // so verify each payout against ALL its rows in the DB, not just this date range
      const { data: allPayoutRows, error: are } = payoutIds.size
        ? await sb.from('grab_rows').select('payout_id,total').in('payout_id', [...payoutIds])
        : { data: [], error: null }
      if (are) throw are
      const payoutRowSum = new Map<string, number>()
      for (const r of (allPayoutRows as DbRow[]) ?? []) {
        const pid = r.payout_id as string
        payoutRowSum.set(pid, (payoutRowSum.get(pid) ?? 0) + Number(r.total ?? 0))
      }
      const payoutAmount = new Map<string, number>()
      for (const p of (pos2 as DbRow[]) ?? []) payoutAmount.set(p.payout_id as string, Number(p.amount ?? 0))

      const parse: GrabParse = {
        rows: grabRows,
        payouts: ((pos2 as DbRow[]) ?? []).map((p): GrabPayout => ({
          payoutId: (p.payout_id as string) ?? '',
          storeName: '',
          grabStoreId: (p.grab_store_id as string) ?? '',
          amount: Number(p.amount ?? 0),
          transferredAt: (p.transferred_at as string) ?? null,
          bankStmtRef: (p.bank_stmt_ref as string) ?? '',
          bankName: (p.bank_name as string) ?? '',
          bankLast4: (p.bank_last4 as string) ?? '',
        })),
        periodStart: from, periodEnd: to, warnings: [],
      }
      setCount(grabRows.length)
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
      setPayouts((pos as DbRow[]) ?? [])
    } catch (err) {
      setError((err as Error).message)
    }
    setBusy(false)
  }

  useEffect(() => { load() }, [])

  return (
    <div>
      <h1>Grab — Dashboard</h1>
      <div className="card row">
        <div><label>ตั้งแต่วันที่ (วันขาย)</label><input type="date" value={from} onChange={e => setFrom(e.target.value)} /></div>
        <div><label>ถึงวันที่</label><input type="date" value={to} onChange={e => setTo(e.target.value)} /></div>
        <button className="primary" onClick={load} disabled={busy}>{busy ? 'กำลังโหลด…' : 'แสดงผล'}</button>
        <span className="muted">{count} รายการ</span>
      </div>
      {error && <div className="banner bad">{error}</div>}

      {recon.length > 0 && (
        <div className="card">
          <h2>กระทบยอดต่อสาขา ({from} → {to})</h2>
          <ReconTable recon={recon} branchName={branchName} />
        </div>
      )}
      {recon.length === 0 && !busy && <div className="banner warn">ไม่มีข้อมูลในช่วงวันที่นี้ — อัปโหลดรายงาน Grab ก่อน</div>}

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
