import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { parseGrabWorkbook, parseGrabDate } from '../src/lib/grabParser'

// Synthetic workbook mirroring the GrabMerchant export structure (no real data — public repo)
const TXN_HDR = [
  'ชื่อร้าน', 'Merchant ID', 'ชื่อร้าน', 'รหัสร้านค้า', 'Updated On', 'วันที่สร้าง', 'ประเภท', 'หมวดหมู่',
  'บัญชีรับเงิน / แหล่งที่มาของเงิน', 'รายการย่อย', 'สถานะ', 'Transaction ID', 'รหัสรายการที่เกี่ยวข้อง',
  'รหัสการทำรายการพาร์ทเนอร์ 1', 'รหัสการทำรายการพาร์ทเนอร์ 2', 'รหัสคำสั่งซื้อยาว', 'รหัสคำสั่งซื้อสั้น',
  'รหัสการจอง', 'ช่องทางการสั่งซื้อ', 'ประเภทคำสั่งซื้อ', 'วิธีการชำระเงิน', 'เลขเครื่องทำรายการ', 'ช่องทาง',
  'ประเภทโปรโมชัน', 'ค่าธรรมเนียม Grab (%)', 'ตัวคูณคะแนน', 'คะแนนที่ได้รับ', 'รหัสการทำรายการ', 'วันที่โอน',
  'ยอด', 'ภาษีคำสั่งซื้อ', 'ค่าบรรจุภัณฑ์ร้าน', 'ค่าธรรมเนียมสำหรับผู้ที่ไม่ได้เป็นสมาชิก', 'ค่าบริการของร้าน',
  'โปรโมชัน', 'ส่วนลด (ออกโดยร้าน)', 'ส่วนลดค่าจัดส่ง (ออกโดยร้าน)', 'ค่าจัดส่งโดยร้าน (ร้านค้า Grab ออนไลน์)',
  'ค่าจัดส่งโดยร้าน (ร้านจัดส่งเอง)', 'ค่าบริการจัดส่ง GrabExpress', 'ยอดขายสุทธิ', 'MDR สุทธิ', 'ภาษี MDR',
  'ค่าธรรมเนียม Grab', 'ค่าธรรมเนียมการตลาด', 'ค่าคอมมิชชันการจัดส่ง', 'ค่าคอมมิชชันแพลตฟอร์ม',
  'ค่าคอมมิชชันคำสั่งซื้อ', 'ค่าคอมมิชชันอื่นของ GrabFood / GrabMart', 'GrabKitchen Commission',
  'ค่าคอมมิชชันอื่นของ GrabKitchen', 'ภาษีหัก ณ ที่จ่าย', 'ทั้งหมด', 'ภาษี MDR (%)', 'ค่าคอมมิชชันการจัดส่ง (%)',
  'ค่าคอมมิชชันแพลตฟอร์ม (%)', 'ค่าคอมมิชชันคำสั่งซื้อ (%)',
  'ภาษีค่าคอมมิชชัน, การปรับรายได้, โฆษณา GrabFood / GrabMart', 'ภาษีค่าคอมมิชชัน GrabKitchen ทั้งหมด',
  'สาเหตุที่ยกเลิก', 'ยกเลิกโดย', 'สาเหตุที่คืนเงิน', 'คำอธิบาย', 'กลุ่มเหตุการณ์', 'นามแฝงเหตุการณ์',
  'รายการที่ได้รับผลกระทบ', 'ลิงค์อุทธรณ์', 'สถานะการอุทธรณ์',
]

function txnRow(over: Record<string, unknown>): unknown[] {
  const base: Record<string, unknown> = {
    'ชื่อร้าน': 'Test Co', 'รหัสร้านค้า': 'store-a', 'ประเภท': 'GrabFood',
    'วันที่สร้าง': '11 Aug 2026 1:02 PM',
  }
  const merged = { ...base, ...over }
  const row = TXN_HDR.map(() => '')
  // second ชื่อร้าน (store col, index 2)
  row[2] = (over['__store'] as string) ?? 'Shop - Branch A'
  TXN_HDR.forEach((h, i) => {
    if (i !== 0 && i !== 2 && h in merged) row[i] = merged[h] as never
  })
  row[0] = 'Test Co'
  return row
}

