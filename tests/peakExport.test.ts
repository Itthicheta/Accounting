import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { buildPeakReceiptLines, peakReceiptWorkbook, toDocDate } from '../src/lib/peakExport'
import type { Branch } from '../src/lib/supabase'

const branches: Branch[] = [
  { code: 'gaysorn', name_en: 'Gaysorn Tower', name_th: null, grab_store_id: 'sa', peak_bank_sub: 'BSV002', bank_last4: null, is_active: true, peak_customer: 'C00065', peak_class: '00002', tungngern_peak_sub: null },
  { code: 'silom', name_en: 'Park Silom', name_th: null, grab_store_id: 'sb', peak_bank_sub: 'BSV003', bank_last4: null, is_active: true, peak_customer: 'C00066', peak_class: '00003', tungngern_peak_sub: 'BSV020' },
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
    const gb = lines.find(l => l.customer === 'C00065' && l.description === 'Grab')!
    expect(gb.amount).toBeCloseTo(1034.30, 2)
    expect(gb.paidBy).toBe('BSV002')
    expect(gb.classGroup).toBe('00002')
    expect(gb.docDate).toBe(20260810)
    const sneg = lines.find(l => l.customer === 'C00066' && l.description === 'Grab')!
    expect(sneg.amount).toBeCloseTo(-160.97, 2) // negative day allowed
    const sw = lines.find(l => l.description === 'Grab ถุงเงิน')!
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
