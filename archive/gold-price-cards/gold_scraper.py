#!/usr/bin/env python3
"""Scrape gold prices from https://emas.maulanar.my.id/price-cards.

Standard library only (urllib + html.parser), no API key needed.
The page is server-rendered: one `.price-card-item` per product, holding the
brand, the sell price ("Harga Jual"), the buyback price, the day change of each,
the weight ("Ukuran") and the last update date ("Update Terakhir").

Use as a library:
    from gold_scraper import scrape, find
    cards = scrape()
    antam_1g = find(cards, brand="ANTAM", weight_gram=1)
    print(antam_1g["buyback"])

Use from the command line:
    python scripts/gold_scraper.py                       # table of all cards
    python scripts/gold_scraper.py --brand ANTAM         # filter by brand
    python scripts/gold_scraper.py --brand ANTAM --weight 1 --json
    python scripts/gold_scraper.py --csv > gold.csv
    python scripts/gold_scraper.py --html saved_page.html   # parse a saved file

If the site changes its markup, parsing raises ScrapeError instead of
returning wrong numbers.
"""
import argparse
import csv
import json
import re
import sys
import time
import urllib.error
import urllib.request
from html.parser import HTMLParser

URL = "https://emas.maulanar.my.id/price-cards"
USER_AGENT = "Mozilla/5.0 (compatible; FinanceTracker-GoldScraper/1.0)"

LABELS = {
    "harga jual": "sell",
    "buyback": "buyback",
    "ukuran": "weight",
    "update terakhir": "updated",
}


class ScrapeError(RuntimeError):
    pass


