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
  const [day, setDay] = useState(bkkToday(1))
  const [posLines, setPosLines] = useState<PeakReceiptLine[]>([])
  const [grabRevLines, setGrabRevLines] = useState<PeakReceiptLine[]>([])
  const [grabExpLines, setGrabExpLines] = useState<PeakExpenseLine[]>([])
  const [wallet, setWallet] = useState<WalletRow[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [info, setInfo] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [config, setConfig] = useState<PeakConfig>(DEFAULT_PEAK_CONFIG)

  const byStoreId = new Map(branches.filter(b => b.grab_store_id).map(b => [b.grab_store_id!, b]))
  const byLocation = new Map(branches.filter(b => b.pos_location_id).map(b => [b.pos_location_id!, b.code]))

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
      const gcfg: GrabPeakConfig = {
        discountAccount: smap.grab_discount_account || DEFAULT_GRAB_PEAK_CONFIG.discountAccount,
        costAccount: smap.grab_cost_account || DEFAULT_GRAB_PEAK_CONFIG.costAccount,
        adjAccount: smap.grab_adj_account ?? '',
      }
      setConfig(cfg)

      const rows = await fetchAll<DbRow>((f, t) => sb.from('grab_rows')
        .select('*').eq('business_date', day).order('id').range(f, t))
      const grabRows = rows.map(dbToGrabRow)

      // POS channels from mp_metrics view (dine_in + take_away per method)
      const posRows = await fetchAll<PosViewRow>((f, t) => sb.from('pos_channel_payment')
        .select('*').eq('business_date', day).order('location_id').range(f, t))
      const pos = buildPosLines(posRows, byLocation)

      const { data: events, error: ee } = await sb.from('catering_events')
        .select('branch_code,name,net_receiving').eq('event_date', day)
        .in('status', ['reconcile_ready', 'performance_complete'])
      if (ee) throw ee
      const catering: CateringLine[] = ((events as DbRow[]) ?? []).map(e => ({
        branchCode: (e.branch_code as string) ?? null,
        name: (e.name as string) ?? '',
        netReceiving: Number(e.net_receiving ?? 0),
      }))

      // file 1: POS + Catering (no Grab lines — Grab has its own two files now)
      const f1 = buildPeakReceiptLines(day, branches, [], catering, pos.posLines, cfg)
      // files 2 + 3: Grab order-level revenue into E-Wallet + costs out of E-Wallet
      const active = grabRows.filter(r => r.category !== 'ยกเลิก')
      const f2 = buildGrabReceiptLines(day, branches, active, cfg)
      const f3 = buildGrabExpenseLines(day, branches, active, gcfg)

      // E-Wallet check: gross in − costs out − (settlement legs staff will key) ≈ 0
      const recon = active.length
        ? reconByBranch({ rows: active, payouts: [], periodStart: day, periodEnd: day, declaredStart: day, declaredEnd: day, warnings: [] })
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

      // ONE receipt file daily (Point 2026-08-26): POS + Catering + Grab rows share
      // the same Import_Receipt template — merge with continuous ลำดับที่
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

  useEffect(() => { if (branches.length) load() }, [branches.length, day])

  const dl = (kind: 'receipt' | 'expense') => {
    if (kind === 'expense') {
      XLSX.writeFile(peakExpenseWorkbook(grabExpLines, config), `PEAK_ImportExpense_Grab_${day}.xlsx`)
    } else {
      XLSX.writeFile(peakReceiptWorkbook([...posLines, ...grabRevLines], config), `PEAK_ImportReceipt_${day}.xlsx`)
    }
  }

  const sum = (ls: { amount: number }[]) => ls.reduce((s, l) => s + l.amount, 0)
  const grabDocCount = new Set(grabExpLines.map(l => l.seq)).size

  return (
    <div>
      <h1>Peak — Export รายวัน (2 ไฟล์)</h1>
      <p className="muted">
        ไฟล์รายรับ (Import_Receipt ไฟล์เดียว): ยอดขายหน้าร้าน POS + Catering เข้าบัญชีธนาคาร/ถุงเงิน
        และรายรับ Grab รายออเดอร์เข้า E-Wallet ของสาขา ·
        ไฟล์ต้นทุน (Import_Expenses): ต้นทุน Grab รายออเดอร์จ่ายออกจาก E-Wallet —
        จากนั้นพนักงานคีย์โอนเงินออกจาก E-Wallet → ธนาคาร/ถุงเงินใน Peak เองตอนเงินเข้า
      </p>
      <div className="card row">
        <div><label>วันที่ (วันขาย)</label><input type="date" value={day} onChange={e => setDay(e.target.value)} /></div>
        {busy && <span className="muted">กำลังโหลด…</span>}
      </div>
      {error && <div className="banner bad">{error}</div>}
      {warnings.map((w, i) => <div key={i} className="banner warn">{w}</div>)}
      {info.map((w, i) => <div key={i} className="banner" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>ℹ️ {w}</div>)}

      <div className="card row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <button className="primary" onClick={() => dl('receipt')} disabled={busy || (posLines.length === 0 && grabRevLines.length === 0)}>
          1) ไฟล์รายรับ — POS+Catering {posLines.length} บรรทัด + Grab {grabRevLines.length} ออเดอร์ · {fmt(sum(posLines) + sum(grabRevLines))}
        </button>
        <button className="primary" onClick={() => dl('expense')} disabled={busy || grabExpLines.length === 0}>
          2) ไฟล์ต้นทุน Grab ← E-Wallet ({grabDocCount} เอกสาร · {fmt(sum(grabExpLines))})
        </button>
      </div>

      {wallet.length > 0 && (
        <div className="card scroll-x">
          <h2>เช็ค E-Wallet ({day}) — หลังคีย์โอนออกครบ ยอดคงเหลือควรเป็น 0</h2>
          <table className="data">
            <thead>
              <tr><th style={{ textAlign: 'left' }}>สาขา</th><th>E-Wallet</th>
                <th>เข้า (ยอดขาย Grab)</th><th>ออก (ต้นทุน)</th>
                <th>โอนออก→ธนาคาร (คำนวณ)</th><th>โอนออก→ถุงเงิน (TCT)</th><th>คงเหลือ</th></tr>
            </thead>
            <tbody>
              {wallet.map(w => (
                <tr key={w.ewallet}>
                  <td style={{ textAlign: 'left' }}>{w.branch}</td>
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
            E-Wallet จะติดลบข้ามวันจนยอดวันถัดไปมาหักล้าง · คงเหลือไม่เป็นศูนย์ส่วนใหญ่มาจากรายการปรับรายได้ที่ยังไม่ได้บันทึก (ดู warning)
          </p>
        </div>
      )}

      {posLines.length > 0 && (
        <div className="card scroll-x">
          <h2>ไฟล์รายรับ · ส่วน POS + Catering ({posLines.length} บรรทัด)</h2>
          <table className="data">
            <thead>
              <tr><th>ลำดับ</th><th>ลูกค้า</th><th>คำอธิบาย</th><th>จำนวนเงิน (รวม VAT)</th><th>รับชำระโดย</th><th>หมายเหตุ</th><th>กลุ่ม</th></tr>
            </thead>
            <tbody>
              {posLines.map(l => (
                <tr key={l.seq}>
                  <td>{l.seq}</td>
                  <td style={{ textAlign: 'left' }}>{l.customer}</td>
                  <td style={{ textAlign: 'left' }}>{l.description}</td>
                  <td style={{ color: l.amount < 0 ? 'var(--danger)' : 'inherit' }}>{fmt(l.amount)}</td>
                  <td style={{ textAlign: 'left' }}>{l.paidBy}</td>
                  <td style={{ textAlign: 'left' }}>{l.note}</td>
                  <td style={{ textAlign: 'left' }}>{l.classGroup}</td>
                </tr>
              ))}
              <tr className="total"><td colSpan={3} style={{ textAlign: 'left' }}>รวม</td><td>{fmt(sum(posLines))}</td><td colSpan={3}></td></tr>
            </tbody>
          </table>
        </div>
      )}

      {grabRevLines.length > 0 && (
        <div className="card scroll-x">
          <details>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
              ไฟล์รายรับ · ส่วน Grab รายออเดอร์ ({grabRevLines.length} บรรทัด · รวม {fmt(sum(grabRevLines))}) — คลิกเพื่อดูรายบรรทัด
            </summary>
            <table className="data" style={{ marginTop: 10 }}>
              <thead>
                <tr><th>ลำดับ</th><th>อ้างอิง</th><th>ลูกค้า</th><th>คำอธิบาย</th><th>จำนวนเงิน</th><th>รับชำระโดย</th><th>กลุ่ม</th></tr>
              </thead>
              <tbody>
                {grabRevLines.map(l => (
                  <tr key={l.seq}>
                    <td>{l.seq}</td>
                    <td style={{ textAlign: 'left' }}>{l.ref}</td>
                    <td style={{ textAlign: 'left' }}>{l.customer}</td>
                    <td style={{ textAlign: 'left' }}>{l.description}</td>
                    <td>{fmt(l.amount)}</td>
                    <td style={{ textAlign: 'left' }}>{l.paidBy}</td>
                    <td style={{ textAlign: 'left' }}>{l.classGroup}</td>
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
              ไฟล์ต้นทุน Grab ({grabDocCount} เอกสาร · {grabExpLines.length} บรรทัด · รวม {fmt(sum(grabExpLines))}) — คลิกเพื่อดูรายบรรทัด
            </summary>
            <table className="data" style={{ marginTop: 10 }}>
              <thead>
                <tr><th>เอกสาร</th><th>อ้างอิง</th><th>คู่ค้า</th><th>บัญชี</th><th>คำอธิบาย</th><th>จำนวนเงิน</th><th>ชำระโดย</th><th>ยอดเอกสาร</th><th>กลุ่ม</th></tr>
              </thead>
              <tbody>
                {grabExpLines.map((l, i) => (
                  <tr key={i}>
                    <td>{l.seq}</td>
                    <td style={{ textAlign: 'left' }}>{l.ref}</td>
                    <td style={{ textAlign: 'left' }}>{l.contact}</td>
                    <td>{l.account}</td>
                    <td style={{ textAlign: 'left' }}>{l.description}</td>
                    <td style={{ color: l.amount < 0 ? 'var(--danger)' : 'inherit' }}>{fmt(l.amount)}</td>
                    <td style={{ textAlign: 'left' }}>{l.paidBy}</td>
                    <td>{fmt(l.docTotal)}</td>
                    <td style={{ textAlign: 'left' }}>{l.classGroup}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      )}

      {posLines.length === 0 && grabRevLines.length === 0 && !busy && !error && (
        <div className="banner warn">ไม่มีข้อมูลรายรับสำหรับวันนี้ — อัปโหลดรายงาน Grab หรือบันทึก Catering ก่อน</div>
      )}
    </div>
  )
}
