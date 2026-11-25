"""
pricing.py — live market data for the finance bot.

  get_gold_buyback()        -> Antam 1-gram buyback price (IDR), via page, then API
  get_stock_price(ticker)   -> last price for an IDX ticker (IDR), via Yahoo
  build_portfolio(holdings) -> P&L per position + totals

All functions degrade gracefully: on any failure they return a result
with price=None and a 'source'/'error' note rather than raising, so the
bot can still answer with partial data.
"""

import os
import sys
import json
import requests

# First gold source: the muamalahemas.com scraper (scripts/gold_scraper.py,
# standard library only).
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
try:
    import gold_scraper
except Exception:  # pragma: no cover - the API still works without it
    gold_scraper = None

UA = {"User-Agent": "Mozilla/5.0 (compatible; FinanceBot/1.0)"}


# ---------------- GOLD (Antam buyback) ----------------
#
# First source: https://muamalahemas.com/ (a reseller's Antam buyback, no key).
# Second source: Emas API ID  (https://emas.maulanar.my.id) — a dedicated gold-price
# SaaS whose "antam" resource is the OFFICIAL logammulia.com Antam price
# (not a reseller rate). Requires a free API key.
#
# SETUP:
#   1. Register at https://emas.maulanar.my.id/register
#   2. Copy your API key from the dashboard
#   3. Put it in .env as:  EMAS_API_KEY=your_key_here
#
# NOTE: Antam publishes its buyback ONCE PER BUSINESS DAY (~08:30 WIB), so this
# is a daily figure, not tick-by-tick. The response includes the date and the
# day-over-day change so you can see how fresh it is.

EMAS_API_BASE = "https://emas.maulanar.my.id/api/prices"
EMAS_API_KEY = os.environ.get("EMAS_API_KEY", "")


def get_gold_buyback():
    """
    Antam 1-gram buyback price (IDR).
    Returns {"price": float|None, "source": str, "date": str?, "change": float?, "error": str?}.
    Buyback = the price Antam BUYS BACK from you = what your gold is worth.

    Reads muamalahemas.com first; when that gives no price (unreachable or the
    layout changed) it falls back to Emas API ID. "fallback_reason" says why.
    """
    res = _gold_from_page()
    if res.get("price") is not None:
        return res
    fb = _gold_from_api()
    if fb.get("price") is not None:
        fb["fallback_reason"] = res.get("error", "page gave no price")
        return fb
    res["error"] = f"{res.get('error', 'no price')}; API fallback failed: {fb.get('error')}"
    return res


def _gold_from_page():
    """The "Buyback per 1 Gr" price on muamalahemas.com."""
    if gold_scraper is None:
        return {"price": None, "source": "muamalahemas", "error": "gold_scraper not available"}
    try:
        page = gold_scraper.scrape()
        bb = float(page["buyback"])
        if not (500_000 <= bb <= 50_000_000):   # sanity bound
            return {"price": None, "source": "muamalahemas", "error": f"price out of range: {bb}"}
        return {"price": bb, "source": "muamalahemas.com (scraped Antam buyback)",
                "date": page["updated"]}
    except Exception as e:
        return {"price": None, "source": "muamalahemas", "error": str(e)}


def _gold_from_api():
    """The keyed JSON API. Same return shape as get_gold_buyback()."""
    if not EMAS_API_KEY:
        return {"price": None, "source": "emas-api-id",
                "error": "no EMAS_API_KEY set — register at "
                         "https://emas.maulanar.my.id/register"}
    try:
        # brand AND resource both 'antam' -> the official logammulia.com price.
        # weight=1 -> the 1-gram row.
        r = requests.get(
            EMAS_API_BASE,
            params={"brand": "ANTAM", "resource": "antam", "weight": "1"},
            headers={**UA, "X-API-Key": EMAS_API_KEY},
            timeout=20,
        )
        if r.status_code >= 400:   # 429 = usage limit reached, 401/403 = bad key
            return {"price": None, "source": "emas-api-id",
                    "error": f"API HTTP {r.status_code}"}
        data = r.json()
        rows = data.get("data", [])
        # /api/prices returns a list; find the 1g Antam buyback
        for row in rows:
            if str(row.get("brand", "")).lower() != "antam":
                continue
            if row.get("weight") not in (1, "1", 1.0):
                continue
            bb = row.get("buyback_price")
            if bb is None:
                continue
            bb = float(bb)
            if not (500_000 <= bb <= 50_000_000):   # sanity bound
                continue
            return {"price": bb, "source": "Emas API ID (official Antam buyback)",
                    "date": row.get("updated_at") or row.get("date", ""),
                    "change": row.get("buyback_price_change")}
        return {"price": None, "source": "emas-api-id",
                "error": "no 1g Antam buyback in response"}
    except Exception as e:
        return {"price": None, "source": "emas-api-id", "error": str(e)}


