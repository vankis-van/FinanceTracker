"""
============================================================
 FINANCE TELEGRAM BOT
============================================================
 Adds transactions to your Google Sheet (via the Apps Script
 API you already deployed) from two kinds of input:

   1. Text command:   /add expense 85000 groceries food
                       /add income 12000000 salary
   2. Receipt photo:   just send/forward a photo of a receipt;
                       Claude reads the amount + merchant and
                       asks you to confirm before saving.

 Other commands:
   /start    quick help
   /summary  this month's income / expense / balance
   /recent   last 5 transactions
============================================================
"""

import env_loader  # noqa: F401  loads ../.env before any os.environ reads
import os
import json
import base64
from datetime import date as _date
import requests
import telebot
from telebot import types

import pricing   # market-data: gold buyback scrape + IDX stock quotes

# ---------------- CONFIG (use environment variables) ----------------
BOT_TOKEN = os.environ["BOT_TOKEN"]          # from @BotFather
APPS_SCRIPT_URL = os.environ["APPS_SCRIPT_URL"]   # your /exec web app URL
API_SECRET = os.environ["API_SECRET"]         # must match Code.gs SECRET
# required: only this Telegram user id may use the bot (unset = the bot refuses everyone)
ALLOWED_USER = os.environ.get("ALLOWED_TELEGRAM_ID", "")

# --- Receipt OCR (optional) ---
# Pick which AI reads receipt photos. "gemini" is free; "anthropic" is paid.
OCR_PROVIDER = os.environ.get("OCR_PROVIDER", "gemini").lower()
# used if OCR_PROVIDER=anthropic
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
# used if OCR_PROVIDER=gemini
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
# Whether OCR is usable at all = the selected provider has a key
OCR_KEY = GEMINI_KEY if OCR_PROVIDER == "gemini" else ANTHROPIC_KEY
# --------------------------------------------------------------------

bot = telebot.TeleBot(BOT_TOKEN)

# holds receipts awaiting confirmation, keyed by chat id
pending = {}

VALID_TYPES = {"income", "expense", "invest", "investment"}

# Your savings accounts. Order here = order of the picker buttons.
ACCOUNTS = ["Ivan", "Mely", "Bersama"]


def resolve_account(text):
    """Match free text to one of ACCOUNTS, case-insensitively. Returns canonical
    name or '' if no match."""
    t = (text or "").strip().lower()
    for a in ACCOUNTS:
        if a.lower() == t:
            return a
    return ""


# ---------------- helpers ----------------

def normalize_type(t):
    t = t.lower().strip()
    if t in ("investment", "invest"):
        return "invest"
    return t


def rupiah(n):
    return "Rp " + f"{int(round(n)):,}".replace(",", ".")


def authorized(message):
    """Only ALLOWED_TELEGRAM_ID may use the bot. If it is not set, nobody can: a bot with no
    owner would let anyone who finds it read and write your sheet."""
    if not ALLOWED_USER:
        try:
            bot.reply_to(message, "This bot has no owner yet. Put ALLOWED_TELEGRAM_ID="
                         f"{message.from_user.id} in .env and restart it.")
        except Exception:
            pass
        return False
    return str(message.from_user.id) == str(ALLOWED_USER)


def api_add(txn_type, amount, category, description, source="telegram",
            account="", date=""):
    """POST a transaction to the Apps Script web app.

    `date` is optional (YYYY-MM-DD). When empty, the Apps Script uses the
    current date. Used by /history to preserve each row's original date."""
    payload = {
        "action": "add",
        "secret": API_SECRET,
        "type": txn_type,
        "amount": amount,
        "category": category,
        "description": description,
        "source": source,
        "account": account,
    }
    if date:
        payload["date"] = date
    r = requests.post(APPS_SCRIPT_URL, data=json.dumps(payload),
                      headers={"Content-Type": "text/plain;charset=utf-8"}, timeout=30)
    return r.json()


def api_summary(period="monthly"):
    r = requests.get(APPS_SCRIPT_URL,
                     params={"action": "summary",
                             "period": period, "secret": API_SECRET},
                     timeout=30)
    return r.json().get("data", {})


def api_transfer(from_acct, to_acct, amount, note=""):
    """Move funds between two accounts (writes two linked rows)."""
    payload = {"action": "transfer", "secret": API_SECRET,
               "fromAccount": from_acct, "toAccount": to_acct,
               "amount": amount, "description": note, "source": "telegram"}
    r = requests.post(APPS_SCRIPT_URL, data=json.dumps(payload),
                      headers={"Content-Type": "text/plain;charset=utf-8"}, timeout=30)
    return r.json()


def api_recent(n=5):
    r = requests.get(APPS_SCRIPT_URL,
                     params={"action": "read", "secret": API_SECRET}, timeout=30)
    rows = r.json().get("data", [])
    rows.sort(key=lambda x: x["date"], reverse=True)
    return rows[:n]


def api_holdings():
    """Fetch investment holdings (gold + stocks) from the Holdings tab."""
    r = requests.get(APPS_SCRIPT_URL,
                     params={"action": "holdings", "secret": API_SECRET}, timeout=30)
    return r.json().get("data", [])


