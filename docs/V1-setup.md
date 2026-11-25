# FinanceTracker V1 and the shelved Telegram webhook

This is the legacy V1 setup (Google Sheet + Apps Script, web dashboard, Python Telegram bot) and the shelved V2 Telegram webhook. It is **not needed** for the current app: see [`../setup.md`](../setup.md) for the V2 setup.

Secrets rule: never commit `.env` or `Dashboard/config.js`. In V1, `API_SECRET` ships to the browser inside `Dashboard/config.js`, so a V1 dashboard is only as private as its URL.

---

## V1 prerequisites

- **Python 3.12.7** (matches `.python-version` / `runtime.txt`)
- A **Google account** (for Sheets + Apps Script)
- A **Telegram account** (to create the bot via @BotFather)
- API keys: **Gemini** (free OCR); optionally **Emas API ID** (backup gold prices)

---

## Step 1 — Backend (Google Sheets + Apps Script)

1. Create a new Google Sheet. This is your database. The system expects tabs for transactions, holdings, accounts, and realized P&L (the Apps Script reads/writes these).
2. Open **Extensions → Apps Script** and paste in your `Code.gs`.
3. In `Code.gs`, set the `SECRET` constant to a value you choose (this is your `API_SECRET`).
4. **Deploy → New deployment → Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone** (the secret is what protects it)
5. Copy the deployed `/exec` Web App URL — you'll paste it into the root `.env` as `APPS_SCRIPT_URL` (shared by the bot and the dashboard).

Whenever you change `Code.gs`, redeploy (or manage the deployment so the same URL serves the new code).

---

## Step 2 — Get your API keys

**Gemini (receipt/payslip OCR — free tier, ~1,500 req/day)**

1. Go to Google AI Studio and create an API key.
2. Put it in `.env` as `GEMINI_API_KEY`.

**Emas API ID (backup gold price source, optional, free)**

Gold is read from muamalahemas.com first; this key is used only when that page cannot be read.

1. Register at `https://emas.maulanar.my.id/register`.
2. Copy your key from the dashboard.
3. Put it in `.env` as `EMAS_API_KEY`.

**Telegram bot token**

1. Message @BotFather → `/newbot`, follow the prompts.
2. Copy the token into `.env` as `BOT_TOKEN`.

---

## Step 3 — Telegram bot

From `TelegramBot/`:

```bash
cd TelegramBot

# create + activate a virtual environment
python3 -m venv venv
source venv/bin/activate          # macOS/Linux
# (Windows: venv\Scripts\activate)

# install dependencies
python3 -m pip install -r requirements.txt
```

Copy `.env.example` to `.env` in the **project root** (one file for both the bot and the dashboard) and fill it with YOUR rotated values:

```env
BOT_TOKEN=your_telegram_bot_token
APPS_SCRIPT_URL=https://script.google.com/macros/s/XXXX/exec
API_SECRET=your_chosen_secret          # must match SECRET in Code.gs

# required: only this Telegram user id may use the bot (blank = the bot refuses everyone and replies with your id so you can paste it here)
ALLOWED_TELEGRAM_ID=

# OCR
OCR_PROVIDER=gemini                    # "gemini" (free) or "anthropic" (paid)
GEMINI_API_KEY=your_gemini_key
GEMINI_MODEL=gemini-2.5-flash
ANTHROPIC_API_KEY=                     # only if OCR_PROVIDER=anthropic

# gold pricing
EMAS_API_KEY=your_emas_key
```

`bot.py` loads the root `.env` automatically via `TelegramBot/env_loader.py` (no extra package). Variables already set in the real environment (e.g. on a host) take precedence.

For the dashboard, generate its config from the same file:

```bash
python scripts/build_dashboard_config.py
```

Run it:

```bash
python3 bot.py
```

You should see `Bot is running (long polling)...`. Message your bot `/start` to confirm.

**Sanity-check gold pricing** (optional):

```bash
python3 diagnose.py
```

This prints whether `EMAS_API_KEY` is set, what the API returns and which source gave the price.

---

## Step 4 — Dashboard

The dashboard reads `APPS_SCRIPT_URL` and `API_SECRET` from the root `.env`. Generate its config (re-run whenever `.env` changes):

```bash
python scripts/build_dashboard_config.py
```

