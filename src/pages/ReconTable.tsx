import { COMPANY, pctOfNetSales, type BranchRecon } from '../lib/grabCalc'

const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function CostCell({ v, b }: { v: number; b: BranchRecon }) {
  return (
    <td>
      {fmt(v)}
      {v !== 0 && <span className="pct">{pctOfNetSales(v, b)}</span>}
    </td>
  )
}

/** Performance + settlement table: one column per branch + company. */
export default function ReconTable({ recon, branchName }: {
  recon: BranchRecon[]
  branchName: (storeIdOrName: string) => string
}) {
  const cols = recon
  const name = (b: BranchRecon) => b.store === COMPANY ? 'รวมทั้งบริษัท' : branchName(b.grabStoreId || b.store)
  return (
    <div className="scroll-x">
      <table className="data">
        <thead>
          <tr>
            <th></th>
            {cols.map((b, i) => <th key={i}>{name(b)}</th>)}
          </tr>
        </thead>
        <tbody>
          <tr className="section"><td colSpan={cols.length + 1}>Performance — รายได้รวม เทียบต้นทุนทั้งหมด</td></tr>
          <tr><td>ยอดขาย gross (ปกติ + TCT)</td>{cols.map((b, i) => <td key={i}>{fmt(b.totalGross)}</td>)}</tr>
          <tr><td>− ส่วนลดร้านออกเอง</td>{cols.map((b, i) => <td key={i}>{fmt(b.discBank + b.discWallet)}</td>)}</tr>
          <tr className="total"><td>= ยอดขายสุทธิ</td>{cols.map((b, i) => <td key={i}>{fmt(b.totalNetSales)}</td>)}</tr>
          <tr><td>− ค่าคอมมิชชันแพลตฟอร์ม</td>{cols.map((b, i) => <CostCell key={i} v={b.commPlatform} b={b} />)}</tr>
          <tr><td>− ค่าคอมมิชชันคำสั่งซื้อ</td>{cols.map((b, i) => <CostCell key={i} v={b.commOrder} b={b} />)}</tr>
          <tr><td>− ค่าคอมมิชชันอื่น</td>{cols.map((b, i) => <CostCell key={i} v={b.commOther + b.commDelivery} b={b} />)}</tr>
          <tr><td>− ค่าธรรมเนียมการตลาด</td>{cols.map((b, i) => <CostCell key={i} v={b.marketingFee} b={b} />)}</tr>
          <tr><td>− MDR / ค่าธรรมเนียม / WHT</td>{cols.map((b, i) => <CostCell key={i} v={b.mdrTotal + b.wht} b={b} />)}</tr>
          <tr><td>− ค่าคอมมิชชัน TCT</td>{cols.map((b, i) => <CostCell key={i} v={b.tctCommission} b={b} />)}</tr>
          <tr><td>± การปรับรายได้อื่นๆ</td>{cols.map((b, i) => <CostCell key={i} v={b.adjOther} b={b} />)}</tr>
          <tr><td>− โฆษณา manual keywords</td>{cols.map((b, i) => <CostCell key={i} v={b.adsManual} b={b} />)}</tr>
          <tr><td>− โฆษณา automatic keywords</td>{cols.map((b, i) => <CostCell key={i} v={b.adsAuto} b={b} />)}</tr>
          <tr className="total"><td>รวมต้นทุน (% ของยอดขายสุทธิ)</td>{cols.map((b, i) => (
            <td key={i}>{fmt(b.totalCosts)}<span className="pct">{pctOfNetSales(b.totalCosts, b)}</span></td>
          ))}</tr>
          <tr className="total"><td>= ยอดรับสุทธิ</td>{cols.map((b, i) => <td key={i}>{fmt(b.netReceiving)}</td>)}</tr>

          <tr className="section"><td colSpan={cols.length + 1}>Settlement — เงินเข้าที่ไหน</td></tr>
          <tr><td>โอนเข้าธนาคาร {' '}
            </td>{cols.map((b, i) => (
            <td key={i}>
              {fmt(b.bankPayoutCalc)}
              {b.payoutMatches === true && <span className="pct" style={{ color: 'var(--accent)' }}>✓</span>}
              {b.payoutMatches === false && <span className="pct" style={{ color: 'var(--danger)' }}>✗ ไม่ตรง {b.payoutSheetAmount != null ? fmt(b.payoutSheetAmount) : ''}</span>}
            </td>
          ))}</tr>
          <tr><td className="muted">ในยอดธนาคาร: เงิน TCT ที่ย้ายมา (อื่นๆ)</td>{cols.map((b, i) => <td key={i} className="muted">{b.walletShift !== 0 ? fmt(b.walletShift) : '—'}</td>)}</tr>
          <tr><td>เข้าถุงเงิน (TCT หลังหักส่วนที่ย้าย)</td>{cols.map((b, i) => <td key={i}>{fmt(b.walletReceive)}</td>)}</tr>
          <tr className="total"><td>รวมเงินที่จะได้รับ</td>{cols.map((b, i) => <td key={i}>{fmt(b.netReceiving)}</td>)}</tr>
          <tr><td className="muted">จำนวนออเดอร์ (ธนาคาร / ถุงเงิน)</td>{cols.map((b, i) => <td key={i} className="muted">{b.bankOrders} / {b.walletOrders}</td>)}</tr>
        </tbody>
      </table>
      {cols.some(b => b.payoutMatches === false) && (
        <p className="muted" style={{ marginTop: 8 }}>
          ✗ = ผลรวมแถวในช่วงนี้ไม่เท่ายอดโอนจริงของ Grab — รอบโอนหนึ่งอาจรวมรายการจากวันอื่น
          (อัปโหลดไฟล์วันก่อน/หลังเพิ่มเพื่อให้ครบรอบโอน) ยอดที่เข้าธนาคารจริงคือตัวเลขหลัง ✗
        </p>
      )}
      {cols.some(b => b.walletShift !== 0) && (
        <p className="muted" style={{ marginTop: 4 }}>
          การปรับรายได้ "อื่นๆ" ที่อ้างถึงออเดอร์ TCT = เงินของออเดอร์นั้นที่ Grab จ่ายผ่านรอบโอนธนาคาร
          แทนถุงเงิน — ระบบย้ายยอดนี้ออกจากถุงเงินให้แล้ว (ไม่ใช่รายได้เพิ่มและไม่ใช่ต้นทุน)
        </p>
      )}
    </div>
  )
}