def api_sell(ticker, quantity, sell_price, account, name=""):
    """Sell a holding: reduces qty, logs income proceeds, records realized P&L."""
    payload = {"action": "sellHolding", "secret": API_SECRET,
               "ticker": ticker, "name": name, "quantity": quantity,
               "sellPrice": sell_price, "account": account, "source": "telegram"}
    r = requests.post(APPS_SCRIPT_URL, data=json.dumps(payload),
                      headers={"Content-Type": "text/plain;charset=utf-8"}, timeout=30)
    return r.json()


def api_realized():
    """Fetch realized P&L rows + total from the Realized tab."""
    r = requests.get(APPS_SCRIPT_URL,
                     params={"action": "realized", "secret": API_SECRET}, timeout=30)
    return r.json().get("data", {})


# ---------------- receipt OCR (Gemini or Claude) ----------------

OCR_PROMPT = (
    "This is a receipt photo. Extract the transaction details. "
    "Respond with ONLY a JSON object, no markdown, no prose, with keys: "
    '"amount" (number, the grand total in the receipt currency, no separators), '
    '"description" (merchant name), '
    '"category" (one of: Food & Drink, Groceries, Transport, Shopping, Paylater, '
    'Bills & Utilities, Rent / Mortgage, Health, Entertainment, Education, '
    'Subscriptions, Travel, Gifts & Donations, Family, Fees & Charges, Other). '
    "If you cannot confidently determine the category from the receipt, set "
    '"category" to an empty string "" instead of guessing. '
    '"date" (the transaction date printed on the receipt as YYYY-MM-DD, else '
    'empty string ""). '
    "If you cannot read the total, set amount to 0."
)

PAYSLIP_PROMPT = (
    "This is a payslip / salary slip (slip gaji). Extract ONLY the final "
    "take-home net pay — the amount actually received after all deductions "
    "(often labeled 'Take Home Pay', 'Gaji Bersih', 'Net Pay', 'Penerimaan "
    "Bersih', or 'THP'). Ignore gross salary, allowances, and deductions. "
    "Respond with ONLY a JSON object, no markdown, no prose, with keys: "
    '"amount" (number, the net take-home, no separators), '
    '"description" (employer name if visible, else "Salary"), '
    '"category" (always "Salary"), '
    '"date" (the pay date as YYYY-MM-DD if visible; if only the pay period '
    'month is shown, use the last day of that month; else empty string ""). '
    "If you cannot read the net pay, set amount to 0."
)


HISTORY_PROMPT = (
    "This is a screenshot of a bank/e-wallet transaction history (mutasi) — "
    "a LIST of multiple transactions. Extract EVERY transaction row you can "
    "read. Respond with ONLY a JSON array (no markdown, no prose). Each element "
    "is an object with keys: "
    '"type" (either "income" for money received/credit/masuk, or "expense" for '
    'money spent/debit/keluar), '
    '"amount" (number, positive, no separators or currency symbols), '
    '"description" (merchant/counterparty or short label), '
    '"category" (one of: Food & Drink, Transport, Shopping, Utilities, Health, '
    'Entertainment, Salary, Transfer, Other), '
    '"date" (the transaction date as YYYY-MM-DD if visible, else empty string). '
    "Infer type from sign, colour, +/- prefix, or labels like debit/kredit, "
    "masuk/keluar. Skip running-balance figures and headers. If you can read no "
    "rows, return an empty array []."
)


def clean_date(value):
    """Return `value` as YYYY-MM-DD if it is a real, non-future date, else ""."""
    try:
        d = _date.fromisoformat(str(value or "").strip()[:10])
    except ValueError:
        return ""
    return d.isoformat() if d <= _date.today() else ""


def _extract_json(text):
    """Strip markdown fences and parse the JSON object the model returned."""
    text = text.strip().replace("```json", "").replace("```", "").strip()
    return json.loads(text)


def read_receipt(image_bytes, media_type="image/jpeg", prompt=OCR_PROMPT):
    """Route to the configured OCR provider. `prompt` selects receipt vs payslip."""
    if OCR_PROVIDER == "anthropic":
        return _read_receipt_anthropic(image_bytes, media_type, prompt)
    return _read_receipt_gemini(image_bytes, media_type, prompt)


def _read_receipt_gemini(image_bytes, media_type="image/jpeg", prompt=OCR_PROMPT):
    """Free option: Google Gemini (AI Studio). Multimodal, no credit card."""
    b64 = base64.standard_b64encode(image_bytes).decode("utf-8")
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{GEMINI_MODEL}:generateContent")
    resp = requests.post(
        url,
        params={"key": GEMINI_KEY},
        headers={"content-type": "application/json"},
        data=json.dumps({
            "contents": [{
                "parts": [
                    {"inline_data": {"mime_type": media_type, "data": b64}},
                    {"text": prompt},
                ]
            }],
            # ask Gemini to emit raw JSON, not prose
            "generationConfig": {"response_mime_type": "application/json"},
        }),
        timeout=60,
    )
    data = resp.json()
    text = "".join(
        p.get("text", "")
        for p in data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
    )
    return _extract_json(text)


def _read_receipt_anthropic(image_bytes, media_type="image/jpeg", prompt=OCR_PROMPT):
    """Paid option: Anthropic Claude. Highest accuracy, no training on your data."""
    b64 = base64.standard_b64encode(image_bytes).decode("utf-8")
    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        data=json.dumps({
            "model": "claude-sonnet-4-6",
            "max_tokens": 300,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64",
                                                 "media_type": media_type, "data": b64}},
                    {"type": "text", "text": prompt},
                ],
            }],
        }),
        timeout=60,
    )
    text = "".join(b.get("text", "") for b in resp.json().get("content", []))
    return _extract_json(text)


