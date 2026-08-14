import * as XLSX from 'xlsx'
import type { Branch } from './supabase'

/** One line of the PEAK Import_Receipt sheet (per Point's real template, Aug 2026). */
export type PeakReceiptLine = {
  seq: number            // A ลำดับที่ — each line is its own document (sample style)
  docDate: number        // B YYYYMMDD
  customer: string       // E ลูกค้า (per-branch contact code)
  account: string        // K บัญชี (410101 revenue)
  description: string    // L คำอธิบาย (source label)
  amount: number         // N ราคาต่อหน่วย (VAT-inclusive)
  paidBy: string         // R รับชำระโดย (BSVxxx / wallet sub-account)
  note: string           // S หมายเหตุ (payment method, per Point's rule)
  classGroup: string     // T กลุ่มจัดประเภท
}

/** Row of acc.pos_channel_payment (mp_metrics.transaction_by_channel_and_payment). */
export type PosViewRow = {
  business_date: string
  location_id: string
  channel: string        // dine_in | take_away | delivery
  method_name: string
  method_code: string
  method_group: string   // cash | transfer | qr | platform | internal | other
  bills: number
  amount_thb: number | string
}

export type PosLine = {
  branchCode: string
  methodCode: string
  methodName: string
  amount: number
  bills: number
  toWallet: boolean      // TCT → the branch's ถุงเงิน account
}

const TCT_METHOD = 'thai_chuai_thai'

/**
 * Point's rules (2026-08-15):
 * - dine_in + take_away with the same payment method are summed into one line
 * - internal methods (staff meal…) are excluded entirely
 * - grab-METHOD bills (any channel) are excluded — they settle via the Grab
 *   คำนวณ/ถุงเงิน lines instead (booking both would double-count)
 * - delivery-channel rows are excluded from booking; grab-related bills are
 *   counted for the bill reconcile instead
 * - ไทยช่วยไทย (TCT) lines go to the branch's ถุงเงิน account; the rest to the
 *   branch revenue account
 * Returns lines + per-branch POS bill counts of grab-origin orders
 * (method=grab any channel, plus delivery×TCT) for reconciling with the Grab report.
 */
export function buildPosLines(
  rows: PosViewRow[],
  branchByLocation: Map<string, string>,
): { posLines: PosLine[]; grabPosBills: Map<string, number>; warnings: string[] } {
  const warnings: string[] = []
  const grabPosBills = new Map<string, number>()
  const agg = new Map<string, PosLine>()

  for (const r of rows) {
    const branchCode = branchByLocation.get(r.location_id)
    if (!branchCode) {
      warnings.push(`ไม่รู้จักสาขา POS "${r.location_id}" — ข้าม ${r.method_code} ${r.amount_thb}`)
      continue
    }
    const amount = Number(r.amount_thb)
    const isGrabMethod = r.method_group === 'platform'
    const isTct = r.method_code === TCT_METHOD

    if (isGrabMethod || (r.channel === 'delivery' && isTct)) {
      grabPosBills.set(branchCode, (grabPosBills.get(branchCode) ?? 0) + Number(r.bills))
      continue
    }
    if (r.method_group === 'internal') continue
    if (r.channel === 'delivery') {
      warnings.push(`${branchCode}: delivery × ${r.method_code} ${amount.toFixed(2)} — ยังไม่มีกติกา ไม่ถูกใส่ในไฟล์`)
      continue
    }
    const key = `${branchCode}|${r.method_code}`
    if (!agg.has(key)) {
      agg.set(key, { branchCode, methodCode: r.method_code, methodName: r.method_name, amount: 0, bills: 0, toWallet: isTct })
    }
    const a = agg.get(key)!
    a.amount += amount
    a.bills += Number(r.bills)
  }
  for (const a of agg.values()) a.amount = Math.round(a.amount * 100) / 100
  return { posLines: [...agg.values()], grabPosBills, warnings }
}

export type PeakSourceAmounts = {
  branchCode: string
  grabBank: number       // โอนเข้าธนาคาร (คำนวณ) for the day — may be negative
  grabWallet: number     // เข้าถุงเงิน (TCT) for the day
}

export type CateringLine = { branchCode: string | null; name: string; netReceiving: number }

export type PeakConfig = {
  revenueAccount: string   // K
  vatRate: number          // P
  priceType: number        // I (1 แยกภาษี, 2 รวมภาษี, 3 ไม่มีภาษี)
  taxInvoice: number       // H (1 ออก, 2 ไม่ออก)
}
export const DEFAULT_PEAK_CONFIG: PeakConfig = {
  revenueAccount: '410101', vatRate: 0.07, priceType: 2, taxInvoice: 1,
}

export function toDocDate(isoDate: string): number {
  return Number(isoDate.replaceAll('-', ''))
}

/**
 * Build receipt lines for one day, all branches. Returns lines + warnings for
 * anything that could not be included (missing mappings).
 */
