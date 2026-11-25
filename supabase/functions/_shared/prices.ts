// Shared by the "prices" (app) and "telegram" (bot) functions: live Antam gold
// buyback and IDX stock quotes. Gold is read from the public muamalahemas.com
// page (no key needed); when that fails, it falls back to Emas API ID with the
// EMAS_API_KEY secret.

const UA = { "User-Agent": "Mozilla/5.0 (compatible; FinanceTracker/2.0)" };

const inRange = (p: number) => p >= 500_000 && p <= 50_000_000;

const MONTHS = ["januari", "februari", "maret", "april", "mei", "juni", "juli",
  "agustus", "september", "oktober", "november", "desember"];

// First source: the "Buyback per 1 Gr" row on muamalahemas.com, dated by its
// "Terakhir Diperbarui 25 November 2026" line. Returns null if the layout changed.
// scripts/gold_scraper.py reads the same two things; change both together.
export async function goldFromPage(): Promise<{ price: number; date: string } | null> {
  try {
    const res = await fetch("https://muamalahemas.com/", { headers: UA, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const html = await res.text();
    const bb = html.match(/Buyback\s+per\s+1\s*Gr\s*<\/td>\s*<td[^>]*>\s*Rp\.?\s*([\d.]+)/i);
    const price = bb ? Number(bb[1].replace(/\./g, "")) : NaN;
    if (!inRange(price)) return null;
    const d = html.match(/Terakhir\s+Diperbarui\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
    const month = d ? MONTHS.indexOf(d[2].toLowerCase()) + 1 : 0;
    const date = d && month ? `${d[3]}-${String(month).padStart(2, "0")}-${d[1].padStart(2, "0")}` : "";
    return { price, date };
  } catch (_) { /* layout or network problem */ }
  return null;
}

export async function goldBuyback(): Promise<{ price: number; date: string } | null> {
  return (await goldFromPage()) ?? (await goldFromApi());
}

async function goldFromApi(): Promise<{ price: number; date: string } | null> {
  const key = Deno.env.get("EMAS_API_KEY");
  if (!key) return null;
  try {
    const url = "https://emas.maulanar.my.id/api/prices?brand=ANTAM&resource=antam&weight=1";
    const res = await fetch(url, { headers: { ...UA, "X-API-Key": key }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null; // 429 = usage limit reached, 401/403 = bad key
    const rows = (await res.json()).data ?? [];
    for (const row of rows) {
      if (String(row.brand ?? "").toLowerCase() !== "antam") continue;
      if (Number(row.weight) !== 1) continue;
      const price = Number(row.buyback_price);
      if (inRange(price)) {
        return { price, date: String(row.updated_at ?? row.date ?? "") };
      }
    }
  } catch (_) { /* fall through */ }
  return null;
}

export async function stockPrice(ticker: string): Promise<number | null> {
  const symbol = ticker.includes(".") ? ticker : `${ticker}.JK`;
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
      { headers: UA, signal: AbortSignal.timeout(8000) },
    );
    const price = (await res.json())?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return typeof price === "number" ? price : null;
  } catch (_) {
    return null;
  }
}

// ---- Prices on a past day (used for month-end statements) ----

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Antam buyback for one past day. The page only shows the latest price, so it is
// the right answer for a past day only when it was published on or before that day
// (nothing newer to skip) and no more than a week earlier. Otherwise the Emas API
// is asked, which filters by update date (updated_at[eq]=YYYY-MM-DD); if that day
// has no row (weekend, holiday), the previous days are tried, up to a week back.
export async function goldBuybackOn(date: string): Promise<{ price: number; date: string } | null> {
  const page = await goldFromPage();
  if (page && /^\d{4}-\d{2}-\d{2}$/.test(page.date) && page.date <= date &&
      Date.parse(`${date}T00:00:00Z`) - Date.parse(`${page.date}T00:00:00Z`) < 7 * DAY) {
    return page;
  }
  return await goldOnFromApi(date);
}

async function goldOnFromApi(date: string): Promise<{ price: number; date: string } | null> {
  const key = Deno.env.get("EMAS_API_KEY");
  if (!key) return null;
  const start = Date.parse(`${date}T00:00:00Z`);
  for (let back = 0; back < 7; back++) {
    const day = isoDay(start - back * DAY);
    try {
      const url = "https://emas.maulanar.my.id/api/prices?brand=ANTAM&resource=antam&weight=1" +
        `&updated_at[eq]=${day}&sort_by=updated_at&order=desc&limit=5`;
      const res = await fetch(url, { headers: { ...UA, "X-API-Key": key }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null; // limit reached or bad key: stop, let the caller fall back
      const rows = (await res.json()).data ?? [];
      for (const row of rows) {
        if (String(row.brand ?? "").toLowerCase() !== "antam" || Number(row.weight) !== 1) continue;
        const price = Number(row.buyback_price);
        if (inRange(price)) return { price, date: day };
      }
    } catch (_) { /* try the previous day */ }
  }
  return null;
}

// Closing price of an IDX stock on a past day: the last trading day on or before it.
export async function stockPriceOn(ticker: string, date: string): Promise<{ price: number; date: string } | null> {
  const symbol = ticker.includes(".") ? ticker : `${ticker}.JK`;
  const end = Date.parse(`${date}T00:00:00Z`);
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
        `?interval=1d&period1=${Math.floor((end - 10 * DAY) / 1000)}&period2=${Math.floor((end + 2 * DAY) / 1000)}`,
      { headers: UA, signal: AbortSignal.timeout(8000) },
    );
    const r = (await res.json())?.chart?.result?.[0];
    const times: number[] = r?.timestamp ?? [];
    const closes: (number | null)[] = r?.indicators?.quote?.[0]?.close ?? [];
    let best: { price: number; date: string } | null = null;
    times.forEach((t, i) => {
      const day = isoDay((t + 7 * 3600) * 1000); // Jakarta calendar day
      const c = closes[i];
      if (typeof c === "number" && day <= date) best = { price: c, date: day };
    });
    return best;
  } catch (_) {
    return null;
  }
}