# ---------------- command handlers ----------------

@bot.message_handler(commands=["start", "help"])
def cmd_start(message):
    if not authorized(message):
        return bot.reply_to(message, "Not authorized.")
    bot.reply_to(message,
                 "💰 *Finance Tracker Bot*\n\n"
                 "*Add by text:*\n"
                 "`/add <type> <amount> <description> [category]`\n"
                 "Example: `/add expense 85000 groceries Food & Drink`\n"
                 "Type = income / expense / invest\n\n"
                 "*Add by photo:*\n"
                 "• Send a *receipt* → logged as expense\n"
                 "• `/payslip` then send your *slip gaji* → net pay logged as income\n"
                 "• `/history` then send a *mutasi screenshot* → all rows logged at once\n\n"
                 "*Investments:*\n"
                 "`/portfolio` — live P&L on your gold + stocks\n"
                 "`/sell <ticker> <qty> <price> <account>` — sell a holding\n"
                 "`/realized` — realized profit/loss from past sales\n\n"
                 "*Transfer:*\n"
                 "`/transfer <from> <to> <amount> [note]` — move funds between accounts\n\n"
                 "*Report:*\n"
                 "`/accounts` — balance per savings account (Ivan / Mely / Bersama)\n"
                 "`/summary` — this month's balance\n"
                 "`/recent` — last 5 transactions",
                 parse_mode="Markdown")


@bot.message_handler(commands=["add"])
def cmd_add(message):
    if not authorized(message):
        return bot.reply_to(message, "Not authorized.")
    # /add expense 85000 groceries Food & Drink
    parts = message.text.split(maxsplit=4)
    if len(parts) < 4:
        return bot.reply_to(message,
                            "Format: `/add <type> <amount> <description> [category]`\n"
                            "Example: `/add expense 85000 lunch Food & Drink`",
                            parse_mode="Markdown")

    _, ttype, amount_str, rest = parts[0], parts[1], parts[2], parts[3]
    category = parts[4] if len(parts) == 5 else "Other"

    ttype = normalize_type(ttype)
    if ttype not in ("income", "expense", "invest"):
        return bot.reply_to(message, "Type must be: income, expense, or invest.")
    try:
        amount = float(amount_str.replace(".", "").replace(",", ""))
    except ValueError:
        return bot.reply_to(message, f"Couldn't read amount: {amount_str}")

    # stage it, then ask which account
    pending[message.chat.id] = {"type": ttype, "amount": amount,
                                "category": category, "description": rest,
                                "source": "telegram"}
    ask_account(message.chat.id,
                f"{ttype.title()} • {rupiah(amount)} — {rest} ({category})")


def ask_account(chat_id, summary_line):
    """Show account-picker buttons for a staged transaction."""
    kb = types.InlineKeyboardMarkup()
    kb.row(*[types.InlineKeyboardButton(a, callback_data="acc:" + a)
           for a in ACCOUNTS])
    kb.row(types.InlineKeyboardButton(
        "Skip (unassigned)", callback_data="acc:"))
    bot.send_message(chat_id,
                     f"{summary_line}\n\n💳 *Which account?*",
                     parse_mode="Markdown", reply_markup=kb)


def ask_receipt_category(chat_id, summary_line):
    """Show category buttons for a staged receipt whose category was unreadable.
    After a pick, on_receipt_category continues to the account picker."""
    kb = types.InlineKeyboardMarkup()
    btns = [types.InlineKeyboardButton(c, callback_data=f"rcat:{idx}")
            for idx, c in enumerate(HISTORY_CATEGORIES)]
    for j in range(0, len(btns), 2):       # 2 per row
        kb.row(*btns[j:j + 2])
    bot.send_message(chat_id,
                     f"{summary_line}\n\n🏷 *No category on the receipt — pick one:*",
                     parse_mode="Markdown", reply_markup=kb)


@bot.message_handler(commands=["summary"])
def cmd_summary(message):
    if not authorized(message):
        return bot.reply_to(message, "Not authorized.")
    s = api_summary("monthly")
    bot.reply_to(message,
                 "📊 *This Month*\n\n"
                 f"Income:      {rupiah(s.get('income', 0))}\n"
                 f"Expenses:    {rupiah(s.get('expense', 0))}\n"
                 f"Investments: {rupiah(s.get('invest', 0))}\n"
                 f"━━━━━━━━━━━━━━\n"
                 f"Net balance: {rupiah(s.get('net', 0))}\n"
                 f"Savings rate: {s.get('savingsRate', 0)}%",
                 parse_mode="Markdown")


@bot.message_handler(commands=["recent"])
def cmd_recent(message):
    if not authorized(message):
        return bot.reply_to(message, "Not authorized.")
    rows = api_recent(5)
    if not rows:
        return bot.reply_to(message, "No transactions yet.")
    lines = ["🧾 *Last 5*\n"]
    icon = {"income": "🟢", "expense": "🔴", "invest": "🔵"}
    for t in rows:
        acc = t.get("account", "")
        acc_tag = f"  ·  {acc}" if acc and acc != "Unassigned" else ""
        lines.append(f"{icon.get(t['type'], '•')} {t['date']}  {rupiah(t['amount'])}  "
                     f"{t['description']}{acc_tag}")
    bot.reply_to(message, "\n".join(lines), parse_mode="Markdown")