function makeWb(): XLSX.WorkBook {
  const regular = txnRow({
    'หมวดหมู่': 'ชำระเงิน', 'สถานะ': 'โอนแล้ว', 'Transaction ID': 'txn-reg-1',
    'รหัสคำสั่งซื้อสั้น': 'GF-100', 'ประเภทคำสั่งซื้อ': 'Auto-Paid', 'วิธีการชำระเงิน': 'ไม่ใช้เงินสด',
    'รหัสการทำรายการ': 'PAYOUT1', 'วันที่โอน': '12 Aug 2026 4:44 AM',
    'ยอด': 179, 'ส่วนลด (ออกโดยร้าน)': 0, 'ยอดขายสุทธิ': 179,
    'ค่าคอมมิชชันคำสั่งซื้อ': -26.85, 'ทั้งหมด': 152.15,
    'ภาษีค่าคอมมิชชัน, การปรับรายได้, โฆษณา GrabFood / GrabMart': -1.76,
  })
  const tctSale = txnRow({
    'หมวดหมู่': 'ชำระเงิน', 'สถานะ': 'เสร็จสมบูรณ์', 'Transaction ID': 'txn-tct-1',
    'รหัสรายการที่เกี่ยวข้อง': 'txn-adj-1',
    'รหัสคำสั่งซื้อสั้น': 'GF-200', 'ประเภทคำสั่งซื้อ': 'Auto-Paid', 'วิธีการชำระเงิน': 'ไม่ใช้เงินสด',
    'ยอด': 139, 'ส่วนลด (ออกโดยร้าน)': 0, 'ยอดขายสุทธิ': 139, 'ทั้งหมด': 139,
  })
  const tctAdj = txnRow({
    'หมวดหมู่': 'การปรับรายได้', 'รายการย่อย': 'Commission for Govt Campaign (taxable)',
    'สถานะ': 'โอนแล้ว', 'Transaction ID': 'txn-adj-1', 'รหัสคำสั่งซื้อสั้น': 'GF-200',
    'ประเภทคำสั่งซื้อ': 'Manually Paid', 'รหัสการทำรายการ': 'PAYOUT1',
    'วันที่โอน': '12 Aug 2026 4:44 AM', 'ยอด': -13.39, 'ทั้งหมด': -13.39,
  })
  const ads = txnRow({
    'หมวดหมู่': 'โฆษณา', 'สถานะ': 'โอนแล้ว', 'Transaction ID': 'txn-ads-1',
    'ประเภทคำสั่งซื้อ': 'Auto-Paid', 'รหัสการทำรายการ': 'PAYOUT1',
    'วันที่โอน': '12 Aug 2026 4:44 AM', 'ยอด': -107.76, 'ทั้งหมด': -115.32,
    'คำอธิบาย': 'Manual Keywords - 2026-08-11',
  })
  const txnAoa = [TXN_HDR, regular, tctSale, tctAdj, ads]

  const payoutHdr = ['วันที่', 'ชื่อร้าน', 'รหัสร้านค้า', 'รหัสการจ่ายรายได้', 'ยอดสุทธิ', 'สถานะ', 'วันที่โอน', 'รหัสใบแจ้งยอดธนาคาร', 'ชื่อธนาคาร', 'ชื่อบัญชี']
  const payoutAoa = [
    payoutHdr,
    ['12/08/2026 02:48', 'Shop - Branch A', 'store-a', 'PAYOUT1', 23.44, '', '12/08/2026 04:44', 'REF1', 'Kasikornthai', '1234'],
  ]

  const summaryAoa = [
    [], [], [], ['', 'รายงาน GrabMerchant'],
    ['', 'ช่วงวันที่', '11/08/2026 - 11/08/2026'],
  ]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryAoa), 'สรุป')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(txnAoa), 'รายการชำระเงิน')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(payoutAoa), 'การจ่ายรายได้')
  return wb
}

describe('parseGrabDate', () => {
  it('parses grab datetime strings', () => {
    expect(parseGrabDate('11 Aug 2026 1:02 PM')).toBe('2026-08-11T13:02:00+07:00')
    expect(parseGrabDate('12 Aug 2026 4:44 AM')).toBe('2026-08-12T04:44:00+07:00')
    expect(parseGrabDate('12/08/2026 02:48')).toBe('2026-08-12T02:48:00+07:00')
    expect(parseGrabDate('')).toBeNull()
  })
})

