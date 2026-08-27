import * as XLSX from 'xlsx'
import type { Branch } from './supabase'
import type { GrabRow } from './grabParser'
import { isBankSale } from './grabCalc'

/** One line of the PEAK Import_Receipt sheet (per Point's real template, Aug 2026). */
export type PeakReceiptLine = {
  seq: number            // A ลำดับที่ — each line is its own document (sample style)
  docDate: number        // B YYYYMMDD
  ref?: string           // D อ้างอิงถึง (Grab flow: GF order code)
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
  qty: number              // M จำนวน — คงที่
}
export const DEFAULT_PEAK_CONFIG: PeakConfig = {
  revenueAccount: '410101', vatRate: 0.07, priceType: 2, taxInvoice: 1, qty: 1,
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
      l.seq, l.docDate, '', l.ref ?? '', l.customer,
      '', '', config.taxInvoice, config.priceType,
      '', l.account, l.description, config.qty, l.amount,
      '', config.vatRate, '', l.paidBy,
      l.note, l.classGroup,
    ])
  }
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Import_Receipt')
  return wb
}

// ---------------------------------------------------------------------------
// Grab E-Wallet flow (Point, 2026-08-18): each Grab order books at ORDER level.
// Revenue file (Import_Receipt): gross ยอด into the branch's G-Wallet (EWLxxx).
// Costs file (Import_Expenses): one document per order/ads row, every cost line
// paid from the same wallet. Staff key the settlement transfers (wallet → bank /
// wallet → TCT account) manually in Peak — all costs ride the normal-order
// settlement, never the TCT one, so the wallet may carry a negative balance
// forward when costs exceed the day's normal-order net.
// ---------------------------------------------------------------------------

export type GrabPeakConfig = {
  discountAccount: string  // K ส่วนลดออกโดยร้าน (510301 per Point; Sheet1 shows 510310)
  costAccount: string      // K ทุกค่าคอม/ค่าธรรมเนียม/โฆษณา (530504 for now)
  adjAccount: string       // K การปรับรายได้อื่นๆ — '' = ยังไม่บันทึก (เตือนแทน)
}
export const DEFAULT_GRAB_PEAK_CONFIG: GrabPeakConfig = {
  discountAccount: '510301', costAccount: '530504', adjAccount: '',
}

/** One line of the PEAK Import_Expenses sheet. Same seq = one document. */
export type PeakExpenseLine = {
  seq: number          // A ลำดับที่ — เลขเดียวกัน = เอกสารเดียวกัน
  docDate: number      // B YYYYMMDD
  ref: string          // C อ้างอิงถึง (GF code / ads txn)
  contact: string      // D ผู้รับเงิน/คู่ค้า (grab_contact ของสาขา)
  account: string      // K บัญชี
  description: string  // L คำอธิบาย
  amount: number       // N ราคาต่อหน่วย (บวก)
  paidBy: string       // Q ชำระโดย (EWLxxx)
  docTotal: number     // R จำนวนเงินที่ชำระ — ยอดรวมของเอกสาร ซ้ำทุกบรรทัด
  classGroup: string   // U กลุ่มจัดประเภท
}

const r2 = (n: number) => Math.round(n * 100) / 100

type BranchIssue = { count: number; sum: number }
function noteIssue(m: Map<string, BranchIssue>, key: string, amount: number) {
  if (!m.has(key)) m.set(key, { count: 0, sum: 0 })
  const x = m.get(key)!
  x.count += 1
  x.sum += amount
}
function issueWarnings(m: Map<string, BranchIssue>, what: string): string[] {
  return [...m.entries()].map(([k, v]) =>
    `${k}: ${what} ${v.count} รายการ (รวม ${v.sum.toFixed(2)}) — ไม่ถูกใส่ในไฟล์`)
}

/**
 * Grab revenue file — one receipt line (own document) per ชำระเงิน row:
 * gross ยอด into the branch's E-Wallet, อ้างอิง = GF code, ลูกค้า = Grab contact.
 * Cancelled orders and zero-amount rows are skipped.
 */