@bot.message_handler(commands=["accounts", "saldo"])
def cmd_accounts(message):
    if not authorized(message):
        return bot.reply_to(message, "Not authorized.")
    bot.send_chat_action(message.chat.id, "typing")
    try:
        r = requests.get(APPS_SCRIPT_URL,
                         params={"action": "accounts", "secret": API_SECRET}, timeout=30)
        data = r.json().get("data", {})
    except Exception as e:
        return bot.reply_to(message, f"Couldn't load balances: {e}")
    balances = data.get("balances", {})
    if not balances:
        return bot.reply_to(message, "No account activity yet.")
    lines = ["💳 *Account Balances* (all-time net)\n"]
    total = 0
    for acc in ACCOUNTS:
        bal = balances.get(acc, 0)
        total += bal
        lines.append(f"• *{acc}*: {rupiah(bal)}")
    # any extra accounts (e.g. Unassigned) not in the canonical list
    for acc, bal in balances.items():
        if acc not in ACCOUNTS:
            total += bal
            lines.append(f"• {acc}: {rupiah(bal)}")
    lines.append("━━━━━━━━━━━━━")
    lines.append(f"*Total*: {rupiah(total)}")
    bot.reply_to(message, "\n".join(lines), parse_mode="Markdown")


@bot.message_handler(commands=["transfer"])
def cmd_transfer(message):
    if not authorized(message):
        return bot.reply_to(message, "Not authorized.")
    # /transfer Ivan Bersama 20000 [note...]
    parts = message.text.split(maxsplit=4)
    if len(parts) < 4:
        return bot.reply_to(message,
                            "Format: `/transfer <from> <to> <amount> [note]`\n"
                            "Example: `/transfer Ivan Bersama 20000 shared bills`\n"
                            f"Accounts: {', '.join(ACCOUNTS)}",
                            parse_mode="Markdown")
    from_acct = resolve_account(parts[1])
    to_acct = resolve_account(parts[2])
    if not from_acct or not to_acct:
        return bot.reply_to(message,
                            f"Unknown account. Use one of: {', '.join(ACCOUNTS)}")
    if from_acct == to_acct:
        return bot.reply_to(message, "From and To must be different accounts.")
    try:
        amount = float(parts[3].replace(".", "").replace(",", ""))
    except ValueError:
        return bot.reply_to(message, f"Couldn't read amount: {parts[3]}")
    note = parts[4] if len(parts) == 5 else ""

    res = api_transfer(from_acct, to_acct, amount, note)
    if res.get("ok"):
        bot.reply_to(message,
                     f"🔁 *Transfer saved*\n"
                     f"{from_acct} → {to_acct}\n"
                     f"{rupiah(amount)}" + (f"\n_{note}_" if note else ""),
                     parse_mode="Markdown")
    else:
        bot.reply_to(message, f"⚠️ Error: {res.get('error', 'unknown')}")


@bot.message_handler(commands=["portfolio", "pnl"])
def cmd_portfolio(message):
    if not authorized(message):
        return bot.reply_to(message, "Not authorized.")
    bot.send_chat_action(message.chat.id, "typing")
    try:
        holdings = api_holdings()
    except Exception as e:
        return bot.reply_to(message, f"Couldn't load holdings: {e}")
    if not holdings:
        return bot.reply_to(message,
                            "No holdings found. Add rows to the *Holdings* tab in your sheet "
                            "(asset_type, ticker, name, quantity, buy_price, buy_date).",
                            parse_mode="Markdown")

    port = pricing.build_portfolio(holdings)   # fetches live prices
    lines = ["📈 *Investment P&L*\n"]
    any_missing = False
    for p in port["positions"]:
        if p["currentPrice"] is None:
            any_missing = True
            lines.append(f"⚠️ {p['label']} — price unavailable")
            continue
        arrow = "🟢" if p["pl"] >= 0 else "🔴"
        unit = "gr" if p["assetType"] == "gold" else "shares"
        # show how many buys were combined, and label the price as average
        lots = p.get("lots", 1)
        buy_label = "Avg buy" if lots > 1 else "Buy"
        lots_tag = f"  ·  {lots} buys" if lots > 1 else ""
        lines.append(
            f"{arrow} *{p['label']}*  ({p['quantity']:g} {unit}{lots_tag})\n"
            f"   {buy_label} {rupiah(p['buyPrice'])} → Now {rupiah(p['currentPrice'])}\n"
            f"   Value {rupiah(p['value'])}  •  P&L {rupiah(p['pl'])} ({p['plPct']:+.1f}%)"
        )
    t = port["totals"]
    total_arrow = "🟢" if t["pl"] >= 0 else "🔴"
    lines.append("━━━━━━━━━━━━━")
    lines.append(
        f"{total_arrow} *Total*\n"
        f"   Cost {rupiah(t['cost'])}  •  Value {rupiah(t['value'])}\n"
        f"   P&L {rupiah(t['pl'])} ({t['plPct']:+.1f}%)"
    )
    lines.append("\n_Stocks ~15min delayed. Gold = Antam buyback "
                 "(Emas API ID), updated daily ~08:30 WIB. For monitoring only._")
    if any_missing:
        lines.append("_Some prices couldn't be fetched; try again shortly._")
    bot.reply_to(message, "\n".join(lines), parse_mode="Markdown")


