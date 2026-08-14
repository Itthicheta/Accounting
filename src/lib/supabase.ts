import { createClient } from '@supabase/supabase-js'

export const sb = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_KEY,
  { db: { schema: 'acc' } },
)

/**
 * Fetch ALL rows of a query by paging — Supabase caps any single request
 * (default 1000 rows), which silently truncates large results otherwise.
 * `build` must apply a stable .order() so pages don't shuffle.
 */
export async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  page = 1000,
): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; ; i += page) {
    const { data, error } = await build(i, i + page - 1)
    if (error) throw error
    const chunk = data ?? []
    out.push(...chunk)
    if (chunk.length < page) return out
  }
}

/** Today's date in Asia/Bangkok as YYYY-MM-DD (toISOString would give UTC — wrong before 07:00) */
export function bkkToday(offsetDays = 0): string {
  const d = new Date(Date.now() - offsetDays * 86400_000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(d)
}

export type Branch = {
  code: string
  name_en: string
  name_th: string | null
  grab_store_id: string | null
  peak_bank_sub: string | null
  bank_last4: string | null
  is_active: boolean
  peak_customer: string | null
  peak_class: string | null
  tungngern_peak_sub: string | null
  pos_location_id: string | null
}
