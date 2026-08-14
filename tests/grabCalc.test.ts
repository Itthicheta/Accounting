import { describe, it, expect } from 'vitest'
import { reconByBranch, COMPANY, pctOfNetSales } from '../src/lib/grabCalc'
import type { GrabParse, GrabRow } from '../src/lib/grabParser'

function row(over: Partial<GrabRow>): GrabRow {
  return {
    storeName: 'Branch A', grabStoreId: 'store-a', category: 'ชำระเงิน', subitem: '', status: '',
    txnId: Math.random().toString(36).slice(2), relatedTxnId: '', orderCode: '', longOrderId: '',
    orderType: '', paymentMethod: '', payoutId: '', grabCreatedAt: null, transferredAt: null,
    businessDate: '2026-08-11', amount: 0, shopDiscount: 0, deliveryDiscount: 0, netSales: 0,
    mdr: 0, mdrVat: 0, grabFee: 0, marketingFee: 0, commDelivery: 0, commPlatform: 0,
    commOrder: 0, commOther: 0, wht: 0, total: 0, commVat: 0, description: '',
    cancelReason: '', cancelledBy: '', refundReason: '', ...over,
  }
}

function parse(rows: GrabRow[], payouts: GrabParse['payouts'] = []): GrabParse {
  return { rows, payouts, periodStart: '2026-08-11', periodEnd: '2026-08-11', warnings: [] }
}

describe('reconByBranch', () => {
  it('splits streams, sums costs, matches payout, appends company row', () => {
    const p = parse([
      // regular bank order: 179 gross, -26.85 comm → 152.15
      row({ payoutId: 'P1', amount: 179, netSales: 179, commOrder: -26.85, total: 152.15 }),
      // TCT wallet order: 139 all to wallet
      row({ amount: 139, netSales: 139, total: 139 }),
      // TCT commission adjustment: -13.39 from bank payout
      row({ category: 'การปรับรายได้', subitem: 'Commission for Govt Campaign (taxable)', payoutId: 'P1', amount: -13.39, total: -13.39 }),
      // ads manual: -115.32 from bank payout
      row({ category: 'โฆษณา', payoutId: 'P1', amount: -107.76, total: -115.32, description: 'Manual Keywords - 2026-08-11' }),
    ], [{ payoutId: 'P1', storeName: 'Branch A', grabStoreId: 'store-a', amount: 23.44, transferredAt: null, bankStmtRef: '', bankName: '', bankLast4: '1234' }])

    const out = reconByBranch(p)
    expect(out).toHaveLength(2)
    const a = out[0]
    expect(a.store).toBe('Branch A')
    expect(a.bankOrders).toBe(1)
    expect(a.walletOrders).toBe(1)
    expect(a.orderNets).toBeCloseTo(152.15, 2)
    expect(a.tctCommission).toBeCloseTo(-13.39, 2)
    expect(a.adsManual).toBeCloseTo(-115.32, 2)
    expect(a.adsAuto).toBe(0)
    expect(a.bankPayoutCalc).toBeCloseTo(152.15 - 13.39 - 115.32, 2) // 23.44
    expect(a.payoutSheetAmount).toBeCloseTo(23.44, 2)
    expect(a.payoutMatches).toBe(true)
    expect(a.walletReceive).toBeCloseTo(139, 2)
    expect(a.netReceiving).toBeCloseTo(23.44 + 139, 2)
    expect(a.totalNetSales).toBeCloseTo(179 + 139, 2)
    expect(a.totalCosts).toBeCloseTo(26.85 + 13.39 + 115.32, 2)

    const c = out[1]
    expect(c.store).toBe(COMPANY)
    expect(c.netReceiving).toBeCloseTo(a.netReceiving, 2)
  })

  it('flags payout mismatch', () => {
    const p = parse(
      [row({ payoutId: 'P1', amount: 100, netSales: 100, total: 100 })],
      [{ payoutId: 'P1', storeName: 'Branch A', grabStoreId: 'store-a', amount: 90, transferredAt: null, bankStmtRef: '', bankName: '', bankLast4: '' }],
    )
    const out = reconByBranch(p)
    expect(out[0].payoutMatches).toBe(false)
  })

  it('null payout match when no payout sheet', () => {
    const out = reconByBranch(parse([row({ payoutId: 'P1', amount: 100, netSales: 100, total: 100 })]))
    expect(out[0].payoutMatches).toBeNull()
  })

  it('pctOfNetSales formats', () => {
    const out = reconByBranch(parse([row({ payoutId: 'P1', amount: 200, netSales: 200, commPlatform: -30, total: 170 })]))
    expect(pctOfNetSales(out[0].commPlatform, out[0])).toBe('15.0%')
  })
})