describe('parseGrabWorkbook', () => {
  it('classifies rows, parses numbers, derives period, no warnings', () => {
    const p = parseGrabWorkbook(makeWb())
    expect(p.warnings).toEqual([])
    expect(p.rows).toHaveLength(4)
    expect(p.periodStart).toBe('2026-08-11')
    expect(p.periodEnd).toBe('2026-08-11')
    expect(p.declaredStart).toBe('2026-08-11')
    expect(p.declaredEnd).toBe('2026-08-11')

    const reg = p.rows.find(r => r.txnId === 'txn-reg-1')!
    expect(reg.category).toBe('ชำระเงิน')
    expect(reg.payoutId).toBe('PAYOUT1')
    expect(reg.commOrder).toBe(-26.85)
    expect(reg.total).toBe(152.15)
    expect(reg.businessDate).toBe('2026-08-11')

    const tct = p.rows.find(r => r.txnId === 'txn-tct-1')!
    expect(tct.payoutId).toBe('')
    expect(tct.relatedTxnId).toBe('txn-adj-1')

    const adj = p.rows.find(r => r.txnId === 'txn-adj-1')!
    expect(adj.category).toBe('การปรับรายได้')
    expect(adj.total).toBe(-13.39)

    const ads = p.rows.find(r => r.txnId === 'txn-ads-1')!
    expect(ads.category).toBe('โฆษณา')
    expect(ads.description).toContain('Manual Keywords')

    expect(p.payouts).toHaveLength(1)
    expect(p.payouts[0].payoutId).toBe('PAYOUT1')
    expect(p.payouts[0].amount).toBe(23.44)
    expect(p.payouts[0].bankLast4).toBe('1234')
  })

  it('warns when identity does not hold', () => {
    const wb = makeWb()
    const ws = wb.Sheets['รายการชำระเงิน']
    // corrupt the regular order's total (row 2, col ทั้งหมด = index 53 -> BB2? compute addr)
    const totalIdx = TXN_HDR.indexOf('ทั้งหมด')
    const addr = XLSX.utils.encode_cell({ r: 1, c: totalIdx })
    ws[addr] = { t: 'n', v: 999 }
    const p = parseGrabWorkbook(wb)
    expect(p.warnings.some(w => w.includes('GF-100'))).toBe(true)
  })
})

describe('cancelled orders (blank category)', () => {
  it('keeps them as ยกเลิก with zero money, no warning', () => {
    const wb = makeWb()
    const cancelled = txnRow({
      'หมวดหมู่': '', 'สถานะ': 'ยกเลิก', 'ประเภทคำสั่งซื้อ': 'Not Paid',
      'รหัสคำสั่งซื้อสั้น': 'GF-804', 'รหัสคำสั่งซื้อยาว': 'cancel-long-1',
      'ทั้งหมด': 0, 'สาเหตุที่ยกเลิก': 'WAITED_TOO_LONG', 'ยกเลิกโดย': 'ลูกค้า',
    })
    XLSX.utils.sheet_add_aoa(wb.Sheets['รายการชำระเงิน'], [cancelled], { origin: -1 })
    const p = parseGrabWorkbook(wb)
    expect(p.warnings).toEqual([])
    const c = p.rows.find(r => r.orderCode === 'GF-804')!
    expect(c.category).toBe('ยกเลิก')
    expect(c.total).toBe(0)
    expect(c.cancelReason).toBe('WAITED_TOO_LONG')
    expect(c.cancelledBy).toBe('ลูกค้า')
  })

  it('still blocks blank category rows that carry money', () => {
    const wb = makeWb()
    const weird = txnRow({
      'หมวดหมู่': '', 'สถานะ': 'ยกเลิก', 'รหัสคำสั่งซื้อสั้น': 'GF-999',
      'รหัสคำสั่งซื้อยาว': 'cancel-long-2', 'ทั้งหมด': 55,
    })
    XLSX.utils.sheet_add_aoa(wb.Sheets['รายการชำระเงิน'], [weird], { origin: -1 })
    const p = parseGrabWorkbook(wb)
    expect(p.warnings.some(w => w.includes('หมวดหมู่ไม่รู้จัก'))).toBe(true)
  })
})
