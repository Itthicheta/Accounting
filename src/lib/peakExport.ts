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
  classGroup: string     // T กลุ่มจัดประเภท
}

export type PeakSourceAmounts = {
  branchCode: string
  grabBank: number       // โอนเข้าธนาคาร (คำนวณ) for the day — may be negative
  grabWallet: number     // เข้าถุงเงิน (TCT) for the day
}

export type CateringLine = { branchCode: string | null; name: string; netReceiving: number }

export const REVENUE_ACCOUNT = '410101'

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
): { lines: PeakReceiptLine[]; warnings: string[] } {
  const lines: PeakReceiptLine[] = []
  const warnings: string[] = []
  const docDate = toDocDate(isoDate)
  const byCode = new Map(branches.map(b => [b.code, b]))
  let seq = 1

  const push = (b: Branch, description: string, amount: number, paidBy: string) => {
    lines.push({
      seq: seq++, docDate,
      customer: b.peak_customer ?? '',
      account: REVENUE_ACCOUNT,
      description,
      amount: Math.round(amount * 100) / 100,
      paidBy,
      classGroup: b.peak_class ?? '',
    })
  }

  for (const g of grab) {
    const b = byCode.get(g.branchCode)
    if (!b) { warnings.push(`ไม่รู้จักสาขา "${g.branchCode}" — ข้ามยอด Grab`); continue }
    if (!b.peak_customer || !b.peak_class) {
      warnings.push(`${b.name_en}: ยังไม่ตั้งค่า peak_customer/peak_class ใน acc.branches — ข้ามยอด Grab`)
      continue
    }
    if (Math.abs(g.grabBank) > 0.005) {
      if (b.peak_bank_sub) push(b, 'Grab', g.grabBank, b.peak_bank_sub)
      else warnings.push(`${b.name_en}: ไม่มีบัญชีธนาคาร (BSV) — ข้ามบรรทัด Grab ${g.grabBank.toFixed(2)}`)
    }
    if (Math.abs(g.grabWallet) > 0.005) {
      const wallet = (b as Branch & { tungngern_peak_sub?: string | null }).tungngern_peak_sub
      if (wallet) push(b, 'Grab ถุงเงิน', g.grabWallet, wallet)
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
    push(b, `Catering: ${c.name}`, c.netReceiving, b.peak_bank_sub)
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
export function peakReceiptWorkbook(lines: PeakReceiptLine[]): XLSX.WorkBook {
  const aoa: unknown[][] = [HEADERS]
  for (const l of lines) {
    aoa.push([
      l.seq, l.docDate, '', '', l.customer,
      '', '', 1, 2,
      '', l.account, l.description, 1, l.amount,
      '', 0.07, '', l.paidBy,
      '', l.classGroup,
    ])
  }
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Import_Receipt')
  return wb
}
