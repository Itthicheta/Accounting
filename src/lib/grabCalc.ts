import type { GrabParse, GrabRow } from './grabParser'

export type BranchRecon = {
  store: string
  grabStoreId: string
  bankOrders: number
  walletOrders: number
  grossBank: number
  discBank: number
  netSalesBank: number
  commPlatform: number
  commOrder: number
  commDelivery: number
  commOther: number
  marketingFee: number
  mdrTotal: number
  wht: number
  orderNets: number
  tctCommission: number
  adjOther: number
  walletShift: number
  adsManual: number
  adsAuto: number
  adsTotal: number
  bankPayoutCalc: number
  payoutSheetAmount: number | null
  payoutMatches: boolean | null
  grossWallet: number
  discWallet: number
  walletReceive: number
  totalGross: number
  totalNetSales: number
  totalCosts: number
  netReceiving: number
}

export const COMPANY = '__company__'

function blank(store: string, grabStoreId: string): BranchRecon {
  return {
    store, grabStoreId,
    bankOrders: 0, walletOrders: 0,
    grossBank: 0, discBank: 0, netSalesBank: 0,
    commPlatform: 0, commOrder: 0, commDelivery: 0, commOther: 0,
    marketingFee: 0, mdrTotal: 0, wht: 0, orderNets: 0,
    tctCommission: 0, adjOther: 0, walletShift: 0, adsManual: 0, adsAuto: 0, adsTotal: 0,
    bankPayoutCalc: 0, payoutSheetAmount: null, payoutMatches: null,
    grossWallet: 0, discWallet: 0, walletReceive: 0,
    totalGross: 0, totalNetSales: 0, totalCosts: 0, netReceiving: 0,
  }
}

/**
 * Bank-stream sale = has a payout id OR carries inline deductions (a pending regular
 * order awaiting payout assignment still shows its commissions inline). TCT/wallet
 * sales never have inline deductions.
 */
export function isBankSale(r: GrabRow): boolean {
  if (r.payoutId) return true
  const ded = r.mdr + r.mdrVat + r.grabFee + r.marketingFee +
    r.commDelivery + r.commPlatform + r.commOrder + r.commOther + r.wht
  return Math.abs(ded) > 0.001
}

function addRow(b: BranchRecon, r: GrabRow, tctCodes: Set<string>, bankCodes: Set<string>): void {
  if (r.category === 'ชำระเงิน') {
    const disc = r.shopDiscount + r.deliveryDiscount
    if (isBankSale(r)) {
      b.bankOrders += 1
      b.grossBank += r.amount
      b.discBank += disc
      b.netSalesBank += r.netSales
      b.commPlatform += r.commPlatform
      b.commOrder += r.commOrder
      b.commDelivery += r.commDelivery
      b.commOther += r.commOther
      b.marketingFee += r.marketingFee
      b.mdrTotal += r.mdr + r.mdrVat + r.grabFee
      b.wht += r.wht
      b.orderNets += r.total
    } else {
      b.walletOrders += 1
      b.grossWallet += r.amount
      b.discWallet += disc
      b.walletReceive += r.total
    }
  } else if (r.category === 'การปรับรายได้') {
    if (r.subitem.startsWith('Commission for Govt Campaign')) {
      b.tctCommission += r.total
    } else if (/refund/i.test(r.description) && !(r.orderCode && bankCodes.has(r.orderCode))) {
      // Point's rule (2026-08-14): อื่นๆ whose คำอธิบาย says "Refund" is paid via the
      // bank payout INSTEAD of ถุงเงิน — a stream shift, not income and not a cost.
      // (If the refund references a bank-stream order there is no wallet to reduce,
      // so it falls through to adjOther below.)
      b.walletShift += r.total
    } else {
      b.adjOther += r.total
    }
  } else if (r.category === 'โฆษณา') {
    if (r.description.startsWith('Manual')) b.adsManual += r.total
    else if (r.description.startsWith('Automatic')) b.adsAuto += r.total
    else b.adsAuto += r.total
    b.adsTotal += r.total
  }
}

