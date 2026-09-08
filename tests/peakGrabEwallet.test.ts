import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import {
  buildGrabReceiptLines, buildGrabExpenseLines, mergeReceiptLines,
  peakExpenseWorkbook, peakReceiptWorkbook, buildPeakReceiptLines,
  DEFAULT_GRAB_PEAK_CONFIG,
} from '../src/lib/peakExport'
import type { GrabRow } from '../src/lib/grabParser'
import type { Branch } from '../src/lib/supabase'

// Rama 9 as Point's hand-made sample (PEAK_ImportExpense(1).xlsx / PEAK_ImportReceipt(1).xlsx)
const rama9: Branch = {
  code: 'rama9', name_en: 'Rama 9', name_th: null, grab_store_id: 'store-r9',
  peak_bank_sub: 'BSV004', bank_last4: null, is_active: true, peak_customer: 'C00068',
  peak_class: '00001', tungngern_peak_sub: null, pos_location_id: null,
  ewallet: 'EWL001', grab_contact: 'C00072',
}

const base: GrabRow = {
  storeName: 'Rama 9', grabStoreId: 'store-r9', category: 'ชำระเงิน', subitem: 'การชำระเงิน',
  status: 'โอนเงินสำเร็จแล้ว', txnId: 't1', relatedTxnId: '', orderCode: 'GF-654', longOrderId: 'lo1',
  orderType: 'การจัดส่งอาหาร', paymentMethod: 'บัตรเครดิต', payoutId: 'PO-1',
  grabCreatedAt: '2026-08-17T12:00:00+07:00', transferredAt: null, businessDate: '2026-08-17',
  amount: 0, shopDiscount: 0, deliveryDiscount: 0, netSales: 0, mdr: 0, mdrVat: 0, grabFee: 0,
  marketingFee: 0, commDelivery: 0, commPlatform: 0, commOrder: 0, commOther: 0, wht: 0,
  total: 0, commVat: 0, description: '', cancelReason: '', cancelledBy: '', refundReason: '',
}

// GF-654: gross 327, discount -63, marketing -37.45, platform -39.60, other -11.30 → net 175.65
const gf654: GrabRow = {
  ...base, orderCode: 'GF-654', amount: 327, shopDiscount: -63, netSales: 264,
  marketingFee: -37.45, commPlatform: -39.6, commOther: -11.3, total: 175.65,
}
// GF-834: TCT sale 139 (wallet stream, no deductions) + its GP clawback row -13.39
const gf834sale: GrabRow = {
  ...base, txnId: '', orderCode: 'GF-834', longOrderId: 'lo2', payoutId: '',
  paymentMethod: 'ไทยช่วยไทย', amount: 139, netSales: 139, total: 139,
}
const gf834gp: GrabRow = {
  ...base, category: 'การปรับรายได้', subitem: 'Commission for Govt Campaign x TCT',
  txnId: 't3', orderCode: 'GF-834', longOrderId: '', payoutId: 'PO-1', amount: 0, total: -13.39,
}

describe('buildGrabReceiptLines (ไฟล์รายรับ Grab → E-Wallet, grouped per stream 2026-09-08)', () => {
  it('groups to 2 daily lines per wallet: Grab + Grab ไทยช่วยไทย, ref blank', () => {
    // two normal orders + one TCT order → exactly 2 lines
    const gf2: GrabRow = { ...gf654, txnId: 't2b', orderCode: 'GF-999', longOrderId: 'lo9', amount: 173, total: 120 }
    const { lines, warnings } = buildGrabReceiptLines('2026-08-17', [rama9], [gf654, gf2, gf834sale, gf834gp])
    expect(warnings).toEqual([])
    expect(lines).toHaveLength(2) // adjustment row is NOT revenue; orders collapse per stream
    const [a, b] = lines
    expect(a.description).toBe('Grab')
    expect(a.amount).toBeCloseTo(327 + 173, 2) // summed gross
    expect(a.ref).toBe('')                     // no per-order ref on grouped lines
    expect(a.customer).toBe('C00072')
    expect(a.paidBy).toBe('EWL001')
    expect(a.classGroup).toBe('00001')
    expect(a.docDate).toBe(20260817)
    expect(b.description).toBe('Grab ไทยช่วยไทย')
    expect(b.amount).toBeCloseTo(139, 2)
    expect(b.ref).toBe('')
    expect(lines.map(l => l.seq)).toEqual([1, 2])
    // workbook: D อ้างอิงถึง blank, K = 410101
    const aoa: unknown[][] = XLSX.utils.sheet_to_json(peakReceiptWorkbook(lines).Sheets['Import_Receipt'], { header: 1 })
    expect(aoa[1][3] ?? '').toBe('')
    expect(aoa[1][4]).toBe('C00072')
    expect(aoa[1][10]).toBe('410101')
    expect(aoa[1][13]).toBe(500)
    expect(aoa[1][17]).toBe('EWL001')
  })

  it('warns and skips when branch has no ewallet/contact yet', () => {
    const { lines, warnings } = buildGrabReceiptLines('2026-08-17',
      [{ ...rama9, grab_contact: null }], [gf654])
    expect(lines).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Rama 9')
  })
})

