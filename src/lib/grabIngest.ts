import { sb } from './supabase'
import { dedupeKey, type GrabParse, type GrabRow } from './grabParser'

export function rowToDb(r: GrabRow, fileId: number, branchCode: string | null) {
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

export type UploadItem = { filename: string; parse: GrabParse }

/**
 * Save parsed Grab files. Same-date data is REPLACED: existing rows within each
 * file's business-date range are deleted first (the file is company-wide, so the
 * range covers all branches). Payouts are upserted by payout_id (new file wins).
 * Files are processed in order — when ranges overlap, the later file wins.
 */
export async function saveGrabUploads(
  items: UploadItem[],
  branchCodeByStoreId: Map<string, string>,
): Promise<{ rows: number; payouts: number }> {
  let rows = 0
  let payouts = 0
  for (const { filename, parse } of items) {
    const { data: fileRow, error: fe } = await sb.from('grab_files')
      .insert({
        filename,
        period_start: parse.periodStart || null,
        period_end: parse.periodEnd || null,
        row_count: parse.rows.length,
      })
      .select('id').single()
    if (fe) throw fe
    const fileId = (fileRow as { id: number }).id

    if (parse.periodStart && parse.periodEnd) {
      const { error: de } = await sb.from('grab_rows').delete()
        .gte('business_date', parse.periodStart)
        .lte('business_date', parse.periodEnd)
      if (de) throw de
    }

    const dbRows = parse.rows.map(r => rowToDb(r, fileId, branchCodeByStoreId.get(r.grabStoreId) ?? null))
    if (dbRows.length) {
      const { error: re } = await sb.from('grab_rows')
        .upsert(dbRows, { onConflict: 'dedupe_key' })
      if (re) throw re
      rows += dbRows.length
    }

    const dbPayouts = parse.payouts.map(po => ({
      file_id: fileId,
      payout_id: po.payoutId,
      branch_code: branchCodeByStoreId.get(po.grabStoreId) ?? null,
      grab_store_id: po.grabStoreId,
      amount: po.amount,
      transferred_at: po.transferredAt,
      bank_stmt_ref: po.bankStmtRef || null,
      bank_name: po.bankName || null,
      bank_last4: po.bankLast4 || null,
    }))
    if (dbPayouts.length) {
      const { error: pe } = await sb.from('grab_payouts')
        .upsert(dbPayouts, { onConflict: 'payout_id' })
      if (pe) throw pe
      payouts += dbPayouts.length
    }
  }
  return { rows, payouts }
}
