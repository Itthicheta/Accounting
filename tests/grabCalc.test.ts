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
      row({ category: 'การปรับรายได้', payoutId: 'P1', amount: -13.39, total: -13.39 }),
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
