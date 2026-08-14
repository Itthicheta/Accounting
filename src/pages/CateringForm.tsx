import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { sb, bkkToday } from '../lib/supabase'
import {
  gross, bowlsSold, eventNet, cateringNet, staffTotal, netProfit,
  type Menu, type StaffCost,
} from '../lib/cateringCalc'
import { useBranches } from './Shell'

const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const emptyMenus = (): Menu[] => Array.from({ length: 5 }, () => ({ name: '', pricePerBowl: 0, bowls: 0 }))
const emptyStaff = (): StaffCost[] => Array.from({ length: 5 }, () => ({ name: '', costPerHr: 0, hours: 0 }))

export default function CateringForm() {
  const { id } = useParams()
  const nav = useNavigate()
  const branches = useBranches()

  const [eventDate, setEventDate] = useState(bkkToday())
  const [name, setName] = useState('')
  const [branchCode, setBranchCode] = useState('')
  const [mode, setMode] = useState<'catering' | 'event'>('catering')
  const [menus, setMenus] = useState<Menu[]>(emptyMenus())
  const [rentType, setRentType] = useState<'fixed' | 'gp'>('fixed')
  const [rentValue, setRentValue] = useState(0)
  const [discountType, setDiscountType] = useState<'percent' | 'fixed'>('percent')
  const [discountValue, setDiscountValue] = useState(0)
  const [cateringFee, setCateringFee] = useState(0)
  const [staff, setStaff] = useState<StaffCost[]>(emptyStaff())
  const [transport, setTransport] = useState(0)
  const [bowlsTaken, setBowlsTaken] = useState(0)
  const [bowlsLeft, setBowlsLeft] = useState(0)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')

  useEffect(() => {
    if (!id) return
    sb.from('catering_events').select('*, catering_menus(*), catering_staff(*)').eq('id', id).single()
      .then(({ data }) => {
        if (!data) return
        const d = data as Record<string, unknown> & { catering_menus: Record<string, unknown>[]; catering_staff: Record<string, unknown>[] }
        setEventDate(d.event_date as string)
        setName(d.name as string)
        setBranchCode((d.branch_code as string) ?? '')
        setMode(d.mode as 'catering' | 'event')
        setRentType(((d.rent_type as string) ?? 'fixed') as 'fixed' | 'gp')
        setRentValue(Number(d.rent_value ?? 0))
        setDiscountType(((d.discount_type as string) ?? 'percent') as 'percent' | 'fixed')
        setDiscountValue(Number(d.discount_value ?? 0))
        setCateringFee(Number(d.catering_fee ?? 0))
        setTransport(Number(d.transport_cost ?? 0))
        setBowlsTaken(Number(d.bowls_taken ?? 0))
        setBowlsLeft(Number(d.bowls_left ?? 0))
        const ms = d.catering_menus.map(m => ({ name: (m.name as string) ?? '', pricePerBowl: Number(m.price_per_bowl ?? 0), bowls: Number(m.bowls ?? 0) }))
        setMenus([...ms, ...emptyMenus()].slice(0, 5))
        const ss = d.catering_staff.map(s => ({ name: (s.name as string) ?? '', costPerHr: Number(s.cost_per_hr ?? 0), hours: Number(s.hours ?? 0) }))
        setStaff([...ss, ...emptyStaff()].slice(0, 5))
      })
  }, [id])

  const g = gross(menus)
  const net = mode === 'event'
    ? eventNet(menus, rentType, rentValue)
    : cateringNet(menus, discountType, discountValue, cateringFee)
  const sold = bowlsSold(menus)
  const used = bowlsTaken - bowlsLeft
  const bowlsOk = bowlsTaken === 0 && bowlsLeft === 0 ? null : used === sold
  const staffCost = staffTotal(staff)
  const hasCosts = staffCost > 0 || transport > 0
  const profit = netProfit(net, staff, transport)

  function setMenu(i: number, patch: Partial<Menu>) {
    setMenus(ms => ms.map((m, j) => j === i ? { ...m, ...patch } : m))
  }
  function setStaffRow(i: number, patch: Partial<StaffCost>) {
    setStaff(ss => ss.map((s, j) => j === i ? { ...s, ...patch } : s))
  }

  async function save() {
    setBusy(true); setErr(''); setMsg('')
    try {
      if (!name.trim()) throw new Error('กรุณาใส่ชื่องาน')
      const status = hasCosts ? 'performance_complete' : 'reconcile_ready'
      const record = {
        event_date: eventDate, name: name.trim(), mode,
        branch_code: branchCode || null,
        rent_type: mode === 'event' ? rentType : null,
        rent_value: mode === 'event' ? rentValue : null,
        discount_type: mode === 'catering' ? discountType : null,
        discount_value: mode === 'catering' ? discountValue : null,
        catering_fee: mode === 'catering' ? cateringFee : null,
        gross: g, net_receiving: net,
        bowls_taken: bowlsTaken || null, bowls_left: bowlsLeft || null,
        transport_cost: transport || null,
        status, updated_at: new Date().toISOString(),
      }
      let eventId: number
      if (id) {
        const { error } = await sb.from('catering_events').update(record).eq('id', id)
        if (error) throw error
        eventId = Number(id)
        await sb.from('catering_menus').delete().eq('event_id', eventId)
        await sb.from('catering_staff').delete().eq('event_id', eventId)
      } else {
        const { data, error } = await sb.from('catering_events').insert(record).select('id').single()
        if (error) throw error
        eventId = (data as { id: number }).id
      }
      const menuRows = menus.filter(m => m.name.trim() || m.bowls > 0)
        .map(m => ({ event_id: eventId, name: m.name, price_per_bowl: m.pricePerBowl, bowls: m.bowls }))
      if (menuRows.length) {
        const { error } = await sb.from('catering_menus').insert(menuRows)
        if (error) throw error
      }
      const staffRows = staff.filter(s => s.name.trim() || (s.costPerHr > 0 && s.hours > 0))
        .map(s => ({ event_id: eventId, name: s.name, cost_per_hr: s.costPerHr, hours: s.hours }))
      if (staffRows.length) {
        const { error } = await sb.from('catering_staff').insert(staffRows)
        if (error) throw error
      }
      if (bowlsOk === false) {
        await sb.from('mismatch_log').insert({
          branch_code: branchCode || null, business_date: eventDate, type: 'bowls_diff',
          order_code: name.trim(), amount: (used - sold),
          note: `bowls used ${used} vs sold ${sold} (${name.trim()})`,
        })
      }
      setMsg('บันทึกแล้ว — สถานะ: ' + (hasCosts ? 'ครบทั้ง performance' : 'พร้อมกระทบยอด (ยังไม่ใส่ต้นทุน)'))
      if (!id) nav('/catering')
    } catch (e) {
      setErr((e as Error).message)
    }
    setBusy(false)
  }

  return (
    <div>
      <h1>{id ? 'แก้ไข' : 'บันทึก'} Catering / Event</h1>

      <div className="card">
        <h2>1. ข้อมูลงาน</h2>
        <div className="row">
          <div><label>วันที่จัดงาน</label><input type="date" value={eventDate} onChange={e => setEventDate(e.target.value)} /></div>
          <div style={{ flex: 1 }}><label>ชื่องาน / ลูกค้า</label><input style={{ width: '100%' }} value={name} onChange={e => setName(e.target.value)} placeholder="เช่น งานเลี้ยงบริษัท A" /></div>
          <div><label>สาขาที่รับผิดชอบ (ถ้ามี)</label>
            <select value={branchCode} onChange={e => setBranchCode(e.target.value)}>
              <option value="">— ไม่ระบุ —</option>
              {branches.map(b => <option key={b.code} value={b.code}>{b.name_en}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>2. เมนูที่ขาย</h2>
        <div className="row" style={{ marginBottom: 12 }}>
          <button className={mode === 'catering' ? 'primary' : ''} onClick={() => setMode('catering')}>Catering</button>
          <button className={mode === 'event' ? 'primary' : ''} onClick={() => setMode('event')}>Event</button>
        </div>
        <div className="menu-grid muted" style={{ marginBottom: 2 }}>
          <div>เมนู</div><div>ราคา/ชาม</div><div>จำนวนชาม</div>
        </div>
        {menus.map((m, i) => (
          <div className="menu-grid" key={i}>
            <input value={m.name} onChange={e => setMenu(i, { name: e.target.value })} placeholder={`เมนูที่ ${i + 1}`} />
            <input type="number" min="0" value={m.pricePerBowl || ''} onChange={e => setMenu(i, { pricePerBowl: +e.target.value })} />
            <input type="number" min="0" value={m.bowls || ''} onChange={e => setMenu(i, { bowls: +e.target.value })} />
          </div>
        ))}
        {mode === 'event' ? (
          <div className="row" style={{ marginTop: 10 }}>
            <div><label>ค่าเช่าที่ (rent)</label>
              <select value={rentType} onChange={e => setRentType(e.target.value as 'fixed' | 'gp')}>
                <option value="fixed">เหมาจ่าย (บาท)</option>
                <option value="gp">GP (%)</option>
              </select>
            </div>
            <div><label>{rentType === 'gp' ? 'GP %' : 'จำนวนเงิน'}</label>
              <input type="number" min="0" value={rentValue || ''} onChange={e => setRentValue(+e.target.value)} /></div>
          </div>
        ) : (
          <div className="row" style={{ marginTop: 10 }}>
            <div><label>ส่วนลด</label>
              <select value={discountType} onChange={e => setDiscountType(e.target.value as 'percent' | 'fixed')}>
                <option value="percent">%</option>
                <option value="fixed">บาท</option>
              </select>
            </div>
            <div><label>{discountType === 'percent' ? 'ส่วนลด %' : 'ส่วนลด บาท'}</label>
              <input type="number" min="0" value={discountValue || ''} onChange={e => setDiscountValue(+e.target.value)} /></div>
            <div><label>Catering fee (เก็บลูกค้าเพิ่ม)</label>
              <input type="number" min="0" value={cateringFee || ''} onChange={e => setCateringFee(+e.target.value)} /></div>
          </div>
        )}
        <div className="kpis">
          <div className="kpi"><div className="v">{fmt(g)}</div><div className="l">ยอดขายรวม (gross)</div></div>
          {mode === 'catering' && <div className="kpi"><div className="v">+7%</div><div className="l">VAT</div></div>}
          <div className="kpi"><div className="v">{fmt(net)}</div><div className="l">ยอดรับสุทธิ (net receiving)</div></div>
          <div className="kpi"><div className="v">{sold}</div><div className="l">ชามที่ขาย</div></div>
        </div>
      </div>

      <div className="card">
        <h2>3. ต้นทุน (ใส่ทีหลังได้ — ใช้ดูกำไร ไม่กระทบยอดรับ)</h2>
        <div className="staff-grid muted" style={{ marginBottom: 2 }}>
          <div>พนักงาน</div><div>ค่าแรง/ชม.</div><div>จำนวน ชม.</div>
        </div>
        {staff.map((s, i) => (
          <div className="staff-grid" key={i}>
            <input value={s.name} onChange={e => setStaffRow(i, { name: e.target.value })} placeholder={`คนที่ ${i + 1}`} />
            <input type="number" min="0" value={s.costPerHr || ''} onChange={e => setStaffRow(i, { costPerHr: +e.target.value })} />
            <input type="number" min="0" value={s.hours || ''} onChange={e => setStaffRow(i, { hours: +e.target.value })} />
          </div>
        ))}
        <div className="row" style={{ marginTop: 8 }}>
          <div><label>ค่าเดินทาง/ขนส่ง</label><input type="number" min="0" value={transport || ''} onChange={e => setTransport(+e.target.value)} /></div>
        </div>
        {hasCosts && (
          <div className="kpis">
            <div className="kpi"><div className="v">{fmt(staffCost + transport)}</div><div className="l">ต้นทุนรวม</div></div>
            <div className="kpi"><div className="v">{fmt(profit)}</div><div className="l">กำไรสุทธิ (net profit)</div></div>
          </div>
        )}
      </div>

      <div className="card">
        <h2>4. กระทบยอดชาม</h2>
        <div className="row">
          <div><label>ชามที่เอาไป</label><input type="number" min="0" value={bowlsTaken || ''} onChange={e => setBowlsTaken(+e.target.value)} /></div>
          <div><label>ชามที่เหลือกลับ</label><input type="number" min="0" value={bowlsLeft || ''} onChange={e => setBowlsLeft(+e.target.value)} /></div>
          <div className="kpi"><div className="v">{used}</div><div className="l">ใช้ไป (เทียบกับขาย {sold})</div></div>
        </div>
        {bowlsOk === false && <div className="banner warn">ชามไม่ตรง: ใช้ไป {used} แต่ขาย {sold} — บันทึกได้ แต่ระบบจะเก็บลง mismatch log</div>}
        {bowlsOk === true && <div className="banner ok">ชามตรงกับยอดขาย ✓</div>}
      </div>

      {err && <div className="banner bad">{err}</div>}
      {msg && <div className="banner ok">{msg}</div>}
      <button className="primary" onClick={save} disabled={busy}>{busy ? 'กำลังบันทึก…' : 'บันทึก'}</button>
    </div>
  )
}