This writes `Dashboard/config.js` with only those two values; bot-only keys never reach the browser.

To run locally, just open `dashboard.html` in a browser, or serve the folder:

```bash
cd Dashboard
python3 -m http.server 8000
# then visit http://localhost:8000/dashboard.html
```

The dashboard does full CRUD on transactions, investments, account balances, and transfers, with an expenses-by-category chart (Chart.js) and a filterable/sortable/paginated table.

---

## Bot command reference

```
/add <type> <amount> <description> [category]   add a transaction (type = income/expense/invest)
/payslip                                        next photo → net take-home logged as income
(send a receipt photo)                          OCR → logged as expense, asks which account

/portfolio                                      live P&L on gold + stocks
/sell <ticker> <qty> <price> <account>          sell a holding, records realized P&L
/realized                                       realized profit/loss from past sales

/accounts                                       balance per account (Ivan/Mely/Bersama)
/transfer <from> <to> <amount> [note]           move funds between accounts
/summary                                        this month's income/expense/balance
/recent                                         last 5 transactions
```

---

## How the pieces talk

```
Telegram Bot ─┐
              ├──► Apps Script Web App (/exec, guarded by API_SECRET) ──► Google Sheet
Dashboard ────┘
```

- **Transactions** flow in from the bot or the dashboard; both POST JSON as `text/plain` (this avoids a CORS preflight that Apps Script doesn't answer).
- **Gold** is standardized as `ticker: "LM"` with the brand (e.g. "Antam") in `name`, unifying gold and stocks under one holdings model. Buyback price comes from muamalahemas.com, with Emas API ID as the backup.
- **Stocks** are priced via Yahoo Finance (`.JK` suffix added automatically), ~15 min delayed.
- **Transfers** write two linked rows and are excluded from income/expense totals.
- Live price fetching stays **server-side** (Apps Script / bot), never in the browser.

---

## Telegram bot on Supabase (shelved)

> Not in use. Scanning in the app covers the same need, so this is parked: the code is in the repo but nothing is deployed, and the "Telegram bot" row in Settings is hidden unless `TELEGRAM_BOT: true` is added to `pwa/config.js`. The steps below are kept in case it is wanted later.

The bot now exists as a Supabase function, `telegram`. Telegram calls it for every message (a "webhook"), so no computer has to stay on and no bot hosting is needed. It reads and writes Supabase, uses your own accounts and categories, and shares the same photo reader and daily scan limit as the app.

**Turn it on (once)**

1. In the Supabase dashboard, open **SQL Editor**, paste the contents of `supabase/migrations/20261116000000_telegram.sql`, and run it.
2. From the project folder (after `npx supabase login` and `npx supabase link`), run:

```bash
python scripts/setup_telegram_webhook.py
```

The script creates `TELEGRAM_WEBHOOK_SECRET` in `.env` if it is missing, stores the bot token, that secret, and the Gemini and Emas keys as Supabase secrets, deploys the function, and points Telegram at it. It prints no secret values.

3. The `ocr` and `prices` functions now share code with the bot. Redeploy them so all three run the same version:

```bash
npx supabase functions deploy ocr
```

```bash
npx supabase functions deploy prices
```

4. In the app, open **Settings -> Link Telegram**. It shows a message such as `/link ABCD1234`. Send that to your bot within 10 minutes. Each household member links their own Telegram account this way.

**Using it**

- Send a receipt photo, or `/add expense 85000 lunch at warung`. The bot asks for the category and the account with buttons, then saves.
- `/payslip` or `/history`, then a photo. History rows are reviewed one card at a time (Keep, Rename, Skip).
- `/transfer`, `/sell`, `/portfolio`, `/realized`, `/accounts`, `/summary`, `/recent` work as before. `/cancel` drops whatever is in progress; `/unlink` disconnects your Telegram account.

**Good to know**

- Once the webhook is on, the old Python bot (`TelegramBot/bot.py`) stops receiving messages; a bot can use only one of the two. To go back: `python scripts/setup_telegram_webhook.py --off`. To see the current state: `--status`.
- The bot answers only people who have linked from the app, and only in private chats. Everyone else gets a "this bot is private" reply.
- Entries are saved with source `telegram` (typed) or `telegram-ocr` (from a photo).

---