# ---------------- STOCKS (Yahoo Finance, .JK) ----------------

def get_stock_price(ticker):
    """
    Last price for an IDX ticker via Yahoo's free quote endpoint.
    'BBCA' -> appends '.JK'. Returns {"price": float|None, "source", "error"?}.
    """
    yf_ticker = ticker if "." in ticker else ticker + ".JK"
    url = "https://query1.finance.yahoo.com/v8/finance/chart/" + yf_ticker
    try:
        r = requests.get(url, headers=UA, params={
                         "interval": "1d", "range": "1d"}, timeout=20)
        data = r.json()
        result = data["chart"]["result"][0]
        price = result["meta"].get("regularMarketPrice")
        if price is not None:
            return {"price": float(price), "source": "Yahoo Finance (delayed)"}
        return {"price": None, "source": "yahoo", "error": "no price in response"}
    except Exception as e:
        return {"price": None, "source": "yahoo", "error": str(e)}


# ---------------- PORTFOLIO P&L ----------------

def build_portfolio(holdings):
    """
    holdings: list of dicts from the Apps Script 'holdings' endpoint, each with
      assetType ('gold'|'stock'), ticker, name, quantity, buyPrice, buyDate.

    Holdings are AGGREGATED by position: multiple buys of the same ticker (or the
    same gold item) are combined into one line with total quantity, total cost,
    and a weighted-average buy price (= total cost / total quantity). The current
    market price is then fetched once per unique position.

    Returns {positions:[...], totals:{...}} with P&L computed.
    Gold quantity is in grams; stock quantity in shares.
    """
    # --- step 1: aggregate lots into positions ---
    groups = {}          # key -> aggregated dict
    order = []           # preserve first-seen order
    for h in holdings:
        atype = h.get("assetType", "")
        qty = float(h.get("quantity", 0) or 0)
        buy = float(h.get("buyPrice", 0) or 0)
        if qty <= 0:
            continue
        ticker = str(h.get("ticker", "")).upper().strip()
        name = h.get("name", "") or ticker or atype
        # group key: stocks by ticker (same ticker = same stock); gold by
        # ticker + brand-name so different brands (Antam LM vs UBS LM) stay
        # separate even when they share a ticker like "LM".
        if atype == "stock" and ticker:
            key = f"stock:{ticker}"
        else:
            key = f"{atype}:{ticker}:{name.lower()}"
        if key not in groups:
            # nice display label: "Antam LM" rather than just "Antam"
            label = name if not ticker or ticker.lower(
            ) in name.lower() else f"{name} {ticker}"
            groups[key] = {"assetType": atype, "ticker": ticker, "label": label,
                           "quantity": 0.0, "cost": 0.0, "lots": 0}
            order.append(key)
        g = groups[key]
        g["quantity"] += qty
        g["cost"] += qty * buy
        g["lots"] += 1

    # --- step 2: price each aggregated position once ---
    positions = []
    gold_price = None
    total_cost = 0.0
    total_value = 0.0

    for key in order:
        g = groups[key]
        atype = g["assetType"]
        qty = g["quantity"]
        cost = g["cost"]
        # weighted-average buy price
        avg_buy = (cost / qty) if qty else 0.0

        if atype == "gold":
            if gold_price is None:
                gold_price = get_gold_buyback()
            cur = gold_price.get("price")
            src = gold_price.get("source")
        elif atype == "stock":
            q = get_stock_price(g["ticker"])
            cur = q.get("price")
            src = q.get("source")
        else:
            cur, src = None, "unknown asset_type"

        if cur is not None:
            value = qty * cur
            pl = value - cost
            pl_pct = (pl / cost * 100) if cost else 0.0
            total_cost += cost
            total_value += value
        else:
            value = pl = pl_pct = None

        positions.append({
            "assetType": atype,
            "label": g["label"],
            "ticker": g["ticker"],
            "quantity": qty,
            "buyPrice": avg_buy,        # weighted average across all lots
            "lots": g["lots"],          # how many buys were combined
            "currentPrice": cur,
            "cost": cost,
            "value": value,
            "pl": pl,
            "plPct": pl_pct,
            "source": src,
        })

    total_pl = total_value - total_cost
    total_pl_pct = (total_pl / total_cost * 100) if total_cost else 0.0
    return {
        "positions": positions,
        "totals": {
            "cost": total_cost,
            "value": total_value,
            "pl": total_pl,
            "plPct": total_pl_pct,
        },
    }