# --------------------------------------------------------------------------- #
# Fetching
# --------------------------------------------------------------------------- #
def fetch(url=URL, retries=3, timeout=30):
    """Download the page as text. Retries on network errors and 5xx."""
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                                       "Accept-Language": "id,en;q=0.8"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode(r.headers.get_content_charset() or "utf-8")
        except urllib.error.HTTPError as e:
            last = e
            if e.code < 500:
                break
        except (urllib.error.URLError, TimeoutError) as e:
            last = e
        time.sleep(1.5 * (attempt + 1))
    raise ScrapeError(f"could not fetch {url}: {last}")


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #
class _CardParser(HTMLParser):
    """Collect, for every .price-card-item, its data-brand and its text nodes."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.cards = []        # [{"brand": str, "card_id": str, "tokens": [str]}]
        self._depth = 0        # div depth inside the current card
        self._skip = 0         # inside <script>/<style>/<button>
        self._cur = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ("script", "style", "button", "svg"):
            self._skip += 1
        if tag == "div":
            if self._cur is None and "price-card-item" in (a.get("class") or "").split():
                self._cur = {"brand": (a.get("data-brand") or "").strip(),
                             "card_id": "", "tokens": []}
                self._depth = 1
                return
            if self._cur is not None:
                self._depth += 1
                if a.get("id", "").startswith("card-"):
                    self._cur["card_id"] = a["id"][5:]

    def handle_endtag(self, tag):
        if tag in ("script", "style", "button", "svg") and self._skip:
            self._skip -= 1
        if tag == "div" and self._cur is not None:
            self._depth -= 1
            if self._depth == 0:
                self.cards.append(self._cur)
                self._cur = None

    def handle_data(self, data):
        if self._cur is None or self._skip:
            return
        text = " ".join(data.split())
        if text:
            self._cur["tokens"].append(text)


def parse_rupiah(text):
    """'Rp 2.515.000' -> 2515000; 'Rp -7.000' -> -7000; None if no number."""
    m = re.search(r"(-)?\s*Rp\s*(-)?\s*([\d.,]+)", text)
    if not m:
        return None
    digits = re.sub(r"[.,]", "", m.group(3))
    if not digits:
        return None
    value = int(digits)
    return -value if (m.group(1) or m.group(2)) else value


def parse_weight(text):
    """'1 Gram' -> 1.0, '0,5 Gram' -> 0.5, '1 Kg' -> 1000.0; None if unknown."""
    m = re.search(r"([\d.,]+)\s*(kg|kilogram|gram|gr|g)\b", text, re.I)
    if not m:
        return None
    num = m.group(1)
    # Indonesian format uses "," as the decimal mark and "." for thousands.
    if "," in num:
        num = num.replace(".", "").replace(",", ".")
    elif num.count(".") > 1 or re.fullmatch(r"\d{1,3}\.\d{3}", num):
        num = num.replace(".", "")
    value = float(num)
    return value * 1000 if m.group(2).lower().startswith("k") else value


def _change(token):
    """'↓ Rp -20.000' / '↑ Rp 5.000' -> signed int; None if not a change pill."""
    if "Rp" not in token or re.match(r"^Rp\s*[\d.,]+$", token):
        return None  # not a pill, or a plain price
    value = parse_rupiah(token)
    if value is None:
        return None
    down = bool(re.match(r"^\s*[↓▼]", token))
    up = bool(re.match(r"^\s*[↑▲]", token))
    if down:
        return -abs(value)
    if up:
        return abs(value)
    return value


def _card_from_tokens(raw):
    tokens = raw["tokens"]
    card = {
        "brand": raw["brand"],
        "card_id": raw["card_id"],
        "name": None,
        "source": None,
        "weight_gram": None,
        "weight_text": None,
        "sell": None,
        "sell_change": None,
        "buyback": None,
        "buyback_change": None,
        "updated": None,
    }
    section = None
    for tok in tokens:
        key = LABELS.get(tok.lower())
        if key:
            section = key
            continue
        if tok.startswith("●"):
            card["source"] = tok.lstrip("● ").strip()
            continue
        if section in ("sell", "buyback"):
            if tok.startswith("Rp") and re.match(r"^Rp\s*[\d.,]+$", tok):
                card[section] = parse_rupiah(tok) or None  # "Rp 0" means no price listed
            else:
                ch = _change(tok)
                if ch is not None:
                    card[f"{section}_change"] = ch
        elif section == "weight" and card["weight_text"] is None:
            card["weight_text"] = tok
            card["weight_gram"] = parse_weight(tok)
        elif section == "updated" and card["updated"] is None:
            if re.match(r"^\d{4}-\d{2}-\d{2}", tok):
                card["updated"] = tok
        elif section is None and card["name"] is None and not tok.startswith("●"):
            card["name"] = tok.strip()
    if card["name"] is None:
        card["name"] = card["brand"]
    return card


def parse(html):
    """Parse the page HTML into a list of card dicts."""
    p = _CardParser()
    p.feed(html)
    p.close()
    if not p.cards:
        raise ScrapeError("no price cards found: the page layout may have changed")
    cards = [_card_from_tokens(c) for c in p.cards]
    bad = [c for c in cards if c["sell"] is None and c["buyback"] is None]
    if len(bad) == len(cards):
        raise ScrapeError("found cards but no prices: the page layout may have changed")
    return cards


def scrape(url=URL, html=None):
    """Fetch (unless html is given) and parse. Returns a list of card dicts."""
    return parse(html if html is not None else fetch(url))


def find(cards, brand=None, weight_gram=None):
    """Filter cards by brand (case-insensitive, exact) and/or weight in grams."""
    out = []
    for c in cards:
        if brand and c["brand"].lower() != brand.lower():
            continue
        if weight_gram is not None and (c["weight_gram"] is None
                                        or abs(c["weight_gram"] - weight_gram) > 1e-9):
            continue
        out.append(c)
    if brand is not None and weight_gram is not None:
        return out[0] if out else None
    return out


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
FIELDS = ["brand", "name", "weight_gram", "sell", "sell_change", "buyback",
          "buyback_change", "updated", "source", "card_id"]


def _fmt(n):
    return "-" if n is None else f"{n:,}".replace(",", ".")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Scrape gold prices from emas.maulanar.my.id")
    ap.add_argument("--brand", help="filter by brand, e.g. ANTAM, UBS, 'GALERI 24'")
    ap.add_argument("--weight", type=float, help="filter by weight in grams, e.g. 1 or 0.5")
    ap.add_argument("--json", action="store_true", help="print JSON")
    ap.add_argument("--csv", action="store_true", help="print CSV")
    ap.add_argument("--html", metavar="FILE", help="parse a saved HTML file instead of fetching")
    ap.add_argument("--url", default=URL)
    args = ap.parse_args(argv)

    try:
        html = open(args.html, encoding="utf-8").read() if args.html else None
        cards = scrape(args.url, html)
    except (ScrapeError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    cards = [c for c in cards
             if (not args.brand or c["brand"].lower() == args.brand.lower())
             and (args.weight is None or c["weight_gram"] == args.weight)]

    if args.json:
        print(json.dumps(cards, indent=2, ensure_ascii=False))
    elif args.csv:
        w = csv.DictWriter(sys.stdout, fieldnames=FIELDS, extrasaction="ignore", lineterminator="\n")
        w.writeheader()
        w.writerows(cards)
    else:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8")
        print(f"{'BRAND':<22}{'GRAM':>7}{'SELL':>13}{'BUYBACK':>13}{'Δ BUYBACK':>11}  UPDATED")
        for c in cards:
            g = "-" if c["weight_gram"] is None else f"{c['weight_gram']:g}"
            print(f"{c['brand']:<22}{g:>7}{_fmt(c['sell']):>13}{_fmt(c['buyback']):>13}"
                  f"{_fmt(c['buyback_change']):>11}  {c['updated'] or '-'}")
        print(f"\n{len(cards)} card(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
