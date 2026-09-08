import { useEffect, useState } from 'react'
import * as XLSX from 'xlsx'
import { sb, fetchAll, bkkToday } from '../lib/supabase'
import { reconByBranch, COMPANY } from '../lib/grabCalc'
import { dbToGrabRow } from '../lib/grabIngest'
import {
  buildPeakReceiptLines, buildPosLines, buildGrabReceiptLines, buildGrabExpenseLines,
  mergeReceiptLines, peakReceiptWorkbook, peakExpenseWorkbook,
  DEFAULT_PEAK_CONFIG, DEFAULT_GRAB_PEAK_CONFIG,
  type PeakConfig, type GrabPeakConfig, type CateringLine, type PeakReceiptLine,
  type PeakExpenseLine, type PosViewRow,
} from '../lib/peakExport'
import { useBranches } from './Shell'

type DbRow = Record<string, unknown>
const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** ISO date ± days (dates only, no TZ pitfalls at noon UTC) */
function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
const thDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

type WalletRow = {
  branch: string
  ewallet: string
  revenue: number      // เข้า wallet (ยอดขาย gross)
  costs: number        // ออกจาก wallet (ไฟล์ต้นทุน)
  toBank: number       // โอนเข้าธนาคาร (คำนวณ) — settle ออกด้วยมือ
  toTct: number        // เข้าถุงเงิน (TCT) — settle ออกด้วยมือ
  leftover: number     // revenue - costs - toBank - toTct (ควรเป็น 0)
}

