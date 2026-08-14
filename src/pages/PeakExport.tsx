import { useEffect, useState } from 'react'
import * as XLSX from 'xlsx'
import { sb, fetchAll, bkkToday } from '../lib/supabase'
import { reconByBranch, COMPANY } from '../lib/grabCalc'
import { dbToGrabRow } from '../lib/grabIngest'
import {
  buildPeakReceiptLines, buildPosLines, peakReceiptWorkbook, DEFAULT_PEAK_CONFIG,
  type PeakConfig, type PeakSourceAmounts, type CateringLine, type PeakReceiptLine, type PosViewRow,
} from '../lib/peakExport'
import { useBranches } from './Shell'

type DbRow = Record<string, unknown>
const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function PeakExport() {
  const branches = useBranches()
  const [day, setDay] = useState(bkkToday(1))
  const [lines, setLines] = useState<PeakReceiptLine[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [billRecon, setBillRecon] = useState<{ branch: string; pos: number; grab: number; hasPos: boolean }[]>([])
  const [config, setConfig] = useState<PeakConfig>(DEFAULT_PEAK_CONFIG)

  const byStoreId = new Map(branches.filter(b => b.grab_store_id).map(b => [b.grab_store_id!, b.code]))
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
      }
      setConfig(cfg)
      const rows = await fetchAll<DbRow>((f, t) => sb.from('grab_rows')
        .select('*').eq('business_date', day).order('id').range(f, t))

      // reuse the tested reconciliation: per-branch bank (คำนวณ) and ถุงเงิน for the day
      const grabRows = rows.map(dbToGrabRow).filter(r => r.category !== 'ยกเลิก')
      const recon = grabRows.length
        ? reconByBranch({ rows: grabRows, payouts: [], periodStart: day, periodEnd: day, declaredStart: day, declaredEnd: day, warnings: [] })
        : []
      const per: PeakSourceAmounts[] = recon
        .filter(b => b.store !== COMPANY)
        .map(b => ({
          branchCode: byStoreId.get(b.grabStoreId) ?? '',
          grabBank: b.bankPayoutCalc,
          grabWallet: b.walletReceive,
        }))

      // POS channels from mp_metrics view (dine_in + take_away per method)
      const posRows = await fetchAll<PosViewRow>((f, t) => sb.from('pos_channel_payment')
        .select('*').eq('business_date', day).order('location_id').range(f, t))
      const pos = buildPosLines(posRows, byLocation)

      // bill reconcile: POS grab-origin bills vs Grab report payment rows
      const grabBillsByBranch = new Map<string, number>()
      for (const r of grabRows) {
        if (r.category !== 'ชำระเงิน') continue
        const code = byStoreId.get(r.grabStoreId) ?? ''
        if (code) grabBillsByBranch.set(code, (grabBillsByBranch.get(code) ?? 0) + 1)
      }
      const posCoveredBranches = new Set(posRows.map(r => byLocation.get(r.location_id)).filter(Boolean))
      const branchCodes = [...new Set([...pos.grabPosBills.keys(), ...grabBillsByBranch.keys()])].sort()
      setBillRecon(branchCodes.map(c => ({
        branch: c,
        pos: pos.grabPosBills.get(c) ?? 0,
        grab: grabBillsByBranch.get(c) ?? 0,
        hasPos: posCoveredBranches.has(c),
      })))

      const { data: events, error: ee } = await sb.from('catering_events')
        .select('branch_code,name,net_receiving').eq('event_date', day)
        .in('status', ['reconcile_ready', 'performance_complete'])
      if (ee) throw ee
      const catering: CateringLine[] = ((events as DbRow[]) ?? []).map(e => ({
        branchCode: (e.branch_code as string) ?? null,
        name: (e.name as string) ?? '',
        netReceiving: Number(e.net_receiving ?? 0),
      }))

      const built = buildPeakReceiptLines(day, branches, per, catering, pos.posLines, cfg)
      setLines(built.lines)
      setWarnings([...pos.warnings, ...built.warnings])
    } catch (err) {
      setError((err as Error).message)
    }
    setBusy(false)
  }

  useEffect(() => { if (branches.length) load() }, [branches.length, day])

  function download() {
    const wb = peakReceiptWorkbook(lines, config)
    XLSX.writeFile(wb, `PEAK_ImportReceipt_${day}.xlsx`)
  }

  const branchName = (code: string) => branches.find(b => b.code === code)?.name_en
    ?? branches.find(b => b.peak_customer && lines.some(l => l.customer === b.peak_customer))?.name_en ?? code
  const total = lines.reduce((s, l) => s + l.amount, 0)

  return (
    <div>
      <h1>Peak — Export ใบเสร็จรับเงิน</h1>
      <p className="muted">สร้างไฟล์ Import_Receipt รายวัน (ทุกสาขาในไฟล์เดียว) จากข้อมูล POS (dine-in + take-away รวมกันตามช่องทางจ่ายเงิน) + Grab + Catering — สาขาที่ POS ยังไม่ sync จะมีเฉพาะบรรทัด Grab</p>
      <div className="card row">
        <div><label>วันที่ (วันขาย)</label><input type="date" value={day} onChange={e => setDay(e.target.value)} /></div>
        <button className="primary" onClick={download} disabled={busy || lines.length === 0}>
          ดาวน์โหลดไฟล์ Peak ({lines.length} บรรทัด)
        </button>
        {busy && <span className="muted">กำลังโหลด…</span>}
      </div>
      {error && <div className="banner bad">{error}</div>}
      {warnings.map((w, i) => <div key={i} className="banner warn">{w}</div>)}

      {lines.length > 0 && (
        <div className="card scroll-x">
          <h2>ตัวอย่างไฟล์ ({day})</h2>
          <table className="data">
            <thead>
              <tr><th>ลำดับ</th><th>ลูกค้า</th><th>คำอธิบาย</th><th>จำนวนเงิน (รวม VAT)</th><th>รับชำระโดย</th><th>หมายเหตุ</th><th>กลุ่ม</th></tr>
            </thead>
            <tbody>
              {lines.map(l => (
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
              <tr className="total"><td colSpan={3} style={{ textAlign: 'left' }}>รวม</td><td>{fmt(total)}</td><td colSpan={3}></td></tr>
            </tbody>
          </table>
        </div>
      )}
      {billRecon.length > 0 && (
        <div className="card">
          <h2>กระทบยอดจำนวนบิล Grab (POS delivery vs รายงาน Grab)</h2>
          <div className="scroll-x">
            <table className="data">
              <thead><tr><th>สาขา</th><th>บิลใน POS</th><th>บิลในรายงาน Grab</th><th>ผล</th></tr></thead>
              <tbody>
                {billRecon.map((r, i) => (
                  <tr key={i}>
                    <td style={{ textAlign: 'left' }}>{branchName(r.branch)}</td>
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

      {lines.length === 0 && !busy && !error && (
        <div className="banner warn">ไม่มีข้อมูลรายรับสำหรับวันนี้ — อัปโหลดรายงาน Grab หรือบันทึก Catering ก่อน</div>
      )}
    </div>
  )
}