export function buildGrabReceiptLines(
  isoDate: string,
  branches: Branch[],
  rows: GrabRow[],
  config: PeakConfig = DEFAULT_PEAK_CONFIG,
): { lines: PeakReceiptLine[]; warnings: string[] } {
  const lines: PeakReceiptLine[] = []
  const missing = new Map<string, BranchIssue>()
  const docDate = toDocDate(isoDate)
  const byStoreId = new Map(branches.filter(b => b.grab_store_id).map(b => [b.grab_store_id!, b]))
  let seq = 1
  for (const r of rows) {
    if (r.category !== 'ชำระเงิน') continue
    if (Math.abs(r.amount) <= 0.005) continue
    const b = byStoreId.get(r.grabStoreId)
    if (!b || !b.ewallet || !b.grab_contact || !b.peak_class) {
      noteIssue(missing, b?.name_en ?? r.storeName, r.amount)
      continue
    }
    lines.push({
      seq: seq++, docDate,
      ref: r.orderCode,
      customer: b.grab_contact,
      account: config.revenueAccount,
      description: isBankSale(r) ? 'Grab' : 'Grab ไทยช่วยไทย',
      amount: r2(r.amount),
      paidBy: b.ewallet,
      note: '',
      classGroup: b.peak_class,
    })
  }
  return {
    lines,
    warnings: issueWarnings(missing, 'ยังตั้งค่า E-Wallet/ผู้ติดต่อ Grab ไม่ครบ — ข้ามรายรับ Grab'),
  }
}

/** Cost components of one Grab payment row, in template order. */
function costParts(r: GrabRow, cfg: GrabPeakConfig): { account: string; label: string; amount: number }[] {
  const parts = [
    { account: cfg.discountAccount, label: 'ส่วนลดออกโดยร้านค้า', amount: -r.shopDiscount },
    { account: cfg.discountAccount, label: 'ส่วนลดค่าจัดส่ง (ออกโดยร้าน)', amount: -r.deliveryDiscount },
    { account: cfg.costAccount, label: 'ค่าธรรมเนียมการตลาด', amount: -r.marketingFee },
    { account: cfg.costAccount, label: 'ค่าคอมมิชชั่นแพลตฟอร์ม', amount: -r.commPlatform },
    { account: cfg.costAccount, label: 'ค่าคอมมิชชั่นคำสั่งซื้อ', amount: -r.commOrder },
    { account: cfg.costAccount, label: 'ค่าคอมมิชชั่นการจัดส่ง', amount: -r.commDelivery },
    { account: cfg.costAccount, label: 'ค่าคอมมิชชั่นอื่นของ grab', amount: -r.commOther },
    { account: cfg.costAccount, label: 'MDR / ค่าธรรมเนียม Grab', amount: -(r.mdr + r.mdrVat + r.grabFee) },
  ]
  return parts.filter(p => Math.abs(p.amount) > 0.005).map(p => ({ ...p, amount: r2(p.amount) }))
}

/**
 * Grab costs file — Import_Expenses documents, all paid from the branch E-Wallet:
 * - one document per ชำระเงิน order holding its discount/fee/commission lines
 * - one document per TCT commission row (การปรับรายได้ Commission for Govt Campaign)
 * - one document per โฆษณา row (Manual/Automatic Keywords)
 * - refund-labeled อื่นๆ rows are pure settlement-stream shifts → skipped (info)
 * - other การปรับรายได้ rows need grab_adj_account; blank config → warning
 * - ภาษีหัก ณ ที่จ่าย has no rule yet → loud warning if it ever appears
 */