@bot.message_handler(commands=["sell"])
def cmd_sell(message):
    if not authorized(message):
        return bot.reply_to(message, "Not authorized.")
    # /sell <ticker[:brand]> <quantity> <sellprice> <account>
    parts = message.text.split()
    if len(parts) < 5:
        return bot.reply_to(message,
                            "Format: `/sell <ticker> <quantity> <sellprice> <account>`\n"
                            "Stocks: `/sell BBCA 50 11000 Ivan`\n"
                            "Gold:   `/sell LM 5 2475000 Mely`\n"
                            "Multiple gold brands? Use `TICKER:Brand` — e.g. `LM:Antam`\n"
                            f"Accounts: {', '.join(ACCOUNTS)}",
                            parse_mode="Markdown")

    raw = parts[1]
    account = resolve_account(parts[-1])
    if not account:
        return bot.reply_to(message, f"Unknown account. Use one of: {', '.join(ACCOUNTS)}")
    try:
        qty = float(parts[2].replace(".", "").replace(",", ""))
        sell_price = float(parts[3].replace(".", "").replace(",", ""))
    except ValueError:
        return bot.reply_to(message, "Couldn't read quantity or sell price as numbers.")

    # split TICKER:Brand if the user disambiguated a gold brand
    if ":" in raw:
        ticker, name = raw.split(":", 1)
        ticker, name = ticker.strip().upper(), name.strip()
    else:
        ticker, name = raw.upper(), ""

    bot.send_chat_action(message.chat.id, "typing")
    res = api_sell(ticker, qty, sell_price, account, name=name)
    data = res.get("data", {})
    if not res.get("ok") or data.get("error"):
        return bot.reply_to(message,
                            f"⚠️ {data.get('error') or res.get('error', 'sell failed')}")

    pl = data.get("realizedPl", 0)
    pl_icon = "🟢" if pl >= 0 else "🔴"
    bot.reply_to(message,
                 f"💸 *Sold*\n"
                 f"{data.get('sold'):g} {data.get('label')} @ {rupiah(data.get('sellPrice', 0))}\n"
                 f"Proceeds: {rupiah(data.get('proceeds', 0))} → {account}\n"
                 f"Avg buy: {rupiah(data.get('avgBuyPrice', 0))}\n"
                 f"{pl_icon} Realized P&L: {rupiah(pl)}",
                 parse_mode="Markdown")


@bot.message_handler(commands=["realized"])
def cmd_realized(message):
    if not authorized(message):
        return bot.reply_to(message, "Not authorized.")
    bot.send_chat_action(message.chat.id, "typing")
    try:
        data = api_realized()
    except Exception as e:
        return bot.reply_to(message, f"Couldn't load realized P&L: {e}")
    rows = data.get("rows", [])
    if not rows:
        return bot.reply_to(message, "No sales recorded yet. Use /sell to record one.")
    rows.sort(key=lambda x: x.get("date", ""), reverse=True)
    lines = ["💰 *Realized P&L*\n"]
    for r in rows[:10]:
        pl = r.get("realizedPl", 0)
        icon = "🟢" if pl >= 0 else "🔴"
        lines.append(f"{icon} {r['date']}  {r.get('name') or r.get('ticker')}  "
                     f"({r['quantity']:g})  {rupiah(pl)}")
    total = data.get("totalRealized", 0)
    total_icon = "🟢" if total >= 0 else "🔴"
    lines.append("━━━━━━━━━━━━━")
    lines.append(f"{total_icon} *Total realized: {rupiah(total)}*")
    if len(rows) > 10:
        lines.append(f"_(showing 10 of {len(rows)} sales)_")
    bot.reply_to(message, "\n".join(lines), parse_mode="Markdown")


# ---------------- photo (receipt / payslip) handler ----------------

# chat ids waiting to send a payslip photo (set by /payslip)
payslip_mode = set()

# chat ids waiting to send a transaction-history screenshot (set by /history)
history_mode = set()

# Per-chat review session for a parsed history batch. Each value:
#   {"rows": [...], "i": <cursor>, "awaiting_rename": bool}
# We walk rows one at a time: confirm/rename description -> pick category ->
# pick account -> save -> advance. QRIS rows often lack the real tenant name,
# so the rename step lets you type it in before saving.
history_review = {}

# categories offered during per-row review (index used in callback_data)
HISTORY_CATEGORIES = ["Food & Drink", "Groceries", "Transport", "Shopping",
                      "Paylater", "Bills & Utilities", "Rent / Mortgage",
                      "Health", "Entertainment", "Education", "Family", "Fees & Charges",
                      "Other"]


@bot.message_handler(commands=["payslip", "slipgaji"])
def cmd_payslip(message):
    if not authorized(message):
        return bot.reply_to(message, "Not authorized.")
    if not OCR_KEY:
        return bot.reply_to(message, "Scanning is off (no API key configured).")
    payslip_mode.add(message.chat.id)
    bot.reply_to(message,
                 "📄 *Payslip mode on.* Send your payslip photo now and I'll log the "
                 "*net take-home* as income.\n\n_The next photo only; after that it's back "
                 "to receipts._", parse_mode="Markdown")


@bot.message_handler(commands=["history", "mutasi"])
def cmd_history(message):
    if not authorized(message):
        return bot.reply_to(message, "Not authorized.")
    if not OCR_KEY:
        return bot.reply_to(message, "Scanning is off (no API key configured).")
    history_mode.add(message.chat.id)
    bot.reply_to(message,
                 "📜 *History mode on.* Send a screenshot of your transaction "
                 "history (mutasi). I'll read every row, then walk you through them "
                 "*one by one* — you can fix the QRIS description, pick a category, "
                 "and choose the account for each.\n\n_The next photo only._",
                 parse_mode="Markdown")


