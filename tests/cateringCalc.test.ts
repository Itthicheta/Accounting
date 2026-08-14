import { describe, it, expect } from 'vitest'
import { gross, bowlsSold, eventNet, cateringNet, staffTotal, netProfit } from '../src/lib/cateringCalc'
import type { Menu, StaffCost } from '../src/lib/cateringCalc'

const menus: Menu[] = [
  { name: 'คอหมูย่าง', pricePerBowl: 120, bowls: 100 },  // 12,000
  { name: 'ต้มยำ', pricePerBowl: 150, bowls: 40 },        // 6,000
]

describe('cateringCalc', () => {
  it('gross and bowls', () => {
    expect(gross(menus)).toBe(18000)
    expect(bowlsSold(menus)).toBe(140)
  })

  it('event with fixed rent', () => {
    expect(eventNet(menus, 'fixed', 3000)).toBe(15000)
  })

  it('event with gp% rent', () => {
    expect(eventNet(menus, 'gp', 20)).toBe(14400) // 18000 − 3600
  })

  it('catering percent discount + fee + vat', () => {
    // (18000 − 10% + 500) × 1.07 = (16200 + 500) × 1.07 = 17869
    expect(cateringNet(menus, 'percent', 10, 500)).toBe(17869)
  })

  it('catering fixed discount, no fee', () => {
    // (18000 − 1000 + 0) × 1.07 = 18190
    expect(cateringNet(menus, 'fixed', 1000, 0)).toBe(18190)
  })

  it('staff cost and net profit', () => {
    const staff: StaffCost[] = [
      { name: 'A', costPerHr: 60, hours: 8 },   // 480
      { name: 'B', costPerHr: 55, hours: 6 },   // 330
    ]
    expect(staffTotal(staff)).toBe(810)
    expect(netProfit(17869, staff, 1200)).toBe(15859)
  })
})
