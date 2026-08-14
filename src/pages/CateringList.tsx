import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { sb } from '../lib/supabase'

type EventRow = {
  id: number
  event_date: string
  name: string
  mode: string
  gross: number | null
  net_receiving: number | null
  bowls_taken: number | null
  bowls_left: number | null
  transport_cost: number | null
  status: string
}

const fmt = (n: number | null) => (n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function CateringList() {
  const [rows, setRows] = useState<EventRow[]>([])

  useEffect(() => {
    sb.from('catering_events').select('*').order('event_date', { ascending: false }).limit(100)
      .then(({ data }) => setRows((data as EventRow[]) ?? []))
  }, [])

  return (
    <div>
      <h1>Catering / Event</h1>
      <p><Link to="/catering/new"><button className="primary">+ บันทึกงานใหม่</button></Link></p>
      <div className="card scroll-x">
        <table className="data">
          <thead>
            <tr><th>วันที่</th><th>ชื่องาน</th><th>ประเภท</th><th>ยอดรับสุทธิ</th><th>สถานะ</th></tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td style={{ textAlign: 'left' }}>{r.event_date}</td>
                <td style={{ textAlign: 'left' }}><Link to={`/catering/${r.id}`}>{r.name}</Link></td>
                <td style={{ textAlign: 'left' }}>{r.mode}</td>
                <td>{fmt(r.net_receiving)}</td>
                <td style={{ textAlign: 'left' }}>
                  {r.status === 'performance_complete'
                    ? <span className="chip ok">ครบทั้ง performance</span>
                    : r.status === 'reconcile_ready'
                      ? <span className="chip warn">รอใส่ต้นทุน</span>
                      : <span className="chip bad">draft</span>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'left' }}>ยังไม่มีงานบันทึกไว้</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
