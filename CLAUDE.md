# FinanceTracker

Self-hosted personal finance system for an Indonesian household. **V2 is current:** Supabase (Postgres with row-level security, Auth, Edge Functions) is the database and the phone-first PWA in `pwa/` (hosted on Cloudflare Pages) is the app. **V1 is legacy:** one Google Sheet read and written only by a Google Apps Script web app, with a web dashboard and a Telegram bot as front-ends. V1 still works but is not developed; the V1 sections below are marked as such.

## Goals

- Track income, expenses, investments and balances across three savings accounts: **Ivan**, **Mely**, **Bersama** (joint).
- Make logging near-effortless: a Telegram message or a photo of a receipt/payslip should be enough.
- Show live profit/loss on gold (Antam buyback) and IDX stocks alongside cash balances.
- Keep the data self-owned (in the user's own Google Sheet) and the running cost at zero (free tiers only).
- Fit the Indonesian context: Rupiah formatting, QRIS-style receipts, Antam gold pricing.
- V2 (Supabase + `pwa/` on Cloudflare Pages) is the current system; V1 hosting (24/7 bot, dashboard on GitHub Pages) is off the roadmap.
- The GitHub repo is public: it must never hold a real secret (see Working rules).

## Architecture and flow

**V2 (current)**

```
PWA (Cloudflare Pages) ──► Supabase Auth + Postgres (RLS, RPCs)
   ├──► Edge Function prices ──► muamalahemas.com (Emas API ID fallback), Yahoo Finance
   ├──► Edge Function ocr ─────► Gemini (optional "smart read")
   └──► on-device OCR (PaddleOCR in a Web Worker)
```

The app talks to Supabase with the signed-in user's session; every table has a `household_id` and RLS decides access. Details of each V2 phase are under "V2 upgrade" below.

**V1 (legacy)**

```
Telegram Bot ─┐
              ├──► Apps Script Web App (/exec, guarded by API_SECRET) ──► Google Sheet
Dashboard ────┘
```

- **Requests:** both front-ends call the `/exec` URL with `?action=...`. Reads are GET; writes are POST with a JSON body sent as `text/plain` (avoids a CORS preflight that Apps Script does not answer). Every call carries the shared secret.
- **API actions (`code.gs`):**
  - GET: `read`, `summary`, `holdings`, `accounts`, `portfolio`, `realized`
  - POST: `add`, `transfer`, `delete`, `addHolding`, `deleteHolding`, `sellHolding`
- **Text entry flow:** `/add` (or the dashboard form) → pick account → `add` action → row in the Transactions sheet.
- **Receipt flow:** photo → OCR (Gemini) extracts merchant, amount, date → bot asks category and account → `add` as expense.
- **Payslip flow:** `/payslip`, then photo → OCR reads net take-home and pay date → `add` as income.
- **History flow:** `/history`, then a screenshot of a transaction list → OCR parses many rows → bot shows a review card per row (keep / rename / skip, category, account) → `add` for each kept row.
- **Investment flow:** buy via `addHolding` (weighted-average cost per position) → `/portfolio` prices holdings live → `/sell` calls `sellHolding`, which records realized P&L → `/realized` lists it.
- **Transfer flow:** `/transfer` writes two linked rows and is excluded from income/expense totals.
- **Dates:** `add` accepts an optional `date` (`YYYY-MM-DD`), defaulting to today. The bot drops malformed or future dates.
- **Pricing:** fetched server-side only (bot or Apps Script), never in the browser.
  - Gold: stored as `ticker: "LM"` with the brand (e.g. "Antam") in `name`; priced at the Antam 1 g buyback scraped from `https://muamalahemas.com/` (a reseller's rate, no key).
    - Fallback: when the page is unreachable or its layout changed, gold uses Emas API ID (`EMAS_API_KEY`, monthly quota). Python: `scripts/gold_scraper.py` (standard library only, also a CLI) used by `pricing.get_gold_buyback()`, which adds `fallback_reason`. Edge Functions: `goldFromPage()` in `_shared/prices.ts` (keep both parsers in step); for a past day (`goldBuybackOn`) the page counts only when it was published on or before that day and within 7 days, else the API is asked. Redeploy `prices`, `ocr` and `telegram` after changing `_shared/prices.ts`. The old `emas.maulanar.my.id/price-cards` scraper is in `archive/gold-price-cards/`.
  - Stocks: Yahoo Finance with `.JK` appended automatically, about 15 minutes delayed.
- **Config:** one root `.env` serves both front-ends. The bot loads it through `TelegramBot/env_loader.py`; `scripts/build_dashboard_config.py` writes `Dashboard/config.js` containing only `APPS_SCRIPT_URL` and `API_SECRET`.

## Features (V1; V2 features are listed in README.md)

- **Dashboard:** add/delete transactions, holdings and transfers; per-account balances; expenses-by-category chart; searchable, filterable, sortable, paginated transaction table.
- **Telegram bot commands:** `/add`, `/payslip`, `/history`, `/portfolio`, `/sell`, `/realized`, `/accounts`, `/transfer`, `/summary`, `/recent`, plus sending a receipt photo directly.
- **OCR import:** receipts → expenses, payslips → income, history screenshots → reviewed bulk import.
- **Investments:** weighted-average positions, sell tracking, realized and unrealized P&L.
- **Multi-account:** balances per account and transfers between them.
- **Access control (V1):** `API_SECRET` on the API; `ALLOWED_TELEGRAM_ID` is required: the bot refuses everyone while it is unset. Sheet writes in `code.gs` go through `safeCell_()`, which stores text starting with `= + - @` as plain text.

## Tech used

| Part | Tech |
| --- | --- |
| V2 database and auth | Supabase (Postgres, RLS, magic-link or password sign-in) |
| V2 app | `pwa/`: HTML, CSS, vanilla JS (no build step), service worker, Chart.js |
| V2 hosting | Cloudflare Pages (`scripts/deploy_pwa.py`) |
| V2 functions | Deno / TypeScript Edge Functions in `supabase/functions/` |
| V1 database | Google Sheets |
| Backend/API | Google Apps Script web app (`code.gs`) |
| Dashboard | HTML, CSS, vanilla JS, Chart.js (`Dashboard/`) |
| Bot | Python 3.12.7, pyTelegramBotAPI, requests, beautifulsoup4 (`TelegramBot/`) |
| OCR | Gemini API (`gemini-2.5-flash`, free tier); Anthropic as an optional paid provider via `OCR_PROVIDER` |
| Gold price | muamalahemas.com scrape (Antam buyback), Emas API ID as fallback |
| Stock price | Yahoo Finance (IDX `.JK`) |
| CI | None (the sample Jekyll workflow was removed); the PWA deploys to Cloudflare Pages with `scripts/deploy_pwa.py` |

## Key files

V2:

- `pwa/app.js`, `pwa/styles.css`, `pwa/sw.js`, `pwa/index.html`, `pwa/_headers`: the app, its styles, service worker, shell and security headers.
- `supabase/migrations/`: schema, RLS and RPCs in order; `supabase/setup_all.sql` is all of them in one file (rebuild with `python scripts/build_supabase_setup.py`).
- `supabase/functions/`: `prices`, `ocr`, parked `telegram`, and `_shared/` (`gemini.ts`, `prices.ts`, `cors.ts`).
- `tests/sql/` (run with `sh tests/sql/run.sh`, needs Docker; suites: ledger, plans, plan ledger, loans, hardening) and `tests/receipt_parser_test.js`.

V1 (legacy):

- `code.gs`: the whole backend. Changes only take effect after redeploying the Apps Script web app.
- `TelegramBot/bot.py`: commands, OCR, review cards, API wrappers (`api_add`, `api_transfer`, `api_sell`, ...).
- `TelegramBot/pricing.py`: `get_gold_buyback()`, `get_stock_price()`, `build_portfolio()`.
- `TelegramBot/diagnose.py`: gold-pricing connectivity check.
- `Dashboard/app.js`: all dashboard logic; reads `window.FINANCE_CONFIG` from the generated `config.js`.
- `scripts/build_dashboard_config.py`: generates `Dashboard/config.js` from `.env`.

## V2 upgrade (in progress)

Target: Supabase as the default database (Google Sheet kept as a second source and nightly mirror), user-defined accounts, a phone-first PWA dashboard, and receipt OCR inside the app via a Supabase function. Build order: (1) Supabase schema, security and Sheet import, (2) PWA rebuild, (3) in-app OCR, (4) bot update and webhook, (5) Sheets mode and mirror.

- Phase 1 files: `supabase/migrations/20261114000000_init.sql` (schema, row-level security, RPCs) and `scripts/import_sheet_to_supabase.py` (re-runnable import, matched on `legacy_id`).
- Every table carries `household_id`; access is decided by membership. New tables must enable RLS and follow the same policy shape: `household_id in (select private.my_households())` for tables read in bulk (since `20261124000000_query_performance.sql`; the older `private.is_member()` call cost one lookup per row), `private.is_owner()` for owner-only actions.
- `SUPABASE_SECRET_KEY` is server-side only. The browser gets only `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`.
- Phase 2 files: `pwa/` (no build step: `index.html`, `styles.css`, `app.js`, `sw.js`, `manifest.webmanifest`, `icons/`), `scripts/build_pwa_config.py` (writes the git-ignored `pwa/config.js` and PNG icons), `supabase/functions/prices/index.ts` (live prices; the app falls back to cost when it is not deployed).
- `pwa/app.js` is one IIFE: state in `S`, views `viewHome/viewStats/viewPortfolio/viewSettings/viewActivity`, bottom-sheet forms `sheet*`, submit handlers in `forms`, click handlers in `actions`. Bump `VERSION` in `pwa/sw.js` whenever shell files change. Motion: `transition(update, kind)` wraps screen changes in a View Transition, `openFrom(el, open)` grows a sheet out of the tapped element and `closeSheet()` shrinks it back; the matching CSS is the `motion` block at the end of `styles.css` (all inside `prefers-reduced-motion: no-preference`).
- Phase 3 (scanning): on-device by default. `pwa/ocr-worker.js` runs PaddleOCR (`ppu-paddle-ocr@6.7.1` from jsDelivr, onnxruntime-web, PP-OCRv6 tiny models self-hosted in the git-ignored `pwa/models/`, fetched by `scripts/fetch_ocr_models.py`) and returns text lines with boxes. `pwa/receipt-parser.js` (`window.ReceiptParser.parse(mode, lines, ctx)`) turns lines into rows with rules only; test with `node tests/receipt_parser_test.js`. In `pwa/app.js`: `sheetScan` -> `runScan(file, engine)` -> `readTextOnDevice` + parser, or `readSmart` (the optional `supabase/functions/ocr` Gemini function, with the `use_ocr_scan()` daily limit from `supabase/migrations/20261115000000_ocr_usage.sql`); rows are reviewed through `sheetAdd(type, pre, scan)` with `S.scan`, saved with `source: "ocr"`. Photos are not stored.
- Phase 4 (shelved, not deployed; Settings row hidden unless `TELEGRAM_BOT` is set in `pwa/config.js`): `supabase/functions/telegram/index.ts` (the bot as a Telegram webhook; deployed with `--no-verify-jwt`, guarded by `TELEGRAM_WEBHOOK_SECRET`; uses the service role, so every query must filter by the linked `household_id`), `supabase/functions/_shared/gemini.ts` and `_shared/prices.ts` (shared by `ocr`, `prices` and `telegram`; redeploy all three after changing them), `supabase/migrations/20261116000000_telegram.sql` (`telegram_link_codes`, `telegram_state`, `create_telegram_link_code()`, `use_ocr_scan_for()`), `scripts/setup_telegram_webhook.py` (secrets, deploy, setWebhook; `--off` returns to polling). Linking: app Settings creates a one-time code, the user sends `/link CODE` to the bot. Bot conversation state lives in `telegram_state.state` (pending entry, review queue, next-photo mode).
- V2.4 ledger closing: `supabase/migrations/20261117000000_ledger_closing.sql` (`ledger_closings`, `ledger_closing_accounts`, `ledger_closing_events`; `period_statement()`, `close_period()`, `reopen_period()` RPCs; trigger `private.guard_closed_month()` on `transactions` and `sales` refuses changes dated on or before `private.locked_through()`). In `pwa/app.js`: the `ledger` route (`viewLedger`), `sheetStatement` / `statementBody`, `forms.close` / `forms.reopen`; helpers `lockedThrough()`, `isLocked()`, `minDate()`, `nextToClose()`. `S.ledgerReady` is false until the migration has run. Only owners close or reopen; closing is never automatic.
- V2.5 plans app (done): route `plans` (`viewPlans`, opened from the Home card `homePlans()`), `sheetPlan` (detail + `drawPlanChart`), `sheetPlanForm`, `sheetContribution`; `forms.plan` / `forms.contribution`; actions `plan-*`, `contribution-delete`. `planStats(p)` mirrors `private.check_plan` (saved, monthly needed, on track / behind / overdue); keep the two in step. `S.plansReady` is false until the plans migration has run. Statements show `st.plans` (draft from `period_figures`, snapshot from `ledger_closings.plans`).
- V2.5 plans database: `supabase/migrations/20261118000000_plans.sql` (`plans`, `plan_contributions`, `notifications`, `notification_prefs`, `push_subscriptions`; `ledger_closings.plans`). Notifications are rows created only by the database: `private.check_plan()` (milestones right after a contribution, date checks daily), `private.check_household()` (plans + month-close reminders), `private.notify()` (owners default on, members default off, unique per `(user, kind, subject, period_key)`). The app calls `check_notifications(household)` on open (returns the unread count); `pg_cron` calls `run_notifications()` at 07:00 and 19:00 WIB. `private.period_figures` now wraps `period_figures_base` and adds `plans`. Push delivery (Edge Function reading `sent_at is null`) is still to do. Test with `sh tests/sql/run.sh` (Docker; Postgres 15 + `tests/sql/supabase_stubs.sql`).
- V2.6 plan ledger (migration and app done): `supabase/migrations/20261119000000_plan_ledger.sql`. `plan_contributions` is now `plan_ledger` (`entry_type`: deposit, withdrawal, adjustment, asset_in, asset_out; signed amounts; cash never below zero; asset rows describe the asset so they survive a sale). Plans are earmarks on a real account, not accounts: `account_earmarks(household)` gives cash per account, free to spend = balance minus earmark. Gold and stocks join a plan through `plan_holdings` (`assign_holding_to_plan`, `unassign_holding_from_plan`; selling a lot releases it automatically). The database values holdings at cost; the app prices them live, and `set_month_end_prices()` stores market prices before closing so `plan_figures()` (opening_cash, deposits, withdrawals, adjustments, cash, asset_value, assets_priced) is reproducible. `plan_contributions` stays as a view over deposit rows, and `plan_ledger_running` gives running balances. In `pwa/app.js`: `S.ledger` / `S.planHoldings` / `S.earmarks` load in `refresh()` (falls back to `plan_contributions` when `S.plansLedger` is false, i.e. before this migration); `planStats(p)` now returns `cash`, `assets`, `assetValue` (live price, else cost) and `entries`; `sheetWithdraw`, `sheetAssign`, `forms.withdraw` / `forms.assign`, actions `plan-withdraw`, `plan-assign`, `plan-release`; wallet cards show "Set aside" and "Free to spend"; `forms.close` saves today's prices with `set_month_end_prices` before `close_period`; `forms.txn` warns when spending takes an account below its earmark. `planStats` mirrors `private.check_plan` except that it prices assets live.
- V2.7 (code and tests done, migration and function deploy pending): `supabase/migrations/20261120000000_plan_sale_and_month_end.sql`. `sell_holding` sets the transaction-local setting `ft.sale_price`; the release trigger then also writes a `deposit` ("Sale proceeds: ...") into each plan whose assigned quantity was sold (a plain delete adds no cash; cancelled plans are skipped). `month_end_prices.price_date` and `plans[].prices_on` give the day a statement price is for. The `prices` function accepts `date` (`goldBuybackOn`, `stockPriceOn` in `_shared/prices.ts`) and `forms.close` fetches last-day prices, falling back to today's price. Notification checks still use cost by design. Run `python scripts/build_supabase_setup.py` after migration changes.
- V2.8: `supabase/migrations/20261121000000_scheduled_jobs.sql` reschedules the notification checks to 08:00, 12:00 and 16:00 WIB (the last-day month-close reminder now starts at 16:00). Holding prices are not scheduled: the Portfolio page has a **Sync prices** button (`actions["sync-prices"]`, `loadPrices(manual)`, `S.pricesAt`).
- V2.5 notifications app (done): `S.notifs` / `S.prefs` load in `refresh()`; `runChecks()` calls `check_notifications` on start and when the app becomes visible again (at most every 30 min); `listenNotifs()` subscribes to Realtime inserts for this user; bell on Home (`paintBell()`, `#bell-count`), `sheetNotifications()`, `openNotifLink()` (`plan:<id>`, `statement:<YYYY-MM-01>`); actions `notifs`, `notif`, `notifs-read`, `notifs-clear`; Settings → Configuration → Notifications screen (route `notifications`, `viewNotifSettings()`) with switches from `NOTIF_GROUPS` (one switch can cover several kinds; `prefOn()` gives the owner-on / member-off default).
- Web Push is dropped: notifications stay in the in-app bell (`push_subscriptions` and `save_push_subscription()` are unused). The Telegram webhook, Sheets mode and V1 hosting are off the roadmap too.
- V2.9 loans (migration run on the live project; the Loans screens load in the app): `supabase/migrations/20261122000000_loans.sql`. Money lent from a household account (e.g. Bersama) to a member: `loans` table plus transactions of type `loan-out` (the money leaving the account) and `loan-in` (a repayment coming back) carrying `loan_id`; not income or expense. Loan rows are written only by `add_loan`, `update_loan`, `delete_loan`, `add_loan_payment`, `delete_loan_payment` (a trigger refuses direct writes unless the transaction-local setting `ft.loan` is set). `period_figures_base` now includes `loan_in`/`loan_out` and `private.period_figures` adds `loans` + `loans_outstanding` (unpaid at month end); a trigger stores them in `ledger_closings.loans`. `household_members()` gives member emails for the borrower picker. In `pwa/app.js`: `S.loans` / `S.memberEmails` / `S.loansReady`, helpers `loanStats()` / `openLoans()` / `totalOwed()`, route `loans` (`viewLoans`, Home card `homeLoans()`), `sheetLoanForm` / `sheetLoan` / `sheetLoanPay`, `forms.loan` / `forms.loanpay`, actions `loan-*`, statement section in `statementBody`. Loans need a connection (not in the offline queue); the app refuses to lend more than the account holds. Run `python scripts/build_supabase_setup.py` after migration changes.
- Design system (V2.10): accent burgundy `#b23455` (press `#8f2742`) on a warm wine-black canvas `#130a0e`; tokens are `:root` variables at the top of `pwa/styles.css`. Pages (`.sheet`) and modals (`.modal`) are translucent dark glass: both override `--ink`, `--ink-muted`, `--rule`, `--wash`, `--sheet`, `--g-tile`, `--green`, `--red` and `--accent-press` so new content follows automatically, and the "page glass" / "modal glass" blocks at the end of the file fix controls that hard-code light colors (chips, ghost pills, logo tiles, tags, danger buttons). Blur (`backdrop-filter`) is used only on the nav, modals, toast and pickers: not on pages, and tiles lose it while they move (`.enter`, `html[data-vt]`). Text links (`.link`) are dark-burgundy buttons. Plain modals close with a CSS slide on the live element (class `closing` on `.overlay`, in `closeSheet()`), because a View Transition snapshot drops the blur; only sheets grown from a row use the "hero" transition, and during it the nav and page lose their `view-transition-name` so they stay in the root layer. Pickers are our own, because native popups cannot be styled: selects use `appearance: base-select` where supported (native picker elsewhere), `enhanceCombos()` replaces a `<datalist>` with `.combo-list`, and `enhanceDates()` makes `type="date"` fields read-only and opens the `.cal` calendar (it enforces `min`/`max` and a required value on submit). Check a visual change on the Home, Overview, Portfolio and Settings pages and in a modal.
- Query performance (V2.12): `supabase/migrations/20261124000000_query_performance.sql` adds `private.my_households()`, rewrites the member policies to use it, and indexes `transactions.category_id` and `plan_ledger.holding_id`; test `tests/sql/rls_test.sql` (who sees and writes what). In `pwa/app.js`: `fetchAll()` takes the row count from page 1 and loads the other pages four at a time (its query must select with `count: "exact"` and end in a total order, hence the `id` tiebreaker); `saveCache()` writes the offline copy once per burst (`flushCache()` on hide, cleared on sign-out) and, if localStorage is full, keeps the last two years; `loanRepaid()` and `accountStack()` total in one pass. Benchmark when changing queries: seed about 100,000 transactions in the Docker Postgres used by `tests/sql/run.sh` and time the reads as the `authenticated` role.
- V2.13 (built; migration not yet run on the live project; requirements in `docs/BRD.md` BR-51 to BR-56 and `docs/SRS.md` FR-PLN-21 to FR-PLN-28, FR-CLS-18, FR-CLS-19): plan ledger entry type `spend` = a real expense on an account plus cash leaving the plan, and `saved` becomes cash + assets + spent, so `planStats` and `private.check_plan` / `plan_figures` must change together. Migration will be `20261125000000_plan_spend.sql` (`spend_from_plan`, `delete_plan_spend`). The statement charts (expenses by account and category) draw from data `statementBody` already has; no database change. Closing a plan (achieved or cancelled) gets a confirmation sheet that offers to release leftover cash (`withdrawal`) and assigned holdings (`asset_out`); nothing is released automatically. In the app: `planStats` returns `spent`/`closedAt`, `sheetSpend` + `forms.spend`, `sheetClosePlan` + `forms.closeplan`, actions `plan-spend`, `plan-closeout`, `spend-delete`; statement charts `expenseSplit` / `drawStatementCharts`.
- V2.14 (built, not yet deployed; `docs/SRS.md` FR-OCR-12): smart-read loading panel (`startSmartLoading`, `scanLoad`, action `scan-cancel`) in `sheetScan` / `runScan` (photo preview with scan line, step text, seconds waited, Cancel, 45 s timeout); on-device reads keep the small `.scan-busy` indicator.
- Loading skeletons: while the first data loads, `start()` paints `skeleton(tab)` (grey `.sk` shapes laid out like the real screen, transform-only shimmer, non-interactive nav). `pwa/index.html` holds a static copy of the Home skeleton for the moment before `app.js` runs; it is generated from the code between the `skeleton:begin` / `skeleton:end` markers in `pwa/app.js`, so regenerate it when that block changes. Refreshes after a write do not show a skeleton.
- Security hardening (audit follow-up): `pwa/index.html` loads supabase-js and chart.js with `integrity=` + `crossorigin="anonymous"`; when a pinned version changes, recompute the sha384 hash. `pwa/sw.js` caches those CDN files with a CORS-mode request (an opaque copy cannot satisfy an integrity-checked script). `supabase/migrations/20261123000000_hardening.sql` (household/member limits, `private` helpers revoked; test `tests/sql/hardening_test.sql`). `supabase/functions/_shared/cors.ts` reads the optional `ALLOWED_ORIGINS` secret; `prices` limits each user to 20 calls a minute and every outbound fetch in `_shared/prices.ts` has an 8 s timeout. V1: `code.gs` `safeCell_()` prefixes `'` to text starting with `= + - @`; `bot.py` `authorized()` refuses everyone when `ALLOWED_TELEGRAM_ID` is unset. Public sign-ups must be off in Supabase (the app cannot enforce that).
- Hosting: `python scripts/deploy_pwa.py` (uploads a temp copy whose `_headers` pins `connect-src` to the host in `SUPABASE_URL`) uploads `pwa/` to Cloudflare Pages (`CLOUDFLARE_PAGES_PROJECT` in `.env`); `pwa/_headers` carries the content security policy, so new external hosts must be added there.
- Run locally with the `pwa` launch config (port 5173).
- `TelegramBot/bot.py` and the V1 `Dashboard/` still run on the Sheet. The Python bot only receives messages while no webhook is set.

## Working rules

- Never commit `.env`, `Dashboard/config.js` or `pwa/config.js`; never print their values. The repo is public; a scan of the tree and history found only placeholders (the first commit holds an old V1 Apps Script URL, not a secret by itself).
- `API_SECRET` ships to the browser in `config.js`, so the dashboard is only as private as its URL.
- The account list (`Ivan`, `Mely`, `Bersama`) is hard-coded in `bot.py`; keep it in sync with the dashboard and `code.gs`.
- Keep `README.md` and `setup.md` in step with behavior changes.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
