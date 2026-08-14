export type Menu = { name: string; pricePerBowl: number; bowls: number }
export type StaffCost = { name: string; costPerHr: number; hours: number }

const r2 = (n: number): number => Math.round(n * 100) / 100

export function gross(menus: Menu[]): number {
  return r2(menus.reduce((s, m) => s + (m.pricePerBowl || 0) * (m.bowls || 0), 0))
}

export function bowlsSold(menus: Menu[]): number {
  return menus.reduce((s, m) => s + (m.bowls || 0), 0)
}

/** Event: net = gross − rent (fixed THB or GP % of gross). No VAT. */
export function eventNet(menus: Menu[], rentType: 'fixed' | 'gp', rentValue: number): number {
  const g = gross(menus)
  const rent = rentType === 'gp' ? g * (rentValue || 0) / 100 : (rentValue || 0)
  return r2(g - rent)
}

/** Catering: net = (gross − discount + fee) × 1.07 (VAT 7%). Fee is charged to the customer. */
export function cateringNet(
  menus: Menu[],
  discountType: 'percent' | 'fixed',
  discountValue: number,
  fee: number,
): number {
  const g = gross(menus)
  const disc = discountType === 'percent' ? g * (discountValue || 0) / 100 : (discountValue || 0)
  return r2((g - disc + (fee || 0)) * 1.07)
}

export function staffTotal(staff: StaffCost[]): number {
  return r2(staff.reduce((s, x) => s + (x.costPerHr || 0) * (x.hours || 0), 0))
}

export function netProfit(netReceiving: number, staff: StaffCost[], transport: number): number {
  return r2(netReceiving - staffTotal(staff) - (transport || 0))
}