describe('mergeReceiptLines (Point 2026-08-26: ONE receipt file daily)', () => {
  it('POS/Catering + Grab lines merge with continuous ลำดับที่, values untouched', () => {
    const pos = buildPeakReceiptLines('2026-08-17', [rama9], [], [
      { branchCode: 'rama9', name: 'งานเลี้ยง A', netReceiving: 5000 },
    ]).lines
    const grab = buildGrabReceiptLines('2026-08-17', [rama9], [gf654, gf834sale]).lines
    const merged = mergeReceiptLines(pos, grab)
    expect(merged).toHaveLength(3)
    expect(merged.map(l => l.seq)).toEqual([1, 2, 3])
    expect(merged[0].paidBy).toBe('BSV004')       // catering → bank, no ref
    expect(merged[0].ref ?? '').toBe('')
    expect(merged[1].description).toBe('Grab')    // grouped grab line → wallet
    expect(merged[1].paidBy).toBe('EWL001')
    expect(merged[2].amount).toBeCloseTo(139, 2)
    // single workbook holds both kinds of rows
    const aoa: unknown[][] = XLSX.utils.sheet_to_json(peakReceiptWorkbook(merged).Sheets['Import_Receipt'], { header: 1 })
    expect(aoa).toHaveLength(4)
    expect(aoa[1][17]).toBe('BSV004')
    expect(aoa[2][17]).toBe('EWL001')
  })
})

