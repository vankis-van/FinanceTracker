# Software Requirements Specification (SRS)

**Project:** FinanceTracker
**Document version:** 1.2 (adds the gold price fallback, visual design, pickers and security hardening, V2.10 and V2.11)
**Date:** 2026-11-17
**Related:** [BRD.md](BRD.md), [../README.md](../README.md), [../setup.md](../setup.md)

---

## 1. Introduction

### 1.1 Purpose

This document specifies what FinanceTracker must do and the conditions it must meet. It covers both generations of the system:

- **V1** (in use): Google Sheet + Google Apps Script API, web dashboard, Python Telegram bot.
- **V2** (in progress): Supabase database, phone-first PWA, in-app scanning, bot as a webhook function.

Requirement IDs trace back to the business requirements (`BR-xx`) in the BRD.

### 1.2 Scope

FinanceTracker records a household's income, expenses, transfers and investments, reads receipts and payslips by OCR, and values gold and IDX stock holdings at live prices. It does not move money.

### 1.3 Definitions

| Term | Meaning |
| --- | --- |
| Household | The group whose data is shared. V2 data is scoped by `household_id`. |
| Account | A savings account the household tracks (V1: Ivan, Mely, Bersama). |
| Transaction | One row of type `income`, `expense`, `invest`, `transfer-out`, `transfer-in`, `loan-in` or `loan-out`. |
| Loan | Money taken out of one household account and lent to a household member (the borrower), who pays it back. Represented by a `loan-out` transaction on the account it came from. |
| Repayment | A `loan-in` transaction linked to a loan by `loan_id`. Raises the receiving account's balance and lowers the loan's outstanding amount. |
| Outstanding | A loan's amount minus its repayments dated on or before the day being looked at. |
| Transfer | Two linked transactions (`transfer-out` + `transfer-in`) sharing a `transfer_group`; excluded from income and expense totals. |
| Holding / lot | One purchase of gold (grams) or stock (shares) at a unit price. |
| Position | All lots of one asset combined, valued at weighted-average cost. |
| Realized P&L | `proceeds − cost basis` on a sale. |
| Unrealized P&L | `quantity × current price − cost basis` on a position still held. |
| LM | Ticker used for Antam gold ("Logam Mulia"); the brand goes in `name`. |
| Buyback price | The price Antam pays to buy gold back; used to value gold. |
| OCR | Optical character recognition of a photo into text and fields. |
| RLS | Postgres row-level security. |
| RPC | A Postgres function called through the Supabase API. |
| WIB | Western Indonesia Time (Asia/Jakarta, UTC+7). |

## 2. Overall description

### 2.1 System context

**V1**

```
Telegram Bot (Python) ─┐
                       ├──► Apps Script web app (/exec, API_SECRET) ──► Google Sheet
Web Dashboard ─────────┘           (Transactions, Holdings, Realized)
```

**V2**

```
PWA (Cloudflare Pages) ──► Supabase Auth + Postgres (RLS, RPCs)
         │                       ▲
         ├──► Edge Function: prices ──► muamalahemas.com, Emas API ID, Yahoo Finance
         ├──► Edge Function: ocr ─────► Gemini (optional)
         └──► On-device OCR (PaddleOCR in a Web Worker)

Telegram ──► Edge Function: telegram (webhook, shelved) ──► Postgres
Google Sheet ◄── nightly mirror / Sheets mode (planned)
```

### 2.2 Components

| Component | Location | Technology |
| --- | --- | --- |
| V1 API | `code.gs` | Google Apps Script |
| V1 database | Google Sheet (`Transactions`, `Holdings`, `Realized`) | Google Sheets |
| V1 dashboard | `Dashboard/` | HTML, CSS, vanilla JS, Chart.js |
| V1 bot | `TelegramBot/` | Python 3.12, pyTelegramBotAPI, requests, beautifulsoup4 |
| V2 database | `supabase/migrations/` | Supabase Postgres |
| V2 app | `pwa/` | HTML, CSS, vanilla JS (no build step), service worker, Chart.js |
| V2 scanning | `pwa/ocr-worker.js`, `pwa/receipt-parser.js` | PaddleOCR (`ppu-paddle-ocr@6.7.1`), onnxruntime-web |
| V2 functions | `supabase/functions/` (`prices`, `ocr`, `telegram`, `_shared`) | Deno / TypeScript |
| Tooling | `scripts/` | Python |

### 2.3 User classes

| Class | Permissions |
| --- | --- |
| Owner (V2) | Everything a member can do, plus rename or delete the household and add or remove members. |
| Member (V2) | Read and write all household data: transactions, accounts, categories, holdings, sales. |
| Holder of `API_SECRET` (V1) | Full read and write through the Apps Script API. |
| Telegram user (V1) | Full access through the bot, limited to `ALLOWED_TELEGRAM_ID`; the bot refuses everyone while it is unset. |

### 2.4 Operating environment

- Phone or desktop browser with ES2020, Service Workers, Web Workers and WebAssembly (current Chrome, Safari, Edge, Firefox).
- V1 bot: any machine running Python 3.12 with internet access.
- Supabase hosted project; Cloudflare Pages for the PWA.

### 2.5 Design constraints

- C-1: Free tiers only (BR-18).
- C-2: The PWA has no build step; libraries are pinned versions from jsDelivr, and supabase-js and Chart.js are loaded with integrity hashes (update the hash when the version changes).
- C-3: Price lookups happen server-side only, never from the browser.
- C-4: V1 writes are `POST` with a JSON body sent as `text/plain`, because Apps Script does not answer CORS preflights.
- C-5: V1 backend changes take effect only after redeploying the Apps Script web app.
- C-6: `SUPABASE_SECRET_KEY` (service role) is used only server-side. The browser receives only `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`.
- C-7: Every new external host used by the PWA must be added to the content security policy in `pwa/_headers`.
- C-8: All dates default to today in Asia/Jakarta.
- C-9: All amounts are IDR.

## 3. Functional requirements

Priority: **M** must, **S** should, **C** could. "Version" says where the requirement is met.

### 3.1 Authentication and household (V2)

| ID | Requirement | Pri | Version | Trace |
| --- | --- | --- | --- | --- |
| FR-AUTH-01 | Users sign in with email and password. The sign-in screen has a "Github Docs" button that opens the project documentation on GitHub (the emailed magic-link button was removed). | M | V2 | BR-13 |
| FR-AUTH-02 | A signed-in user with no household is taken to onboarding, which creates a household and its first accounts (`create_household(p_name, p_accounts)`); the creator becomes `owner`. | M | V2 | BR-16 |
| FR-AUTH-03 | An owner can add a member by email (`add_member_by_email`). The member must already have an account. | M | V2 | BR-13 |
| FR-AUTH-04 | Users can sign out from Settings. | M | V2 | BR-13 |
| FR-AUTH-05 | V1 API calls must carry `API_SECRET`; calls without it are rejected. | M | V1 | BR-13 |
| FR-AUTH-06 | When `ALLOWED_TELEGRAM_ID` is set, the V1 bot ignores every other Telegram user. | S | V1 | BR-13 |

### 3.2 Accounts and categories

| ID | Requirement | Pri | Version | Trace |
| --- | --- | --- | --- | --- |
| FR-ACC-01 | Users can create, rename, reorder and archive accounts, each with an opening balance. | S | V2 | BR-16 |
| FR-ACC-02 | Account balance = opening balance + income + transfer-in + loan-in − expense − invest − transfer-out − loan-out for that account. (`loan-in` and `loan-out` exist from V2.9 only; V1 has neither.) | M | V1, V2 | BR-03, BR-40 |
| FR-ACC-03 | V1 accounts are the fixed list `Ivan`, `Mely`, `Bersama`, kept in sync across `bot.py`, the dashboard and `code.gs`. | M | V1 | BR-03 |
| FR-ACC-04 | Users can create and rename categories. Deleting a category leaves its transactions uncategorised. | S | V2 | BR-16 |
| FR-ACC-05 | A transaction may have no account ("unassigned"), for example after its account is deleted. | S | V2 | BR-03 |

### 3.3 Transactions

| ID | Requirement | Pri | Version | Trace |
| --- | --- | --- | --- | --- |
| FR-TXN-01 | Users can add a transaction with type (`income`, `expense`, `invest`), amount (≥ 0), date, category, description and account. | M | V1, V2 | BR-01 |
| FR-TXN-02 | Date is optional (`YYYY-MM-DD`) and defaults to today (WIB). | M | V1, V2 | BR-17 |
| FR-TXN-03 | Each transaction records its `source` (`web`, `bot`, `ocr`, ...). | S | V1, V2 | BR-01 |
| FR-TXN-04 | Users can edit (V2: amount, type, description, category, account, date, from the transaction sheet; transfers cannot be edited) and delete (V1, V2) a transaction. In V2, deleting one leg of a transfer deletes both (matched on `transfer_group`). | M | V1, V2 | BR-11 |
| FR-TXN-05 | The transaction list can be searched by text, filtered by type, category and account, sorted, and paginated. | M | V1, V2 | BR-11 |
| FR-TXN-06 | V1 transaction IDs follow `TXN-...` for entries and `TRF-...` for transfers. | M | V1 | BR-19 |

