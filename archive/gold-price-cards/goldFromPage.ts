// Archived: replaced by the muamalahemas.com scraper in
// supabase/functions/_shared/prices.ts. Nothing imports this file.
//
// Fallback: the official Antam 1 g card on the public price-cards page.
// Each card is a `price-card-item` block with a brand, a source label ("● antam"),
// a buyback price, a size and an update date. Returns null if the layout changed.

const UA = { "User-Agent": "Mozilla/5.0 (compatible; FinanceTracker/2.0)" };

const inRange = (p: number) => p >= 500_000 && p <= 50_000_000;

export async function goldFromPage(): Promise<{ price: number; date: string } | null> {
  try {
    const res = await fetch("https://emas.maulanar.my.id/price-cards", { headers: UA, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const html = await res.text();
    for (const card of html.split('price-card-item"').slice(1)) {
      if (!/^\s*data-brand="ANTAM"/.test(card)) continue;
      if (!/●\s*antam\s*<\/span>/i.test(card)) continue; // official source, not galeri24 etc.
      const size = card.match(/Ukuran<\/span>\s*<span[^>]*>\s*([\d.,]+)\s*Gram/i);
      if (!size || Number(size[1].replace(",", ".")) !== 1) continue;
      const bb = card.match(/Buyback<\/span>[\s\S]*?price-value[^>]*>\s*Rp\s*([\d.]+)\s*</);
      const price = bb ? Number(bb[1].replace(/\./g, "")) : NaN;
      if (!inRange(price)) continue;
      const day = card.match(/Update Terakhir<\/span>\s*<span[^>]*>\s*(\d{4}-\d{2}-\d{2})/);
      return { price, date: day ? day[1] : "" };
    }
  } catch (_) { /* layout or network problem */ }
  return null;
}