export default function PeakExport() {
  const branches = useBranches()
  // Point's workflow (2026-08-28): pick the SETTLEMENT date S. In-store money
  // (โอน/QR same day, cash + TCT by T+1..3) is reconciled for S-1; Grab is
  // reconciled for S-3 — by then the payout has landed (bank T+1, report T+2)
  // and TCT has arrived (latest T+3), so everything in the sitting is matchable.
  const [settleDay, setSettleDay] = useState(bkkToday())
  // sale dates default from the settlement date but stay individually editable
  const [instoreDay, setInstoreDay] = useState(shiftDate(bkkToday(), -1))
  const [grabDay, setGrabDay] = useState(shiftDate(bkkToday(), -3))
  const pickSettle = (d: string) => {
    setSettleDay(d)
    setInstoreDay(shiftDate(d, -1))
    setGrabDay(shiftDate(d, -3))
  }
  const [posLines, setPosLines] = useState<PeakReceiptLine[]>([])
  const [grabRevLines, setGrabRevLines] = useState<PeakReceiptLine[]>([])
  const [grabExpLines, setGrabExpLines] = useState<PeakExpenseLine[]>([])
  const [wallet, setWallet] = useState<WalletRow[]>([])
  const [posMissing, setPosMissing] = useState<string[]>([])
  const [grabFileReady, setGrabFileReady] = useState<boolean | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [info, setInfo] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [config, setConfig] = useState<PeakConfig>(DEFAULT_PEAK_CONFIG)

  const byStoreId = new Map(branches.filter(b => b.grab_store_id).map(b => [b.grab_store_id!, b]))
  const byLocation = new Map(branches.filter(b => b.pos_location_id).map(b => [b.pos_location_id!, b.code]))
  // display-only branch name per line (via its unique class group) — NOT exported to excel
  const branchByClass = new Map(branches.filter(b => b.peak_class).map(b => [b.peak_class!, b.name_en]))
  const branchOf = (classGroup: string) => branchByClass.get(classGroup) ?? '—'

  async function load() {
    setBusy(true); setError('')
    try {
      const { data: st } = await sb.from('app_settings').select('*')
      const smap: Record<string, string> = {}
      for (const r of (st as { key: string; value: string }[]) ?? []) smap[r.key] = r.value
      const cfg: PeakConfig = {
        revenueAccount: smap.peak_revenue_account ?? DEFAULT_PEAK_CONFIG.revenueAccount,
        vatRate: Number(smap.peak_vat_rate ?? DEFAULT_PEAK_CONFIG.vatRate),
        priceType: Number(smap.peak_price_type ?? DEFAULT_PEAK_CONFIG.priceType),
        taxInvoice: Number(smap.peak_tax_invoice ?? DEFAULT_PEAK_CONFIG.taxInvoice),
        qty: Number(smap.peak_qty ?? DEFAULT_PEAK_CONFIG.qty),
      }
      const D = DEFAULT_GRAB_PEAK_CONFIG
      const gcfg: GrabPeakConfig = {
        discountAccount: smap.grab_discount_account || D.discountAccount,
        deliveryDiscountAccount: smap.grab_delivery_discount_account || D.deliveryDiscountAccount,
        marketingAccount: smap.grab_marketing_account || D.marketingAccount,
        commissionAccount: smap.grab_commission_account || D.commissionAccount,
        mdrAccount: smap.grab_mdr_account || D.mdrAccount,
        adsAccount: smap.grab_ads_account || D.adsAccount,
        compensationAccount: smap.grab_compensation_account || D.compensationAccount,
        adjAccount: smap.grab_adj_account ?? '',
      }
      setConfig(cfg)

      // ---- in-store side (S-1): POS + Catering ----
      const posRows = await fetchAll<PosViewRow>((f, t) => sb.from('pos_channel_payment')
        .select('*').eq('business_date', instoreDay).order('location_id').range(f, t))
      const pos = buildPosLines(posRows, byLocation)
      const seen = new Set(posRows.map(r => r.location_id))
      setPosMissing(branches
        .filter(b => b.is_active && b.pos_location_id && !seen.has(b.pos_location_id))
        .map(b => b.name_en))

      const { data: events, error: ee } = await sb.from('catering_events')
        .select('branch_code,name,net_receiving').eq('event_date', instoreDay)
        .in('status', ['reconcile_ready', 'performance_complete'])
      if (ee) throw ee
      const catering: CateringLine[] = ((events as DbRow[]) ?? []).map(e => ({
        branchCode: (e.branch_code as string) ?? null,
        name: (e.name as string) ?? '',
        netReceiving: Number(e.net_receiving ?? 0),
      }))

      // ---- Grab side (S-3): per-order revenue + costs, report must be uploaded ----
      const { data: gf } = await sb.from('grab_files').select('id')
        .lte('period_start', grabDay).gte('period_end', grabDay).limit(1)
      setGrabFileReady((gf ?? []).length > 0)
      const rows = await fetchAll<DbRow>((f, t) => sb.from('grab_rows')
        .select('*').eq('business_date', grabDay).order('id').range(f, t))
      const active = rows.map(dbToGrabRow).filter(r => r.category !== 'ยกเลิก')

      const f1 = buildPeakReceiptLines(instoreDay, branches, [], catering, pos.posLines, cfg)
      const f2 = buildGrabReceiptLines(grabDay, branches, active, cfg)
      const f3 = buildGrabExpenseLines(grabDay, branches, active, gcfg)

      // E-Wallet check: gross in − costs out − (settlement legs staff will key) ≈ 0
      const recon = active.length
        ? reconByBranch({ rows: active, payouts: [], periodStart: grabDay, periodEnd: grabDay, declaredStart: grabDay, declaredEnd: grabDay, warnings: [] })
        : []
      const wrows: WalletRow[] = []
      for (const rb of recon) {
        if (rb.store === COMPANY) continue
        const b = byStoreId.get(rb.grabStoreId)
        if (!b?.ewallet) continue
        const revenue = f2.lines.filter(l => l.paidBy === b.ewallet).reduce((s, l) => s + l.amount, 0)
        const costs = f3.lines.filter(l => l.paidBy === b.ewallet).reduce((s, l) => s + l.amount, 0)
        wrows.push({
          branch: b.name_en, ewallet: b.ewallet,
          revenue, costs,
          toBank: rb.bankPayoutCalc, toTct: rb.walletReceive,
          leftover: revenue - costs - rb.bankPayoutCalc - rb.walletReceive,
        })
      }

      // ONE receipt file per sitting: POS/Catering lines (dated S-1) then Grab
      // lines (dated S-3), continuous ลำดับที่
      const merged = mergeReceiptLines(f1.lines, f2.lines)
      setPosLines(merged.slice(0, f1.lines.length))
      setGrabRevLines(merged.slice(f1.lines.length))
      setGrabExpLines(f3.lines)
      setWallet(wrows)
      const sizeWarn = [merged, f3.lines].some(l => l.length > 1000)
        ? ['ไฟล์เกิน 1,000 บรรทัด — Peak รับสูงสุด 1,000 บรรทัดต่อไฟล์ ต้องแบ่งไฟล์ (แจ้ง Point)'] : []
      setWarnings([...pos.warnings, ...f1.warnings, ...f2.warnings, ...f3.warnings, ...sizeWarn])
      setInfo(f3.info)
    } catch (err) {
      setError((err as Error).message)
    }
    setBusy(false)
  }

  useEffect(() => { if (branches.length) load() }, [branches.length, instoreDay, grabDay])

  const dl = (kind: 'receipt' | 'expense') => {
    if (kind === 'expense') {
      XLSX.writeFile(peakExpenseWorkbook(grabExpLines, config), `PEAK_ImportExpense_Grab_${grabDay}.xlsx`)
    } else {
      XLSX.writeFile(peakReceiptWorkbook([...posLines, ...grabRevLines], config), `PEAK_ImportReceipt_${instoreDay}_grab_${grabDay}.xlsx`)
    }
  }

  const sum = (ls: { amount: number }[]) => ls.reduce((s, l) => s + l.amount, 0)
  const grabDocCount = new Set(grabExpLines.map(l => l.seq)).size
  const posReady = posMissing.length === 0

  return (
    <div>
      <h1>Peak — Export รายวัน (2 ไฟล์)</h1>
      <p className="muted">
        เลือก<b>วันที่ settlement</b> — ระบบจะรวมยอดขายหน้าร้าน+Catering ของ<b>เมื่อวาน (S−1)</b> และ
        ยอดขาย Grab ของ <b>3 วันก่อน (S−3)</b> (รวมเป็น 2 บรรทัดต่อ E-Wallet: Grab ปกติ + ไทยช่วยไทย)
        ไว้ในไฟล์รายรับไฟล์เดียว (แต่ละบรรทัดลงวันที่ขายจริง)
        เพราะเงิน Grab โอน T+1 รายงานมา T+2 และไทยช่วยไทยเข้าช้าสุด T+3 — ทุกยอดในรอบนี้จึงมีเงินเข้าให้จับคู่แล้ว
      </p>
      <div className="card row">
        <div><label>วันที่ Settlement</label><input type="date" value={settleDay} onChange={e => pickSettle(e.target.value)} /></div>
        <div><label>หน้าร้าน+Catering (S−1, แก้ได้)</label><input type="date" value={instoreDay} onChange={e => setInstoreDay(e.target.value)} /></div>
        <div><label>Grab (S−3, แก้ได้)</label><input type="date" value={grabDay} onChange={e => setGrabDay(e.target.value)} /></div>
        {busy && <span className="muted">กำลังโหลด…</span>}
      </div>
      {(instoreDay !== shiftDate(settleDay, -1) || grabDay !== shiftDate(settleDay, -3)) && (
        <div className="banner warn">ใช้วันที่ขายที่กำหนดเอง (ต่างจากค่าปกติของ settlement {thDate(settleDay)}) — เปลี่ยนวันที่ Settlement เพื่อกลับเป็นค่าปกติ</div>
      )}

      {!busy && (
        <div className="card">
          <h2>เช็คความพร้อมก่อนดาวน์โหลด</h2>
          <p style={{ margin: '4px 0' }}>
            {posReady
              ? <span className="chip ok">✓ POS {thDate(instoreDay)} ครบทุกสาขา ({branches.filter(b => b.is_active && b.pos_location_id).length} สาขา)</span>
              : <span className="chip warn">⚠ POS {thDate(instoreDay)} ยังไม่มีข้อมูล: {posMissing.join(', ')} — รอ sync (ทุก 30 นาที) หรือสาขาปิด</span>}
          </p>
          <p style={{ margin: '4px 0' }}>
            {grabFileReady
              ? <span className="chip ok">✓ รายงาน Grab ครอบคลุมวันที่ {thDate(grabDay)} อัปโหลดแล้ว</span>
              : <span className="chip warn">⚠ ยังไม่ได้อัปโหลดรายงาน Grab ของวันที่ {thDate(grabDay)} — อัปโหลดที่หน้า Grab Dashboard ก่อน</span>}
          </p>
        </div>
      )}
      {error && <div className="banner bad">{error}</div>}
      {warnings.map((w, i) => <div key={i} className="banner warn">{w}</div>)}
      {info.map((w, i) => <div key={i} className="banner" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>ℹ️ {w}</div>)}

      <div className="card row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <button className="primary" onClick={() => dl('receipt')} disabled={busy || (posLines.length === 0 && grabRevLines.length === 0)}>
          1) ไฟล์รายรับ — หน้าร้าน {thDate(instoreDay)} ({posLines.length} บรรทัด) + Grab {thDate(grabDay)} ({grabRevLines.length} บรรทัด) · {fmt(sum(posLines) + sum(grabRevLines))}
        </button>
        <button className="primary" onClick={() => dl('expense')} disabled={busy || grabExpLines.length === 0}>
          2) ไฟล์ต้นทุน Grab {thDate(grabDay)} ({grabDocCount} เอกสาร · {fmt(sum(grabExpLines))})
        </button>
      </div>

      {wallet.length > 0 && (
        <div className="card scroll-x">
          <h2>เช็ค E-Wallet (Grab {thDate(grabDay)}) — หลังคีย์โอนออกครบ ยอดคงเหลือควรเป็น 0</h2>
          <table className="data center">
            <thead>
              <tr><th>สาขา</th><th>E-Wallet</th>
                <th>เข้า (ยอดขาย Grab)</th><th>ออก (ต้นทุน)</th>
                <th>โอนออก→ธนาคาร (คำนวณ)</th><th>โอนออก→ถุงเงิน (TCT)</th><th>คงเหลือ</th></tr>
            </thead>
            <tbody>
              {wallet.map(w => (
                <tr key={w.ewallet}>
                  <td>{w.branch}</td>
                  <td>{w.ewallet}</td>
                  <td>{fmt(w.revenue)}</td>
                  <td>{fmt(w.costs)}</td>
                  <td style={{ color: w.toBank < 0 ? 'var(--danger)' : 'inherit' }}>{fmt(w.toBank)}</td>
                  <td>{fmt(w.toTct)}</td>
                  <td>{Math.abs(w.leftover) <= 0.02
                    ? <span className="chip ok">0.00 ✓</span>
                    : <span className="chip warn">{fmt(w.leftover)}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ marginTop: 8 }}>
            โอนเข้าธนาคาร (คำนวณ) ติดลบ = วันนั้นต้นทุนสูงกว่ายอด Grab ปกติ (ตัดจากถุงเงินไม่ได้) —
            พนักงานไม่ต้องคีย์ขาธนาคารวันนั้น ยอดติดลบจะค้างใน E-Wallet แล้วไปหักออกจากยอดโอนของวันถัดไปเอง ·
            คงเหลือไม่เป็นศูนย์ส่วนใหญ่มาจากรายการปรับรายได้ที่ยังไม่ได้บันทึก (ดู warning)
          </p>
        </div>
      )}

      {posLines.length > 0 && (
        <div className="card scroll-x">
          <h2>ไฟล์รายรับ · ส่วนหน้าร้าน + Catering — วันที่ขาย {thDate(instoreDay)} ({posLines.length} บรรทัด)</h2>
          <table className="data center">
            <thead>
              <tr><th>ลำดับ</th><th>สาขา</th><th>ลูกค้า</th><th>คำอธิบาย</th><th>จำนวนเงิน (รวม VAT)</th><th>รับชำระโดย</th><th>หมายเหตุ</th><th>กลุ่ม</th></tr>
            </thead>
            <tbody>
              {posLines.map(l => (
                <tr key={l.seq}>
                  <td>{l.seq}</td>
                  <td>{branchOf(l.classGroup)}</td>
                  <td>{l.customer}</td>
                  <td>{l.description}</td>
                  <td style={{ color: l.amount < 0 ? 'var(--danger)' : 'inherit' }}>{fmt(l.amount)}</td>
                  <td>{l.paidBy}</td>
                  <td>{l.note}</td>
                  <td>{l.classGroup}</td>
                </tr>
              ))}
              <tr className="total"><td colSpan={4}>รวม</td><td>{fmt(sum(posLines))}</td><td colSpan={3}></td></tr>
            </tbody>
          </table>
        </div>
      )}

      {grabRevLines.length > 0 && (
        <div className="card scroll-x">
          <details>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
              ไฟล์รายรับ · ส่วน Grab (รวมยอดต่อ E-Wallet) — วันที่ขาย {thDate(grabDay)} ({grabRevLines.length} บรรทัด · รวม {fmt(sum(grabRevLines))}) — คลิกเพื่อดูรายบรรทัด
            </summary>
            <table className="data center" style={{ marginTop: 10 }}>
              <thead>
                <tr><th>ลำดับ</th><th>สาขา</th><th>อ้างอิง</th><th>ลูกค้า</th><th>คำอธิบาย</th><th>จำนวนเงิน</th><th>รับชำระโดย</th><th>กลุ่ม</th></tr>
              </thead>
              <tbody>
                {grabRevLines.map(l => (
                  <tr key={l.seq}>
                    <td>{l.seq}</td>
                    <td>{branchOf(l.classGroup)}</td>
                    <td>{l.ref}</td>
                    <td>{l.customer}</td>
                    <td>{l.description}</td>
                    <td>{fmt(l.amount)}</td>
                    <td>{l.paidBy}</td>
                    <td>{l.classGroup}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      )}

      {grabExpLines.length > 0 && (
        <div className="card scroll-x">
          <details>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
              ไฟล์ต้นทุน Grab — วันที่ขาย {thDate(grabDay)} ({grabDocCount} เอกสาร · {grabExpLines.length} บรรทัด · รวม {fmt(sum(grabExpLines))}) — คลิกเพื่อดูรายบรรทัด
            </summary>
            <table className="data center" style={{ marginTop: 10 }}>
              <thead>
                <tr><th>เอกสาร</th><th>สาขา</th><th>อ้างอิง</th><th>คู่ค้า</th><th>บัญชี</th><th>คำอธิบาย</th><th>จำนวนเงิน</th><th>ชำระโดย</th><th>ยอดเอกสาร</th><th>กลุ่ม</th></tr>
              </thead>
              <tbody>
                {grabExpLines.map((l, i) => (
                  <tr key={i}>
                    <td>{l.seq}</td>
                    <td>{branchOf(l.classGroup)}</td>
                    <td>{l.ref}</td>
                    <td>{l.contact}</td>
                    <td>{l.account}</td>
                    <td>{l.description}</td>
                    <td style={{ color: l.amount < 0 ? 'var(--danger)' : 'inherit' }}>{fmt(l.amount)}</td>
                    <td>{l.paidBy}</td>
                    <td>{fmt(l.docTotal)}</td>
                    <td>{l.classGroup}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      )}

      {posLines.length === 0 && grabRevLines.length === 0 && !busy && !error && (
        <div className="banner warn">ไม่มีข้อมูลรายรับสำหรับรอบนี้ — เช็คว่า POS sync แล้ว / อัปโหลดรายงาน Grab แล้ว</div>
      )}
    </div>
  )
}
