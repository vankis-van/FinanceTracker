/* FinanceTracker PWA (V2): talks straight to Supabase; row-level security
   decides what each signed-in user can read or write. No secrets live here. */
(() => {
  "use strict";

  // ------------------------------------------------------------ basics
  const cfg = window.FINANCE_CONFIG || {};
  const $ = (sel, root = document) => root.querySelector(sel);
  const app = $("#app");
  // The web font loads after first paint so it never blocks rendering (the page falls back to the system font until it arrives).
  { const f = document.createElement("link"); f.rel = "stylesheet"; f.href = "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap"; document.head.appendChild(f); }
  const sheetRoot = $("#sheet-root");
  const TABS = ["home", "stats", "portfolio", "settings", "activity", "ledger", "plans", "notifications", "loans"];
  let sb = null;
  let charts = [];
  let pricesDown = false;
  let syncing = false;

  const S = {
    session: null, households: [], household: null,
    accounts: [], categories: [], txns: [], holdings: [], sales: [], members: [],
    prices: null, offline: false, period: "month",
    filter: { q: "", type: "", account: "" },
    telegram: null, // this user's Telegram link, if any
    scan: null, // rows read from a photo, reviewed one at a time: { rows, index, saved }
    closings: [], // monthly ledger closings (all versions); see the ledger section
    ledgerReady: false, // false until the ledger migration has been run
    plans: [], ledger: [], // savings goals and their ledger (deposits, withdrawals, assets in and out)
    planHoldings: [], earmarks: {}, // holdings earmarked for plans; cash set aside per account id
    plansReady: false, // false until the plans migration has been run
    plansLedger: false, // false until the plan ledger migration (V2.6) has been run
    notifs: [], prefs: [], // this user's notifications (newest first) and per-kind settings
    loans: [], loansReady: false, // money lent to members; false until the loans migration has been run
    memberEmails: {}, loanFilter: "", // user id -> email (for the borrower picker), borrower filter on the Loans screen
  };

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (n) => Math.round(Number(n) || 0).toLocaleString("id-ID");
  const rp = (n) => (n < 0 ? "−" : "") + "Rp " + num(Math.abs(n));
  const compact = (n) => {
    const a = Math.abs(n), s = n < 0 ? "−" : "";
    const f = (v, unit) => s + v.toLocaleString("id-ID", { maximumFractionDigits: 1 }) + " " + unit;
    if (a >= 1e9) return f(a / 1e9, "M");
    if (a >= 1e6) return f(a / 1e6, "jt");
    if (a >= 1e3) return f(a / 1e3, "rb");
    return s + num(a);
  };
  const qtyFmt = (n) => Number(n).toLocaleString("id-ID", { maximumFractionDigits: 4 });
  const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, device time zone
  const dateLabel = (d) => {
    if (d === today()) return "Hari ini";
    const dt = new Date(d + "T00:00:00");
    return dt.toLocaleDateString("id-ID", { day: "numeric", month: "short", year: dt.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  };
  const initials = (name) => String(name || "?").trim().slice(0, 2).toUpperCase();
  const parseAmount = (v) => Number(String(v).replace(/[^\d]/g, "")) || 0;
  const parseSigned = (v) => (/^\s*[-−]/.test(String(v)) ? -1 : 1) * parseAmount(v);
  const parseQty = (v) => parseFloat(String(v).replace(/\s/g, "").replace(",", ".")) || 0;
  const isNetworkError = (e) => !navigator.onLine || /failed to fetch|networkerror|load failed/i.test(String(e?.message || e));

  const ICON = {
    home: '<path d="M4 11l8-7 8 7v9H4z"/>',
    stats: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    coins: '<circle cx="9" cy="9" r="5"/><path d="M14.5 10.2a5 5 0 11-4.3 4.3"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-5 15-5 16 0"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    swap: '<path d="M7 7h12l-3-3M17 17H5l3 3"/>',
    refresh: '<path d="M20 11a8 8 0 10-2.3 6.3M20 5v6h-6"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    image: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 16l5-5 4 4 3-3 4 4"/><circle cx="15" cy="9" r="1.2"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
    next: '<path d="M9 5l7 7-7 7"/>',
    bell: '<path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 004 0"/>',
    // transaction row badges
    arrowIn: '<path d="M17 7L7 17M7 9v8h8"/>',
    arrowOut: '<path d="M7 17L17 7M9 7h8v8"/>',
    cart: '<path d="M4 5h2l2 10h9l2-7H7"/><circle cx="10" cy="19" r="1.2"/><circle cx="17" cy="19" r="1.2"/>',
    food: '<path d="M7 4v6a2 2 0 002 2v8M11 4v6M7 8h4M17 4c-2 1-3 3-3 6 0 2 1 3 3 3v7"/>',
    fuel: '<path d="M5 20V5a1 1 0 011-1h7a1 1 0 011 1v15M4 20h11M7 8h5M14 9h2.5a1.5 1.5 0 011.5 1.5V16a1.5 1.5 0 003 0V9l-3-3"/>',
    car: '<path d="M5 17v-5l2-5h10l2 5v5M5 17h14M5 17v2M19 17v2"/><circle cx="8.5" cy="13.5" r=".8"/><circle cx="15.5" cy="13.5" r=".8"/>',
    bag: '<path d="M5 8h14l-1 12H6z"/><path d="M9 8V7a3 3 0 016 0v1"/>',
    bolt: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
    heart: '<path d="M12 20s-7-4.5-7-10a4 4 0 017-2.5A4 4 0 0119 10c0 5.5-7 10-7 10z"/>',
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    gift: '<rect x="4" y="9" width="16" height="11" rx="1.5"/><path d="M12 9v11M4 13h16M12 9c-3 0-4-4-1-4 2 0 1 4 1 4zm0 0c3 0 4-4 1-4-2 0-1 4-1 4z"/>',
    wallet: '<path d="M4 7h14a2 2 0 012 2v9a2 2 0 01-2 2H6a2 2 0 01-2-2z"/><path d="M4 7l11-3v3M16 14h2"/>',
    play: '<rect x="4" y="5" width="16" height="14" rx="3"/><path d="M10 9.5v5l4.5-2.5z"/>',
    book: '<path d="M5 5a2 2 0 012-2h12v15H7a2 2 0 00-2 2zM5 19a2 2 0 002 2h12"/>',
    briefcase: '<rect x="4" y="8" width="16" height="11" rx="2"/><path d="M9 8V6a1 1 0 011-1h4a1 1 0 011 1v2M4 13h16"/>',
    gold: '<path d="M3 17l2.5-6h13L21 17z"/><path d="M8 11l1.5-4h5L16 11"/>',
    // plan actions
    pencil: '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>',
    pause: '<path d="M9 5v14M15 5v14"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    resume: '<path d="M8 5l11 7-11 7z"/>',
    trash: '<path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13"/>',
  };
  const icon = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

  let toastTimer;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  // ------------------------------------------------------------ local storage (cache + offline queue)
  const store = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; /* storage full or blocked */ } },
  };
  const queue = () => store.get("ft.queue", []);

  function cacheData() {
    return {
      household: S.household, households: S.households, accounts: S.accounts, categories: S.categories,
      txns: S.txns, holdings: S.holdings, sales: S.sales, members: S.members, prices: S.prices, pricesAt: S.pricesAt,
      closings: S.closings, ledgerReady: S.ledgerReady,
      plans: S.plans, ledger: S.ledger, planHoldings: S.planHoldings, earmarks: S.earmarks,
      plansLedger: S.plansLedger, plansReady: S.plansReady,
      notifs: S.notifs, prefs: S.prefs,
      loans: S.loans, loansReady: S.loansReady, memberEmails: S.memberEmails,
    };
  }
  // Several callers ask to save in a row (a refresh, the bell, prices): turn that into one write
  // a moment later, because stringifying the whole history blocks the screen. localStorage holds
  // about 5 MB; if the history does not fit, keep the last two years of entries (balances come from
  // the account list, so they stay right; only older entries are missing while offline).
  let cacheTimer = 0;
  function writeCache() {
    cacheTimer = 0;
    const data = cacheData();
    if (store.set("ft.cache", data)) return;
    const cut = shiftDay(today(), -730);
    data.txns = data.txns.filter((t) => t.date >= cut);
    data.ledger = (data.ledger || []).filter((c) => c.date >= cut);
    store.set("ft.cache", data);
  }
  function saveCache() {
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(writeCache, 400);
  }
  function flushCache() { if (cacheTimer) { clearTimeout(cacheTimer); writeCache(); } }
  function loadCache() {
    const c = store.get("ft.cache", null);
    if (!c || !c.household) return false;
    Object.assign(S, c);
    return true;
  }

  // ------------------------------------------------------------ data
  const check = (res) => { if (res.error) throw res.error; return res.data; };

  // `build()` must select with { count: "exact" } and end in a total order, so that pages never
  // overlap or skip a row. Page 1 tells how many rows there are; the rest load a few at a time
  // instead of one after another (each page is a round trip, which adds up on a phone).
  async function fetchAll(build) {
    const size = 1000; // PostgREST returns at most 1000 rows per request
    const first = await build().range(0, size - 1);
    const rows = check(first);
    const total = first.count;
    if (rows.length < size) return rows;
    if (typeof total !== "number") { // no count: fall back to one page after another
      let out = rows, from = size;
      for (;;) {
        const more = check(await build().range(from, from + size - 1));
        out = out.concat(more);
        if (more.length < size) return out;
        from += size;
      }
    }
    const starts = [];
    for (let from = size; from < total; from += size) starts.push(from);
    const pages = [rows];
    for (let i = 0; i < starts.length; i += 4) {
      const batch = await Promise.all(starts.slice(i, i + 4).map(async (from) => check(await build().range(from, from + size - 1))));
      pages.push(...batch);
    }
    return pages.flat();
  }

  async function refresh() {
    const hid = S.household.id;
    const uid = S.session.user.id;
    const [acc, opening, cat, tx, hold, sales, mem, tele, led, plans, contribs, notifs, prefs, phold, earm, loanRes, memRes] = await Promise.all([
      sb.from("account_balances").select("*").eq("household_id", hid).order("sort_order").order("name"),
      sb.from("accounts").select("id, opening_balance").eq("household_id", hid),
      sb.from("categories").select("*").eq("household_id", hid).order("name"),
      fetchAll(() => sb.from("transactions").select("*", { count: "exact" }).eq("household_id", hid)
        .order("date", { ascending: false }).order("created_at", { ascending: false }).order("id", { ascending: false })),
      sb.from("holdings").select("*").eq("household_id", hid).order("created_at"),
      sb.from("sales").select("*").eq("household_id", hid).order("date", { ascending: false }),
      sb.from("members").select("user_id, role").eq("household_id", hid),
      sb.from("telegram_links").select("linked_at").eq("user_id", S.session.user.id).maybeSingle(),
      sb.from("ledger_closings").select("id, month, version, status, closing, closed_at")
        .eq("household_id", hid).order("month", { ascending: false }),
      sb.from("plans").select("*").eq("household_id", hid).order("target_date"),
      sb.from("plan_ledger").select("*").eq("household_id", hid)
        .order("date", { ascending: false }).order("created_at", { ascending: false }),
      sb.from("notifications").select("*").eq("user_id", uid).order("created_at", { ascending: false }).limit(60),
      sb.from("notification_prefs").select("kind, enabled").eq("user_id", uid),
      sb.from("plan_holdings").select("*").eq("household_id", hid),
      sb.rpc("account_earmarks", { p_household: hid }),
      sb.from("loans").select("*").eq("household_id", hid).order("date", { ascending: false }),
      sb.rpc("household_members", { p_household: hid }),
    ]);
    if (loanRes.error && isNetworkError(loanRes.error)) throw loanRes.error;
    S.loansReady = !loanRes.error; // the table is missing until the loans migration runs
    S.loans = (loanRes.data || []).map((l) => ({ ...l, amount: Number(l.amount) }));
    S.memberEmails = memRes.error ? S.memberEmails : Object.fromEntries((memRes.data || []).map((m) => [m.user_id, m.email]));
    if (led.error && isNetworkError(led.error)) throw led.error;
    S.notifs = notifs.error ? [] : notifs.data;
    S.prefs = prefs.error ? [] : prefs.data;
    if (plans.error && isNetworkError(plans.error)) throw plans.error;
    // before the V2.6 migration there is no plan_ledger: read the deposit-only table instead
    S.plansLedger = !contribs.error;
    let ledgerRes = contribs;
    if (contribs.error && !isNetworkError(contribs.error)) {
      ledgerRes = await sb.from("plan_contributions").select("*").eq("household_id", hid)
        .order("date", { ascending: false }).order("created_at", { ascending: false });
    }
    S.plansReady = !plans.error && !ledgerRes.error; // the tables are missing until the plans migration runs
    S.plans = (plans.data || []).map((p) => ({ ...p, target_amount: Number(p.target_amount) }));
    S.ledger = (ledgerRes.data || []).map((c) => ({
      entry_type: "deposit", ...c, amount: Number(c.amount),
      quantity: c.quantity == null ? null : Number(c.quantity), unit_price: c.unit_price == null ? null : Number(c.unit_price),
    }));
    S.planHoldings = !S.plansLedger || phold.error ? [] : (phold.data || []).map((h) => ({ ...h, quantity: Number(h.quantity) }));
    S.earmarks = !S.plansLedger || earm.error ? {} : Object.fromEntries((earm.data || []).map((r) => [r.account_id, Number(r.earmarked)]));
    S.ledgerReady = !led.error; // the table is missing until the ledger migration runs
    S.closings = led.data || [];
    const open = Object.fromEntries(check(opening).map((a) => [a.id, Number(a.opening_balance)]));
    S.accounts = check(acc).map((a) => ({ ...a, id: a.account_id, balance: Number(a.balance), opening_balance: open[a.account_id] || 0 }));
    S.categories = check(cat);
    S.txns = tx.map((t) => ({ ...t, amount: Number(t.amount) }));
    S.holdings = check(hold).map((h) => ({ ...h, quantity: Number(h.quantity), buy_price: Number(h.buy_price) }));
    S.sales = check(sales);
    S.members = check(mem);
    S.telegram = tele.error ? null : tele.data;
    S.offline = false;
    saveCache();
  }

  // manual = the Sync prices button: asks again even if an earlier call failed, and reports the result
  async function loadPrices(manual = false) {
    const tickers = [...new Set(S.holdings.filter((h) => h.asset_type === "stock").map((h) => h.ticker))];
    const gold = S.holdings.some((h) => h.asset_type === "gold");
    if (!tickers.length && !gold) { if (manual) toast("No holdings to price yet."); return; }
    if (pricesDown && !manual) return;
    try {
      const { data, error } = await sb.functions.invoke("prices", { body: { tickers, gold } });
      // function not deployed yet: holdings show at cost; stop asking until the next app start
      if (error || !data) {
        pricesDown = true;
        if (manual) toast("Could not reach the price service. Is the prices function deployed?");
        return;
      }
      pricesDown = false;
      S.prices = data;
      S.pricesAt = Date.now();
      saveCache();
      if (["home", "portfolio"].includes(currentTab())) route();
      if (manual) {
        const missing = tickers.filter((t) => !(data.stocks && data.stocks[t]));
        if (gold && !data.gold) toast("Gold price unavailable from both sources. Try again later.");
        else if (missing.length) toast(`Prices updated, but no price for ${missing.join(", ")}.`);
        else toast("Prices updated");
      }
    } catch {
      if (manual) toast("Could not sync prices. Check your connection.");
    }
  }

  async function flushQueue() {
    const pending = queue();
    if (!pending.length || !navigator.onLine) return;
    const left = [];
    let locked = 0;
    for (const row of pending) {
      const { _qid, _category, ...payload } = row;
      if (_category && !payload.category_id) {
        try { payload.category_id = await categoryId(_category); } catch { left.push(row); continue; }
      }
      const { error } = await sb.from("transactions").insert(payload);
      if (error) { left.push(row); if (/closed month/i.test(error.message)) locked += 1; }
    }
    store.set("ft.queue", left);
    if (locked) toast(`${locked} offline entr${locked === 1 ? "y is" : "ies are"} dated in a closed month and can't sync until an owner reopens it.`);
    if (left.length < pending.length) toast(`${pending.length - left.length} offline entr${pending.length - left.length === 1 ? "y" : "ies"} synced`);
  }

  async function reload(message) {
    try {
      await flushQueue();
      await refresh();
      loadPrices();
    } catch (e) {
      if (isNetworkError(e)) S.offline = true; else toast(e.message || "Could not load data");
    }
    route();
    if (message) toast(message);
  }

  const accountName = (id) => S.accounts.find((a) => a.id === id)?.name || "Unassigned";
  const categoryName = (id) => S.categories.find((c) => c.id === id)?.name || "Other";
  const activeAccounts = () => S.accounts.filter((a) => !a.archived);
  const isOwner = () => S.members.some((m) => m.user_id === S.session?.user?.id && m.role === "owner");

  // ------------------------------------------------------------ ledger months
  // Months are "YYYY-MM-01" strings, so they sort and compare as text.
  const monthStart = (d) => d.slice(0, 7) + "-01";
  const fullDate = (ts) => new Date(ts).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
  const monthLabel = (m) => new Date(m + "T00:00:00").toLocaleDateString("id-ID", { month: "long", year: "numeric" });
  const shiftDay = (d, n) => { const x = new Date(d + "T00:00:00"); x.setDate(x.getDate() + n); return x.toLocaleDateString("en-CA"); };
  const addMonths = (m, n) => { const x = new Date(m + "T00:00:00"); x.setMonth(x.getMonth() + n); return x.toLocaleDateString("en-CA"); };
  const closedMonths = () => S.closings.filter((c) => c.status === "closed");
  const latestClosed = () => closedMonths().map((c) => c.month).sort().pop() || "";
  // last day of the latest closed month: entries on or before it are locked
  const lockedThrough = () => (latestClosed() ? shiftDay(addMonths(latestClosed(), 1), -1) : "");
  const isLocked = (date) => !!lockedThrough() && date <= lockedThrough();
  const minDate = () => (lockedThrough() ? shiftDay(lockedThrough(), 1) : "");

  // The month an owner should close next, or null when none has ended yet.
  // The first close may be any finished month; after that they go in order.
  function nextToClose() {
    const thisMonth = monthStart(today());
    if (latestClosed()) {
      const next = addMonths(latestClosed(), 1);
      return next < thisMonth ? next : null;
    }
    const last = addMonths(thisMonth, -1);
    return S.txns.some((t) => t.date < thisMonth) ? last : null;
  }

  async function categoryId(name) {
    const hit = S.categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit.id;
    const row = check(await sb.from("categories").insert({ household_id: S.household.id, name }).select().single());
    S.categories.push(row);
    return row.id;
  }

  // ------------------------------------------------------------ derived numbers
  const signed = (t) => (t.type === "income" || t.type === "transfer-in" || t.type === "loan-in" ? t.amount : -t.amount);

  // ------------------------------------------------------------ loans (money lent from an account to a member)
  // Money lent is a `loan-out` entry on the account it came from; each repayment is a `loan-in` entry (never income or expense).
  // The database keeps the status; the rules here mirror the loan functions in the loans migration.
  const memberName = (uid) => {
    const e = S.memberEmails[uid];
    return e ? e.split("@")[0] : uid ? "A member" : "A former member";
  };
  let repaidSrc = null, repaidLen = -1, repaidBy = new Map();
  const loanRepaid = (l) => {
    if (repaidSrc !== S.txns || repaidLen !== S.txns.length) { // S.txns is replaced, never edited in place
      repaidSrc = S.txns; repaidLen = S.txns.length; repaidBy = new Map();
      for (const t of S.txns) if (t.type === "loan-in" && t.loan_id) repaidBy.set(t.loan_id, (repaidBy.get(t.loan_id) || 0) + t.amount);
    }
    return repaidBy.get(l.id) || 0;
  };
  const loanStats = (l) => {
    const repaid = loanRepaid(l), outstanding = Math.max(l.amount - repaid, 0);
    const overdue = outstanding > 0 && !!l.due_date && l.due_date < today();
    return { repaid, outstanding, progress: l.amount ? Math.min(repaid / l.amount, 1) : 0, overdue, paid: outstanding === 0 };
  };
  const openLoans = () => S.loans.filter((l) => !loanStats(l).paid);
  const totalOwed = () => openLoans().reduce((s, l) => s + loanStats(l).outstanding, 0);
  const loanPayments = (l) => S.txns.filter((t) => t.loan_id === l.id && t.type === "loan-in");

  function periodRange(p) {
    const now = new Date(), y = now.getFullYear(), m = now.getMonth();
    const iso = (d) => d.toLocaleDateString("en-CA");
    if (p === "month") return [iso(new Date(y, m, 1)), iso(new Date(y, m + 1, 0))];
    if (p === "last") return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))];
    if (p === "year") return [`${y}-01-01`, `${y}-12-31`];
    return ["0000-01-01", "9999-12-31"];
  }

  function summary(p) {
    const [from, to] = periodRange(p);
    const rows = S.txns.filter((t) => t.date >= from && t.date <= to);
    const sum = (type) => rows.filter((t) => t.type === type).reduce((s, t) => s + t.amount, 0);
    const income = sum("income"), expense = sum("expense"), invest = sum("invest");
    const byCat = {};
    rows.filter((t) => t.type === "expense").forEach((t) => {
      const k = categoryName(t.category_id);
      byCat[k] = (byCat[k] || 0) + t.amount;
    });
    const net = income - expense - invest;
    return {
      income, expense, invest, net,
      savingsRate: income > 0 ? Math.round((net / income) * 100) : 0,
      byCat: Object.entries(byCat).sort((a, b) => b[1] - a[1]),
    };
  }

  function positions() {
    const map = new Map();
    for (const h of S.holdings) {
      const key = `${h.asset_type}|${h.ticker}|${h.name.toLowerCase()}`;
      const p = map.get(key) || { asset_type: h.asset_type, ticker: h.ticker, name: h.name, qty: 0, cost: 0, ids: [] };
      p.ids.push(h.id);
      p.lots = p.ids.length;
      p.qty += h.quantity;
      p.cost += h.quantity * h.buy_price;
      map.set(key, p);
    }
    return [...map.values()].map((p) => {
      const price = p.asset_type === "gold" ? S.prices?.gold?.price : S.prices?.stocks?.[p.ticker];
      const value = price ? p.qty * price : null;
      return { ...p, avg: p.cost / p.qty, price: price || null, value, pl: value === null ? null : value - p.cost };
    });
  }

  // ------------------------------------------------------------ plans (savings goals)
  // Same rules as private.check_plan in the plans migration (FR-PLN-04/05).
  const daysBetween = (a, b) => Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 864e5);
  const PLAN_STATUS = {
    achieved: ["Achieved", "ok"], ontrack: ["On track", ""], behind: ["Behind", "due"],
    overdue: ["Overdue", "due"], paused: ["Paused", ""], cancelled: ["Cancelled", ""],
  };

  // The plan ledger: cash entries move cash, asset rows record gold or stock assigned or released.
  const isCashEntry = (l) => l.entry_type === "deposit" || l.entry_type === "withdrawal" || l.entry_type === "adjustment" || l.entry_type === "spend";
  // value that entered (+) or left (-) the plan; a payment made from the plan (spend) still counts as progress
  const flowOf = (l) => (l.entry_type === "asset_out" ? -l.amount : l.entry_type === "spend" ? 0 : l.amount);
  // the V2.13 migration adds plans.progress_at_close and the spend functions
  const spendReady = () => (S.plans.length ? "progress_at_close" in S.plans[0] : true);
  const ledgerTable = () => (S.plansLedger ? "plan_ledger" : "plan_contributions");
  const livePrice = (type, ticker) => (type === "gold" ? S.prices?.gold?.price : S.prices?.stocks?.[ticker]) || null;
  const earmarkOf = (accountId) => S.earmarks[accountId] || 0;
  // quantity of a lot not yet earmarked for any plan
  const lotFree = (lot) => lot.quantity - S.planHoldings.filter((h) => h.holding_id === lot.id).reduce((s, h) => s + h.quantity, 0);
  const qtyLabel = (type, q) => `${q.toLocaleString("id-ID", { maximumFractionDigits: 4 })} ${type === "gold" ? "g" : "sh"}`;

  // Saved = cash in the plan + its gold and stocks, valued live when prices are
  // connected and at cost otherwise (the database itself only knows cost).
  function planStats(p) {
    const t = today();
    const entries = S.ledger.filter((c) => c.plan_id === p.id);
    const cash = entries.filter(isCashEntry).reduce((s, c) => s + c.amount, 0);
    const spent = entries.filter((c) => c.entry_type === "spend").reduce((s, c) => s - c.amount, 0); // paid out of the plan, still progress
    const assets = S.planHoldings.filter((h) => h.plan_id === p.id).map((h) => {
      const lot = S.holdings.find((x) => x.id === h.holding_id);
      if (!lot) return null;
      const price = livePrice(lot.asset_type, lot.ticker), cost = h.quantity * lot.buy_price;
      return { id: lot.id, lot, qty: h.quantity, cost, price, value: price ? h.quantity * price : null };
    }).filter(Boolean);
    const assetCost = assets.reduce((s, a) => s + a.cost, 0);
    const assetValue = assets.reduce((s, a) => s + (a.value ?? a.cost), 0);
    const saved = cash + assetValue + spent;
    const target = p.target_amount;
    const remaining = Math.max(target - saved, 0);
    // whole months from today to the target date, rounded up, at least 1
    const [y, m, d] = t.split("-").map(Number), [ty, tm, td] = p.target_date.split("-").map(Number);
    const monthsLeft = Math.max(1, (ty - y) * 12 + (tm - m) + (td > d ? 1 : 0));
    const total = Math.max(daysBetween(p.start_date, p.target_date), 1);
    const elapsed = Math.min(Math.max(daysBetween(p.start_date, t), 0), total);
    const expected = (target * elapsed) / total;
    let status = p.status === "active" ? "ontrack" : p.status;
    if (p.status === "active") {
      if (saved >= target) status = "achieved";
      else if (p.target_date < t) status = "overdue";
      else if (saved < expected - target * 0.05) status = "behind";
    }
    return {
      entries, cash, spent, closedAt: p.progress_at_close ?? null, assets, assetCost, assetValue, live: assets.every((a) => a.value !== null),
      saved, target, remaining, monthsLeft, expected, status,
      progress: Math.min(saved / target, 1), monthly: remaining / monthsLeft,
      daysLeft: daysBetween(t, p.target_date),
    };
  }

  const runningPlans = () => S.plans.filter((p) => p.status === "active" || p.status === "paused");
  const planTag = (st) => `<span class="tag ${PLAN_STATUS[st.status][1]}">${PLAN_STATUS[st.status][0]}${st.status === "cancelled" && st.closedAt != null ? ` at ${Number(st.closedAt).toLocaleString("id-ID")}%` : ""}</span>`;
  const planBar = (st) => `<span class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(st.progress * 100)}"><i style="width:${(st.progress * 100).toFixed(1)}%"></i></span>`;

  // ------------------------------------------------------------ notifications
  // Rows are created only by the database (plans migration). The app runs the
  // daily checks when it opens, listens for new rows, and marks them read.
  const NOTIF_GROUPS = [ // the switches in Settings (FR-NTF-05); each covers one or more kinds
    { id: "milestones", label: "Plan milestones", hint: "25%, 50%, 75% and reaching the target", kinds: ["plan_milestone", "plan_achieved"] },
    { id: "behind", label: "Plan falling behind", hint: "When a plan drops below its plan line", kinds: ["plan_behind"] },
    { id: "deadlines", label: "Plan deadlines", hint: "30 and 7 days before the target date, and overdue", kinds: ["plan_deadline", "plan_overdue"] },
    { id: "monthly", label: "Monthly plan reminder", hint: "From the 25th, when this month's share is not in yet", kinds: ["plan_monthly"] },
    { id: "loans", label: "Loan due dates", hint: "7 days before a loan is due, and when it is overdue", kinds: ["loan_due", "loan_overdue"] },
    { id: "close", label: "Month-close reminder", hint: "Last day of the month, then days 1, 3 and 7", kinds: ["month_close"], owner: true },
  ];
  const unreadCount = () => S.notifs.filter((n) => !n.read_at).length;
  const prefOn = (kind) => {
    const row = S.prefs.find((p) => p.kind === kind);
    return row ? row.enabled : isOwner(); // no row: owners get everything, other members nothing
  };

  function paintBell() {
    const b = $("#bell-count"), n = unreadCount();
    if (!b) return;
    b.textContent = n > 99 ? "99+" : String(n);
    b.hidden = !n;
    b.closest("button")?.setAttribute("aria-label", n ? `Notifications, ${n} unread` : "Notifications");
  }

  const timeAgo = (ts) => {
    const s = (Date.now() - new Date(ts)) / 1000;
    if (s < 60) return "baru saja";
    if (s < 3600) return `${Math.floor(s / 60)} mnt`;
    if (s < 86400) return `${Math.floor(s / 3600)} jam`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)} hr`;
    return fullDate(ts);
  };

  // Daily checks for this household (the same ones pg_cron runs twice a day).
  // On open, and again when the app comes back after 30 minutes or more.
  let checkedAt = 0;
  async function runChecks() {
    if (!S.plansReady || !navigator.onLine || Date.now() - checkedAt < 30 * 60e3) return;
    checkedAt = Date.now();
    const { error } = await sb.rpc("check_notifications", { p_household: S.household.id });
    if (error) return;
    const { data } = await sb.from("notifications").select("*").eq("user_id", S.session.user.id)
      .order("created_at", { ascending: false }).limit(60);
    if (data) { S.notifs = data; saveCache(); paintBell(); }
  }

  // New rows arrive over Realtime while the app is open (when the table is in
  // the supabase_realtime publication); otherwise they show on the next refresh.
  let notifChannel = null;
  function listenNotifs() {
    if (notifChannel || !S.plansReady) return;
    const uid = S.session.user.id;
    notifChannel = sb.channel(`notifs-${uid}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${uid}` }, ({ new: n }) => {
        if (S.notifs.some((x) => x.id === n.id)) return;
        S.notifs.unshift(n);
        saveCache();
        paintBell();
        toast(n.title);
      })
      .subscribe();
  }

  // ------------------------------------------------------------ motion
  // View Transitions: a tapped card grows into the sheet it opens and closing sends it back;
  // tabs slide the way you move. Without the API (or with reduced motion) screens just swap.
  const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const motionOK = () => !!document.startViewTransition && !reducedMotion();
  let vtRunning = false;
  let hero = null; // { act, id } of the element the open sheet grew from

  function transition(update, kind = "", after = () => {}) {
    if (!motionOK() || vtRunning) { update(); after(); return; }
    vtRunning = true;
    const root = document.documentElement;
    root.dataset.vt = kind;
    const t = document.startViewTransition(update);
    t.ready.catch(() => {}); // skipped transitions reject; the update still ran
    t.updateCallbackDone.catch((e) => console.error(e));
    t.finished.catch(() => {}).finally(() => { vtRunning = false; delete root.dataset.vt; after(); });
  }

  // Open a sheet so that it grows out of `el` (a row or card).
  function openFrom(el, open) {
    if (!motionOK() || vtRunning || !el) { hero = null; return open(); }
    hero = { act: el.dataset.act, id: el.dataset.id };
    const src = el.closest(".wcard") || el;
    src.style.viewTransitionName = "hero";
    transition(() => {
      src.style.viewTransitionName = "";
      open();
      const m = $(".modal", sheetRoot);
      if (m) { m.style.viewTransitionName = "hero"; m.classList.add("grown"); }
    }, "hero");
  }

  function countUp(el, from, to) {
    if (!el || from === to || reducedMotion()) return;
    const t0 = performance.now(), dur = 750;
    const step = (now) => {
      if (!el.isConnected) return;
      const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = num(from + (to - from) * e);
      if (p < 1) requestAnimationFrame(step);
    };
    el.textContent = num(from);
    requestAnimationFrame(step);
  }
  let shownTotal = 0;

  // ------------------------------------------------------------ shell + routing
  const currentTab = () => {
    const t = location.hash.slice(1);
    return TABS.includes(t) ? t : "home";
  };

  function nav(tab) {
    const item = (id, ic, label) =>
      `<button class="${tab === id ? "on" : ""}" data-go="${id}" aria-label="${label}">${tab === id ? `<span class="nav-ind" aria-hidden="true"></span>` : ""}${icon(ic)}</button>`;
    return `<nav class="nav">
      ${item("home", "home", "Home")}${item("stats", "stats", "Overview")}
      <button class="add" data-act="scan" aria-label="Scan a receipt">${icon("camera")}</button>
      ${item("portfolio", "coins", "Portfolio")}${item("settings", "user", "Settings")}
    </nav>`;
  }

  // ------------------------------------------------------------ loading skeletons
  // Shown while the first data loads: grey shapes laid out like the real screen, so the page does
  // not jump when the data arrives. pwa/index.html holds a static copy of the Home skeleton (made
  // from this code) for the moment before this script has run; keep the two in step.
  // skeleton:begin
  const sk = (w, h, r = 8) =>
    `<i class="sk" style="${w === "flex" ? "flex:1" : `width:${typeof w === "number" ? `${w}px` : w}`};height:${h}px;border-radius:${typeof r === "number" ? `${r}px` : r}"></i>`;
  const skLines = (a = "60%", b = "40%") => `<div class="grow" style="display:grid;gap:7px">${sk(a, 13)}${sk(b, 10)}</div>`;
  const skTx = () => `<div class="tx sk-tx">${sk(38, 38, 11)}${skLines("65%", "45%")}${sk(56, 14)}</div>`;
  const skCard = (rows = 2) => `<div class="card"><div class="row between">${sk(72, 14)}${sk(58, 24, "12px")}</div>${
    Array.from({ length: rows }, () => `<div class="row">${sk(36, 36, "12px")}${skLines()}${sk(58, 20, "999px")}</div>`).join("")}</div>`;
  const skStats = () => `<div class="stats">${Array.from({ length: 3 }, () => `<div class="stat">${sk(54, 10)}<div style="height:7px"></div>${sk(46, 15)}</div>`).join("")}</div>`;
  const skList = (title, n = 5) => `<div class="sheet sk-sheet"><div class="row between">${sk(title, 18)}${sk(64, 26, "13px")}</div>${Array.from({ length: n }, skTx).join("")}</div>`;
  function skeleton(tab) {
    if (tab === "stats") {
      return `<div class="top skel" data-sk="stats" aria-hidden="true">${sk(110, 22)}${sk("100%", 44, "999px")}${skStats()}
        <div class="card">${sk(150, 14)}${sk("100%", 170, "14px")}</div></div>${skList(150, 4)}`;
    }
    if (tab === "portfolio") {
      return `<div class="top skel" data-sk="portfolio" aria-hidden="true">${sk(100, 22)}<div style="display:grid;gap:8px">${sk(90, 12)}${sk(200, 32)}</div>${skStats()}
        <div class="row">${sk("flex", 44, "999px")}${sk("flex", 44, "999px")}</div></div>${skList(100, 3)}`;
    }
    if (tab === "settings") {
      return `<div class="top skel" data-sk="settings" aria-hidden="true">${sk(90, 22)}
        <div class="card"><div class="row">${sk(40, 40, "50%")}${skLines("70%", "45%")}</div><div class="row">${sk("flex", 40, "999px")}${sk("flex", 40, "999px")}</div></div></div>${skList(100, 3)}`;
    }
    if (tab === "home") {
      return `<div class="top skel" data-sk="home" aria-hidden="true">
        <div class="row between"><div class="row">${sk(40, 40, "50%")}<div style="display:grid;gap:7px">${sk(70, 10)}${sk(110, 14)}</div></div>
          <div class="row" style="gap:8px">${sk(40, 40, "50%")}${sk(40, 40, "50%")}</div></div>
        <div style="display:grid;gap:8px">${sk(90, 12)}${sk(210, 32)}</div>
        <div class="row">${sk("flex", 44, "999px")}${sk("flex", 44, "999px")}</div>
        <div class="card"><div class="row between">${sk(80, 14)}${sk(58, 24, "12px")}</div>${sk("100%", 54, "18px")}${sk("100%", 54, "18px")}${sk("100%", 54, "18px")}</div>
        ${skStats()}${skCard(2)}</div>${skList(150, 4)}`;
    }
    return `<div class="top skel" data-sk="${tab}" aria-hidden="true">${sk(120, 22)}</div>${skList(130, 5)}`;
  }
  // skeleton:end

  function paintSkeleton() {
    const tab = currentTab();
    app.innerHTML = `<span class="sr-only" role="status">Loading…</span>${skeleton(tab)}${nav(tab).replace('<nav class="nav">', '<nav class="nav" inert aria-hidden="true">')}`;
  }

  let paintedView = null, enterTimer;
  function paint(tab, html) {
    charts.forEach((c) => c.destroy());
    charts = [];
    const banner = S.offline ? `<div class="banner">Offline. Showing the last saved data.</div>` : "";
    app.innerHTML = banner + html + nav(tab);
    // a newly shown screen lets its rows rise in one after another; a data refresh does not
    if (currentTab() !== paintedView) {
      paintedView = currentTab();
      app.classList.add("enter");
      clearTimeout(enterTimer);
      enterTimer = setTimeout(() => app.classList.remove("enter"), 1000);
    }
  }

  function route() {
    if (!S.session) return viewLogin();
    if (!S.household) return viewOnboard();
    const tab = currentTab();
    ({ home: viewHome, stats: viewStats, portfolio: viewPortfolio, settings: viewSettings, activity: viewActivity, ledger: viewLedger, plans: viewPlans, notifications: viewNotifSettings, loans: viewLoans })[tab]();
  }

  // ------------------------------------------------------------ views: auth + onboarding
  function viewLogin(note = "") {
    app.innerHTML = `<div class="auth login">
      <div class="login-art" aria-hidden="true"><i></i><i></i></div>
      <div class="login-copy"><h1>Welcome</h1><p>Your household's money, in one place.</p></div>
      <form data-form="login">
        <label class="f">Email<input id="login-email" name="email" type="email" autocomplete="email" required placeholder="you@example.com"></label>
        <label class="f">Password<input id="login-password" name="password" type="password" autocomplete="current-password" placeholder="Your password"></label>
        <div class="error" id="login-error">${esc(note)}</div>
        <button class="pill" type="submit">Sign in</button>
        <a class="pill soft" href="https://github.com/ivankalka11/FinanceTracker#readme" target="_blank" rel="noopener noreferrer" style="text-decoration:none">Github Docs</a>
        <p class="hint">Accounts are by invitation only.</p>
      </form>
    </div>`;
  }

  function viewOnboard() {
    app.innerHTML = `<div class="auth">
      <div class="hero"><h1>Set up your household</h1><p>Name it and add the accounts you want to track. You can change these later.</p></div>
      <div class="sheet">
        <form data-form="onboard">
          <label class="f">Household name<input id="ob-name" name="name" required placeholder="Keluarga"></label>
          <label class="f">Accounts, one per line
            <textarea id="ob-accounts" name="accounts" rows="4" required placeholder="Tabungan&#10;Bersama" style="border:1px solid var(--rule);border-radius:13px;padding:12px;font:inherit;font-size:16px;color:var(--ink)"></textarea></label>
          <div class="error" id="onboard-error"></div>
          <button class="pill" type="submit">Create household</button>
          <button class="link" type="button" data-act="signout">Sign out</button>
        </form>
      </div>
    </div>`;
  }

  // ------------------------------------------------------------ views: main tabs
  // Badge for a transaction row: an icon by type, then by category / description keywords.
  // The tint shows direction: green = money in, pink = transfer or loan, neutral = spending.
  const KEYWORD_ICONS = [
    [/bensin|bbm|fuel|pertalite|pertamax|solar|spbu/i, "fuel"],
    [/transport|ojek|grab|gojek|taksi|taxi|kereta|bus\b|tol\b|parkir|mobil|motor/i, "car"],
    [/makan|food|resto|kafe|cafe|kopi|coffee|minum|jajan|bakso|nasi|warung|snack/i, "food"],
    [/belanja|shop|market|mart\b|toko|tokopedia|shopee|lazada|baju|pakaian|grocer/i, "cart"],
    [/listrik|pln|pdam|air\b|internet|wifi|tagihan|bill|pulsa|token|cicilan|sewa|kost|rent|utilit/i, "bolt"],
    [/sehat|health|dokter|obat|apotek|klinik|rumah sakit/i, "heart"],
    [/hiburan|netflix|spotify|game|film|bioskop|liburan|wisata|entertain/i, "play"],
    [/sekolah|kuliah|pendidikan|kursus|buku\b|edu/i, "book"],
    [/hadiah|gift|donasi|zakat|sedekah|amal|charity/i, "gift"],
    [/gaji|salary|payslip|bonus|thr\b/i, "briefcase"],
  ];
  function txBadge(t, cat) {
    if (t.type === "transfer-in" || t.type === "loan-in") return { name: "arrowIn", tone: "xfer" };
    if (t.type === "transfer-out" || t.type === "loan-out") return { name: "arrowOut", tone: "xfer" };
    const text = `${cat} ${t.description || ""}`;
    const hit = KEYWORD_ICONS.find(([re]) => re.test(text));
    if (t.type === "income") return { name: hit ? hit[1] : "wallet", tone: "in" };
    return { name: hit ? hit[1] : "receipt", tone: "out" };
  }

  function txRow(t, i = 0) {
    const sign = signed(t);
    const cat = t.type.startsWith("transfer") ? "Transfer" : t.type === "loan-in" ? "Loan repayment" : t.type === "loan-out" ? "Loan given" : categoryName(t.category_id);
    const title = t.description || cat;
    const badge = txBadge(t, cat);
    return `<button class="tx ${t._qid ? "pending" : ""}" style="--i:${Math.min(i, 12)}" ${t._qid ? "" : `data-act="tx" data-id="${t.id}"`}>
      <span class="logo ${badge.tone}" aria-hidden="true">${icon(badge.name)}</span>
      <span class="body"><b>${esc(title)}</b>
        <small class="meta"><span class="when">${esc(dateLabel(t.date))}</span><span class="cat">${esc(cat)}</span><span class="acct">${esc(accountName(t.account_id))}</span>${t._qid ? `<span class="cat wait">Waiting to sync</span>` : ""}</small></span>
      <em class="num ${sign < 0 ? "neg" : "pos"}">${sign < 0 ? "−" : "+"}${num(t.amount)}</em>
    </button>`;
  }

  // Row for the plan and loan sheets (ledger entries, held assets, repayments): a badge,
  // a title with a meta line, the amount on the right and an optional small action.
  //   meta: [{ cls: "when" | "cat" | "acct", html }]   (html must already be escaped)
  //   dir: 1 money in (green), -1 money out (red), 0 neutral
  function entRow({ badge, tone, title, meta = [], amount = "", dir = 0, action = "" }) {
    const sub = meta.length ? `<small class="meta">${meta.map((m) => `<span class="${m.cls}">${m.html}</span>`).join("")}</small>` : "";
    return `<div class="tx ent">
      <span class="logo ${tone}" aria-hidden="true">${icon(badge)}</span>
      <span class="body"><b>${title}</b>${sub}</span>
      <span class="side">${amount ? `<em class="num ${dir < 0 ? "neg" : dir > 0 ? "pos" : ""}">${amount}</em>` : ""}${action}</span>
    </div>`;
  }

  const allRows = () => queue().concat(S.txns);

  // Wallet-style stack: each card shows its header strip; the open card shows in full.
  // Used on Home (active accounts) and in Settings (all accounts, archived ones tagged).
  function accountStack(list) {
    const openId = list.some((a) => a.id === S.openAccount) ? S.openAccount : list[list.length - 1]?.id;
    const [mFrom, mTo] = periodRange("month");
    const flows = new Map(); // account id -> { in, out } for this month, from one pass over the entries
    for (const t of S.txns) {
      if (t.date < mFrom || t.date > mTo) continue;
      const f = flows.get(t.account_id) || { in: 0, out: 0 };
      if (signed(t) > 0) f.in += t.amount; else f.out += t.amount;
      flows.set(t.account_id, f);
    }
    const flow = (id, sign) => (flows.get(id) || { in: 0, out: 0 })[sign > 0 ? "in" : "out"];
    return list.map((a, i) => `
      <div class="wcard c${i % 5} ${a.id === openId ? "open" : ""} ${a.archived ? "archived" : ""}">
        <button class="wc-head" data-act="card" data-id="${a.id}" aria-label="Show ${esc(a.name)}">
          <span class="wc-name"><i>${esc(initials(a.name))}</i>${esc(a.name)}${a.archived ? `<em>Archived</em>` : ""}</span>
          <b class="num">${a.balance < 0 ? "−" : ""}<small>Rp</small>${num(Math.abs(a.balance))}</b>
        </button>
        <div class="wc-body">
          <span>In this month<b class="num">${compact(flow(a.id, 1))}</b></span>
          <span>Out this month<b class="num">${compact(flow(a.id, -1))}</b></span>
          ${earmarkOf(a.id) > 0 ? `<span>Set aside<b class="num">${compact(earmarkOf(a.id))}</b></span>
          <span class="free">Free to spend<b class="num">${compact(a.balance - earmarkOf(a.id))}</b></span>` : ""}
          <button class="wc-edit" data-act="account" data-id="${a.id}" aria-label="Edit ${esc(a.name)}">${icon("pencil")}</button>
        </div>
      </div>`).join("");
  }

  function viewHome() {
    const total = S.accounts.reduce((s, a) => s + a.balance, 0);
    const m = summary("month");
    const email = S.session.user.email || "";
    const accts = accountStack(activeAccounts());
    const due = S.ledgerReady && isOwner() ? nextToClose() : null;
    const recent = allRows().slice(0, 6).map(txRow).join("") ||
      `<div class="empty">No transactions yet. Tap + to add your first one.</div>`;
    paint("home", `
      <div class="top">
        <div class="row between">
          <div class="row"><div class="avatar">${esc(initials(email))}</div>
            <div><div class="muted" style="font-size:12px">${esc(S.household.name)}</div><b>${esc(email.split("@")[0])}</b></div></div>
          <div class="row" style="gap:8px">
            ${S.plansReady ? `<button class="icon-btn bell" data-act="notifs" aria-label="Notifications">${icon("bell")}<span class="badge" id="bell-count" hidden></span></button>` : ""}
            <button class="icon-btn" data-act="reload" aria-label="Refresh">${icon("refresh")}</button>
          </div>
        </div>
        <div><div class="balance-label">Total balance</div>
          <div class="balance num"><small>Rp</small><span id="total">${num(total)}</span></div></div>
        <div class="row">
          <button class="pill" data-act="add">${icon("plus")} Add</button>
          <button class="pill ghost" data-act="transfer">${icon("swap")} Transfer</button>
        </div>
        <div class="card">
          <div class="row between"><h3>Accounts</h3><button class="link" data-go="settings">Manage</button></div>
          <div class="stack">${accts}</div>
          <button class="wc-new" data-act="account">+ New account</button>
        </div>
        <div class="stats">
          <div class="stat"><span>Income (month)</span><b class="num up">${compact(m.income)}</b></div>
          <div class="stat"><span>Expense</span><b class="num down">${compact(m.expense)}</b></div>
          <div class="stat"><span>Invested</span><b class="num">${compact(m.invest)}</b></div>
        </div>
        ${due ? `<button class="card due-card" data-act="statement" data-id="${due}">
          <span class="grow"><b>Close ${esc(monthLabel(due))}</b><small>Check the figures and bank balances, then lock the month.</small></span>${icon("lock")}</button>` : ""}
        ${homePlans()}
        ${homeLoans()}
      </div>
      <div class="sheet">
        <div class="row between"><h2>Recent transactions</h2><button class="link" data-go="activity">View all</button></div>
        ${recent}
      </div>`);
    countUp($("#total"), shownTotal, total);
    shownTotal = total;
    paintBell();
  }

  // Home: the three active plans with the nearest target date (FR-PLN-08).
  function homePlans() {
    if (!S.plansReady) return "";
    const top = S.plans.filter((p) => p.status === "active").sort((a, b) => a.target_date.localeCompare(b.target_date)).slice(0, 3);
    const rows = top.map((p) => {
      const st = planStats(p);
      return `<button class="mini-plan" data-act="plan" data-id="${p.id}">
        <span class="mp-icon" aria-hidden="true">${esc(p.icon)}</span>
        <span class="grow"><b>${esc(p.name)}</b><small>${Math.round(st.progress * 100)}% · ${compact(st.saved)} of ${compact(st.target)}</small>${planBar(st)}</span>
        ${planTag(st)}</button>`;
    }).join("");
    return `<div class="card">
      <div class="row between"><h3>Plans</h3>${S.plans.length ? `<button class="link" data-go="plans">See all</button>` : ""}</div>
      ${rows || `<button class="wc-new" data-act="plan-new">+ Start a plan</button>`}
    </div>`;
  }

  // Home: what the household still owes (FR-LON-10).
  function homeLoans() {
    if (!S.loansReady) return "";
    const open = openLoans();
    return `<div class="card">
      <div class="row between"><h3>Loans</h3><button class="link" data-go="loans">${S.loans.length ? "See all" : "Open"}</button></div>
      ${open.length
        ? `<button class="mini-plan" data-go="loans"><span class="grow"><b class="num">${rp(totalOwed())}</b>
            <small>still owed on ${open.length} loan${open.length === 1 ? "" : "s"}${open.some((l) => loanStats(l).overdue) ? " · some overdue" : ""}</small></span></button>`
        : `<button class="wc-new" data-act="loan-new">+ Record a loan</button>`}
    </div>`;
  }

  function viewActivity() {
    const f = S.filter;
    paint("home", `
      <div class="top">
        <div class="row between">
          <button class="icon-btn" data-go="home" aria-label="Back">${icon("back")}</button>
          <h1 class="title">Transactions</h1><span style="width:40px"></span>
        </div>
      </div>
      <div class="sheet">
        <div class="filters">
          <input id="f-q" type="search" placeholder="Search" value="${esc(f.q)}" data-filter="q">
          <select id="f-type" data-filter="type">
            ${[["", "All types"], ["income", "Income"], ["expense", "Expense"], ["invest", "Invest"], ["transfer", "Transfers"], ...(S.loansReady ? [["loan", "Loans"]] : [])]
              .map(([v, l]) => `<option value="${v}" ${f.type === v ? "selected" : ""}>${l}</option>`).join("")}
          </select>
          <select id="f-account" data-filter="account">
            <option value="">All accounts</option>
            ${S.accounts.map((a) => `<option value="${a.id}" ${f.account === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}
          </select>
        </div>
        <div id="tx-list"></div>
      </div>`);
    renderTxList();
  }

  function renderTxList() {
    const f = S.filter, q = f.q.trim().toLowerCase();
    const rows = allRows().filter((t) =>
      (!f.type || (f.type === "transfer" || f.type === "loan" ? t.type.startsWith(f.type) : t.type === f.type)) &&
      (!f.account || t.account_id === f.account) &&
      (!q || `${t.description} ${categoryName(t.category_id)} ${accountName(t.account_id)}`.toLowerCase().includes(q)));
    const shown = rows.slice(0, 300);
    $("#tx-list").innerHTML = `<p class="muted" style="margin:4px 0 10px;font-size:12.5px">${rows.length} transaction${rows.length === 1 ? "" : "s"}${rows.length > shown.length ? `, showing the latest ${shown.length}` : ""}</p>
      <div style="display:flex;flex-direction:column;gap:8px">${shown.map(txRow).join("") || `<div class="empty">Nothing matches.</div>`}</div>`;
  }

  function viewStats() {
    const s = summary(S.period);
    const periods = [["month", "This month"], ["last", "Last month"], ["year", "This year"], ["all", "All"]];
    const cats = s.byCat.map(([name, amount]) =>
      `<div class="list-row"><span class="grow">${esc(name)}</span><b class="num">${rp(amount)}</b></div>`).join("") ||
      `<div class="empty">No expenses in this period.</div>`;
    paint("stats", `
      <div class="top">
        <h1 class="title">Overview</h1>
        <div class="seg">${periods.map(([v, l]) => `<button class="${S.period === v ? "on" : ""}" data-act="period" data-id="${v}">${l}</button>`).join("")}</div>
        <div class="stats">
          <div class="stat"><span>Income</span><b class="num up">${compact(s.income)}</b></div>
          <div class="stat"><span>Expense</span><b class="num down">${compact(s.expense)}</b></div>
          <div class="stat"><span>Net</span><b class="num ${s.net < 0 ? "down" : ""}">${compact(s.net)}</b></div>
        </div>
        <div class="card">
          <div class="row between"><h3>Income and expense, last 6 months</h3></div>
          <div class="chart-box"><canvas id="bars" aria-label="Income and expense by month"></canvas></div>
        </div>
      </div>
      <div class="sheet">
        <div class="row between"><h2>Expenses by category</h2><span class="tag">Savings rate ${s.savingsRate}%</span></div>
        ${s.byCat.length ? `<div class="chart-box" style="height:220px"><canvas id="donut" aria-label="Expenses by category"></canvas></div>` : ""}
        <div>${cats}</div>
      </div>`);
    drawCharts(s);
  }

  function drawCharts(s) {
    if (!window.Chart) return;
    const months = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ key: d.toLocaleDateString("en-CA").slice(0, 7), label: d.toLocaleDateString("id-ID", { month: "short" }) });
    }
    const total = (key, type) => S.txns.filter((t) => t.type === type && t.date.startsWith(key)).reduce((a, t) => a + t.amount, 0);
    charts.push(new Chart($("#bars"), {
      type: "bar",
      data: {
        labels: months.map((m) => m.label),
        datasets: [
          { label: "Income", data: months.map((m) => total(m.key, "income")), backgroundColor: "rgba(255, 255, 255, 0.3)", borderRadius: 5 },
          { label: "Expense", data: months.map((m) => total(m.key, "expense")), backgroundColor: "#cf4d6b", borderRadius: 5 },
        ],
      },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: "rgba(255, 255, 255, 0.85)", boxWidth: 10, boxHeight: 10 } },
                   tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${rp(c.parsed.y)}` } } },
        scales: { x: { ticks: { color: "rgba(255, 255, 255, 0.6)" }, grid: { display: false } },
                  y: { ticks: { color: "rgba(255, 255, 255, 0.6)", callback: (v) => compact(v) }, grid: { color: "rgba(255, 255, 255, 0.1)" } } },
      },
    }));
    if (s.byCat.length && $("#donut")) {
      const palette = ["#cf4d6b", "#f0899f", "#9a2a47", "#e3a3b3", "#7d1d38", "#f5c2cd", "#b23455", "#fadde3"];
      charts.push(new Chart($("#donut"), {
        type: "doughnut",
        data: { labels: s.byCat.map((c) => c[0]), datasets: [{ data: s.byCat.map((c) => c[1]), backgroundColor: palette, borderWidth: 2, borderColor: "#1c1217" }] },
        options: { maintainAspectRatio: false, cutout: "62%",
          plugins: { legend: { position: "right", labels: { color: "rgba(255, 255, 255, 0.85)", boxWidth: 10, boxHeight: 10, font: { size: 11 } } },
                     tooltip: { callbacks: { label: (c) => `${c.label}: ${rp(c.parsed)}` } } } },
      }));
    }
  }

  function viewPortfolio() {
    const pos = positions();
    const cost = pos.reduce((s, p) => s + p.cost, 0);
    const priced = pos.filter((p) => p.value !== null);
    const value = priced.reduce((s, p) => s + p.value, 0);
    const pl = priced.reduce((s, p) => s + p.pl, 0);
    const realized = S.sales.reduce((s, x) => s + Number(x.realized_pl), 0);
    const rows = pos.map((p, i) => {
      const unit = p.asset_type === "gold" ? "g" : "lembar";
      const label = p.name || p.ticker;
      return `<button class="tx" data-act="position" data-id="${i}">
        <span class="logo gold" aria-hidden="true">${icon(p.asset_type === "gold" ? "gold" : "stats")}</span>
        <span class="body"><b>${esc(label)}</b><small class="meta"><span class="cat">${qtyFmt(p.qty)} ${unit}</span><span class="acct">avg ${rp(p.avg)}</span></small></span>
        <em class="num">${rp(p.value ?? p.cost)}
          ${p.pl === null ? `<small class="muted">at cost</small>` : `<small class="${p.pl < 0 ? "neg" : "pos"}">${p.pl < 0 ? "−" : "+"}${num(Math.abs(p.pl))}</small>`}</em>
      </button>`;
    }).join("") || `<div class="empty">No holdings yet.</div>`;
    const sales = S.sales.slice(0, 20).map((x) => {
      const r = Number(x.realized_pl);
      return `<div class="list-row"><span class="grow">${esc(x.name || x.ticker)}<small>${esc(dateLabel(x.date))} · ${qtyFmt(x.quantity)} @ ${rp(Number(x.sell_price))}</small></span>
        <b class="num ${r < 0 ? "neg" : "pos"}">${r < 0 ? "−" : "+"}${num(Math.abs(r))}</b></div>`;
    }).join("");
    paint("portfolio", `
      <div class="top">
        <h1 class="title">Portfolio</h1>
        <div><div class="balance-label">${priced.length ? "Market value" : "Total cost"}</div>
          <div class="balance num"><small>Rp</small>${num(priced.length ? value : cost)}</div></div>
        <div class="stats">
          <div class="stat"><span>Cost</span><b class="num">${compact(cost)}</b></div>
          <div class="stat"><span>Unrealized</span><b class="num ${pl < 0 ? "down" : "up"}">${priced.length ? compact(pl) : "n/a"}</b></div>
          <div class="stat"><span>Realized</span><b class="num ${realized < 0 ? "down" : "up"}">${compact(realized)}</b></div>
        </div>
        <p class="muted" style="font-size:12.5px;margin:0">${S.prices
          ? (S.pricesAt ? `Prices updated ${new Date(S.pricesAt).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}. Tap Sync prices to refresh.` : "Tap Sync prices to refresh.")
          : "Live prices are not connected yet, so holdings show at cost. Tap Sync prices to try again."}</p>
        <div class="row"><button class="pill" data-act="holding">${icon("plus")} Add holding</button>
          <button class="pill ghost" data-act="sync-prices" id="sync-prices">${icon("refresh")} Sync prices</button></div>
      </div>
      <div class="sheet">
        <h2>Holdings</h2>${rows}
        ${sales ? `<div class="section-label">Realized sales</div><div>${sales}</div>` : ""}
      </div>`);
  }

  function viewSettings() {
    const accts = accountStack(S.accounts);
    const cats = S.categories.map((c) => `<button class="chip" data-act="category" data-id="${c.id}">${esc(c.name)}</button>`).join("");
    const owner = isOwner();
    paint("settings", `
      <div class="top">
        <h1 class="title">Settings</h1>
        <div class="card">
          <div class="row"><div class="avatar">${esc(initials(S.session.user.email))}</div>
            <div class="grow"><b>${esc(S.session.user.email)}</b><div class="muted" style="font-size:12.5px">${esc(S.household.name)} · ${S.members.length} member${S.members.length === 1 ? "" : "s"}</div></div></div>
          <div class="row">
            ${owner ? `<button class="pill ghost" data-act="member">Add member</button>` : ""}
            <button class="pill ghost" data-act="signout-ask">Sign out</button>
          </div>
        </div>
      </div>
      <div class="sheet">
        <div class="row between"><h2>Accounts</h2><button class="link" data-act="account">Add account</button></div>
        ${accts ? `<div class="stack">${accts}</div>` : `<div class="empty">No accounts yet.</div>`}
        <div class="row between" style="margin-top:14px"><h2>Categories</h2><button class="link" data-act="category">Add category</button></div>
        <div class="chips">${cats}</div>
        ${cfg.TELEGRAM_BOT ? `        <div class="section-label">Telegram bot</div>
        <div class="list-row"><span class="grow">\${S.telegram ? "Linked" : "Not linked"}<small>\${S.telegram
          ? "Send the bot a receipt photo or /help"
          : "Log entries by chat or by sending a receipt photo"}</small></span>
          <button class="link" data-act="\${S.telegram ? "telegram-unlink" : "telegram-link"}">\${S.telegram ? "Unlink" : "Link Telegram"}</button></div>` : ""}
        ${S.plansReady ? (() => {
          const groups = myNotifGroups(), on = groups.filter((g) => g.kinds.every(prefOn)).length;
          return `<div class="section-label">Configuration</div>
        <button class="list-row" data-go="notifications"><span class="grow">Notifications<small>${
          on === groups.length ? "All on" : on === 0 ? "All off" : `${on} of ${groups.length} on`}</small></span>${icon("next")}</button>`;
        })() : ""}
        <div class="section-label">Data</div>
        ${S.loansReady ? `<button class="list-row" data-go="loans"><span class="grow">Loans<small>${openLoans().length
          ? `${rp(totalOwed())} still owed` : "Nothing owed"}</small></span>${icon("next")}</button>` : ""}
        <button class="list-row" data-go="ledger"><span class="grow">Monthly statements<small>${lockedThrough()
          ? `Closed through ${esc(monthLabel(latestClosed()))}` : "No month closed yet"}</small></span>${icon("next")}</button>
        <div class="list-row"><span class="grow">Waiting to sync<small>Entries saved while offline</small></span><b class="num">${queue().length}</b></div>
      </div>`);
  }

  // ------------------------------------------------------------ notification settings screen
  const myNotifGroups = () => NOTIF_GROUPS.filter((g) => !g.owner || isOwner());

  function viewNotifSettings() {
    const owner = isOwner();
    const rows = myNotifGroups().map((g) => `<label class="list-row switch-row">
        <span class="grow">${esc(g.label)}<small>${esc(g.hint)}</small></span>
        <input type="checkbox" class="switch" data-pref="${g.id}" ${g.kinds.every(prefOn) ? "checked" : ""} aria-label="${esc(g.label)}">
      </label>`).join("");
    paint("settings", `
      <div class="top">
        <div class="row between">
          <button class="icon-btn" data-go="settings" aria-label="Back">${icon("back")}</button>
          <h1 class="title">Notifications</h1><span style="width:40px"></span>
        </div>
      </div>
      <div class="sheet">
        ${S.plansReady ? `<p class="hint" style="margin:0 0 4px">Choose what shows under the bell on Home. ${owner
          ? "As an owner you get every kind unless you turn it off."
          : "Members get none until they turn them on."}</p>
        ${rows}` : `<div class="empty">Notifications are not set up yet. Run <code>supabase/migrations/20261118000000_plans.sql</code>, then refresh.</div>`}
      </div>`);
  }

  // ------------------------------------------------------------ plans screen
  function planRow(p, i = 0) {
    const st = planStats(p);
    const running = st.status !== "achieved" && p.status === "active";
    const sub = `<small class="meta"><span class="cat">${Math.round(st.progress * 100)}%</span>`
      + `<span class="acct">${compact(st.saved)} of ${compact(st.target)}</span>`
      + `${running ? `<span class="acct">${compact(st.monthly)}/bln</span>` : ""}</small>`;
    return `<button class="tx plan-row" style="--i:${Math.min(i, 12)}" data-act="plan" data-id="${p.id}">
      <span class="logo emoji" aria-hidden="true">${esc(p.icon)}</span>
      <span class="body"><b>${esc(p.name)}</b>${sub}</span>
      ${planTag(st)}${planBar(st)}
    </button>`;
  }

  function viewPlans() {
    if (!S.plansReady) {
      return paint("home", `<div class="top">
        <div class="row between"><button class="icon-btn" data-go="home" aria-label="Back">${icon("back")}</button>
          <h1 class="title">Plans</h1><span style="width:40px"></span></div>
        <div class="card"><b>Not set up yet</b><span class="muted" style="font-size:13px">Run <code>supabase/migrations/20261118000000_plans.sql</code> in the Supabase SQL Editor, then refresh.</span></div>
      </div><div class="sheet"></div>`);
    }
    const running = runningPlans().map((p) => [p, planStats(p)]);
    const active = running.filter(([p]) => p.status === "active");
    const saved = running.reduce((s, [, st]) => s + st.saved, 0);
    const target = running.reduce((s, [, st]) => s + st.target, 0);
    const monthly = active.filter(([, st]) => st.status !== "achieved").reduce((s, [, st]) => s + st.monthly, 0);
    const behind = active.filter(([, st]) => st.status === "behind" || st.status === "overdue").length;
    const order = (a, b) => a.target_date.localeCompare(b.target_date);
    const live = S.plans.filter((p) => p.status === "active").sort(order);
    const other = S.plans.filter((p) => p.status !== "active")
      .sort((a, b) => ["paused", "achieved", "cancelled"].indexOf(a.status) - ["paused", "achieved", "cancelled"].indexOf(b.status) || order(a, b));
    paint("home", `
      <div class="top">
        <div class="row between">
          <button class="icon-btn" data-go="home" aria-label="Back">${icon("back")}</button>
          <h1 class="title">Plans</h1><span style="width:40px"></span>
        </div>
        <div><div class="balance-label">Saved in running plans</div>
          <div class="balance num"><small>Rp</small>${num(saved)}</div></div>
        <div class="stats">
          <div class="stat"><span>Target</span><b class="num">${compact(target)}</b></div>
          <div class="stat"><span>Needed / month</span><b class="num">${compact(monthly)}</b></div>
          <div class="stat"><span>Behind</span><b class="num ${behind ? "down" : ""}">${behind}</b></div>
        </div>
        <div class="row"><button class="pill" data-act="plan-new">${icon("plus")} New plan</button></div>
      </div>
      <div class="sheet">
        <h2>Active</h2>
        ${live.map(planRow).join("") || `<div class="empty">No active plans. Start one for something you are saving towards, like a laptop or a wedding.</div>`}
        ${other.length ? `<details class="fold"><summary>Paused, achieved and cancelled (${other.length})</summary>
          <div class="fold-body">${other.map(planRow).join("")}</div></details>` : ""}
      </div>`);
  }

  // ------------------------------------------------------------ loans screen
  function loanRow(l, i = 0) {
    const st = loanStats(l);
    const sub = `<small class="meta">` + (st.paid
      ? `<span class="cat">Repaid</span><span class="acct">${compact(l.amount)}</span>`
      : `<span class="cat">${compact(st.outstanding)} left</span><span class="acct">of ${compact(l.amount)}</span>`
        + `${l.due_date ? `<span class="acct">due ${esc(dateLabel(l.due_date))}</span>` : ""}`) + `</small>`;
    const tag = st.paid ? `<span class="tag ok">Paid</span>` : st.overdue ? `<span class="tag due">Overdue</span>` : `<span class="tag">Open</span>`;
    return `<button class="tx plan-row" style="--i:${Math.min(i, 12)}" data-act="loan" data-id="${l.id}">
      <span class="logo xfer" aria-hidden="true">${icon("user")}</span>
      <span class="body"><b>${esc(memberName(l.borrower_id))}</b>${sub}</span>
      ${tag}<span class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(st.progress * 100)}"><i style="width:${(st.progress * 100).toFixed(1)}%"></i></span>
    </button>`;
  }

  function viewLoans() {
    if (!S.loansReady) {
      return paint("home", `<div class="top">
        <div class="row between"><button class="icon-btn" data-go="home" aria-label="Back">${icon("back")}</button>
          <h1 class="title">Loans</h1><span style="width:40px"></span></div>
        <div class="card"><b>Not set up yet</b><span class="muted" style="font-size:13px">Run <code>supabase/migrations/20261122000000_loans.sql</code> in the Supabase SQL Editor, then refresh.</span></div>
      </div><div class="sheet"></div>`);
    }
    const by = S.loanFilter;
    const mine = S.loans.filter((l) => !by || l.borrower_id === by);
    const open = mine.filter((l) => !loanStats(l).paid).sort((a, b) => (a.due_date || "9999").localeCompare(b.due_date || "9999") || a.date.localeCompare(b.date));
    const done = mine.filter((l) => loanStats(l).paid);
    const owed = open.reduce((s, l) => s + loanStats(l).outstanding, 0);
    const repaid = mine.reduce((s, l) => s + loanStats(l).repaid, 0);
    const overdue = open.filter((l) => loanStats(l).overdue).length;
    const borrowers = [...new Set(S.loans.map((l) => l.borrower_id).filter(Boolean))];
    paint("home", `
      <div class="top">
        <div class="row between">
          <button class="icon-btn" data-go="home" aria-label="Back">${icon("back")}</button>
          <h1 class="title">Loans</h1><span style="width:40px"></span>
        </div>
        <div><div class="balance-label">${by ? `Still owed by ${esc(memberName(by))}` : "Still owed"}</div>
          <div class="balance num"><small>Rp</small>${num(owed)}</div></div>
        <div class="stats">
          <div class="stat"><span>Open loans</span><b class="num">${open.length}</b></div>
          <div class="stat"><span>Repaid</span><b class="num up">${compact(repaid)}</b></div>
          <div class="stat"><span>Overdue</span><b class="num ${overdue ? "down" : ""}">${overdue}</b></div>
        </div>
        <div class="row"><button class="pill" data-act="loan-new">${icon("plus")} New loan</button></div>
      </div>
      <div class="sheet">
        ${borrowers.length > 1 ? `<div class="filters"><select id="f-loan" data-loanfilter aria-label="Borrower">
          <option value="">Everyone</option>${borrowers.map((u) => `<option value="${u}" ${by === u ? "selected" : ""}>${esc(memberName(u))}</option>`).join("")}</select></div>` : ""}
        <h2>Open</h2>
        ${open.map(loanRow).join("") || `<div class="empty">Nothing owed. Record a loan when a member borrows from an account, for example Bersama.</div>`}
        ${done.length ? `<details class="fold"><summary>Paid (${done.length})</summary><div class="fold-body">${done.map(loanRow).join("")}</div></details>` : ""}
        <p class="hint">A loan is money lent from one of your accounts to a member, who pays it back into an account. It is not an expense, and the repayment is not income.</p>
      </div>`);
  }

  // ------------------------------------------------------------ monthly statements (ledger closing)
  function viewLedger() {
    const thisMonth = monthStart(today());
    const next = nextToClose();
    const lock = lockedThrough();
    const oldest = S.txns.length ? monthStart(S.txns.reduce((d, t) => (t.date < d ? t.date : d), thisMonth)) : thisMonth;
    const closed = Object.fromEntries(closedMonths().map((c) => [c.month, c]));
    const months = [];
    for (let m = thisMonth; m >= oldest && months.length < 240; m = addMonths(m, -1)) months.push(m);
    const rows = months.map((m, i) => {
      const c = closed[m];
      const status = c ? `Closed on ${fullDate(c.closed_at)}${c.version > 1 ? ` · version ${c.version}` : ""}`
        : m === thisMonth ? "This month, still running"
        : lock && m <= lock ? "Locked: before the first closed month"
        : m === next ? "Ready to close" : "Open";
      const tag = c ? `<span class="tag ok">Closed</span>` : m === next ? `<span class="tag due">To close</span>` : "";
      return `<button class="list-row" style="--i:${Math.min(i, 12)}" data-act="statement" data-id="${m}">
        <span class="grow"><b>${esc(monthLabel(m))}</b><small>${esc(status)}</small></span>
        ${c ? `<b class="num">${rp(Number(c.closing))}</b>` : ""}${tag}</button>`;
    }).join("");
    paint("settings", `
      <div class="top">
        <div class="row between">
          <button class="icon-btn" data-go="settings" aria-label="Back">${icon("back")}</button>
          <h1 class="title">Monthly statements</h1><span style="width:40px"></span>
        </div>
        ${!S.ledgerReady ? `<div class="card"><b>Not set up yet</b><span class="muted" style="font-size:13px">Run <code>supabase/migrations/20261117000000_ledger_closing.sql</code> in the Supabase SQL Editor, then refresh.</span></div>`
          : next && isOwner() ? `<button class="card due-card" data-act="statement" data-id="${next}">
            <span class="grow"><b>Close ${esc(monthLabel(next))}</b><small>Check the figures and bank balances, then lock the month.</small></span>${icon("lock")}</button>` : ""}
      </div>
      <div class="sheet">
        <p class="hint" style="margin:0 0 4px">Closing a month saves its statement and locks every entry dated in it or earlier. Only an owner can close or reopen a month.</p>
        ${S.ledgerReady ? rows : ""}
      </div>`);
  }

  let lastStatement = null; // { m, st } of the statement on screen, for the CSV export

  async function sheetStatement(m) {
    if (!S.ledgerReady) return toast("Monthly statements are not set up yet");
    const c = closedMonths().find((x) => x.month === m);
    openSheet(monthLabel(m), `<div class="statement" id="statement" data-month="${m}">
      <div class="scan-busy"><span class="spinner"></span> Loading the statement…</div></div>`);
    try {
      const evq = sb.from("ledger_closing_events").select("*").eq("household_id", S.household.id).eq("month", m).order("at", { ascending: false });
      let st;
      if (c) {
        const [full, accs] = await Promise.all([
          sb.from("ledger_closings").select("*").eq("id", c.id).single(),
          sb.from("ledger_closing_accounts").select("*").eq("closing_id", c.id).order("sort_order"),
        ]);
        const snap = check(full);
        st = {
          closing: snap, totals: snap, savings_rate: snap.savings_rate, realized_pl: snap.realized_pl,
          by_category: snap.by_category, checklist: snap.checklist, plans: snap.plans || [],
          loans: snap.loans || [], loans_outstanding: snap.loans_outstanding || 0,
          accounts: check(accs).map((a) => ({ ...a, name: a.account_name })),
        };
      } else {
        st = check(await sb.rpc("period_statement", { p_household: S.household.id, p_month: m }));
      }
      const events = (await evq).data || [];
      const box = $("#statement");
      if (!box || box.dataset.month !== m) return; // closed or replaced while loading
      lastStatement = { m, st };
      box.innerHTML = statementBody(m, st, events);
      drawStatementCharts(st);
    } catch (e) {
      const box = $("#statement");
      if (box) box.innerHTML = `<div class="error">${esc(isNetworkError(e) ? "Statements need a connection." : e.message || "Could not load the statement.")}</div>`;
    }
  }

  // Expenses of the month by account and by category, from figures the statement already carries
  // (a draft is live, a closed month is its stored snapshot). Top six categories, the rest as "Other".
  function expenseSplit(st) {
    const n = (v) => Number(v) || 0;
    const accounts = (st.accounts || []).filter((a) => n(a.expense) > 0).sort((a, b) => n(b.expense) - n(a.expense));
    const all = (st.by_category || []).filter((c) => n(c.amount) > 0).sort((a, b) => n(b.amount) - n(a.amount));
    const cats = all.slice(0, 6).map((c) => ({ name: c.name, amount: n(c.amount) }));
    const rest = all.slice(6).reduce((s, c) => s + n(c.amount), 0);
    if (rest > 0) cats.push({ name: "Other", amount: rest });
    return { accounts, cats };
  }

  function drawStatementCharts(st) {
    if (!window.Chart) return;
    const n = (v) => Number(v) || 0;
    const { accounts, cats } = expenseSplit(st);
    const ink = "rgba(255, 255, 255, 0.85)", soft = "rgba(255, 255, 255, 0.6)";
    const accEl = $("#st-acc"), catEl = $("#st-cat");
    if (accEl && accounts.length) {
      charts.push(new Chart(accEl, {
        type: "bar",
        data: { labels: accounts.map((a) => a.name), datasets: [{ data: accounts.map((a) => n(a.expense)), backgroundColor: "#cf4d6b", borderRadius: 5, maxBarThickness: 28 }] },
        options: {
          indexAxis: "y", maintainAspectRatio: false, animation: reducedMotion() ? false : undefined,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => rp(c.parsed.x) } } },
          scales: { x: { ticks: { color: soft, callback: (v) => compact(v), maxTicksLimit: 5 }, grid: { color: "rgba(255, 255, 255, 0.1)" } },
                    y: { ticks: { color: ink }, grid: { display: false } } },
        },
      }));
    }
    if (catEl && cats.length) {
      const palette = ["#cf4d6b", "#f0899f", "#9a2a47", "#e3a3b3", "#7d1d38", "#f5c2cd", "#888780"]; // the last one is "Other"
      charts.push(new Chart(catEl, {
        type: "doughnut",
        data: { labels: cats.map((c) => c.name), datasets: [{ data: cats.map((c) => c.amount), backgroundColor: cats.map((c, i) => (c.name === "Other" && i === cats.length - 1 ? palette[6] : palette[i])), borderWidth: 2, borderColor: "#1c1217" }] },
        options: { maintainAspectRatio: false, cutout: "62%", animation: reducedMotion() ? false : undefined,
          plugins: { legend: { position: "right", labels: { color: ink, boxWidth: 10, boxHeight: 10, font: { size: 11 } } },
                     tooltip: { callbacks: { label: (c) => `${c.label}: ${rp(c.parsed)}` } } } },
      }));
    }
  }

  function statementBody(m, st, events) {
    const n = (v) => Number(v) || 0;
    const T = st.totals, closed = !!st.closing, label = monthLabel(m);
    const net = n(T.income) - n(T.expense) - n(T.invest);
    const cell = (name, value, cls = "") => `<div><span>${name}</span><b class="num ${cls}">${value}</b></div>`;
    const tone = (v) => (v < 0 ? "neg" : "pos");
    const head = closed
      ? `<p class="hint">Closed on ${esc(fullDate(st.closing.closed_at))}${st.closing.version > 1 ? ` (version ${st.closing.version})` : ""}. These are the figures saved at closing.${st.closing.note ? ` Note: ${esc(st.closing.note)}` : ""}</p>`
      : `<p class="hint">Draft. The figures follow your entries until the month is closed.</p>`;
    const summary = `<div class="st-grid">
      ${cell("Opening balance", rp(n(T.opening)))}${cell("Closing balance", rp(n(T.closing)))}
      ${cell("Income", rp(n(T.income)), "pos")}${cell("Expense", rp(-n(T.expense)), "neg")}
      ${cell("Invested", rp(n(T.invest)))}${cell("Net", rp(net), tone(net))}
      ${cell("Savings rate", st.savings_rate == null ? "n/a" : `${n(st.savings_rate).toLocaleString("id-ID")}%`)}
      ${cell("Realized P&amp;L", rp(n(st.realized_pl)), tone(n(st.realized_pl)))}
      ${n(T.loan_in) || n(T.loan_out) ? cell("Loans given", rp(-n(T.loan_out)), "neg") + cell("Repayments received", rp(n(T.loan_in)), "pos") : ""}
      ${closed && st.closing.portfolio_value != null ? cell("Portfolio at closing", rp(n(st.closing.portfolio_value)))
        + cell("Unrealized P&amp;L", st.closing.unrealized_pl == null ? "at cost" : rp(n(st.closing.unrealized_pl)), tone(n(st.closing.unrealized_pl))) : ""}
    </div>`;
    const accounts = st.accounts.map((a) => {
      const inflow = n(a.income) + n(a.transfer_in) + n(a.loan_in), out = n(a.expense) + n(a.invest) + n(a.transfer_out) + n(a.loan_out);
      const bank = closed && a.bank_balance != null
        ? `<small>Bank ${rp(n(a.bank_balance))}${n(a.difference) ? ` · differs by ${rp(n(a.difference))}${a.difference_note ? `: ${esc(a.difference_note)}` : ""}` : " · matches"}</small>` : "";
      return `<div class="list-row"><span class="grow">${esc(a.name)}<small>Opening ${rp(n(a.opening))} · in ${compact(inflow)} · out ${compact(out)}</small>${bank}</span>
        <b class="num">${rp(n(a.closing))}</b></div>`;
    }).join("") || `<div class="empty">No accounts.</div>`;
    const cats = (st.by_category || []).map((c) =>
      `<div class="list-row"><span class="grow">${esc(c.name)}</span><b class="num">${rp(n(c.amount))}</b></div>`).join("")
      || `<div class="empty">No expenses this month.</div>`;
    // Loans still unpaid at the end of this month (FR-CLS-16). A closed statement shows the saved list.
    const loansList = st.loans || [];
    const owedTotal = n(st.loans_outstanding);
    const loansSection = loansList.length ? `<div class="section-label">Loans outstanding at month end</div>
      ${loansList.map((l) => `<div class="list-row"><span class="grow">${esc(l.borrower ? l.borrower.split("@")[0] : "A former member")}<small>Lent ${rp(n(l.amount))} on ${esc(dateLabel(l.date))}${
          n(l.borrowed) ? " (this month)" : ""} · repaid ${rp(n(l.repaid_to_date))}${n(l.repaid_month) ? `, ${rp(n(l.repaid_month))} this month` : ""}${l.due_date ? ` · due ${esc(dateLabel(l.due_date))}` : ""}</small></span>
          <b class="num neg">${rp(n(l.outstanding))}</b></div>`).join("")}
      <div class="list-row"><span class="grow"><b>Total outstanding</b></span><b class="num neg">${rp(owedTotal)}</b></div>` : "";
    const ck = st.checklist || {};
    const waiting = queue().filter((q) => monthStart(q.date) === m).length;
    const checkRow = (ok, text) => `<div class="check ${ok ? "ok" : "warn"}">${ok ? "✓" : "!"} ${text}</div>`;
    const checklist = `<div class="section-label">Checklist${closed ? " at closing" : ""}</div>
      ${checkRow(true, `${n(ck.entries)} entr${n(ck.entries) === 1 ? "y" : "ies"} this month`)}
      ${checkRow(!n(ck.uncategorised), `${n(ck.uncategorised)} without a category`)}
      ${checkRow(!n(ck.unassigned), `${n(ck.unassigned)} without an account`)}
      ${loansList.length ? checkRow(true, `${loansList.length} loan${loansList.length === 1 ? "" : "s"} still unpaid, ${rp(owedTotal)} in total`) : ""}
      ${closed ? "" : checkRow(!waiting, `${waiting} waiting to sync on this device`)}`;

    let action = "";
    if (!closed && st.can_close) {
      const active = st.accounts.filter((a) => a.account_id && !a.archived);
      action = `<form data-form="close">
        <input type="hidden" name="month" value="${m}">
        <div class="section-label">Bank balances on the last day</div>
        <p class="hint">Enter what each bank app shows at the end of ${esc(label)}. If it differs from the books, fix the entries or say why.</p>
        ${active.map((a) => `<div class="bank-row">
          <label class="f">${esc(a.name)} (Rp)<input inputmode="numeric" name="bank-${a.account_id}" data-bank data-id="${a.account_id}"
            data-name="${esc(a.name)}" data-closing="${n(a.closing)}" value="${num(n(a.closing))}" required></label>
          <small class="diff" id="diff-${a.account_id}">Matches the books</small>
          <input id="diffnote-${a.account_id}" placeholder="Why it differs (e.g. bank fee not recorded)" hidden>
        </div>`).join("")}
        <label class="f">Note (optional)<input name="note" placeholder="Anything worth remembering about this month"></label>
        <div class="error"></div>
        <button class="pill" type="submit">Close ${esc(label)}</button>
        <p class="hint">After closing, entries dated in ${esc(label)} or earlier can't be added, changed or deleted until an owner reopens it.</p>
      </form>`;
    } else if (!closed) {
      action = `<p class="hint">${esc(st.blocked_reason || "")}</p>`;
    } else {
      const canReopen = isOwner() && m === latestClosed();
      action = `<div class="row no-print">
          <button class="pill ghost-light" type="button" data-act="statement-print">Print or save PDF</button>
          <button class="pill ghost-light" type="button" data-act="statement-csv" data-id="${m}">Export CSV</button>
        </div>
        ${canReopen ? `<form data-form="reopen">
          <input type="hidden" name="month" value="${m}">
          <label class="f">Reason for reopening<input name="reason" required placeholder="e.g. late receipt from the 30th"></label>
          <div class="error"></div>
          <button class="pill dark" type="submit">Reopen ${esc(label)}</button>
        </form>` : ""}`;
    }

    const history = events.length ? `<div class="section-label">History</div>${events.map((e) =>
      `<div class="list-row"><span class="grow">${e.action === "close" ? `Closed (version ${e.version})` : "Reopened"}${e.reason ? `<small>${esc(e.reason)}</small>` : ""}</span>
        <small>${esc(new Date(e.at).toLocaleString("id-ID", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }))}</small></div>`).join("")}` : "";

    // net money put in this month: deposits - withdrawals + adjustments (older snapshots only have deposits)
    const planNet = (p) => n(p.contributed) - n(p.withdrawals) + n(p.adjustments);
    const plans = (st.plans || []).map((p) =>
      `<div class="list-row"><span class="grow">${esc(p.icon)} ${esc(p.name)}<small>${rp(n(p.saved))} of ${rp(n(p.target))} at month end (${n(p.progress).toLocaleString("id-ID")}%)${
        n(p.asset_value) ? ` · includes ${rp(n(p.asset_value))} of gold and stocks at ${p.assets_priced === "market" ? `market price${p.prices_on ? " of " + dateLabel(p.prices_on) : ""}` : "cost"}` : ""}${
        n(p.withdrawals) ? ` · ${rp(n(p.withdrawals))} taken out` : ""}${
        n(p.spent_total) ? ` · ${rp(n(p.spent_total))} paid from the plan${n(p.spent) ? ` (${rp(n(p.spent))} this month)` : ""}` : ""}</small></span>
        <b class="num ${planNet(p) > 0 ? "pos" : ""}">${planNet(p) ? (planNet(p) > 0 ? "+" : "−") + num(Math.abs(planNet(p))) : "0"}</b></div>`).join("");

    // charts of where the month's expenses went; the text lists are under each chart
    const split = expenseSplit(st);
    const accChart = !split.accounts.length ? "" : `<div class="section-label">Expenses by account</div>
        <div class="chart-box" style="height:${Math.max(110, split.accounts.length * 44 + 40)}px"><canvas id="st-acc" role="img" aria-label="Expenses by account: ${esc(split.accounts.map((a) => `${a.name} ${rp(n(a.expense))}`).join(", "))}"></canvas></div>
        ${split.accounts.map((a) => `<div class="list-row"><span class="grow">${esc(a.name)}</span><b class="num">${rp(n(a.expense))}</b></div>`).join("")}`;
    const catChart = !split.cats.length ? "" : `<div class="chart-box" style="height:190px"><canvas id="st-cat" role="img" aria-label="Expenses by category: ${esc(split.cats.map((c) => `${c.name} ${rp(c.amount)}`).join(", "))}"></canvas></div>`;

    return `${head}${summary}${accChart}
      <div class="section-label">Accounts</div>${accounts}
      <div class="section-label">Expenses by category</div>${catChart}${cats}
      ${plans ? `<div class="section-label">Plans: added this month</div>${plans}` : ""}
      ${loansSection}
      ${checklist}${action}${history}`;
  }

  function downloadCsv(m) {
    if (lastStatement?.m !== m) return;
    const st = lastStatement.st, T = st.totals;
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [
      ["Statement", monthLabel(m)], [],
      ["Account", "Opening", "Income", "Expense", "Invest", "Transfer in", "Transfer out", "Loan repayment received", "Loan given", "Closing", "Bank balance", "Difference", "Note"],
      ...st.accounts.map((a) => [a.name, a.opening, a.income, a.expense, a.invest, a.transfer_in, a.transfer_out, a.loan_in ?? 0, a.loan_out ?? 0, a.closing,
        a.bank_balance ?? "", a.difference ?? "", a.difference_note ?? ""]),
      ["Total", T.opening, T.income, T.expense, T.invest, T.transfer_in, T.transfer_out, T.loan_in ?? 0, T.loan_out ?? 0, T.closing], [],
      ...((st.loans || []).length ? [["Loan outstanding at month end", "Borrower", "Date", "Original amount", "Repaid this month", "Repaid to date", "Outstanding", "Due date"],
        ...st.loans.map((l) => ["", l.borrower ? l.borrower.split("@")[0] : "", l.date, l.amount, l.repaid_month, l.repaid_to_date, l.outstanding, l.due_date ?? ""]),
        ["Total outstanding", "", "", "", "", "", st.loans_outstanding], []] : []),
      ...((st.plans || []).length ? [["Plan", "Added this month", "Taken out", "Spent this month", "Spent to date", "Cash at month end", "Gold and stocks", "Priced at", "Saved at month end", "Target", "Progress %", "Status"],
        ...st.plans.map((p) => [p.name, p.contributed, p.withdrawals ?? 0, p.spent ?? 0, p.spent_total ?? 0, p.cash ?? p.saved, p.asset_value ?? 0, p.assets_priced ?? "", p.saved, p.target, p.progress, p.status]), []] : []),
      ["Date", "Type", "Category", "Description", "Account", "Amount"],
      ...S.txns.filter((t) => monthStart(t.date) === m).slice().reverse().map((t) =>
        [t.date, t.type, t.type.startsWith("transfer") ? "Transfer" : categoryName(t.category_id), t.description, accountName(t.account_id), t.amount]),
    ];
    const blob = new Blob(["﻿" + lines.map((r) => r.map(q).join(",")).join("\r\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `statement-${m.slice(0, 7)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ------------------------------------------------------------ bottom-sheet forms
  function openSheet(title, body) {
    sheetRoot.innerHTML = `<div class="overlay" data-act="dismiss"><div class="modal" role="dialog" aria-label="${esc(title)}">
      <header><h2>${esc(title)}</h2><button class="close" data-act="close" aria-label="Close">${icon("close")}</button></header>
      ${body}</div></div>`;
    enhanceCombos();
    enhanceDates();
    $("input:not([type=hidden]), select", sheetRoot)?.focus({ preventScroll: true });
  }

  // The native date popup cannot be styled, so date fields open a glass calendar of our own.
  // The field stays a real type="date" input (value is still YYYY-MM-DD, set programmatically
  // in places) but is read-only so only the calendar changes it; min/max are enforced by it.
  let calBound = false;
  function enhanceDates() {
    if (!calBound) {
      calBound = true;
      document.addEventListener("pointerdown", (e) => {
        if (e.target.closest?.(".cal") || e.target.closest?.('input[type="date"]')) return;
        document.querySelectorAll(".cal").forEach((c) => { c.hidden = true; });
      });
    }
    const pad = (n) => String(n).padStart(2, "0");
    const key = (y, m, d) => { const x = new Date(y, m, d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
    const chev = (dir) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${dir < 0 ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"}"/></svg>`;
    const months = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString("en-US", { month: "short" }));
    sheetRoot.querySelectorAll('input[type="date"]').forEach((inp) => {
      if (inp.disabled) return;
      inp.readOnly = true;
      inp.setAttribute("autocomplete", "off");
      const box = document.createElement("div");
      box.className = "cal";
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-label", "Choose a date");
      box.hidden = true;
      sheetRoot.appendChild(box);
      let view = "days", y = 0, m = 0;
      const okDay = (s) => (!inp.min || s >= inp.min) && (!inp.max || s <= inp.max);
      const hide = () => { box.hidden = true; };
      const draw = () => {
        const sel = inp.value, t = today();
        if (view === "months") {
          const prevOff = inp.min && inp.min >= key(y, 0, 1), nextOff = inp.max && inp.max < key(y + 1, 0, 1);
          box.innerHTML = `<div class="cal-head"><button type="button" class="cal-nav" data-cal="prev" aria-label="Previous year" ${prevOff ? "disabled" : ""}>${chev(-1)}</button>
            <button type="button" class="cal-title" data-cal="days">${y}</button>
            <button type="button" class="cal-nav" data-cal="next" aria-label="Next year" ${nextOff ? "disabled" : ""}>${chev(1)}</button></div>
            <div class="cal-months">${months.map((n, i) => {
              const off = (inp.min && key(y, i + 1, 0) < inp.min) || (inp.max && key(y, i, 1) > inp.max);
              return `<button type="button" class="cal-m ${sel.startsWith(`${y}-${pad(i + 1)}`) ? "sel" : ""}" data-m="${i}" ${off ? "disabled" : ""}>${n}</button>`;
            }).join("")}</div>`;
          return;
        }
        const lead = (new Date(y, m, 1).getDay() + 6) % 7, n = new Date(y, m + 1, 0).getDate();
        const prevOff = inp.min && inp.min >= key(y, m, 1), nextOff = inp.max && inp.max < key(y, m + 1, 1);
        let cells = "";
        for (let i = 0; i < lead; i++) cells += `<span></span>`;
        for (let d = 1; d <= n; d++) {
          const s = key(y, m, d);
          cells += `<button type="button" class="cal-d ${s === sel ? "sel" : ""} ${s === t ? "today" : ""}" data-d="${s}" ${okDay(s) ? "" : "disabled"}>${d}</button>`;
        }
        box.innerHTML = `<div class="cal-head"><button type="button" class="cal-nav" data-cal="prev" aria-label="Previous month" ${prevOff ? "disabled" : ""}>${chev(-1)}</button>
          <button type="button" class="cal-title" data-cal="months">${new Date(y, m, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" })}</button>
          <button type="button" class="cal-nav" data-cal="next" aria-label="Next month" ${nextOff ? "disabled" : ""}>${chev(1)}</button></div>
          <div class="cal-week">${["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((w) => `<span>${w}</span>`).join("")}</div>
          <div class="cal-grid">${cells}</div>
          <div class="cal-foot"><button type="button" class="cal-today" data-d="${t}" ${okDay(t) ? "" : "disabled"}>Today</button></div>`;
      };
      const open = () => {
        document.querySelectorAll(".cal").forEach((c) => { if (c !== box) c.hidden = true; });
        const base = inp.value || (inp.max && inp.max < today() ? inp.max : today());
        y = Number(base.slice(0, 4)); m = Number(base.slice(5, 7)) - 1; view = "days";
        draw();
        place();
        box.hidden = false;
      };
      const place = () => {
        const r = inp.getBoundingClientRect(), w = Math.min(320, innerWidth - 24);
        box.style.width = `${w}px`;
        box.style.left = `${Math.max(12, Math.min(r.left, innerWidth - w - 12))}px`;
        const below = innerHeight - r.bottom - 14, above = r.top - 14, up = below < 360 && above > below;
        box.style.maxHeight = `${Math.max(240, up ? above : below)}px`;
        box.style.top = up ? "auto" : `${r.bottom + 6}px`;
        box.style.bottom = up ? `${innerHeight - r.top + 6}px` : "auto";
      };
      inp.addEventListener("click", () => (box.hidden ? open() : hide()));
      inp.addEventListener("keydown", (e) => {
        if (["Enter", " ", "ArrowDown"].includes(e.key)) { e.preventDefault(); open(); }
        else if (e.key === "Escape" && !box.hidden) { e.stopPropagation(); hide(); }
        else if ((e.key === "Backspace" || e.key === "Delete") && !inp.required) { inp.value = ""; inp.dispatchEvent(new Event("change", { bubbles: true })); }
      });
      box.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b || b.disabled) return;
        if (b.dataset.d) {
          inp.value = b.dataset.d;
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          hide();
          return;
        }
        if (b.dataset.m) { m = Number(b.dataset.m); view = "days"; return draw(); }
        const step = b.dataset.cal === "prev" ? -1 : b.dataset.cal === "next" ? 1 : 0;
        if (b.dataset.cal === "months") view = "months";
        else if (b.dataset.cal === "days") view = "days";
        else if (view === "months") y += step;
        else { const x = new Date(y, m + step, 1); y = x.getFullYear(); m = x.getMonth(); }
        draw();
      });
      // the browser scrolls a focused field into view after a moment: follow it instead of closing
      $(".modal", sheetRoot)?.addEventListener("scroll", () => { if (!box.hidden) place(); }, { passive: true });
      // a read-only field skips the browser's required check, so do it here
      const form = inp.closest("form");
      if (form && !form.dataset.dateGuard) {
        form.dataset.dateGuard = "1";
        form.addEventListener("submit", (e) => {
          const bad = [...form.querySelectorAll('input[type="date"][required]')].find((i) => !i.value);
          if (!bad) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          const err = $(".error", form);
          if (err) err.textContent = "Pick a date.";
        });
      }
    });
  }

  // A native <datalist> popup cannot be styled, so a text field with `list` gets a glass
  // suggestion list of its own (same look as the select menu). Typing still accepts any text.
  function enhanceCombos() {
    sheetRoot.querySelectorAll("input[list]").forEach((inp) => {
      const dl = document.getElementById(inp.getAttribute("list"));
      if (!dl) return;
      const values = [...dl.options].map((o) => o.value);
      inp.removeAttribute("list");
      dl.remove();
      inp.autocomplete = "off";
      const box = document.createElement("div");
      box.className = "combo-list";
      box.setAttribute("role", "listbox");
      box.hidden = true;
      sheetRoot.appendChild(box);
      let items = [], active = -1;
      const hide = () => { box.hidden = true; active = -1; };
      const mark = () => items.forEach((el, i) => el.classList.toggle("active", i === active));
      const pick = (v) => { inp.value = v; inp.dispatchEvent(new Event("input", { bubbles: true })); hide(); };
      const show = () => {
        const q = inp.value.trim().toLowerCase();
        const list = values.filter((v) => v.toLowerCase().includes(q) && v.toLowerCase() !== q);
        if (!list.length) return hide();
        box.innerHTML = list.map((v) => `<div role="option" class="combo-opt" data-v="${esc(v)}">${esc(v)}</div>`).join("");
        items = [...box.children];
        const r = inp.getBoundingClientRect();
        const below = innerHeight - r.bottom - 14, above = r.top - 14;
        const up = below < 150 && above > below;
        box.style.left = `${r.left}px`;
        box.style.width = `${r.width}px`;
        box.style.maxHeight = `${Math.max(100, Math.min(240, up ? above : below))}px`;
        box.style.top = up ? "auto" : `${r.bottom + 6}px`;
        box.style.bottom = up ? `${innerHeight - r.top + 6}px` : "auto";
        box.hidden = false;
        active = -1;
      };
      inp.addEventListener("focus", show);
      inp.addEventListener("input", show);
      inp.addEventListener("blur", () => setTimeout(hide, 120));
      inp.addEventListener("keydown", (e) => {
        if (box.hidden) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          mark();
          items[active].scrollIntoView({ block: "nearest" });
        } else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(items[active].dataset.v); }
        else if (e.key === "Escape") { e.stopPropagation(); hide(); }
      });
      // pointerdown (not click) so the field keeps focus and the blur timer does not eat the tap
      box.addEventListener("pointerdown", (e) => {
        const o = e.target.closest(".combo-opt");
        if (o) { e.preventDefault(); pick(o.dataset.v); }
      });
      $(".modal", sheetRoot)?.addEventListener("scroll", () => { if (!box.hidden) show(); }, { passive: true });
    });
  }
  function closeSheet() {
    const scan = S.scan;
    S.scan = null;
    const m = $(".modal", sheetRoot);
    const back = hero;
    hero = null;
    if (!m || !motionOK() || vtRunning) sheetRoot.innerHTML = "";
    else {
      // a sheet that grew from a row shrinks back into it; any other sheet slides down
      const morph = m.style.viewTransitionName === "hero";
      if (!morph) {
        // Plain sheet: a CSS slide-down on the live element. A view transition would flatten the
        // glass (its snapshot drops the backdrop blur), so the close would not match the open.
        m.style.viewTransitionName = "";
        $(".overlay", sheetRoot)?.classList.add("closing");
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          if ($(".modal", sheetRoot) === m) sheetRoot.innerHTML = "";
        };
        m.addEventListener("animationend", (e) => { if (e.target === m) finish(); });
        setTimeout(finish, 450); // safety net if the animation never fires
      } else {
        let target = null;
        transition(() => {
          if ($(".modal", sheetRoot) === m) sheetRoot.innerHTML = "";
          const el = back && app.querySelector(`[data-act="${back.act}"][data-id="${CSS.escape(back.id || "")}"]`);
          if (el) { target = el.closest(".wcard") || el; target.style.viewTransitionName = "hero"; }
        }, "hero", () => { if (target) target.style.viewTransitionName = ""; });
      }
    }
    if (scan?.saved) reload(); // a scan review was closed part-way: show what was saved
  }

  const accountOptions = (selected, allowNone = false) =>
    (allowNone ? `<option value="">None</option>` : "") +
    activeAccounts().map((a) => `<option value="${a.id}" ${a.id === selected ? "selected" : ""}>${esc(a.name)}</option>`).join("");

  // `pre` prefills the form from a scan or, with `pre.id`, from a saved transaction being edited;
  // `scan` adds the review header and Skip button.
  function sheetAdd(type = "expense", pre = {}, scan = null) {
    if (!activeAccounts().length) return sheetAccount();
    const editing = !!pre.id;
    const types = [["expense", "Expense"], ["income", "Income"], ["invest", "Invest"]];
    const category = pre.category ?? (type === "income" ? "Salary" : type === "invest" ? "Stocks" : "");
    const date = pre.date && (editing || pre.date <= today()) ? pre.date : today();
    const many = scan && scan.rows.length > 1;
    const account = editing ? pre.account || "" : store.get("ft.lastAccount", "");
    const planSpend = editing ? S.ledger.find((l) => l.entry_type === "spend" && l.transaction_id === pre.id) : null;
    const planOf = planSpend ? S.plans.find((x) => x.id === planSpend.plan_id) : null;
    const lock = planSpend ? "disabled" : ""; // amount, account and date of a plan payment are changed from the plan
    openSheet(editing ? "Edit transaction" : scan ? "Check the details" : "Add transaction", `<form data-form="txn">
      <input type="hidden" name="id" value="${esc(pre.id || "")}">
      <input type="hidden" name="type" id="txn-type" value="${type}">
      <input type="hidden" name="source" value="${scan ? "ocr" : "web"}">
      ${scan ? `<p class="hint">${many ? `Row ${scan.index + 1} of ${scan.rows.length}. ` : ""}${scan.engine === "smart" ? "Read by smart read." : "Read on this device."} Fix anything that is wrong; nothing is saved until you tap Save.</p>` : ""}
      <div class="chips">${types.map(([v, l]) => `<button type="button" class="chip ${v === type ? "on" : ""}" data-act="txn-type" data-id="${v}">${l}</button>`).join("")}</div>
      ${planSpend ? `<p class="hint">Paid from the plan ${planOf ? esc(planOf.icon + " " + planOf.name) : ""}. Amount, account and date are changed from the plan; remove the payment there to undo it.</p>` : ""}
      <label class="f">Amount (Rp)<input id="txn-amount" name="amount" inputmode="numeric" ${planSpend ? "" : "required"} placeholder="0" data-money value="${pre.amount ? num(pre.amount) : ""}" ${lock}></label>
      <label class="f">Description<input id="txn-desc" name="description" placeholder="e.g. Indomaret" value="${esc(pre.description || "")}"></label>
      <div class="two">
        <label class="f">Category<input id="txn-category" name="category" list="cat-list" required value="${esc(category)}" placeholder="Pick or type"></label>
        <label class="f">Account<select id="txn-account" name="account" ${lock}>${accountOptions(account, editing)}</select></label>
      </div>
      <datalist id="cat-list">${S.categories.map((c) => `<option value="${esc(c.name)}">`).join("")}</datalist>
      <label class="f">Date<input id="txn-date" name="date" type="date" value="${date}" min="${minDate()}" max="${editing && date > today() ? date : today()}" ${planSpend ? "disabled" : "required"}></label>
      ${minDate() && date < minDate() ? `<p class="hint">${esc(monthLabel(monthStart(date)))} is closed. Pick a date from ${esc(dateLabel(minDate()))}, or ask an owner to reopen the month.</p>` : ""}
      <div class="error"></div>
      <button class="pill" type="submit">${editing ? "Save changes" : "Save"}</button>
      ${many ? `<button class="pill ghost" type="button" data-act="scan-skip">Skip this row</button>` : ""}
      ${scan && scan.engine === "device" && !scan.saved ? `<button class="link" type="button" data-act="scan-smart">Not right? Try smart read (sends the photo to Google Gemini)</button>` : ""}
    </form>`);
  }

  // ------------------------------------------------------------ scan (photo -> ocr function -> review)
  const SCAN_MODES = [
    ["receipt", "Receipt", "One expense from a shop receipt."],
    ["payslip", "Payslip", "Your net take-home pay, saved as income."],
    ["history", "History", "A screenshot of a transaction list. You review each row."],
  ];

  function sheetScan(mode = "receipt") {
    if (!activeAccounts().length) return sheetAccount();
    openSheet("Scan", `<div class="scan" id="scan" data-mode="${mode}">
      <div class="chips">${SCAN_MODES.map(([v, l]) => `<button type="button" class="chip ${v === mode ? "on" : ""}" data-act="scan-mode" data-id="${v}">${l}</button>`).join("")}</div>
      <p class="hint" id="scan-hint">${SCAN_MODES.find((m) => m[0] === mode)[2]}</p>
      <label class="pill scan-pick">${icon("camera")} Take a photo<input type="file" accept="image/*" capture="environment" data-scan hidden></label>
      <label class="pill ghost scan-pick">${icon("image")} Choose from gallery<input type="file" accept="image/*" data-scan hidden></label>
      <p class="hint">Read on this device. Your photo is not uploaded.</p>
      <div class="scan-busy" id="scan-busy" hidden><span class="spinner"></span> <span id="scan-busy-text">Reading your photo…</span></div>
      <div class="scan-load" id="scan-load" hidden>
        <div class="scan-thumb"><img id="scan-thumb" alt="The photo being read"><i class="scan-line" aria-hidden="true"></i></div>
        <p class="scan-step" id="scan-step" role="status" aria-live="polite"></p>
        <p class="hint" id="scan-note"></p>
        <button class="pill ghost" type="button" data-act="scan-cancel">Cancel</button>
        <p class="hint">Cancelling only stops the wait. The scan may still count towards today's limit.</p>
      </div>
      <div class="error"></div>
      <button class="pill dark" type="button" id="scan-smart" data-act="scan-smart" hidden>Try smart read</button>
      <p class="hint" id="scan-smart-hint" hidden>Smart read sends this photo to Google Gemini.</p>
      <button class="link" type="button" data-act="add">Type it in instead</button>
    </div>`);
  }

  // Shrink the photo so reading is quick; returns a JPEG Blob.
  async function shrinkImage(file, maxSide = 2000) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("That file could not be opened as a photo."));
        el.src = url;
      });
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; // transparent PNG screenshots would turn black in JPEG
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return await new Promise((resolve, reject) =>
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not prepare that photo."))), "image/jpeg", 0.85));
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // On-device reader: PaddleOCR in a background worker (ocr-worker.js). No upload, no key.
  let ocrWorker = null;
  const ocrJobs = new Map();
  function readTextOnDevice(buffer) {
    if (!ocrWorker) {
      ocrWorker = new Worker("ocr-worker.js", { type: "module" });
      ocrWorker.onmessage = (ev) => {
        const job = ocrJobs.get(ev.data.id);
        if (!job) return;
        ocrJobs.delete(ev.data.id);
        clearTimeout(job.timer);
        if (ev.data.error) job.reject(new Error(ev.data.error)); else job.resolve(ev.data.lines);
      };
      ocrWorker.onerror = () => { // the worker could not start (offline on first use, or an old browser)
        ocrJobs.forEach((job) => { clearTimeout(job.timer); job.reject(new Error("The on-device reader could not start.")); });
        ocrJobs.clear();
        ocrWorker.terminate();
        ocrWorker = null;
      };
    }
    return new Promise((resolve, reject) => {
      const id = Date.now() + Math.random();
      const timer = setTimeout(() => { ocrJobs.delete(id); reject(new Error("Reading took too long.")); }, 90000);
      ocrJobs.set(id, { resolve, reject, timer });
      ocrWorker.postMessage({ id, image: buffer }, [buffer]);
    });
  }

  // Past entries teach the category: "Indomaret" was Groceries last time, so it is again.
  const scanContext = () => ({
    categories: S.categories.map((c) => c.name),
    history: S.txns.filter((t) => !t.type.startsWith("transfer") && t.category_id).slice(0, 3000)
      .map((t) => ({ description: t.description, category: categoryName(t.category_id) })),
  });

  // Smart read: the photo goes to the "ocr" function, which asks Google Gemini.
  async function readSmart(blob, mode) {
    const image = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(new Error("Could not prepare that photo."));
      reader.readAsDataURL(blob);
    });
    const { data, error } = await sb.functions.invoke("ocr", {
      body: { mode, image, mime: "image/jpeg", categories: S.categories.map((c) => c.name) },
    });
    if (error) {
      let message = "";
      try { message = (await error.context.json()).error; } catch { /* no JSON body */ }
      throw new Error(message || "Smart read is not set up (the ocr function is not deployed).");
    }
    return data?.rows || [];
  }

  let scanPhoto = null; // { blob, mode } of the last photo, kept for a smart-read retry
  let scanLoad = null; // the smart-read loading panel while one is showing

  const SMART_SLOW_S = 15, SMART_TIMEOUT_S = 45;
  // Loading panel for a smart read: photo preview with a scan line, the current step, seconds waited,
  // a note when it is slow, and Cancel. `stopped` rejects on Cancel, on timeout or when the sheet is closed.
  function startSmartLoading(box) {
    const panel = $("#scan-load", box), stepEl = $("#scan-step", box), note = $("#scan-note", box), img = $("#scan-thumb", box);
    let timer = null, reject;
    const stopped = new Promise((_, rej) => { reject = rej; });
    stopped.catch(() => {}); // settled on its own when nothing is racing it
    box.classList.add("loading");
    panel.hidden = false;
    note.textContent = "";
    img.removeAttribute("src");
    const api = {
      stopped,
      step(text) { stepEl.textContent = text; },
      thumb(blob) {
        if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
        img.dataset.url = URL.createObjectURL(blob);
        img.src = img.dataset.url;
      },
      // "Asking Gemini… 7s", with a note once it is slow and a stop at the timeout
      wait(text) {
        const t0 = Date.now();
        const tick = () => {
          if (!box.isConnected) return api.cancel();
          const s = Math.floor((Date.now() - t0) / 1000);
          stepEl.textContent = `${text}… ${s}s`;
          if (s >= SMART_TIMEOUT_S) reject(new Error("Gemini did not answer in time. Try again."));
          else if (s >= SMART_SLOW_S) note.textContent = "Taking longer than usual. Large or blurry photos can be slow.";
        };
        tick();
        timer = setInterval(tick, 1000);
      },
      cancel() { reject(Object.assign(new Error("Cancelled"), { cancelled: true })); },
      end() {
        clearInterval(timer);
        if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
        if (box.isConnected) { box.classList.remove("loading"); panel.hidden = true; }
      },
    };
    return api;
  }

  // engine: "device" (default) or "smart". `file` is a new photo; without it the last photo is re-read.
  async function runScan(file, engine = "device") {
    const box = $("#scan");
    const errEl = $(".error", sheetRoot);
    const busy = (on, text) => {
      if (box) { box.classList.toggle("busy", on); $("#scan-busy", box).hidden = !on; if (text) $("#scan-busy-text", box).textContent = text; }
      else if (on) toast(text);
    };
    const offerSmart = (show) => {
      if (!box) return;
      $("#scan-smart", box).hidden = !show;
      $("#scan-smart-hint", box).hidden = !show;
    };
    if (scanLoad) return; // a smart read is already running
    if (errEl) errEl.textContent = "";
    offerSmart(false);
    const load = engine === "smart" && box ? startSmartLoading(box) : null;
    scanLoad = load;
    try {
      if (file) scanPhoto = { blob: null, mode: box.dataset.mode, file };
      if (!scanPhoto) return;
      if (load) load.step("Preparing the photo…");
      else busy(true, engine === "smart" ? "Smart read in progress…" : "Reading on this device… the first scan takes longer.");
      if (!scanPhoto.blob) scanPhoto.blob = await shrinkImage(scanPhoto.file);
      const { blob, mode } = scanPhoto;
      let rows;
      if (engine === "smart") {
        if (!navigator.onLine) throw new Error("Smart read needs a connection.");
        if (load) {
          load.thumb(blob);
          load.wait("Asking Gemini");
          rows = await Promise.race([readSmart(blob, mode), load.stopped]);
        } else rows = await readSmart(blob, mode);
      } else {
        const lines = await readTextOnDevice(await blob.arrayBuffer());
        rows = window.ReceiptParser.parse(mode, lines, scanContext());
      }
      if (box && $("#scan") !== box) return; // the sheet was closed while reading
      if (!rows.length) {
        throw new Error(engine === "smart" ? "Nothing readable was found. Try a sharper, well-lit photo."
          : mode === "payslip" ? "I could not find the take-home pay on this photo."
          : mode === "history" ? "I could not find any transaction rows on this photo."
          : "I could not find the total on this photo.");
      }
      S.scan = { rows, index: 0, saved: 0, engine };
      scanReview();
    } catch (e) {
      if (box && $("#scan") !== box) return;
      const message = e.cancelled ? "" : e.message || "Could not read that photo.";
      if ($("#scan")) { $(".error", sheetRoot).textContent = message; offerSmart(!!scanPhoto?.blob); }
      else toast(message);
    } finally {
      load?.end();
      scanLoad = null;
      busy(false);
    }
  }

  function scanReview() {
    const scan = S.scan, row = scan.rows[scan.index];
    sheetAdd(row.type, row, scan);
  }

  // Move to the next scanned row, or finish and refresh when there are none left.
  async function scanNext(saved) {
    const scan = S.scan;
    if (saved) scan.saved += 1;
    scan.index += 1;
    if (scan.index < scan.rows.length) {
      scanReview();
      return toast(saved ? "Saved" : "Skipped");
    }
    S.scan = null;
    closeSheet();
    if (scan.saved) await reload(`${scan.saved} saved from your photo`);
    else toast("Nothing saved");
  }

  function sheetTransfer() {
    if (activeAccounts().length < 2) return toast("Add a second account first");
    const a = activeAccounts();
    openSheet("Transfer", `<form data-form="transfer">
      <div class="two">
        <label class="f">From<select id="tr-from" name="from">${accountOptions(a[0].id)}</select></label>
        <label class="f">To<select id="tr-to" name="to">${accountOptions(a[1].id)}</select></label>
      </div>
      <label class="f">Amount (Rp)<input id="tr-amount" name="amount" inputmode="numeric" required placeholder="0" data-money></label>
      <label class="f">Note<input id="tr-note" name="note" placeholder="Optional"></label>
      <label class="f">Date<input id="tr-date" name="date" type="date" value="${today()}" min="${minDate()}" max="${today()}" required></label>
      <div class="error"></div>
      <button class="pill" type="submit">Transfer</button>
    </form>`);
  }

  function sheetTx(id) {
    const t = S.txns.find((x) => x.id === id);
    if (!t) return;
    const transfer = t.type.startsWith("transfer");
    openSheet(t.description || categoryName(t.category_id), `
      <div>
        <div class="list-row"><span class="grow">Amount</span><b class="num ${signed(t) < 0 ? "neg" : "pos"}">${rp(signed(t))}</b></div>
        <div class="list-row"><span class="grow">Type</span><span>${esc(t.type)}</span></div>
        <div class="list-row"><span class="grow">Category</span><span>${esc(transfer ? "Transfer" : categoryName(t.category_id))}</span></div>
        <div class="list-row"><span class="grow">Account</span><span>${esc(accountName(t.account_id))}</span></div>
        <div class="list-row"><span class="grow">Date</span><span>${esc(dateLabel(t.date))}</span></div>
        <div class="list-row"><span class="grow">Added from</span><span>${esc(t.source)}</span></div>
      </div>
      <div class="error"></div>
      ${isLocked(t.date)
        ? `<p class="hint">${icon("lock")} The books are closed through ${esc(monthLabel(latestClosed()))}, so this entry is locked. An owner can reopen the month in Settings → Monthly statements.</p>`
        : `${transfer ? "" : `<button class="pill" data-act="tx-edit" data-id="${t.id}">Edit</button>`}
      <button class="pill danger" data-act="tx-delete" data-id="${t.id}">${transfer ? "Delete both sides of this transfer" : "Delete transaction"}</button>`}`);
  }

  function sheetAccount(id) {
    const a = S.accounts.find((x) => x.id === id);
    openSheet(a ? "Edit account" : "New account", `<form data-form="account">
      <input type="hidden" name="id" value="${a ? a.id : ""}">
      <label class="f">Name<input id="acc-name" name="name" required value="${esc(a?.name || "")}" placeholder="e.g. Tabungan"></label>
      <label class="f">Opening balance (Rp)<input id="acc-open" name="opening" inputmode="numeric" data-money value="${a ? num(a.opening_balance ?? 0) : ""}" placeholder="0"></label>
      <p class="hint">The opening balance is what the account held before you started tracking.</p>
      <div class="error"></div>
      <button class="pill" type="submit">Save</button>
      ${a ? `<button class="pill dark" type="button" data-act="account-archive" data-id="${a.id}">${a.archived ? "Restore account" : "Archive account"}</button>
        <p class="hint">Archiving hides the account from forms. Its history stays.</p>` : ""}
    </form>`);
  }

  function sheetSignOut() {
    openSheet("Sign out?", `<p class="hint">You will need to sign in again to see your accounts on this device.</p>
      <button class="pill danger" type="button" data-act="signout">Sign out</button>
      <button class="pill ghost" type="button" data-act="close">Cancel</button>`);
  }

  function sheetCategory(id) {
    const c = S.categories.find((x) => x.id === id);
    openSheet(c ? "Edit category" : "New category", `<form data-form="category">
      <input type="hidden" name="id" value="${c ? c.id : ""}">
      <label class="f">Name<input id="cat-name" name="name" required value="${esc(c?.name || "")}"></label>
      <div class="error"></div>
      <button class="pill" type="submit">Save</button>
      ${c ? `<button class="pill danger" type="button" data-act="category-delete" data-id="${c.id}">Delete category</button>
        <p class="hint">Transactions using it will show as "Other".</p>` : ""}
    </form>`);
  }

  function sheetMember() {
    openSheet("Add member", `<form data-form="member">
      <label class="f">Their email<input id="mem-email" name="email" type="email" required></label>
      <p class="hint">Invite them in the Supabase dashboard first (Authentication → Users), then add them here.</p>
      <div class="error"></div>
      <button class="pill" type="submit">Add to household</button>
    </form>`);
  }

  function sheetTelegram(code) {
    openSheet("Link Telegram", `
      <p class="hint">Open your Finance Tracker bot in Telegram and send it this message. The code works once and expires in 10 minutes.</p>
      <div class="code-box" id="tg-code">/link ${esc(code)}</div>
      <div class="error"></div>
      <button class="pill" type="button" data-act="telegram-copy">Copy message</button>
      <button class="pill ghost" type="button" data-act="telegram-done">I sent it</button>`);
  }

  function sheetHolding() {
    openSheet("Add holding", `<form data-form="holding">
      <input type="hidden" name="asset" id="hold-asset" value="stock">
      <div class="chips">
        <button type="button" class="chip on" data-act="asset" data-id="stock">Stock</button>
        <button type="button" class="chip" data-act="asset" data-id="gold">Gold</button>
      </div>
      <div class="two">
        <label class="f"><span id="hold-ticker-label">Ticker</span><input id="hold-ticker" name="ticker" required placeholder="BBCA" autocapitalize="characters"></label>
        <label class="f"><span id="hold-name-label">Name</span><input id="hold-name" name="name" placeholder="Bank Central Asia"></label>
      </div>
      <div class="two">
        <label class="f"><span id="hold-qty-label">Shares</span><input id="hold-qty" name="qty" inputmode="decimal" required placeholder="0"></label>
        <label class="f"><span id="hold-price-label">Price per share (Rp)</span><input id="hold-price" name="price" inputmode="numeric" data-money required placeholder="0"></label>
      </div>
      <div class="two">
        <label class="f">Buy date<input id="hold-date" name="date" type="date" value="${today()}" max="${today()}" required></label>
        <label class="f">Paid from<select id="hold-account" name="account">${accountOptions("", true)}</select></label>
      </div>
      <p class="hint">Choosing an account also records the purchase as an invest transaction.</p>
      <div class="error"></div>
      <button class="pill" type="submit">Save holding</button>
    </form>`);
  }

  function sheetPosition(index) {
    const p = positions()[index];
    if (!p) return;
    const unit = p.asset_type === "gold" ? "grams" : "shares";
    openSheet(`Sell ${p.name || p.ticker}`, `<form data-form="sell">
      <input type="hidden" name="ticker" value="${esc(p.ticker)}"><input type="hidden" name="name" value="${esc(p.name)}">
      <p class="hint">You hold ${qtyFmt(p.qty)} ${unit} at an average of ${rp(p.avg)}. Oldest lots are sold first.</p>
      <div class="two">
        <label class="f">Quantity (${unit})<input id="sell-qty" name="qty" inputmode="decimal" required placeholder="0"></label>
        <label class="f">Sell price (Rp)<input id="sell-price" name="price" inputmode="numeric" data-money required value="${p.price ? num(p.price) : ""}" placeholder="0"></label>
      </div>
      <div class="two">
        <label class="f">Proceeds go to<select id="sell-account" name="account">${accountOptions("", true)}</select></label>
        <label class="f">Date<input id="sell-date" name="date" type="date" value="${today()}" min="${minDate()}" max="${today()}" required></label>
      </div>
      <div class="error"></div>
      <button class="pill" type="submit">Sell</button>
      <button class="pill danger" type="button" data-act="position-delete" data-id="${index}">Delete ${esc(p.name || p.ticker)}</button>
      <p class="hint">Delete is for mistakes: it removes ${p.lots > 1 ? `all ${p.lots} lots` : "the holding"} without recording a sale. Any invest transaction stays; delete that from Transactions if needed.</p>
    </form>`);
  }

  // ------------------------------------------------------------ plan sheets
  const PLAN_ICONS = ["🎯", "💻", "💍", "🏠", "🚗", "✈️", "🎓", "🏥", "👶", "🕌", "📱", "🛡️"];

  function sheetPlan(id) {
    const p = S.plans.find((x) => x.id === id);
    if (!p) return;
    const st = planStats(p);
    const cell = (name, value) => `<div><span>${name}</span><b class="num">${value}</b></div>`;
    const running = p.status === "active" && st.status !== "achieved";
    const ENTRY = { deposit: "Added money", withdrawal: "Taken out", adjustment: "Adjustment", asset_in: "Assigned", asset_out: "Released", spend: "Paid from plan" };
    const LEDGER_PREVIEW = 6; // newest entries shown at first; the rest sit behind "Show all"
    const ledgerRows = st.entries.map((c) => {
      const asset = c.entry_type === "asset_in" || c.entry_type === "asset_out";
      const dir = c.entry_type === "asset_out" || c.amount < 0 ? -1 : c.entry_type === "asset_in" || c.amount > 0 ? 1 : 0;
      const what = asset ? ` ${esc(qtyLabel(c.asset_type, c.quantity))} ${esc(c.asset_name || c.ticker)}` : "";
      const badge = asset ? (c.asset_type === "gold" ? "gold" : "stats")
        : c.entry_type === "deposit" ? "arrowIn" : c.entry_type === "withdrawal" ? "arrowOut" : "wallet";
      const tone = asset ? "gold" : c.entry_type === "deposit" ? "in" : c.entry_type === "withdrawal" ? "xfer" : "out";
      const meta = [{ cls: "when", html: esc(dateLabel(c.date)) }];
      if (c.note) meta.push({ cls: "cat", html: esc(c.note) });
      const spend = c.entry_type === "spend";
      const paidFrom = spend ? S.txns.find((t) => t.id === c.transaction_id) : null;
      if (spend) meta.push({ cls: "acct", html: esc(paidFrom ? accountName(paidFrom.account_id) : "An expense") });
      else if (c.transaction_id) meta.push({ cls: "cat", html: "Linked to a transaction" });
      return entRow({
        badge, tone, title: `${ENTRY[c.entry_type]}${what}`, meta, dir,
        amount: `${dir < 0 ? "−" : dir > 0 ? "+" : ""}${num(Math.abs(c.amount))}`,
        action: isLocked(c.date) ? icon("lock") : asset ? ""
          : spend ? `<button class="chip-act" data-act="spend-delete" data-id="${c.id}">Remove</button>`
          : `<button class="chip-act" data-act="contribution-delete" data-id="${c.id}">Remove</button>`,
      });
    });
    const contribs = !ledgerRows.length ? `<div class="empty">No money added yet.</div>`
      : ledgerRows.slice(0, LEDGER_PREVIEW).join("") + (ledgerRows.length > LEDGER_PREVIEW
        ? `<div class="ent-more" hidden>${ledgerRows.slice(LEDGER_PREVIEW).join("")}</div>
           <button class="pill ghost-light show-more" type="button" data-act="ledger-more" data-all="Show all ${ledgerRows.length} transactions" data-less="Show fewer">Show all ${ledgerRows.length} transactions</button>`
        : "");
    const heldRows = st.assets.map((a) => {
      const gain = a.value === null ? 0 : a.value - a.cost;
      const meta = [{ cls: "cat", html: esc(qtyLabel(a.lot.asset_type, a.qty)) },
        a.value === null ? { cls: "acct", html: "at cost" }
          : { cls: `acct ${gain < 0 ? "neg" : "pos"}`, html: `${gain < 0 ? "−" : "+"}${num(Math.abs(gain))}` }];
      return entRow({
        badge: a.lot.asset_type === "gold" ? "gold" : "stats", tone: "gold", title: esc(a.lot.name || a.lot.ticker), meta,
        amount: num(a.value ?? a.cost),
        action: p.status === "cancelled" ? "" : `<button class="chip-act" data-act="plan-release" data-plan="${p.id}" data-id="${a.id}">Release</button>`,
      });
    }).join("");
    const acct = p.account_id ? S.accounts.find((a) => a.id === p.account_id) : null;
    const statusBtns = {
      active: [["paused", "Pause"], ["achieved", "Mark achieved"], ["cancelled", "Cancel plan"]],
      paused: [["active", "Resume"], ["cancelled", "Cancel plan"]],
      achieved: [["active", "Back to active"]],
      cancelled: [["active", "Resume"]],
    }[p.status];
    const STATUS_ICON = { paused: "pause", achieved: "check", active: "resume", cancelled: "close" };
    const statusBtn = ([to, label]) => `<button class="pill ${to === "cancelled" ? "danger" : "ghost-light"}" type="button"
        data-act="plan-status" data-id="${p.id}" data-to="${to}">${icon(STATUS_ICON[to])}<span>${label}</span></button>`;
    const safeBtns = statusBtns.filter(([to]) => to !== "cancelled").map(statusBtn).join("");
    const dangerBtns = statusBtns.filter(([to]) => to === "cancelled").map(statusBtn).join("");
    const lead = st.status === "achieved" ? `Reached ${rp(st.saved)}${p.achieved_at ? ` on ${esc(fullDate(p.achieved_at))}` : ""}.`
      : st.status === "overdue" ? `The target date has passed with ${rp(st.remaining)} still to go. Move the date or add money.`
      : st.status === "behind" ? `By now it should be about ${rp(st.expected)}. Putting in ${rp(st.monthly)} a month still gets there.`
      : st.status === "paused" ? "Paused: no reminders until you resume it."
      : st.status === "cancelled" ? `Cancelled${st.closedAt != null ? ` at ${Number(st.closedAt).toLocaleString("id-ID")}%` : ""}. Its history is kept.${st.spent ? ` ${rp(st.spent)} was already paid from it and stays as expenses.` : ""}`
      : `Putting in ${rp(st.monthly)} a month reaches the target by ${esc(fullDate(p.target_date))}.`;
    openSheet(`${p.icon} ${p.name}`, `<div class="plan-detail">
      <div class="row between"><b class="num plan-pct">${Math.round(st.progress * 100)}%</b>${planTag(st)}</div>
      ${planBar(st)}
      <p class="hint" style="margin:0">${lead}</p>
      <div class="st-grid">
        ${cell("Saved", rp(st.saved))}${cell("Target", rp(st.target))}
        ${st.assets.length || st.spent ? cell("Cash", rp(st.cash)) : ""}
        ${st.spent ? cell("Paid from plan", rp(st.spent)) : ""}
        ${st.assets.length ? cell(st.live ? "Gold and stocks (live)" : "Gold and stocks (at cost)", rp(st.assetValue)) : ""}
        ${cell("Remaining", rp(st.remaining))}${cell("Needed / month", running ? rp(st.monthly) : "–")}
        ${cell("Target date", esc(fullDate(p.target_date)))}${cell(st.daysLeft >= 0 ? "Time left" : "Overdue by",
          st.daysLeft >= 0 ? `${st.monthsLeft} month${st.monthsLeft === 1 ? "" : "s"}` : `${-st.daysLeft} day${st.daysLeft === -1 ? "" : "s"}`)}
      </div>
      ${p.account_id ? `<p class="hint" style="margin:0">Kept in ${esc(accountName(p.account_id))}${S.plansLedger && acct ? ` (${rp(acct.balance - earmarkOf(acct.id))} free to spend)` : ""}. Started ${esc(fullDate(p.start_date))}.</p>`
        : `<p class="hint" style="margin:0">Started ${esc(fullDate(p.start_date))}.</p>`}
      ${p.note ? `<p class="hint" style="margin:0">${esc(p.note)}</p>` : ""}
      <div class="chart-box" style="height:180px"><canvas id="plan-chart" aria-label="Saved over time against the plan"></canvas></div>
      <div class="error"></div>
      ${p.status === "cancelled" ? "" : `<div class="plan-actions quick">
        <button class="pill" type="button" data-act="plan-money" data-id="${p.id}">${icon("plus")}<span>Add money</span></button>
        ${S.plansLedger ? `<button class="pill ghost-light" type="button" data-act="plan-spend" data-id="${p.id}">${icon("wallet")}<span>Pay from plan</span></button>
        <button class="pill ghost-light" type="button" data-act="plan-withdraw" data-id="${p.id}">${icon("arrowOut")}<span>Take out</span></button>
        <button class="pill ghost-light" type="button" data-act="plan-assign" data-id="${p.id}">${icon("gold")}<span>Gold or stock</span></button>` : ""}
      </div>`}
      ${(p.status === "achieved" || p.status === "cancelled") && S.plansLedger && (st.cash > 0 || st.assets.length)
        ? `<p class="hint" style="margin:0">${st.cash > 0 ? `${rp(st.cash)} is still ${p.status === "cancelled" ? "in" : "set aside for"} this plan` : ""}${st.cash > 0 && st.assets.length ? " and " : ""}${st.assets.length ? `${st.assets.length} holding${st.assets.length === 1 ? " is" : "s are"} still assigned` : ""}.</p>
        <button class="pill ghost-light" type="button" data-act="plan-closeout" data-id="${p.id}">${icon("arrowOut")}<span>Release what is left</span></button>` : ""}
      ${heldRows ? `<div class="section-label">Gold and stocks</div><div class="ent-list">${heldRows}</div>` : ""}
      <div class="section-label">Ledger</div>
      <div class="ent-list">${contribs}</div>
      <div class="section-label">Plan</div>
      <div class="plan-actions quick">
        <button class="pill ghost-light" type="button" data-act="plan-edit" data-id="${p.id}">${icon("pencil")}<span>Edit</span></button>
        ${safeBtns}
      </div>
      <div class="plan-actions">
        ${dangerBtns}
        ${st.entries.length || st.assets.length ? "" : `<button class="pill danger" type="button" data-act="plan-delete" data-id="${p.id}">${icon("trash")}<span>Delete plan</span></button>`}
      </div>
    </div>`);
    drawPlanChart(p, st);
  }

  // Saved at the end of each month against the straight line from start to target.
  function drawPlanChart(p, st) {
    const el = $("#plan-chart");
    if (!window.Chart || !el) return;
    const first = monthStart(st.entries.reduce((d, c) => (c.date < d ? c.date : d), p.start_date));
    const lastM = monthStart(p.target_date > today() ? p.target_date : today());
    const months = [];
    for (let m = first; m <= lastM && months.length < 120; m = addMonths(m, 1)) months.push(m);
    const end = (m) => shiftDay(addMonths(m, 1), -1);
    const total = Math.max(daysBetween(p.start_date, p.target_date), 1);
    const line = (m) => {
      const e = end(m) < p.target_date ? end(m) : p.target_date;
      return Math.round((st.target * Math.min(Math.max(daysBetween(p.start_date, e), 0), total)) / total);
    };
    const savedBy = (m) => (end(m) > today() && m > monthStart(today()) ? null
      : st.entries.filter((c) => c.date <= end(m)).reduce((s, c) => s + flowOf(c), 0)); // gold and stocks at the price recorded when assigned
    charts.push(new Chart(el, {
      type: "line",
      data: {
        labels: months.map((m) => new Date(m + "T00:00:00").toLocaleDateString("id-ID", { month: "short", year: "2-digit" })),
        datasets: [
          { label: "Saved", data: months.map(savedBy), borderColor: "#f0899f", backgroundColor: "rgba(240, 137, 159, 0.16)", pointBackgroundColor: "#f0899f", fill: true, tension: 0.25, pointRadius: 2, spanGaps: false },
          { label: "Plan", data: months.map(line), borderColor: "rgba(255, 255, 255, 0.55)", borderDash: [5, 4], pointRadius: 0, fill: false },
        ],
      },
      options: {
        maintainAspectRatio: false, animation: reducedMotion() ? false : undefined,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { labels: { color: "rgba(255, 255, 255, 0.85)", boxWidth: 10, boxHeight: 10, font: { size: 11 } } },
                   tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${rp(c.parsed.y)}` } } },
        scales: { x: { ticks: { color: "rgba(255, 255, 255, 0.6)", maxTicksLimit: 6 }, grid: { display: false } },
                  y: { beginAtZero: true, ticks: { color: "rgba(255, 255, 255, 0.6)", callback: (v) => compact(v) }, grid: { color: "rgba(255, 255, 255, 0.1)" } } },
      },
    }));
  }

  function sheetPlanForm(id) {
    const p = S.plans.find((x) => x.id === id);
    const icon0 = p?.icon || PLAN_ICONS[0];
    const tomorrow = shiftDay(today(), 1);
    openSheet(p ? "Edit plan" : "New plan", `<form data-form="plan">
      <input type="hidden" name="id" value="${p ? p.id : ""}">
      <input type="hidden" id="plan-icon" name="icon" value="${esc(icon0)}">
      <div class="chips icon-chips" role="group" aria-label="Icon">${PLAN_ICONS.map((e) =>
        `<button type="button" class="chip ${e === icon0 ? "on" : ""}" data-act="plan-icon" data-id="${e}" aria-label="Icon ${e}">${e}</button>`).join("")}</div>
      <label class="f">Name<input id="plan-name" name="name" required maxlength="60" value="${esc(p?.name || "")}" placeholder="e.g. Buy laptop"></label>
      <div class="two">
        <label class="f">Target (Rp)<input id="plan-target" name="target" inputmode="numeric" data-money required value="${p ? num(p.target_amount) : ""}" placeholder="0"></label>
        <label class="f">Target date<input id="plan-date" name="target_date" type="date" required value="${p?.target_date || ""}" ${p ? "" : `min="${tomorrow}"`}></label>
      </div>
      <div class="two">
        <label class="f">Start date<input id="plan-start" name="start_date" type="date" required value="${p?.start_date || today()}"></label>
        <label class="f">Kept in<select id="plan-account" name="account">${accountOptions(p?.account_id || "", true)}</select></label>
      </div>
      <label class="f">Note (optional)<input id="plan-note" name="note" value="${esc(p?.note || "")}" placeholder="Anything worth remembering"></label>
      <p class="hint">Progress is measured against a straight line from the start date to the target date.</p>
      <div class="error"></div>
      <button class="pill" type="submit">${p ? "Save" : "Create plan"}</button>
    </form>`);
  }

  // Money into a plan. It can point at an existing income or transfer-in
  // transaction (e.g. a move into the savings account); each one funds one plan.
  function sheetContribution(planId) {
    const p = S.plans.find((x) => x.id === planId);
    if (!p) return;
    const used = new Set(S.ledger.map((c) => c.transaction_id).filter(Boolean));
    const linkable = S.txns.filter((t) => (t.type === "transfer-in" || t.type === "income") && !used.has(t.id) && !isLocked(t.date))
      .sort((a, b) => (b.account_id === p.account_id) - (a.account_id === p.account_id) || b.date.localeCompare(a.date))
      .slice(0, 40);
    openSheet(`Add money to ${p.name}`, `<form data-form="contribution">
      <input type="hidden" name="plan" value="${p.id}">
      ${linkable.length ? `<label class="f">From a transaction (optional)<select id="ctr-tx" name="transaction">
        <option value="">None, just record the amount</option>
        ${linkable.map((t) => `<option value="${t.id}" data-amount="${t.amount}" data-date="${t.date}">${esc(dateLabel(t.date))} · ${esc(t.description || categoryName(t.category_id))} · ${esc(accountName(t.account_id))} · ${rp(t.amount)}</option>`).join("")}
      </select></label>` : ""}
      <div class="two">
        <label class="f">Amount (Rp)<input id="ctr-amount" name="amount" inputmode="numeric" data-money required placeholder="0"></label>
        <label class="f">Date<input id="ctr-date" name="date" type="date" required value="${today()}" min="${minDate()}" max="${today()}"></label>
      </div>
      <label class="f">Note (optional)<input id="ctr-note" name="note" placeholder="e.g. Bonus November"></label>
      <p class="hint">This records money set aside for the plan. It does not move money between accounts; use Transfer for that.</p>
      <div class="error"></div>
      <button class="pill" type="submit">Add money</button>
    </form>`);
  }

  // Money leaving a plan (for example when it is spent). It records the movement
  // in the plan; the spending itself is a normal expense on the account.
  function sheetWithdraw(planId) {
    const p = S.plans.find((x) => x.id === planId);
    if (!p) return;
    const cash = planStats(p).cash;
    openSheet(`Take money out of ${p.name}`, `<form data-form="withdraw">
      <input type="hidden" name="plan" value="${p.id}">
      <p class="hint" style="margin-top:0">${rp(cash)} cash is in this plan.</p>
      <div class="two">
        <label class="f">Amount (Rp)<input id="wd-amount" name="amount" inputmode="numeric" data-money required placeholder="0"></label>
        <label class="f">Date<input id="wd-date" name="date" type="date" required value="${today()}" min="${minDate()}" max="${today()}"></label>
      </div>
      <label class="f">Note (optional)<input id="wd-note" name="note" placeholder="e.g. Paid the dentist"></label>
      <p class="hint">This frees the money from the plan. It does not move money between accounts or record an expense.</p>
      <div class="error"></div>
      <button class="pill" type="submit">Take out</button>
    </form>`);
  }

  // Pay for something from a plan: a real expense on an account, and the same amount out of the
  // plan's cash. The plan keeps its progress (saved = cash + gold and stocks + paid from plan).
  function sheetSpend(planId) {
    const p = S.plans.find((x) => x.id === planId);
    if (!p) return;
    const cash = planStats(p).cash;
    if (cash <= 0) {
      openSheet("Pay from plan", `<div class="empty">This plan has no cash to pay from. Add money, or sell gold or stocks into it first.</div>`);
      return;
    }
    openSheet(`Pay from ${p.name}`, `<form data-form="spend">
      <input type="hidden" name="plan" value="${p.id}">
      <p class="hint" style="margin-top:0">${rp(cash)} cash is in this plan. The payment is saved as an expense, and the plan keeps its progress.</p>
      <div class="two">
        <label class="f">Amount (Rp)<input id="sp-amount" name="amount" inputmode="numeric" data-money required placeholder="0"></label>
        <label class="f">Paid from account<select id="sp-account" name="account">${accountOptions(p.account_id || store.get("ft.lastAccount", ""))}</select></label>
      </div>
      <div class="two">
        <label class="f">Category<input id="sp-category" name="category" list="cat-list" required placeholder="Pick or type"></label>
        <label class="f">Date<input id="sp-date" name="date" type="date" required value="${today()}" min="${minDate()}" max="${today()}"></label>
      </div>
      <datalist id="cat-list">${S.categories.map((c) => `<option value="${esc(c.name)}">`).join("")}</datalist>
      <label class="f">Note (optional)<input id="sp-note" name="note" placeholder="e.g. Down payment to the vendor"></label>
      ${p.account_id ? `<p class="hint">${esc(accountName(p.account_id))} is where this plan is kept. Paying from it keeps its free to spend the same; another account will change it.</p>` : ""}
      <div class="error"></div>
      <button class="pill" type="submit">Pay</button>
    </form>`);
  }

  // Achieved or cancelled: offer to release what is still tied to the plan. Nothing is released
  // unless it is ticked, and the status change goes ahead either way. `to` is "achieved",
  // "cancelled", or null to only release what is left of a plan that is already closed.
  function sheetClosePlan(planId, to) {
    const p = S.plans.find((x) => x.id === planId);
    if (!p) return;
    const st = planStats(p);
    const cancel = to === "cancelled";
    const on = cancel || !to ? "checked" : ""; // release is pre-ticked when cancelling, kept when marking achieved
    const rows = [];
    if (st.cash > 0) {
      rows.push(`<label class="list-row switch-row"><span class="grow">Release ${rp(st.cash)} cash<small>Frees it from the set-aside${p.account_id ? ` on ${esc(accountName(p.account_id))}` : ""}. No money moves.</small></span>
        <input type="checkbox" class="switch" name="cash" ${on} aria-label="Release the cash"></label>`);
    }
    st.assets.forEach((a) => rows.push(`<label class="list-row switch-row"><span class="grow">Release ${esc(qtyLabel(a.lot.asset_type, a.qty))} ${esc(a.lot.name || a.lot.ticker)}<small>Worth ${rp(a.value ?? a.cost)}. It stays in your portfolio.</small></span>
        <input type="checkbox" class="switch" name="asset" value="${a.id}" ${on} aria-label="Release ${esc(a.lot.name || a.lot.ticker)}"></label>`));
    const title = cancel ? `Cancel ${p.name}` : to === "achieved" ? `Mark ${p.name} achieved` : `Release from ${p.name}`;
    openSheet(title, `<form data-form="closeplan">
      <input type="hidden" name="plan" value="${p.id}">
      <input type="hidden" name="to" value="${to || ""}">
      <p class="hint" style="margin-top:0">${rows.length ? "Still tied to this plan. Choose what to release." : "Nothing is tied to this plan any more."}${cancel ? ` It stops at ${Math.round(st.progress * 1000) / 10}% of its target.` : ""}</p>
      ${rows.join("")}
      <div class="error"></div>
      <button class="pill ${cancel ? "danger" : ""}" type="submit">${cancel ? "Cancel plan" : to === "achieved" ? "Mark achieved" : "Release"}</button>
    </form>`);
  }

  // Earmark gold or stocks you already hold for a plan. They count towards its
  // total at the live price; the lots stay in your portfolio.
  function sheetAssign(planId) {
    const p = S.plans.find((x) => x.id === planId);
    if (!p) return;
    const lots = S.holdings.map((h) => ({ h, free: lotFree(h) })).filter((x) => x.free > 0);
    if (!lots.length) {
      openSheet("Add gold or stock", `<div class="empty">Nothing free to assign. Buy gold or stocks in Portfolio first, or release some from another plan.</div>`);
      return;
    }
    openSheet(`Add gold or stock to ${p.name}`, `<form data-form="assign">
      <input type="hidden" name="plan" value="${p.id}">
      <label class="f">Which holding<select id="as-lot" name="holding">${lots.map(({ h, free }) =>
        `<option value="${h.id}" data-free="${free}">${esc(h.name || h.ticker)} · ${esc(qtyLabel(h.asset_type, free))} free · bought at ${rp(h.buy_price)}</option>`).join("")}</select></label>
      <div class="two">
        <label class="f">Quantity<input id="as-qty" name="qty" inputmode="decimal" required placeholder="e.g. 5"></label>
        <label class="f">Price now (optional)<input id="as-price" name="price" inputmode="numeric" data-money placeholder="live price"></label>
      </div>
      <label class="f">Date<input id="as-date" name="date" type="date" required value="${today()}" min="${minDate()}" max="${today()}"></label>
      <p class="hint">Grams for gold, shares for stocks. The price is only recorded in the ledger; the plan's total follows the live price.</p>
      <div class="error"></div>
      <button class="pill" type="submit">Add to plan</button>
    </form>`);
  }

  // ------------------------------------------------------------ loan sheets
  const memberIds = () => (Object.keys(S.memberEmails).length ? Object.keys(S.memberEmails) : S.members.map((m) => m.user_id));

  function sheetLoanForm(id) {
    const l = S.loans.find((x) => x.id === id);
    if (!l && !activeAccounts().length) return sheetAccount();
    const pays = l ? loanPayments(l).length : 0;
    const frozen = !!l && (pays > 0 || isLocked(l.date)); // amount, date and account are fixed once money has moved or the month is closed
    const dis = frozen ? "disabled" : "";
    const me = S.session.user.id;
    openSheet(l ? "Edit loan" : "New loan", `<form data-form="loan">
      <input type="hidden" name="id" value="${l ? l.id : ""}">
      <label class="f">Who borrows it<select id="loan-borrower" name="borrower" required>${memberIds().map((u) =>
        `<option value="${u}" ${u === (l ? l.borrower_id : me) ? "selected" : ""}>${esc(memberName(u))}${u === me ? " (you)" : ""}</option>`).join("")}</select></label>
      <div class="two">
        <label class="f">Amount (Rp)<input id="loan-amount" name="amount" inputmode="numeric" data-money required placeholder="0" value="${l ? num(l.amount) : ""}" ${dis}></label>
        <label class="f">Lend from<select id="loan-account" name="account" ${dis}>${accountOptions(l?.account_id || store.get("ft.lastAccount", ""))}</select></label>
      </div>
      <div class="two">
        <label class="f">Date<input id="loan-date" name="date" type="date" required value="${l?.date || today()}" min="${l ? "" : minDate()}" max="${today()}" ${dis}></label>
        <label class="f">Due date (optional)<input id="loan-due" name="due_date" type="date" value="${l?.due_date || ""}"></label>
      </div>
      <label class="f">Note (optional)<input id="loan-note" name="note" value="${esc(l?.note || "")}" placeholder="Anything worth remembering"></label>
      ${frozen ? `<p class="hint">${icon("lock")} ${pays ? "This loan has repayments, so its amount, date and account are fixed." : "This month is closed, so the amount, date and account are fixed."} You can still change the rest.</p>`
        : `<p class="hint">The money leaves the account you pick. It is not counted as an expense, and the repayment will not count as income.</p>`}
      <div class="error"></div>
      <button class="pill" type="submit">${l ? "Save" : "Save loan"}</button>
    </form>`);
  }

  function sheetLoan(id) {
    const l = S.loans.find((x) => x.id === id);
    if (!l) return;
    const st = loanStats(l);
    const cell = (name, value, cls = "") => `<div><span>${name}</span><b class="num ${cls}">${value}</b></div>`;
    const pays = loanPayments(l).slice().sort((a, b) => b.date.localeCompare(a.date));
    const rows = pays.map((t) => {
      const meta = [{ cls: "when", html: esc(dateLabel(t.date)) }, { cls: "cat", html: `Into ${esc(accountName(t.account_id))}` }];
      if (t.description && / - /.test(t.description)) meta.push({ cls: "cat", html: esc(t.description.replace(/^Loan repayment from \S+ - /, "")) });
      return entRow({
        badge: "arrowIn", tone: "in", title: "Repayment", meta, dir: 1, amount: `+${num(t.amount)}`,
        action: isLocked(t.date) ? icon("lock") : `<button class="chip-act" data-act="loan-payment-delete" data-id="${t.id}">Remove</button>`,
      });
    }).join("") || `<div class="empty">No repayments yet.</div>`;
    const canDelete = !pays.length && !isLocked(l.date);
    const lead = st.paid ? "Fully repaid."
      : st.overdue ? `The due date (${esc(fullDate(l.due_date + "T00:00:00"))}) has passed with ${rp(st.outstanding)} still unpaid.`
      : l.due_date ? `Due ${esc(fullDate(l.due_date + "T00:00:00"))}.` : "No due date set. Pay it back in any amounts.";
    openSheet(`${memberName(l.borrower_id)}'s loan`, `<div class="plan-detail">
      <div class="row between"><b class="num plan-pct">${Math.round(st.progress * 100)}%</b>${st.paid ? `<span class="tag ok">Paid</span>` : st.overdue ? `<span class="tag due">Overdue</span>` : `<span class="tag">Open</span>`}</div>
      <span class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(st.progress * 100)}"><i style="width:${(st.progress * 100).toFixed(1)}%"></i></span>
      <p class="hint" style="margin:0">${lead}</p>
      <div class="st-grid">
        ${cell("Lent", rp(l.amount))}${cell("Outstanding", rp(st.outstanding), st.outstanding ? "neg" : "pos")}
        ${cell("Repaid", rp(st.repaid), "pos")}${cell("Borrower", esc(memberName(l.borrower_id)))}
        ${cell("Lent on", esc(fullDate(l.date + "T00:00:00")))}${cell("Lent from", esc(accountName(l.account_id)))}
      </div>
      ${l.note ? `<p class="hint" style="margin:0">${esc(l.note)}</p>` : ""}
      <div class="error"></div>
      ${st.paid ? "" : `<div class="plan-actions"><button class="pill" type="button" data-act="loan-pay" data-id="${l.id}">${icon("plus")} Record a repayment</button></div>`}
      <div class="section-label">Repayments</div>
      <div class="ent-list">${rows}</div>
      <div class="section-label">Loan</div>
      <div class="plan-actions">
        <button class="pill ghost-light" type="button" data-act="loan-edit" data-id="${l.id}">Edit</button>
        ${canDelete ? `<button class="pill danger" type="button" data-act="loan-delete" data-id="${l.id}">Delete loan</button>` : ""}
      </div>
      ${canDelete ? "" : `<p class="hint">${isLocked(l.date) ? "The month this loan was made in is closed, so it cannot be deleted." : "A loan with repayments cannot be deleted. Remove its repayments first."}</p>`}
    </div>`);
  }

  function sheetLoanPay(id) {
    const l = S.loans.find((x) => x.id === id);
    if (!l) return;
    const st = loanStats(l);
    if (!activeAccounts().length) return sheetAccount();
    openSheet("Record a repayment", `<form data-form="loanpay">
      <input type="hidden" name="loan" value="${l.id}">
      <p class="hint" style="margin-top:0">${rp(st.outstanding)} is still owed by ${esc(memberName(l.borrower_id))}.</p>
      <div class="two">
        <label class="f">Amount (Rp)<input id="lp-amount" name="amount" inputmode="numeric" data-money required value="${num(st.outstanding)}"></label>
        <label class="f">Paid into<select id="lp-account" name="account">${accountOptions(l.account_id || "")}</select></label>
      </div>
      <label class="f">Date<input id="lp-date" name="date" type="date" required value="${today()}" min="${[minDate(), l.date].sort().pop()}" max="${today()}"></label>
      <label class="f">Note (optional)<input id="lp-note" name="note" placeholder="e.g. Installment 1"></label>
      <p class="hint">This records money paid back into the account. It raises the account's balance and lowers the amount owed. It is not counted as income.</p>
      <div class="error"></div>
      <button class="pill" type="submit">Save repayment</button>
    </form>`);
  }

  // ------------------------------------------------------------ notification list
  function sheetNotifications() {
    const unread = unreadCount(), read = S.notifs.length - unread;
    const rows = S.notifs.map((n) => `<button class="notif ${n.read_at ? "" : "unread"}" data-act="notif" data-id="${n.id}">
        <span class="dot" aria-hidden="true"></span>
        <span class="grow"><b>${esc(n.title)}</b>${n.body ? `<small>${esc(n.body)}</small>` : ""}</span>
        <time datetime="${esc(n.created_at)}">${esc(timeAgo(n.created_at))}</time>
      </button>`).join("");
    openSheet("Notifications", `<div class="notif-list" id="notif-list">
      ${rows || `<div class="empty">Nothing yet. Plan milestones, deadlines and month-close reminders show up here.</div>`}
      ${S.notifs.length ? `<div class="row">
        ${unread ? `<button class="pill ghost-light" type="button" data-act="notifs-read">Mark all read</button>` : ""}
        ${read ? `<button class="pill ghost-light" type="button" data-act="notifs-clear">Clear read (${read})</button>` : ""}
      </div>` : ""}
      <p class="hint">Choose which kinds you get in Settings → Notifications.</p>
    </div>`);
  }

  // Follow a notification's link: 'plan:<id>' or 'statement:<YYYY-MM-01>'.
  function openNotifLink(link) {
    const [kind, id] = String(link || "").split(":");
    if (kind === "plan") {
      if (S.plans.some((p) => p.id === id)) return sheetPlan(id);
      closeSheet();
      return toast("That plan has been deleted");
    }
    if (kind === "statement" && id) return sheetStatement(id);
    if (kind === "loan") {
      if (S.loans.some((l) => l.id === id)) return sheetLoan(id);
      closeSheet();
      return toast("That loan has been deleted");
    }
    closeSheet();
  }

  // ------------------------------------------------------------ form handlers
  const forms = {
    async login(fd) {
      const email = fd.get("email").trim(), password = fd.get("password");
      if (!password) throw new Error("Enter your password.");
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    },

    async onboard(fd) {
      const accounts = fd.get("accounts").split("\n").map((s) => s.trim()).filter(Boolean);
      if (!accounts.length) throw new Error("Add at least one account.");
      check(await sb.rpc("create_household", { p_name: fd.get("name").trim(), p_accounts: accounts }));
      await start();
    },

    async txn(fd) {
      // an expense paid from a plan: only its category and description change here (amount, account and date belong to the plan)
      if (fd.get("id") && S.ledger.some((l) => l.entry_type === "spend" && l.transaction_id === fd.get("id"))) {
        const category = fd.get("category").trim() || "Other";
        check(await sb.from("transactions").update({
          description: fd.get("description").trim(), category_id: await categoryId(category),
        }).eq("id", fd.get("id")));
        closeSheet();
        return reload("Updated");
      }
      const amount = parseAmount(fd.get("amount"));
      if (amount <= 0) throw new Error("Enter an amount above zero.");
      const type = fd.get("type");
      const category = fd.get("category").trim() || "Other";
      const id = fd.get("id");
      if (id) { // editing a saved transaction: needs a connection, keeps its original source
        const changes = {
          date: fd.get("date"), type, description: fd.get("description").trim(), amount,
          account_id: fd.get("account") || null, category_id: await categoryId(category),
        };
        check(await sb.from("transactions").update(changes).eq("id", id));
        closeSheet();
        return reload("Updated");
      }
      const row = {
        household_id: S.household.id, date: fd.get("date"), type, description: fd.get("description").trim(),
        amount, source: fd.get("source") === "ocr" ? "ocr" : "web", account_id: fd.get("account") || null,
      };
      store.set("ft.lastAccount", row.account_id);
      const known = S.categories.find((c) => c.name.toLowerCase() === category.toLowerCase());
      try {
        row.category_id = known ? known.id : await categoryId(category);
        check(await sb.from("transactions").insert(row));
      } catch (e) {
        if (!isNetworkError(e)) throw e;
        row.category_id = known ? known.id : null;
        // a new category name is kept so it can be created when the entry syncs
        store.set("ft.queue", [{ ...row, _qid: Date.now(), ...(known ? {} : { _category: category }) }, ...queue()]);
        if (S.scan) { toast("Saved offline"); return scanNext(true); } // keep reviewing the other scanned rows
        closeSheet(); route();
        return toast("Saved offline. It will sync when you are back online.");
      }
      if (S.scan) return scanNext(true);
      closeSheet();
      await reload("Saved");
      // spending that cuts into money set aside for plans
      const acct = S.accounts.find((a) => a.id === row.account_id);
      if (acct && type !== "income" && earmarkOf(acct.id) > 0 && acct.balance < earmarkOf(acct.id)) {
        toast(`${acct.name} is now below the ${compact(earmarkOf(acct.id))} set aside for plans`);
      }
    },

    async transfer(fd) {
      const amount = parseAmount(fd.get("amount"));
      if (amount <= 0) throw new Error("Enter an amount above zero.");
      if (fd.get("from") === fd.get("to")) throw new Error("Choose two different accounts.");
      check(await sb.rpc("add_transfer", {
        p_household: S.household.id, p_from: fd.get("from"), p_to: fd.get("to"),
        p_amount: amount, p_date: fd.get("date"), p_note: fd.get("note").trim(), p_source: "web",
      }));
      closeSheet();
      await reload("Transfer saved");
    },

    async account(fd) {
      const name = fd.get("name").trim(), opening = parseAmount(fd.get("opening"));
      const id = fd.get("id");
      if (id) check(await sb.from("accounts").update({ name, opening_balance: opening }).eq("id", id));
      else check(await sb.from("accounts").insert({ household_id: S.household.id, name, opening_balance: opening, sort_order: S.accounts.length }));
      closeSheet();
      await reload(id ? "Account updated" : "Account added");
    },

    async category(fd) {
      const name = fd.get("name").trim(), id = fd.get("id");
      if (id) check(await sb.from("categories").update({ name }).eq("id", id));
      else check(await sb.from("categories").insert({ household_id: S.household.id, name }));
      closeSheet();
      await reload(id ? "Category updated" : "Category added");
    },

    async member(fd) {
      check(await sb.rpc("add_member_by_email", { p_household: S.household.id, p_email: fd.get("email").trim() }));
      closeSheet();
      await reload("Member added");
    },

    async holding(fd) {
      const asset = fd.get("asset");
      const qty = parseQty(fd.get("qty")), price = parseAmount(fd.get("price"));
      if (qty <= 0 || price <= 0) throw new Error("Quantity and price must be above zero.");
      const ticker = asset === "gold" ? "LM" : fd.get("ticker").trim().toUpperCase();
      const name = fd.get("name").trim() || (asset === "gold" ? "Antam" : ticker);
      check(await sb.from("holdings").insert({
        household_id: S.household.id, asset_type: asset, ticker, name, quantity: qty, buy_price: price, buy_date: fd.get("date"),
      }));
      if (fd.get("account")) {
        check(await sb.from("transactions").insert({
          household_id: S.household.id, date: fd.get("date"), type: "invest",
          category_id: await categoryId(asset === "gold" ? "Gold" : "Stocks"),
          description: `Buy ${qtyFmt(qty)} ${name}`, amount: Math.round(qty * price), source: "web", account_id: fd.get("account"),
        }));
      }
      closeSheet();
      await reload("Holding added");
    },

    async close(fd, form) {
      const m = fd.get("month");
      const bank = {}, notes = {};
      for (const el of form.querySelectorAll("[data-bank]")) {
        const closing = Number(el.dataset.closing);
        const v = parseSigned(el.value);
        const note = $(`#diffnote-${el.dataset.id}`, form).value.trim();
        const same = Math.round(v) === Math.round(closing);
        if (!el.value.trim()) throw new Error(`Enter the bank balance for ${el.dataset.name}.`);
        if (!same && !note) throw new Error(`Say why ${el.dataset.name} differs from the books, or fix the entries first.`);
        bank[el.dataset.id] = same ? closing : v; // rounding in the field must not count as a difference
        if (note && !same) notes[el.dataset.id] = note;
      }
      const btn = $("button[type=submit]", form);
      if (form.dataset.armed !== "1") { // closing locks the month: ask for a second tap
        form.dataset.armed = "1";
        btn.textContent = `Tap again to close ${monthLabel(m)}`;
        return;
      }
      const ps = positions();
      const priced = ps.some((p) => p.value !== null);
      // save the market price of the month's last day for every asset sitting in a plan, so the
      // statement can value them (the last trading day on or before it). Where that price cannot be
      // fetched, today's price is saved and the statement shows the day it is for.
      const inPlans = new Set(S.planHoldings.map((h) => h.holding_id));
      const planPos = ps.filter((p) => p.ids.some((id) => inPlans.has(id)));
      const lastDay = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
      let past = null;
      if (S.plansLedger && planPos.length && !pricesDown) {
        try {
          const r = await sb.functions.invoke("prices", { body: {
            tickers: [...new Set(planPos.filter((p) => p.asset_type === "stock").map((p) => p.ticker))],
            gold: planPos.some((p) => p.asset_type === "gold"), date: lastDay } });
          past = r.error ? null : r.data;
        } catch { /* fall back to today's price below */ }
      }
      const planPrices = planPos.map((p) => {
        const hist = p.asset_type === "gold" ? past?.gold
          : past?.stocks?.[p.ticker] ? { price: past.stocks[p.ticker], date: past.stockDates?.[p.ticker] } : null;
        const price = hist?.price || p.price;
        return price ? { asset_type: p.asset_type, ticker: p.ticker, name: p.name, price, price_date: hist?.price ? hist.date : undefined } : null;
      }).filter(Boolean);
      if (S.plansLedger && planPrices.length) {
        await sb.rpc("set_month_end_prices", { p_household: S.household.id, p_month: m, p_prices: planPrices });
      }
      check(await sb.rpc("close_period", {
        p_household: S.household.id, p_month: m, p_bank: bank, p_notes: notes, p_note: fd.get("note").trim(),
        p_portfolio_value: ps.length ? ps.reduce((s, p) => s + (p.value ?? p.cost), 0) : null,
        p_unrealized: ps.length && priced ? ps.reduce((s, p) => s + (p.pl ?? 0), 0) : null,
      }));
      closeSheet();
      await reload(`${monthLabel(m)} closed`);
    },

    async plan(fd) {
      const id = fd.get("id");
      const row = {
        name: fd.get("name").trim(), icon: fd.get("icon") || "🎯", note: fd.get("note").trim(),
        target_amount: parseAmount(fd.get("target")), target_date: fd.get("target_date"),
        start_date: fd.get("start_date"), account_id: fd.get("account") || null,
      };
      if (!row.name) throw new Error("Give the plan a name.");
      if (!(row.target_amount > 0)) throw new Error("Enter a target above Rp 0.");
      if (row.target_date <= row.start_date) throw new Error("The target date must be after the start date.");
      const saved = id
        ? check(await sb.from("plans").update(row).eq("id", id).select("id").single())
        : check(await sb.from("plans").insert({ ...row, household_id: S.household.id }).select("id").single());
      closeSheet();
      await reload(id ? "Plan saved" : "Plan created");
      sheetPlan(saved.id);
    },

    async contribution(fd) {
      const plan = fd.get("plan");
      const amount = parseAmount(fd.get("amount"));
      if (!(amount > 0)) throw new Error("Enter an amount above Rp 0.");
      check(await sb.from(ledgerTable()).insert({
        household_id: S.household.id, plan_id: plan, amount, date: fd.get("date"),
        note: (fd.get("note") || "").trim(), transaction_id: fd.get("transaction") || null,
      }));
      closeSheet();
      await reload("Money added");
      sheetPlan(plan);
    },

    async withdraw(fd) {
      const plan = fd.get("plan"), p = S.plans.find((x) => x.id === plan);
      const amount = parseAmount(fd.get("amount"));
      if (!(amount > 0)) throw new Error("Enter an amount above Rp 0.");
      if (p && amount > planStats(p).cash) throw new Error(`Only ${rp(planStats(p).cash)} cash is in this plan.`);
      check(await sb.from("plan_ledger").insert({
        household_id: S.household.id, plan_id: plan, entry_type: "withdrawal", amount: -amount,
        date: fd.get("date"), note: (fd.get("note") || "").trim(),
      }));
      closeSheet();
      await reload("Money taken out");
      sheetPlan(plan);
    },

    // Pay from a plan: one expense on an account and the same amount out of the plan's cash.
    async spend(fd) {
      const plan = fd.get("plan"), p = S.plans.find((x) => x.id === plan);
      const amount = parseAmount(fd.get("amount"));
      if (!(amount > 0)) throw new Error("Enter an amount above Rp 0.");
      const cash = p ? planStats(p).cash : Infinity;
      if (amount > cash) throw new Error(`Only ${rp(cash)} cash is in this plan. Pay less, or sell gold or stocks into the plan first.`);
      const category = fd.get("category").trim() || "Other";
      const known = S.categories.find((c) => c.name.toLowerCase() === category.toLowerCase());
      const { error } = await sb.rpc("spend_from_plan", {
        p_plan: plan, p_amount: amount, p_account: fd.get("account") || null,
        p_category: known ? known.id : await categoryId(category),
        p_date: fd.get("date"), p_note: (fd.get("note") || "").trim(),
      });
      if (error) {
        if (error.code === "PGRST202") throw new Error("Paying from a plan is not set up yet. Run supabase/migrations/20261125000000_plan_spend.sql in the Supabase SQL Editor.");
        throw error;
      }
      store.set("ft.lastAccount", fd.get("account"));
      closeSheet();
      await reload("Paid from plan");
      sheetPlan(plan);
    },

    // Achieved or cancelled: release what the user ticked, remember the progress, change the status.
    async closeplan(fd) {
      const plan = fd.get("plan"), to = fd.get("to"), p = S.plans.find((x) => x.id === plan);
      if (!p) return;
      const st = planStats(p);
      const day = minDate() > today() ? minDate() : today(); // the first open day when this month is closed
      if (fd.get("cash") && st.cash > 0) {
        check(await sb.from("plan_ledger").insert({
          household_id: S.household.id, plan_id: plan, entry_type: "withdrawal", amount: -st.cash,
          date: day, note: "Plan closed",
        }));
      }
      for (const id of fd.getAll("asset")) {
        const lot = S.holdings.find((h) => h.id === id);
        check(await sb.rpc("unassign_holding_from_plan", {
          p_plan: plan, p_holding: id, p_price: lot ? livePrice(lot.asset_type, lot.ticker) : null, p_date: day,
        }));
      }
      if (to) {
        const changes = { status: to };
        if (spendReady()) changes.progress_at_close = Math.round(st.progress * 1000) / 10; // % of the target reached
        check(await sb.from("plans").update(changes).eq("id", plan));
      }
      closeSheet();
      await reload(to === "cancelled" ? "Plan cancelled" : to === "achieved" ? "Marked achieved" : "Released");
      sheetPlan(plan);
    },

    async assign(fd) {
      const plan = fd.get("plan"), lot = S.holdings.find((h) => h.id === fd.get("holding"));
      const qty = parseQty(fd.get("qty"));
      if (!lot || !(qty > 0)) throw new Error("Enter a quantity above zero.");
      if (qty > lotFree(lot) + 1e-9) throw new Error(`Only ${qtyLabel(lot.asset_type, lotFree(lot))} of this holding is free.`);
      const price = parseAmount(fd.get("price")) || livePrice(lot.asset_type, lot.ticker) || null;
      check(await sb.rpc("assign_holding_to_plan", {
        p_plan: plan, p_holding: lot.id, p_quantity: qty, p_price: price, p_date: fd.get("date"),
      }));
      closeSheet();
      await reload("Added to plan");
      sheetPlan(plan);
    },

    async loan(fd) {
      const id = fd.get("id"), amount = parseAmount(fd.get("amount"));
      const frozen = id && $("#loan-amount").disabled;
      if (!frozen && !(amount > 0)) throw new Error("Enter an amount above Rp 0.");
      const from = S.accounts.find((a) => a.id === fd.get("account"));
      if (!id && from && amount > from.balance) throw new Error(`${from.name} only has ${rp(from.balance)}.`);
      const due = fd.get("due_date") || null;
      const loanDate = fd.get("date") || S.loans.find((x) => x.id === id)?.date; // a locked date field is not submitted
      if (due && due < loanDate) throw new Error("The due date cannot be before the loan date.");
      if (id) {
        const fields = { borrower: fd.get("borrower"), due_date: due, note: fd.get("note").trim() };
        if (!frozen) Object.assign(fields, { amount, account: fd.get("account"), date: fd.get("date") });
        check(await sb.rpc("update_loan", { p_loan: id, p_fields: fields }));
      } else {
        const saved = check(await sb.rpc("add_loan", {
          p_household: S.household.id, p_account: fd.get("account"), p_amount: amount, p_borrower: fd.get("borrower"),
          p_date: fd.get("date"), p_due_date: due, p_note: fd.get("note").trim(), p_source: "web",
        }));
        store.set("ft.lastAccount", fd.get("account"));
        closeSheet();
        await reload("Loan saved");
        return sheetLoan(saved);
      }
      closeSheet();
      await reload("Loan updated");
      sheetLoan(id);
    },

    async loanpay(fd) {
      const loan = fd.get("loan"), amount = parseAmount(fd.get("amount"));
      if (!(amount > 0)) throw new Error("Enter an amount above Rp 0.");
      const l = S.loans.find((x) => x.id === loan);
      if (l && amount > loanStats(l).outstanding) throw new Error(`Only ${rp(loanStats(l).outstanding)} is still owed.`);
      check(await sb.rpc("add_loan_payment", {
        p_loan: loan, p_account: fd.get("account"), p_amount: amount, p_date: fd.get("date"),
        p_note: fd.get("note").trim(), p_source: "web",
      }));
      store.set("ft.lastAccount", fd.get("account"));
      closeSheet();
      await reload("Repayment saved");
      sheetLoan(loan);
    },

    async reopen(fd) {
      const m = fd.get("month"), reason = fd.get("reason").trim();
      if (!reason) throw new Error("Say why the month is being reopened.");
      check(await sb.rpc("reopen_period", { p_household: S.household.id, p_month: m, p_reason: reason }));
      closeSheet();
      await reload(`${monthLabel(m)} reopened`);
    },

    async sell(fd) {
      const qty = parseQty(fd.get("qty")), price = parseAmount(fd.get("price"));
      if (qty <= 0 || price <= 0) throw new Error("Quantity and price must be above zero.");
      check(await sb.rpc("sell_holding", {
        p_household: S.household.id, p_quantity: qty, p_sell_price: price,
        p_account: fd.get("account") || null, p_ticker: fd.get("ticker") || null, p_name: fd.get("name") || null,
        p_date: fd.get("date"), p_source: "web",
      }));
      closeSheet();
      await reload("Sale recorded");
    },
  };

  document.addEventListener("submit", async (ev) => {
    const form = ev.target.closest("form[data-form]");
    if (!form) return;
    ev.preventDefault();
    const btn = $("button[type=submit]", form), errEl = $(".error", form);
    if (errEl) errEl.textContent = "";
    btn.disabled = true;
    try {
      await forms[form.dataset.form](new FormData(form), form);
    } catch (e) {
      const msg = isNetworkError(e) ? "You are offline. Try again when connected." : (e.message || "Something went wrong.");
      if (errEl) errEl.textContent = msg; else toast(msg);
    } finally {
      btn.disabled = false;
    }
  });

  // ------------------------------------------------------------ click actions
  let armed = null; // id of a destructive button waiting for its second tap

  const actions = {
    add: () => { S.scan = null; sheetAdd(); },
    scan: () => sheetScan(),
    "scan-skip": () => scanNext(false),
    "scan-smart": () => {
      S.scan = null;
      if (!$("#scan") && scanPhoto) sheetScan(scanPhoto.mode); // started from the review sheet: show the loading panel
      return runScan(null, "smart");
    },
    "scan-cancel": () => scanLoad?.cancel(),
    "scan-mode": (el) => {
      $("#scan").dataset.mode = el.dataset.id;
      el.parentElement.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === el));
      $("#scan-hint").textContent = SCAN_MODES.find((m) => m[0] === el.dataset.id)[2];
    },
    transfer: sheetTransfer,
    holding: sheetHolding,
    member: sheetMember,
    close: closeSheet,
    reload: () => reload("Up to date"),
    tx: (el) => {
      const t = S.txns.find((x) => x.id === el.dataset.id);
      if (t?.loan_id && S.loans.some((l) => l.id === t.loan_id)) return openFrom(el, () => sheetLoan(t.loan_id)); // loan entries live on the loan
      return openFrom(el, () => sheetTx(el.dataset.id));
    },
    statement: (el) => openFrom(el, () => sheetStatement(el.dataset.id)),
    "statement-print": () => window.print(),
    "statement-csv": (el) => downloadCsv(el.dataset.id),
    "tx-edit": (el) => {
      const t = S.txns.find((x) => x.id === el.dataset.id);
      if (!t) return;
      sheetAdd(t.type, {
        id: t.id, amount: t.amount, description: t.description, date: t.date, account: t.account_id,
        category: t.category_id ? categoryName(t.category_id) : "",
      });
    },
    account: (el) => (el.dataset.id ? openFrom(el, () => sheetAccount(el.dataset.id)) : sheetAccount()),
    category: (el) => (el.dataset.id ? openFrom(el, () => sheetCategory(el.dataset.id)) : sheetCategory()),
    position: (el) => openFrom(el, () => sheetPosition(Number(el.dataset.id))),
    period: (el) => transition(() => { S.period = el.dataset.id; route(); }),
    card: (el) => { // bring one account card to the front without re-rendering, so it animates
      S.openAccount = el.dataset.id;
      const card = el.closest(".wcard");
      card.parentElement.querySelectorAll(".wcard").forEach((c) => c.classList.toggle("open", c === card));
    },
    dismiss: (el, ev) => { if (ev.target === el) closeSheet(); },
    "signout-ask": () => sheetSignOut(),
    // plan sheet: reveal or hide the older ledger entries
    "ledger-more"(el) {
      const more = el.parentElement.querySelector(".ent-more");
      if (!more) return;
      more.hidden = !more.hidden;
      el.textContent = more.hidden ? el.dataset.all : el.dataset.less;
    },
    async "sync-prices"(el) {
      if (syncing) return;
      if (Date.now() - (S.pricesAt || 0) < 15000) { toast("Prices were just updated."); return; } // spare the gold API's rate limit
      syncing = true;
      el.disabled = true;
      el.lastChild.textContent = " Syncing...";
      try { await loadPrices(true); } finally { syncing = false; }
      route(); // repaints the page, which also re-enables the button
    },

    "txn-type": (el) => {
      $("#txn-type").value = el.dataset.id;
      el.parentElement.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === el));
      const cat = $("#txn-category");
      if (["", "Salary", "Stocks"].includes(cat.value)) cat.value = { income: "Salary", invest: "Stocks", expense: "" }[el.dataset.id];
    },

    asset: (el) => {
      const gold = el.dataset.id === "gold";
      $("#hold-asset").value = el.dataset.id;
      el.parentElement.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === el));
      const ticker = $("#hold-ticker");
      ticker.value = gold ? "LM" : "";
      ticker.readOnly = gold;
      $("#hold-name-label").textContent = gold ? "Brand" : "Name";
      $("#hold-name").placeholder = gold ? "Antam" : "Bank Central Asia";
      $("#hold-qty-label").textContent = gold ? "Grams" : "Shares";
      $("#hold-price-label").textContent = gold ? "Price per gram (Rp)" : "Price per share (Rp)";
    },

    async "telegram-link"() {
      const { data, error } = await sb.rpc("create_telegram_link_code", { p_household: S.household.id });
      if (error) {
        throw new Error(/create_telegram_link_code/.test(error.message)
          ? "The Telegram bot is not set up yet (see setup.md, phase 4)." : error.message);
      }
      sheetTelegram(data);
    },

    async "telegram-copy"(el) {
      await navigator.clipboard.writeText($("#tg-code").textContent);
      el.textContent = "Copied";
    },

    async "telegram-done"() {
      closeSheet();
      await reload();
      toast(S.telegram ? "Telegram linked" : "Not linked yet. Send the code to the bot, then refresh.");
    },

    async "telegram-unlink"(el) {
      if (armed !== "tg") { armed = "tg"; el.textContent = "Tap again to unlink"; return; }
      armed = null;
      check(await sb.from("telegram_links").delete().eq("user_id", S.session.user.id));
      await reload("Telegram unlinked");
    },

    async signout() {
      if (notifChannel) { sb.removeChannel(notifChannel); notifChannel = null; }
      checkedAt = 0;
      clearTimeout(cacheTimer); // a pending save must not bring the cache back after sign-out
      cacheTimer = 0;
      localStorage.removeItem("ft.cache");
      // "local" ends this device's session. If the server cannot be reached, supabase-js keeps
      // the session and returns an error, which used to leave the button doing nothing.
      let failed = false;
      try { failed = !!(await sb.auth.signOut({ scope: "local" })).error; } catch { failed = true; }
      if (failed) {
        Object.keys(localStorage).filter((k) => k.startsWith("sb-")).forEach((k) => localStorage.removeItem(k));
        location.reload();
      }
    },

    async "tx-delete"(el) {
      if (armed !== el.dataset.id) { armed = el.dataset.id; el.textContent = "Tap again to delete"; return; }
      armed = null;
      const t = S.txns.find((x) => x.id === el.dataset.id);
      const q = sb.from("transactions").delete();
      check(await (t.transfer_group ? q.eq("transfer_group", t.transfer_group) : q.eq("id", t.id)));
      hero = null; // the row is gone: slide the sheet away instead of shrinking it back
      const m = $(".modal", sheetRoot);
      if (m) m.style.viewTransitionName = "";
      closeSheet();
      await reload("Deleted");
    },

    async "position-delete"(el) {
      const p = positions()[Number(el.dataset.id)];
      if (!p) return;
      const key = `pos-${p.ids.join(",")}`;
      if (armed !== key) { armed = key; el.textContent = "Tap again to delete"; return; }
      armed = null;
      check(await sb.from("holdings").delete().in("id", p.ids));
      closeSheet();
      await reload(`${p.name || p.ticker} deleted`);
    },

    notifs: () => sheetNotifications(),

    async notif(el) { // mark read (the list does not wait for it), then open what it points at
      const n = S.notifs.find((x) => x.id === el.dataset.id);
      if (!n) return;
      if (!n.read_at) {
        n.read_at = new Date().toISOString();
        saveCache();
        paintBell();
        sb.from("notifications").update({ read_at: n.read_at }).eq("id", n.id).then(({ error }) => { if (error) n.read_at = null; });
      }
      openNotifLink(n.link);
    },

    async "notifs-read"() {
      const ids = S.notifs.filter((n) => !n.read_at).map((n) => n.id);
      if (!ids.length) return;
      const at = new Date().toISOString();
      check(await sb.from("notifications").update({ read_at: at }).in("id", ids));
      S.notifs.forEach((n) => { if (!n.read_at) n.read_at = at; });
      saveCache();
      paintBell();
      sheetNotifications();
    },

    async "notifs-clear"() {
      const ids = S.notifs.filter((n) => n.read_at).map((n) => n.id);
      if (!ids.length) return;
      check(await sb.from("notifications").delete().in("id", ids));
      S.notifs = S.notifs.filter((n) => !n.read_at);
      saveCache();
      sheetNotifications();
    },

    plan: (el) => openFrom(el, () => sheetPlan(el.dataset.id)),
    "plan-new": () => sheetPlanForm(),
    "plan-edit": (el) => sheetPlanForm(el.dataset.id),
    "plan-money": (el) => sheetContribution(el.dataset.id),
    "plan-withdraw": (el) => sheetWithdraw(el.dataset.id),
    "plan-spend": (el) => sheetSpend(el.dataset.id),
    "plan-closeout": (el) => sheetClosePlan(el.dataset.id, null),

    // Remove a payment made from a plan: the expense goes too, and the cash returns to the plan.
    async "spend-delete"(el) {
      const c = S.ledger.find((x) => x.id === el.dataset.id);
      if (!c) return;
      if (armed !== c.id) { armed = c.id; el.textContent = "Tap again: also removes the expense"; return; }
      armed = null;
      check(await sb.rpc("delete_plan_spend", { p_entry: c.id }));
      closeSheet();
      await reload("Payment removed");
      sheetPlan(c.plan_id);
    },
    "plan-assign": (el) => sheetAssign(el.dataset.id),

    async "plan-release"(el) {
      const lot = S.holdings.find((h) => h.id === el.dataset.id), plan = el.dataset.plan;
      const key = `release-${plan}-${el.dataset.id}`;
      if (armed !== key) { armed = key; el.textContent = "Tap again to release"; return; }
      armed = null;
      check(await sb.rpc("unassign_holding_from_plan", {
        p_plan: plan, p_holding: el.dataset.id, p_price: lot ? livePrice(lot.asset_type, lot.ticker) : null,
      }));
      closeSheet();
      await reload("Released from plan");
      sheetPlan(plan);
    },
    "plan-icon": (el) => {
      $("#plan-icon").value = el.dataset.id;
      el.parentElement.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === el));
    },

    async "plan-status"(el) {
      const p = S.plans.find((x) => x.id === el.dataset.id), to = el.dataset.to;
      if (!p) return;
      if (S.plansLedger && (to === "cancelled" || to === "achieved")) {
        // closing a plan: show what is still tied to it and let the user release it (cancelling always asks)
        const st = planStats(p);
        if (to === "cancelled" || st.cash > 0 || st.assets.length) return sheetClosePlan(p.id, to);
      } else if (to === "cancelled" && armed !== `cancel-${p.id}`) { armed = `cancel-${p.id}`; el.textContent = "Tap again to cancel"; return; }
      armed = null;
      const changes = { status: to };
      if (spendReady() && to === "achieved") changes.progress_at_close = Math.round(planStats(p).progress * 1000) / 10;
      check(await sb.from("plans").update(changes).eq("id", p.id));
      closeSheet();
      await reload({ paused: "Plan paused", active: "Plan resumed", achieved: "Marked achieved", cancelled: "Plan cancelled" }[to]);
      sheetPlan(p.id);
    },

    async "plan-delete"(el) {
      if (armed !== el.dataset.id) { armed = el.dataset.id; el.textContent = "Tap again to delete"; return; }
      armed = null;
      check(await sb.from("plans").delete().eq("id", el.dataset.id));
      hero = null;
      const m = $(".modal", sheetRoot);
      if (m) m.style.viewTransitionName = "";
      closeSheet();
      await reload("Plan deleted");
    },

    async "contribution-delete"(el) {
      const c = S.ledger.find((x) => x.id === el.dataset.id);
      if (!c) return;
      if (armed !== c.id) { armed = c.id; el.textContent = "Tap again to remove"; return; }
      armed = null;
      check(await sb.from(ledgerTable()).delete().eq("id", c.id));
      closeSheet();
      await reload("Removed");
      sheetPlan(c.plan_id);
    },

    "loan-new": () => sheetLoanForm(),
    loan: (el) => openFrom(el, () => sheetLoan(el.dataset.id)),
    "loan-edit": (el) => sheetLoanForm(el.dataset.id),
    "loan-pay": (el) => sheetLoanPay(el.dataset.id),

    async "loan-delete"(el) {
      if (armed !== el.dataset.id) { armed = el.dataset.id; el.textContent = "Tap again to delete"; return; }
      armed = null;
      check(await sb.rpc("delete_loan", { p_loan: el.dataset.id }));
      hero = null;
      const m = $(".modal", sheetRoot);
      if (m) m.style.viewTransitionName = "";
      closeSheet();
      await reload("Loan deleted");
    },

    async "loan-payment-delete"(el) {
      const t = S.txns.find((x) => x.id === el.dataset.id);
      if (!t) return;
      if (armed !== t.id) { armed = t.id; el.textContent = "Tap again to remove"; return; }
      armed = null;
      check(await sb.rpc("delete_loan_payment", { p_txn: t.id }));
      closeSheet();
      await reload("Repayment removed");
      sheetLoan(t.loan_id);
    },

    async "account-archive"(el) {
      const a = S.accounts.find((x) => x.id === el.dataset.id);
      check(await sb.from("accounts").update({ archived: !a.archived }).eq("id", a.id));
      closeSheet();
      await reload(a.archived ? "Account restored" : "Account archived");
    },

    async "category-delete"(el) {
      if (armed !== el.dataset.id) { armed = el.dataset.id; el.textContent = "Tap again to delete"; return; }
      armed = null;
      check(await sb.from("categories").delete().eq("id", el.dataset.id));
      closeSheet();
      await reload("Category deleted");
    },
  };

  document.addEventListener("click", async (ev) => {
    const go = ev.target.closest("[data-go]");
    if (go) { location.hash = go.dataset.go; return; }
    const el = ev.target.closest("[data-act]");
    if (!el) return;
    try {
      await actions[el.dataset.act]?.(el, ev);
    } catch (e) {
      const msg = isNetworkError(e) ? "You are offline. Try again when connected." : (e.message || "Something went wrong.");
      const errEl = $(".error", sheetRoot);
      if (errEl) errEl.textContent = msg; else toast(msg);
    }
  });

  // The on-screen keyboard covers the lower half of a sheet on iPhone (and some Androids):
  // once it is up, scroll the field being typed in back into view.
  document.addEventListener("focusin", (ev) => {
    const el = ev.target;
    if (!el.matches?.("input, select, textarea") || !el.closest(".modal")) return;
    setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 320);
  });

  document.addEventListener("input", (ev) => {
    const el = ev.target;
    if (el.matches("[data-money]")) { const n = parseAmount(el.value); el.value = n ? num(n) : ""; }
    if (el.dataset.filter) { S.filter[el.dataset.filter] = el.value; renderTxList(); }
    if (el.matches("[data-bank]")) { // closing: show how far the bank balance is from the books
      if (/^\s*[-−]\s*$/.test(el.value)) return; // a minus sign on its own: wait for digits
      const v = parseSigned(el.value);
      el.value = el.value.trim() ? (v < 0 ? "-" : "") + num(Math.abs(v)) : "";
      const diff = Math.round(v) - Math.round(Number(el.dataset.closing));
      const out = $(`#diff-${el.dataset.id}`), note = $(`#diffnote-${el.dataset.id}`);
      out.textContent = diff ? `Differs from the books by ${rp(diff)}` : "Matches the books";
      out.classList.toggle("neg", !!diff);
      note.hidden = !diff;
      const form = el.closest("form"); // any change cancels a half-done "tap again" and clears an old error
      const err = form && $(".error", form);
      if (err) err.textContent = "";
      if (form?.dataset.armed) { delete form.dataset.armed; $("button[type=submit]", form).textContent = `Close ${monthLabel(form.month.value)}`; }
    }
  });

  document.addEventListener("change", (ev) => {
    const el = ev.target;
    if (el.dataset.pref) { // Settings → Notifications switch: save every kind in the group
      const g = NOTIF_GROUPS.find((x) => x.id === el.dataset.pref);
      const enabled = el.checked, uid = S.session.user.id;
      el.disabled = true;
      sb.from("notification_prefs").upsert(g.kinds.map((kind) => ({ user_id: uid, kind, enabled })))
        .then(({ error }) => {
          el.disabled = false;
          if (error) { el.checked = !enabled; return toast(isNetworkError(error) ? "You are offline. Try again when connected." : error.message); }
          g.kinds.forEach((kind) => {
            const row = S.prefs.find((p) => p.kind === kind);
            if (row) row.enabled = enabled; else S.prefs.push({ kind, enabled });
          });
          saveCache();
          toast(`${g.label} ${enabled ? "on" : "off"}`);
        });
      return;
    }
    if (el.dataset.loanfilter !== undefined) { // Loans screen: show one borrower's loans
      S.loanFilter = el.value;
      route();
      return;
    }
    if (el.id === "ctr-tx") { // money into a plan from a transaction: take its amount and date
      const o = el.selectedOptions[0];
      if (o?.dataset.amount) {
        $("#ctr-amount").value = num(o.dataset.amount);
        $("#ctr-date").value = o.dataset.date; // never in a closed month: those are not offered
      }
      return;
    }
    if (!el.matches("input[data-scan]")) return;
    const file = el.files[0];
    el.value = ""; // picking the same photo again must fire change
    runScan(file);
  });

  const TAB_ORDER = { home: 0, activity: 0.5, plans: 0.6, loans: 0.7, stats: 1, portfolio: 2, settings: 3, notifications: 3.4, ledger: 3.5 };
  let lastTab = currentTab();
  window.addEventListener("hashchange", () => {
    const tab = currentTab();
    const kind = TAB_ORDER[tab] >= TAB_ORDER[lastTab] ? "forward" : "back";
    lastTab = tab;
    transition(() => { closeSheet(); route(); window.scrollTo(0, 0); }, kind);
  });
  window.addEventListener("online", () => { if (S.household) reload(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushCache();
    if (document.visibilityState === "visible" && S.household && S.session) runChecks().catch(() => {});
  });
  window.addEventListener("pagehide", flushCache);
  window.addEventListener("offline", () => { S.offline = true; if (S.household) route(); });

  // ------------------------------------------------------------ startup
  async function start() {
    closeSheet();
    if (!S.session) { S.household = null; return viewLogin(); }
    if (app.querySelector(".skel")?.dataset.sk !== currentTab()) paintSkeleton(); // the page's own copy already covers Home
    const res = await sb.from("households").select("*").order("created_at");
    if (res.error) {
      if (isNetworkError(res.error) && loadCache()) { S.offline = true; return route(); }
      return viewLogin(res.error.message);
    }
    S.households = res.data;
    S.household = res.data[0] || null;
    if (!S.household) return viewOnboard();
    await reload();
    listenNotifs();
    runChecks().catch(() => {});
  }

  async function boot() {
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY || !window.supabase) {
      app.innerHTML = `<div class="center"><div><h2>Not configured</h2>
        <p class="muted">Run <code>python scripts/build_pwa_config.py</code> to create <code>pwa/config.js</code>, then reload.</p></div></div>`;
      return;
    }
    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);
    S.session = (await sb.auth.getSession()).data.session;
    sb.auth.onAuthStateChange((_event, session) => {
      const changed = (session?.user?.id || null) !== (S.session?.user?.id || null);
      S.session = session;
      if (changed) setTimeout(start, 0); // never call Supabase from inside this callback
    });
    await start();
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  boot();
})();
