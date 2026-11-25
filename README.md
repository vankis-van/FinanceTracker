# FinanceTracker

A self-hosted, phone-first money app for an Indonesian household: Rupiah formatting, receipt scanning and Antam gold buyback pricing. Your data lives in your own Supabase project and the running cost is zero (free tiers only).

To run your own copy, follow [`setup.md`](setup.md) (about 30 minutes). What is built and what is next: [`plan.md`](plan.md).

---

## Features

- **Accounts you define**: any number of accounts per household, with opening balances, and transfers between them that stay out of income and expense totals.
- **Transactions**: income, expense and invest entries, categories, edit and delete, offline queue.
- **Scan**: photograph a receipt, payslip or a transaction-history screenshot. Text is read on the device (PaddleOCR); an optional Gemini function ("smart read") helps with hard photos. Nothing is saved until you check and tap Save.
- **Portfolio**: gold (Antam buyback) and IDX stocks, weighted-average cost, live profit and loss, sell tracking and realized P&L.
- **Monthly closing**: close a month to save its statement and lock its entries; owners can reopen the latest month.
- **Plans**: savings goals with a target amount and date. A plan is a set-aside on a real account, with its own ledger (add, take out, adjust), and can include gold and stocks you already hold. Each account shows balance, set aside and free to spend.
- **Plan spending**: pay a vendor or bill from a plan as a real expense on the account you choose, in partial payments; the plan keeps its progress (30 juta plan, 5 juta paid: 25 juta cash + 5 juta spent = 30 juta).
- **Statement charts**: the monthly statement shows expenses by account and by category as charts.
- **Loans**: lend money from an account (for example Bersama) to Ivan or Mely and record their repayments back into an account. Loans are not expenses and repayments are not income; each monthly statement lists the loans still unpaid at month end.
- **Notifications**: plan milestones, falling behind, deadlines and month-close reminders, in an in-app bell with per-kind switches. They show inside the app only; phone push is not planned.
- **Households**: invite members by email (up to 10 per household, 3 households per user); owners and members have different rights.
- **Look and feel**: a dark burgundy theme with translucent glass pages and sheets, glass dropdown menus and calendar, and motion that follows your touch (off under reduced-motion).

---

## Architecture

```
Phone / browser (PWA on Cloudflare Pages)  ──►  Supabase  (Postgres + row-level security, Auth, Edge Functions)
                                                  ├─ prices function  (Antam gold, Yahoo Finance)
                                                  └─ ocr function     (optional Gemini "smart read")
```

The app talks straight to Supabase with the signed-in user's session. Every table carries a `household_id` and row-level security lets only household members read or write it. Live prices are fetched server-side by an Edge Function, never in the browser.

---

## Tech stack

| Part | Tech |
| --- | --- |
| Database and auth | Supabase (Postgres, magic-link or password sign-in) |
| App | HTML, CSS, vanilla JS, Chart.js, no build step (`pwa/`) |
| Scanning | PaddleOCR on the device (ONNX runtime); optional Gemini function |
| Prices | muamalahemas.com (Antam buyback; if it fails, Emas API ID), Yahoo Finance (IDX `.JK`), via a Supabase function |
| Hosting | Cloudflare Pages (`scripts/deploy_pwa.py`) |

---

## Quick start

> Full steps, including hosting and the optional extras, are in [`setup.md`](setup.md).

1. Create a free Supabase project and paste `supabase/setup_all.sql` into the SQL Editor once (it is every migration in one file).
2. Copy `.env.example` to `.env` and fill in `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`.
3. Run locally:

```bash
python scripts/build_pwa_config.py
python -m http.server 5173 --directory pwa
```

4. Open `http://localhost:5173` and sign in. To host it: `python scripts/deploy_pwa.py` (Cloudflare Pages).

Run the checks:

```bash
node tests/receipt_parser_test.js
sh tests/sql/run.sh        # database rules, needs Docker
```

---

## Repository layout

```
pwa/                 V2 app (index.html, app.js, styles.css, sw.js, receipt-parser.js, ocr-worker.js, _headers)
supabase/migrations/ database schema, security rules and functions, in order
supabase/functions/  Edge Functions: prices, ocr, and the shelved telegram webhook
scripts/             config build, Cloudflare deploy, OCR model fetch, Sheet import
tests/               parser tests and SQL tests (ledger, plans, loans, hardening)
docs/                BRD.md (business requirements), SRS.md (software requirements), V1-setup.md (legacy setup)
Dashboard/, TelegramBot/, code.gs   legacy V1 (Google Sheet backend), see docs/V1-setup.md
```

---

## Security and what is on GitHub

This repository is public. It must never hold a real secret.

- **Git-ignored, never committed:** `.env`, `pwa/config.js`, `Dashboard/config.js`, `pwa/models/`, `supabase/.temp/`, and `.claude/settings*.json`. Only `.env.example` (empty values) is tracked.
- **Safe in the browser:** `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. Row-level security protects the data, and sign-ups are turned off so people join by invite only.
- **Server-side only:** `SUPABASE_SECRET_KEY` (bypasses security), `BOT_TOKEN`, `GEMINI_API_KEY`, `EMAS_API_KEY`, `ANTHROPIC_API_KEY`, `TELEGRAM_WEBHOOK_SECRET`. Edge Function keys are stored with `supabase secrets set`, not in files.
- **Hardening in place:** the two CDN scripts carry `integrity=` hashes (update them when a version changes), `pwa/_headers` sets the content security policy, HSTS and COOP, and `scripts/deploy_pwa.py` pins the policy's Supabase host to your own project in the uploaded copy. The V1 bot refuses everyone until `ALLOWED_TELEGRAM_ID` is set, and V1 sheet writes neutralise text that starts with `=`, `+`, `-` or `@`.
- If a secret is ever committed, rotate it first (removing it from history does not undo the exposure); see the Security section of [`setup.md`](setup.md).

---

## Legacy V1

The original Google Sheet + Apps Script backend, web dashboard and Telegram bot are kept in the repo (`Dashboard/`, `TelegramBot/`, `code.gs`) but are not developed any more. Setup and bot commands: [`docs/V1-setup.md`](docs/V1-setup.md). To bring V1 data into V2, use `scripts/import_sheet_to_supabase.py` (see [`setup.md`](setup.md)).
