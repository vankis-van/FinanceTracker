# Business Requirements Document (BRD)

**Project:** FinanceTracker
**Document version:** 1.2 (adds the gold price fallback, the visual refresh and security hardening, V2.10 and V2.11)
**Date:** 2026-11-17
**Owner:** Ivan
**Status:** Living document. V1 is in use; V2 is being built.

---

## 1. Purpose

This document states why FinanceTracker exists, who it serves, what it must achieve, and how success is judged. It does not describe how the system is built; that is in [SRS.md](SRS.md).

## 2. Background

An Indonesian household of two (Ivan and Mely) keeps money in three savings accounts: Ivan's, Mely's, and a joint account (Bersama). They also hold Antam gold bars and IDX-listed stocks.

Before FinanceTracker, spending was tracked by hand, if at all. Commercial budgeting apps either did not fit the Indonesian context (Rupiah formatting, QRIS receipts, Antam buyback pricing), held the data on a third party's servers, or charged a subscription.

FinanceTracker V1 solved this with one Google Sheet as the database, a Google Apps Script web app as the API, a web dashboard and a Telegram bot. V1 works but has limits: the account list is hard-coded, the dashboard is desktop-first, the shared secret ships to the browser, and the bot needs a machine running all the time. V2 addresses these.

## 3. Business problem

| # | Problem | Impact |
| --- | --- | --- |
| P1 | Logging every expense by hand is tedious, so entries get skipped. | Totals are wrong; budgeting decisions rest on bad data. |
| P2 | Paper and QRIS receipts pile up and are never entered. | Spending is under-reported. |
| P3 | There is no single view of cash plus investments. | The household cannot see its real net position. |
| P4 | Gold and stock value is only known at purchase price. | Profit or loss is unknown until something is sold. |
| P5 | Moving money between accounts looks like spending. | Income and expense totals are inflated. |
| P6 | Third-party apps own the data and may charge for it. | Lock-in, privacy exposure, recurring cost. |
| P7 | There is no month-end close. Past months can be changed at any time, and nobody checks the recorded balances against the bank. | Reports for a finished month keep moving; errors go unnoticed; there is no fixed record to look back on. |
| P8 | Savings goals ("Buy Laptop", "Marriage", "AWS Certification") live in people's heads, not in the system. | No one knows how far along a goal is, how much to save each month, or when a goal is falling behind. |
| P9 | Money taken out of a shared account (usually Bersama) for Ivan or Mely to use is not tracked as a loan. It looks like an expense, so the joint account's balance drops with nothing to show it must be paid back. | Nobody knows who owes the household how much, repayments look like income, and month-end statements hide the amount still owed. |

## 4. Business objectives

| ID | Objective | Measure |
| --- | --- | --- |
| BO-1 | Make logging a transaction take under 15 seconds. | A typed entry needs at most one form or one bot command; a receipt needs one photo plus a review. |
| BO-2 | Capture receipts and payslips without retyping. | A scan pre-fills merchant, amount and date; the user only confirms. |
| BO-3 | Show the household's full position in one place. | Cash per account, investments at live price, and month totals on one screen. |
| BO-4 | Show live investment profit and loss. | Unrealized P&L on gold (Antam buyback) and IDX stocks; realized P&L on every sale. |
| BO-5 | Keep the data self-owned. | All records live in a Google Sheet or a Supabase project the household controls. |
| BO-6 | Keep running cost at zero. | Only free tiers: Google, Supabase, Cloudflare Pages, Gemini, Telegram. |
| BO-7 | Work well on a phone. | V2 app installs to the home screen, works offline and queues entries until back online. |
| BO-8 | Close every month with a fixed, reconciled statement. | Each month is closed by the owner within 7 days of month end; closed months cannot change without a recorded reopen. |
| BO-9 | Make savings goals visible and on track. | Every goal shows progress, the monthly amount needed, and its status; the owner is notified of milestones and of goals falling behind. |
| BO-10 | Track money lent from household accounts until it is paid back. | Every loan shows who owes it, the amount repaid and the amount outstanding; every month-end statement lists the loans still unpaid at that date. |

## 5. Scope

### 5.1 In scope