export function buildGrabExpenseLines(
  isoDate: string,
  branches: Branch[],
  rows: GrabRow[],
  cfg: GrabPeakConfig = DEFAULT_GRAB_PEAK_CONFIG,
): { lines: PeakExpenseLine[]; warnings: string[]; info: string[] } {
  const lines: PeakExpenseLine[] = []
  const warnings: string[] = []
  const info: string[] = []
  const missing = new Map<string, BranchIssue>()
  const noAdjAccount = new Map<string, BranchIssue>()
  const docDate = toDocDate(isoDate)
  const byStoreId = new Map(branches.filter(b => b.grab_store_id).map(b => [b.grab_store_id!, b]))
  // bank-stream order codes per store — refund rows referencing them are NOT wallet shifts
  const bankCodes = new Set(rows
    .filter(r => r.category === 'ชำระเงิน' && r.orderCode && isBankSale(r))
    .map(r => `${r.grabStoreId}|${r.orderCode}`))
  let seq = 1

  const pushDoc = (b: Branch, ref: string, parts: { account: string; label: string; amount: number }[]) => {
    if (!parts.length) return
    const docTotal = r2(parts.reduce((s, p) => s + p.amount, 0))
    const docSeq = seq++
    for (const p of parts) {
      lines.push({
        seq: docSeq, docDate, ref,
        contact: b.grab_contact!,
        account: p.account, description: p.label, amount: p.amount,
        paidBy: b.ewallet!, docTotal, classGroup: b.peak_class!,
      })
    }
  }

  for (const r of rows) {
    if (r.category === 'ยกเลิก') continue
    const b = byStoreId.get(r.grabStoreId)
    const totalMag = r.category === 'ชำระเงิน' ? r.total - r.amount : r.total
    const ready = b && b.ewallet && b.grab_contact && b.peak_class
    if (r.category === 'ชำระเงิน') {
      if (Math.abs(r.wht) > 0.005) {
        warnings.push(`${r.orderCode}: มีภาษีหัก ณ ที่จ่าย ${(-r.wht).toFixed(2)} — ยังไม่มีกติกาบันทึก ไม่ถูกใส่ในไฟล์ (แจ้ง Point)`)
      }
      const parts = costParts(r, cfg)
      if (!parts.length) continue
      if (!ready) { noteIssue(missing, b?.name_en ?? r.storeName, totalMag); continue }
      pushDoc(b!, r.orderCode, parts)
    } else if (r.category === 'การปรับรายได้') {
      if (r.subitem.startsWith('Commission for Govt Campaign')) {
        if (!ready) { noteIssue(missing, b?.name_en ?? r.storeName, r.total); continue }
        pushDoc(b!, r.orderCode, [{ account: cfg.costAccount, label: 'ค่าคอมมิชชั่นไทยช่วยไทย', amount: r2(-r.total) }])
      } else if (/refund/i.test(r.description) && !(r.orderCode && bankCodes.has(`${r.grabStoreId}|${r.orderCode}`))) {
        info.push(`${b?.name_en ?? r.storeName} ${r.orderCode || r.txnId}: "${r.description}" ${r.total.toFixed(2)} — ย้ายสาย settlement (ถุงเงิน→ธนาคาร) เท่านั้น ไม่ต้องบันทึกบัญชี`)
      } else if (!cfg.adjAccount) {
        noteIssue(noAdjAccount, b?.name_en ?? r.storeName, r.total)
      } else {
        if (!ready) { noteIssue(missing, b?.name_en ?? r.storeName, r.total); continue }
        pushDoc(b!, r.orderCode || r.txnId, [{ account: cfg.adjAccount, label: `การปรับรายได้ ${r.subitem || 'อื่นๆ'}${r.description ? ` — ${r.description}` : ''}`, amount: r2(-r.total) }])
      }
    } else if (r.category === 'โฆษณา') {
      if (!ready) { noteIssue(missing, b?.name_en ?? r.storeName, r.total); continue }
      pushDoc(b!, r.orderCode || r.txnId, [{ account: cfg.costAccount, label: `โฆษณา ${r.description || r.subitem}`, amount: r2(-r.total) }])
    }
  }
  warnings.push(...issueWarnings(missing, 'ยังตั้งค่า E-Wallet/ผู้ติดต่อ Grab ไม่ครบ — ข้ามต้นทุน Grab'))
  warnings.push(...issueWarnings(noAdjAccount, 'การปรับรายได้อื่นๆ ยังไม่มีบัญชี (ตั้ง grab_adj_account ในตั้งค่า)'))
  return { lines, warnings, info }
}

/**
 * Merge receipt-line groups into ONE Import_Receipt file (Point 2026-08-26:
 * POS/Catering and per-order Grab revenue share the exact same template, so
 * upload once). Renumbers ลำดับที่ 1..n across all groups.
 */
export function mergeReceiptLines(...groups: PeakReceiptLine[][]): PeakReceiptLine[] {
  return groups.flat().map((l, i) => ({ ...l, seq: i + 1 }))
}

const EXPENSE_HEADERS = [
  'ลำดับที่* ', 'วันที่เอกสาร', 'อ้างอิงถึง', 'ผู้รับเงิน/คู่ค้า',
  'เลขทะเบียน 13 หลัก', 'เลขสาขา 5 หลัก', 'เลขที่ใบกำกับฯ (ถ้ามี)',
  'วันที่ใบกำกับฯ (ถ้ามี)', 'วันที่บันทึกภาษีซื้อ (ถ้ามี)', 'ประเภทราคา',
  'บัญชี', 'คำอธิบาย', 'จำนวน', 'ราคาต่อหน่วย', 'อัตราภาษี',
  'หัก ณ ที่จ่าย (ถ้ามี)', 'ชำระโดย', 'จำนวนเงินที่ชำระ', 'ภ.ง.ด. (ถ้ามี)',
  'หมายเหตุ', 'กลุ่มจัดประเภท',
]

/** Serialize expense lines into the exact Import_Expenses workbook Peak expects. */
export function peakExpenseWorkbook(lines: PeakExpenseLine[], config: PeakConfig = DEFAULT_PEAK_CONFIG): XLSX.WorkBook {
  const aoa: unknown[][] = [EXPENSE_HEADERS]
  for (const l of lines) {
    aoa.push([
      l.seq, l.docDate, l.ref, l.contact,
      '', '', '', '', '', config.priceType,
      l.account, l.description, config.qty, l.amount, config.vatRate,
      '', l.paidBy, l.docTotal, '', '', l.classGroup,
    ])
  }
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Import_Expenses')
  return wb
}
