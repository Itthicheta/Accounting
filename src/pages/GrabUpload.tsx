import { useState } from 'react'
import * as XLSX from 'xlsx'
import { sb } from '../lib/supabase'
import { parseGrabWorkbook, dedupeKey, type GrabParse, type GrabRow } from '../lib/grabParser'
import { reconByBranch, type BranchRecon } from '../lib/grabCalc'
import { useBranches } from './Shell'
import ReconTable from './ReconTable'

function rowToDb(r: GrabRow, fileId: number, branchCode: string | null) {
  return {
    file_id: fileId,
    dedupe_key: dedupeKey(r),
    branch_code: branchCode,
    store_name: r.storeName,
    grab_store_id: r.grabStoreId,
    category: r.category,
    subitem: r.subitem || null,
    status: r.status || null,
    txn_id: r.txnId,
    related_txn_id: r.relatedTxnId || null,
    order_code: r.orderCode || null,
    long_order_id: r.longOrderId || null,
    order_type: r.orderType || null,
    payment_method: r.paymentMethod || null,
    payout_id: r.payoutId || null,
    grab_created_at: r.grabCreatedAt,
    transferred_at: r.transferredAt,
    business_date: r.businessDate || null,
    amount: r.amount,
    shop_discount: r.shopDiscount,
    delivery_discount: r.deliveryDiscount,
    net_sales: r.netSales,
    mdr: r.mdr, mdr_vat: r.mdrVat, grab_fee: r.grabFee,
    marketing_fee: r.marketingFee,
    comm_delivery: r.commDelivery, comm_platform: r.commPlatform,
    comm_order: r.commOrder, comm_other: r.commOther,
    wht: r.wht, total: r.total, comm_vat: r.commVat,
    description: r.description || null,
    cancel_reason: r.cancelReason || null,
    cancelled_by: r.cancelledBy || null,
    refund_reason: r.refundReason || null,
  }
}

export default function GrabUpload() {
  const branches = useBranches()
  const [parse, setParse] = useState<GrabParse | null>(null)
  const [recon, setRecon] = useState<BranchRecon[]>([])
  const [fileName, setFileName] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string>('')
  const [error, setError] = useState<string>('')

  const byStoreId = new Map(branches.filter(b => b.grab_store_id).map(b => [b.grab_store_id!, b]))
  const branchName = (key: string) => byStoreId.get(key)?.name_en ?? key
  const unknownStores = parse
    ? [...new Set(parse.rows.filter(r => r.grabStoreId && !byStoreId.has(r.grabStoreId)).map(r => r.storeName))]
    : []

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setSaved(''); setError('')
    setFileName(f.name)
    const wb = XLSX.read(await f.arrayBuffer())
    const p = parseGrabWorkbook(wb)
    setParse(p)
    setRecon(p.rows.length ? reconByBranch(p) : [])
  }

  async function save() {
    if (!parse) return
    setSaving(true); setError('')
    try {
      const { data: fileRow, error: fe } = await sb.from('grab_files')
        .insert({ filename: fileName, period_start: parse.periodStart || null, period_end: parse.periodEnd || null, row_count: parse.rows.length })
        .select('id').single()
      if (fe) throw fe
      const fileId = (fileRow as { id: number }).id

      const dbRows = parse.rows.map(r => rowToDb(r, fileId, byStoreId.get(r.grabStoreId)?.code ?? null))
      const { error: re } = await sb.from('grab_rows')
        .upsert(dbRows, { onConflict: 'dedupe_key', ignoreDuplicates: true })
      if (re) throw re

      const dbPayouts = parse.payouts.map(po => ({
        file_id: fileId,
        payout_id: po.payoutId,
        branch_code: byStoreId.get(po.grabStoreId)?.code ?? null,
        grab_store_id: po.grabStoreId,
        amount: po.amount,
        transferred_at: po.transferredAt,
        bank_stmt_ref: po.bankStmtRef || null,
        bank_name: po.bankName || null,
        bank_last4: po.bankLast4 || null,
      }))
      if (dbPayouts.length) {
        const { error: pe } = await sb.from('grab_payouts')
          .upsert(dbPayouts, { onConflict: 'payout_id', ignoreDuplicates: true })
        if (pe) throw pe
      }
      setSaved(`บันทึกแล้ว: ${parse.rows.length} รายการ, ${parse.payouts.length} ยอดโอน (รายการซ้ำถูกข้ามอัตโนมัติ)`)
    } catch (err) {
      setError('บันทึกไม่สำเร็จ: ' + (err as Error).message)
    }
    setSaving(false)
  }

  return (
    <div>
      <h1>Grab — อัปโหลดรายงาน</h1>
      <p className="muted">อัปโหลดไฟล์ GrabMerchant Report (.xlsx) — ระบบจะแยกสาขา ตรวจสูตร และกระทบยอดให้อัตโนมัติ</p>
      <div className="card">
        <input type="file" accept=".xlsx" onChange={onFile} />
        {fileName && <span className="muted" style={{ marginLeft: 10 }}>{fileName}</span>}
      </div>

      {parse && parse.warnings.length > 0 && (
        <div className="banner warn">
          <strong>คำเตือน:</strong>
          <ul style={{ margin: '4px 0 0 18px' }}>{parse.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}
      {unknownStores.length > 0 && (
        <div className="banner bad">ร้านที่ไม่รู้จักในระบบ (ต้องเพิ่ม grab_store_id ใน acc.branches ก่อน): {unknownStores.join(', ')}</div>
      )}

      {parse && recon.length > 0 && (
        <div className="card">
          <h2>ผลกระทบยอด {parse.periodStart}{parse.periodEnd !== parse.periodStart ? ` ถึง ${parse.periodEnd}` : ''}</h2>
          <ReconTable recon={recon} branchName={branchName} />
          <div style={{ marginTop: 14 }}>
            <button className="primary" onClick={save} disabled={saving || unknownStores.length > 0}>
              {saving ? 'กำลังบันทึก…' : 'บันทึกเข้าระบบ'}
            </button>
          </div>
        </div>
      )}
      {saved && <div className="banner ok">{saved}</div>}
      {error && <div className="banner bad">{error}</div>}
    </div>
  )
}