describe('adjOther (อื่นๆ income adjustments)', () => {
  it('separates non-TCT adjustments and includes them in bank payout', () => {
    const p = parse([
      row({ payoutId: 'P1', amount: 200, netSales: 200, total: 200 }),
      row({ category: 'การปรับรายได้', subitem: 'อื่นๆ', payoutId: 'P1', amount: 48, total: 48 }),
      row({ category: 'การปรับรายได้', subitem: 'Commission for Govt Campaign (taxable)', payoutId: 'P1', amount: -15.31, total: -15.31 }),
    ])
    const out = reconByBranch(p)
    const b = out[0]
    expect(b.adjOther).toBeCloseTo(48, 2)
    expect(b.tctCommission).toBeCloseTo(-15.31, 2)
    expect(b.bankPayoutCalc).toBeCloseTo(200 + 48 - 15.31, 2)
    expect(b.totalCosts).toBeCloseTo(15.31 - 48, 2)
  })
})

describe('walletShift (อื่นๆ tied to TCT orders)', () => {
  it('moves money from wallet to bank without double counting', () => {
    const p = parse([
      row({ orderCode: 'GF-1', amount: 159, netSales: 159, total: 159 }), // TCT sale
      row({ category: 'การปรับรายได้', subitem: 'อื่นๆ', orderCode: 'GF-1', payoutId: 'P1', amount: 48, total: 48, description: 'TH6040 Refund Discount | GF-1 | 2026-08-10' }),
      row({ payoutId: 'P1', amount: 100, netSales: 100, total: 100 }),    // regular order
    ])
    const b = reconByBranch(p)[0]
    expect(b.walletShift).toBeCloseTo(48, 2)
    expect(b.adjOther).toBeCloseTo(0, 2)
    expect(b.walletReceive).toBeCloseTo(111, 2)          // 159 − 48
    expect(b.bankPayoutCalc).toBeCloseTo(148, 2)         // 100 + 48
    expect(b.netReceiving).toBeCloseTo(259, 2)           // = 159 + 100, no double count
    expect(b.totalNetSales).toBeCloseTo(259, 2)
    expect(b.totalCosts).toBeCloseTo(0, 2)               // a shift is not a cost
  })
})

describe('refund rule edge cases', () => {
  it('refund on a bank-stream order stays adjOther (no wallet to reduce)', () => {
    const p = parse([
      row({ orderCode: 'GF-9', payoutId: 'P1', amount: 100, netSales: 100, total: 100 }), // bank order
      row({ category: 'การปรับรายได้', subitem: 'อื่นๆ', orderCode: 'GF-9', payoutId: 'P1', amount: 30, total: 30, description: 'TH6040 Refund Discount | GF-9 | 2026-08-10' }),
    ])
    const b = reconByBranch(p)[0]
    expect(b.walletShift).toBe(0)
    expect(b.adjOther).toBeCloseTo(30, 2)
    expect(b.walletReceive).toBe(0)
    expect(b.bankPayoutCalc).toBeCloseTo(130, 2)
  })

  it('non-refund อื่นๆ never shifts the wallet, even on a TCT order', () => {
    const p = parse([
      row({ orderCode: 'GF-1', amount: 159, netSales: 159, total: 159 }), // TCT sale
      row({ category: 'การปรับรายได้', subitem: 'อื่นๆ', orderCode: 'GF-1', payoutId: 'P1', amount: 20, total: 20, description: 'Goodwill compensation' }),
    ])
    const b = reconByBranch(p)[0]
    expect(b.walletShift).toBe(0)
    expect(b.adjOther).toBeCloseTo(20, 2)
    expect(b.walletReceive).toBeCloseTo(159, 2)
  })

  it('cross-date refund (TCT order not in this file) still shifts', () => {
    const p = parse([
      row({ category: 'การปรับรายได้', subitem: 'อื่นๆ', orderCode: 'GF-77', payoutId: 'P1', amount: 25, total: 25, description: 'TH6040 Refund Discount | GF-77 | 2026-08-09' }),
    ])
    const b = reconByBranch(p)[0]
    expect(b.walletShift).toBeCloseTo(25, 2)
    expect(b.walletReceive).toBeCloseTo(-25, 2)
  })
})

describe('pending regular orders (no payout id yet)', () => {
  it('classifies by inline deductions, not payout id', () => {
    const p = parse([
      // pending regular order: no payout id BUT has commissions inline
      row({ orderCode: 'GF-822', amount: 238, netSales: 238, commPlatform: -35.7, marketingFee: -71.86, total: 130.44 }),
      // TCT order: no payout id, no deductions
      row({ orderCode: 'GF-052', amount: 208, shopDiscount: -45, netSales: 163, total: 163 }),
    ])
    const b = reconByBranch(p)[0]
    expect(b.bankOrders).toBe(1)
    expect(b.walletOrders).toBe(1)
    expect(b.orderNets).toBeCloseTo(130.44, 2)
    expect(b.walletReceive).toBeCloseTo(163, 2)
  })
})