def _review_row_text(row, idx, total):
    """Build the review card for a single parsed row."""
    icon = {"income": "🟢", "expense": "🔴"}.get(row["type"], "•")
    d = f"{row['date']}\n" if row.get("date") else ""
    return (f"📜 *Review {idx + 1} of {total}*\n\n"
            f"{icon} *{row['type'].title()}* • {rupiah(row['amount'])}\n"
            f"{d}"
            f"Description: _{row['description']}_\n"
            f"Category: _{row['category']}_")


def send_review_card(chat_id, message_id=None):
    """Show the current row with Keep / Rename / Skip buttons.
    If message_id is given, edit that message in place; else send a new one."""
    sess = history_review.get(chat_id)
    if not sess:
        return
    i, rows = sess["i"], sess["rows"]
    total = len(rows)

    # finished?
    if i >= total:
        saved = sess.get("saved", 0)
        skipped = sess.get("skipped", 0)
        failed = sess.get("failed", 0)
        history_review.pop(chat_id, None)
        msg = (f"✅ *History import done*\n"
               f"Saved: {saved}" +
               (f" • Skipped: {skipped}" if skipped else "")
               + (f" • Failed: {failed}" if failed else ""))
        if message_id:
            return bot.edit_message_text(msg, chat_id, message_id, parse_mode="Markdown")
        return bot.send_message(chat_id, msg, parse_mode="Markdown")

    row = rows[i]
    kb = types.InlineKeyboardMarkup()
    kb.row(types.InlineKeyboardButton("✅ Keep name", callback_data="hkeep:"),
           types.InlineKeyboardButton("✏️ Rename", callback_data="hren:"))
    kb.row(types.InlineKeyboardButton("⏭ Skip row", callback_data="hskip:"),
           types.InlineKeyboardButton("❌ Cancel all", callback_data="hcancel:"))
    text = _review_row_text(row, i, total)
    if message_id:
        bot.edit_message_text(text, chat_id, message_id,
                              parse_mode="Markdown", reply_markup=kb)
    else:
        bot.send_message(chat_id, text, parse_mode="Markdown", reply_markup=kb)


def ask_review_category(chat_id, message_id):
    """Category picker for the current row (indices keep callback_data short)."""
    kb = types.InlineKeyboardMarkup()
    btns = [types.InlineKeyboardButton(c, callback_data=f"hcat:{idx}")
            for idx, c in enumerate(HISTORY_CATEGORIES)]
    # 2 per row
    for j in range(0, len(btns), 2):
        kb.row(*btns[j:j + 2])
    bot.edit_message_text("🏷 *Pick a category for this row:*",
                          chat_id, message_id, parse_mode="Markdown",
                          reply_markup=kb)


def ask_review_account(chat_id, message_id):
    """Account picker for the current row."""
    kb = types.InlineKeyboardMarkup()
    kb.row(*[types.InlineKeyboardButton(a, callback_data="hracc:" + a)
           for a in ACCOUNTS])
    kb.row(types.InlineKeyboardButton(
        "Skip (unassigned)", callback_data="hracc:"))
    bot.edit_message_text("💳 *Which account for this row?*",
                          chat_id, message_id, parse_mode="Markdown",
                          reply_markup=kb)


