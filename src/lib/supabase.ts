import { createClient } from '@supabase/supabase-js'

export const sb = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_KEY,
  { db: { schema: 'acc' } },
)

export type Branch = {
  code: string
  name_en: string
  name_th: string | null
  grab_store_id: string | null
  peak_bank_sub: string | null
  bank_last4: string | null
  is_active: boolean
}