### 3.4 Transfers

| ID | Requirement | Pri | Version | Trace |
| --- | --- | --- | --- | --- |
| FR-TRF-01 | A transfer from account A to account B of amount X writes two rows: `transfer-out` on A and `transfer-in` on B, sharing a `transfer_group`. | M | V1, V2 | BR-02 |
| FR-TRF-02 | Both rows are written atomically (V2: `add_transfer` RPC). | M | V2 | BR-02 |
| FR-TRF-03 | From and to accounts must differ; amount must be > 0. | M | V1, V2 | BR-02 |
| FR-TRF-04 | Transfers are excluded from income, expense and savings-rate figures. | M | V1, V2 | BR-02 |
| FR-TRF-05 | An optional note is appended to both rows' descriptions. | C | V1, V2 | BR-02 |

### 3.5 Investments

| ID | Requirement | Pri | Version | Trace |
| --- | --- | --- | --- | --- |
| FR-INV-01 | Users can add a holding: asset type (`gold`, `stock`), ticker, name, quantity (> 0, grams or shares), unit buy price (≥ 0), buy date. | M | V1, V2 | BR-07 |
| FR-INV-02 | Gold is stored with ticker `LM` and the brand (e.g. "Antam") in `name`. | M | V1, V2 | BR-09 |
| FR-INV-03 | Lots of the same asset are combined into a position at weighted-average cost. | M | V1, V2 | BR-07 |
| FR-INV-04 | The portfolio shows, per position and in total: quantity, average cost, current price, market value, unrealized P&L and P&L %. | M | V1, V2 | BR-07 |
| FR-INV-05 | When live prices are unavailable, positions are valued at cost and the UI says so. | M | V2 | BR-07 |
| FR-INV-06 | Users can sell a quantity of a position at a unit price into an account. The sale consumes lots oldest first, rejects selling more than is held, and records quantity, average buy price, sell price, proceeds, cost basis and realized P&L (`sell_holding` RPC in V2; `sellHolding` in V1). | M | V1, V2 | BR-08 |
| FR-INV-07 | A sale also writes an income transaction (category "Asset Sale") for the proceeds into the chosen account. | M | V1, V2 | BR-08 |
| FR-INV-08 | Users can list realized sales with totals. | M | V1, V2 | BR-08 |
| FR-INV-09 | Users can delete a position entered by mistake (all its lots, two taps). No sale is recorded and any invest transaction is kept. | S | V1, V2 | BR-07 |
| FR-INV-09 | Users can delete a holding lot. | M | V1, V2 | BR-07 |

### 3.6 Pricing

