# FinanceTracker: setup guide

Run your own copy of FinanceTracker, a phone-first money app for a household. It includes everything: accounts, transactions, scanning receipts, portfolio (gold and stocks), monthly closing, savings plans and notifications.

You need about 30 minutes, a computer, and free accounts only. Your data lives in **your own** Supabase project.

```
Phone / browser (the app, hosted on Cloudflare Pages)  ──►  your Supabase project (database, sign-in, functions)
```

## What you need

| | Needed for | Cost |
| --- | --- | --- |
| [Supabase](https://supabase.com) account | the database and sign-in (required) | Free |
| [Cloudflare](https://cloudflare.com) account | putting the app online (required for phone use) | Free |
| [Node.js](https://nodejs.org) 18+ and [Python](https://python.org) 3.10+ | running the setup scripts | Free |
| Emas API ID key (optional) | backup source for Antam gold prices | Free |
| Google Gemini key (optional) | "smart read" for hard-to-read receipts | Free tier |

Get the code:

```bash
git clone https://github.com/ivankalka11/FinanceTracker
cd FinanceTracker
```

---

## 1. Create the database

1. At supabase.com, create a free project (region closest to you, for example Singapore). Save the database password in a password manager.
2. Open **SQL Editor**, paste the **whole** of [`supabase/setup_all.sql`](supabase/setup_all.sql), and click **Run**. This creates every table, security rule and function for all features in one go. Run it once, on a new empty project only.
3. In **Authentication → Sign In / Providers**, keep **Email** on and turn **off** "Allow new users to sign up". People join by invitation only.
4. In **Authentication → Users → Add user**, create your own user (your email and a password).
5. In **Project Settings → API keys**, copy the **Project URL** and the **publishable key**. You need them in the next step.

> Optional scheduled notification checks: see **Scheduled checks** below.

---

## 2. Configure and run it locally

```bash
cp .env.example .env        # Windows: copy .env.example .env
```

Open `.env` and fill in only these two lines:

```env
SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
SUPABASE_PUBLISHABLE_KEY=your publishable key
```

Then:

```bash
python scripts/build_pwa_config.py
python -m http.server 5173 --directory pwa
```

Open `http://localhost:5173`, sign in with the user from step 1, and the app asks you to create your household and accounts. Add a transaction to check that it works.

The publishable key is designed to be public. Never put `SUPABASE_SECRET_KEY` anywhere near the app.

---

## 3. Put it online (Cloudflare Pages)

1. Log in to Cloudflare once (a browser window opens):

```bash
npx wrangler login
```

2. In `.env`, set a project name of your own (lowercase letters, numbers and dashes). It becomes your address `https://<name>.pages.dev`:

```env
CLOUDFLARE_PAGES_PROJECT=my-finance
```

3. Upload:

```bash
python scripts/deploy_pwa.py
```

The script builds the config, downloads the on-device scanning models, and uploads a copy of the `pwa` folder whose security headers allow only **your** Supabase project (taken from `SUPABASE_URL` in `.env`). It prints the final address (Cloudflare adds a suffix if the name is taken).

4. In Supabase, open **Authentication → URL Configuration** and set **Site URL** to that address (also add it under **Redirect URLs**). Password sign-in works without it; it matters only for auth emails such as invitations and password resets.
5. On your phone, open the address, sign in, and choose **Add to Home Screen**.

For every later release, run `python scripts/deploy_pwa.py` again. If the main address shows a 404 after an upload, the project's production branch is not `main`: set `CLOUDFLARE_PAGES_BRANCH` in `.env` to that branch, or change **Production branch** in the Cloudflare project settings, then upload again.

---

## 4. Optional extras

**Live gold and stock prices.** Without this, holdings show at cost.

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_ID
npx supabase secrets set EMAS_API_KEY=your_emas_key
npx supabase functions deploy prices
```

Gold uses the Antam 1 g buyback price shown on [muamalahemas.com](https://muamalahemas.com/) (a reseller's rate, no key needed). If that page cannot be read, the function asks Emas API ID, which needs `EMAS_API_KEY` and has a monthly quota. Stocks use Yahoo Finance with `.JK` added for IDX, about 15 minutes delayed. Each user may ask for prices 20 times a minute.

**Smart read for scanning.** Scanning works on the device with no key (PaddleOCR; the photo never leaves your phone). If a photo reads badly, "Try smart read" sends it to Google Gemini. To turn that on:

```bash
npx supabase secrets set GEMINI_API_KEY=your_gemini_key
npx supabase functions deploy ocr
```

It is limited to 30 smart reads per user per day (change `v_limit` in the `use_ocr_scan` function to adjust). Google's free tier may use submitted images to improve its products, so this applies to smart read only.

**Lock the functions to your app (recommended).** By default `prices` and `ocr` answer browsers on any origin (they still need a signed-in user's token). To accept only your app, set its address and redeploy:

```bash
npx supabase secrets set ALLOWED_ORIGINS=https://YOUR-PROJECT.pages.dev
npx supabase functions deploy prices
npx supabase functions deploy ocr
```

After any change to `supabase/functions/_shared/`, redeploy `prices` and `ocr` (and `telegram` if you deployed it; it is parked by default).

**Existing projects: run the hardening migration.** In the SQL Editor, run `supabase/migrations/20261123000000_hardening.sql` once. It limits households per user (3) and members per household (10), and locks down internal helper functions. New projects get it from `setup_all.sql`. It does not replace turning sign-ups off (step above): with sign-ups on, anyone could create an account.

**Existing projects: run the query-performance migration.** After the hardening one, run `supabase/migrations/20261124000000_query_performance.sql` once in the SQL Editor. It makes reads of a large history much faster (membership is checked once per query, not once per row) and changes nothing about who can see what. New projects get it from `setup_all.sql`.

**Bring your data from the old Google Sheet version.** Add `SUPABASE_SECRET_KEY` and `APPS_SCRIPT_URL` / `API_SECRET` to `.env`, then preview and run (safe to repeat):

```bash
python scripts/import_sheet_to_supabase.py --owner-email you@example.com --household "Keluarga" --dry-run
python scripts/import_sheet_to_supabase.py --owner-email you@example.com --household "Keluarga"
```

Run this from your own computer only; the secret key bypasses all security rules.

---

## 5. Scheduled checks (optional)

Notification checks (plans and month-close reminders) can run inside Supabase at **08:00, 12:00 and 16:00 WIB**. Without this they still run whenever someone opens the app.

1. In Supabase, open **Database → Extensions** and turn on **pg_cron**.
2. In **SQL Editor**, run `supabase/migrations/20261121000000_scheduled_jobs.sql`. (On a new project, turn the extension on first and then run `setup_all.sql`, which already contains it.)

Check it: **Database → Cron Jobs** lists `finance-notifications`.

Holding prices are not scheduled. Open the **Portfolio** page and tap **Sync prices** to refresh gold and stocks on demand.

---

## 6. Using the app

- **Home:** total balance, your accounts, this month's totals, plans, recent transactions, and the notification bell.
- **Add:** income, expense or invest entries; transfers between accounts (not counted as income or expense). Works offline and syncs when the connection returns.
- **Scan (centre button):** pick Receipt, Payslip or History, take a photo, check the details, then Save. Nothing is saved until you tap Save, and photos are not stored.
- **Overview:** period totals, a 6-month chart, expenses by category.
- **Portfolio:** add gold or stocks, see live profit and loss, sell (oldest lots first) and see realized P&L.
- **Loans:** Home → Loans (or Settings → Loans). Record money lent from an account (such as Bersama) to a member: amount, the account it leaves, who borrows it, optional due date. Then record repayments into any account. Loans and repayments change balances but are not expense or income, and each monthly statement lists the loans still unpaid at that month's end. Needs `supabase/migrations/20261122000000_loans.sql`.
- **Plans:** savings goals with a target amount and date. A plan is a set-aside on a real account, with its own ledger (add money, take money out, adjust). Gold and stocks you hold can be assigned to a plan. Each account shows balance, set aside and free to spend.
- **Monthly closing (owners):** when a month ends, check the figures, enter each account's bank balance, and close it. This saves the statement (printable, CSV export) and locks entries dated in or before that month. An owner can reopen the latest closed month with a reason.
- **Notifications:** plan milestones (25/50/75/100%), falling behind, deadlines, monthly reminders and month-close reminders. Switch each kind on or off in **Settings → Configuration → Notifications**. They appear in the in-app bell only (phone push is not planned).
- **Settings:** accounts (add, rename, archive, opening balances), categories, household members (add by email, they must exist as a Supabase user first; up to 10 per household), sign out.

---

## Security

- The repository is public and must never hold a secret. `.env`, `pwa/config.js` and `pwa/models/` are git-ignored; only `.env.example` (empty values) is tracked.
- Safe in the browser: `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. Row-level security means data is only returned to signed-in members of the household, and sign-ups are off.
- Server-side only: `SUPABASE_SECRET_KEY`, `GEMINI_API_KEY`, `EMAS_API_KEY`. Function keys go in with `supabase secrets set`, not in files.
- If a key is ever exposed, rotate it first: create a new Supabase secret key and delete the old one, regenerate the Gemini and Emas keys.
- The app address is public, so anyone can open the sign-in page, but only people you added can sign in.

## Updating and troubleshooting

- **New version of the app:** `git pull`, then `python scripts/deploy_pwa.py`. New database changes arrive as files in `supabase/migrations/`; run any you have not run yet in the SQL Editor (and rebuild `setup_all.sql` with `python scripts/build_supabase_setup.py` if you change one).
- **Check the database rules:** `sh tests/sql/run.sh` (needs Docker). Check the scanner: `node tests/receipt_parser_test.js`.
- **Phone camera does not open:** it only works on an HTTPS address, so use the hosted address, not `localhost`, on the phone.
- **"Not set up yet" for plans or statements:** the database script was not run, or ran on a different project than `SUPABASE_URL` points to.
- **Old setup (Google Sheet, V1 dashboard, Telegram bot):** [`docs/V1-setup.md`](docs/V1-setup.md). Not needed for the current app. What is built and what is next: [`plan.md`](plan.md).
