import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { buildPeakReceiptLines, buildPosLines, peakReceiptWorkbook, toDocDate } from '../src/lib/peakExport'
import type { Branch } from '../src/lib/supabase'

const branches: Branch[] = [
  { code: 'gaysorn', name_en: 'Gaysorn Tower', name_th: null, grab_store_id: 'sa', peak_bank_sub: 'BSV002', bank_last4: null, is_active: true, peak_customer: 'C00065', peak_class: '00002', tungngern_peak_sub: null, pos_location_id: 'gaysorn' },
  { code: 'silom', name_en: 'Park Silom', name_th: null, grab_store_id: 'sb', peak_bank_sub: 'BSV003', bank_last4: null, is_active: true, peak_customer: 'C00066', peak_class: '00003', tungngern_peak_sub: 'BSV020', pos_location_id: 'silom' },
]

describe('buildPeakReceiptLines', () => {
  it('builds grab bank + wallet + catering lines with mappings', () => {
    const { lines, warnings } = buildPeakReceiptLines('2026-08-10', branches,
      [
        { branchCode: 'gaysorn', grabBank: 1034.30, grabWallet: 860 },
        { branchCode: 'silom', grabBank: -160.97, grabWallet: 3400 },
      ],
      [{ branchCode: 'silom', name: 'งานเลี้ยง A', netReceiving: 12091 }],
    )
    expect(lines).toHaveLength(4) // gaysorn bank; silom bank(neg) + wallet + catering
    const gb = lines.find(l => l.customer === 'C00065' && l.description === 'Grab โอนเข้าธนาคาร')!
    expect(gb.amount).toBeCloseTo(1034.30, 2)
    expect(gb.paidBy).toBe('BSV002')
    expect(gb.classGroup).toBe('00002')
    expect(gb.docDate).toBe(20260810)
    const sneg = lines.find(l => l.customer === 'C00066' && l.description === 'Grab โอนเข้าธนาคาร')!
    expect(sneg.amount).toBeCloseTo(-160.97, 2) // negative day allowed
    const sw = lines.find(l => l.description === 'Grab ถุงเงิน (TCT)')!
    expect(sw.paidBy).toBe('BSV020')
    expect(sw.amount).toBeCloseTo(3400, 2)
    const cat = lines.find(l => l.description.startsWith('Catering'))!
    expect(cat.amount).toBeCloseTo(12091, 2)
    // gaysorn wallet has no ถุงเงิน account -> warning, no line
    expect(warnings.some(w => w.includes('ถุงเงิน') && w.includes('Gaysorn'))).toBe(true)
    expect(lines.filter(l => l.customer === 'C00065')).toHaveLength(1)
  })

  it('workbook has exact headers and row shape', () => {
    const { lines } = buildPeakReceiptLines('2026-08-10', branches,
      [{ branchCode: 'gaysorn', grabBank: 100, grabWallet: 0 }], [])
    const wb = peakReceiptWorkbook(lines)
    const aoa: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets['Import_Receipt'], { header: 1 })
    expect(aoa[0][0]).toBe('ลำดับที่*')
    expect(aoa[0][17]).toBe('รับชำระโดย')
    expect(aoa[1][0]).toBe(1)          // ลำดับ
    expect(aoa[1][7]).toBe(1)          // ใบกำกับ
    expect(aoa[1][8]).toBe(2)          // ราคารวมภาษี
    expect(aoa[1][10]).toBe('410101')
    expect(aoa[1][13]).toBe(100)
    expect(aoa[1][15]).toBe(0.07)
    expect(aoa[1][17]).toBe('BSV002')
    expect(aoa[1][19]).toBe('00002')
  })

  it('toDocDate', () => expect(toDocDate('2026-08-02')).toBe(20260802))
})