describe('buildGrabExpenseLines (ไฟล์ต้นทุน Grab ← E-Wallet)', () => {
  it('matches Point sample: GF-654 doc of 4 lines totalling 151.35 + GF-834 GP doc of 13.39', () => {
    const { lines, warnings } = buildGrabExpenseLines('2026-08-17', [rama9], [gf654, gf834sale, gf834gp])
    expect(warnings).toEqual([])
    const doc1 = lines.filter(l => l.seq === 1)
    expect(doc1).toHaveLength(4)
    expect(doc1.map(l => [l.description, l.amount])).toEqual([
      ['ส่วนลดออกโดยร้านค้า', 63],
      ['ค่าธรรมเนียมการตลาด', 37.45],
      ['ค่าคอมมิชชั่นแพลตฟอร์ม', 39.6],
      ['ค่าคอมมิชชั่นอื่นของ grab', 11.3],
    ])
    expect(doc1[0].account).toBe('410302')  // ส่วนลด → contra-revenue (chart 2026-08-28)
    expect(doc1[1].account).toBe('520219')  // marketing
    expect(doc1[2].account).toBe('520220')  // platform commission
    expect(doc1[3].account).toBe('520220')  // other commission
    for (const l of doc1) {
      expect(l.ref).toBe('GF-654')
      expect(l.contact).toBe('C00072')
      expect(l.paidBy).toBe('EWL001')
      expect(l.docTotal).toBeCloseTo(151.35, 2)
      expect(l.classGroup).toBe('00001')
    }
    const doc2 = lines.filter(l => l.seq === 2)
    expect(doc2).toHaveLength(1)
    expect(doc2[0].account).toBe('520220')
    expect(doc2[0].description).toBe('ค่าคอมมิชชั่นไทยช่วยไทย')
    expect(doc2[0].amount).toBeCloseTo(13.39, 2)
    expect(doc2[0].docTotal).toBeCloseTo(13.39, 2)
    expect(doc2[0].ref).toBe('GF-834')
    // conservation: revenue − costs = net receiving (175.65 + 139 − 13.39... already inside)
    const rev = 327 + 139
    const costs = lines.reduce((s, l) => s + l.amount, 0)
    expect(rev - costs).toBeCloseTo(175.65 + 139 - 13.39, 2)
  })

  it('ads rows become their own expense docs on the cost account', () => {
    const ads: GrabRow = {
      ...base, category: 'โฆษณา', txnId: 'ad1', orderCode: '', longOrderId: '', payoutId: 'PO-1',
      description: 'Manual Keywords', total: -53.5,
    }
    const { lines } = buildGrabExpenseLines('2026-08-17', [rama9], [ads])
    expect(lines).toHaveLength(1)
    expect(lines[0].description).toBe('โฆษณา Manual Keywords')
    expect(lines[0].account).toBe('520219')
    expect(lines[0].amount).toBeCloseTo(53.5, 2)
    expect(lines[0].ref).toBe('ad1')
  })

  it('refund-labeled อื่นๆ = settlement shift → info only, no booking', () => {
    const shift: GrabRow = {
      ...base, category: 'การปรับรายได้', subitem: 'อื่นๆ', txnId: 't9', orderCode: 'GF-506',
      longOrderId: '', payoutId: 'PO-1', description: 'TH6040 Refund Discount | GF-506', total: 48,
    }
    const { lines, warnings, info } = buildGrabExpenseLines('2026-08-17', [rama9], [gf834sale, shift])
    expect(lines).toHaveLength(0)
    expect(warnings).toEqual([])
    expect(info).toHaveLength(1)
    expect(info[0]).toContain('GF-506')
  })

  it('หักเงินเพื่อชดเชยผู้สั่งซื้อ (ยอดเรียกคืน) books to 410303 — the Park Silom 22/08 case', () => {
    const clawback: GrabRow = {
      ...base, category: 'การปรับรายได้', subitem: 'หักเงินเพื่อชดเชยผู้สั่งซื้อ',
      txnId: 't7', orderCode: 'GF-531', longOrderId: '', payoutId: 'PO-1', amount: -139,
      total: -139, description: 'ยอดเรียกคืน เนื่องจากการร้องเรียนของลูกค้าเมื่อ 21-08-2026*',
    }
    const { lines, warnings } = buildGrabExpenseLines('2026-08-22', [rama9], [clawback])
    expect(warnings).toEqual([])
    expect(lines).toHaveLength(1)
    expect(lines[0].account).toBe('410303')
    expect(lines[0].amount).toBeCloseTo(139, 2)
    expect(lines[0].ref).toBe('GF-531')
    expect(lines[0].description).toContain('ยอดเรียกคืน')
  })

  it('cancelled-order claim: value books as revenue, its commission as 520220 (GF-804 case)', () => {
    const claimValue: GrabRow = {
      ...base, category: 'การปรับรายได้', subitem: 'ชดเชยคำสั่งซื้อที่ถูกยกเลิก',
      txnId: 'c1', orderCode: 'GF-804', longOrderId: '', payoutId: 'PO-1', amount: 0,
      total: 189, description: '[CLAIM] 02-08-2026 Order Value',
    }
    const claimFee: GrabRow = {
      ...base, category: 'การปรับรายได้', subitem: 'ค่าคอมมิชชันจากคำสั่งซื้อที่ถูกยกเลิก (รวมภาษีมูลค่าเพิ่ม)',
      txnId: 'c2', orderCode: 'GF-804', longOrderId: '', payoutId: 'PO-1', amount: 0,
      total: -18.2, description: '[CLAIM] 02-08-2026 Service Fee Incl VAT',
    }
    const rcp = buildGrabReceiptLines('2026-08-04', [rama9], [claimValue, claimFee])
    expect(rcp.warnings).toEqual([])
    expect(rcp.lines).toHaveLength(1)
    expect(rcp.lines[0].amount).toBeCloseTo(189, 2)
    expect(rcp.lines[0].description).toBe('Grab ชดเชยคำสั่งซื้อที่ถูกยกเลิก')
    expect(rcp.lines[0].ref).toBe('GF-804')
    expect(rcp.lines[0].paidBy).toBe('EWL001')
    const exp = buildGrabExpenseLines('2026-08-04', [rama9], [claimValue, claimFee])
    expect(exp.warnings).toEqual([])
    expect(exp.lines).toHaveLength(1)
    expect(exp.lines[0].account).toBe('520220')
    expect(exp.lines[0].amount).toBeCloseTo(18.2, 2)
    expect(exp.lines[0].ref).toBe('GF-804')
    // conservation: 189 in − 18.2 out = 170.80 = what the settlement carries
    expect(rcp.lines[0].amount - exp.lines[0].amount).toBeCloseTo(170.8, 2)
  })

  it('อื่นๆ without refund label: blank adj account → warning; set account → booked', () => {
    const adj: GrabRow = {
      ...base, category: 'การปรับรายได้', subitem: 'อื่นๆ', txnId: 't8', orderCode: '',
      longOrderId: '', payoutId: 'PO-1', description: 'Adjustment', total: 100,
    }
    const blank = buildGrabExpenseLines('2026-08-17', [rama9], [adj])
    expect(blank.lines).toHaveLength(0)
    expect(blank.warnings.some(w => w.includes('grab_adj_account'))).toBe(true)
    const booked = buildGrabExpenseLines('2026-08-17', [rama9], [adj],
      { ...DEFAULT_GRAB_PEAK_CONFIG, adjAccount: '410199' })
    expect(booked.lines).toHaveLength(1)
    expect(booked.lines[0].account).toBe('410199')
    expect(booked.lines[0].amount).toBeCloseTo(-100, 2) // credit → negative expense
  })

  it('warns loudly when WHT appears (no rule yet)', () => {
    const withWht: GrabRow = { ...gf654, wht: -3.27, total: 172.38 }
    const { warnings } = buildGrabExpenseLines('2026-08-17', [rama9], [withWht])
    expect(warnings.some(w => w.includes('หัก ณ ที่จ่าย'))).toBe(true)
  })

  it('cancelled orders are skipped entirely', () => {
    const cancelled: GrabRow = { ...base, category: 'ยกเลิก', amount: 0, total: 0, status: 'ยกเลิก' }
    const rcp = buildGrabReceiptLines('2026-08-17', [rama9], [cancelled])
    const exp = buildGrabExpenseLines('2026-08-17', [rama9], [cancelled])
    expect(rcp.lines).toHaveLength(0)
    expect(exp.lines).toHaveLength(0)
  })

  it('expense workbook matches the Import_Expenses template exactly', () => {
    const { lines } = buildGrabExpenseLines('2026-08-17', [rama9], [gf654, gf834sale, gf834gp])
    const aoa: unknown[][] = XLSX.utils.sheet_to_json(peakExpenseWorkbook(lines).Sheets['Import_Expenses'], { header: 1 })
    expect(aoa[0][0]).toBe('ลำดับที่* ')
    expect(aoa[0][3]).toBe('ผู้รับเงิน/คู่ค้า')
    expect(aoa[0][16]).toBe('ชำระโดย')
    expect(aoa[0][17]).toBe('จำนวนเงินที่ชำระ')
    expect(aoa[0][20]).toBe('กลุ่มจัดประเภท')
    // row 2 = first line of doc 1 (per Point's sample values)
    expect(aoa[1][0]).toBe(1)          // A ลำดับที่
    expect(aoa[1][1]).toBe(20260817)   // B YYYYMMDD
    expect(aoa[1][2]).toBe('GF-654')   // C อ้างอิงถึง
    expect(aoa[1][3]).toBe('C00072')   // D ผู้รับเงิน
    expect(aoa[1][9]).toBe(2)          // J รวมภาษี
    expect(aoa[1][10]).toBe('410302')  // K
    expect(aoa[1][11]).toBe('ส่วนลดออกโดยร้านค้า')
    expect(aoa[1][12]).toBe(1)         // M จำนวน
    expect(aoa[1][13]).toBe(63)        // N
    expect(aoa[1][14]).toBe(0.07)      // O
    expect(aoa[1][16]).toBe('EWL001')  // Q
    expect(aoa[1][17]).toBe(151.35)    // R ยอดเอกสาร
    expect(aoa[1][20]).toBe('00001')   // U
    // GP doc row
    expect(aoa[5][0]).toBe(2)
    expect(aoa[5][13]).toBe(13.39)
    expect(aoa[5][17]).toBe(13.39)
  })
})
