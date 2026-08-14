# Mamapook Accounting

Revenue reconciliation app for Mamapook branches. Current modules (mock v0.1):

- **Grab — upload**: parse the GrabMerchant report (.xlsx), reconcile per branch
  (performance + settlement, verified against the payout sheet to the satang), save to DB.
- **Grab — dashboard**: revenue, every cost as % of net sales, bank vs ถุงเงิน split,
  payout tracker.
- **Catering / Event**: 4-section entry form (info → menus/pricing → costs → bowl
  reconcile) with live formulas.

Coming next: POS revenue pull, Peak import file generator, bank statement pre-check.

## Stack

Vite + React + TypeScript SPA. Data in Supabase (schema `acc`), auth via Supabase
email/password. Grab xlsx parsed client-side. No server component.

## Setup

```bash
npm install
cp .env.example .env   # fill VITE_SUPABASE_URL + VITE_SUPABASE_KEY (publishable key)
npm run dev
```

### Staff accounts

Public signups are disabled. Create staff users in Supabase Dashboard →
Authentication → Add user (email + password, confirm email automatically).
All authenticated users can read/write the `acc` schema (RLS policy `to authenticated`).

## Tests

```bash
npm test          # pure-logic tests (parser, reconciliation, catering formulas)
```

Local-only tests in `local/` (gitignored) verify against real export files.

## Deploy (Cloudflare Pages)

One-time: `npx wrangler login` (opens browser OAuth).

```bash
npm run deploy
```

Then set the two `VITE_*` env vars in the Cloudflare Pages project settings
(Build & deployments → Environment variables) if building on CF instead of locally.

## Security notes

- This repo is public: no secrets, no bank account numbers, no real business data
  committed. Branch/bank mappings live only in the `acc.branches` table.
- The publishable Supabase key is client-safe; the `acc` schema grants nothing to
  `anon` — every request requires a logged-in staff session.