describe('buildPosLines (Point rules 2026-08-15, real gaysorn 13/08 shape)', () => {
  const loc = new Map([['gaysorn', 'gaysorn']])
  const rows = [
    { business_date: '2026-08-13', location_id: 'gaysorn', channel: 'dine_in', method_name: 'ไทยช่วยไทย', method_code: 'thai_chuai_thai', method_group: 'other', bills: 47, amount_thb: 10426.08 },
    { business_date: '2026-08-13', location_id: 'gaysorn', channel: 'take_away', method_name: 'ไทยช่วยไทย', method_code: 'thai_chuai_thai', method_group: 'other', bills: 3, amount_thb: 999.38 },
    { business_date: '2026-08-13', location_id: 'gaysorn', channel: 'delivery', method_name: 'ไทยช่วยไทย', method_code: 'thai_chuai_thai', method_group: 'other', bills: 10, amount_thb: 2213.86 },
    { business_date: '2026-08-13', location_id: 'gaysorn', channel: 'dine_in', method_name: 'เงินโอน', method_code: 'bank_transfer', method_group: 'transfer', bills: 19, amount_thb: 4710.25 },
    { business_date: '2026-08-13', location_id: 'gaysorn', channel: 'take_away', method_name: 'เงินโอน', method_code: 'bank_transfer', method_group: 'transfer', bills: 1, amount_thb: 138.03 },
    { business_date: '2026-08-13', location_id: 'gaysorn', channel: 'dine_in', method_name: 'เงินสด', method_code: 'cash', method_group: 'cash', bills: 2, amount_thb: 1662.78 },
    { business_date: '2026-08-13', location_id: 'gaysorn', channel: 'take_away', method_name: 'เงินสด', method_code: 'cash', method_group: 'cash', bills: 2, amount_thb: 478.29 },
    { business_date: '2026-08-13', location_id: 'gaysorn', channel: 'delivery', method_name: 'Grab', method_code: 'grab', method_group: 'platform', bills: 12, amount_thb: 4714.64 },
    { business_date: '2026-08-13', location_id: 'gaysorn', channel: 'dine_in', method_name: 'พนักงาน', method_code: 'staff_meal', method_group: 'internal', bills: 8, amount_thb: 1136.34 },
  ]

  it('sums dine_in+take_away, excludes internal/grab/delivery, counts grab bills', () => {
    const { posLines, grabPosBills, warnings } = buildPosLines(rows, loc)
    expect(warnings).toEqual([])
    const tct = posLines.find(l => l.methodCode === 'thai_chuai_thai')!
    expect(tct.amount).toBeCloseTo(10426.08 + 999.38, 2)   // delivery TCT excluded
    expect(tct.toWallet).toBe(true)
    const qr = posLines.find(l => l.methodCode === 'bank_transfer')!
    expect(qr.amount).toBeCloseTo(4848.28, 2)
    const cash = posLines.find(l => l.methodCode === 'cash')!
    expect(cash.amount).toBeCloseTo(2141.07, 2)
    expect(posLines.find(l => l.methodCode === 'grab')).toBeUndefined()
    expect(posLines.find(l => l.methodCode === 'staff_meal')).toBeUndefined()
    expect(grabPosBills.get('gaysorn')).toBe(22)           // 12 grab + 10 delivery TCT
  })

  it('grab-method bills under take_away also count as grab-origin (self-pickup)', () => {
    const { posLines, grabPosBills } = buildPosLines([
      { business_date: '2026-08-14', location_id: 'gaysorn', channel: 'take_away', method_name: 'Grab', method_code: 'grab', method_group: 'platform', bills: 3, amount_thb: 743.55 },
    ], loc)
    expect(posLines).toHaveLength(0)
    expect(grabPosBills.get('gaysorn')).toBe(3)
  })

  it('TCT line routes to the wallet account in receipt lines', () => {
    const { posLines } = buildPosLines(rows, loc)
    const gaysorn: Branch = { code: 'gaysorn', name_en: 'Gaysorn Tower', name_th: null, grab_store_id: 'sa', peak_bank_sub: 'BSV002', bank_last4: null, is_active: true, peak_customer: 'C00065', peak_class: '00002', tungngern_peak_sub: 'BSV015', pos_location_id: 'gaysorn' }
    const { lines } = buildPeakReceiptLines('2026-08-13', [gaysorn], [], [], posLines)
    const tct = lines.find(l => l.note === 'ไทยช่วยไทย')!
    expect(tct.paidBy).toBe('BSV015')
    expect(tct.amount).toBeCloseTo(11425.46, 2)
    const qr = lines.find(l => l.note === 'เงินโอน')!
    expect(qr.paidBy).toBe('BSV002')
  })
})