| ID | Requirement | Pri | Version | Trace |
| --- | --- | --- | --- | --- |
| FR-PRC-01 | Gold is priced at the Antam 1 g buyback price per gram scraped from muamalahemas.com (a reseller's rate). | M | V1, V2 | BR-09 |
| FR-PRC-02 | Stocks are priced from Yahoo Finance; `.JK` is appended to the ticker automatically. Prices may be about 15 minutes delayed. | M | V1, V2 | BR-09 |
| FR-PRC-03 | Prices are fetched only by the bot, Apps Script or the `prices` Edge Function, never from the browser. | M | V1, V2 | C-3 |
| FR-PRC-04 | `TelegramBot/diagnose.py` checks gold-pricing connectivity. | C | V1 | BR-09 |
| FR-PRC-05 | The Portfolio page has a **Sync prices** button that asks the `prices` function again for the held stocks and gold, shows when prices were last updated, and says if the gold or a stock price could not be fetched. Prices also load when the app opens. Taps within 15 seconds of an update are ignored to protect the gold API's rate limit. | S | V2.8 | BR-09 |
| FR-PRC-06 | When that page is unreachable or its layout changed, gold falls back to Emas API ID (`EMAS_API_KEY`). The page is read by `scripts/gold_scraper.py` for the V1 bot and `goldFromPage()` in `_shared/prices.ts` for the Edge Functions. For a past day the page counts only if it was published on or before that day and within 7 days; otherwise the API is asked. The Python fallback reports `fallback_reason`. | S | V2.15 | BR-09 |
| FR-PRC-07 | The `prices` function answers signed-in users only, allows each user 20 calls a minute, and gives every outbound lookup an 8-second timeout. | S | V2.11 | BR-09 |

### 3.7 Reports

| ID | Requirement | Pri | Version | Trace |
| --- | --- | --- | --- | --- |
| FR-RPT-01 | The home screen shows total balance, balance per account, and this month's income and expense. | M | V1, V2 | BR-03, BR-10 |
| FR-RPT-02 | The stats screen offers periods: this month, last month, this year, all. | M | V2 | BR-10 |
| FR-RPT-03 | For the chosen period it shows income, expense, savings rate (`(income − expense) / income`) and a donut chart of expenses by category. | M | V1, V2 | BR-10 |
| FR-RPT-04 | A bar chart shows income and expense for the last 6 months. | S | V2 | BR-10 |
| FR-RPT-05 | Amounts are formatted as Rupiah (`id-ID` locale). | M | V1, V2 | BR-17 |
| FR-RPT-06 | `loan-in` and `loan-out` rows are excluded from income, expense, savings-rate, category and 6-month figures, as transfers are. The Activity list shows them with their own label ("Loan given", "Loan repayment") and the borrower. | M | V2.9 | BR-41 |

### 3.8 Scanning (OCR)

| ID | Requirement | Pri | Version | Trace |
| --- | --- | --- | --- | --- |
| FR-OCR-01 | Receipt mode: a photo yields merchant (description), total amount and date, saved as an expense after the user picks category and account. | M | V1, V2 | BR-04 |
| FR-OCR-02 | Payslip mode: a photo yields net take-home pay and pay date, saved as income. | S | V1, V2 | BR-05 |
| FR-OCR-03 | History mode: a screenshot of a transaction list yields many rows. Each row is shown for review (keep / rename / skip, category, account) before saving. | S | V1, V2 | BR-06 |
| FR-OCR-04 | Every scanned entry passes a review step before it is saved; nothing is saved automatically. | M | V1, V2 | BR-04 |
| FR-OCR-05 | Malformed or future dates read by OCR are discarded and the entry falls back to today. | M | V1, V2 | BR-17 |
| FR-OCR-06 | V2 scans on the device by default: PaddleOCR in a Web Worker returns text lines with boxes, and `ReceiptParser.parse(mode, lines, ctx)` turns them into rows using rules only. | M | V2 | BR-04, BR-18 |
| FR-OCR-07 | V2 offers an optional "smart" scan through the `ocr` Edge Function (Gemini), limited to 30 scans per user per day (`use_ocr_scan()`); the limit resets at midnight WIB. | S | V2 | BR-18 |
| FR-OCR-08 | If the on-device engine cannot start (offline on first use, old browser) or takes longer than 90 seconds, the scan fails with a clear message and the user can retry or use the smart scan. | S | V2 | BR-04 |
| FR-OCR-11 | During review every field of a scanned row (amount, description, category, account, date, type) is editable; after saving, the entry can still be edited like any other transaction (FR-TXN-04). | M | V2 | BR-04 |
| FR-OCR-12 | While a smart read (Gemini) is running, the Scan sheet shows a loading panel instead of the small spinner: a preview of the photo being read with a slow scan line over it (a still preview under reduced-motion), a status line that follows the real steps ("Preparing the photo", then "Asking Gemini" with the seconds waited), a note after 15 seconds ("Taking longer than usual") and a **Cancel** button. The photo picker, mode chips and Try smart read button are disabled so a second request cannot start. After 45 seconds with no answer the wait stops with a clear message and a Try again button; Cancel and the timeout stop the app waiting, but the request may still count towards the daily limit (FR-OCR-07), and the panel says so. A failed or empty read returns to the picker with the photo kept for a retry. The on-device read keeps its current small indicator. | S | V2.14 | BR-18 |
| FR-OCR-09 | Scanned entries are saved with `source = "ocr"`. Photos are not stored. | M | V2 | BR-04 |
| FR-OCR-10 | V1 OCR uses Gemini (`gemini-2.5-flash`) by default; `OCR_PROVIDER` can switch to Anthropic. | S | V1 | BR-04 |

### 3.9 Offline (V2)

| ID | Requirement | Pri | Version | Trace |
| --- | --- | --- | --- | --- |
| FR-OFF-01 | The service worker caches the app shell so the app opens without a network. Cache name is set by `VERSION` in `pwa/sw.js` and must change whenever shell files change. | M | V2 | BR-14 |
| FR-OFF-02 | The last loaded data is cached locally and shown with an "Offline" banner when the network is down. | M | V2 | BR-14 |
| FR-OFF-03 | New transactions entered offline are queued locally and synced automatically when back online; the user is told how many synced. | M | V2 | BR-14 |
| FR-OFF-04 | Settings shows the number of entries waiting to sync. | S | V2 | BR-14 |
| FR-OFF-05 | The app is installable (web app manifest, icons 192/512, Apple touch icon). | S | V2 | BR-14 |

### 3.10 Telegram bot

| ID | Requirement | Pri | Version | Trace |
| --- | --- | --- | --- | --- |
| FR-BOT-01 | Commands: `/add`, `/payslip`, `/history`, `/portfolio`, `/sell`, `/realized`, `/accounts`, `/transfer`, `/summary`, `/recent`. Sending a photo with no pending mode is treated as a receipt. | S | V1 | BR-15 |
| FR-BOT-02 | `/add <type> <amount> <description> [category]` then asks for the account. | S | V1 | BR-15 |
| FR-BOT-03 | `/sell <ticker> <qty> <price> <account>` sells a holding; `/transfer <from> <to> <amount> [note]` records a transfer. | S | V1 | BR-15 |
| FR-BOT-04 | `/summary` shows this month's totals; `/recent` the last 5 transactions; `/accounts` each balance. | S | V1 | BR-15 |
| FR-BOT-05 | V2 bot runs as the `telegram` Edge Function webhook, guarded by `TELEGRAM_WEBHOOK_SECRET`, deployed with `--no-verify-jwt`. | C | V2 (shelved) | BR-15 |
| FR-BOT-06 | V2 linking: Settings creates a one-time code valid for 10 minutes (`create_telegram_link_code`); the user sends `/link CODE`. A new code replaces earlier ones. | C | V2 (shelved) | BR-13 |
| FR-BOT-07 | V2 bot conversation state (pending entry, review queue, next-photo mode) is stored in `telegram_state.state`. | C | V2 (shelved) | BR-15 |
| FR-BOT-08 | The V2 bot uses the service role, so every query must filter by the linked `household_id`. | M | V2 (shelved) | BR-13 |
| FR-BOT-09 | The Settings Telegram row is hidden unless `TELEGRAM_BOT` is set in `pwa/config.js`. | C | V2 | BR-15 |

### 3.11 Data migration and mirroring

| ID | Requirement | Pri | Version | Trace |
| --- | --- | --- | --- | --- |
| FR-MIG-01 | `scripts/import_sheet_to_supabase.py` imports V1 transactions, holdings and realized sales into a household. | M | V2 | BR-19 |
| FR-MIG-02 | Imported rows keep their V1 ID in `legacy_id`; re-running the import updates matching rows instead of duplicating them. | M | V2 | BR-19 |
| FR-MIG-03 | A household's `data_source` can be `supabase` (default) or `sheets`. | S | V2 | BR-12 |
| FR-MIG-04 | A nightly job mirrors Supabase data to the Google Sheet. | S | Planned | BR-12 |

### 3.12 Monthly ledger closing (V2.4, built)

A *period* is one calendar month in Asia/Jakarta time. A period is **open** until the owner closes it; the system never closes it automatically (BR-21).

| ID | Requirement | Pri | Version | Trace |
| --- | --- | --- | --- | --- |
| FR-CLS-01 | For any period the app shows a draft closing statement computed live from the data: per account the opening balance, income, expense, invest, transfer-in, transfer-out and closing balance; household totals; savings rate; expenses by category; realized P&L of sales in the period; portfolio market value and unrealized P&L at the time of viewing. | M | V2 | BR-20 |
| FR-CLS-02 | Only an `owner` can close a period. Closing is a deliberate action: the owner opens the statement, completes the checklist and confirms "Close month". | M | V2 | BR-21 |
| FR-CLS-03 | A period can be closed only after it has ended (on or after the 1st of the next month, WIB), and only in order: the first close may be any finished month (everything before it becomes the opening balance and is locked with it); after that, only the month right after the latest closed one. | M | V2 | BR-21, BR-25 |
| FR-CLS-04 | The closing checklist shows the number of entries in the period and flags transactions in the period with no category; with no account; entries waiting in the offline queue on this device. Items are warnings; the owner may close with them, and the count is saved with the statement. | M | V2 | BR-22 |
| FR-CLS-05 | For each account the owner enters the actual bank balance at month end. The app shows the difference against the recorded closing balance. A non-zero difference must be either fixed (add an adjusting entry, category "Adjustment") or accepted with a note before closing. | M | V2 | BR-22 |
| FR-CLS-06 | Closing (`close_period(p_household, p_month)` RPC) runs in one transaction: it recomputes the figures, stores them as an immutable snapshot in `ledger_closings` and `ledger_closing_accounts`, and marks the period `closed` with who closed it and when. | M | V2 | BR-23 |
| FR-CLS-07 | While a period is closed, the database refuses inserts, updates and deletes of `transactions` and `sales` whose `date` falls in it, and of transfers or sales that would write a leg into it. The check is a database trigger, so it applies to every client (PWA, bot, import). The error message names the closed month. | M | V2 | BR-23 |
| FR-CLS-08 | The opening balance of a period equals the closing balance of the previous closed period for each account; for the first period it is the account's `opening_balance`. | M | V2 | BR-25 |
| FR-CLS-09 | An owner can reopen the most recent closed period (`reopen_period`), giving a reason. The reopen is logged in `ledger_closing_events` (who, when, reason). The old snapshot is kept as a previous version; closing again creates a new version. Reopening an earlier period requires reopening the later ones first. | S | V2 | BR-24 |
| FR-CLS-10 | A "Statements" list shows every period with status (running, ready to close, open, closed, locked before the first close) and the closing date and version; a closed month also shows its close/reopen history. Opening a closed one shows its stored snapshot, not live figures. | S | V2 | BR-26 |
| FR-CLS-11 | A closed statement can be printed or saved as PDF (print stylesheet) and exported as CSV (summary and transactions). | S | V2 | BR-26 |
| FR-CLS-12 | The owner is reminded on the last day of the month from 16:00 WIB (the last scheduled check of the day), and on days 1, 3 and 7 of the next month while the previous month is still open. Uses the notification channel of section 3.14. | S | V2.5 | BR-27 |
| FR-CLS-13 | Investment holdings are not locked by closing; the statement stores their market value and unrealized P&L at the moment of closing. | M | V2 | BR-20 |
| FR-CLS-14 | V1 (Sheet) has no closing; the feature is V2 only. | M | V2 | — |
| FR-CLS-15 | Each per-account row of the statement also carries `loan_in` (repayments received) and `loan_out` (loans given), so that closing = opening + income + transfer_in + loan_in − expense − invest − transfer_out − loan_out. Loan lines are shown apart from income and expense and are not part of the savings rate. | M | V2.9 | BR-20, BR-41 |
| FR-CLS-16 | The statement has a **Loans outstanding** section: every loan dated on or before the last day of the period whose outstanding amount at that day is above zero. Per loan: borrower, original amount, lent in the period, repaid in the period, repaid to date, outstanding at period end, due date. Below it, the total outstanding. The draft computes it live (`period_statement`); closing stores it in `ledger_closings.loans` (JSON) with `loans_outstanding` (total), and a closed statement shows the stored copy. | M | V2.9 | BR-45 |
| FR-CLS-17 | A loan fully repaid on or before the last day of the period does not appear in that period's Loans section, but a loan repaid later still appears in every earlier statement in which it was unpaid. Repayments dated after the period end never change a closed statement. | M | V2.9 | BR-45 |
| FR-CLS-18 | The statement shows two charts under the summary: **Expenses by account** (one horizontal bar per account with expense above zero, from the accounts list the statement already has) and **Expenses by category** (a doughnut of the top six categories plus "Other", from `by_category`), each with the figures listed as text beneath it. They work for a draft and for a closed statement (stored snapshot), need no extra query and are skipped when the month has no expenses. Plan payments (FR-PLN-22) are ordinary expenses and are included. The charts print with the statement (FR-CLS-11). | S | V2.13 | BR-55 |
| FR-CLS-19 | The plan section of the statement adds per plan `spent` (this month) and `spent_total` (to date); `saved` includes `spent_total`. `private.plan_figures` returns them, `ledger_closings.plans` stores them, and the CSV export gains "Spent this month" and "Spent to date" columns. Snapshots closed before V2.13 have no such keys and show 0; they are never recalculated. | C | V2.13 | BR-54 |

### 3.13 Plans (V2.5, plan ledger V2.6)

| ID | Requirement | Pri | Version | Trace |
| --- | --- | --- | --- | --- |
| FR-PLN-01 | Users can create a plan with: name (required), target amount (> 0, required), target date (required, in the future), icon (emoji), note, linked account (optional), and start date (default today). | M | V2.5 | BR-28 |
| FR-PLN-02 | Users can edit any field of a plan and delete a plan that has no ledger entries and no assigned holdings. A plan with either can only be cancelled. | M | V2.5 | BR-28, BR-31 |
| FR-PLN-03 | Users can add a contribution (amount > 0, date, note) and delete one. Optionally a contribution can be linked to an existing transaction (for example a transfer into the savings account); a transaction can fund only one contribution. | M | V2.5 | BR-29 |
| FR-PLN-04 | For each plan the app computes: `saved` = plan cash (deposits − withdrawals + adjustments) + value of assigned gold and stocks (FR-PLN-16); `progress` = saved ÷ target (capped at 100% for display); `remaining` = max(target − saved, 0); `months_left` = whole months from today to the target date (minimum 1); `monthly_needed` = remaining ÷ months_left. | M | V2.5 | BR-30 |
| FR-PLN-05 | Status: **achieved** when saved ≥ target; **behind** when saved < target × (elapsed days ÷ total days between start and target date) − 5% of target; **on track** otherwise; **overdue** when the target date has passed and the plan is not achieved. Paused and cancelled plans show those statuses instead. | M | V2.5 | BR-30 |
| FR-PLN-06 | A "Plans" screen lists active plans with a progress bar, saved / target, monthly needed and status; achieved, paused and cancelled plans are in a separate collapsed list. Tapping a plan opens its detail with contribution history and a progress chart over time. | M | V2.5 | BR-30 |
| FR-PLN-07 | Users can pause, resume, mark achieved (even below target) or cancel a plan. Paused plans get no "behind" or reminder notifications. | S | V2.5 | BR-31 |
| FR-PLN-08 | The Home screen shows the top 3 active plans by nearest target date. | C | V2.5 | BR-30 |
| FR-PLN-09 | Notifications for a plan (see 3.14): milestone at 25%, 50%, 75% and 100% (each sent once); status turned to behind (once per change); target date 30 days and 7 days away; overdue; a monthly reminder on the 25th showing the amount still needed this month. | M | V2.5 | BR-32 |
| FR-PLN-10 | Plans are household data: all members can see and contribute; notifications go to the owner, and to other members who turn them on. | S | V2.5 | BR-28, BR-33 |
| FR-PLN-11 | The closing statement lists, per plan: cash at the start of the period, money added, taken out and adjusted, cash at the end, the value of assigned gold and stocks, `saved` and progress at period end, and whether the gold and stocks were valued at market price or at cost (`assets_priced`). | C | V2.5, V2.6 | BR-34, BR-38 |
| FR-PLN-12 | Plan ledger entries dated in a closed period follow the same lock as transactions (FR-CLS-07). The "set null" that follows a sold lot or a deleted transaction still passes. | S | V2.5 | BR-23 |
| FR-PLN-13 | Each plan has a ledger (`plan_ledger`). Entry types: `deposit` (amount > 0), `withdrawal` (amount < 0), `adjustment` (either sign, not 0), `asset_in` and `asset_out` (a holding assigned or released: quantity, price, amount = quantity × price). A plan's cash (deposits, withdrawals, adjustments) can never go below zero. Users add and remove cash entries in open months; asset entries are written only by the assign, release and sale functions. | M | V2.6 | BR-36 |
| FR-PLN-14 | Users can take money out of a plan (amount up to the plan's cash, date, note). This records the movement in the plan only; it creates no transaction and moves no money between accounts. | S | V2.6 | BR-36 |
| FR-PLN-15 | Users can assign gold or stocks they hold to a plan: choose a lot, a quantity not above what is still free (not assigned to other plans), a date and optionally the price to record (default: the live price, else the lot's cost). They can release it again. A lot can be split across several plans. | S | V2.6 | BR-37 |
| FR-PLN-16 | Assigned holdings are valued at the live price when prices are connected and at cost otherwise, and the plan screen says which. The database does not know live prices: notification checks (milestones, behind, achieved) use cost by design, so they react to money put in or taken out and not to price swings; the plan screen says so. | S | V2.6 | BR-37, BR-30 |
| FR-PLN-17 | When a lot is sold or deleted, the sold quantity is taken out of the plans it was assigned to (newest assignment first) and an `asset_out` entry is written. For a sale (not a plain delete), the proceeds of the sold quantity (quantity × sell price) are also added to each plan's cash as a `deposit` entry ("Sale proceeds: ...") dated today (or the first open day), so the value moves from the asset to cash. Cancelled plans get no deposit. | S | V2.7 | BR-37 |
| FR-PLN-18 | A plan is a set-aside on its account, not an account. `account_earmarks()` returns the cash set aside per account (plans that are not cancelled). The app shows, per account, balance, set aside, and free to spend = balance − set aside. Gold and stocks are not cash accounts and are not part of the set-aside. | M | V2.6 | BR-35 |
| FR-PLN-19 | After an expense or investment is saved, the app warns when the account's balance is below the amount set aside. It does not block the entry. | C | V2.6 | BR-39 |
| FR-PLN-20 | Before an owner closes a month, the app fetches the market price of the **last day of that month** for every asset assigned to a plan (the closing price of the last trading day on or before it for stocks; the last Antam buyback on or before it, up to 7 days back, for gold) and saves it with `set_month_end_prices()` (owner only, refused for a closed month), together with the day the price is for (`price_date`). The statement values assigned holdings with those prices and shows the day (`prices_on`). If a month-end price cannot be fetched, today's price is saved instead and the statement shows that day; without any saved price it uses cost and says so. | C | V2.6, V2.7 | BR-38 |
| FR-PLN-21 | Plan ledger entry type `spend`: amount < 0 and a required `transaction_id` pointing at the expense it created. It counts as cash leaving the plan (the cash-never-below-zero rule of FR-PLN-13 applies) and as progress (FR-PLN-23). Written only by `spend_from_plan()` and removed only by `delete_plan_spend()`. | S | V2.13 | BR-51 |
| FR-PLN-22 | `spend_from_plan(p_plan, p_account, p_category, p_amount, p_date, p_note)` runs in one database transaction: it inserts an `expense` transaction on the chosen account (default: the plan's linked account) and the `spend` entry. It refuses a cancelled plan, an amount above the plan's cash, an account or category of another household and a date in a closed month (FR-CLS-07). Gold and stocks cannot be spent directly: they are sold first and the proceeds land in plan cash (FR-PLN-17). | S | V2.13 | BR-51 |
| FR-PLN-23 | `saved` = plan cash + value of gold and stocks + spent to date (`-sum(amount)` of `spend` entries). `progress`, `remaining`, `monthly_needed`, status (FR-PLN-05) and the notification checks (FR-PLN-09) use this `saved`. Example: target 30 juta, cash 30 juta, one spend of 5 juta: cash 25 juta, spent 5 juta, saved 30 juta. The plan screen shows cash, spent and assets as separate lines. Take out (FR-PLN-14) does not add to spent. | S | V2.13 | BR-52 |
| FR-PLN-24 | The linked expense and the `spend` entry live and die together: deleting either one from the app deletes both (a trigger covers a delete of the transaction made elsewhere). Amount, account and date of the linked expense cannot be edited from Activity (change them through the plan); category and description can. `account_earmarks()` is unchanged: cash falls by the same amount as the account balance, so free to spend stays the same. | S | V2.13 | BR-53 |
| FR-PLN-25 | The plan screen has a **Pay from plan** action next to Take out: amount, account, category, date, note. It shows the plan's cash and the account's balance, and after saving the new cash, spent and progress. The ledger lists spend rows as "Spent: note" with the account name. | S | V2.13 | BR-51, BR-52 |
| FR-PLN-26 | When the user marks a plan achieved or cancels it, a confirmation sheet lists what is still tied to the plan: cash left ("Rp X is still set aside") and each assigned holding (quantity and current value). Each item has a choice, **Release** or **Keep**; release is pre-selected when cancelling and keep when marking achieved. Releasing cash writes a `withdrawal` (Take out, "Plan closed") dated today and releasing a holding writes an `asset_out` entry and removes the assignment, both dated today or the first open day if the month is closed. Nothing is released automatically, and the status change works with every item kept. | S | V2.13 | BR-56 |
| FR-PLN-27 | Cash left in an achieved plan stays set aside (FR-PLN-18) and gold and stocks stay assigned until released, so the plan screen of an achieved or cancelled plan shows a "Release" action for them. A cancelled plan accepts no new money or assets, and Pay from plan is refused for it (FR-PLN-22); an achieved plan can still be paid from. | S | V2.13 | BR-56 |
| FR-PLN-28 | A cancelled plan is labelled "Cancelled at N%", where N is its progress (FR-PLN-23, spent included) when it was cancelled; the plan list and the statement show it. Payments already made from the plan stay as expenses and as its spent total. | C | V2.13 | BR-56 |

### 3.14 Notifications (V2.5; in-app only, Web Push dropped)

| ID | Requirement | Pri | Version | Trace |
| --- | --- | --- | --- | --- |
| FR-NTF-01 | A scheduled job (Supabase `pg_cron` calling `run_notifications()`) runs every day at 08:00, 12:00 and 16:00 WIB and works out which plan and closing notifications are due. The app runs the same check for its household when it opens (`check_notifications()`), so nothing depends on the schedule alone. | M | V2.5 | BR-27, BR-32 |
| FR-NTF-02 | Each notification is written to a `notifications` table first (user, kind, title, body, link, created_at, read_at), then delivered. A unique key per (user, kind, subject, period) prevents duplicates. | M | V2.5 | BR-32 |
| FR-NTF-03 | Delivery channels: the in-app list only. Web Push (`push_subscriptions`, VAPID keys) and a Telegram message were planned and are dropped; the table and `save_push_subscription()` stay unused. | M | Dropped | BR-33 |
| FR-NTF-04 | The app shows an in-app notification list (bell icon with unread count) so nothing is lost when push is blocked. | M | V2.5 | BR-33 |
| FR-NTF-05 | Settings lets each user turn each kind (plan milestones, plan behind, plan deadlines, monthly plan reminder, month-close reminder) on or off. The per-device push switch was dropped with Web Push. | S | V2.5 | BR-33 |
| FR-NTF-06 | Tapping a notification opens the related plan or statement. | S | V2.5 | BR-33 |
| FR-NTF-07 | On iPhone, push is only offered once the app is installed to the home screen; the app explains this. | S | Planned | BR-33 |
| FR-NTF-08 | Milestone and achieved notifications are also checked immediately after a contribution is saved, not only by the daily job. | S | V2.5 | BR-32 |

### 3.14a Loans (V2.9)

V2 only. A loan is money lent from a household account to a household member. The money itself is a `loan-out` transaction on the account it came from; each repayment is a `loan-in` transaction on the account that receives it. Both carry `loan_id`, so balances, the month lock (FR-CLS-07) and the activity list work without special cases. The `loans` table holds the terms.

| ID | Requirement | Pri | Version | Trace |
| --- | --- | --- | --- | --- |
| FR-LON-01 | Users can add a loan (`add_loan` RPC) with: account (required, the money leaves it), amount (> 0, required), date (default today WIB, not in a closed month), borrower (required, a household member), due date (optional, not before the loan date) and note. In one transaction it writes the `loans` row and a `loan-out` transaction for the amount, so the account balance falls by the amount. | M | V2.9 | BR-40 |
| FR-LON-02 | The borrower must be a current member of the household (`members`). The borrower is the person who owes the money; it does not change which account is used. | M | V2.9 | BR-40 |
| FR-LON-03 | Users can add a repayment to a loan (`add_loan_payment` RPC): amount (> 0), date (default today, not before the loan date, not in a closed month), receiving account (required; the app offers the loan's own account first) and note. It writes a `loan-in` transaction with the loan's `loan_id`. A repayment may be partial. The amount may not exceed the loan's outstanding amount at the time of saving; the error says how much is still owed. | M | V2.9 | BR-42 |
| FR-LON-04 | A loan's `repaid` = sum of its `loan-in` transactions; `outstanding` = amount − repaid. Status is `open` while outstanding > 0 and `paid` when it reaches 0, set by the database from the repayments, not typed in. Deleting a repayment reopens a paid loan. | M | V2.9 | BR-43 |
| FR-LON-05 | `loan-in` and `loan-out` rows are excluded from income, expense and savings rate (FR-RPT-06) and from category totals. They are included in account balances (FR-ACC-02). They are created, changed and removed only by the loan RPCs: a trigger on `transactions` (`guard_loan_txn`) refuses any direct insert, update or delete of these two types, and the ordinary add form does not offer them. | M | V2.9 | BR-41 |
| FR-LON-06 | A **Loans** screen (opened from Home or Settings) lists open loans first, each with borrower, original amount, repaid, outstanding, due date and a progress bar, with the total outstanding on top. A filter selects one borrower. Paid loans are in a separate collapsed list. Tapping a loan opens its detail with the repayment history, a **Record a repayment** action and Edit / Delete where allowed. | M | V2.9 | BR-44 |
| FR-LON-07 | Edit: while a loan has no repayments and its date is in an open month, any field can change (including amount, account and borrower; the linked `loan-out` follows). With repayments, only borrower, due date and note can change. Delete: only a loan with no repayments, in an open month (`delete_loan` removes the loan and its `loan-out`). A repayment can be deleted in an open month (`delete_loan_payment`). | S | V2.9 | BR-47 |
| FR-LON-08 | Loan entries dated in a closed month cannot be added, edited or deleted (FR-CLS-07 applies to the linked transactions). Loan terms that do not touch money (due date, note, borrower) can still be edited. | M | V2.9 | BR-46 |
| FR-LON-09 | Deleting an account that holds loan transactions follows DR-2 (the reference is set to null; the loan stays). Archiving is preferred and the app says so. | S | V2.9 | BR-40 |
| FR-LON-10 | Home shows the total outstanding for the household; the Loans filter by borrower shows what each member still owes. | S | V2.9 | BR-49 |
| FR-LON-11 | Notifications (FR-NTF) for loans, to the owner and to members who turn them on: due date 7 days away, and overdue (once, then weekly while still unpaid). Kinds `loan_due` and `loan_overdue`; they join the notification settings as one switch. | C | V2.9 | BR-48 |
| FR-LON-12 | Loans and repayments need a connection. They are not put in the offline queue (a repayment depends on the loan's current balance); offline, the form shows "You are offline. Try again when connected." | S | V2.9 | BR-14 |
| FR-LON-13 | The statement checklist (FR-CLS-04) shows a line with the number of unpaid loans and their total, for information. They do not block closing. | S | V2.9 | BR-45 |
| FR-LON-14 | CSV export of a closed statement (FR-CLS-11) includes the Loans outstanding section. | S | V2.9 | BR-26, BR-45 |
| FR-LON-15 | The app refuses a new loan larger than the chosen account's current balance and says what the account holds. The database does not enforce this. | S | V2.9 | BR-50 |

### 3.15 V1 API (Apps Script)

All calls go to the `/exec` URL with `?action=...` and the shared secret.

| Method | Action | Purpose |
| --- | --- | --- |
| GET | `read` | List transactions. |
| GET | `summary` | Totals for the current month. |
| GET | `accounts` | Balance per account. |
| GET | `holdings` | List holding lots. |
| GET | `portfolio` | Positions valued at live prices. |
| GET | `realized` | Realized sales. |
| POST | `add` | Add a transaction (optional `date`). |
| POST | `transfer` | Add a transfer (two rows). |
| POST | `delete` | Delete a transaction or transfer. |
| POST | `addHolding` | Add a holding lot. |
| POST | `deleteHolding` | Delete a holding lot. |
| POST | `sellHolding` | Sell, record realized P&L and proceeds. |

### 3.16 V2 server functions

| Name | Kind | Purpose |
| --- | --- | --- |
| `create_household(p_name, p_accounts)` | RPC | New household, owner membership, initial accounts. Refused past 3 households per user, a name over 80 characters, more than 30 accounts or an account name over 60 characters. |
| `add_member_by_email(p_household, p_email)` | RPC | Owner adds an existing user; refused past 10 members. An unknown address gets a generic message, which does not hide whether an account exists, so public sign-ups must be off. |
| `add_transfer(p_household, p_from, p_to, p_amount, p_date, p_note, p_source)` | RPC | Atomic two-leg transfer. |
| `sell_holding(p_household, p_quantity, p_sell_price, p_account, p_holding, p_ticker, p_name, p_date, p_source)` | RPC | Sale across lots, sale record, proceeds transaction. |
| `use_ocr_scan()` / `use_ocr_scan_for(p_user)` | RPC | Count a smart scan; refuse past 30 a day. |
| `create_telegram_link_code(p_household)` | RPC | One-time bot link code. |
| `prices` | Edge Function | Current gold and stock prices for the household's holdings, or for a past `date`. Signed-in users only, 20 calls a minute per user, 8-second timeouts, gold API fallback (FR-PRC-06). |
| `ocr` | Edge Function | Gemini-based scan of a photo. Signed-in users only, 30 a day. `prices` and `ocr` answer only the origins in the optional `ALLOWED_ORIGINS` secret (any origin when it is unset). |
| `telegram` | Edge Function | Bot webhook (shelved). |
| `close_period(p_household, p_month, p_bank, p_notes, p_note, p_portfolio_value, p_unrealized)` | RPC | Owner-only month close: checks bank balances, stores the snapshot, locks the month. |
| `reopen_period(p_household, p_month, p_reason)` | RPC | Owner-only reopen of the latest closed month, logged. |
| `period_statement(p_household, p_month)` | RPC | Live draft figures for a month (same maths as the snapshot), plus `can_close` and `blocked_reason`. |
| `check_notifications(p_household)` | RPC | Runs the daily plan and month-close checks for the household when the app opens; returns the caller's unread count. |
| `run_notifications()` | RPC | Called by `pg_cron` at 08:00, 12:00 and 16:00 WIB for every household; trims old notifications. |
| `save_push_subscription(p_endpoint, p_p256dh, p_auth, p_user_agent)` | RPC | Stores a Web Push subscription. Unused: Web Push was dropped. |
| `assign_holding_to_plan(p_plan, p_holding, p_quantity, p_price, p_date)` | RPC | Earmark a quantity of a lot for a plan; writes an `asset_in` entry. |
| `unassign_holding_from_plan(p_plan, p_holding, p_quantity, p_price, p_date)` | RPC | Release a lot (all of it when no quantity is given); writes an `asset_out` entry. |
| `account_earmarks(p_household)` | RPC | Cash set aside for plans, per account. |
| `set_month_end_prices(p_household, p_month, p_prices)` | RPC | Owner-only: saves market prices (each with its `price_date`) used to value plan assets in a month's statement. |
| `add_loan(p_household, p_account, p_amount, p_borrower, p_date, p_due_date, p_note, p_source)` | RPC | Atomic: writes the loan and its `loan-out` transaction. Checks the borrower is a member and the month is open. Returns the loan id. |
| `update_loan(p_loan, p_fields)` | RPC | Edits a loan under the rules of FR-LON-07 / FR-LON-08. |
| `delete_loan(p_loan)` | RPC | Deletes a loan with no repayments, and its `loan-out`. |
| `add_loan_payment(p_loan, p_account, p_amount, p_date, p_note, p_source)` | RPC | Writes a `loan-in` transaction; refuses more than the outstanding amount; refreshes the loan status. |
| `delete_loan_payment(p_txn)` | RPC | Removes a repayment in an open month and refreshes the loan's status. |
| `household_members(p_household)` | RPC | Members with their email (user id, role, email), for the borrower picker. Members only. |
| `private.loan_figures(p_household, p_month)` | internal | Loans unpaid at month end, as JSON. Used by `period_statement` and by the closing snapshot trigger. |
| `private.my_households()` | internal | The signed-in user's household ids; used by the row-level security policies. |
| `notify` | Edge Function (dropped) | Was planned to send Web Push / Telegram. Not built; checks run in the database (`run_notifications()`). |

## 4. Data requirements

### 4.1 V2 data model

| Table | Key columns | Notes |
| --- | --- | --- |
| `households` | `id`, `name`, `data_source` (`supabase`/`sheets`), `created_by` | |
| `members` | `household_id`, `user_id`, `role` (`owner`/`member`) | |
| `accounts` | `id`, `household_id`, `name`, `opening_balance`, `archived`, `sort_order` | |
| `categories` | `id`, `household_id`, `name` | |
| `transactions` | `id`, `household_id`, `date`, `type`, `category_id`, `description`, `amount ≥ 0`, `source`, `account_id`, `transfer_group`, `legacy_id`, `created_by` | Indexed on `(household_id, date desc)` and `account_id`. |
| `holdings` | `id`, `household_id`, `asset_type` (`gold`/`stock`), `ticker`, `name`, `quantity > 0`, `buy_price ≥ 0`, `buy_date`, `legacy_id` | One row per lot. |
| `sales` | `id`, `household_id`, `date`, `asset_type`, `ticker`, `name`, `quantity`, `avg_buy_price`, `sell_price`, `proceeds`, `cost_basis`, `realized_pl`, `account_id`, `legacy_id` | |
| `receipts` | `id`, `household_id`, `transaction_id`, `storage_path` | Reserved; photos are not stored today. |
| `telegram_links` | `user_id`, `household_id`, `telegram_user_id` (unique) | |
| `telegram_link_codes` | `code`, `user_id`, `household_id`, `expires_at` | |
| `telegram_state` | per Telegram user, `state` (JSON) | |
| `ocr_usage` | `user_id`, `day`, `scans` | |

Ledger tables (built, migration `20261117000000_ledger_closing.sql`), plan and notification tables (built, migration `20261118000000_plans.sql`) and the plan ledger (built, migration `20261119000000_plan_ledger.sql`):

| Table | Key columns | Notes |
| --- | --- | --- |
| `ledger_closings` | `id`, `household_id`, `month` (first day of month), `version`, `status` (`closed`/`superseded`), totals (income, expense, invest, savings_rate, realized_pl, portfolio_value, unrealized_pl), `by_category` (JSON), `plans` (JSON), `checklist` (JSON), `notes`, `closed_by`, `closed_at` | Unique on `(household_id, month, version)`; rows are never updated except `status`. |
| `ledger_closing_accounts` | `id`, `closing_id`, `household_id`, `account_id` (null = unassigned entries), `sort_order`, `account_name`, `opening`, `income`, `expense`, `invest`, `transfer_in`, `transfer_out`, `closing`, `bank_balance`, `difference`, `difference_note` | One row per account per closing. |
| `ledger_closing_events` | `id`, `household_id`, `month`, `version`, `action` (`close`/`reopen`), `reason`, `user_id`, `at` | Audit trail. |
| `plans` | `id`, `household_id`, `name`, `icon`, `note`, `target_amount > 0`, `start_date`, `target_date`, `account_id`, `status` (`active`/`paused`/`achieved`/`cancelled`), `achieved_at`, `behind_since`, `created_by`, `created_at` | `achieved_at` and `behind_since` are set by the database only. |
| `plan_ledger` | `id`, `household_id`, `plan_id`, `entry_type` (`deposit`/`withdrawal`/`adjustment`/`asset_in`/`asset_out`), `date`, `amount` (signed), `note`, `transaction_id` (unique, nullable), `holding_id` (null after the lot is gone), `asset_type`, `ticker`, `asset_name`, `quantity`, `unit_price`, `created_by`, `created_at` | Was `plan_contributions` (V2.5). Asset columns are filled only on asset entries. Members can write cash entries only. |
| `plan_holdings` | `id`, `household_id`, `plan_id`, `holding_id`, `quantity > 0`, `created_by`, `created_at` | Unique on `(plan_id, holding_id)`. The total assigned from a lot never exceeds its quantity. Changed only through the assign, release and sale functions. |
| `month_end_prices` | `household_id`, `month`, `asset_type`, `ticker`, `name`, `price > 0`, `price_date` | Market prices of the month's last trading day, saved before closing; read-only for the app. |
| `plan_contributions` (view) | the deposit rows of `plan_ledger` | Compatibility view so the pre-V2.6 app keeps working. |
| `plan_ledger_running` (view) | `plan_ledger` plus `cash_balance` and `value_balance` per plan | Running balances in date order. |
| `plan_ledger` (changed, V2.13) | `entry_type` check gains `spend`; the shape check requires `amount < 0` and `transaction_id` not null for it | Migration `20261125000000_plan_spend.sql`: also `spend_from_plan()`, `delete_plan_spend()`, a trigger that removes the entry when its transaction is deleted, and `plan_figures` / `check_plan` counting `spent`. |
| `notifications` | `id`, `household_id`, `user_id`, `kind`, `subject_id`, `period_key`, `title`, `body`, `link`, `created_at`, `sent_at`, `read_at` | Unique on `(user_id, kind, subject_id, period_key)`. |
| `push_subscriptions` | `id`, `user_id`, `endpoint` (unique), `p256dh`, `auth`, `user_agent`, `created_at` | Per device. |
| `notification_prefs` | `user_id`, `kind`, `enabled` | Missing row = on for owners, off for other members (FR-PLN-10). |

Loans (built, migration `20261122000000_loans.sql`):

| Table | Key columns | Notes |
| --- | --- | --- |
| `loans` | `id`, `household_id`, `borrower_id` (user id, must be a member), `amount > 0`, `date`, `due_date` (nullable, ≥ `date`), `note`, `status` (`open`/`paid`), `account_id` (the account the money left), `created_by`, `created_at` | Status is maintained by the database. Members read; only the RPCs write. |
| `transactions` (changed) | adds `loan_id` (nullable, FK to `loans`, on delete restrict); `type` check gains `loan-in` and `loan-out` | Index on `loan_id`. A check keeps `loan_id` null for every other type and non-null for the two loan types. |
| `ledger_closings` (changed) | adds `loans` (JSON snapshot) and `loans_outstanding` | See FR-CLS-16. |
| `ledger_closing_accounts` (changed) | adds `loan_in`, `loan_out` | See FR-CLS-15. |
| `notification_prefs` kinds | adds `loan_due`, `loan_overdue` | Same default as plan kinds (FR-PLN-10). |

Money columns are `numeric(18,2)`; quantities `numeric(18,6)`.

### 4.2 V1 data model

Google Sheet tabs: `Transactions`, `Holdings`, `Realized`. Columns mirror the V2 tables without `household_id` and with account names as text.

### 4.3 Data rules

- DR-1: Every V2 table carries `household_id` (except per-user tables). Deleting a household cascades to its data.
- DR-2: Deleting an account or category sets the reference to null; it does not delete transactions.
- DR-3: Amounts are stored as positive numbers; the type decides the sign.
- DR-4: Receipt photos are never persisted.
- DR-5: A stored closing snapshot is never edited. Reopening marks it `superseded`; closing again writes a new version.
- DR-6: Rows dated in a closed month (`transactions`, `sales`, `plan_ledger`) cannot be inserted, updated or deleted (FR-CLS-07).
- DR-7: `push_subscriptions`, `notification_prefs` and `notifications` are per user: RLS allows a user to see only their own rows.
- DR-8: Plan ledger amounts are signed (deposit > 0, withdrawal < 0). A plan's cash never goes below zero, and a plan's cash never changes the balance of its account: plans are set-asides, not accounts.
- DR-9: Loan amounts are positive; the transaction type (`loan-out`, `loan-in`) decides the sign. A loan's outstanding amount never goes below zero, and a loan with repayments is never deleted.
- DR-10: `loan-in` and `loan-out` rows exist only through the loan RPCs and always carry a `loan_id`; a loan's `loan-out` is created and removed with the loan.

## 5. External interfaces

### 5.1 User interfaces

- **V2 PWA:** phone-first, bottom navigation with Home, Overview, Scan (centre), Portfolio and Settings. Activity, Plans, Loans, Monthly statements and Notifications open from Home or Settings. Forms open as bottom sheets (add, scan, transfer, transaction, account, category, member, holding, position, plan, loan, Telegram). Login and onboarding screens precede the main app.
- **Look and feel (V2.10):** a dark burgundy theme on a warm near-black canvas. Pages and sheets are translucent dark glass with white text; blur is used only on the navigation bar, sheets, the toast and pickers. Text links are small dark-burgundy buttons. Dropdown menus, the category suggestion list and the date calendar are glass panels of the app's own (selects use the browser's customizable select where supported and its native picker elsewhere). Date fields are picked from the calendar, not typed.
- **Monthly statements (V2):** Settings → Monthly statements lists every month with its status (running, ready to close, closed, locked). A month opens as a statement sheet: summary, accounts, expenses by category, checklist, then either the close form (bank balance per account, two-tap confirm) or, when closed, print/PDF, CSV export, reopen with a reason, and the close/reopen history. Owners see a "Close <month>" card on Home when one is due. Locked entries show no Edit or Delete, and date pickers start after the locked month.
- **V1 dashboard:** single page with forms for transactions, holdings and transfers; account balances; category chart; transaction table.
- **Telegram bot:** text commands, inline keyboards for account and category choice, review cards for history imports.

### 5.2 Software interfaces

| Service | Use | Auth |
| --- | --- | --- |
| Supabase (Auth, Postgres, Edge Functions) | V2 database and server logic | Publishable key + user JWT (browser); secret key (server only) |
| Google Apps Script | V1 API | `API_SECRET` |
| Telegram Bot API | Bot messages and webhook | `BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` |
| Gemini API | Cloud OCR | `GEMINI_API_KEY` |
| Anthropic API | Optional V1 OCR provider | API key |
| Emas API ID | Gold fallback when muamalahemas.com cannot be read | `EMAS_API_KEY` |
| Yahoo Finance | IDX stock price | None |
| jsDelivr | supabase-js, Chart.js, PaddleOCR, onnxruntime-web | None (pinned versions; supabase-js and Chart.js are integrity-checked) |
| muamalahemas.com | Antam buyback price (first source) | None |
| Google Fonts | Plus Jakarta Sans typeface | None |
| Cloudflare Pages | PWA hosting | Deploy token |

### 5.3 Configuration

- One root `.env` holds all secrets (template: `.env.example`).
- `scripts/build_dashboard_config.py` writes `Dashboard/config.js` (`APPS_SCRIPT_URL`, `API_SECRET` only).
- `scripts/build_pwa_config.py` writes the git-ignored `pwa/config.js` (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, optional `TELEGRAM_BOT`) and PNG icons.
- `scripts/fetch_ocr_models.py` downloads the OCR models into the git-ignored `pwa/models/`.
- `scripts/deploy_pwa.py` uploads `pwa/` to the Cloudflare Pages project named by `CLOUDFLARE_PAGES_PROJECT`, in a temporary copy whose `_headers` pins `connect-src` to the host in `SUPABASE_URL`.
- `scripts/setup_telegram_webhook.py` sets secrets, deploys the bot function and sets the webhook; `--off` returns to polling.

## 6. Non-functional requirements

### 6.1 Security and privacy

| ID | Requirement |
| --- | --- |
| NFR-SEC-01 | Every V2 table has RLS enabled. Access is granted only to members of the row's household (`household_id in (select private.my_households())`, equivalent to `private.is_member`); owner-only actions use `private.is_owner`. |
| NFR-SEC-02 | New tables must enable RLS and follow the same policy shape. |
| NFR-SEC-03 | The service-role key never reaches the browser; code using it filters every query by `household_id`. |
| NFR-SEC-04 | `.env`, `Dashboard/config.js` and `pwa/config.js` are never committed, and their values are never printed. |
| NFR-SEC-05 | The PWA is served with a strict content security policy (including `upgrade-insecure-requests`), `Strict-Transport-Security`, `Cross-Origin-Opener-Policy: same-origin`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `nosniff`, and camera allowed only for self (no `noindex`: Lighthouse SEO requires the page to be crawlable; the app is sign-in only). The deploy script narrows the policy's Supabase host to the project's own. |
| NFR-SEC-06 | The Telegram webhook rejects requests without the correct secret header, compared in constant time. |
| NFR-SEC-07 | Closing and reopening are enforced as owner-only inside the RPCs, not just hidden in the UI. |
| NFR-SEC-08 | Notifications are shown inside the app only, so nothing appears on a lock screen. (If push is ever added: generic text, and VAPID private keys in function secrets.) |
| NFR-SEC-09 | V1 limitation, accepted: `API_SECRET` ships to the browser in `config.js`, so the V1 dashboard is only as private as its URL. |
| NFR-SEC-10 | Loan RPCs check `private.is_member` and, for the borrower, that the chosen user belongs to the same household; they never trust an id from the client without that check. |
| NFR-SEC-11 | The scripts the app depends on (supabase-js, Chart.js) carry `integrity` hashes with `crossorigin`; the service worker caches them with a CORS request so the check still passes offline. |
| NFR-SEC-12 | Public sign-ups are off in Supabase (a setting, not enforceable in code). A household has at most 10 members and a user at most 3 households. |
| NFR-SEC-13 | Internal helper functions in the `private` schema are not executable by signed-in users; they run only from other server functions and triggers. |
| NFR-SEC-14 | V1: the bot refuses everyone until `ALLOWED_TELEGRAM_ID` is set, and sheet writes store text beginning with `=`, `+`, `-` or `@` as plain text so it cannot run as a formula. |
| NFR-SEC-15 | Browser-facing Edge Functions need a signed-in user's token; the optional `ALLOWED_ORIGINS` secret restricts the origins they answer. |

### 6.2 Performance

| ID | Requirement |
| --- | --- |
| NFR-PRF-01 | The PWA shell loads from cache in under 2 seconds on a mid-range phone. |
| NFR-PRF-02 | Saving a transaction completes in under 2 seconds on a normal mobile connection. |
| NFR-PRF-03 | An on-device scan returns rows in under 10 seconds after the models are cached. |
| NFR-PRF-04 | Portfolio prices load in under 5 seconds; the app does not block on them. |
| NFR-PRF-05 | Known limit: the app loads the whole transaction history on start and after every write (pages after the first load four at a time). That suits tens of thousands of rows; larger histories need recent-months loading and an IndexedDB cache (see `plan.md`). The offline copy in localStorage is written once per burst of changes and trimmed to the last two years when it does not fit. |
| NFR-PRF-07 | Reading a household's whole history (100,000 transactions) takes under 150 ms in the database as a signed-in user, and the account balances under 100 ms: row-level security checks membership once per query, not once per row. |
| NFR-PRF-06 | Blur effects are kept off full-screen pages and off elements while they animate, so scrolling and sheet motion stay at 60 fps on a mid-range phone. |

### 6.3 Reliability and availability

| ID | Requirement |
| --- | --- |
| NFR-REL-01 | Entries made offline are never lost; they stay queued until synced. |
| NFR-REL-02 | Multi-row writes (transfers, sales) are atomic. |
| NFR-REL-03 | A price-source failure does not break the portfolio view (falls back to cost). |
| NFR-REL-04 | The V1 Sheet stays intact after import and can serve as a fallback. |
| NFR-REL-05 | A closed statement's figures equal the live draft figures at the moment of closing, to the rupiah. |
| NFR-REL-06 | Each due notification is delivered at most once per channel, and within 1 hour of its scheduled time. |
| NFR-REL-07 | Offline-queued entries dated in a month that was closed meanwhile are not dropped: the sync shows the error and lets the user move the entry to the current month or ask the owner to reopen. |
| NFR-REL-08 | A closed statement's Loans outstanding total equals the sum of loan balances on the last day of that month, to the rupiah, and equals the live draft at the moment of closing. Two payments saved at once cannot together exceed the outstanding amount (the RPC locks the loan row). |

### 6.4 Usability

| ID | Requirement |
| --- | --- |
| NFR-USE-01 | Layout is designed for phone width first; touch targets are at least 44 px. |
| NFR-USE-02 | Rupiah and dates follow Indonesian formatting. |
| NFR-USE-03 | Errors are shown in plain words ("You are offline. Try again when connected."). |
| NFR-USE-04 | Adding an expense takes at most three taps after opening the app, plus typing. |
| NFR-USE-05 | Motion explains navigation: a tapped row or card grows into the sheet it opens and shrinks back on close, and other sheets slide up and down with their glass blur intact; tabs slide in the direction of travel; the nav highlight glides; rows rise in on a new screen; buttons respond to touch. Built on the View Transitions API with a plain swap where it is unsupported, and switched off under `prefers-reduced-motion`. |

### 6.5 Maintainability

| ID | Requirement |
| --- | --- |
| NFR-MNT-01 | `pwa/app.js` stays one IIFE with state in `S`, views `view*`, sheets `sheet*`, `forms` and `actions`. |
| NFR-MNT-02 | Shared Edge Function code lives in `supabase/functions/_shared/`; changing it means redeploying `ocr`, `prices` and `telegram`. |
| NFR-MNT-03 | Schema changes are new, timestamped files in `supabase/migrations/`. |
| NFR-MNT-04 | `README.md` and `setup.md` are updated with every behavior change. |
| NFR-MNT-05 | `sh tests/sql/run.sh` passes (ledger, plans, plan ledger, loans, hardening) before a migration is released. |
| NFR-MNT-06 | The service worker's `VERSION` is bumped whenever a shell file changes, and `supabase/setup_all.sql` is rebuilt after a migration changes. |

### 6.6 Cost

| ID | Requirement |
| --- | --- |
| NFR-CST-01 | The system runs within free tiers of every service it uses. |
| NFR-CST-02 | On-device OCR is the default so cloud OCR quota is used only on request. |

## 7. Verification

| Area | Method |
| --- | --- |
| Receipt parser | `node tests/receipt_parser_test.js` |
| RLS | Sign in as a user of another household and confirm no rows are returned or writable. |
| Transfers and sales | Check that both legs exist, totals exclude transfers, and overselling is refused. |
| Offline | Turn off the network, add an entry, reconnect, confirm it syncs once. |
| Pricing | `python TelegramBot/diagnose.py`; open Portfolio with and without the `prices` function deployed. |
| Import | Run the import twice; confirm row counts do not change on the second run. |
| PWA locally | `pwa` launch configuration, port 5173. |
| Ledger closing | Close a month; try to add, edit and delete an entry dated in it (all refused); reopen with a reason; check the audit row and that the next month's opening equals the closing balance. Try closing as a member (refused) and closing a month that has not ended (refused). |
| Plans | Create a plan, add contributions crossing 25/50/75/100%; confirm one notification each. Move the target date so the plan is behind; confirm one "behind" notification. Pause it; confirm no reminders. Run `sh tests/sql/run.sh` (Docker) for the SQL rules. |
| Plan ledger | Take out more than the plan holds (refused). Assign gold or stock, then more than is free (refused). Check that the account shows set aside and free to spend, and that an expense below the set-aside shows the warning. Sell the lot and confirm it leaves the plan. Close a month with assigned assets and check the statement says "market price" or "cost". |
| Plan spending (V2.13) | Plan of 30 juta fully funded: pay a vendor 5 juta from Mely. Progress stays at 100%, cash shows 25 juta, spent 5 juta, Mely's balance falls by 5 juta and free to spend does not change. Pay 26 juta (refused: more than the cash). Delete the expense from Activity: the plan's spend entry goes too and cash is back to 30 juta. Pay in a closed month (refused). Close the month: the statement shows 5 juta spent for the plan, the expense in the category list and in both charts. |
| Loans | Lend from Bersama to a member: Bersama's balance falls, income and expense totals do not move. Choose a non-member as borrower (refused). Lend more than the account holds (refused in the app). Repay part of it into Bersama, then more than is owed (refused); repay the rest and confirm the status turns to paid. Close the month a loan was made in: the statement lists it with the outstanding amount; repay it next month and confirm the old statement is unchanged and the new one no longer lists it. Try to add, edit or delete a loan or repayment dated in a closed month (refused). Delete a loan that has a repayment (refused). Run `sh tests/sql/run.sh` for the SQL rules. |
| Hardening | Run `sh tests/sql/run.sh` (the hardening suite checks the household and member limits, the generic add-member message and that the private helpers refuse signed-in users). In Supabase, confirm "Allow new users to sign up" is off. Load the app and check that supabase-js and Chart.js load (an altered file would be refused by its integrity hash). |
| Appearance | Open Home, Overview, Portfolio, Settings and a sheet (Add, a plan): text is readable on the glass, dropdown menus and the calendar open as glass panels, closing a sheet keeps its blur, and nothing stutters while sheets open and close. |
| Query performance | Seed about 100,000 transactions in the Docker Postgres and time the whole-history read, the deepest page, `account_balances` and a count as the `authenticated` role (targets: NFR-PRF-07). `sh tests/sql/run.sh` includes `rls_test.sql`, which checks that members see their household, outsiders see nothing and cannot write, and signed-out visitors are refused. |
| Notifications | Subscribe a device, run the `notify` function twice for the same day; confirm no duplicates. Block push; confirm the in-app list still shows them. |

## 8. Open items

0. V2.13 (plan spending and statement charts) is specified above (FR-PLN-21 to FR-PLN-28, FR-CLS-18, FR-CLS-19) (built; the migration must be run). Defaults used in this document: gold and stocks are not spent directly (sell first); Take out stays a separate action that lowers progress.
1. Receipt photos are not stored, by decision. The `receipts` table is unused and can be dropped by a future migration.
2. Ledger closing (3.12): built (V2.4). The month-close reminders (FR-CLS-12) and the plan section of the statement (FR-PLN-11) are built too.
3. Plans (3.13): built (V2.5 to V2.7). Decided: sale proceeds go into plan cash (FR-PLN-17); notification checks keep using cost (FR-PLN-16); the statement uses last-day-of-month prices (FR-PLN-20); "Add money" never creates a transfer automatically.
4. Notifications (3.14): in-app list, settings and database checks are built. Web Push delivery was dropped by decision (the bell is enough). `pg_cron` must be enabled on the Supabase project for the scheduled checks.
5. The V2.5 and V2.6 migrations (`20261118000000_plans.sql`, `20261119000000_plan_ledger.sql`) have been run on the live Supabase project. The V2.7 migration (`20261120000000_plan_sale_and_month_end.sql`) must be run, and the `prices` function redeployed (`npx supabase functions deploy prices`), for sale proceeds and month-end prices.
6. Loans (3.14a, V2.9): built in code and covered by `tests/sql/loans_test.sql`; the migration `20261122000000_loans.sql` has been run on the live Supabase project and the Loans screens load, but lending and repaying have not been exercised against live data. Decided: money lent from a household account (such as Bersama) to a household member who pays it back; principal only (no interest or schedule); not income or expense. Assumed, to confirm: the borrower shows by the part of their email before the `@` (members have no name field); any member can add loans and repayments (only closing stays owner-only); an account may not be lent more than it holds, enforced in the app only.
7. Off the roadmap for now: the Telegram webhook (FR-BOT-05 to FR-BOT-08, built but not deployed), Sheets mode and the nightly mirror (FR-MIG-03, FR-MIG-04), and hosting for the V1 bot and dashboard.
8. Security hardening (V2.11) is built, tested and rolled out on the live project (sign-ups off, hardening migration run, functions and app redeployed). GitHub Pages is unpublished. If the V1 Apps Script web app is no longer used, undeploy it; its old URL is in early commits.
9. Known performance limits (NFR-PRF-05): the whole history is downloaded on start and after every write; render-blocking Google Fonts and two synchronous CDN scripts; the service worker rechecks every app file on each launch. Planned fixes are listed in `plan.md`.
