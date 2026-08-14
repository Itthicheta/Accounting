import { useEffect, useState } from 'react'
import { sb, fetchAll, bkkToday } from '../lib/supabase'

const THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม']
const WEEKDAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส']

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * Month calendar. Dates that have uploaded grab rows get a green ring.
 * Clicking a date calls onPick(YYYY-MM-DD).
 */
export default function MonthCalendar({ onPick, refreshKey }: {
  onPick: (date: string) => void
  refreshKey: number
}) {
  const today = bkkToday()
  const [year, setYear] = useState(Number(today.slice(0, 4)))
  const [month, setMonth] = useState(Number(today.slice(5, 7))) // 1-12
  const [dataDates, setDataDates] = useState<Set<string>>(new Set())

  const monthStart = `${year}-${pad(month)}-01`
  const daysInMonth = new Date(year, month, 0).getDate()
  const monthEnd = `${year}-${pad(month)}-${pad(daysInMonth)}`
  const firstWeekday = new Date(year, month - 1, 1).getDay() // 0 = Sunday

  useEffect(() => {
    let alive = true
    fetchAll<{ business_date: string }>((f, t) => sb.from('grab_rows')
      .select('business_date')
      .gte('business_date', monthStart).lte('business_date', monthEnd)
      .order('business_date').range(f, t))
      .then(rows => {
        if (alive) setDataDates(new Set(rows.map(r => r.business_date)))
      })
      .catch(() => { /* calendar markers are non-critical */ })
    return () => { alive = false }
  }, [monthStart, monthEnd, refreshKey])

  function shiftMonth(d: number) {
    const m = month + d
    if (m < 1) { setMonth(12); setYear(y => y - 1) }
    else if (m > 12) { setMonth(1); setYear(y => y + 1) }
    else setMonth(m)
  }

  const cells: (number | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]

  return (
    <div className="card" style={{ maxWidth: 340 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <button className="ghost" onClick={() => shiftMonth(-1)} aria-label="เดือนก่อน">‹</button>
        <strong>{THAI_MONTHS[month - 1]} {year}</strong>
        <button className="ghost" onClick={() => shiftMonth(1)} aria-label="เดือนถัดไป">›</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, textAlign: 'center' }}>
        {WEEKDAYS.map(w => <div key={w} className="muted" style={{ fontSize: 11.5, padding: '2px 0' }}>{w}</div>)}
        {cells.map((d, i) => {
          if (d === null) return <div key={`e${i}`} />
          const iso = `${year}-${pad(month)}-${pad(d)}`
          const has = dataDates.has(iso)
          const isToday = iso === today
          return (
            <button
              key={iso}
              onClick={() => onPick(iso)}
              title={has ? `${iso} — มีข้อมูลแล้ว` : iso}
              style={{
                padding: 0, width: 34, height: 34, margin: '0 auto',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 13, cursor: 'pointer', background: 'none',
                border: has ? '2px solid var(--accent)' : '1px solid transparent',
                borderRadius: '50%',
                color: has ? 'var(--accent)' : 'var(--text)',
                fontWeight: has || isToday ? 600 : 400,
                textDecoration: isToday ? 'underline' : 'none',
              }}
            >
              {d}
            </button>
          )
        })}
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
        วงกลมเขียว = วันที่มีข้อมูลในระบบแล้ว · คลิกวันที่เพื่อดูวันนั้น
      </div>
    </div>
  )
}
