import * as XLSX from 'xlsx'

export type GrabCategory = 'ชำระเงิน' | 'การปรับรายได้' | 'โฆษณา'

export type GrabRow = {
  storeName: string
  grabStoreId: string
  category: GrabCategory
  subitem: string
  status: string
  txnId: string
  relatedTxnId: string
  orderCode: string
  longOrderId: string
  orderType: string
  paymentMethod: string
  payoutId: string
  grabCreatedAt: string | null
  transferredAt: string | null
  businessDate: string
  amount: number
  shopDiscount: number
  deliveryDiscount: number
  netSales: number
  mdr: number
  mdrVat: number
  grabFee: number
  marketingFee: number
  commDelivery: number
  commPlatform: number
  commOrder: number
  commOther: number
  wht: number
  total: number
  commVat: number
  description: string
  cancelReason: string
  cancelledBy: string
  refundReason: string
}

export type GrabPayout = {
  payoutId: string
  storeName: string
  grabStoreId: string
  amount: number
  transferredAt: string | null
  bankStmtRef: string
  bankName: string
  bankLast4: string
}

export type GrabParse = {
  rows: GrabRow[]
  payouts: GrabPayout[]
  /** min/max business date actually seen in the rows */
  periodStart: string
  periodEnd: string
  /** the report period DECLARED in the สรุป sheet (ช่วงวันที่) — authoritative
   *  bound for replace-on-upload; falls back to row dates when missing */
  declaredStart: string
  declaredEnd: string
  warnings: string[]
}

const TXN_SHEET = 'รายการชำระเงิน'
const PAYOUT_SHEET = 'การจ่ายรายได้'
const SUMMARY_SHEET = 'สรุป'

/** "10/08/2026 - 11/08/2026" (สรุป ช่วงวันที่) -> [ '2026-08-10', '2026-08-11' ] */
function parseDeclaredPeriod(wb: XLSX.WorkBook): [string, string] | null {
  const ws = wb.Sheets[SUMMARY_SHEET]
  if (!ws) return null
  const aoa: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false })
  for (const row of aoa.slice(0, 12)) {
    if (!row) continue
    const i = row.findIndex(c => String(c ?? '').trim() === 'ช่วงวันที่')
    if (i < 0) continue
    const m = String(row[i + 1] ?? '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/)
    if (!m) return null
    const iso = (d: string, mo: string, y: string) => `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
    return [iso(m[1], m[2], m[3]), iso(m[4], m[5], m[6])]
  }
  return null
}

// Column headers as they appear in the GrabMerchant export (documented in handoff §6c)
const H = {
  storeName2: 'ชื่อร้าน', // appears twice; we take the 3rd column (index 2) via position
  storeId: 'รหัสร้านค้า',
  createdAt: 'วันที่สร้าง',
  category: 'หมวดหมู่',
  subitem: 'รายการย่อย',
  status: 'สถานะ',
  txnId: 'Transaction ID',
  relatedTxnId: 'รหัสรายการที่เกี่ยวข้อง',
  orderCodeShort: 'รหัสคำสั่งซื้อสั้น',
  orderCodeLong: 'รหัสคำสั่งซื้อยาว',
  orderType: 'ประเภทคำสั่งซื้อ',
  paymentMethod: 'วิธีการชำระเงิน',
  payoutId: 'รหัสการทำรายการ',
  transferredAt: 'วันที่โอน',
  amount: 'ยอด',
  shopDiscount: 'ส่วนลด (ออกโดยร้าน)',
  deliveryDiscount: 'ส่วนลดค่าจัดส่ง (ออกโดยร้าน)',
  netSales: 'ยอดขายสุทธิ',
  mdr: 'MDR สุทธิ',
  mdrVat: 'ภาษี MDR',
  grabFee: 'ค่าธรรมเนียม Grab',
  marketingFee: 'ค่าธรรมเนียมการตลาด',
  commDelivery: 'ค่าคอมมิชชันการจัดส่ง',
  commPlatform: 'ค่าคอมมิชชันแพลตฟอร์ม',
  commOrder: 'ค่าคอมมิชชันคำสั่งซื้อ',
  commOther: 'ค่าคอมมิชชันอื่นของ GrabFood / GrabMart',
  wht: 'ภาษีหัก ณ ที่จ่าย',
  total: 'ทั้งหมด',
  commVat: 'ภาษีค่าคอมมิชชัน, การปรับรายได้, โฆษณา GrabFood / GrabMart',
  description: 'คำอธิบาย',
  cancelReason: 'สาเหตุที่ยกเลิก',
  cancelledBy: 'ยกเลิกโดย',
  refundReason: 'สาเหตุที่คืนเงิน',
} as const

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
}

/** "11 Aug 2026 1:02 PM" -> ISO string; returns null when unparseable */
export function parseGrabDate(v: unknown): string | null {
  if (v == null || v === '') return null
  const s = String(v).trim()
  const m = s.match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4})(?: (\d{1,2}):(\d{2}) (AM|PM))?$/)
  if (m) {
    const [, d, mon, y, hh, mm, ap] = m
    let hour = hh ? parseInt(hh, 10) : 0
    if (ap === 'PM' && hour !== 12) hour += 12
    if (ap === 'AM' && hour === 12) hour = 0
    const mo = MONTHS[mon]
    if (!mo) return null
    return `${y}-${mo}-${d.padStart(2, '0')}T${String(hour).padStart(2, '0')}:${mm ?? '00'}:00+07:00`
  }
  // "12/08/2026 02:48" (payout sheet style, DD/MM/YYYY)
  const m2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{1,2}):(\d{2}))?$/)
  if (m2) {
    const [, d, mo, y, hh, mm] = m2
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${(hh ?? '00').padStart(2, '0')}:${mm ?? '00'}:00+07:00`
  }
  return null
}

function isoToDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : ''
}

function num(v: unknown): number {
  if (typeof v === 'number') return v
  if (v == null || v === '') return 0
  const n = parseFloat(String(v).replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

function str(v: unknown): string {
  return v == null ? '' : String(v).trim()
}

/**
 * Stable identity for a row across re-uploads of overlapping exports.
 * TCT sale rows have no Transaction ID — fall back through related txn id,
 * long order id, then store+code+time+amount (GF codes recycle across days/branches).
 */
export function dedupeKey(r: GrabRow): string {
  return r.category + '|' + (
    r.txnId ||
    r.relatedTxnId ||
    r.longOrderId ||
    `${r.grabStoreId}@${r.orderCode}@${r.grabCreatedAt ?? ''}@${r.amount}`
  )
}

export function parseGrabWorkbook(wb: XLSX.WorkBook): GrabParse {
  const warnings: string[] = []
  const rows: GrabRow[] = []
  const payouts: GrabPayout[] = []

  const txnWs = wb.Sheets[TXN_SHEET]
  if (!txnWs) {
    warnings.push(`ไม่พบชีต "${TXN_SHEET}" ในไฟล์`)
    return { rows, payouts, periodStart: '', periodEnd: '', declaredStart: '', declaredEnd: '', warnings }
  }
  const aoa: unknown[][] = XLSX.utils.sheet_to_json(txnWs, { header: 1, raw: true })
  const hdr = (aoa[0] ?? []).map(str)
  const col: Record<string, number> = {}
  hdr.forEach((h, i) => { if (!(h in col)) col[h] = i })
  // store name appears twice (company col A, store col C) — take the second occurrence
  const storeNameIdx = hdr.indexOf(H.storeName2, hdr.indexOf(H.storeName2) + 1)

  const need = [H.category, H.amount, H.total, H.storeId]
  for (const n of need) {
    if (!(n in col)) warnings.push(`ไม่พบคอลัมน์ "${n}"`)
  }
  if (warnings.length) return { rows, payouts, periodStart: '', periodEnd: '', declaredStart: '', declaredEnd: '', warnings }

  const g = (r: unknown[], name: string): unknown => r[col[name]]

  for (let i = 1; i < aoa.length; i++) {
    const r = aoa[i]
    if (!r || r.length === 0 || r[0] == null || r[0] === '') continue
    const category = str(g(r, H.category)) as GrabCategory
    if (!['ชำระเงิน', 'การปรับรายได้', 'โฆษณา'].includes(category)) {
      warnings.push(`แถว ${i + 1}: หมวดหมู่ไม่รู้จัก "${category}"`)
      continue
    }
    const createdAt = parseGrabDate(g(r, H.createdAt))
    const row: GrabRow = {
      storeName: str(storeNameIdx >= 0 ? r[storeNameIdx] : ''),
      grabStoreId: str(g(r, H.storeId)),
      category,
      subitem: str(g(r, H.subitem)),
      status: str(g(r, H.status)),
      txnId: str(g(r, H.txnId)),
      relatedTxnId: str(g(r, H.relatedTxnId)),
      orderCode: str(g(r, H.orderCodeShort)),
      longOrderId: str(g(r, H.orderCodeLong)),
      orderType: str(g(r, H.orderType)),
      paymentMethod: str(g(r, H.paymentMethod)),
      payoutId: str(g(r, H.payoutId)),
      grabCreatedAt: createdAt,
      transferredAt: parseGrabDate(g(r, H.transferredAt)),
      businessDate: isoToDate(createdAt),
      amount: num(g(r, H.amount)),
      shopDiscount: num(g(r, H.shopDiscount)),
      deliveryDiscount: num(g(r, H.deliveryDiscount)),
      netSales: num(g(r, H.netSales)),
      mdr: num(g(r, H.mdr)),
      mdrVat: num(g(r, H.mdrVat)),
      grabFee: num(g(r, H.grabFee)),
      marketingFee: num(g(r, H.marketingFee)),
      commDelivery: num(g(r, H.commDelivery)),
      commPlatform: num(g(r, H.commPlatform)),
      commOrder: num(g(r, H.commOrder)),
      commOther: num(g(r, H.commOther)),
      wht: num(g(r, H.wht)),
      total: num(g(r, H.total)),
      commVat: num(g(r, H.commVat)),
      description: str(g(r, H.description)),
      cancelReason: str(g(r, H.cancelReason)),
      cancelledBy: str(g(r, H.cancelledBy)),
      refundReason: str(g(r, H.refundReason)),
    }
    // identity check on payment rows: amount + discounts + fees + commissions = total
    if (row.category === 'ชำระเงิน') {
      const parts = row.amount + row.shopDiscount + row.deliveryDiscount + row.mdr + row.mdrVat +
        row.grabFee + row.marketingFee + row.commDelivery + row.commPlatform + row.commOrder +
        row.commOther + row.wht
      if (Math.abs(parts - row.total) > 0.01) {
        warnings.push(`แถว ${i + 1} (${row.orderCode}): ยอดรวมไม่ตรงสูตร (${parts.toFixed(2)} ≠ ${row.total.toFixed(2)})`)
      }
    }
    rows.push(row)
  }

  const payoutWs = wb.Sheets[PAYOUT_SHEET]
  if (payoutWs) {
    const paoa: unknown[][] = XLSX.utils.sheet_to_json(payoutWs, { header: 1, raw: true })
    const ph = (paoa[0] ?? []).map(str)
    const pc: Record<string, number> = {}
    ph.forEach((h, i) => { if (!(h in pc)) pc[h] = i })
    for (let i = 1; i < paoa.length; i++) {
      const r = paoa[i]
      if (!r || r[0] == null || r[0] === '') continue
      payouts.push({
        payoutId: str(r[pc['รหัสการจ่ายรายได้']]),
        storeName: str(r[pc['ชื่อร้าน']]),
        grabStoreId: str(r[pc['รหัสร้านค้า']]),
        amount: num(r[pc['ยอดสุทธิ']]),
        transferredAt: parseGrabDate(r[pc['วันที่โอน']]),
        bankStmtRef: str(r[pc['รหัสใบแจ้งยอดธนาคาร']]),
        bankName: str(r[pc['ชื่อธนาคาร']]),
        bankLast4: str(r[pc['ชื่อบัญชี']]),
      })
    }
  } else {
    warnings.push(`ไม่พบชีต "${PAYOUT_SHEET}" ในไฟล์`)
  }

  const dates = rows.map(r => r.businessDate).filter(Boolean).sort()
  const periodStart = dates[0] ?? ''
  const periodEnd = dates[dates.length - 1] ?? ''

  const declared = parseDeclaredPeriod(wb)
  let declaredStart = periodStart
  let declaredEnd = periodEnd
  if (declared) {
    ;[declaredStart, declaredEnd] = declared
  } else {
    warnings.push(`ไม่พบช่วงวันที่ในชีต "${SUMMARY_SHEET}" — ใช้ช่วงวันที่จากรายการแทน (${periodStart} ถึง ${periodEnd})`)
  }
  const outside = rows.filter(r => r.businessDate && (r.businessDate < declaredStart || r.businessDate > declaredEnd))
  if (outside.length) {
    warnings.push(`มี ${outside.length} รายการลงวันที่นอกช่วงรายงาน (${declaredStart} ถึง ${declaredEnd}) — จะบันทึกเพิ่มโดยไม่ลบข้อมูลของวันเหล่านั้น`)
  }

  return {
    rows,
    payouts,
    periodStart,
    periodEnd,
    declaredStart,
    declaredEnd,
    warnings,
  }
}