- Recording income, expenses, investment purchases and transfers.
- Multiple savings accounts with per-account balances (fixed list in V1, user-defined in V2).
- Receipt, payslip and transaction-history scanning (OCR).
- Gold and stock holdings with weighted-average cost, live pricing, sell tracking and realized P&L.
- Monthly, yearly and all-time summaries; expenses by category.
- Two front-ends: a phone-first web app (V2 PWA; V1 dashboard) and a Telegram bot.
- Shared access for household members.
- One-time import of V1 Sheet data into V2.
- Monthly ledger closing: a month-end statement produced only when the owner closes the month by hand, after which the month is locked.
- Plans (savings goals) with progress tracking and notifications to the owner.
- Loans: money taken out of a household account (for example Bersama) and lent to a household member, repaid in one or more repayments back into an account, and listed on each month-end statement while unpaid.

### 5.2 Out of scope

- Bank or e-wallet API integration (automatic feeds).
- Bill payment, money movement or trading of any kind. The system only records.
- Tax filing.
- Multi-currency. Everything is in Rupiah (IDR).
- Financial advice or forecasts (a plan's "monthly amount needed" is simple arithmetic, not advice).
- Automatic month-end closing. A month is only ever closed by the owner.
- Moving money into a plan. A plan tracks money set aside; it does not hold or move it.
- Loans to or from people outside the household, interest, installment schedules and late fees. A loan here is principal only; repayments can be any amount at any time.
- Loans and repayments are recorded, not made. The system never moves real money.
- Public multi-tenant SaaS. The system is for one household (V2's data model allows more, but this is not a goal).

## 6. Stakeholders

| Stakeholder | Role | Interest |
| --- | --- | --- |
| Ivan | Owner, developer, primary user | Accurate records, low effort, zero cost, owns the code. |
| Mely | Household member, user | Easy logging from the phone, a clear view of shared money. |
| External services | Google, Supabase, Cloudflare, Telegram, Gemini, muamalahemas.com, Emas API ID, Yahoo Finance | Free-tier limits and terms of use must be respected. |

## 7. Users and usage

| Persona | Typical use | Main channel |
| --- | --- | --- |
| Owner | Sets up accounts and categories, invites members, reviews monthly totals, manages investments. | PWA (V2), dashboard (V1), bot |
| Member | Logs daily spending, scans receipts, checks balances. | PWA or bot |

Usage is light: a few dozen entries a week, a handful of scans a day, portfolio checks a few times a week.

## 8. Business requirements

Priority: **M** = must have, **S** = should have, **C** = could have.

| ID | Requirement | Priority | Objective |
| --- | --- | --- | --- |
| BR-01 | Users can record income, expense and investment entries with date, amount, category, description and account. | M | BO-1 |
| BR-02 | Users can record a transfer between two accounts that does not count as income or expense. | M | BO-3, P5 |
| BR-03 | The system shows the balance of every account. | M | BO-3 |
| BR-04 | Users can photograph a receipt and have the merchant, amount and date filled in. | M | BO-2 |
| BR-05 | Users can photograph a payslip and have the net take-home pay recorded as income. | S | BO-2 |
| BR-06 | Users can photograph a transaction-history screen and import many rows after reviewing each one. | S | BO-2 |
| BR-07 | Users can record gold and stock purchases and see current value and unrealized P&L. | M | BO-4 |
| BR-08 | Users can record a sale and see realized P&L. | M | BO-4 |
| BR-09 | Gold is valued at the Antam buyback price; stocks at the IDX market price. | M | BO-4 |
| BR-10 | Users see income, expense and savings rate for this month, last month, this year and all time, plus expenses by category. | M | BO-3 |
| BR-11 | Users can search, filter, edit and delete past entries. | M | BO-1 |
| BR-12 | Records are stored in a database the household owns, and can be exported or mirrored to Google Sheets. | M | BO-5 |
| BR-13 | Only household members can read or change household data. | M | BO-5 |
| BR-14 | The phone app keeps working offline and syncs queued entries later. | S | BO-7 |
| BR-15 | Users can log entries by messaging a Telegram bot. | S | BO-1 |
| BR-16 | Account and category lists are defined by the user, not hard-coded. | S | BO-3 |
| BR-17 | All figures use Rupiah formatting and the Asia/Jakarta date. | M | Context |
| BR-18 | Total running cost stays at zero under normal household use. | M | BO-6 |
| BR-19 | Existing V1 Sheet data moves to V2 without loss, and the import can be re-run safely. | M | BO-5 |

#### 8.1 Monthly ledger closing

| ID | Requirement | Priority | Objective |
| --- | --- | --- | --- |
| BR-20 | At the end of each month the system prepares a closing statement for that month: opening balance, income, expense, investment, transfers and closing balance per account; expenses by category; realized P&L; and a portfolio snapshot. | M | BO-8 |
| BR-21 | **Prerequisite:** a month is closed only when the owner closes it by hand. The system never closes a month on its own. Until then the statement is a draft. | M | BO-8 |
| BR-22 | Before closing, the owner sees a checklist (uncategorised or unassigned entries, entries still waiting to sync) and enters the real bank balance of each account; any difference is shown and must be accepted or fixed. | M | BO-8 |
| BR-23 | Once closed, the month is locked: its entries cannot be added, edited or deleted. The statement figures are stored and do not change. | M | BO-8, P7 |
| BR-24 | The owner can reopen a closed month, giving a reason. The reopen is recorded, and the month must be closed again. | S | BO-8 |
| BR-25 | The closing balance of a month becomes the opening balance of the next. | M | BO-8 |
| BR-26 | Users can view past closing statements and save or print one (PDF or CSV). | S | BO-8 |
| BR-27 | The owner is reminded to close the month on the last day and again if it is still open after month end. | S | BO-8 |

#### 8.2 Plans (savings goals)

| ID | Requirement | Priority | Objective |
| --- | --- | --- | --- |
| BR-28 | Users can create a plan with a name (e.g. "Buy Laptop", "Marriage", "AWS Certification"), target amount, target date, and optionally an icon, a note and a linked account. | M | BO-9, P8 |
| BR-29 | Users can add contributions to a plan (amount, date, note), and remove them. | M | BO-9 |
| BR-30 | Each plan shows saved amount, progress %, amount remaining, months left, monthly amount needed, and whether it is on track, behind or achieved. | M | BO-9 |
| BR-31 | Plans can be paused, resumed, marked achieved, or cancelled; cancelled and achieved plans are kept for history. | S | BO-9 |
| BR-32 | The owner is notified when a plan reaches 25%, 50%, 75% and 100%; when it falls behind; when its target date is 30 and 7 days away; and once a month as a reminder to contribute. | M | BO-9 |
| BR-33 | Notifications reach the owner's phone even when the app is closed (push notification; Telegram once the bot is live). The owner can turn each kind on or off. | S | BO-9 |
| BR-34 | The closing statement lists each plan's contributions for the month and its progress at month end. | C | BO-8, BO-9 |
| BR-35 | A plan is a set-aside on a real account, not an account of its own, so account balances keep matching the bank. Each account shows its balance, the amount set aside for plans, and what is free to spend. | M | BO-9, BO-3 |
| BR-36 | Money can also be taken out of a plan (for example when it is spent) and corrected with an adjustment. Every movement is kept in a ledger for the plan, and a plan's cash can never go below zero. | S | BO-9 |
| BR-37 | Gold and stocks already held can be assigned to a plan. They count towards its total at the live price (at cost when prices are not available), and can be released again. Selling a holding releases it from any plan and the sale proceeds move into that plan's cash. | S | BO-9, BO-3 |
| BR-38 | The closing statement shows, per plan, the cash at the start and end of the month, money added and taken out, the value of gold and stocks, and whether those were valued at the market price of the month's last day (shown with the date) or at cost. | C | BO-8, BO-9 |
| BR-39 | The user is warned when an expense takes an account below the amount set aside for plans. | C | BO-9 |
| BR-51 | Users can pay for something from a plan: an expense is recorded on an account the user picks (with category, date and note) and the same amount leaves the plan's cash. A plan can be spent in several partial payments, never more than its cash. | S | BO-9, BO-3 |
| BR-52 | Money spent from a plan still counts as progress: saved = cash + gold and stocks + spent so far. Example: a plan of Rp 30 juta pays a vendor Rp 5 juta; it then holds Rp 25 juta cash and Rp 5 juta spent, and still shows Rp 30 juta of progress. Taking money out without spending it (BR-36) still lowers progress. | S | BO-9 |
| BR-53 | The payment is a normal expense: it lowers the account balance, appears in the month's expenses and categories, and is locked by closing. The account's free to spend does not change, because the expense and the set-aside fall by the same amount. Removing the payment removes the expense and the other way round. | S | BO-9, BO-3 |
| BR-54 | The closing statement shows, per plan, what was spent this month and in total. | C | BO-8, BO-9 |
| BR-55 | The monthly statement shows two charts: expenses by account and expenses by category, for a draft month and for a closed one. | S | BO-8 |
| BR-56 | When a plan is marked achieved or cancelled, the app shows what is still tied to it (cash set aside, gold and stocks assigned) and offers to release it. Nothing is released without the user's confirmation, and a cancelled plan keeps showing the progress it reached. | S | BO-9, BO-3 |

#### 8.3 Loans (money lent from an account to a member)

A loan is money taken out of one of the household's accounts, often the joint account (Bersama), for a household member (Ivan or Mely) to use. The member owes it and pays it back, in one or more repayments, into an account. Neither the loan nor its repayments count as income or expense.

| ID | Requirement | Priority | Objective |
| --- | --- | --- | --- |
| BR-40 | Users can record a loan from an account: amount, date, the household member who borrows it, an optional due date and a note. The account balance goes down by the amount. | M | BO-10, P9 |
| BR-41 | A loan and its repayments are not income or expense. They change account balances and the loan balance only, and are left out of income, expense and savings-rate figures, as transfers are (BR-02). | M | BO-10, P9 |
| BR-42 | Users can record a repayment against a loan: amount, date, the account it is paid into (the loan's own account by default), and a note. The repayment raises that account's balance and lowers the loan's outstanding amount. Part repayments are allowed; a repayment can never exceed the outstanding amount. | M | BO-10 |
| BR-43 | A loan shows its borrower, original amount, total repaid, outstanding amount, due date and status (open or paid). It becomes paid when the outstanding amount reaches zero. | M | BO-10 |
| BR-44 | A Loans screen lists open loans first, with the total outstanding, and can be filtered by borrower. Paid loans stay in a history list. | M | BO-10 |
| BR-45 | The monthly closing statement lists every loan still outstanding at the end of that month: borrower, original amount, lent and repaid during the month, and the outstanding amount at month end; plus the total outstanding. This list is stored with the closed statement and does not change afterwards. | M | BO-8, BO-10 |
| BR-46 | A loan or repayment dated in a closed month cannot be added, edited or deleted, like any other entry (BR-23). | M | BO-8 |
| BR-47 | A loan with repayments cannot be deleted; a loan without repayments can be edited or deleted in an open month. Repayments can be deleted in an open month, which raises the outstanding amount again. | S | BO-10 |
| BR-48 | The owner is reminded when a loan's due date is 7 days away and when it is overdue, and can switch these notifications off. | C | BO-10 |
| BR-49 | The Home screen shows the total outstanding loans. A loan can be viewed by borrower so each member sees what they still owe. | S | BO-10 |
| BR-50 | The app refuses to lend more than the chosen account currently holds. | S | BO-10 |

## 9. Success criteria

1. At least 90% of the household's spending in a month is recorded in the system.
2. A receipt scan pre-fills the correct amount in most cases, so the user edits at most one field.
3. Account balances match the real bank balances at month end, within reconciled differences.
4. Portfolio value is never more than one trading day stale for gold, or about 15 minutes for stocks during market hours.
5. No monthly bill from any service.
6. No household data is readable by anyone outside the household.
7. Every finished month has a closed statement, and no closed month changes without a recorded reopen.
8. Every active plan shows its progress, and the owner gets each milestone and "behind" notification on time.
9. Income and expense totals contain no loan money, and every closed statement lists the loans still unpaid at its month end, with an outstanding total equal to the sum of the loan balances on that date.

## 10. Assumptions

- Both users have a smartphone with a modern browser and a camera.
- Free tiers (Supabase, Cloudflare Pages, Gemini, Google Apps Script) remain available at roughly their current limits.
- muamalahemas.com keeps publishing the Antam buyback price in its current page layout; Emas API ID is the backup, within its monthly quota.
- Yahoo Finance keeps serving IDX quotes with the `.JK` suffix.
- Usage stays within one household.

## 11. Constraints

- **Cost:** free tiers only.
- **Skills and time:** built and maintained by one person; the stack must stay small (no build step for the web app).
- **Privacy:** receipt photos are not stored; secrets never go into git.
- **Platform:** V1 relies on Google Apps Script, which needs a redeploy for every backend change and does not answer CORS preflights.
- **Pricing data:** stock prices are about 15 minutes delayed; gold buyback is updated once a day. When the gold API is unavailable, the app falls back to a public price page.

## 12. Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| A free tier is withdrawn or its limits cut. | Medium | High | Keep the Google Sheet as a second source and nightly mirror; keep providers swappable (OCR provider setting, on-device OCR default). |
| OCR misreads amounts. | Medium | Medium | Every scanned row goes through a review step before saving. |
| A price source changes its API. | Medium | Low | Pricing is fetched server-side in one module; the app falls back to cost price when prices are unavailable. |
| V1 shared secret leaks via the dashboard URL. | Medium | High | V2 replaces it with per-user sign-in and row-level security. |
| Gemini daily quota is exceeded. | Low | Low | On-device OCR is the default; cloud OCR is capped at 30 scans per user per day. |
| Data loss. | Low | High | Supabase backups plus Sheet mirror; V1 Sheet remains intact after import. |
| The owner forgets to close a month. | Medium | Medium | Reminders on the last day and after; the next month still works while the previous one is open, and the draft statement is always available. |
| A late receipt belongs to a closed month. | Medium | Low | The owner reopens the month with a reason, or records the entry in the current month. |
| Push notifications are not delivered (iPhone needs the app installed to the home screen; the user may block them). | Medium | Medium | Show plan alerts inside the app as well; add Telegram as a second channel when the bot is live. |
| A loan is entered as an expense, or a repayment as income, by mistake. | Medium | Medium | Loans and repayments have their own forms; the ordinary add form does not offer them, and the database refuses them there. |
| A repayment is dated before its loan, or in a closed month. | Low | Low | The system refuses it and says why; the owner reopens the month if needed. |
| Public sign-ups are left on in Supabase, so a stranger could create an account. | Low | High | Sign-ups are turned off (setup step); per-user limits (3 households, 10 members per household) cap what an unwanted account could do. |
| A third-party script host (CDN) is compromised and serves altered code. | Low | High | The two scripts the app depends on carry integrity hashes, so an altered file is refused; the content security policy limits what any script may reach. |
| The V1 Telegram bot is found by a stranger. | Low | Medium | The bot refuses everyone until `ALLOWED_TELEGRAM_ID` is set. |

## 13. Roadmap

| Phase | Deliverable | Status |
| --- | --- | --- |
| V1 | Google Sheet + Apps Script API, web dashboard, Telegram bot with Gemini OCR, investments, transfers. | Done, in use |
| V2.1 | Supabase schema, row-level security, RPCs, Sheet import. | Done |
| V2.2 | Phone-first PWA with offline queue, hosted on Cloudflare Pages. | Done |
| V2.3 | In-app scanning: on-device PaddleOCR by default, optional Gemini function. | Done |
| V2.4 | Monthly ledger closing (draft statement, manual close by the owner, lock, reopen, history). | Done |
| V2.5 | Plans module with progress and notifications (database, plans screens, in-app bell and notification settings). | Done (in-app bell only; Web Push dropped) |
| V2.6 | Plan ledger (add, take out, adjust), gold and stocks inside plans, set-aside and free-to-spend per account, plan section of the statement with prices. | Done (migration run on the live Supabase project) |
| V2.7 | Sale proceeds go into plan cash; the statement values plan assets at the price of the month's last day. | Done in code (migration `20261120000000_plan_sale_and_month_end.sql` and the `prices` function still have to be deployed) |
| V2.9 | Loans: lend from an account to a household member, record repayments, list unpaid loans on each month-end statement. | Done (migration `20261122000000_loans.sql` is run on the live project) |
| V2.10 | Gold price fallback when the Emas API fails; visual refresh (dark burgundy glass theme, matching dropdown menus, calendar and category list). | Done |
| V2.11 | Security hardening: integrity-checked scripts, tighter headers, function limits, household and member limits. | Done and rolled out |
| V2.13 | Pay from a plan as an expense while keeping its progress; charts of expenses by account and by category on the statement. | Built in code and tests; migration `20261125000000_plan_spend.sql` still to run |
| V2.14 | Clear loading state while Gemini reads a photo (preview, steps, cancel, timeout). | Built in code; redeploy the app |
| V2.15 | Gold price comes from muamalahemas.com, with Emas API ID as the backup; the price-cards scraper is archived. | Built in code; redeploy the `prices` function and the app |
| Next | Nothing planned. Web Push delivery was considered and dropped; notifications stay in the in-app bell. | Off the roadmap |

## 14. Approval

| Name | Role | Date | Decision |
| --- | --- | --- | --- |
| Ivan | Owner | | |
| Mely | User | | |