@bot.message_handler(content_types=["photo"])
def handle_photo(message):
    if not authorized(message):
        return bot.reply_to(message, "Not authorized.")
    if not OCR_KEY:
        return bot.reply_to(message, "Receipt scanning is off (no API key configured).")

    is_payslip = message.chat.id in payslip_mode
    payslip_mode.discard(message.chat.id)   # consume the flag
    is_history = message.chat.id in history_mode
    history_mode.discard(message.chat.id)   # consume the flag

    bot.send_chat_action(message.chat.id, "typing")
    file_id = message.photo[-1].file_id          # highest-resolution version
    file_info = bot.get_file(file_id)
    image_bytes = bot.download_file(file_info.file_path)

    # ---- history screenshot: parse a LIST of rows, batch-confirm ----
    if is_history:
        try:
            rows = read_receipt(image_bytes, prompt=HISTORY_PROMPT)
        except Exception as e:
            return bot.reply_to(message, f"Couldn't read the history: {e}")
        if not isinstance(rows, list):
            rows = rows.get("transactions", []) if isinstance(
                rows, dict) else []

        cleaned = []
        for r in rows:
            try:
                amt = float(str(r.get("amount", 0)).replace(
                    ".", "").replace(",", ""))
            except (ValueError, TypeError):
                amt = 0
            if amt <= 0:
                continue
            ttype = "income" if str(r.get("type", "")).lower(
            ).startswith("inc") else "expense"
            cleaned.append({
                "type": ttype,
                "amount": amt,
                "category": r.get("category") or "Other",
                "description": r.get("description") or "History",
                "date": clean_date(r.get("date")),
                "source": "ocr-history",
            })

        if not cleaned:
            return bot.reply_to(message,
                                "I couldn't read any transaction rows from that "
                                "screenshot. Try a clearer crop, or add them with /add.")

        net = sum(t["amount"] if t["type"] == "income" else -t["amount"]
                  for t in cleaned)

        # preview up to 8 rows
        icon = {"income": "🟢", "expense": "🔴"}
        preview = [
            f"📜 *Parsed {len(cleaned)} transaction(s)* • net {rupiah(net)}\n"]
        for t in cleaned[:8]:
            d = f"{t['date']}  " if t["date"] else ""
            preview.append(
                f"{icon[t['type']]} {d}{rupiah(t['amount'])}  {t['description']}")
        if len(cleaned) > 8:
            preview.append(f"_…and {len(cleaned) - 8} more_")
        preview.append("\n_Let's review them one by one._")
        bot.reply_to(message, "\n".join(preview), parse_mode="Markdown")

        # start the per-row review session
        history_review[message.chat.id] = {
            "rows": cleaned, "i": 0, "awaiting_rename": False,
            "saved": 0, "skipped": 0, "failed": 0,
        }
        return send_review_card(message.chat.id)

    try:
        prompt = PAYSLIP_PROMPT if is_payslip else OCR_PROMPT
        data = read_receipt(image_bytes, prompt=prompt)
    except Exception as e:
        label = "payslip" if is_payslip else "receipt"
        return bot.reply_to(message, f"Couldn't read the {label}: {e}")

    amount = data.get("amount", 0)
    txn_date = clean_date(data.get("date"))
    date_line = f"\nDate: {txn_date}" if txn_date else "\nDate: today"

    if is_payslip:
        desc = data.get("description", "Salary")
        if not amount:
            return bot.reply_to(message,
                                "I couldn't find the net take-home on that payslip. "
                                "Add it manually with /add income <amount> Salary.")
        pending[message.chat.id] = {"type": "income", "amount": amount,
                                    "category": "Salary", "description": desc,
                                    "source": "ocr", "date": txn_date}
        bot.reply_to(message,
                     f"📄 *Payslip detected*\n"
                     f"Employer: {desc}\n"
                     f"Net take-home: {rupiah(amount)}{date_line}",
                     parse_mode="Markdown")
        return ask_account(message.chat.id,
                           f"Income • {rupiah(amount)} — {desc} (Salary)")

    # default: receipt -> expense
    desc = data.get("description", "Receipt")
    cat = (data.get("category") or "").strip()
    if not amount:
        return bot.reply_to(message,
                            "I couldn't find a total on that receipt. Add it manually with /add.")
    pending[message.chat.id] = {"type": "expense", "amount": amount,
                                "category": cat or "Other", "description": desc,
                                "source": "ocr", "date": txn_date}
    # if the OCR couldn't read a category, ask for it with buttons first
    if not cat:
        bot.reply_to(message,
                     f"🧾 *Receipt detected*\n"
                     f"Merchant: {desc}\n"
                     f"Amount: {rupiah(amount)}\n"
                     f"Category: _not found_{date_line}",
                     parse_mode="Markdown")
        return ask_receipt_category(message.chat.id,
                                    f"Expense • {rupiah(amount)} — {desc}")
    bot.reply_to(message,
                 f"🧾 *Receipt detected*\n"
                 f"Merchant: {desc}\n"
                 f"Amount: {rupiah(amount)}\n"
                 f"Category: {cat}{date_line}",
                 parse_mode="Markdown")
    ask_account(message.chat.id,
                f"Expense • {rupiah(amount)} — {desc} ({cat})")


def _awaiting_rename(message):
    """True only when this chat is mid-review and waiting for a typed tenant name."""
    sess = history_review.get(message.chat.id)
    return bool(sess and sess.get("awaiting_rename"))


@bot.message_handler(func=_awaiting_rename, content_types=["text"])
def on_review_rename_text(message):
    """Capture the typed description, then go to category picker."""
    if not authorized(message):
        return
    sess = history_review.get(message.chat.id)
    if not sess:
        return
    name = (message.text or "").strip()
    if not name:
        return bot.reply_to(message, "Empty — type the description, please.")
    sess["rows"][sess["i"]]["description"] = name
    sess["awaiting_rename"] = False
    bot.reply_to(message, f"Renamed to *{name}*.", parse_mode="Markdown")
    # send a fresh card (new message) leading straight into category
    msg = bot.send_message(message.chat.id, "🏷 *Pick a category for this row:*",
                           parse_mode="Markdown")
    ask_review_category(message.chat.id, msg.message_id)


@bot.callback_query_handler(func=lambda c: c.data and c.data.startswith("hkeep:"))
def on_review_keep(call):
    """Keep the parsed description -> go to category picker."""
    chat_id = call.message.chat.id
    sess = history_review.get(chat_id)
    if not sess:
        return bot.edit_message_text("⌛ This review expired. Re-send the screenshot.",
                                     chat_id, call.message.message_id)
    sess["awaiting_rename"] = False
    ask_review_category(chat_id, call.message.message_id)


@bot.callback_query_handler(func=lambda c: c.data and c.data.startswith("hren:"))
def on_review_rename(call):
    """Ask the user to type the description for this row."""
    chat_id = call.message.chat.id
    sess = history_review.get(chat_id)
    if not sess:
        return bot.edit_message_text("⌛ This review expired. Re-send the screenshot.",
                                     chat_id, call.message.message_id)
    sess["awaiting_rename"] = True
    row = sess["rows"][sess["i"]]
    bot.edit_message_text(
        f"✏️ *Type the description* for:\n"
        f"{rupiah(row['amount'])} — _{row['description']}_\n\n"
        f"_Send it as a normal message._",
        chat_id, call.message.message_id, parse_mode="Markdown")


