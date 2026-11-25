#!/usr/bin/env python3
"""Scrape the Antam 1 g buyback price from https://muamalahemas.com/.

Standard library only, no API key needed. The page is server-rendered: the
"Tabel Harga Buyback" table has a "Buyback per 1 Gr" row, and the page says
"Terakhir Diperbarui <day> <Indonesian month> <year>".
goldFromPage() in supabase/functions/_shared/prices.ts reads the same two
things; change both together.

Use as a library:
    from gold_scraper import scrape
    scrape()  # {"buyback": 2240000, "updated": "2026-11-25"}

Use from the command line:
    python scripts/gold_scraper.py
    python scripts/gold_scraper.py --html saved_page.html   # parse a saved file

If the site changes its markup, parsing raises ScrapeError instead of
returning wrong numbers.
"""
import argparse
import datetime
import json
import re
import sys
import time
import urllib.error
import urllib.request

URL = "https://muamalahemas.com/"
USER_AGENT = "Mozilla/5.0 (compatible; FinanceTracker-GoldScraper/1.0)"

MONTHS = ["januari", "februari", "maret", "april", "mei", "juni", "juli",
          "agustus", "september", "oktober", "november", "desember"]


class ScrapeError(RuntimeError):
    pass


def fetch(url=URL, retries=2, timeout=15):
    """Download the page as text. Retries on network errors and 5xx."""
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode(r.headers.get_content_charset() or "utf-8")
        except urllib.error.HTTPError as e:
            last = e
            if e.code < 500:
                break
        except OSError as e:  # URLError, timeouts, dropped connections
            last = e
        if attempt + 1 < retries:
            time.sleep(1.5)
    raise ScrapeError(f"could not fetch {url}: {last}")


def parse_date(html):
    """'Terakhir Diperbarui 25 November 2026' -> '2026-11-25'; '' if absent."""
    m = re.search(r"Terakhir\s+Diperbarui\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})", html, re.I)
    if not m or m.group(2).lower() not in MONTHS:
        return ""
    try:
        return datetime.date(int(m.group(3)), MONTHS.index(m.group(2).lower()) + 1,
                             int(m.group(1))).isoformat()
    except ValueError:
        return ""


def parse(html):
    """Page HTML -> {"buyback": int, "updated": "YYYY-MM-DD" or ""}."""
    m = re.search(r"Buyback\s+per\s+1\s*Gr\s*</td>\s*<td[^>]*>\s*Rp\.?\s*([\d.]+)", html, re.I)
    if not m:
        raise ScrapeError("no 'Buyback per 1 Gr' row: the page layout may have changed")
    return {"buyback": int(m.group(1).replace(".", "")), "updated": parse_date(html)}


def scrape(url=URL, html=None):
    """Fetch (unless html is given) and parse."""
    return parse(html if html is not None else fetch(url))


def main(argv=None):
    ap = argparse.ArgumentParser(description="Scrape the Antam 1 g buyback price from muamalahemas.com")
    ap.add_argument("--html", metavar="FILE", help="parse a saved HTML file instead of fetching")
    args = ap.parse_args(argv)
    try:
        html = open(args.html, encoding="utf-8").read() if args.html else None
        print(json.dumps(scrape(html=html)))
    except (ScrapeError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