export function buildPeakReceiptLines(
  isoDate: string,
  branches: Branch[],
  grab: PeakSourceAmounts[],
  catering: CateringLine[],
  posLines: PosLine[] = [],
  config: PeakConfig = DEFAULT_PEAK_CONFIG,
): { lines: PeakReceiptLine[]; warnings: string[] } {
  const lines: PeakReceiptLine[] = []
  const warnings: string[] = []
  const docDate = toDocDate(isoDate)
  const byCode = new Map(branches.map(b => [b.code, b]))
  let seq = 1

  const push = (b: Branch, description: string, amount: number, paidBy: string, note = '') => {
    lines.push({
      seq: seq++, docDate,
      customer: b.peak_customer ?? '',
      account: config.revenueAccount,
      description,
      amount: Math.round(amount * 100) / 100,
      paidBy,
      note,
      classGroup: b.peak_class ?? '',
    })
  }

  for (const p of posLines) {
    const b = byCode.get(p.branchCode)
    if (!b || !b.peak_customer || !b.peak_class) {
      warnings.push(`${p.branchCode}: ยังตั้งค่า Peak ไม่ครบ — ข้าม POS ${p.methodName} ${p.amount.toFixed(2)}`)
      continue
    }
    if (Math.abs(p.amount) <= 0.005) continue
    if (p.toWallet) {
      if (b.tungngern_peak_sub) push(b, `POS ${p.methodName}`, p.amount, b.tungngern_peak_sub, p.methodName)
      else warnings.push(`${b.name_en}: ไม่มีบัญชีถุงเงิน — POS ${p.methodName} ${p.amount.toFixed(2)} ไม่ถูกใส่ในไฟล์`)
    } else {
      if (b.peak_bank_sub) push(b, `POS ${p.methodName}`, p.amount, b.peak_bank_sub, p.methodName)
      else warnings.push(`${b.name_en}: ไม่มีบัญชีธนาคาร — POS ${p.methodName} ${p.amount.toFixed(2)} ไม่ถูกใส่ในไฟล์`)
    }
  }

  for (const g of grab) {
    const b = byCode.get(g.branchCode)
    if (!b) { warnings.push(`ไม่รู้จักสาขา "${g.branchCode}" — ข้ามยอด Grab`); continue }
    if (!b.peak_customer || !b.peak_class) {
      warnings.push(`${b.name_en}: ยังไม่ตั้งค่า peak_customer/peak_class ใน acc.branches — ข้ามยอด Grab`)
      continue
    }
    if (Math.abs(g.grabBank) > 0.005) {
      if (b.peak_bank_sub) push(b, 'Grab โอนเข้าธนาคาร', g.grabBank, b.peak_bank_sub, 'Grab')
      else warnings.push(`${b.name_en}: ไม่มีบัญชีธนาคาร (BSV) — ข้ามบรรทัด Grab ${g.grabBank.toFixed(2)}`)
    }
    if (Math.abs(g.grabWallet) > 0.005) {
      if (b.tungngern_peak_sub) push(b, 'Grab ถุงเงิน (TCT)', g.grabWallet, b.tungngern_peak_sub, 'Grab TCT')
      else warnings.push(`${b.name_en}: ยังไม่ตั้งค่าบัญชีถุงเงิน — บรรทัด Grab ถุงเงิน ${g.grabWallet.toFixed(2)} ไม่ถูกใส่ในไฟล์ (บันทึกใน Peak เองไปก่อน)`)
    }
  }

  for (const c of catering) {
    if (Math.abs(c.netReceiving) <= 0.005) continue
    const b = c.branchCode ? byCode.get(c.branchCode) : undefined
    if (!b || !b.peak_customer || !b.peak_bank_sub) {
      warnings.push(`Catering "${c.name}" (${c.netReceiving.toFixed(2)}): ${!b ? 'ไม่ได้ระบุสาขา' : 'สาขายังตั้งค่าไม่ครบ'} — ไม่ถูกใส่ในไฟล์`)
      continue
    }
    push(b, `Catering: ${c.name}`, c.netReceiving, b.peak_bank_sub, 'Catering')
  }

  return { lines, warnings }
}

const HEADERS = [
  'ลำดับที่*', 'วันที่เอกสาร', 'เลขที่เอกสาร', 'อ้างอิงถึง', 'ลูกค้า',
  'เลขทะเบียน 13 หลัก', 'เลขสาขา 5 หลัก', 'การออกใบกำกับภาษี', 'ประเภทราคา',
  'สินค้า/บริการ', 'บัญชี', 'คำอธิบาย', 'จำนวน', 'ราคาต่อหน่วย',
  'ส่วนลดต่อหน่วย', 'อัตราภาษี', 'ถูกหัก ณ ที่จ่าย(ถ้ามี)', 'รับชำระโดย',
  'หมายเหตุ', 'กลุ่มจัดประเภท',
]

/** Serialize lines into the exact Import_Receipt workbook Peak expects. */
export function peakReceiptWorkbook(lines: PeakReceiptLine[], config: PeakConfig = DEFAULT_PEAK_CONFIG): XLSX.WorkBook {
  const aoa: unknown[][] = [HEADERS]
  for (const l of lines) {
    aoa.push([
      l.seq, l.docDate, '', '', l.customer,
      '', '', config.taxInvoice, config.priceType,
      '', l.account, l.description, 1, l.amount,
      '', config.vatRate, '', l.paidBy,
      l.note, l.classGroup,
    ])
  }
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Import_Receipt')
  return wb
}