@bot.callback_query_handler(func=lambda c: c.data and c.data.startswith("hskip:"))
def on_review_skip(call):
    """Skip this row entirely (don't save) and advance."""
    chat_id = call.message.chat.id
    sess = history_review.get(chat_id)
    if not sess:
        return bot.edit_message_text("⌛ This review expired. Re-send the screenshot.",
                                     chat_id, call.message.message_id)
    sess["skipped"] += 1
    sess["i"] += 1
    sess["awaiting_rename"] = False
    send_review_card(chat_id, call.message.message_id)


@bot.callback_query_handler(func=lambda c: c.data and c.data.startswith("hcat:"))
def on_review_category(call):
    """Category chosen for the current row -> go to account picker."""
    chat_id = call.message.chat.id
    sess = history_review.get(chat_id)
    if not sess:
        return bot.edit_message_text("⌛ This review expired. Re-send the screenshot.",
                                     chat_id, call.message.message_id)
    try:
        idx = int(call.data.split(":", 1)[1])
        cat = HISTORY_CATEGORIES[idx]
    except (ValueError, IndexError):
        cat = "Other"
    sess["rows"][sess["i"]]["category"] = cat
    ask_review_account(chat_id, call.message.message_id)


@bot.callback_query_handler(func=lambda c: c.data and c.data.startswith("hracc:"))
def on_review_account(call):
    """Account chosen -> SAVE this row, then advance to the next."""
    chat_id = call.message.chat.id
    sess = history_review.get(chat_id)
    if not sess:
        return bot.edit_message_text("⌛ This review expired. Re-send the screenshot.",
                                     chat_id, call.message.message_id)
    account = call.data.split(":", 1)[1]      # '' = unassigned
    row = sess["rows"][sess["i"]]
    try:
        res = api_add(row["type"], row["amount"], row["category"],
                      row["description"], source=row.get(
                          "source", "ocr-history"),
                      account=account, date=row.get("date", ""))
        if res.get("ok"):
            sess["saved"] += 1
        else:
            sess["failed"] += 1
    except Exception:
        sess["failed"] += 1

    sess["i"] += 1
    sess["awaiting_rename"] = False
    send_review_card(chat_id, call.message.message_id)


@bot.callback_query_handler(func=lambda c: c.data and c.data.startswith("hcancel:"))
def on_history_cancel(call):
    """Abort the whole review; rows already saved stay saved."""
    chat_id = call.message.chat.id
    sess = history_review.pop(chat_id, None)
    saved = sess.get("saved", 0) if sess else 0
    bot.edit_message_text(
        f"❌ Review cancelled." + (f" {saved} already saved." if saved else ""),
        chat_id, call.message.message_id)


@bot.callback_query_handler(func=lambda c: c.data and c.data.startswith("rcat:"))
def on_receipt_category(call):
    """Category chosen for a staged receipt -> continue to the account picker."""
    chat_id = call.message.chat.id
    item = pending.get(chat_id)
    if not item:
        return bot.edit_message_text("⌛ This entry expired. Please re-send the receipt.",
                                     chat_id, call.message.message_id)
    try:
        idx = int(call.data.split(":", 1)[1])
        cat = HISTORY_CATEGORIES[idx]
    except (ValueError, IndexError):
        cat = "Other"
    item["category"] = cat
    bot.edit_message_text(
        f"🏷 Category set: *{cat}*\n"
        f"{item['type'].title()} • {rupiah(item['amount'])} — {item['description']}",
        chat_id, call.message.message_id, parse_mode="Markdown")
    ask_account(chat_id,
                f"Expense • {rupiah(item['amount'])} — {item['description']} ({cat})")


@bot.callback_query_handler(func=lambda c: c.data and c.data.startswith("acc:"))
def on_account(call):
    """Account chosen -> save the staged transaction with that account."""
    chat_id = call.message.chat.id
    item = pending.pop(chat_id, None)
    if not item:
        return bot.edit_message_text("⌛ This entry expired. Please re-enter it.",
                                     chat_id, call.message.message_id)
    account = call.data.split(":", 1)[1]          # '' = unassigned (Skip)
    res = api_add(item["type"], item["amount"], item["category"],
                  item["description"], source=item.get("source", "telegram"),
                  account=account, date=item.get("date", ""))
    if res.get("ok"):
        label = item["type"].title()
        acc_line = f"\nAccount: {account}" if account else "\nAccount: (unassigned)"
        if item.get("date"):
            acc_line += f"\nDate: {item['date']}"
        bot.edit_message_text(
            f"✅ Saved\n{label} • {rupiah(item['amount'])}\n"
            f"{item['description']} ({item['category']}){acc_line}",
            chat_id, call.message.message_id)
    else:
        bot.edit_message_text(f"⚠️ Error: {res.get('error', 'unknown')}",
                              chat_id, call.message.message_id)


@bot.callback_query_handler(func=lambda c: True)
def on_cancel(call):
    """Any other callback (e.g. stray Cancel) clears the staged item."""
    chat_id = call.message.chat.id
    pending.pop(chat_id, None)
    bot.edit_message_text("❌ Cancelled.", chat_id, call.message.message_id)


# ---------------- run ----------------

if __name__ == "__main__":
    print("Bot is running (long polling)...")
    bot.infinity_polling(timeout=30)
