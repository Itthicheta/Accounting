import { Link } from 'react-router-dom'
import { useBranches } from './Shell'

export default function Home() {
  const branches = useBranches()
  return (
    <div>
      <h1>หน้าหลัก</h1>
      <p className="muted">ระบบบัญชีรายรับ — เวอร์ชันทดลอง (Grab + Catering ใช้งานได้)</p>
      <div className="card">
        <h2>โมดูลที่พร้อมใช้</h2>
        <p><Link to="/grab/upload">อัปโหลดรายงาน Grab</Link> — ตรวจกระทบยอดต่อสาขา และบันทึกเข้าระบบ</p>
        <p><Link to="/grab">Grab dashboard</Link> — ดูรายได้ ต้นทุน (% ของยอดขาย) และยอดโอนแยกช่องทาง</p>
        <p><Link to="/catering/new">บันทึก Catering / Event</Link> — กรอกยอดขายงานนอกสถานที่</p>
      </div>
      <div className="card">
        <h2>สาขา ({branches.length})</h2>
        {branches.map(b => (
          <div key={b.code} className="muted">
            {b.name_en}{b.peak_bank_sub ? ` — ${b.peak_bank_sub}` : ' — (ยังไม่ตั้งค่าบัญชีธนาคาร)'}
          </div>
        ))}
      </div>
    </div>
  )
}
