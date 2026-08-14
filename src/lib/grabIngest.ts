import { sb } from './supabase'
import { dedupeKey, type GrabCategory, type GrabParse, type GrabRow } from './grabParser'

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
 * Save parsed Grab files atomically via the acc.replace_grab_file RPC.
 * Per file, in ONE transaction server-side: rows within the file's DECLARED
 * report period are replaced; rows dated outside it are upserted without
 * deleting those days; payouts are upserted and orphaned payouts removed.
 * A failure anywhere rolls the whole file back — nothing is lost.
 * Files are processed in order — when periods overlap, the later file wins.
 */
export async function saveGrabUploads(
  items: UploadItem[],
  branchCodeByStoreId: Map<string, string>,
): Promise<{ rows: number; payouts: number; duplicatesDropped: number }> {
  let rows = 0
  let payouts = 0
  let duplicatesDropped = 0
  for (const { filename, parse } of items) {
    // intra-file dedupe: identical dedupe keys would abort the insert (error 21000);
    // keep the last occurrence and count what was dropped
    const byKey = new Map<string, ReturnType<typeof rowToDb>>()
    for (const r of parse.rows) {
      const db = rowToDb(r, 0, branchCodeByStoreId.get(r.grabStoreId) ?? null)
      byKey.set(db.dedupe_key, db)
    }
    duplicatesDropped += parse.rows.length - byKey.size
    const dbRows = [...byKey.values()].map(({ file_id: _omit, ...rest }) => rest)

    const dbPayouts = parse.payouts.map(po => ({
      payout_id: po.payoutId,
      branch_code: branchCodeByStoreId.get(po.grabStoreId) ?? null,
      grab_store_id: po.grabStoreId,
      amount: po.amount,
      transferred_at: po.transferredAt,
      bank_stmt_ref: po.bankStmtRef || null,
      bank_name: po.bankName || null,
      bank_last4: po.bankLast4 || null,
    }))

    const { data, error } = await sb.rpc('replace_grab_file', {
      p_filename: filename,
      p_period_start: parse.declaredStart || parse.periodStart || null,
      p_period_end: parse.declaredEnd || parse.periodEnd || null,
      p_rows: dbRows,
      p_payouts: dbPayouts,
    })
    if (error) throw error
    const res = data as { inserted: number; payouts: number }
    rows += res.inserted ?? dbRows.length
    payouts += res.payouts ?? dbPayouts.length
  }
  return { rows, payouts, duplicatesDropped }
}

export function dbToGrabRow(r: Record<string, unknown>): GrabRow {
  return {
    storeName: (r.store_name as string) ?? '',
    grabStoreId: (r.grab_store_id as string) ?? '',
    category: r.category as GrabCategory,
    subitem: (r.subitem as string) ?? '',
    status: (r.status as string) ?? '',
    txnId: (r.txn_id as string) ?? '',
    relatedTxnId: (r.related_txn_id as string) ?? '',
    orderCode: (r.order_code as string) ?? '',
    longOrderId: (r.long_order_id as string) ?? '',
    orderType: (r.order_type as string) ?? '',
    paymentMethod: (r.payment_method as string) ?? '',
    payoutId: (r.payout_id as string) ?? '',
    grabCreatedAt: (r.grab_created_at as string) ?? null,
    transferredAt: (r.transferred_at as string) ?? null,
    businessDate: (r.business_date as string) ?? '',
    amount: Number(r.amount ?? 0),
    shopDiscount: Number(r.shop_discount ?? 0),
    deliveryDiscount: Number(r.delivery_discount ?? 0),
    netSales: Number(r.net_sales ?? 0),
    mdr: Number(r.mdr ?? 0),
    mdrVat: Number(r.mdr_vat ?? 0),
    grabFee: Number(r.grab_fee ?? 0),
    marketingFee: Number(r.marketing_fee ?? 0),
    commDelivery: Number(r.comm_delivery ?? 0),
    commPlatform: Number(r.comm_platform ?? 0),
    commOrder: Number(r.comm_order ?? 0),
    commOther: Number(r.comm_other ?? 0),
    wht: Number(r.wht ?? 0),
    total: Number(r.total ?? 0),
    commVat: Number(r.comm_vat ?? 0),
    description: (r.description as string) ?? '',
    cancelReason: (r.cancel_reason as string) ?? '',
    cancelledBy: (r.cancelled_by as string) ?? '',
    refundReason: (r.refund_reason as string) ?? '',
  }
}