function finalize(b: BranchRecon, payoutTotal: number | null): void {
  b.bankPayoutCalc = b.orderNets + b.tctCommission + b.adjOther + b.walletShift + b.adsTotal
  b.walletReceive -= b.walletShift
  b.payoutSheetAmount = payoutTotal
  b.payoutMatches = payoutTotal == null ? null : Math.abs(b.bankPayoutCalc - payoutTotal) <= 0.01
  b.totalGross = b.grossBank + b.grossWallet
  // performance uses true net sales (pre-shift): wallet net sales = gross + discounts
  b.totalNetSales = b.netSalesBank + b.grossWallet + b.discWallet
  // deduction columns are negative in the source; report total costs as a positive magnitude
  // (adjOther is usually a credit, so it reduces total costs)
  b.totalCosts = -(b.commPlatform + b.commOrder + b.commDelivery + b.commOther +
    b.marketingFee + b.mdrTotal + b.wht + b.tctCommission + b.adjOther + b.adsTotal)
  b.netReceiving = b.bankPayoutCalc + b.walletReceive
}

/** Aggregate parsed grab rows per store; company row (store = COMPANY) appended last. */
export function reconByBranch(p: GrabParse): BranchRecon[] {
  const byStore = new Map<string, BranchRecon>()
  // first pass: classify order codes per store (TCT/wallet vs bank sales)
  const tctCodesByStore = new Map<string, Set<string>>()
  const bankCodesByStore = new Map<string, Set<string>>()
  for (const r of p.rows) {
    if (r.category === 'ชำระเงิน' && r.orderCode) {
      const key = r.grabStoreId || r.storeName
      const m = isBankSale(r) ? bankCodesByStore : tctCodesByStore
      if (!m.has(key)) m.set(key, new Set())
      m.get(key)!.add(r.orderCode)
    }
  }
  for (const r of p.rows) {
    const key = r.grabStoreId || r.storeName
    if (!byStore.has(key)) byStore.set(key, blank(r.storeName, r.grabStoreId))
    addRow(byStore.get(key)!, r, tctCodesByStore.get(key) ?? new Set(), bankCodesByStore.get(key) ?? new Set())
  }
  const payoutByStore = new Map<string, number>()
  for (const po of p.payouts) {
    const key = po.grabStoreId || po.storeName
    payoutByStore.set(key, (payoutByStore.get(key) ?? 0) + po.amount)
  }
  const out: BranchRecon[] = []
  const company = blank(COMPANY, '')
  let companyPayout = 0
  let havePayouts = p.payouts.length > 0
  for (const [key, b] of byStore) {
    finalize(b, payoutByStore.has(key) ? payoutByStore.get(key)! : (havePayouts ? 0 : null))
    out.push(b)
  }
  for (const b of out) {
    company.bankOrders += b.bankOrders; company.walletOrders += b.walletOrders
    company.grossBank += b.grossBank; company.discBank += b.discBank; company.netSalesBank += b.netSalesBank
    company.commPlatform += b.commPlatform; company.commOrder += b.commOrder
    company.commDelivery += b.commDelivery; company.commOther += b.commOther
    company.marketingFee += b.marketingFee; company.mdrTotal += b.mdrTotal; company.wht += b.wht
    company.orderNets += b.orderNets; company.tctCommission += b.tctCommission
    company.adjOther += b.adjOther; company.walletShift += b.walletShift
    company.adsManual += b.adsManual; company.adsAuto += b.adsAuto; company.adsTotal += b.adsTotal
    company.grossWallet += b.grossWallet; company.discWallet += b.discWallet; company.walletReceive += b.walletReceive
    companyPayout += b.payoutSheetAmount ?? 0
  }
  company.walletReceive += company.walletShift // finalize subtracts it again
  finalize(company, havePayouts ? companyPayout : null)
  out.sort((a, z) => a.store.localeCompare(z.store))
  out.push(company)
  return out
}

/** percentage of net sales, formatted for display */
export function pctOfNetSales(value: number, b: BranchRecon): string {
  if (!b.totalNetSales) return '—'
  return `${(Math.abs(value) / b.totalNetSales * 100).toFixed(1)}%`
}
