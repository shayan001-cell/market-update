/* Market Update client. Renders the report JSON (embedded or fetched) and
   handles refresh, auto-update polling, theme, tabs and stock detail. */
(function () {
  "use strict";

  // ---------------------------------------------------------------- state
  const EMBEDDED = document.getElementById("report-data");
  let API = ((document.querySelector('meta[name="mu-api-url"]') || {}).content || "").replace(/__API_URL__/, "").replace(/\/$/, "");
  const STATIC_MODE = !!EMBEDDED && !API;          // a static copy with an API behind it behaves like the app
  let authToken = null; try { authToken = localStorage.getItem("mu-token"); } catch (e) {}
  const mst = (location.hash.match(/[#&]st=([A-Za-z0-9_\-.]+)/) || [])[1];
  if (mst) { authToken = mst; try { localStorage.setItem("mu-token", mst); } catch (e) {} try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {} }
  // When the server stops answering (the tunnel address changed), re-read the address the site was built with.
  let apiRediscoveredAt = 0;
  async function rediscoverApi() {
    if (!EMBEDDED || Date.now() - apiRediscoveredAt < 30000) return false;
    apiRediscoveredAt = Date.now();
    try {
      const r = await fetch("api.json?cb=" + Date.now(), { cache: "no-store" });
      if (!r.ok) return false;
      const j = await r.json(); const next = String(j.api || "").replace(/\/$/, "");
      if (next && next !== API) { API = next; return true; }
    } catch (e) {}
    return false;
  }
  const api = async (path, opts) => {
    const o = Object.assign({}, opts || {}); o.headers = Object.assign({}, o.headers || {}); if (API) o.credentials = "include"; if (authToken) o.headers["Authorization"] = "Bearer " + authToken;
    try { return await fetch(API + path, o); }
    catch (e) { if (await rediscoverApi()) return fetch(API + path, o); throw e; }
  };
  let report = null;
  let selectedTicker = null;
  let stockTab = "all";
  let sortKey = "swing";
  const tvLink = (t) => `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(t.replace("-", "."))}`;
  let charts = [];
  let firstRender = true;
  const VIEWS = [["home", "Overview", "1"], ["watch", "Watchlist", "2"], ["map", "Company map", ""], ["scan", "Scanner", "3"], ["stock", "Stocks", "4"], ["theme", "Themes", "5"], ["smart", "Filings & flow", "6"], ["macro", "Market context", "7"], ["admin", "Admin", "8"], ["record", "Track record", "9"], ["check", "Intraday check", ""], ["desk", "Trading desk", ""], ["guide", "Guide", "0"]];
  const PAGE_TITLES = { home: "Your market overview", watch: "Your watchlist", map: "Company map", scan: "Scanner", stock: "Stocks", theme: "Themes", smart: "Filings and flow", macro: "Market context", admin: "Admin", record: "Track record", check: "Intraday check", desk: "Trading desk", guide: "How to use OneView" };
  // analysis timeframe: changes which read leads on the overview, the watchlist and the stocks table
  let horizon = "swing"; try { horizon = localStorage.getItem("mu-horizon") || "swing"; } catch (e) {}
  const HORIZONS = [["day", "Day", "Day trading: today's price and volume"], ["swing", "Swing", "Swing trading: the next one to ten sessions"], ["long", "Long term", "Long-term investing: the business and the primary trend"]];
  const HZ_NAME = { day: "Day trading", swing: "Swing trading", long: "Long-term investing" };
  function setHorizon(h) { if (!HORIZONS.some((x) => x[0] === h)) return; horizon = h; try { localStorage.setItem("mu-horizon", h); } catch (e) {} sortKey = h === "day" ? "day" : "swing"; if (report) renderAll(); }
  function horizonBar() { const el = $("#horizon"); if (!el) return; const show = ["watch", "stock"].includes(currentView); el.hidden = !show; if (!show) return;   /* the Overview keeps one fixed read; the toggle lives on Watchlist and Stocks */
    el.innerHTML = HORIZONS.map(([k, l, t]) => `<button type="button" class="hz-btn ${horizon === k ? "on" : ""}" aria-pressed="${horizon === k}" data-horizon="${k}" title="${esc(t)}">${l}</button>`).join("");
    el.querySelectorAll("[data-horizon]").forEach((b) => b.addEventListener("click", () => setHorizon(b.getAttribute("data-horizon")))); }
  // the read that matches the chosen timeframe for one name
  function readFor(s) {
    if (!s) return null; const a = s.ai || {};
    if (horizon === "day") { if (!a.intraday) return null; const it = ST.intraday[a.intraday.choice]; return { word: it[0], cls: it[2], plain: it[1], conviction: convOf(a.intraday.confidence), why: [] }; }
    if (horizon === "long") { if (!a.long_term) return null; const lt = LT.stance[a.long_term.choice]; const q = a.long_term_quality ? Math.round(a.long_term_quality.score) : null; return { word: lt[0], cls: lt[2], plain: lt[1] + (q != null ? ` Business quality: ${LT.quality[q]}.` : ""), conviction: convOf(a.long_term.confidence), why: [] }; }
    return verdictFor(s);
  }
  const ICONS = {
    home: '<svg viewBox="0 0 24 24"><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/><path d="M10 20v-5h4v5"/></svg>',
    scan: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 3v9l6.5 4"/></svg>',
    stock: '<svg viewBox="0 0 24 24"><path d="M7 4v16M7 8h-2.5v7H7M12 3v18M12 6h-2.5v9H12M17 5v14M17 9h-2.5v6H17"/><path d="M7 8h2.5v7H7M12 6h2.5v9H12M17 9h2.5v6H17"/></svg>',
    map: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><path d="M6.6 7.2 9.6 10M17.4 7.2 14.4 10M6.6 16.8 9.6 14M17.4 16.8 14.4 14"/></svg>',
    theme: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></svg>',
    smart: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 6.5v11M15 9.2c0-1.4-1.3-2.2-3-2.2s-3 .8-3 2.1c0 2.9 6 1.6 6 4.6 0 1.4-1.4 2.3-3 2.3s-3-.9-3-2.3"/></svg>',
    guide: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7"/><path d="M12 17h.01"/></svg>',
    record: '<svg viewBox="0 0 24 24"><path d="M4 19V5"/><path d="M4 19h16"/><path d="M7 15l4-5 3 3 5-7"/></svg>',
    macro: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/></svg>',
    watch: '<svg viewBox="0 0 24 24"><path d="M12 3.5 14.6 9l6 .6-4.5 4 1.4 5.9L12 16.4 6.5 19.5 7.9 13.6l-4.5-4 6-.6z"/></svg>',
    admin: '<svg viewBox="0 0 24 24"><path d="M12 3 4 6.5v5c0 4.6 3.4 8.4 8 9.5 4.6-1.1 8-4.9 8-9.5v-5z"/><path d="m9 12 2 2 4-4"/></svg>',
    check: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    desk: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4M7 13l3-3 2.5 2L17 8"/></svg>',
  };
  const SUBTABS = { scan: [["scanner", "Volume scanner"], ["lowfloat", "Low float"]], stock: [["all", "All names"], ["day", "Day trade"], ["swing", "Swing trade"], ["large", "Large cap"], ["small", "Small cap"], ["gappers", "Gapping"], ["watchlist", "Watchlist"]], smart: [["money", "Insiders, institutions, Congress"], ["options", "Options flow"]], macro: [["picture", "Big picture"], ["indexes", "Indexes, weekly"], ["rates", "Rates"], ["flows", "Money flows"]] };
  const ADMIN_VIEWS = ["admin", "check", "desk"];   // menu items and views only the admin sees
  const NAV_GROUPS = [["Workspace", ["home", "watch", "map", "desk", "scan", "stock", "theme"]], ["Money", ["smart"]], ["Macro", ["macro", "check", "record"]], ["Help", ["guide"]], ["Admin", ["admin"]]];
  let subTab = { scan: "scanner", stock: "all", smart: "money", macro: "picture" };
  let liveScan = null, liveTimer = null, adminData = null, lastMarketState = null;
  let gateOpen = true;                   // the sign-in card shows first; the dashboard follows a successful login
  let nextRefreshAt = 0;
  let tickerSel = (location.hash.match(/[&#]t=([A-Z0-9.\-^=]+)/i) || [])[1] || null;
  let mailStatus = null;
  const APP_URL = ((document.querySelector('meta[name="mu-app-url"]') || {}).content || "").replace(/__APP_URL__/, "").replace(/\/$/, "");
  const USER_KEY = "mu-user";
  let user = null;                       // { email, profile: { accepted_disclaimer_at, kind, tickers } }
  let newsItems = [], newsSeen = new Set();
  // Watchlists live in this browser (several named lists); the server also keeps the union so scheduled builds analyse them fully.
  const LISTS_KEY = "mu-lists";
  let lists = null;
  const analyzing = new Set(), analyzeError = {};
  let symbolIndex = null, symbolLoading = false, searchSel = 0, searchRows = [];
  let scanTf = "lead", scanOpen = null;
  let currentView = (location.hash.match(/view=([a-z]+)/) || [])[1] || "home";
  if (currentView === "ticker" && tickerSel) tickerSel = tickerSel.toUpperCase();
  if (["market", "flows", "news", "options"].includes(currentView)) currentView = { market: "macro", flows: "macro", news: "home", options: "smart" }[currentView];
  let lastInteraction = Date.now();
  let pendingReport = null;
  ["scroll", "pointerdown", "keydown", "wheel", "touchstart"].forEach((ev) => addEventListener(ev, () => { lastInteraction = Date.now(); }, { passive: true }));

  // ---------------------------------------------------------------- utils
  const $ = (sel, el) => (el || document).querySelector(sel);
  const setLabel = (btn, text) => { if (!btn) return; const l = btn.querySelector(".lbl"); if (l) l.textContent = text; else btn.textContent = text; };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const isNum = (x) => typeof x === "number" && isFinite(x);
  const fnum = (x, nd = 2) => (isNum(x) ? x.toLocaleString("en-US", { minimumFractionDigits: nd, maximumFractionDigits: nd }) : "–");
  const fpct = (x, nd = 2, sign = true) => (isNum(x) ? ((sign && x > 0 ? "+" : "") + x.toFixed(nd) + "%").replace("-", "−") : "–");
  const fbp = (x) => (isNum(x) ? ((x > 0 ? "+" : "") + x.toFixed(0) + " bp").replace("-", "−") : "–");
  const fcap = (x) => { if (!isNum(x)) return "–"; for (const [d, s] of [[1e12, "T"], [1e9, "B"], [1e6, "M"]]) if (x >= d) return "$" + (x / d).toFixed(1) + s; return "$" + x.toFixed(0); };
  const fvol = (x) => { if (!isNum(x)) return "–"; for (const [d, s] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]]) if (x >= d) return (x / d).toFixed(1) + s; return x.toFixed(0); };
  const cls = (x, inverse) => { if (!isNum(x) || Math.abs(x) < 0.005) return "flat"; let up = x > 0; if (inverse) up = !up; return up ? "up" : "down"; };
  const ICON_UP = '<svg class="ico" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2.5 10 8H2z"/></svg>';
  const ICON_DOWN = '<svg class="ico" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 9.5 2 4h8z"/></svg>';
  const ICON_FLAT = '<svg class="ico" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="5.25" width="8" height="1.5" rx=".75"/></svg>';
  const qchg = (x) => (x && isNum(x.chg_pct) ? x.chg_pct : x && isNum(x.change_pct) ? x.change_pct : null);
  const arrow = (x) => (!isNum(x) ? "" : x > 0 ? ICON_UP : x < 0 ? ICON_DOWN : ICON_FLAT);

  // ---------------------------------------------------------------- ONE quote store: every price and change on every view reads from here
  const Q = { map: {}, at: 0, reportAt: 0, liveAt: 0 };
  const qset = (t, last, chg, ts, extra) => { if (!t || !isNum(last)) return; const cur = Q.map[t]; if (cur && cur.ts > ts) { if (extra) Object.keys(extra).forEach((k) => { if (cur[k] == null && extra[k] != null) cur[k] = extra[k]; }); return; }
    Q.map[t] = Object.assign({}, cur || {}, { last, chg: isNum(chg) ? chg : (cur ? cur.chg : null), ts }, extra || {}); };   // newer price wins; flow details (activity, dollars traded) are kept from whichever feed had them
  function seedQuotes(r) {
    const ts = r.generated_at ? Date.parse(r.generated_at) / 1000 : 0; Q.reportAt = ts;
    (r.stocks || []).forEach((x) => qset(x.ticker, x.last_price, x.chg_pct, ts));
    Object.entries(r.lite || {}).forEach(([t, q]) => qset(t, q.last_price, q.chg_pct, ts, q.scan ? { rvol: q.scan.rvol_tod, above_vwap: q.scan.above_vwap, score: q.scan.score, direction: q.scan.direction } : null));
    (r.indices || []).forEach((i) => qset(i.symbol, i.last, i.chg_pct, ts));
    (r.macro || []).forEach((m) => qset(m.symbol, m.last, qchg(m), ts));
    (r.world || []).forEach((w) => qset(w.symbol, w.last, qchg(w), ts));
    ((r.scan || {}).rows || []).forEach((x) => qset(x.ticker, x.price, x.chg_pct, ts));
    ((r.low_float || {}).rows || []).forEach((x) => qset(x.ticker, x.price, x.chg_pct, ts));
    ((r.theme || {}).rows || []).forEach((x) => qset(x.ticker, x.last_price, x.chg_pct, ts));
    ((r.flows || {}).sectors || []).forEach((x) => qset(x.symbol, x.last, x.chg_1d, ts));
    if (!Q.at) Q.at = ts;
  }
  function applyLiveQuotes(j) {
    const ts = j.quotes_at || j.as_of || 0; if (!j.quotes) return;
    let newest = 0;                                  // each quote carries its own time; bar prices are only as fresh as their bar
    Object.entries(j.quotes).forEach(([t, q]) => { const qts = isNum(q.ts) ? q.ts : ts; qset(t, q.last, q.chg_pct, qts, { rvol: q.rvol, above_vwap: q.above_vwap, dollar_vol: q.dollar_vol, vol: q.vol, score: q.score, direction: q.direction, range_pos: q.range_pos, live: true }); if (Q.map[t] && Q.map[t].ts === qts) newest = Math.max(newest, qts); });
    Q.liveAt = Math.max(Q.liveAt || 0, newest || 0, Q.reportAt || 0); Q.at = Math.max(Q.at, Q.liveAt);
  }
  // qp(ticker, fallbackObject) -> {last, chg}: the store first, the object's own numbers only when the store has nothing
  const qp = (t, o) => { const q = Q.map[t]; if (q && isNum(q.last)) return q; const last = o ? [o.last_price, o.last, o.price, o.spot].find(isNum) : null; return { last: isNum(last) ? last : null, chg: o ? qchg(o) : null, ts: 0 }; };
  const priceHtml = (t, o, nd) => { const q = qp(t, o); const d = nd == null ? (isNum(q.last) && q.last < 10 ? 3 : 2) : nd; return `<span class="qx" data-q="${esc(t)}" data-nd="${d}"><span class="px">${fnum(q.last, d)}</span><span class="delta ${cls(q.chg)}">${arrow(q.chg)} ${fpct(q.chg)}</span></span>`; };
  function refreshQuotes() {                        // patch every price on screen in place, no re-render
    document.querySelectorAll(".qx[data-q]").forEach((el) => { const q = Q.map[el.getAttribute("data-q")]; if (!q) return; const d = parseInt(el.getAttribute("data-nd") || "2", 10);
      const px = el.querySelector(".px"), de = el.querySelector(".delta"); if (px) px.textContent = fnum(q.last, d); if (de) { de.className = "delta " + cls(q.chg); de.innerHTML = `${arrow(q.chg)} ${fpct(q.chg)}`; } });
    document.querySelectorAll("[data-qstamp]").forEach((el) => { el.textContent = quoteStamp(); });
  }
  const etTime = (ts) => (ts ? new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }).format(new Date(ts * 1000)) : "–");
  const quoteStamp = () => (Q.liveAt ? `prices ${etTime(Q.liveAt)} ET · 15-min delayed` : Q.at ? `prices ${etTime(Q.at)} ET · from the last build` : "");
  // conviction: never a percentage. Three words, from the model's own spread of answers.
  const CONV = { high: ["HIGH", "the model's answers pile onto one outcome"], med: ["MED", "one outcome leads, but not by much"], low: ["LOW", "the answers are spread out; treat this as a lean, not a call"] };
  const convOf = (c) => (isNum(c) ? (c >= 0.7 ? "high" : c >= 0.5 ? "med" : "low") : "low");
  const convTag = (lvl) => { const k = CONV[lvl] ? lvl : convOf(lvl); return `<span class="conv conv-${k}" title="Conviction ${CONV[k][0]}: ${CONV[k][1]}">${CONV[k][0]}</span>`; };
  // verdictFor(record) -> {word, cls, plain, why[], conviction, kind, code}; the server decides by asset class, the client only falls back for old data
  const ETF_KINDS = new Set(["ETF", "Index", "Fund"]);
  function verdictFor(s) {
    if (!s) return null;
    if (s.verdict && s.verdict.word) return s.verdict;
    const t = s.technicals || {};
    if (ETF_KINDS.has(s.kind)) { const tr = t.trend; const m = { up: ["TREND UP", "up", "Rising trend. Buying dips toward the 20-day average has worked; do not chase a spike."], down: ["TREND DOWN", "down", "Falling trend. Bounces have been sold; wait for it to reclaim its averages."] }[tr] || ["RANGE", "flat", "Moving sideways. Buy near the low end of the range, sell near the top, or wait for a break."];
      return { kind: "etf", code: tr === "up" ? "trend_up" : tr === "down" ? "trend_down" : "range", word: m[0], cls: m[1], plain: m[2], conviction: tr ? "high" : "med", why: whyFallback(s) }; }
    const a = s.ai || {}; if (!a.stance) return null;
    const st = a.stance.choice; return { kind: "stock", code: st, word: ST.stance[st][0], cls: ST.cls[st], plain: ST.stance[st][1], conviction: convOf(a.stance.confidence), why: whyFallback(s) };
  }
  function whyFallback(s) {
    const t = s.technicals || {}, a = s.ai || {}, out = [];
    if (a.main_reason) out.push("Mainly " + ST.reason[a.main_reason.choice] + ".");
    if (t.trend === "up") out.push("Trend up: it trades above its 20- and 50-day averages."); else if (t.trend === "down") out.push("Trend down: it trades below its 20- and 50-day averages.");
    if (isNum(t.dist_sma20_pct) && Math.abs(t.dist_sma20_pct) >= 8) out.push(`${t.dist_sma20_pct > 0 ? "Stretched" : "Oversold"}: ${Math.abs(t.dist_sma20_pct).toFixed(0)}% ${t.dist_sma20_pct > 0 ? "above" : "below"} its 20-day average.`);
    if (isNum(s.rel_volume) && s.rel_volume >= 1.5) out.push(`Trading activity is ${s.rel_volume.toFixed(1)}x normal.`);
    if (isNum(t.ret_5d) && out.length < 2) out.push(`${t.ret_5d >= 0 ? "Up" : "Down"} ${Math.abs(t.ret_5d).toFixed(1)}% over the past week.`);
    return out.slice(0, 4);
  }
  const whyHtml = (v, n) => (v && v.why && v.why.length ? `<ul class="why">${v.why.slice(0, n || 4).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
  const verdictBlock = (s, opts) => {                  // the one verdict renderer: word, plain meaning, conviction, why
    const v = verdictFor(s); const o = opts || {};
    if (!v) return `<div class="verdict none"><div class="verdict-word">${analyzing.has(s.ticker) ? "ANALYSING" : "NO VERDICT"}</div><div class="verdict-why">${analyzing.has(s.ticker) ? "The model is reading this name now." : "No model stance for this build yet."}</div><div class="verdict-meta"></div></div>`;
    const a = s.ai || {}; const it = a.intraday && !o.noIntraday ? ST.intraday[a.intraday.choice] : null;
    return `<div class="verdict ${v.cls}"><div class="verdict-word">${v.word}</div><div class="verdict-why">${esc(v.plain)}</div>${o.noWhy ? "" : whyHtml(v, o.whyN)}<div class="verdict-meta">${convTag(v.conviction)}${v.kind === "etf" ? '<span class="tag acc" title="Index and sector funds get a trend or range bias, never a buy or avoid call">fund · trend read</span>' : v.kind === "large" ? '<span class="tag acc" title="Large companies get a momentum-and-activity read">large cap · momentum read</span>' : ""}${it ? `<span class="pill ${it[2]}">Today · ${it[0]}</span>` : ""}</div></div>`;
  };
  // Plain-English glossary: hover any underlined term.
  const G = {
    atr: "Average True Range: how much the stock typically moves in a day. Higher = wilder.",
    rsi: "RSI (0–100): momentum gauge. Above 70 = stretched to the upside, below 30 = beaten down.",
    sma: "Moving average: the average price over the last N days. Price above it = trend is up.",
    relvol: "Relative volume: today's trading volume versus a normal day. Above 1× = more people trading it than usual.",
    vix: "VIX: the market's fear gauge, built from option prices. Falling = calmer, rising = nervous.",
    spread2s10s: "2s10s: 10-year yield minus 2-year yield. Below zero (inverted) has historically preceded recessions.",
    curve: "Yield curve: what the government pays to borrow for 1 month up to 30 years. Its shape says what bond traders expect.",
    breadth: "Breadth: how many stocks are joining the move. A rally with weak breadth is a few big names doing all the work.",
    pivot: "Pivot points: levels computed from yesterday's high, low and close that intraday traders watch for bounces and breaks.",
    beta: "Beta: how much a stock moves relative to the S&P 500. Beta 2 = roughly twice the market's swings.",
    shortfloat: "Short % of float: share of tradable shares sold short. High values can fuel sharp squeezes upward.",
    gap: "Gap: the jump between yesterday's close and the latest price outside regular hours.",
    swing: "Swing trade: holding for a few days to a couple of weeks.",
    day: "Day trade: in and out within one session.",
    structure: "Market structure: the sequence of swing highs and lows. Higher highs and higher lows = uptrend; lower highs and lower lows = downtrend.",
    candle: "A candle shows one day's open, high, low and close. Where it closes inside its range tells you who won the day.",
    closeloc: "Close location: 100% = closed at the day's high (buyers won), 0% = closed at the low (sellers won).",
    swinglvl: "Swing high / low: a local peak or trough on the chart. Traders treat them as resistance and support.",
    rr: "Reward-to-risk: how much you stand to gain at the target for each dollar risked to the stop. 2× or better is the usual bar.",
  };
  const term = (key, label) => `<abbr class="term" title="${esc(G[key] || "")}">${label}</abbr>`;
  // What each model answer means, in one sentence.
  const EX = {
    tone: { risk_on: "Buyers are in control: futures up, fear gauge down. Dips are more likely to get bought.", risk_off: "Sellers are in control: futures down or fear rising. Rallies are more likely to get sold.", mixed: "Signals disagree. Expect choppy trade until something breaks the tie." },
    vol: ["Calm day expected. Ranges should stay small.", "A normal day. Two-way trade, nothing extraordinary on the calendar.", "Expect bigger swings. There is a catalyst or a large overnight move in play.", "Extreme conditions. Size down and expect gaps."],
    driver: { fed_rates: "The Fed and bond yields are steering everything today.", macro_data: "Economic data is the story.", earnings: "Company results are setting the tone.", ai_tech: "AI and big tech are the story.", geopolitics: "Politics and trade headlines are moving prices.", energy_commodities: "Oil, metals or commodities are leading.", crypto: "Crypto is setting the mood.", deals: "Deal news is the driver.", regulatory_legal: "Regulation or court news is the driver.", no_dominant_driver: "No single story. A technical, flow-driven day." },
    lead: { mega_cap_tech: "The biggest tech names should lead.", semis: "Chip stocks should lead.", small_caps_cyclicals: "Small caps and cyclicals should lead.", financials: "Banks and brokers should lead.", energy_materials: "Energy and materials should lead.", healthcare_biotech: "Healthcare and biotech should lead.", consumer: "Consumer names should lead.", defensives: "Defensive sectors should hold up best.", crypto_linked: "Crypto-linked stocks should lead.", unclear: "No group stands out." },
    rates: { tailwind: "Bond yields are easing, which helps stocks, especially growth names.", headwind: "Yields are rising, which pressures stock valuations.", neutral: "Rates are not a big factor today.", growth_scare: "Yields are dropping because growth looks weak. Good for bonds and defensives, bad for cyclicals." },
    flow: { into_growth_tech: "Money is crowding into big tech and chips.", into_cyclicals_small_caps: "Money is moving into small caps and economy-sensitive stocks.", into_defensives: "Money is hiding in staples, utilities and gold.", into_bonds_cash: "Money is leaving stocks for bonds and cash.", broad_risk_on: "Money is flowing into almost everything.", broad_risk_off: "Money is leaving almost everything.", mixed: "No clear direction in the flows." },
    bias: { long: "Leaning higher over the next few days.", short: "Leaning lower over the next few days.", neutral: "No clear direction. Wait for a better setup." },
    setup: { breakout: "Pushing through recent highs. Momentum traders chase these.", pullback_in_uptrend: "Healthy dip inside an uptrend. Classic buy-the-dip zone.", breakdown: "Falling through recent lows. Momentum is to the downside.", bounce_in_downtrend: "Bouncing inside a downtrend. Often short-lived.", extended_reversal_risk: "Ran too far, too fast. Chasing here is risky.", range: "Bouncing between the same levels. Buy low, sell high inside the box.", news_gap: "Jumped on fresh news. The story matters more than the chart.", no_clear_setup: "Nothing actionable right now." },
    day: ["Too quiet to day trade.", "Tradeable, but nothing special today.", "In play today: enough movement and a reason to watch it.", "Prime day-trade candidate: big range, volume and a fresh catalyst."],
    swing: ["No edge for a multi-day hold.", "Marginal swing setup.", "Reasonable swing setup with a clear line in the sand.", "High-quality swing setup: strong trend and a clear stop."],
    catalyst: { earnings: "Just reported earnings.", preannouncement_guidance: "Changed its guidance.", analyst_action: "An analyst upgraded or downgraded it.", deal: "Deal or partnership news.", regulatory_legal: "Regulatory or legal news.", offering_dilution: "Selling new shares (dilution).", sympathy_macro: "Moving with its sector or the macro tape, not its own news.", technical_only: "No news. It is moving on technicals alone." },
  };
  const explain = (t) => `<div class="explain">${t}</div>`;
  const ST = {
    stance: { buy_now: ["BUY", "Everything lines up: trend, structure, candle and entry agree, with room to the target."], buy_the_dip: ["BUY THE DIP", "Strong stock, but it has run too far to chase. Wait for a pullback toward the 20-day average or the named support."], wait_for_breakout: ["WAIT FOR BREAKOUT", "Constructive, but capped under a level. A close through it is the trigger."], hold_dont_add: ["HOLD, DON'T ADD", "If you own it, keep it with a stop. New money has no edge here."], avoid: ["AVOID", "Reads conflict, an event is near, or informed money is selling. No trade."], short_setup: ["SHORT SETUP", "Downtrend with sellers in control and a clean short entry."] },
    reason: { trend_and_entry: "because of the trend and the entry", extended: "because it has run too far from its averages", resistance: "because of overhead resistance", event_risk: "because of a dated event ahead", smart_money: "because of who is buying or selling", options_flow: "because of the options flow", volume: "because of the intraday volume picture", market_tone: "because of the market mood", poor_reward: "because the reward does not justify the risk" },
    cls: { buy_now: "up", buy_the_dip: "up2", wait_for_breakout: "flat", hold_dont_add: "flat", avoid: "down", short_setup: "down" },
    intraday: { long_momentum: ["LONG MOMENTUM", "Buy strength through yesterday's high on above-normal volume.", "up"], buy_dip_to_support: ["BUY DIP TO SUPPORT", "Buy the first pullback to the pivot or yesterday's high.", "up2"], short_momentum: ["SHORT MOMENTUM", "Short weakness through yesterday's low with sellers in control.", "down"], fade_the_gap: ["FADE THE GAP", "Extended on light volume; fade back toward the pivot.", "down"], range_scalp: ["RANGE SCALP", "Trade between yesterday's high and low; no directional edge.", "flat"], no_trade: ["NO TRADE", "Too quiet, too erratic or an event pending.", "flat"] },
  };
  const words = (v, max, labels) => labels[Math.min(labels.length - 1, Math.floor((v / max) * labels.length))];
  const SCORE_WORDS = ["weak", "modest", "good", "strong"];
  function whoIsBuying(s) {
    const m = s.smart; if (!m) return null;
    const ins = m.insider || {}, inst = m.institutions || {}, sh = m.short || {}, cg = m.congress || [];
    const buys = ins.open_market_buys_90d || [];
    const parts = [];
    if (buys.length) { const b = buys[0]; parts.push({ ok: true, t: `Insiders: YES. ${b.insider} (${(b.position || "").toLowerCase()}) bought ${isNum(b.value) && b.value ? fcap(b.value) : fvol(b.shares) + " sh"} on ${b.date}${buys.length > 1 ? `, ${buys.length} buys in 90 days` : ""}.` }); }
    else if ((ins.sell_value_90d || 0) > 0) parts.push({ ok: false, t: `Insiders: NO, selling. ${fcap(ins.sell_value_90d)} sold on the open market in 90 days.` });
    else parts.push({ ok: null, t: "Insiders: quiet. No open-market buys or sales in 90 days." });
    if (isNum(inst.top10_avg_change)) parts.push({ ok: inst.top10_avg_change > 0.01, t: `Institutions: ${inst.top10_avg_change > 0.01 ? "YES, adding" : inst.top10_avg_change < -0.01 ? "NO, trimming" : "flat"}. Top-10 holders ${fpct(inst.top10_avg_change * 100, 1)} last quarter, ${isNum(inst.pct_held) ? (inst.pct_held * 100).toFixed(0) + "% of shares held" : ""}.` });
    const cbuys = cg.filter((c) => c.type === "buy");
    parts.push(cbuys.length ? { ok: true, t: `Congress: YES. ${cbuys.map((c) => c.name.split(" ").slice(-1)[0]).slice(0, 2).join(", ")} bought (${cbuys[0].size}).` } : { ok: null, t: "Congress: no reported buys in 90 days." });
    if (isNum(sh.change_pct)) parts.push({ ok: sh.change_pct < 0, t: `Shorts: ${sh.change_pct > 5 ? "betting against it, up" : sh.change_pct < -5 ? "backing off, down" : "steady,"} ${fpct(sh.change_pct, 0)} this month${isNum(sh.short_pct_float) ? ` (${(sh.short_pct_float * 100).toFixed(1)}% of float)` : ""}.` });
    return parts;
  }
  const whoHtml = (s) => { const w = whoIsBuying(s); if (!w) return ""; return `<ul class="who">${w.map((p) => `<li class="${p.ok === true ? "yes" : p.ok === false ? "no" : "na"}">${esc(p.t)}</li>`).join("")}</ul>`; };
  const HZ = {
    regime: { strong_uptrend: "Strong uptrend across horizons.", uptrend_pulling_back: "Uptrend, currently pulling back.", range: "Going sideways in a range.", topping: "Momentum rolling over near the highs.", downtrend: "Downtrend across horizons.", bottoming: "Turning up from the lows." },
    alignment: { all_up: "Short and long horizons agree: up.", all_down: "Short and long horizons agree: down.", short_up_long_down: "Bouncing inside a longer decline.", short_down_long_up: "Dipping inside a longer rise.", mixed: "Horizons disagree." },
    strength: ["No trend.", "Mild trend with real pullbacks.", "Strong, consistent trend.", "Extreme: parabolic or capitulating."],
    macro: { growth_boom: "Growth boom: stocks and oil up, yields rising with the economy, gold lagging.", disinflation_rally: "Disinflation rally: stocks up while yields and oil fall; the market is pricing easier money.", inflation_scare: "Inflation scare: yields and oil up while stocks stall; gold holding.", growth_scare: "Growth scare: yields, stocks and oil all falling; gold bid as a haven.", liquidity_melt_up: "Liquidity melt-up: stocks and gold both up strongly; everything except cash is rising.", risk_off: "Risk-off: stocks down, gold up, yields down.", mixed: "No coherent macro story across the five." },
    lean: { higher: "Cross-asset picture leans higher for stocks over three months.", sideways: "Cross-asset picture leans sideways: stretched stocks against rising yields or oil.", lower: "Cross-asset picture leans lower: equity trend weakening with a rates or oil headwind." },
    risk: { rates: "Rising yields are the biggest threat to the equity trend.", oil: "An oil shock is the biggest threat.", extension: "Stocks are stretched after a long run; that is the biggest risk.", growth: "Weakening growth is the biggest risk.", none_obvious: "No single risk stands out." },
  };
  const PA = {
    structure: { uptrend_hh_hl: "Uptrend: higher highs and higher lows.", downtrend_lh_ll: "Downtrend: lower highs and lower lows.", expanding_hh_ll: "Whipsaw: higher highs but lower lows; range is widening.", contracting_lh_hl: "Coiling: lower highs and higher lows; a break is coming.", mixed: "No clean structure.", undefined: "Not enough swings to judge.", breakout_from_downtrend_lh_ll: "Breaking out: price just cleared the last swing high after a run of lower highs; trend may be turning up.", breakout_from_expanding_hh_ll: "Breaking out of a whipsaw range to the upside.", breakdown_from_uptrend_hh_hl: "Breaking down: price just lost the last swing low after a run of higher lows; trend may be turning down.", breakdown_from_expanding_hh_ll: "Breaking down out of a whipsaw range." },
    control: { buyers_in_control: "Buyers are in control.", sellers_in_control: "Sellers are in control.", buyers_exhausting: "Buyers are tiring; the rise is losing conviction.", sellers_exhausting: "Sellers are tiring; the drop is losing conviction.", indecision: "Nobody is pressing; wait for a decisive candle." },
    entry: ["No entry here.", "Early; wait for a confirming close.", "Reasonable entry at a level.", "Textbook entry: everything lines up."],
  };

  // Before-you-take-the-position checklist: code rules over data the model and technicals already produced.
  function checklist(s, r) {
    const a = s.ai, t = s.technicals, pa = s.price_action || {}, f = s.fundamentals || {};
    if (!a) return null;
    const lean = a.bias.choice;
    if (lean === "neutral") return { lean, items: [], passed: 0, total: 0, verdict: "wait", text: "No lean, so no checklist. Wait for a break of the range." };
    const long = lean === "long";
    const pl = plan(s);
    const tone = r.regime ? r.regime.tone.choice : "mixed";
    const items = [
      { ok: t.trend === (long ? "up" : "down"), label: "Trend agrees", why: `price is ${t.trend === "up" ? "above" : t.trend === "down" ? "below" : "mixed against"} its 20/50/200-day averages` },
      { ok: pa.structure === (long ? "uptrend_hh_hl" : "downtrend_lh_ll"), label: "Structure agrees", why: PA.structure[pa.structure] || "structure unclear" },
      { ok: tone === (long ? "risk_on" : "risk_off"), label: "Market mood agrees", why: `market is ${pretty(tone)}` },
      { ok: a.extended.p < 0.6 && isNum(t.dist_sma20_pct) && isNum(t.atr_pct) && Math.abs(t.dist_sma20_pct) <= 2 * t.atr_pct, label: "Not chasing", why: `${fpct(t.dist_sma20_pct, 1)} from the 20-day average; extended ${(a.extended.p * 100).toFixed(0)}%` },
      { ok: pa.direction === (long ? "up" : "down") && (long ? pa.close_location >= 0.6 : pa.close_location <= 0.4), label: "Last candle agrees", why: `${pretty(pa.pattern || "ordinary")} candle, closed ${isNum(pa.close_location) ? (pa.close_location * 100).toFixed(0) + "% up its range" : "–"}` },
      { ok: isNum(pa.volume_vs_avg) && pa.volume_vs_avg >= 1.0, label: "Volume backs it", why: `${isNum(pa.volume_vs_avg) ? pa.volume_vs_avg.toFixed(2) + "× average volume" : "volume unknown"}` },
      { ok: !!pl && pl.rr >= 1.5, label: "Room to run", why: pl && isNum(pl.rr) ? `reward ${pl.rr.toFixed(1)}× the risk` : "no plan" },
      { ok: a.event_risk.p < 0.6 && !(isNum(f.days_to_earnings) && f.days_to_earnings >= 0 && f.days_to_earnings <= 5), label: "No event this week", why: isNum(f.days_to_earnings) && f.days_to_earnings >= 0 ? `earnings in ${f.days_to_earnings} days` : "nothing scheduled" },
      { ok: isNum(t.rsi14) && (long ? t.rsi14 < 70 : t.rsi14 > 30), label: "RSI not at an extreme", why: `RSI ${fnum(t.rsi14, 0)}` },
      { ok: a.entry_quality ? a.entry_quality.score >= 2 : false, label: "Clean entry", why: a.entry_quality ? PA.entry[Math.round(a.entry_quality.score)] : "no read" },
    ];
    const passed = items.filter((i) => i.ok).length;
    const verdict = passed >= 8 ? "ready" : passed >= 6 ? "almost" : "not_yet";
    const text = { ready: "Ready: most boxes are ticked.", almost: "Almost: fix the open items or size down.", not_yet: "Not yet: too many boxes open." }[verdict];
    return { lean, items, passed, total: items.length, verdict, text };
  }
  const checklistHtml = (ck, full) => {
    if (!ck) return "";
    if (!ck.items.length) return `<div class="ck ck-wait">${esc(ck.text)}</div>`;
    const rows = ck.items.map((i) => `<li class="${i.ok ? "ok" : "no"}"><span class="ck-mark" aria-hidden="true">${i.ok ? '<svg viewBox="0 0 12 12"><path d="M2.5 6.5 5 9l4.5-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '<svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'}</span><span class="ck-label">${i.label}</span><span class="ck-why">${esc(i.why)}</span></li>`).join("");
    return `<details class="ck ck-${ck.verdict}" ${full ? "open" : ""}><summary><span class="ck-score">${ck.passed}/${ck.total}</span> <b>${{ ready: "Ready", almost: "Almost", not_yet: "Not yet" }[ck.verdict]}</b> <span class="muted">${esc(ck.text)} · checklist</span></summary><ul>${rows}</ul></details>`;
  };
  const pretty = (k) => String(k || "").replace(/_/g, " ");
  const conf = () => "";                            // confidence is shown as a LOW / MED / HIGH word (convTag), never a percentage
  const bar = (v, max, extra) => `<span class="bar" title="${esc(extra || "")}"><span class="bar-fill" style="width:${Math.max(0, Math.min(1, v / max)) * 100}%"></span></span>`;
  const timeET = (iso) => (iso && iso.length >= 16 ? iso.slice(5, 10) + " " + iso.slice(11, 16) : "");

  function spark(values, cl) {
    const v = (values || []).filter(isNum);
    if (v.length < 2) return "";
    const w = 120, h = 32, lo = Math.min(...v), hi = Math.max(...v), r = hi - lo || 1;
    const pts = v.map((x, i) => `${(i / (v.length - 1) * (w - 2) + 1).toFixed(1)},${(h - 1 - (x - lo) / r * (h - 2)).toFixed(1)}`).join(" ");
    return `<svg class="spark ${cl || ""}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}"/></svg>`;
  }

  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  // ---------------------------------------------------------------- SVG charts
  function lineChart(series, opts) {
    // series: [{cls:"l1", points:[{x, y}]}], x numeric (index or tenor), opts: {w,h,xlabels:[{x,text}], yfmt, zero}
    const w = opts.w || 600, h = opts.h || 200, pl = 44, pr = 10, pt = 10, pb = 22;
    const all = series.flatMap((s) => s.points);
    if (!all.length) return "";
    const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
    let xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
    if (opts.zero) { ymin = Math.min(ymin, 0); ymax = Math.max(ymax, 0); }
    const pad = (ymax - ymin) * 0.08 || 1; ymin -= pad; ymax += pad;
    const X = (x) => pl + (x - xmin) / ((xmax - xmin) || 1) * (w - pl - pr);
    const Y = (y) => pt + (ymax - y) / ((ymax - ymin) || 1) * (h - pt - pb);
    let out = `<svg class="svgchart" viewBox="0 0 ${w} ${h}" role="img">`;
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const y = ymin + (ymax - ymin) * i / ticks;
      out += `<line class="grid" x1="${pl}" x2="${w - pr}" y1="${Y(y).toFixed(1)}" y2="${Y(y).toFixed(1)}"/><text x="${pl - 4}" y="${(Y(y) + 3).toFixed(1)}" text-anchor="end">${(opts.yfmt || ((v) => v.toFixed(1)))(y)}</text>`;
    }
    if (opts.zero && ymin < 0 && ymax > 0) out += `<line class="zero" x1="${pl}" x2="${w - pr}" y1="${Y(0)}" y2="${Y(0)}"/>`;
    (opts.xlabels || []).forEach((l) => { out += `<text x="${X(l.x).toFixed(1)}" y="${h - 6}" text-anchor="middle">${esc(l.text)}</text>`; });
    series.forEach((s) => {
      const d = s.points.map((p) => `${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ");
      if (s.area) out += `<polygon class="area" points="${X(s.points[0].x).toFixed(1)},${Y(opts.zero ? 0 : ymin).toFixed(1)} ${d} ${X(s.points[s.points.length - 1].x).toFixed(1)},${Y(opts.zero ? 0 : ymin).toFixed(1)}"/>`;
      out += `<polyline class="${s.cls}" points="${d}"/>`;
      if (s.dots) s.points.forEach((p) => { out += `<circle class="dot${s.cls.slice(1)}" cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="3"><title>${esc(p.title || "")}</title></circle>`; });
    });
    out += `<line class="axis" x1="${pl}" x2="${w - pr}" y1="${h - pb}" y2="${h - pb}"/></svg>`;
    return out;
  }

  // ---------------------------------------------------------------- candlestick (lightweight-charts)
  function candleChart(el, ohlc, levels, tall) {
    if (!window.LightweightCharts || !ohlc || !ohlc.length) { el.innerHTML = '<div class="muted" style="padding:20px">chart unavailable</div>'; return; }
    const dark = document.documentElement.getAttribute("data-theme") === "dark" || (!document.documentElement.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
    const chart = LightweightCharts.createChart(el, {
      height: tall ? 320 : 220, layout: { background: { color: "transparent" }, textColor: cssVar("--muted") || "#888", fontSize: 11 },
      grid: { vertLines: { color: dark ? "#26262a" : "#eeede9" }, horzLines: { color: dark ? "#26262a" : "#eeede9" } },
      rightPriceScale: { borderColor: cssVar("--border") }, timeScale: { borderColor: cssVar("--border"), timeVisible: false },
      crosshair: { mode: 0 }, handleScroll: false, handleScale: false,
    });
    const up = cssVar("--up"), down = cssVar("--down");
    const s = chart.addCandlestickSeries({ upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down });
    s.setData(ohlc.map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c })));
    const vol = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol", color: cssVar("--flat") });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    vol.setData(ohlc.map((b) => ({ time: b.t, value: b.v, color: b.c >= b.o ? up + "66" : down + "66" })));
    const sma = (n) => { const out = []; for (let i = n - 1; i < ohlc.length; i++) { let a = 0; for (let j = i - n + 1; j <= i; j++) a += ohlc[j].c; out.push({ time: ohlc[i].t, value: a / n }); } return out; };
    if (ohlc.length >= 20) chart.addLineSeries({ color: cssVar("--s1"), lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(sma(20));
    if (ohlc.length >= 50) chart.addLineSeries({ color: cssVar("--s2"), lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(sma(50));
    (levels || []).forEach((l) => { if (isNum(l.price)) s.createPriceLine({ price: l.price, color: l.color || cssVar("--muted"), lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: l.title }); });
    chart.timeScale().fitContent();
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    charts.push({ chart, ro });
  }
  function destroyCharts() { charts.forEach((c) => { try { c.ro.disconnect(); c.chart.remove(); } catch (e) {} }); charts = []; }

  // ---------------------------------------------------------------- action board (top of page)
  function plan(s) {
    const t = s.technicals, a = s.ai, px = qp(s.ticker, s).last;      // the same price every other view shows
    if (!a || !isNum(px)) return null;
    const lean = a.bias.choice, atr = t.atr14 || px * 0.02;
    if (lean === "neutral") return { lean, text: `No trigger yet. It is boxed between ${fnum(t.lo20)} and ${fnum(t.hi20)}. Wait for a close outside that range.` };
    // Stop: the nearest structural level on the risk side (yesterday's extreme or the 20-day average),
    // never more than two ATRs away. Target: the 20-day extreme, or two ATRs if price is already there.
    let stop, target;
    if (lean === "long") {
      const below = [t.prev_low, t.sma20].filter((v) => isNum(v) && v < px);
      stop = below.length ? Math.max(...below) : px - 1.5 * atr;
      if (px - stop > 2 * atr) stop = px - 2 * atr;
      target = isNum(t.hi20) && t.hi20 > px * 1.01 ? t.hi20 : px + 2 * atr;
    } else {
      const above = [t.prev_high, t.sma20].filter((v) => isNum(v) && v > px);
      stop = above.length ? Math.min(...above) : px + 1.5 * atr;
      if (stop - px > 2 * atr) stop = px + 2 * atr;
      target = isNum(t.lo20) && t.lo20 < px * 0.99 ? t.lo20 : px - 2 * atr;
    }
    const risk = Math.abs(px - stop), reward = Math.abs(target - px), rr = risk ? reward / risk : 0;
    const verdict = rr >= 2 ? "good odds" : rr >= 1.2 ? "fair odds" : "poor odds right here; wait for a pullback";
    return { lean, stop, target, risk, reward, rr,
      text: `${lean === "long" ? "Buy" : "Short"} near ${fnum(px)} · stop ${fnum(stop)} (${fpct((stop / px - 1) * 100, 1)}) · target ${fnum(target)} (${fpct((target / px - 1) * 100, 1)}) · reward ${rr.toFixed(1)}× the risk: ${verdict}` };
  }

  function nowStrip(s, r) {
    const sc = s.scan, t = s.technicals || {}, ms = (r || report || {}).market_state;
    const when = { open: "live", pre: "pre-market", post: "after hours", closed: "last session" }[ms] || ms;
    const bits = [];
    if (sc) { bits.push(`<span>${isNum(sc.rvol_tod) ? `<b>${sc.rvol_tod.toFixed(1)}×</b> volume for this time of day` : "volume n/a"}</span>`);
      if (sc.above_vwap != null) bits.push(`<span class="${sc.above_vwap ? "up" : "down"}">${sc.above_vwap ? "above" : "below"} VWAP</span>`);
      if (isNum(sc.range_pos)) bits.push(`<span>${(sc.range_pos * 100).toFixed(0)}% of day range</span>`);
      bits.push(`<span>volume build <b>${sc.score.toFixed(0)}</b>/100 on ${sc.lead}</span>`); }
    else if (isNum(s.rel_volume)) bits.push(`<span><b>${s.rel_volume.toFixed(1)}×</b> normal volume</span>`);
    else bits.push(`<span class="muted">no intraday volume read for this name</span>`);
    bits.push(`<span>vs yesterday: ${isNum(t.prev_high) && isNum(s.last_price) ? (s.last_price > t.prev_high ? '<b class="up">above the high</b>' : s.last_price < t.prev_low ? '<b class="down">below the low</b>' : "inside the range") : "–"}</span>`);
    return `<div class="wc-now"><span class="wc-now-k">${when}</span>${bits.join('<i class="sep"></i>')}</div>`;
  }
  function watchCard(s, compact, r) {
    const a = s.ai || {}, t = s.technicals, c = cls(s.chg_pct), pa = s.price_action || {};
    const lean = a.bias ? a.bias.choice : "neutral";
    const leanCls = { long: "up", short: "down" }[lean] || "flat";
    const pl = plan(s);
    const flags = s.tags.filter((x) => x === "event_risk" || x === "extended").map(tagHtml).join("");
    const earn = s.fundamentals && isNum(s.fundamentals.days_to_earnings) && s.fundamentals.days_to_earnings >= 0 && s.fundamentals.days_to_earnings <= 10 ? `<span class="tag warn">earnings in ${s.fundamentals.days_to_earnings}d</span>` : "";
    const st = a.stance ? a.stance.choice : null;
    const it = a.intraday ? ST.intraday[a.intraday.choice] : null;
    const stCls = st ? ST.cls[st] : "none";
    const verdict = verdictBlock(s, { whyN: 3 });
    const who = whoHtml(s);
    return `<article class="wcard ${leanCls} st-${stCls}" data-ticker="${esc(s.ticker)}">
      <div class="wc-head"><div class="wc-id"><button class="wc-ticker lnk-t" data-ticker-page="${esc(s.ticker)}" title="Open ${esc(s.ticker)}'s page">${esc(s.ticker)}</button><span class="wc-name" title="${esc(s.name)}">${esc(s.name)}</span></div><div class="wc-price">${priceHtml(s.ticker, s)}${compact ? "" : `<button class="wc-x" data-remove="${esc(s.ticker)}" title="Remove from this list">×</button>`}</div></div>
      ${verdict}
      ${nowStrip(s, r)}
      <div class="wc-lean"><span class="lean ${leanCls}">${lean.toUpperCase()}</span><span class="wc-leansub">${a.bias ? convTag(a.bias.confidence) : "no model read"} · ${a.setup ? pretty(a.setup.choice) : "–"}</span></div>
      <div class="wc-scores"><span title="Swing setup quality, 0–100"><i>Swing</i><b>${words(s.scores.swing, 1.0001, SCORE_WORDS)}</b><em class="mono">${(s.scores.swing * 100).toFixed(0)}</em></span><span title="Day-trade fit, 0–100"><i>Day trade</i><b>${words(s.scores.day, 1.0001, SCORE_WORDS)}</b><em class="mono">${(s.scores.day * 100).toFixed(0)}</em></span><span title="Average daily move"><i>Moves</i><b class="mono">${fpct(t.atr_pct, 1, false)}</b><em>a day</em></span></div>
      <div class="wc-who"><div class="wc-who-h">Who is buying</div>${who || '<ul class="who"><li class="na">No smart-money data for this name.</li></ul>'}</div>
      <div class="wc-read">${a.price_action ? `<div class="wc-pa">${PA.control[a.price_action.choice] || ""} ${PA.structure[pa.structure] || ""} Last candle: ${pretty(pa.pattern || "ordinary")}.</div>` : '<div class="wc-pa muted">No price-action read.</div>'}${pl ? `<div class="wc-plan ${pl.lean}">${pl.text}</div>` : '<div class="wc-plan">No plan: the model has no lean here.</div>'}</div>
      ${checklistHtml(checklist(s, r || report))}
      <div class="wc-foot"><div class="wc-flags">${earn}${flags}${smBadge(s)}${opBadge(s)}</div><div class="wc-actions"><button class="btn sm" data-open="${esc(s.ticker)}">Full analysis</button><a class="btn sm ghost" href="${tvLink(s.ticker)}" target="_blank" rel="noopener">Chart</a></div></div>
    </article>`;
  }

  function plainFacts(r) {
    const out = [];
    const m = (r.macro || []).map((x) => ({ ...x, chg_pct: qchg(x) })); const find = (re) => m.find((x) => re.test(x.label || "") || re.test(x.symbol || ""));
    const es = find(/S&P/i), vix = find(/VIX/i), tnx = find(/10Y|10-year/i), dxy = find(/Dollar/i), oil = find(/Oil|WTI|Crude/i), gold = find(/Gold/i);
    if (es && isNum(es.chg_pct)) out.push({ k: "S&P futures", v: fpct(es.chg_pct), c: cls(es.chg_pct), t: es.chg_pct >= 0.5 ? "Buyers are pressing before the open; dips are more likely to get bought." : es.chg_pct <= -0.5 ? "Sellers have the upper hand before the open; bounces are more likely to get sold." : "No lead from overnight; the open will set the tone." });
    if (vix && isNum(vix.last)) { const mv = vix.last / 15.9; out.push({ k: "VIX", v: fnum(vix.last, 1), c: vix.last < 15 ? "up" : vix.last < 20 ? "flat" : "down", t: (vix.last < 15 ? "The market is calm: a normal day moves about " : vix.last < 20 ? "Ordinary nerves: a normal day moves about " : vix.last < 30 ? "The market is nervous: expect swings of about " : "Fear is high: swings of about ") + mv.toFixed(1) + "% on the S&P." }); }
    if (tnx && isNum(tnx.last)) { const bp = isNum(tnx.chg_pct) ? tnx.chg_pct : null; out.push({ k: "10-year yield", v: fnum(tnx.last, 2) + "%", c: bp == null ? "flat" : bp > 0 ? "down" : "up", t: bp != null && Math.abs(bp) >= 1 ? (bp > 0 ? "Borrowing costs rose: a headwind for growth and tech valuations today." : "Yields eased: cheaper money, a tailwind for growth stocks today.") : "Rates are steady: not a factor for stocks today." }); }
    if (dxy && isNum(dxy.chg_pct) && Math.abs(dxy.chg_pct) >= 0.3) out.push({ k: "Dollar", v: fpct(dxy.chg_pct), c: cls(-dxy.chg_pct), t: dxy.chg_pct > 0 ? "A stronger dollar weighs on commodities and companies that sell abroad." : "A weaker dollar helps commodities, gold and exporters." });
    if (oil && isNum(oil.chg_pct) && Math.abs(oil.chg_pct) >= 1.5) out.push({ k: "Oil", v: fpct(oil.chg_pct), c: cls(oil.chg_pct), t: oil.chg_pct > 0 ? "Oil jumped: energy stocks benefit, inflation worries rise." : "Oil fell: relief for airlines and consumers, pressure on energy names." });
    if (gold && isNum(gold.chg_pct) && Math.abs(gold.chg_pct) >= 1) out.push({ k: "Gold", v: fpct(gold.chg_pct), c: cls(gold.chg_pct), t: gold.chg_pct > 0 ? "Money is looking for safety." : "Less demand for safety today." });
    const W = (r.world || []).map((x) => ({ ...x, chg_pct: qp(x.symbol, x).chg })).filter((x) => isNum(x.chg_pct));
    if (W.length) { const asia = W.filter((x) => ["Japan", "Hong Kong", "China", "Korea", "India", "Australia"].includes(x.region)), eu = W.filter((x) => ["UK", "Germany", "Europe"].includes(x.region));
      const tone = (g) => { const u = g.filter((x) => x.chg_pct > 0.2).length, d = g.filter((x) => x.chg_pct < -0.2).length; return u > d ? "up" : d > u ? "down" : "mixed"; };
      const up = W.filter((x) => x.chg_pct > 0.2).length, dn = W.filter((x) => x.chg_pct < -0.2).length;
      out.push({ k: "Overseas", v: `Asia ${tone(asia)} · Europe ${tone(eu)}`, c: up > dn + 2 ? "up" : dn > up + 2 ? "down" : "flat", t: (up > dn + 2 ? "Markets abroad are firm, which gives the US open a tailwind. " : dn > up + 2 ? "Selling abroad; expect a defensive US open. " : "No lead from abroad; the US sets its own tone. ") + W.slice(0, 6).map((x) => `${x.label} ${fpct(x.chg_pct, 1)}`).join(", ") }); }
    const B = (r.flows || {}).breadth; if (B && B.n) { const p = Math.round(B.above20 / B.n * 100); out.push({ k: "How many stocks are rising", v: p + "%", c: p >= 60 ? "up" : p <= 40 ? "down" : "flat", t: p >= 60 ? `${p}% of stocks are above their 20-day average: the move is broad, not a few big names.` : p <= 40 ? `Only ${p}% of stocks are above their 20-day average: strength is narrow and fragile.` : `${p}% of stocks are above their 20-day average: an even, choppy tape.` }); }
    const sp = (((r.rates || {}).spreads || {})["2s10s"] || {}).latest; if (isNum(sp)) out.push({ k: "Bond market signal", v: fbp(sp), c: sp < 0 ? "down" : "flat", t: sp < 0 ? "Short-term rates are above long-term rates (an inverted curve): bond traders are bracing for a slowdown." : "Long-term rates sit above short-term rates, the normal shape: no recession signal from bonds." });
    const S = (!STATIC_MODE && liveScan) || r.scan; if (S && isNum(S.qualified)) out.push({ k: "Volume scanner", v: String(S.qualified), c: S.qualified >= 20 ? "up" : "flat", t: `${S.qualified} names are trading far more than usual ${S.market_state === "open" ? "right now" : "in the last session"}; see SCAN for the list.` });
    const lf = ((r.low_float || {}).rows || []).filter((x) => isNum(x.float_turnover) && x.float_turnover >= 1).length; if (lf) out.push({ k: "Thin stocks running", v: String(lf), c: "down", t: `${lf} small, thinly traded names have changed hands more than once over today: big swings and trading halts are likely there.` });
    return out;
  }
  function secMeaning(r) {
    const f = plainFacts(r); if (!f.length) return "";
    return `<section class="meaning"><h3>What today's numbers mean</h3><div class="mean-grid">${f.map((x) => `<div class="mean-row"><span class="mean-k">${esc(x.k)}</span><span class="mean-v mono ${x.c}">${x.v}</span><span class="mean-t">${esc(x.t)}</span></div>`).join("")}</div></section>`;
  }
  function playbook(r) {
    const g = r.regime; if (!g) return "";
    const tone = g.tone.choice, vol = Math.round(g.volatility.score), lead = g.leadership.choice, rates = g.rates_read.choice;
    const B = (r.flows || {}).breadth; const bp = B && B.n ? Math.round(B.above20 / B.n * 100) : null;
    const S = (!STATIC_MODE && liveScan) || r.scan; const nq = S && isNum(S.qualified) ? S.qualified : null;
    const vix = (r.macro || []).find((x) => /VIX/i.test(x.label || "")); const mv = vix && isNum(vix.last) ? (vix.last / 15.9).toFixed(1) : null;
    const day = [
      tone === "risk_on" ? "Buy strength: longs through yesterday's high on above-normal volume; avoid shorting dips." : tone === "risk_off" ? "Sell strength: short pops into resistance and fade gaps; do not buy the first dip." : "No lead: trade the range between yesterday's high and low, and wait for the first 30 minutes.",
      mv ? `Size for a ${mv}% day on the S&P${vol >= 2 ? "; ranges will be wide, so stops need room" : "; ranges should stay ordinary"}.` : "",
      nq != null ? `${nq} names have unusual volume right now: start in SCAN, take the ones above VWAP with a breakout read.` : "",
      leadingSector(r) ? `Leadership: ${leaderLabel(r)}. Trade in that group first.` : (lead && lead !== "unclear" ? `Leadership: ${pretty(lead)}. Trade in that group first.` : ""),
    ].filter(Boolean);
    const swing = [
      tone === "risk_on" ? "Add to the strongest names on pullbacks to the 20-day average; let winners run." : tone === "risk_off" ? "Cut losers, hold cash, and only take setups with a tight stop and 2× reward." : "Keep size small until the tone resolves; favour names with a clear level.",
      rates === "headwind" ? "Rates are a headwind: lean away from long-duration growth, toward names with earnings now." : rates === "tailwind" ? "Rates are a tailwind: growth and tech setups get the benefit of the doubt." : rates === "growth_scare" ? "Growth scare: defensives and bonds first; wait on cyclicals." : "Rates are not the story this week.",
      bp != null ? (bp >= 60 ? `Breadth is broad (${bp}% above the 20-day): setups outside the leaders can work too.` : bp <= 40 ? `Breadth is narrow (${bp}% above the 20-day): stay with leaders; laggards keep lagging.` : `Breadth is middling (${bp}%): pick names, not the market.`) : "",
      "Check the verdicts on the right: buy-the-dip means wait for the pullback, not chase.",
    ].filter(Boolean);
    return `<div class="playbook"><div class="pb-col"><h4>Day trader</h4><ul>${day.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div><div class="pb-col"><h4>Swing trader</h4><ul>${swing.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div></div>`;
  }
  function moodPanel(r) {
    const g = r.regime; if (!g) return `<section class="panel mood flat"><h3>Market mood</h3><div class="muted">${r.ai_enabled === false || (r.ai_stats && r.ai_stats.calls === 0 && r.ai_stats.failures > 0) ? "The model reads did not run this build (the read service is unavailable or out of credits). Prices and scans are still live; reads return as soon as the service does." : "Model read unavailable this build."}</div></section>`;
    const volL = ["quiet", "normal", "elevated", "extreme"];
    const tone = g.tone.choice, cl = { risk_on: "up", risk_off: "down", mixed: "flat" }[tone];
    const fact = (label, value, c) => `<div class="fact"><span class="fact-l">${label}</span><span class="fact-v ${c || ""}">${value}</span></div>`;
    return `<section class="panel mood ${cl}">
      <h3>Market mood · ${esc(r.session_label.split(",")[0])}${r.ai_source === "rules" ? ` <span class="src-badge" title="The model read service was unavailable on this build (out of credits or down). These reads come from OneView's backup rules: the same facts, judged by fixed rules instead of the model. Conviction is capped at MED.">backup read · rules</span>` : r.ai_source === "mixed" ? ` <span class="src-badge" title="Some reads on this build came from the backup rules because the model service failed part-way.">part backup</span>` : ""}${r.ai_from ? ` <span class="muted" style="text-transform:none;letter-spacing:0" title="The read service was unavailable on the latest build, so the reads from the last good build are shown next to live prices">reads as of ${esc(String(r.ai_from).slice(11, 16))} ET</span>` : ""}</h3>
      <div class="mood-row"><span class="mood-tone">${pretty(tone).toUpperCase()}</span><span class="mood-conf">${convTag(g.tone.confidence)}</span></div>
      <p class="mood-why">${EX.tone[tone]}</p>
      <div class="facts">
        ${fact("Swings", volL[Math.round(g.volatility.score)], g.volatility.score >= 2 ? "warn" : "")}
        ${fact("Driver", pretty(g.driver.choice))}
        ${fact("Leading", esc(leaderLabel(r, pretty(g.leadership.choice))), leadingSector(r) ? cls(leadingSector(r).chg) : "")}
        ${fact("Rates", pretty(g.rates_read.choice), { tailwind: "up", headwind: "down" }[g.rates_read.choice] || "")}
        ${fact("Money flow", pretty(g.flow_read.choice))}
      </div>
      ${activeList().length > 4 ? playbook(r) : ""}
    </section>`;
  }

  function verdictPanel(r) {
    const watch = r.stocks.filter((s) => isWatched(s.ticker) && verdictFor(s));
    if (!watch.length) return `<section class="panel verdicts"><h3>Assessments · ${esc(lists.active)} <span class="muted" style="text-transform:none;letter-spacing:0">swing read</span></h3><div class="muted">${activeList().length ? (STATIC_MODE ? "No full analysis for the names in this list yet. Names in watchlist.txt get one every build." : "Verdicts appear as each name finishes analysing.") : "Add tickers with the search box in the menu bar."}</div></section>`;
    const rank = { up: 0, up2: 1, flat: 2, down: 3, none: 4 };
    watch.sort((a, b) => rank[verdictFor(a).cls] - rank[verdictFor(b).cls] || b.scores.swing - a.scores.swing);
    const counts = {}; watch.forEach((s) => { const v = verdictFor(s); counts[v.word] = counts[v.word] || { n: 0, cls: v.cls }; counts[v.word].n++; });
    const rows = watch.map((s) => { const v = verdictFor(s), sw = verdictFor(s); return `<li class="vrow" data-open="${esc(s.ticker)}">
        <span class="v-t">${esc(s.ticker)}</span>
        <span class="pill ${v.cls}">${v.word}</span>
        <span class="pill v-intra ${s.ai && s.ai.intraday ? ST.intraday[s.ai.intraday.choice][2] : "flat"}">${s.ai && s.ai.intraday ? "today: " + ST.intraday[s.ai.intraday.choice][0] : "–"}</span>
        <span class="v-why">${esc((v.why || [])[0] || v.plain)}</span>
        <span class="v-conf">${convTag(v.conviction)}</span></li>`; }).join("");
    return `<section class="panel verdicts">
      <h3>Assessments · ${watch.length} in ${esc(lists.active)} <span class="muted" style="text-transform:none;letter-spacing:0">swing read · today's read</span><a class="lnk v-record" href="#view=record" data-view-link="record">track record ›</a></h3>
      <div class="v-summary">${Object.entries(counts).map(([w, x]) => `<span class="pill ${x.cls}">${x.n} ${w.toLowerCase()}</span>`).join("")}</div>
      <ul class="vlist">${rows}</ul>
      <div class="meta2">Funds get a trend read, big companies a momentum read, everything else the model's stance. Conviction is LOW, MED or HIGH. Click a row for the reasons.</div>
    </section>`;
  }

  const LT = {
    stance: { accumulate: ["ACCUMULATE", "Growing business, defensible price, primary trend up or basing. Build it over time, buying weakness.", "up"],
              hold: ["HOLD", "Sound holding but fully priced or extended. Keep it, add only on real pullbacks.", "up2"],
              trim: ["TRIM", "The run is stretched and expectations are high. Take some off into strength.", "flat"],
              avoid: ["AVOID", "Growth is fading, the price is stretched, or the primary trend is down. Not a long-term holding.", "down"],
              no_view: ["NO VIEW", "Too little fundamental information to judge.", "none"] },
    quality: ["weak", "mixed", "solid", "outstanding"],
  };
  function perspectiveCard(s, r) {
    const a = s.ai || {}, t = s.technicals || {}, f = s.fundamentals || {}, c = cls(s.chg_pct);
    const st = a.stance ? a.stance.choice : null, it = a.intraday ? a.intraday.choice : null, lt = a.long_term ? a.long_term.choice : null;
    const pl = plan(s), ck = checklist(s, r);
    const dayCol = `<div class="pcol day"><div class="pcol-h"><span>Day trade</span><em>today</em></div>
      ${it ? `<div class="pverdict ${ST.intraday[it][2]}">${ST.intraday[it][0]}</div><p>${ST.intraday[it][1]}</p>` : `<div class="pverdict none">${analyzing.has(s.ticker) ? "ANALYSING" : "NO READ"}</div><p>${analyzing.has(s.ticker) ? "Reading the tape now." : "No intraday read this build."}</p>`}
      <dl class="pkv"><dt>Day score</dt><dd><b>${words(s.scores.day, 1.0001, SCORE_WORDS)}</b> <span class="mono muted">${(s.scores.day * 100).toFixed(0)}</span></dd><dt>Moves a day</dt><dd class="mono">${fpct(t.atr_pct, 1, false)}</dd><dt>Volume vs normal</dt><dd class="mono">${isNum(s.rel_volume) ? s.rel_volume.toFixed(1) + "×" : "n/a"}</dd><dt>Yesterday</dt><dd class="mono">${fnum(t.prev_low)} – ${fnum(t.prev_high)}</dd>${s.scan ? `<dt>Volume build</dt><dd class="mono ${s.scan.direction === "up" ? "up" : s.scan.direction === "down" ? "down" : ""}">${s.scan.score.toFixed(0)}/100 · ${s.scan.lead}</dd>` : ""}</dl></div>`;
    const swingCol = `<div class="pcol swing"><div class="pcol-h"><span>Swing trade</span><em>1–10 sessions</em></div>
      ${(() => { const v = verdictFor(s); return v ? `<div class="pverdict ${v.cls}">${v.word} ${convTag(v.conviction)}</div><p>${esc(v.plain)}</p>${whyHtml(v, 3)}` : `<div class="pverdict none">${analyzing.has(s.ticker) ? "ANALYSING" : "NO VERDICT"}</div><p>No stance this build.</p>`; })()}
      <dl class="pkv"><dt>Swing score</dt><dd><b>${words(s.scores.swing, 1.0001, SCORE_WORDS)}</b> <span class="mono muted">${(s.scores.swing * 100).toFixed(0)}</span></dd><dt>Lean</dt><dd>${a.bias ? `<span class="${{ long: "up", short: "down" }[a.bias.choice] || "flat"}">${a.bias.choice}</span> ${convTag(a.bias.confidence)}` : "–"}</dd><dt>Setup</dt><dd>${a.setup ? pretty(a.setup.choice) : "–"}</dd><dt>Checklist</dt><dd>${ck ? `<b class="${ck.passed >= 8 ? "up" : ck.passed >= 6 ? "warn" : "down"}">${ck.passed}/${ck.total}</b>` : "–"}</dd></dl>
      ${pl && pl.stop ? `<div class="pplan">Entry ~${fnum(s.last_price)} · stop <b>${fnum(pl.stop)}</b> · target <b>${fnum(pl.target)}</b> · <b>${pl.rr.toFixed(1)}×</b> reward to risk</div>` : `<div class="pplan muted">${pl ? pl.text : "No plan without a lean."}</div>`}</div>`;
    const ltv = lt ? LT.stance[lt] : null; const q = a.long_term_quality ? Math.round(a.long_term_quality.score) : null;
    const longCol = `<div class="pcol long"><div class="pcol-h"><span>Long term</span><em>3–12 months</em></div>
      ${ltv ? `<div class="pverdict ${ltv[2]}">${ltv[0]}</div><p>${ltv[1]}${q != null ? ` Quality: <b>${LT.quality[q]}</b> (${a.long_term_quality.score.toFixed(1)}/3).` : ""}</p>` : `<div class="pverdict none">${analyzing.has(s.ticker) ? "ANALYSING" : "NO VIEW"}</div><p>${analyzing.has(s.ticker) ? "Reading the fundamentals now." : "The long-term read arrives with the next build of this name."}</p>`}
      ${["forward_pe", "ps", "rev_growth"].every((k) => !isNum(f[k])) ? '<div class="meta2 warn" style="margin:2px 0 4px">Company data feed returned nothing this build; the figures below are price-only.</div>' : f.profile_stale ? `<div class="meta2 muted" style="margin:2px 0 4px">Company data from ${new Date(f.profile_as_of * 1000).toLocaleDateString()}; the live feed was blocked this build.</div>` : ""}
      <dl class="pkv"><dt>3m / 6m / 12m</dt><dd><span class="${cls(t.ret_3m)}">${fpct(t.ret_3m, 0)}</span> / <span class="${cls(t.ret_6m)}">${fpct(t.ret_6m, 0)}</span> / <span class="${cls(t.ret_12m)}">${fpct(t.ret_12m, 0)}</span></dd><dt>From 52w high</dt><dd class="mono ${cls(t.pct_from_hi52)}">${fpct(t.pct_from_hi52, 0)}</dd><dt>P/E fwd · P/S</dt><dd class="mono">${fnum(f.forward_pe, 0)} · ${fnum(f.ps, 1)}</dd><dt>Revenue growth</dt><dd class="mono ${cls(f.rev_growth)}">${isNum(f.rev_growth) ? fpct(f.rev_growth * 100, 0) : "–"}</dd><dt>Analysts</dt><dd>${pretty(f.analyst) || "–"}${isNum(f.target) ? ` <span class="mono muted">→ ${fnum(f.target, 0)}</span>` : ""}</dd><dt>Above 200-day</dt><dd>${t.above_sma200 == null ? "–" : t.above_sma200 ? '<span class="up">yes</span>' : '<span class="down">no</span>'}</dd></dl></div>`;
    return `<article class="pcard st-${st ? ST.cls[st] : "none"}" data-ticker="${esc(s.ticker)}">
      <div class="pcard-h"><div class="wc-id"><button class="wc-ticker lnk-t" data-ticker-page="${esc(s.ticker)}">${esc(s.ticker)}</button><span class="wc-name" title="${esc(s.name)}">${esc(s.name)}${s.sector ? " · " + esc(s.sector) : ""}</span></div><div class="wc-price">${priceHtml(s.ticker, s)}<button class="wc-x" data-remove="${esc(s.ticker)}" title="Remove from your watchlist">×</button></div></div>
      <div class="pgrid h-${horizon}">${dayCol}${swingCol}${longCol}</div>
      <div class="pfoot">${whoHtml(s) ? `<div class="pwho">${whoHtml(s)}</div>` : ""}<div class="wc-actions"><button class="btn sm" data-open="${esc(s.ticker)}">Full analysis</button><a class="btn sm ghost" href="${tvLink(s.ticker)}" target="_blank" rel="noopener">Chart</a></div></div>
    </article>`;
  }
  // ======================= US MARKET THEMES: ten themes, each split into its sectors =======================
  const TI = {
    ai: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></svg>',
    power: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
    cloud: '<svg viewBox="0 0 24 24"><path d="M7 18a5 5 0 1 1 .9-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 8z"/></svg>',
    bank: '<svg viewBox="0 0 24 24"><path d="M3 10 12 4l9 6"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/></svg>',
    cart: '<svg viewBox="0 0 24 24"><circle cx="9" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/><path d="M3 4h2l2.4 11h11l2-8H6.2"/></svg>',
    health: '<svg viewBox="0 0 24 24"><path d="M12 21s-7-4.4-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.6-9 9-9 9z"/><path d="M9 12h2l1-2 1.5 4 1-2H17"/></svg>',
    oil: '<svg viewBox="0 0 24 24"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/></svg>',
    factory: '<svg viewBox="0 0 24 24"><path d="M3 20V10l5 3V10l5 3V6l8 4v10z"/><path d="M3 20h18"/></svg>',
    rocket: '<svg viewBox="0 0 24 24"><path d="M5 19c1-3 2.5-4.5 4-5l1 1c-.5 1.5-2 3-5 4z"/><path d="M14.5 4.5C18 3 21 3 21 3s0 3-1.5 6.5L13 16l-5-5z"/><circle cx="15.5" cy="8.5" r="1.4"/></svg>',
    car: '<svg viewBox="0 0 24 24"><path d="M5 16h14l-1.5-5.5A2 2 0 0 0 15.6 9H8.4a2 2 0 0 0-1.9 1.5z"/><path d="M4 16v3h3v-3M17 16v3h3v-3"/><circle cx="8" cy="16" r="1"/><circle cx="16" cy="16" r="1"/></svg>',
  };
  const US_THEMES = [
    { key: "ai", name: "AI & semiconductors", icon: TI.ai, drives: "The chips behind artificial intelligence. Moves with AI spending, chip supply and export rules.",
      groups: [["Compute chips", ["NVDA", "AMD", "AVGO", "ARM", "TSM", "MRVL", "ALAB", "CRDO", "INTC"]], ["Memory & storage", ["MU", "SNDK", "WDC", "STX"]], ["Networking & optics", ["ANET", "CIEN", "COHR", "LITE", "AAOI", "FN"]], ["Chip equipment", ["ASML", "AMAT", "LRCX", "KLAC", "TER"]], ["Other chips", ["QCOM", "TXN", "ON", "MPWR"]]] },
    { key: "power", name: "Power & AI infrastructure", icon: TI.power, drives: "Data centres need servers, cooling and a lot of electricity. Moves with data-centre building and power prices.",
      groups: [["Servers & cooling", ["SMCI", "DELL", "HPE", "VRT", "MOD", "NVT"]], ["Power & grid", ["GEV", "ETN", "PWR", "VST", "CEG", "NRG", "TLN"]], ["Nuclear & new power", ["OKLO", "SMR", "BE"]], ["Data-centre property", ["EQIX", "DLR", "IRM"]]] },
    { key: "cloud", name: "Cloud & software", icon: TI.cloud, drives: "The platforms that rent AI and the software built on it. Moves with cloud growth and interest rates.",
      groups: [["Hyperscalers", ["MSFT", "GOOGL", "AMZN", "META", "ORCL"]], ["AI clouds", ["CRWV", "NBIS"]], ["Software", ["CRM", "NOW", "ADBE", "INTU", "SNOW", "DDOG", "PLTR", "APP", "SHOP"]], ["Cybersecurity", ["CRWD", "PANW", "ZS", "NET"]]] },
    { key: "fin", name: "Banks, rates & fintech", icon: TI.bank, drives: "Lenders, brokers and payments. Moves with interest rates, loan growth and trading activity.",
      groups: [["Big banks", ["JPM", "BAC", "WFC", "C"]], ["Brokers & asset managers", ["GS", "MS", "SCHW", "BLK", "HOOD"]], ["Payments", ["V", "MA", "AXP", "PYPL"]], ["Fintech lenders", ["SOFI", "AFRM", "UPST"]]] },
    { key: "cons", name: "The US consumer", icon: TI.cart, drives: "What Americans buy. Moves with jobs, wages, inflation and confidence.",
      groups: [["Big-box retail", ["WMT", "COST", "TGT", "DG", "DLTR"]], ["Brands & restaurants", ["MCD", "SBUX", "CMG", "NKE", "LULU", "CELH", "ELF"]], ["Household staples", ["KO", "PEP", "PG"]], ["Home & housing", ["HD", "LOW", "OPEN", "CVNA"]], ["Streaming & media", ["NFLX", "DIS", "SPOT", "WBD", "RBLX"]]] },
    { key: "health", name: "Health care & weight-loss drugs", icon: TI.health, drives: "Drug makers, biotech and insurers. Moves with drug approvals, weight-loss drug demand and US policy.",
      groups: [["Weight-loss leaders", ["LLY", "NVO"]], ["Big pharma", ["JNJ", "PFE", "MRK", "ABBV"]], ["Biotech", ["AMGN", "GILD", "REGN", "VRTX", "MRNA"]], ["Care & devices", ["UNH", "ISRG", "HIMS"]]] },
    { key: "energy", name: "Energy & materials", icon: TI.oil, drives: "Oil, gas and metals. Moves with commodity prices, the dollar and global growth.",
      groups: [["Oil & gas", ["XOM", "CVX", "OXY", "SLB"]], ["Metals & mining", ["FCX", "NEM", "NUE"]]] },
    { key: "ind", name: "Industrials & defense", icon: TI.factory, drives: "Planes, machines, freight and weapons. Moves with factory activity, government spending and tariffs.",
      groups: [["Aerospace & defense", ["LMT", "RTX", "BA", "GE"]], ["Machinery", ["CAT", "DE", "HON"]], ["Transport", ["UPS", "FDX", "UBER"]]] },
    { key: "frontier", name: "Crypto & frontier tech", icon: TI.rocket, drives: "The high-risk corner: crypto, quantum computing and space. Moves with risk appetite and Bitcoin.",
      groups: [["Crypto", ["COIN", "MSTR", "IBIT", "MARA"]], ["Quantum computing", ["IONQ", "RGTI", "QUBT"]], ["Space", ["RKLB", "ASTS", "LUNR"]], ["Flying taxis & AI apps", ["ACHR", "JOBY", "SOUN", "BBAI"]]] },
    { key: "ev", name: "EVs & autos", icon: TI.car, drives: "Carmakers old and new. Moves with rates, subsidies, tariffs and Tesla.",
      groups: [["Tesla", ["TSLA"]], ["EV makers", ["RIVN", "LCID", "NIO"]], ["Detroit", ["GM", "F"]]] },
  ];
  let themePeriod = "1m";
  const TP_FIELD = { "1w": "ret_5d", "1m": "ret_1m", "3m": "ret_3m" }, TP_WORD = { "1w": "1 week", "1m": "1 month", "3m": "3 months" };
  function themeRec(r, t) {
    const s = stockFor(t), l = (r.lite || {})[t]; const o = s || l; if (!o) return null; const tech = o.technicals || {};
    return { t, name: (s && s.name) || (l && l.name) || t, chg: qp(t, o).chg, ret_5d: tech.ret_5d, ret_1m: tech.ret_1m, ret_3m: tech.ret_3m, up: tech.above_sma50 === true, trend: tech.trend };
  }
  const avgOf = (xs, f) => { const v = xs.map((x) => x[f]).filter(isNum); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  function themeStats(r) {
    const spy = (idxOf(r, "SPY") || {}).technicals || {};
    return US_THEMES.map((th) => {
      const groups = th.groups.map(([name, ts]) => { const recs = ts.map((t) => themeRec(r, t)).filter(Boolean); return { name, recs, ret: avgOf(recs, TP_FIELD[themePeriod]), r5: avgOf(recs, "ret_5d"), r1m: avgOf(recs, "ret_1m"), up: recs.filter((x) => x.up).length }; }).filter((g) => g.recs.length);
      const all = groups.flatMap((g) => g.recs);
      const r1m = avgOf(all, "ret_1m"), r5 = avgOf(all, "ret_5d");
      const rel1m = isNum(r1m) && isNum(spy.ret_1m) ? r1m - spy.ret_1m : null, rel5 = isNum(r5) && isNum(spy.ret_5d) ? r5 - spy.ret_5d : null;
      const state = !isNum(rel1m) || !isNum(rel5) ? ["No read", "flat"] : rel1m >= 0 ? (rel5 >= 0 ? ["Leading", "lead"] : ["Weakening", "weak"]) : (rel5 >= 0 ? ["Improving", "imp"] : ["Lagging", "lag"]);
      const ret = avgOf(all, TP_FIELD[themePeriod]); const spyRet = spy[TP_FIELD[themePeriod]];
      const sorted = all.filter((x) => isNum(x[TP_FIELD[themePeriod]])).sort((a, b) => b[TP_FIELD[themePeriod]] - a[TP_FIELD[themePeriod]]);
      return { ...th, groups, all, ret, vs: isNum(ret) && isNum(spyRet) ? ret - spyRet : null, state, up: all.filter((x) => x.up).length, leaders: sorted.slice(0, 3), laggards: sorted.slice(-2).reverse() };
    }).filter((x) => x.all.length);
  }
  const STATE_HELP = { lead: "beating the S&P over a month and still pulling ahead this week", imp: "behind the S&P over a month but gaining this week", weak: "ahead of the S&P over a month but slipping this week", lag: "behind the S&P and still falling behind", flat: "" };
  function secUsThemes(r) {
    const T = themeStats(r); if (!T.length) return "";
    const spy = ((idxOf(r, "SPY") || {}).technicals || {})[TP_FIELD[themePeriod]];
    const ranked = T.slice().sort((a, b) => (b.ret ?? -1e9) - (a.ret ?? -1e9));
    const mx = Math.max(1, ...ranked.map((x) => Math.abs(x.ret || 0)), Math.abs(spy || 0));
    const seg = Object.keys(TP_WORD).map((k) => `<button type="button" class="${k === themePeriod ? "on" : ""}" data-theme-period="${k}">${k.toUpperCase()}</button>`).join("");
    const board = ranked.map((x) => `<li data-jump='[data-tm="${x.key}"]' role="button" tabindex="0"><span class="tb-ic">${x.icon}</span><span class="tb-n">${esc(x.name)}</span><span class="ps-bar"><i class="${cls(x.ret)}" style="${(x.ret || 0) >= 0 ? "left:50%" : "right:50%"};width:${((Math.abs(x.ret || 0) / mx) * 50).toFixed(1)}%"></i>${isNum(spy) ? `<b class="tb-spy" style="left:${(50 + (spy / mx) * 50).toFixed(1)}%" title="S&P 500 ${fpct(spy, 1)}"></b>` : ""}</span><span class="ps-v ${cls(x.ret)}">${fpct(x.ret, 1)}</span><span class="tm-state s-${x.state[1]}">${x.state[0]}</span></li>`).join("");
    const lead = ranked.filter((x) => x.state[1] === "lead").map((x) => x.name), lag = ranked.filter((x) => x.state[1] === "lag").map((x) => x.name);
    const cards = T.map((x) => {
      const gm = Math.max(1, ...x.groups.map((g) => Math.abs(g.ret || 0)));
      const rows = x.groups.map((g) => `<li><span class="tg-n">${esc(g.name)}</span><span class="ps-bar"><i class="${cls(g.ret)}" style="${(g.ret || 0) >= 0 ? "left:50%" : "right:50%"};width:${((Math.abs(g.ret || 0) / gm) * 50).toFixed(1)}%"></i></span><span class="ps-v ${cls(g.ret)}">${fpct(g.ret, 1)}</span><span class="tg-dots" title="${g.up} of ${g.recs.length} above their 50-day average">${g.recs.map((s) => `<i class="${s.up ? "on" : ""}"></i>`).join("")}</span></li>`).join("");
      const chip = (s) => `<span class="tm-chip ${cls(s[TP_FIELD[themePeriod]])}" data-ticker-page="${esc(s.t)}" title="${esc(s.name)}">${esc(s.t)}<i>${fpct(s[TP_FIELD[themePeriod]], 1)}</i></span>`;
      const pctUp = x.all.length ? Math.round((x.up / x.all.length) * 100) : 0;
      return `<article class="tm-card s-${x.state[1]}" data-tm="${x.key}">
        <div class="tm-top"><span class="tm-ic">${x.icon}</span><div class="tm-tt"><h3>${esc(x.name)}</h3><p>${esc(x.drives)}</p></div><span class="tm-state s-${x.state[1]}" title="${esc(STATE_HELP[x.state[1]])}">${x.state[0]}</span></div>
        <div class="tm-kpis"><div><b class="${cls(x.ret)}">${fpct(x.ret, 1)}</b><span>average, ${TP_WORD[themePeriod]}</span></div><div><b class="${cls(x.vs)}">${fpct(x.vs, 1)}</b><span>vs the S&amp;P 500</span></div><div class="tm-ring" style="--p:${pctUp}"><em>${x.up}/${x.all.length}</em><span>in an uptrend</span></div></div>
        <ul class="tm-groups">${rows}</ul>
        <div class="tm-movers"><div><span class="cr-lbl">Leading</span>${x.leaders.map(chip).join("")}</div><div><span class="cr-lbl">Lagging</span>${x.laggards.map(chip).join("")}</div></div>
      </article>`; }).join("");
    return `<section class="pulse tms">
      <div class="pulse-head"><span class="pz-live"><i></i>US market themes · updated ${esc(r.generated_at.slice(11, 16))} ET</span>
        <h2>Where the market's story is</h2><p>${lead.length ? `<b class="up">Leading:</b> ${esc(lead.join(", "))}. ` : ""}${lag.length ? `<b class="down">Lagging:</b> ${esc(lag.join(", "))}.` : ""} Each theme is split into the sectors that make it up. Numbers are equal-weight averages of the stocks listed.</p></div>
      <article class="pz tm-board"><div class="pz-h"><span class="pz-eye">The scoreboard</span><div class="pz-seg">${seg}</div></div>
        <ul class="tb-list">${board}</ul>
        <div class="tm-key">${[["lead", "Leading"], ["imp", "Improving"], ["weak", "Weakening"], ["lag", "Lagging"]].map(([k, l]) => `<span class="tm-state s-${k}">${l}</span><i>${STATE_HELP[k]}</i>`).join("")}<span class="tb-spyk"><b></b>S&amp;P 500 over the same period</span></div></article>
      <div class="tm-grid">${cards}</div>
      <details class="ctx-more"><summary>Deep dive: the AI data-centre build-out, part by part, with the model's read</summary>${secTheme(r)}</details>
      <div class="pz-foot">Themes and the stocks in them are OneView's grouping. "Uptrend" means above the 50-day average. Information, not advice.</div>
    </section>`;
  }
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-theme-period]"); if (!b || !report) return; themePeriod = b.getAttribute("data-theme-period"); const el = $("#app .tms"); if (!el) return; const y = ($("#app .view") || {}).scrollTop; const tmp = document.createElement("div"); tmp.innerHTML = secUsThemes(report); el.replaceWith(tmp.firstElementChild); const v = $("#app .view"); if (v && y != null) v.scrollTop = y; wireStocks(); });

  // ======================= COMPANY MAP: type a name, see how the money and the dependencies connect =======================
  let mapSym = null, mapData = null, mapBusy = false, mapErr = null, mapSim = null;
  try { mapSym = sessionStorage.getItem("mu-map") || null; } catch (e) {}
  const MAP_COL = { center: "#FF7A2F", customer: "#3DDC97", supplier: "#FFB27A", partner: "#6FA8FF", rival: "#FF6B85", risk: "#F7C85A", owner: "#8B8B97", peer: "#A6A6B2", second: "#C98A5E" };
  const MAP_WORD = { customer: "buys from it", supplier: "supplies it", partner: "partner", rival: "rival", risk: "risk", owner: "owns shares", peer: "same industry", second: "supplier's supplier" };
  const bn = (v) => (!isNum(v) ? "–" : Math.abs(v) >= 1e12 ? "$" + (v / 1e12).toFixed(2) + "T" : Math.abs(v) >= 1e9 ? "$" + (v / 1e9).toFixed(1) + "B" : Math.abs(v) >= 1e6 ? "$" + (v / 1e6).toFixed(0) + "M" : "$" + Math.round(v));
  function resolveMapQuery(q) {
    q = (q || "").trim(); if (!q) return null;
    if (/^[A-Za-z.\-]{1,6}$/.test(q) && q === q.toUpperCase()) return q.toUpperCase();
    const low = q.toLowerCase();
    const known = { nvidia: "NVDA", apple: "AAPL", microsoft: "MSFT", amazon: "AMZN", google: "GOOGL", alphabet: "GOOGL", meta: "META", facebook: "META", tesla: "TSLA", broadcom: "AVGO", tsmc: "TSM", amd: "AMD", intel: "INTC", micron: "MU", oracle: "ORCL", coreweave: "CRWV", supermicro: "SMCI", dell: "DELL", palantir: "PLTR", netflix: "NFLX", arista: "ANET", marvell: "MRVL", asml: "ASML", vertiv: "VRT" };
    if (known[low]) return known[low];
    if (symbolIndex) { const hit = symbolIndex.find((r) => String(r[1] || "").toLowerCase().startsWith(low)) || symbolIndex.find((r) => String(r[1] || "").toLowerCase().includes(low)); if (hit) return hit[0]; }
    return q.toUpperCase().replace(/[^A-Z.\-]/g, "").slice(0, 6) || null;
  }
  async function loadMap(sym) {
    if (!sym) return; mapSym = sym; mapBusy = true; mapErr = null; mapData = null; try { sessionStorage.setItem("mu-map", sym); } catch (e) {}
    rerenderMap();
    try { const res = await api(`/api/company/${encodeURIComponent(sym)}`, { cache: "no-store" }); const j = await res.json().catch(() => ({}));
      if (j.status === "ok") mapData = j; else mapErr = j.status === "not_found" ? `No company found for "${sym}". Try the ticker, such as NVDA.` : (j.detail || "The data could not be loaded right now.");
    } catch (e) { mapErr = "The server is not reachable right now."; }
    mapBusy = false; rerenderMap();
  }
  function rerenderMap() { if (currentView !== "map") return; const el = $("#app .cm"); if (!el) return; const tmp = document.createElement("div"); tmp.innerHTML = secMap(); el.replaceWith(tmp.firstElementChild); mountMap(); }
  function sankey(flow) {
    if (!flow || !flow.links.length) return "";
    const colOf = { rev: 0, cost: 1, gross: 1, rnd: 2, sga: 2, oth: 2, op: 2, tax: 3, ni: 3, capex: 4, bb: 4, dv: 4, acq: 4, kept: 4 };
    const colour = { rev: "#FF7A2F", cost: "#FF6B85", gross: "#3DDC97", rnd: "#6FA8FF", sga: "#9C9CA8", oth: "#9C9CA8", op: "#3DDC97", tax: "#F7C85A", ni: "#3DDC97", capex: "#FFB27A", bb: "#6FA8FF", dv: "#6FA8FF", acq: "#C98A5E", kept: "#3DDC97" };
    const val = {}; flow.links.forEach((l) => { val[l.s] = Math.max(val[l.s] || 0, 0); val[l.t] = (val[l.t] || 0) + l.v; }); val.rev = flow.revenue;
    const outSum = {}; flow.links.forEach((l) => { outSum[l.s] = (outSum[l.s] || 0) + l.v; });
    Object.keys(outSum).forEach((k) => { val[k] = Math.max(val[k] || 0, outSum[k]); });
    const W = 900, H = 360, cols = 5, nodeW = 14, gap = 12, colX = (c) => 10 + c * ((W - 150 - nodeW) / (cols - 1));
    const maxCol = Math.max(...[0, 1, 2, 3, 4].map((c) => flow.nodes.filter((n) => colOf[n.id] === c).reduce((a, n) => a + (val[n.id] || 0), 0)));
    const k = (H - 40 - gap * 4) / (maxCol || 1);
    const pos = {};
    [0, 1, 2, 3, 4].forEach((c) => { let y = 20; flow.nodes.filter((n) => colOf[n.id] === c).forEach((n) => { const h = Math.max(3, (val[n.id] || 0) * k); pos[n.id] = { x: colX(c), y, h, out: 0, in: 0 }; y += h + gap; }); });
    const bands = flow.links.map((l) => { const a = pos[l.s], b = pos[l.t]; if (!a || !b) return ""; const h = Math.max(1.5, l.v * k); const y1 = a.y + a.out + h / 2, y2 = b.y + b.in + h / 2; a.out += h; b.in += h;
      const x1 = a.x + nodeW, x2 = b.x, mx = (x1 + x2) / 2;
      return `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" stroke="${colour[l.t]}" stroke-width="${h.toFixed(1)}" class="sk-band"><title>${esc(flow.nodes.find((n) => n.id === l.t).label)}: ${bn(l.v)}</title></path>`; }).join("");
    const nodes = flow.nodes.map((n) => { const p = pos[n.id]; if (!p) return ""; const right = colOf[n.id] === 4; return `<g><rect x="${p.x}" y="${p.y}" width="${nodeW}" height="${p.h}" rx="3" fill="${colour[n.id]}"/><text x="${right ? p.x + nodeW + 6 : p.x + nodeW + 6}" y="${p.y + Math.min(p.h / 2 + 4, p.h + 12)}" class="sk-l">${esc(n.label)} <tspan>${bn(val[n.id])}</tspan></text></g>`; }).join("");
    return `<svg class="sankey" viewBox="0 0 ${W} ${H}" role="img" aria-label="Where the money went in fiscal ${esc(flow.year || "")}">${bands}${nodes}</svg>`;
  }
  function barsYears(st, keys) {
    const years = (st.years || []).slice().reverse(); if (!years.length) return "";
    const series = keys.map(([k, label, col]) => ({ label, col, v: (st[k] || []).slice(0, years.length).reverse() }));
    const all = series.flatMap((s) => s.v).filter(isNum); if (!all.length) return "";
    const mx = Math.max(...all.map(Math.abs)), W = 420, H = 170, P = 22, gw = (W - P) / years.length, bw = Math.min(24, (gw - 14) / series.length);
    const Y = (v) => H - P - (Math.max(0, v) / mx) * (H - P - 14);
    const bars = years.map((y, i) => series.map((s, j) => { const v = s.v[i]; if (!isNum(v)) return ""; const x = P / 2 + i * gw + (gw - bw * series.length) / 2 + j * bw; return `<rect x="${x.toFixed(1)}" y="${Y(v).toFixed(1)}" width="${(bw - 3).toFixed(1)}" height="${(H - P - Y(v)).toFixed(1)}" rx="3" fill="${s.col}"><title>${esc(s.label)} ${esc(y.slice(0, 4))}: ${bn(v)}</title></rect>`; }).join("") + `<text x="${(P / 2 + i * gw + gw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="yb-l">FY${esc(y.slice(2, 4))}</text>`).join("");
    return `<svg class="ybars" viewBox="0 0 ${W} ${H}">${bars}</svg><div class="yb-key">${series.map((s) => `<span><i style="background:${s.col}"></i>${esc(s.label)} <b>${bn(s.v[s.v.length - 1])}</b></span>`).join("")}</div>`;
  }
  function capexBars(cap) {
    const ok = (cap || []).filter((c) => (c.capex || []).some(isNum)); if (!ok.length) return "";
    const years = ok[0].years.slice().reverse();
    const totals = years.map((y, i) => ok.reduce((a, c) => a + ((c.capex || []).slice().reverse()[i] || 0), 0));
    const mx = Math.max(...totals), W = 420, H = 180, P = 22, gw = (W - P) / years.length, bw = Math.min(46, gw - 20);
    const pal = ["#FF7A2F", "#FFB27A", "#6FA8FF", "#3DDC97", "#F7C85A", "#C98A5E"];
    const bars = years.map((y, i) => { let top = H - P; return ok.map((c, j) => { const v = (c.capex || []).slice().reverse()[i] || 0; const h = (v / mx) * (H - P - 16); top -= h; return `<rect x="${(P / 2 + i * gw + (gw - bw) / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, h - 1).toFixed(1)}" fill="${pal[j % pal.length]}"><title>${esc(c.sym)} ${esc(y)}: ${bn(v)}</title></rect>`; }).join("") + `<text x="${(P / 2 + i * gw + gw / 2).toFixed(1)}" y="${(top - 4).toFixed(1)}" text-anchor="middle" class="yb-t">${bn(totals[i]).replace(".0B", "B")}</text><text x="${(P / 2 + i * gw + gw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="yb-l">${esc(y)}</text>`; }).join("");
    return `<svg class="ybars" viewBox="0 0 ${W} ${H}">${bars}</svg><div class="yb-key">${ok.map((c, j) => `<span><i style="background:${pal[j % pal.length]}"></i>${esc(c.sym)}</span>`).join("")}</div>`;
  }
  function secMap() {
    const d = mapData;
    const chips = ["NVDA", "AMD", "TSM", "AVGO", "MSFT", "META", "AMZN", "AAPL", "TSLA", "SMCI"].map((s) => `<button type="button" class="${s === mapSym ? "on" : ""}" data-map-go="${s}">${s}</button>`).join("");
    const head = `<div class="cm-head"><span class="pz-live"><i></i>Company map</span><h2>How a company really works</h2><p>Type a company. OneView maps who it depends on and who depends on it, follows the money through its statements, and shows where it is critical and where it could break.</p>
      <form class="cm-search" data-map-form><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg><input id="map-q" type="search" placeholder="Type a company, such as NVIDIA or TSLA" autocomplete="off" value="${esc(mapSym || "")}" aria-label="Company name or ticker"><button type="submit" class="lg-btn"><span>Map it</span><i aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6"/></svg></i></button></form>
      <div class="cm-chips">${chips}</div></div>`;
    if (mapBusy) return `<section class="cm">${head}<div class="cm-loading"><div class="cm-bubble"><i></i><i></i><i></i><b>${esc(mapSym || "")}</b></div><p>Reading the statements, the latest annual report and the supply chain…</p></div></section>`;
    if (mapErr) return `<section class="cm">${head}<div class="cr-none cm-err">${esc(mapErr)}</div></section>`;
    if (!d) return `<section class="cm">${head}<div class="cm-empty">Pick a company above to draw its map.</div></section>`;
    const P = d.profile || {}, V = d.valuation || {}, st = d.statements || {}, sec = d.sec, vd = d.verdicts || {};
    const g = d.graph || {};
    const legend = ["customer", "supplier", "partner", "rival", "risk", g.curated ? "second" : "peer", "owner"].map((k) => `<span><i style="background:${MAP_COL[k]}"></i>${MAP_WORD[k]}</span>`).join("");
    const cust = sec && (sec.top || []).length ? (() => { const tops = sec.top.map((t) => t.pct); const rest = Math.max(0, 100 - tops.reduce((a, b) => a + b, 0));
      return `<div class="cm-cust"><div class="cr-split cm-cbar">${tops.map((p, i) => `<i style="width:${p}%;background:${["#FF7A2F", "#FFB27A", "#F7C85A", "#C98A5E", "#6FA8FF"][i]}" title="Customer ${String.fromCharCode(65 + i)} ${p}%"></i>`).join("")}<i style="width:${rest}%;background:rgba(255,255,255,.14)"></i></div>
        <div class="yb-key">${tops.map((p, i) => `<span><i style="background:${["#FF7A2F", "#FFB27A", "#F7C85A", "#C98A5E", "#6FA8FF"][i]}"></i>Customer ${String.fromCharCode(65 + i)} <b>${p}%</b></span>`).join("")}<span><i style="background:rgba(255,255,255,.3)"></i>everyone else <b>${rest.toFixed(0)}%</b></span></div>
        <blockquote class="cm-quote">"${esc(sec.quotes[0] || "").slice(0, 280)}"<span>${esc(sec.form)} filed ${esc(sec.filed)} · <a href="${esc(sec.url)}" target="_blank" rel="noopener">read the filing</a></span></blockquote></div>`; })()
      : `<p class="od-p">${sec ? "The latest annual report names no single customer above 10% of revenue." : "No SEC annual report found for this ticker."}</p>`;
    const named = (g.links || []).filter((l) => l.rel === "customer" && !l.second).sort((a, b) => b.w - a.w).slice(0, 8).map((l) => { const n = g.nodes.find((x) => x.id === l.s); return `<li><b>${esc(n ? n.label : l.s)}</b><span>${esc(l.why)}</span></li>`; }).join("");
    const ytt = V.years_to_20;
    return `<section class="cm">${head}
      <div class="cm-title"><div><b>${esc(P.name || d.symbol)}</b><span>${esc(d.symbol)} · ${esc(P.industry || "")}${P.country ? " · " + esc(P.country) : ""}</span></div>
        <div class="cm-kpis"><div><span>Market value</span><b>${bn(V.market_cap)}</b></div><div><span>Revenue, FY${esc((st.years || [""])[0].slice(2, 4))}</span><b>${bn((st.revenue || [])[0])}</b></div><div><span>Net income</span><b>${bn((st.net_income || [])[0])}</b></div><div><span>P/E</span><b>${fnum(V.pe, 1)}</b></div></div></div>
      <div class="pulse-grid cm-grid">
        <article class="pz cm-graph-card"><div class="pz-h"><span class="pz-eye">The map · drag the circles, scroll to zoom, click a company to map it</span><span class="pz-hint">${g.curated ? "supply chain from public filings and reporting" : "who owns it and its industry peers"}</span></div>
          <div class="cm-stage" id="cm-graph" aria-label="Network map of ${esc(P.name || d.symbol)}"></div><div class="cm-legend">${legend}<span><i class="crit"></i>single point of failure</span></div><div class="cm-tip" id="cm-tip" hidden></div></article>
        <article class="pz cm-crit"><div class="pz-h"><span class="pz-eye up">Why it is critical</span></div><ul class="cm-v up">${(vd.critical || []).map((x) => `<li><b>${esc(x.t)}</b><span>${esc(x.d)}</span></li>`).join("") || "<li><span>Nothing stands out.</span></li>"}</ul></article>
        <article class="pz cm-vul"><div class="pz-h"><span class="pz-eye down">Where it could break</span></div><ul class="cm-v down">${(vd.vulnerable || []).map((x) => `<li><b>${esc(x.t)}</b><span>${esc(x.d)}</span></li>`).join("") || "<li><span>Nothing stands out.</span></li>"}</ul></article>
        <article class="pz cm-flow"><div class="pz-h"><span class="pz-eye">Where the money went · fiscal ${esc(((d.flow || {}).year || "").slice(0, 4))}</span><span class="pz-hint">from the income and cash-flow statements</span></div>${sankey(d.flow) || '<div class="cr-none">No statement data.</div>'}
          <p class="od-p">Of every dollar of sales, <b>${isNum(V.gross_margin) ? Math.round(V.gross_margin * 100) : "–"}¢</b> is left after making the product and <b>${isNum(V.net_margin) ? Math.round(V.net_margin * 100) : "–"}¢</b> after everything. The cash it earned went to ${["capex", "buybacks", "dividends"].map((k) => [k, Math.abs(((st[k] || [])[0]) || 0)]).sort((a, b) => b[1] - a[1]).filter((x) => x[1] > 0).map(([k, v]) => `${{ capex: "building capacity", buybacks: "buying back shares", dividends: "dividends" }[k]} (${bn(v)})`).join(", ") || "none of the usual uses"}.</p></article>
        <article class="pz cm-hist"><div class="pz-h"><span class="pz-eye">Four years of growth</span></div>${barsYears(st, [["revenue", "Revenue", "#FF7A2F"], ["net_income", "Net income", "#3DDC97"], ["fcf", "Free cash flow", "#6FA8FF"]])}</article>
        <article class="pz cm-bal"><div class="pz-h"><span class="pz-eye">Balance sheet</span></div>${barsYears(st, [["cash", "Cash and investments", "#3DDC97"], ["debt", "Debt", "#FF6B85"], ["inventory", "Inventory", "#F7C85A"]])}</article>
        <article class="pz cm-cus"><div class="pz-h"><span class="pz-eye">Who pays them</span><span class="pz-hint">annual report, customers above 10%</span></div>${cust}${named ? `<h5 class="cm-h5">Named on the map</h5><ul class="cm-named">${named}</ul>` : ""}</article>
        ${(d.capex || []).length ? `<article class="pz cm-cap"><div class="pz-h"><span class="pz-eye">The spending wave flowing in</span><span class="pz-hint">capital spending of its biggest customers</span></div>${capexBars(d.capex)}<p class="od-p">What its customers spend building data centers is, in large part, its next revenue.</p></article>` : ""}
        <article class="pz cm-val"><div class="pz-h"><span class="pz-eye">What the price assumes</span></div>
          <div class="wd-odds"><div><span>Price / earnings</span><b>${fnum(V.pe, 1)}</b><em>forward ${fnum(V.forward_pe, 1)}</em></div><div><span>Price / sales</span><b>${fnum(V.ps, 1)}</b><em>market value ÷ revenue</em></div><div><span>Growth, latest</span><b class="${cls(V.growth)}">${isNum(V.growth) ? fpct(V.growth * 100, 0) : "–"}</b><em>earnings, year on year</em></div><div><span>Operating margin</span><b>${isNum(V.op_margin) ? Math.round(V.op_margin * 100) + "%" : "–"}</b><em>profit from operations</em></div></div>
          <p class="od-p">${isNum(ytt) ? `At today's growth, profits catch up with the price, to a market-like 20 times earnings, in about <b>${ytt < 1 ? "under a year" : ytt.toFixed(1) + " years"}</b>. The longer that takes, the more the price depends on growth continuing.` : isNum(V.pe) && V.pe <= 20 ? "Priced at or below a market-like 20 times earnings." : "Not enough data to say what the price assumes."}</p></article>
        ${(d.holders || []).length ? `<article class="pz cm-own"><div class="pz-h"><span class="pz-eye">Who owns it</span></div><ul class="cm-named">${d.holders.map((h) => `<li><b>${esc(h.name)}</b><span>${isNum(h.pct) ? h.pct.toFixed(2) + "% of the shares" : ""}</span></li>`).join("")}</ul></article>` : ""}
      </div>
      <div class="pz-foot">${d.currency && d.currency.reported && d.currency.reported !== "USD" ? `Statements are reported in ${esc(d.currency.reported)} and shown in US dollars${d.currency.usd_rate ? ` at today's rate (1 ${esc(d.currency.reported)} = $${d.currency.usd_rate.toFixed(4)})` : " (no rate available, so figures are in " + esc(d.currency.reported) + ")"}. ` : ""}Statements and holders: Yahoo Finance. Customers: the company's latest ${sec ? esc(sec.form) : "annual report"} on SEC EDGAR. Connections: OneView's map of the AI supply chain from public filings and reporting. Information, not advice.</div>
    </section>`;
  }
  function loadD3() { return window.d3 ? Promise.resolve(window.d3) : new Promise((res, rej) => { const s = document.createElement("script"); s.src = "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"; s.onload = () => res(window.d3); s.onerror = rej; document.head.appendChild(s); }); }
  async function mountMap() {
    const el = $("#cm-graph"); if (!el || !mapData) return;
    let d3; try { d3 = await loadD3(); } catch (e) { el.innerHTML = '<div class="cr-none">The map library could not load.</div>'; return; }
    if (mapSim) { mapSim.stop(); mapSim = null; }
    const g0 = mapData.graph; const W = el.clientWidth || 900, H = el.clientHeight || 560;
    const nodes = g0.nodes.map((n) => ({ ...n, x: W / 2, y: H / 2 }));
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    const links = g0.links.filter((l) => byId[l.s] && byId[l.t]).map((l) => ({ ...l, source: l.s, target: l.t }));
    const deg = {}; links.forEach((l) => { deg[l.s] = Math.max(deg[l.s] || 0, l.w); });
    const critIds = new Set(links.filter((l) => l.critical).map((l) => l.s));
    const R = (n) => (n.group === "center" ? 46 : n.group === "owner" || n.group === "peer" ? 13 : 11 + (deg[n.id] || 1) * 3.2);
    el.innerHTML = "";
    const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("class", "cm-svg");
    const defs = svg.append("defs");
    const gr = defs.append("radialGradient").attr("id", "cmc"); gr.append("stop").attr("offset", "0").attr("stop-color", "#FFB27A"); gr.append("stop").attr("offset", "1").attr("stop-color", "#FF7A2F");
    const root = svg.append("g");
    svg.call(d3.zoom().scaleExtent([0.4, 3]).on("zoom", (ev) => root.attr("transform", ev.transform)));
    const link = root.append("g").selectAll("line").data(links).join("line").attr("class", (l) => `cm-link ${l.rel}${l.critical ? " crit" : ""}${l.second ? " second" : ""}`).attr("stroke", (l) => (l.critical ? "#FF6B85" : MAP_COL[l.rel] || "#888")).attr("stroke-width", (l) => 0.8 + l.w * 0.7);
    const tip = $("#cm-tip");
    const node = root.append("g").selectAll("g").data(nodes).join("g").attr("class", (n) => `cm-node g-${n.group}`).style("cursor", (n) => (/^[A-Z0-9.\-]{1,10}$/.test(n.id) && n.group !== "center" && n.group !== "risk" ? "pointer" : "grab"));
    node.append("circle").attr("class", "cm-halo").attr("r", (n) => R(n) + 6).attr("fill", "none").attr("stroke", (n) => (critIds.has(n.id) ? "#FF6B85" : "transparent")).attr("stroke-width", 2).attr("stroke-dasharray", "3 3");
    node.append("circle").attr("class", "cm-dot").attr("r", 0).attr("fill", (n) => (n.group === "center" ? "url(#cmc)" : MAP_COL[n.group] || "#888")).attr("fill-opacity", (n) => (n.group === "center" ? 1 : 0.9))
      .transition().duration(900).delay((n, i) => (n.group === "center" ? 0 : 250 + i * 25)).ease(d3.easeBackOut.overshoot(1.4)).attr("r", R);
    const short = (n) => n.label.replace(" (private)", "").replace(/,? (Inc\.?|LLC|L\.?P\.?|Corporation|Corp\.?|Company|Co\.?)$/i, "").replace(/\s*&\s*$/, "").replace(/ (Capital|Asset|Investment) Management.*$/i, "").replace(/ Group$/i, "");
    node.append("text").attr("class", "cm-lbl").attr("text-anchor", "middle").attr("dy", (n) => (n.group === "center" ? 5 : R(n) + 14)).text((n) => (n.group === "center" ? n.id : short(n)));
    node.filter((n) => n.group === "center").append("text").attr("class", "cm-sub").attr("text-anchor", "middle").attr("dy", 66).text((n) => n.label);
    node.on("mouseenter", (ev, n) => { const ls = links.filter((l) => l.s === n.id || l.t === n.id); tip.hidden = n.group === "center"; if (n.group === "center") return;
        tip.innerHTML = `<b>${esc(n.label)}</b><i style="color:${MAP_COL[n.group]}">${esc(MAP_WORD[n.group] || n.group)}${n.also ? " · also " + esc(MAP_WORD[n.also] || n.also) : ""}${critIds.has(n.id) ? " · single point of failure" : ""}</i>${ls.slice(0, 2).map((l) => `<span>${esc(l.why)}</span>`).join("")}`;
        const r = el.getBoundingClientRect(); tip.style.left = Math.min(r.width - 280, Math.max(8, ev.clientX - r.left + 14)) + "px"; tip.style.top = Math.max(8, ev.clientY - r.top + 14) + "px";
        link.classed("dim", (l) => l.s !== n.id && l.t !== n.id); node.classed("dim", (m) => m.id !== n.id && !ls.some((l) => l.s === m.id || l.t === m.id)); })
      .on("mouseleave", () => { tip.hidden = true; link.classed("dim", false); node.classed("dim", false); })
      .on("click", (ev, n) => { if (ev.defaultPrevented) return; if (n.group !== "center" && n.group !== "risk" && /^[A-Z0-9.\-]{1,10}$/.test(n.id) && !["OPENAI", "XAI", "HUAWEI", "EXPORT", "TAIWAN"].includes(n.id)) { const q = $("#map-q"); if (q) q.value = n.id; loadMap(n.id); } });
    const ring = { customer: 0.30, supplier: 0.30, partner: 0.36, rival: 0.34, risk: 0.24, owner: 0.44, peer: 0.34, second: 0.46 };
    const ang = { customer: 0, supplier: Math.PI, partner: Math.PI * 1.5, rival: Math.PI * 0.5, risk: Math.PI * 0.75, owner: Math.PI * 1.25, peer: Math.PI * 0.25, second: Math.PI };
    const side = Math.min(W, H);
    mapSim = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id((n) => n.id).distance((l) => (l.second ? 70 : side * (ring[l.rel] || 0.32))).strength((l) => (l.second ? 0.6 : 0.25)))
      .force("charge", d3.forceManyBody().strength((n) => (n.group === "center" ? -900 : -260)))
      .force("collide", d3.forceCollide().radius((n) => Math.max(R(n) + 16, (n.group === "center" ? 0 : Math.min(60, short(n).length * 3.4)))).iterations(2))
      .force("x", d3.forceX((n) => (n.group === "center" ? W / 2 : W / 2 + Math.cos(ang[n.group] || 0) * side * 0.34)).strength((n) => (n.group === "center" ? 0.9 : 0.12)))
      .force("y", d3.forceY((n) => (n.group === "center" ? H / 2 : H / 2 + Math.sin(ang[n.group] || 0) * side * 0.30)).strength((n) => (n.group === "center" ? 0.9 : 0.14)))
      .on("tick", () => {
        nodes.forEach((n) => { const r = R(n) + 4, lx = n.group === "center" ? r : Math.max(r, short(n).length * 3.3 + 4); n.x = Math.max(lx, Math.min(W - lx, n.x)); n.y = Math.max(r, Math.min(H - r - 16, n.y)); });
        link.attr("x1", (l) => l.source.x).attr("y1", (l) => l.source.y).attr("x2", (l) => l.target.x).attr("y2", (l) => l.target.y);
        node.attr("transform", (n) => `translate(${n.x},${n.y})`);
      });
    node.call(d3.drag().on("start", (ev, n) => { if (!ev.active) mapSim.alphaTarget(0.25).restart(); n.fx = n.x; n.fy = n.y; }).on("drag", (ev, n) => { n.fx = ev.x; n.fy = ev.y; }).on("end", (ev, n) => { if (!ev.active) mapSim.alphaTarget(0); n.fx = null; n.fy = null; }));
  }
  document.addEventListener("submit", (e) => { const f = e.target.closest && e.target.closest("[data-map-form]"); if (!f) return; e.preventDefault(); const s2 = resolveMapQuery(($("#map-q") || {}).value); if (s2) loadMap(s2); });
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-map-go]"); if (!b) return; const q = $("#map-q"); if (q) q.value = b.getAttribute("data-map-go"); loadMap(b.getAttribute("data-map-go")); });

  // ======================= MARKET CONTEXT: the bigger picture, drawn =======================
  let ctxWin = "3m";
  const CTX_WINS = [["1m", "1 month"], ["3m", "3 months"], ["6m", "6 months"], ["12m", "12 months"]];
  const REGIME_WORD = { strong_uptrend: ["Strong uptrend", "up"], uptrend_pulling_back: ["Uptrend, pulling back", "up"], range: ["Going sideways", "flat"], topping: ["Topping out", "warn"], downtrend: ["Downtrend", "down"], bottoming: ["Bottoming", "warn"] };
  const MACRO_WORD = { growth_boom: "a growth boom", disinflation_rally: "a disinflation rally", inflation_scare: "an inflation scare", growth_scare: "a growth scare", liquidity_melt_up: "a liquidity melt-up", risk_off: "risk-off", mixed: "mixed signals" };
  function ctxRegime(r) {
    const H = r.horizons || {}; const a = (H.assets || []).find((x) => x.symbol === "ES=F") || (H.assets || [])[0]; if (!a) return "";
    const ai = a.ai || {}, cx = H.ai || {};
    const rg = ai.regime ? REGIME_WORD[ai.regime.choice] || [pretty(ai.regime.choice), "flat"] : null;
    const closes = a.closes_12m || [];
    const lean = cx.equity_lean_3m ? cx.equity_lean_3m.choice : null, risk = cx.biggest_risk ? pretty(cx.biggest_risk.choice) : null, macro = cx.macro_read ? cx.macro_read.choice : null;
    return `<article class="pz ctx-reg" data-ctx="regime">
      <div class="pz-h"><span class="pz-eye">The primary trend · S&amp;P 500</span><span class="pz-hint">12 months</span></div>
      <div class="cx-word ${rg ? rg[1] : "flat"}">${rg ? rg[0] : "No read"}</div>
      <p class="pl-lede">${ai.alignment ? esc(HZ.alignment[ai.alignment.choice] || "") : ""} ${a.above_sma200 ? "It trades above its 200-day average." : "It trades below its 200-day average."}</p>
      ${areaSpark(closes, cls(closes[closes.length - 1] - closes[0]), "cxsp")}
      <div class="cx-facts">
        <div><span>Macro backdrop</span><b>${macro ? esc(MACRO_WORD[macro] || pretty(macro)) : "–"}</b></div>
        <div><span>Next 3 months</span><b class="${{ higher: "up", lower: "down" }[lean] || "flat"}">${lean ? esc(lean) : "–"}</b></div>
        <div><span>Biggest risk</span><b class="warn">${risk ? esc(risk) : "–"}</b></div>
      </div>
      <div class="pz-foot">Reads from OneView's model or its backup rules; not a forecast.</div>
    </article>`;
  }
  function ctxRace(r) {
    const H = r.horizons || {};
    const rows = (H.assets || []).map((a) => { const h = (a.horizons || {})[ctxWin] || {}; return { label: a.label.replace(" futures", ""), sym: a.symbol, v: h.return_pct, pos: h.range_pos, dd: h.max_drawdown_pct, yield: a.kind === "yield" }; })
      .concat((r.indices || []).filter((i) => ["IWM", "DIA"].includes(i.symbol)).map((i) => { const t = i.technicals || {}; const v = { "1m": t.ret_1m, "3m": t.ret_3m, "6m": t.ret_6m, "12m": t.ret_12m }[ctxWin]; return { label: IDX_NAMES[i.symbol], sym: i.symbol, v, pos: null }; }))
      .filter((x) => isNum(x.v)).sort((a, b) => b.v - a.v);
    if (!rows.length) return "";
    const mx = Math.max(1, ...rows.map((x) => Math.abs(x.v)));
    const seg = CTX_WINS.map(([k, l]) => `<button type="button" class="${k === ctxWin ? "on" : ""}" data-ctx-win="${k}">${l.replace(" months", "M").replace(" month", "M")}</button>`).join("");
    const bars = rows.map((x) => `<li><span class="rc-l">${esc(x.label)}${x.yield ? "<i>yield change</i>" : ""}</span><span class="ps-bar"><i class="${cls(x.v)}" style="${x.v >= 0 ? "left:50%" : "right:50%"};width:${((Math.abs(x.v) / mx) * 50).toFixed(1)}%"></i></span><span class="ps-v ${cls(x.v)}">${fpct(x.v, 1)}</span>${isNum(x.pos) ? `<span class="rc-pos" title="Where it sits between the low and the high of the period"><i style="left:${(x.pos * 100).toFixed(0)}%"></i></span>` : `<span class="rc-pos none"></span>`}</li>`).join("");
    const lead = rows[0], lag = rows[rows.length - 1];
    return `<article class="pz ctx-race" data-ctx="race">
      <div class="pz-h"><span class="pz-eye">The asset race</span><div class="pz-seg">${seg}</div></div>
      <p class="pl-lede"><b class="${cls(lead.v)}">${esc(lead.label)}</b> leads over ${CTX_WINS.find((w) => w[0] === ctxWin)[1]}, <b class="${cls(lag.v)}">${esc(lag.label)}</b> trails.</p>
      <ul class="ps-list rc-list">${bars}</ul>
      <div class="rc-legend"><span>return</span><span>where it sits in the period's range, low to high</span></div>
    </article>`;
  }
  function ctxRates(r) {
    const R = r.rates || {}; if (!R.curve || !R.curve.length) return "";
    const pts = (key) => R.curve.filter((c) => isNum(c[key])).map((c) => ({ x: Math.log(c.tenor_years * 12 + 1), y: c[key], title: `${c.label} ${c[key].toFixed(2)}%` }));
    const xl = R.curve.map((c) => ({ x: Math.log(c.tenor_years * 12 + 1), text: c.label })).filter((_, i) => i % 2 === 0 || i === R.curve.length - 1);
    const curve = lineChart([{ cls: "l3", points: pts("year_ago") }, { cls: "l2", points: pts("month_ago") }, { cls: "l1", points: pts("today"), dots: true }], { w: 560, h: 190, xlabels: xl, yfmt: (v) => v.toFixed(1) + "%" });
    const s2 = ((R.spreads || {})["2s10s"] || {}).latest;
    const ten = (R.live || []).find((y) => /10/.test(y.label)) || {};
    const ang = isNum(s2) ? Math.max(-90, Math.min(90, (s2 / 150) * 90)) : 0;
    const shape = !isNum(s2) ? "–" : s2 < 0 ? ["Inverted", "down", "Short rates above long rates: the classic recession warning."] : s2 < 50 ? ["Flat to normal", "warn", "Barely positive: the curve is only just back to its normal shape."] : ["Normal, upward", "up", "Long rates comfortably above short rates: the healthy shape."];
    const up = isNum(R.chg_10y_1m_bp) && R.chg_10y_1m_bp > 0;
    return `<article class="pz ctx-rates" data-ctx="rates">
      <div class="pz-h"><span class="pz-eye">Interest rates</span><span class="pz-hint">Treasury curve · FRED ${esc(R.as_of || "")}</span></div>
      <div class="cr-grid2">
        <div>${curve}<div class="legend"><span><i class="k1"></i>today</span><span><i class="k2"></i>1 month ago</span><span><i class="k3"></i>1 year ago</span></div></div>
        <div class="rt-side">
          <div class="rt-dial"><svg viewBox="0 0 120 70" aria-label="2s10s spread ${isNum(s2) ? Math.round(s2) : "–"} basis points"><path d="M10 62 A50 50 0 0 1 110 62" class="rt-track"/><path d="M10 62 A50 50 0 0 1 60 12" class="rt-inv"/><g style="transform:rotate(${ang}deg);transform-origin:60px 62px"><line x1="60" y1="62" x2="60" y2="20" class="rt-needle"/></g><circle cx="60" cy="62" r="4" class="rt-hub"/></svg>
            <div class="rt-read"><b class="${shape[1]}">${shape[0]}</b><span>2s10s ${isNum(s2) ? (s2 > 0 ? "+" : "") + Math.round(s2) + " bp" : "–"}</span></div></div>
          <p class="od-p">${shape[2] || ""}</p>
          <div class="rt-10"><span>10-year</span><b>${isNum(ten.last) ? fnum(ten.last, 2) + "%" : "–"}</b><em class="${up ? "down" : "up"}">${fbp(R.chg_10y_1m_bp)} in a month</em></div>
          <p class="od-p">${up ? "Rising long yields make bonds more attractive and weigh most on growth stocks." : "Easing long yields help stocks, growth names most."}</p>
        </div>
      </div>
    </article>`;
  }
  function ring(pct, label, sub) {
    const C = 2 * Math.PI * 30, p = Math.max(0, Math.min(1, pct / 100));
    return `<div class="br-ring"><svg viewBox="0 0 80 80"><circle cx="40" cy="40" r="30" class="br-bg"/><circle cx="40" cy="40" r="30" class="br-fg ${pct >= 60 ? "up" : pct <= 40 ? "down" : "warn"}" style="stroke-dasharray:${(C * p).toFixed(1)} ${C.toFixed(1)}"/></svg><b>${Math.round(pct)}%</b><span>${label}</span><i>${sub}</i></div>`;
  }
  function ctxBreadth(r) {
    const B = (r.flows || {}).breadth || {}; if (!B.n) return "";
    const pc2 = (v) => (v / B.n) * 100;
    const ad = B.adv + B.dec ? (B.adv / (B.adv + B.dec)) * 100 : 50;
    return `<article class="pz ctx-br" data-ctx="breadth">
      <div class="pz-h"><span class="pz-eye">How many stocks are joining in</span><span class="pz-hint">${B.n} large US stocks</span></div>
      <div class="br-rings">${ring(pc2(B.above20), "above 20-day", "short term")}${ring(pc2(B.above50), "above 50-day", "medium term")}${ring(pc2(B.above200), "above 200-day", "long term")}</div>
      <div class="br-ad"><span>Up today <b class="up">${B.adv}</b></span><div class="cr-split"><i class="up" style="width:${ad.toFixed(0)}%"></i><i class="down" style="width:${(100 - ad).toFixed(0)}%"></i></div><span>Down <b class="down">${B.dec}</b></span></div>
      <p class="od-p">${pc2(B.above200) >= 60 && pc2(B.above20) < 50 ? "Most stocks are in long uptrends but the short-term push is fading: a pullback inside a healthy market." : pc2(B.above20) >= 60 ? "A broad move: most stocks are above their short-term averages." : pc2(B.above200) < 40 ? "Most stocks are below their long-term averages: a weak market under the surface." : "A mixed picture: participation is middling."}</p>
    </article>`;
  }
  function ctxRotation(r) {
    const S = ((r.flows || {}).sectors || []).filter((s) => isNum(s.rel_1m) && isNum(s.chg_5d)); if (S.length < 4) return "";
    const W = 640, H = 340, P = 36;
    const xs = S.map((s) => s.rel_1m), ys = S.map((s) => s.chg_5d);
    const mx = Math.max(2, ...xs.map(Math.abs)) * 1.15, my = Math.max(1, ...ys.map(Math.abs)) * 1.2;
    const X = (v) => P + ((v + mx) / (2 * mx)) * (W - 2 * P), Y = (v) => H - P - ((v + my) / (2 * my)) * (H - 2 * P);
    const quad = (s) => (s.rel_1m >= 0 ? (s.chg_5d >= 0 ? ["Leading", "up"] : ["Weakening", "warn"]) : (s.chg_5d >= 0 ? ["Improving", "acc"] : ["Lagging", "down"]));
    // labels: try a few positions around each dot and keep the first that does not touch a placed label
    const placed = [];
    const hit = (b) => placed.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y);
    const pts2 = S.map((s) => ({ s, x: X(s.rel_1m), y: Y(s.chg_5d) }));
    pts2.forEach((p) => placed.push({ x: p.x - 8, y: p.y - 8, w: 16, h: 16 }));      // dots are obstacles too
    const labelled = pts2.map((p) => {
      const w = p.s.label.length * 6.4 + 4, h = 13;
      const tries = [[10, -6], [10, -18], [10, 6], [-10 - w, -6], [-10 - w, -18], [-10 - w, 6], [-w / 2, -24], [-w / 2, 12], [10, -30], [10, 18]];
      let best = null;
      for (const [dx, dy] of tries) { const b = { x: p.x + dx, y: p.y + dy, w, h }; if (b.x < 2 || b.x + w > W - 2) continue; if (!hit(b)) { best = [dx, dy]; placed.push(b); break; } }
      if (!best) { best = [10, -6]; }
      return { ...p, lx: best[0], ly: best[1] + 10, lead: Math.abs(best[1] + 6) > 8 || best[0] < 0 };
    });
    const dots = labelled.map(({ s, x, y, lx, ly }) => { const q = quad(s); return `<g class="rt-pt ${q[1]}" transform="translate(${x.toFixed(1)},${y.toFixed(1)})"><title>${esc(s.label)}: ${fpct(s.rel_1m, 1)} vs the S&P over a month, ${fpct(s.chg_5d, 1)} this week (${q[0].toLowerCase()})</title><circle r="7"/><text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}">${esc(s.label)}</text></g>`; }).join("");
    const groups = { Leading: [], Weakening: [], Improving: [], Lagging: [] }; S.forEach((s) => groups[quad(s)[0]].push(s.label));
    return `<article class="pz ctx-rot" data-ctx="rotation">
      <div class="pz-h"><span class="pz-eye">Where the money is rotating</span><span class="pz-hint">sectors and themes · right = beating the S&amp;P over a month · up = rising this week</span></div>
      <div class="rot-wrap"><svg class="rot" viewBox="0 0 ${W} ${H}" role="img" aria-label="Sector rotation map">
        <rect x="${X(0)}" y="${P}" width="${W - P - X(0)}" height="${Y(0) - P}" class="q q-lead"/><rect x="${X(0)}" y="${Y(0)}" width="${W - P - X(0)}" height="${H - P - Y(0)}" class="q q-weak"/>
        <rect x="${P}" y="${P}" width="${X(0) - P}" height="${Y(0) - P}" class="q q-imp"/><rect x="${P}" y="${Y(0)}" width="${X(0) - P}" height="${H - P - Y(0)}" class="q q-lag"/>
        <line x1="${X(0)}" x2="${X(0)}" y1="${P}" y2="${H - P}" class="axis"/><line x1="${P}" x2="${W - P}" y1="${Y(0)}" y2="${Y(0)}" class="axis"/>
        <text x="${W - P - 6}" y="${P + 16}" text-anchor="end" class="ql up">LEADING</text><text x="${W - P - 6}" y="${H - P - 8}" text-anchor="end" class="ql warn">WEAKENING</text>
        <text x="${P + 6}" y="${P + 16}" class="ql acc">IMPROVING</text><text x="${P + 6}" y="${H - P - 8}" class="ql down">LAGGING</text>
        ${dots}</svg>
        <div class="rot-key">${[["Leading", "up", "beating the market and still rising"], ["Improving", "acc", "behind the market but turning up"], ["Weakening", "warn", "ahead of the market but slipping"], ["Lagging", "down", "behind and still falling"]].map(([k, c, d]) => `<div><b class="${c}">${k}</b><span>${d}</span><em>${groups[k].map(esc).join(", ") || "none"}</em></div>`).join("")}</div>
      </div>
    </article>`;
  }
  function secContext(r) {
    const cx = (r.horizons || {}).ai || {};
    const macro = cx.macro_read ? MACRO_WORD[cx.macro_read.choice] || pretty(cx.macro_read.choice) : null;
    return `<section class="pulse ctx">
      <div class="pulse-head"><span class="pz-live"><i></i>Market context · updated ${esc(r.generated_at.slice(11, 16))} ET</span>
        <h2>The bigger picture</h2><p>${macro ? `The backdrop reads as <b>${esc(macro)}</b>. ` : ""}The trend, the rates, how many stocks are joining in and where the money is rotating, in one screen.</p>
        <nav class="ctx-nav">${[["regime", "Trend"], ["race", "Asset race"], ["rates", "Rates"], ["breadth", "Breadth"], ["rotation", "Rotation"], ["weekly", "Weekly charts"]].map(([k, l]) => `<button type="button" data-jump='[data-ctx="${k}"]'>${l}</button>`).join("")}</nav></div>
      <div class="pulse-grid">${ctxRegime(r)}${ctxRace(r)}${ctxRates(r)}${ctxBreadth(r)}${ctxRotation(r)}${pulseRadar(r).replace('data-pz="radar"', 'data-pz="radar" data-ctx="radar"')}</div>
      <div data-ctx="weekly" class="ctx-weekly">${secIndexesWeekly(r)}</div>
      <details class="ctx-more"><summary>Full tables: every asset and horizon, every sector</summary>${secHorizons(r)}${secFlows(r)}</details>
    </section>`;
  }
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-ctx-win]"); if (!b || !report) return; ctxWin = b.getAttribute("data-ctx-win"); const el = $('[data-ctx="race"]'); if (!el) return; const tmp = document.createElement("div"); tmp.innerHTML = ctxRace(report); tmp.firstElementChild.classList.add("no-anim"); el.replaceWith(tmp.firstElementChild); });

  // ======================= HERO: the crowd right now, the top traders, the big bets =======================
  let prosSnap = null;
  async function pollPros() {
    if (STATIC_MODE) return;
    try { const res = await api("/api/pros", { cache: "no-store" }); if (!res.ok) return; const j = await res.json(); if (j.status !== "ok") { prosSnap = prosSnap || j; return; } prosSnap = j;
      if (currentView === "home" && report) { refreshPulse("pros"); refreshPulse("gauge"); const el = $(".pros"); const tmp = document.createElement("div"); tmp.innerHTML = secPros(report); if (el) { if (tmp.firstElementChild) el.replaceWith(tmp.firstElementChild); } else if (tmp.firstElementChild) { const a = $(".crowd") || $(".home-hero"); if (a) a.insertAdjacentElement("afterend", tmp.firstElementChild); } wireStocks(); }
    } catch (e) { /* server restarting */ }
  }
  const leanWord = (share) => (!isNum(share) ? ["No read", "flat"] : share >= 65 ? ["Bullish", "up"] : share >= 55 ? ["Leaning bullish", "up"] : share <= 35 ? ["Bearish", "down"] : share <= 45 ? ["Leaning bearish", "down"] : ["Split", "flat"]);
  function timelineBars(tl, id) {
    const pts = (tl || []).filter((x) => isNum(x.share)); if (pts.length < 2) return "";
    const W = 300, H = 64, bw = W / pts.length;
    const bars = pts.map((x, i) => { const h = Math.max(3, (x.share / 100) * (H - 14)); const c = x.share >= 55 ? "up" : x.share <= 45 ? "down" : "flat";
      return `<rect class="${c}" x="${(i * bw + 2).toFixed(1)}" y="${(H - 12 - h).toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="${h.toFixed(1)}" rx="3"><title>${x.bull} bullish, ${x.bear} bearish · to ${esc(agoShort(x.to))}</title></rect>`; }).join("");
    const y50 = H - 12 - (H - 14) / 2;
    return `<svg class="tl-bars" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Bullish share of posts through the sample, oldest on the left, now on the right">${bars}<line x1="0" x2="${W}" y1="${y50.toFixed(1)}" y2="${y50.toFixed(1)}" class="tl-50"/><text x="2" y="${H - 1}">older</text><text x="${W - 2}" y="${H - 1}" text-anchor="end">now</text></svg>`;
  }
  function heroCrowdCol(sym, name) {
    const t = crowd && crowd.talk && crowd.talk[sym]; const mood = crowd && crowd.moods && crowd.moods[sym];
    if (!t) return `<div class="hc-col"><div class="hc-h"><b>${sym}</b><i>${name}</i></div><div class="cr-loading">Reading the latest posts…</div></div>`;
    const last = t.last50 && isNum(t.last50.share) ? t.last50 : { share: t.newer && t.newer.bull_share, bull: t.newer && t.newer.bull, bear: t.newer && t.newer.bear };
    const w = leanWord(last.share); const wk = mood ? crowdWordFor(mood) : null;
    const q = (t.quotes.bull[0] && t.quotes.bear[0]) ? [t.quotes.bull[0], t.quotes.bear[0]] : [t.quotes.bull[0] || t.quotes.bear[0]].filter(Boolean);
    return `<div class="hc-col">
      <div class="hc-h"><b>${sym}</b><i>${name}</i><span class="hc-n">${t.posts} posts · ${esc(spanWords(t))}</span></div>
      <div class="hc-word ${w[1]}">${w[0]}<small>right now</small></div>
      <div class="hc-now">Latest ${last.bull + last.bear} tagged posts: <b class="up">${last.bull} bullish</b> · <b class="down">${last.bear} bearish</b></div>
      ${timelineBars(t.timeline)}
      ${wk && isNum(mood.score) ? `<div class="hc-week">Week mood vs normal: <b class="${wk[1]}">${wk[0].toLowerCase()}</b> (${mood.score}/100)${wk[1] !== w[1] && w[1] !== "flat" ? ' · <em>the latest chatter is going against it</em>' : ""}</div>` : ""}
      ${q.map((m) => `<blockquote class="hc-q ${t.quotes.bull.includes(m) ? "up" : "down"}">${esc(m.text.length > 120 ? m.text.slice(0, 117).replace(/\s+\S*$/, "") + "…" : m.text)}<span>${agoShort(m.at)}</span></blockquote>`).join("")}
    </div>`;
  }
  function heroCrowd(r) {
    if (!crowd || crowd.status !== "ok") return `<article class="pz pz-crowd" data-pz="crowd"><div class="pz-h"><span class="pz-eye">What people are saying</span></div><div class="cr-loading">Reading StockTwits…</div></article>`;
    return `<article class="pz pz-crowd" data-pz="crowd">
      <div class="pz-h"><span class="pz-eye">What people are saying</span><a class="pz-hint pz-jump" href="#crowd" data-jump=".crowd">StockTwits · all names ↓</a></div>
      <div class="hc-grid">${heroCrowdCol("SPY", "S&P 500")}${heroCrowdCol("QQQ", "Nasdaq 100")}</div>
    </article>`;
  }
  const handleLink = (u) => `<a class="tr-h" href="https://stocktwits.com/${encodeURIComponent(u)}" target="_blank" rel="noopener">@${esc(u)}</a>`;
  function heroPros(r) {
    const p = prosSnap;
    if (!p || p.status !== "ok") return `<article class="pz pz-pros" data-pz="pros"><div class="pz-h"><span class="pz-eye">Top traders · measured</span></div>
      <p class="pl-lede">OneView is scoring the most-followed StockTwits traders on every call they made: did the price go their way over the next five sessions? The first run takes about 6 minutes.</p><div class="cr-loading">Scoring the calls…</div></article>`;
    const q = p.qualified || [], c = p.consensus || {};
    const lean = (sym) => (c.tickers || []).find((x) => x.sym === sym);
    const row = (sym, name) => { const x = lean(sym); if (!x) return `<div class="tp-lean"><b>${sym}</b><span class="muted">no calls in ${c.window_h || 72} h</span></div>`;
      const sh = isNum(x.lean) ? Math.round(x.lean * 100) : 50; const w = leanWord(sh);
      return `<div class="tp-lean"><b>${sym}</b><div class="cr-split"><i class="up" style="width:${sh}%"></i><i class="down" style="width:${100 - sh}%"></i></div><span class="${w[1]}">${w[0]}</span><em>${x.bull} bull · ${x.bear} bear · ${x.traders} ${x.traders === 1 ? "trader" : "traders"}</em></div>`; };
    const others = (c.tickers || []).filter((x) => !["SPY", "QQQ"].includes(x.sym)).slice(0, 6).map((x) => { const sh = isNum(x.lean) ? Math.round(x.lean * 100) : 50; return `<span class="tp-chip ${sh >= 55 ? "up" : sh <= 45 ? "down" : "flat"}" data-ticker-page="${esc(x.sym)}">$${esc(x.sym)}<i>${x.bull}↑ ${x.bear}↓</i></span>`; }).join("");
    const latest = (c.latest || []).filter((x) => x.text).slice(0, 3).map((x) => `<li><div>${handleLink(x.username)}<span class="tr-rate">${Math.round(x.hit_rate * 100)}% of ${x.scored}</span><span class="tr-call ${x.side === "bullish" ? "up" : "down"}">${x.side} $${esc(x.sym)}</span><span class="tr-at">${agoShort(x.at)}</span></div><p>${esc(x.text.length > 130 ? x.text.slice(0, 127).replace(/\s+\S*$/, "") + "…" : x.text)}</p></li>`).join("");
    return `<article class="pz pz-pros" data-pz="pros">
      <div class="pz-h"><span class="pz-eye">Top traders · measured</span><a class="pz-hint pz-jump" href="#pros" data-jump=".pros">the leaderboard ↓</a></div>
      <p class="pl-lede">OneView has scored <b>${(p.rated || 0).toLocaleString()}</b> popular StockTwits traders on their own calls${isNum(p.median_hit) ? `. The typical one is right <b>${Math.round(p.median_hit * 100)}%</b> of the time` : ""}. Only <b>${q.length}</b> ${q.length === 1 ? "clears" : "clear"} <b>${Math.round(((p.method || {}).min_hit || 0.7) * 100)}%</b>${q.length ? `, and ${c.active || 0} of them posted in the last ${c.window_h || 72} hours` : ""}. The list grows as more accounts are scored.</p>
      ${q.length ? `${row("SPY", "S&P 500")}${row("QQQ", "Nasdaq 100")}${others ? `<div class="tp-others"><span class="cr-lbl">Also on their screens</span><div class="cr-topics">${others}</div></div>` : ""}${latest ? `<ul class="tp-latest">${latest}</ul>` : ""}` : `<div class="cr-none">No trader cleared the bar on this run. The leaderboard below shows who came closest.</div>`}
    </article>`;
  }
  function heroBets(r) {
    const m = oddsSnap && oddsSnap.market;
    if (!m) return `<article class="pz pz-bets" data-pz="bets"><div class="pz-h"><span class="pz-eye">The big bets</span></div><div class="cr-loading">Reading Polymarket and Kalshi…</div></article>`;
    const color = (l) => (/increase|hike/i.test(l) ? "down" : /decrease|cut/i.test(l) ? "up" : "flat");
    const fed = m.fed; const top = fed && fed.options[0];
    const line = (lbl, p, sub, c) => `<div class="hb-line"><span>${lbl}</span><b class="${c}">${pc(p)}</b><em>${sub}</em></div>`;
    return `<article class="pz pz-bets" data-pz="bets">
      <div class="pz-h"><span class="pz-eye">The big bets · real money</span><a class="pz-hint pz-jump" href="#odds" data-jump=".odds">all markets ↓</a></div>
      ${fed ? `<div class="hb-fed"><span class="hb-t">${esc(fed.title.replace("?", ""))}</span><div class="hb-big ${color(top.label)}">${pc(top.p)}<small>${esc(top.label.toLowerCase())}</small></div>
        <div class="od-stack">${fed.options.filter((x) => x.p >= 0.005).map((x) => `<i class="${color(x.label)}" style="width:${(x.p * 100).toFixed(1)}%" title="${esc(x.label)} ${pc(x.p)}"></i>`).join("")}</div>
        <div class="hb-opts">${fed.options.filter((x) => x.p >= 0.02).slice(0, 3).map((x) => `<span><i class="od-dot ${color(x.label)}"></i>${esc(x.label)} <b>${pc(x.p)}</b></span>`).join("")}</div>
        <div class="od-foot">${usd(fed.volume)} traded · Polymarket</div></div>` : ""}
      ${m.spx_close ? line("S&amp;P 500 closes above today's " + fnum(m.spx_close.spot, 0), m.spx_close.p_above_spot, esc((m.spx_close.when || "").replace(/^On /, "")) + " · " + usd(m.spx_close.volume), m.spx_close.p_above_spot >= 0.55 ? "up" : m.spx_close.p_above_spot <= 0.45 ? "down" : "flat") : ""}
      ${m.recession ? line("US recession by the end of 2026", m.recession.p, usd(m.recession.volume) + " traded", m.recession.p >= 0.3 ? "down" : "up") : ""}
      ${m.spx_year && m.spx_year.up && m.spx_year.up[0] ? line("S&amp;P 500 hits " + fnum(m.spx_year.up[0].k, 0) + " by December", m.spx_year.up[0].p, usd(m.spx_year.volume) + " traded", "flat") : ""}
    </article>`;
  }
  function heroMini(r) {
    return ["SPY", "QQQ", "IWM", "DIA"].map((sym) => { const x = idxOf(r, sym); if (!x) return ""; const closes = (x.ohlc || []).slice(-20).map((c) => c.c);
      return `<button type="button" class="hm-chip" data-ticker-page="${sym}" title="${IDX_NAMES[sym]}"><b>${sym}</b>${priceHtml(sym, x)}${spark(closes, closes.length > 1 ? cls(closes[closes.length - 1] - closes[0]) : "flat")}</button>`; }).join("");
  }
  // the traders' leaderboard, the method and the receipts, further down the page
  function secPros(r) {
    const p = prosSnap; if (!p || p.status !== "ok") return "";
    const q = p.qualified || [], m = p.method || {};
    const rows = q.map((t, i) => `<tr><td class="tp-rank">${i + 1}</td><td>${handleLink(t.username)}${t.name && t.name !== t.username ? `<i>${esc(t.name)}</i>` : ""}</td>
      <td><div class="tp-rate"><span class="tp-bar"><b style="width:${Math.round(t.hit_rate * 100)}%"></b></span><strong>${Math.round(t.hit_rate * 100)}%</strong></div><i>${t.hits} of ${t.scored} calls right</i></td>
      <td>${Math.round((t.bull_share || 0) * 100)}% bullish<i>${t.calls} calls read</i></td>
      <td>${t.likes.toLocaleString()} likes<i>on ${t.symbols.length} of the ${m.symbols ? m.symbols.length : 20} big names</i></td>
      <td class="tp-rc">${(t.receipts || []).slice(-4).map((c) => `<span class="${c.hit ? "up" : "down"}" title="${esc(c.side)} $${esc(c.sym)} on ${esc(c.entry_day)}: ${fpct(c.ret, 1)} in ${m.horizon_sessions} sessions">${c.hit ? "✓" : "✗"} $${esc(c.sym)}</span>`).join("")}</td></tr>`).join("");
    return `<section class="pros" id="pros">
      <div class="cr-head"><h3>Top traders, measured <span class="muted">StockTwits · updated ${esc(etTime(p.as_of))} ET · ${(p.rated || 0).toLocaleString()} traders rated · ${p.scored.toLocaleString()} calls scored${isNum(p.median_hit) ? ` · typical trader ${Math.round(p.median_hit * 100)}% right` : ""}</span></h3></div>
      <p class="cr-how">No one publishes verified hit rates for social-media traders, so OneView measures them. We read about ${m.posts_per_symbol || 200} recent posts on each of ${m.symbols ? m.symbols.length : 20} of the most-watched tickers, rank the authors by the likes their posts earn (StockTwits does not share follower counts), and read each leading account's last ${m.posts_per_trader || 90} posts, about ${m.per_run || 30} new accounts per run, building a ledger that keeps every call from the last year. Every post the author tagged bullish or bearish is a call, and so is an untagged post TypeSafe reads as a clear call. Entry is that session's close; the result is the close 1, 5 or 20 sessions later depending on the call's time frame (5 when none is given), one call per ticker per day. A trader makes this list with <b>${m.min_scored || 12}+ scored calls and ${Math.round((m.min_hit || 0.7) * 100)}%+ right</b>. In a rising market, bullish calls win more often, so check the bullish share too.</p>
      ${rows ? `<div class="od-tablew"><table class="od-table tp-table"><thead><tr><th>#</th><th>Trader</th><th>Hit rate</th><th>Calls</th><th>Following</th><th>Latest results</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="cr-none">No trader cleared ${Math.round((m.min_hit || 0.7) * 100)}% on ${m.min_scored || 12}+ calls in this run.</div>`}
      ${(p.near || []).length ? `<div class="od-none">Closest below the bar: ${p.near.slice(0, 6).map((t) => `@${esc(t.username)} ${Math.round((t.hit_rate || 0) * 100)}% of ${t.scored}`).join(" · ")}.</div>` : ""}
      ${(() => { const a = p.ai || {}; if (a.status === "no_credits") return `<div class="od-none">TypeSafe post reading is paused: the TypeSafe account has no credits. ${(a.pending || 0).toLocaleString()} untagged posts are waiting; until then only posts the authors tagged themselves count, judged five sessions later.</div>`;
        if (a.read || p.ai_calls) return `<div class="od-none">TypeSafe read ${(a.read || 0).toLocaleString()} posts this run: it turns clear untagged calls into calls (${(p.ai_calls || 0).toLocaleString()} so far, only when 75%+ sure) and sets each call's time frame, so a day trade is judged the next session and a long-term call after 20.</div>`; return ""; })()}
      <div class="pz-foot">Past calls do not guarantee future ones. Opinions from public accounts, not advice.</div>
    </section>`;
  }
  document.addEventListener("click", (e) => { const j = e.target.closest("[data-jump]"); if (!j) return; e.preventDefault(); const el = $(j.getAttribute("data-jump")); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); });

  // ======================= THE BETTING MARKETS: what people with money on the line expect =======================
  let oddsSnap = null; const oddsExtra = {}; const oddsBusy = new Set();
  const usd = (x) => (!isNum(x) ? "–" : x >= 1e6 ? "$" + (x / 1e6).toFixed(1) + "M" : x >= 1e3 ? "$" + (x / 1e3).toFixed(x >= 1e5 ? 0 : 1) + "K" : "$" + Math.round(x));
  const pc = (p) => (isNum(p) ? Math.round(p * 100) + "%" : "–");
  const thin = (v) => (isNum(v) && v < 1000 ? `<span class="od-thin" title="Under $1,000 traded: one or two people's opinion. Treat with care.">thin</span>` : "");
  const moneyTag = (v, url, src) => `<span class="od-money">${usd(v)} traded${thin(v)}${url ? ` · <a href="${esc(url)}" target="_blank" rel="noopener">${esc(src || "open")}</a>` : ""}</span>`;
  async function pollOdds() {
    if (STATIC_MODE) return;
    try { const res = await api("/api/odds", { cache: "no-store" }); if (!res.ok) return; const j = await res.json(); if (j.status !== "ok") return; oddsSnap = j;
      if (currentView === "home" && report) { const el = $(".odds"); const tmp = document.createElement("div"); tmp.innerHTML = secOdds(report); if (el) { if (tmp.firstElementChild) el.replaceWith(tmp.firstElementChild); } else if (tmp.firstElementChild) { const anchor = $(".crowd") || $(".home-hero"); if (anchor) anchor.insertAdjacentElement("afterend", tmp.firstElementChild); } wireStocks(); }
      if (currentView === "home" && report) refreshPulse("bets");
      if (currentView === "watch") rerenderWatch();
    } catch (e) { /* server restarting */ }
  }
  async function loadOddsSym(sym) {
    if (STATIC_MODE || oddsBusy.has(sym) || (oddsSnap && oddsSnap.tickers && oddsSnap.tickers[sym])) return;
    const have = oddsExtra[sym]; if (have && Date.now() - have.at < 900000) return;
    oddsBusy.add(sym);
    try { const res = await api(`/api/odds/${encodeURIComponent(sym)}`, { cache: "no-store" }); const j = res.ok ? await res.json() : {}; oddsExtra[sym] = { at: Date.now(), data: j.status === "ok" ? j : null }; } catch (e) { oddsExtra[sym] = { at: Date.now(), data: null }; }
    oddsBusy.delete(sym);
    if (currentView === "watch" && wlSel === sym) rerenderWatch();
  }
  const oddsFor = (sym) => (oddsSnap && oddsSnap.tickers && oddsSnap.tickers[sym]) || (oddsExtra[sym] && oddsExtra[sym].data) || null;
  const hasOdds = (o) => o && (o.updown || o.above || o.hit || (o.other || []).length);
  function ladderSvg(L, fmt) {
    const pts = (L.points || []).filter((x) => isNum(x.k) && isNum(x.p)); if (pts.length < 3) return "";
    const spot = L.spot || L.spot_price; const ks = pts.map((x) => x.k); const lo = Math.min(...ks), hi = Math.max(...ks);
    // zoom to where the curve actually moves (5% to 95%)
    const a = (pts.find((x) => x.p < 0.97) || pts[0]).k, b = ([...pts].reverse().find((x) => x.p > 0.03) || pts[pts.length - 1]).k;
    const x0 = Math.min(a, spot || a), x1 = Math.max(b, spot || b), pad = (x1 - x0) * 0.08 || 1, A = x0 - pad, B = x1 + pad;
    const W = 320, H = 96, X = (k) => ((k - A) / (B - A)) * W, Y = (p) => 8 + (1 - p) * (H - 24);
    const line = pts.filter((x) => x.k >= A && x.k <= B).map((x) => `${X(x.k).toFixed(1)},${Y(x.p).toFixed(1)}`).join(" ");
    return `<svg class="od-lad" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2="${W}" y1="${Y(0.5)}" y2="${Y(0.5)}" class="od-50"/>
      <polyline points="${line}"/>
      ${spot ? `<line x1="${X(spot)}" x2="${X(spot)}" y1="4" y2="${H - 14}" class="od-now"/><text x="${Math.min(W - 4, Math.max(4, X(spot)))}" y="${H - 2}" text-anchor="middle">now ${fmt(spot)}</text>` : ""}
      ${L.median ? `<circle cx="${X(L.median)}" cy="${Y(0.5)}" r="4" class="od-mid"/>` : ""}
    </svg>`;
  }
  function closeCard(label, d) {
    if (!d) return "";
    const pa = d.p_above_spot, lean = !isNum(pa) ? "" : pa >= 0.55 ? ["expects it higher", "up"] : pa <= 0.45 ? ["expects it lower", "down"] : ["sees a coin flip", "flat"];
    return `<div class="od-card"><div class="od-h"><b>${esc(label)}</b><span>${esc((d.when || "").replace(/^On /, ""))}</span></div>
      <div class="od-big ${lean[1] || ""}">${pc(pa)}</div>
      <p class="od-p">chance it closes <b>above today's ${fnum(d.spot, 0)}</b>. The market ${lean[0] || ""}; its middle guess for the close is <b>${fnum(d.median, 0)}</b> (${fpct((d.median / d.spot - 1) * 100, 1)}).</p>
      ${ladderSvg(d, (v) => fnum(v, 0))}
      <div class="od-foot">${moneyTag(d.volume, d.url, "Kalshi")}</div></div>`;
  }
  function secOdds(r) {
    const o = oddsSnap; if (!o || !o.market) return "";
    const m = o.market;
    const fed = m.fed ? (() => { const opts = m.fed.options.filter((x) => x.p >= 0.005); const top = opts[0];
      const color = (l) => (/increase|hike/i.test(l) ? "down" : /decrease|cut/i.test(l) ? "up" : "flat");
      return `<div class="od-card od-fed"><div class="od-h"><b>${esc(m.fed.title.replace("?", ""))}</b><span>ends ${esc(String(m.fed.end || "").slice(0, 10))}</span></div>
        <div class="od-big ${color(top.label)}">${pc(top.p)}</div><p class="od-p">chance of <b>${esc(top.label.toLowerCase())}</b>, the favourite. A hike is a headwind for stocks, a cut a tailwind.</p>
        <div class="od-stack">${opts.map((x) => `<i class="${color(x.label)}" style="width:${(x.p * 100).toFixed(1)}%" title="${esc(x.label)} ${pc(x.p)}"></i>`).join("")}</div>
        <ul class="od-opts">${opts.slice(0, 4).map((x) => `<li><span class="od-dot ${color(x.label)}"></span>${esc(x.label)}<b>${pc(x.p)}</b></li>`).join("")}</ul>
        <div class="od-foot">${moneyTag(m.fed.volume, m.fed.url, "Polymarket")}</div></div>`; })() : "";
    const rec = m.recession ? `<div class="od-card od-small"><div class="od-h"><b>${esc(m.recession.title.replace("?", ""))}</b></div><div class="od-big ${m.recession.p >= 0.3 ? "down" : "up"}">${pc(m.recession.p)}</div><p class="od-p">chance, priced by the market.</p><div class="od-foot">${moneyTag(m.recession.volume, m.recession.url, "Polymarket")}</div></div>` : "";
    const yr = m.spx_year ? `<div class="od-card od-small"><div class="od-h"><b>S&amp;P 500 by the end of December</b></div>
        <div class="od-targets">${(m.spx_year.up || []).map((x) => `<span class="up">hits ${fnum(x.k, 0)}<b>${pc(x.p)}</b></span>`).join("")}${(m.spx_year.down || []).map((x) => `<span class="down">falls to ${fnum(x.k, 0)}<b>${pc(x.p)}</b></span>`).join("")}</div>
        <div class="od-foot">${moneyTag(m.spx_year.volume, m.spx_year.url, "Polymarket")}</div></div>` : "";
    const fund = ["SPY", "QQQ", "IWM", "DIA"].map((s) => { const t = (o.tickers || {})[s]; const u = t && t.updown; if (!u) return `<div class="od-fund none"><b>${s}</b><span>no market</span></div>`;
      return `<div class="od-fund"><b>${s}</b><div class="od-meter"><i style="width:${(u.p_up * 100).toFixed(0)}%"></i></div><span class="${u.p_up >= 0.55 ? "up" : u.p_up <= 0.45 ? "down" : "flat"}">${pc(u.p_up)} up</span><em>${esc(u.when)} · ${usd(u.volume)}${u.volume < 1000 ? " · thin" : ""}</em></div>`; }).join("");
    const mine = activeList().filter((s) => !["SPY", "QQQ", "IWM", "DIA"].includes(s));
    const rows = mine.map((s) => ({ s, t: oddsFor(s) })).filter((x) => hasOdds(x.t));
    const none = mine.filter((s) => !hasOdds(oddsFor(s)));
    const wl = rows.map(({ s, t }) => { const u = t.updown, a = t.above, h = t.hit; const px = qp(s, stockFor(s) || (r.lite || {})[s] || {}).last;
      const midPct = a && a.median && isNum(px) ? (a.median / px - 1) * 100 : null; const vol = Math.max(u ? u.volume : 0, a ? a.volume : 0, h ? h.volume : 0);
      return `<tr data-ticker-page="${esc(s)}"><td><b>${esc(s)}</b></td>
        <td>${u ? `<span class="${u.p_up >= 0.55 ? "up" : u.p_up <= 0.45 ? "down" : "flat"}">${pc(u.p_up)}</span><i>${esc(u.when)}</i>` : "–"}</td>
        <td>${a && isNum(a.p_above_spot) ? `<span class="${a.p_above_spot >= 0.55 ? "up" : a.p_above_spot <= 0.45 ? "down" : "flat"}">${pc(a.p_above_spot)}</span><i>${esc(a.when)}</i>` : "–"}</td>
        <td>${a && a.median ? `${fnum(a.median)} <span class="${cls(midPct)}">${fpct(midPct, 1)}</span>` : "–"}</td>
        <td>${h ? `${h.up ? `<span class="up">↑ ${fnum(h.up.k, 0)} ${pc(h.up.p)}</span>` : ""}${h.down ? ` <span class="down">↓ ${fnum(h.down.k, 0)} ${pc(h.down.p)}</span>` : ""}<i>${esc(h.when)}</i>` : "–"}</td>
        <td class="od-oth">${(t.other || []).slice(0, 2).map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener" data-stop>${esc(x.title.replace(/\?$/, ""))}${x.label ? " · " + esc(x.label) : ""}</a><b>${pc(x.p)}</b>`).join("<br>") || "–"}</td>
        <td class="od-v">${usd(Math.max(vol, ...(t.other || []).map((x) => x.volume || 0)))}${Math.max(vol, ...(t.other || []).map((x) => x.volume || 0)) < 1000 ? '<span class="od-thin">thin</span>' : ""}</td></tr>`; }).join("");
    return `<section class="odds">
      <div class="od-head"><h3>The betting markets <span class="muted">Polymarket and Kalshi · real money on the outcome · updated ${esc(etTime(o.as_of))} ET</span></h3></div>
      <p class="cr-how">A price of 64¢ on "Yes" means the market puts the chance at about 64%. These are bets, not forecasts from OneView. Where little money has traded the number is marked <span class="od-thin">thin</span>: treat it as one or two people's opinion.</p>
      <div class="od-grid">${fed}${closeCard("S&P 500 next close", m.spx_close)}${closeCard("Nasdaq-100 next close", m.ndx_close)}<div class="od-col">${rec}${yr}</div></div>
      <div class="od-funds"><h4>Index funds: up or down next session</h4><div class="od-fund-grid">${fund}</div></div>
      <div class="od-wl"><h4>Your watchlist on the betting markets</h4>
        ${wl ? `<div class="od-tablew"><table class="od-table"><thead><tr><th>Name</th><th>Up next session</th><th>Closes above today</th><th>Market's middle guess</th><th>Will it hit</th><th>Other bets</th><th>Money</th></tr></thead><tbody>${wl}</tbody></table></div>` : `<div class="cr-none">None of your names has an open betting market right now.</div>`}
        ${none.length ? `<div class="od-none">No open betting market for: ${none.map(esc).join(", ")}. Prediction markets list mostly the biggest names.</div>` : ""}
      </div>
    </section>`;
  }
  // the selected Watchlist name: its crowd and its betting markets, both fetched on demand
  function wlCrowdOdds(sym) {
    if (STATIC_MODE) return "";
    const t = talkFor(sym), ex = crowdExtra[sym];
    if (!t && !ex) setTimeout(() => loadCrowdSym(sym), 0);
    const o = oddsFor(sym), oe = oddsExtra[sym];
    if (!o && !oe) setTimeout(() => loadOddsSym(sym), 0);
    const mood = (crowd && crowd.moods && crowd.moods[sym]) || (ex && ex.mood);
    const w = mood ? crowdWordFor(mood) : null;
    const tg = t ? t.bull + t.bear : 0, bs = tg ? Math.round((t.bull / tg) * 100) : null;
    const crowdHtml = t ? `<div class="wd-crowd"><div class="wd-ch"><span>StockTwits · last ${t.posts} posts over ${esc(spanWords(t))}</span>${w && isNum(mood.score) ? `<b class="${w[1]}">${w[0]} <small>${mood.score}/100 vs normal</small></b>` : ""}</div>
        <div class="cr-split"><i class="up" style="width:${bs ?? 50}%"></i><i class="down" style="width:${100 - (bs ?? 50)}%"></i></div>
        <div class="wd-cn"><span class="up">${t.bull} bullish</span><span class="down">${t.bear} bearish</span>${isNum((t.older || {}).bull_share) && isNum((t.newer || {}).bull_share) ? `<span>shift ${t.older.bull_share}% → ${t.newer.bull_share}% bullish</span>` : ""}</div>
        ${(t.topics || []).length ? `<div class="cr-topics">${t.topics.slice(0, 4).map((x) => `<span class="cr-topic">${esc(x.label)}<i>${x.n}</i></span>`).join("")}</div>` : ""}</div>`
      : `<div class="wd-crowd"><div class="cr-loading">${ex ? "No StockTwits posts to read on this name." : "Reading the last 200 StockTwits posts. About half a minute the first time."}</div></div>`;
    let oddsHtml;
    if (hasOdds(o)) {
      const u = o.updown, a = o.above, h = o.hit;
      oddsHtml = `<div class="wd-odds">
        ${u ? `<div><span>Up ${esc(u.when)}</span><b class="${u.p_up >= 0.55 ? "up" : u.p_up <= 0.45 ? "down" : "flat"}">${pc(u.p_up)}</b><em>${usd(u.volume)}${u.volume < 1000 ? " · thin" : ""}</em></div>` : ""}
        ${a && isNum(a.p_above_spot) ? `<div><span>Above today ${esc(a.when)}</span><b class="${a.p_above_spot >= 0.55 ? "up" : a.p_above_spot <= 0.45 ? "down" : "flat"}">${pc(a.p_above_spot)}</b><em>middle ${fnum(a.median)} · ${usd(a.volume)}${a.volume < 1000 ? " · thin" : ""}</em></div>` : ""}
        ${h && h.up ? `<div><span>Hits ${fnum(h.up.k, 0)} (${esc(h.when)})</span><b class="up">${pc(h.up.p)}</b><em>${usd(h.volume)}</em></div>` : ""}
        ${h && h.down ? `<div><span>Drops to ${fnum(h.down.k, 0)} (${esc(h.when)})</span><b class="down">${pc(h.down.p)}</b><em>${usd(h.volume)}</em></div>` : ""}
        ${(o.other || []).map((x) => `<div class="wd-oth"><span>${esc(x.title.replace(/\?$/, ""))}${x.label ? " · " + esc(x.label) : ""}</span><b>${pc(x.p)}</b><em>${usd(x.volume)}${x.volume < 1000 ? " · thin" : ""} · <a href="${esc(x.url)}" target="_blank" rel="noopener">open</a></em></div>`).join("")}
      </div><div class="pz-foot">Polymarket prices. A bet, not a OneView forecast.${(u || a || h) && (u || a || h).url ? ` <a href="${esc((u || a || h).url)}" target="_blank" rel="noopener">open</a>` : ""}</div>`;
    } else oddsHtml = `<div class="cr-none">${o || oe ? "No open betting market on this name. Prediction markets list mostly the biggest names." : "Looking up the betting markets…"}</div>`;
    return `<div class="wd-sec"><h5>The crowd</h5>${crowdHtml}</div><div class="wd-sec"><h5>The betting markets</h5>${oddsHtml}</div>`;
  }
  // ======================= WATCHLIST: one list to scan, one panel to understand =======================
  let wlSel = null, wlSort = "mine", wlFilter = "all";
  try { const j = JSON.parse(localStorage.getItem("mu-wl-ui") || "{}"); wlSort = j.sort || "mine"; wlFilter = j.filter || "all"; } catch (e) {}
  const saveWlUi = () => { try { localStorage.setItem("mu-wl-ui", JSON.stringify({ sort: wlSort, filter: wlFilter })); } catch (e) {} };
  const WL_SORTS = [["mine", "My order"], ["up", "Top gainers"], ["down", "Top losers"], ["score", "Best setup"], ["az", "A to Z"]];
  const WL_FILTERS = [["all", "All"], ["up", "Bullish"], ["flat", "Neutral"], ["down", "Bearish"]];
  const toneOf = (c) => (c === "up" || c === "up2" ? "up" : c === "down" ? "down" : c === "flat" ? "flat" : "none");
  function wlItem(t, r) {
    const s = stockFor(t), l = (r.lite || {})[t] || null;
    const q = qp(t, s || l || {});
    const v = s ? readFor(s) : l && ETF_KINDS.has(l.kind) ? verdictFor({ ...l, ticker: t }) : null;
    const a = (s && s.ai) || {};
    const score = !s ? null : horizon === "day" ? s.scores.day : horizon === "long" ? (a.long_term_quality ? a.long_term_quality.score / 3 : null) : s.scores.swing;
    const chg = isNum(q.chg) && Math.abs(q.chg) < 0.05 ? 0 : q.chg;
    return { t, s, l, q, v, chg, score, tone: v ? toneOf(v.cls) : "none", name: (s && s.name) || (l && l.name) || "", closes: s ? (s.ohlc || []).slice(-30).map((c) => c.c) : [] };
  }
  function wlItems(r) {
    const all = activeList().map((t, i) => ({ ...wlItem(t, r), i }));
    let rows = wlFilter === "all" ? all : all.filter((x) => x.tone === wlFilter);
    const by = { mine: (a, b) => a.i - b.i, up: (a, b) => (b.chg ?? -1e9) - (a.chg ?? -1e9), down: (a, b) => (a.chg ?? 1e9) - (b.chg ?? 1e9), score: (a, b) => (b.score ?? -1) - (a.score ?? -1), az: (a, b) => a.t.localeCompare(b.t) }[wlSort] || ((a, b) => a.i - b.i);
    rows = rows.slice().sort(by);
    return { all, rows };
  }
  const WL_HZ = { day: "today's read", swing: "the swing read", long: "the long-term read" };
  function wlSummary(all) {
    const withChg = all.filter((x) => isNum(x.chg)); if (!withChg.length) return "";
    const up = withChg.filter((x) => x.chg > 0).length, dn = withChg.filter((x) => x.chg < 0).length;
    const avg = withChg.reduce((a, x) => a + x.chg, 0) / withChg.length;
    const best = withChg.slice().sort((a, b) => b.chg - a.chg)[0], worst = withChg.slice().sort((a, b) => a.chg - b.chg)[0];
    const cnt = { up: 0, flat: 0, down: 0, none: 0 }; all.forEach((x) => cnt[x.tone]++);
    const tot = all.length || 1;
    return `<div class="wl-sum">
      <div class="ws-tile"><span>Up today</span><b>${up}<i>/${withChg.length}</i></b><em>${dn} down</em></div>
      <div class="ws-tile"><span>Average move</span><b class="${cls(avg)}">${fpct(avg, 2)}</b><em>equal weight</em></div>
      <div class="ws-tile" data-wl-sel="${esc(best.t)}" role="button" tabindex="0"><span>Best</span><b>${esc(best.t)} <small class="${cls(best.chg)}">${fpct(best.chg, 1)}</small></b><em>${esc(best.name || "")}</em></div>
      <div class="ws-tile" data-wl-sel="${esc(worst.t)}" role="button" tabindex="0"><span>Worst</span><b>${esc(worst.t)} <small class="${cls(worst.chg)}">${fpct(worst.chg, 1)}</small></b><em>${esc(worst.name || "")}</em></div>
      <div class="ws-tile ws-mix"><span>Reads · ${WL_HZ[horizon]}</span><div class="ws-bar"><i class="up" style="width:${(cnt.up / tot) * 100}%"></i><i class="flat" style="width:${(cnt.flat / tot) * 100}%"></i><i class="down" style="width:${(cnt.down / tot) * 100}%"></i><i class="none" style="width:${(cnt.none / tot) * 100}%"></i></div><em><b class="up">${cnt.up}</b> bullish · <b>${cnt.flat}</b> neutral · <b class="down">${cnt.down}</b> bearish${cnt.none ? ` · ${cnt.none} no read` : ""}</em></div>
    </div>`;
  }
  function wlRow(x) {
    const on = x.t === wlSel;
    return `<li class="wl-row ${on ? "on" : ""} t-${x.tone}" data-wl-sel="${esc(x.t)}" role="option" aria-selected="${on}" tabindex="${on ? 0 : -1}">
      <span class="wr-id"><b>${esc(x.t)}</b><i>${esc(x.name)}</i></span>
      <span class="wr-spark">${x.closes.length > 1 ? areaSpark(x.closes, cls(x.closes[x.closes.length - 1] - x.closes[0]), "ws" + x.t.replace(/[^A-Za-z0-9]/g, "")) : `<span class="wr-nochart">${analyzing.has(x.t) ? "analysing" : "quote only"}</span>`}</span>
      <span class="wr-px">${priceHtml(x.t, x.s || x.l || {})}</span>
      <span class="wr-read">${x.v ? `<em class="wr-pill ${x.tone}">${esc(x.v.word)}</em>` : `<em class="wr-pill none">${analyzing.has(x.t) ? "Analysing" : "No read"}</em>`}</span>
      <span class="wr-score" title="${isNum(x.score) ? `Setup score ${Math.round(x.score * 100)} of 100 for ${WL_HZ[horizon]}` : "No score yet"}">${isNum(x.score) ? `<i style="width:${Math.max(4, x.score * 100).toFixed(0)}%"></i>` : ""}</span>
      <button type="button" class="wr-x" data-wl-remove="${esc(x.t)}" title="Remove ${esc(x.t)}" aria-label="Remove ${esc(x.t)}">×</button>
    </li>`;
  }
  function wlReadTile(key, label, sub, word, plain, tone, conv) {
    const on = horizon === key;
    return `<button type="button" class="wd-read ${on ? "on" : ""} ${tone}" data-wl-hz="${key}" aria-pressed="${on}"><span class="wd-rl">${label}<i>${sub}</i></span><b>${esc(word || "No read")}</b>${conv ? convTag(conv) : ""}<span class="wd-rp">${esc(plain || "")}</span></button>`;
  }
  function wlDetail(x, r, id) {
    if (!x) return `<div class="wd-empty">Pick a name on the left to see its full story.</div>`;
    const s = x.s, l = x.l, t = (s && s.technicals) || (l && l.technicals) || {}, f = (s && s.fundamentals) || {}, a = (s && s.ai) || {};
    const head = `<div class="wd-h"><div class="wd-id"><b>${esc(x.t)}</b><span>${esc(x.name)}${s && s.sector ? " · " + esc(s.sector) : ""}</span></div><div class="wd-px">${priceHtml(x.t, s || l || {})}</div></div>`;
    const closes = s ? (s.ohlc || []).slice(-90).map((c) => c.c) : [];
    const lo = closes.length ? Math.min(...closes) : null, hi = closes.length ? Math.max(...closes) : null;
    const ch90 = closes.length > 1 ? (closes[closes.length - 1] / closes[0] - 1) * 100 : null;
    const chart = closes.length > 1 ? `<div class="wd-chart"><div class="wd-ch-h"><span>3 months</span><b class="${cls(ch90)}">${fpct(ch90, 1)}</b><span class="wd-ch-r">low ${fnum(lo)} · high ${fnum(hi)}</span></div>${areaSpark(closes, cls(ch90), "wd" + id + x.t.replace(/[^A-Za-z0-9]/g, ""))}</div>` : "";
    const pos = isNum(t.hi52) && isNum(t.lo52) && isNum(x.q.last) && t.hi52 > t.lo52 ? Math.max(0, Math.min(1, (x.q.last - t.lo52) / (t.hi52 - t.lo52))) : null;
    const range52 = pos != null ? `<div class="wd-52"><span>52-week range</span><div class="wd-52bar"><i style="left:${(pos * 100).toFixed(1)}%"></i></div><div class="wd-52n"><span>${fnum(t.lo52)}</span><span>${isNum(t.pct_from_hi52) ? (t.pct_from_hi52 > -0.5 ? "at the high" : fpct(t.pct_from_hi52, 1) + " from the high") : ""}</span><span>${fnum(t.hi52)}</span></div></div>` : "";
    if (!s) {
      const busy = analyzing.has(x.t);
      return `${head}${range52}<div class="wd-note">${busy ? "Reading the tape, the news, smart money and options now. This takes about 20 seconds." : analyzeError[x.t] ? `The last analysis failed: ${esc(analyzeError[x.t])}.` : "This name has a quote and basic technicals only. Run the full analysis to get the day, swing and long-term reads."}</div>
        <div class="wd-stats">${[["Trend", t.trend || "–", { up: "up", down: "down" }[t.trend] || ""], ["RSI 14", fnum(t.rsi14, 0), ""], ["Moves a day", fpct(t.atr_pct, 1, false), ""], ["1 month", fpct(t.ret_1m, 1), cls(t.ret_1m)], ["3 months", fpct(t.ret_3m, 1), cls(t.ret_3m)], ["vs 20-day avg", fpct(t.dist_sma20_pct, 1), cls(t.dist_sma20_pct)]].map(([k, v, c]) => `<div><span>${k}</span><b class="${c}">${v}</b></div>`).join("")}</div>
        <div class="wd-act">${STATIC_MODE ? "" : `<button type="button" class="btn" data-wl-analyze="${esc(x.t)}" ${busy ? "disabled" : ""}>${busy ? "Analysing…" : "Run full analysis"}</button>`}<a class="btn ghost" href="${tvLink(x.t)}" target="_blank" rel="noopener">Chart</a><button type="button" class="btn ghost" data-wl-remove="${esc(x.t)}">Remove</button></div>`;
    }
    const it = a.intraday ? ST.intraday[a.intraday.choice] : null, sv = verdictFor(s), ltv = a.long_term ? LT.stance[a.long_term.choice] : null;
    const reads = `<div class="wd-reads">${wlReadTile("day", "Day", "today", it && it[0], it && it[1], it ? toneOf(it[2]) : "none", a.intraday && convOf(a.intraday.confidence))}${wlReadTile("swing", "Swing", "1 to 10 days", sv && sv.word, sv && sv.plain, sv ? toneOf(sv.cls) : "none", sv && sv.conviction)}${wlReadTile("long", "Long term", "3 to 12 months", ltv && ltv[0], ltv && ltv[1], ltv ? toneOf(ltv[2]) : "none", a.long_term && convOf(a.long_term.confidence))}</div>`;
    const cur = readFor(s);
    const why = cur && cur.why && cur.why.length ? `<div class="wd-why"><h5>Why · ${WL_HZ[horizon]}</h5><ul>${cur.why.slice(0, 4).map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : "";
    const pl = plan(s);
    let planHtml = "";
    if (pl && pl.stop && isNum(pl.target)) {
      const px = x.q.last, lo2 = Math.min(pl.stop, px, pl.target), hi2 = Math.max(pl.stop, px, pl.target), rg = hi2 - lo2 || 1, at = (v) => (((v - lo2) / rg) * 100).toFixed(1);
      const longSide = pl.target > px;
      planHtml = `<div class="wd-plan"><h5>If you trade it · ${longSide ? "long" : "short"} idea from the swing read</h5>
        <div class="wd-pbar"><span class="risk" style="left:${Math.min(at(pl.stop), at(px))}%;width:${Math.abs(at(px) - at(pl.stop))}%"></span><span class="rew" style="left:${Math.min(at(px), at(pl.target))}%;width:${Math.abs(at(pl.target) - at(px))}%"></span>
          <i class="stop" style="left:${at(pl.stop)}%"></i><i class="now" style="left:${at(px)}%"></i><i class="tgt" style="left:${at(pl.target)}%"></i></div>
        <div class="wd-pn"><span class="down">Stop <b>${fnum(pl.stop)}</b></span><span>Now <b>${fnum(px)}</b></span><span class="up">Target <b>${fnum(pl.target)}</b></span><span class="wd-rr"><b>${pl.rr.toFixed(1)}×</b> reward for the risk</span></div></div>`;
    } else if (pl && pl.text) planHtml = `<div class="wd-plan"><h5>If you trade it</h5><p class="wd-note">${esc(pl.text)}</p></div>`;
    const ck = checklist(s, r);
    const stats = horizon === "long"
      ? [["3 months", fpct(t.ret_3m, 0), cls(t.ret_3m)], ["12 months", fpct(t.ret_12m, 0), cls(t.ret_12m)], ["P/E (forward)", fnum(f.forward_pe, 0), ""], ["Price / sales", fnum(f.ps, 1), ""], ["Revenue growth", isNum(f.rev_growth) ? fpct(f.rev_growth * 100, 0) : "–", cls(f.rev_growth)], ["Analysts", pretty(f.analyst) || "–", ""]]
      : horizon === "day"
      ? [["Moves a day", fpct(t.atr_pct, 1, false), ""], ["Volume vs normal", isNum(s.rel_volume) ? s.rel_volume.toFixed(1) + "×" : "–", s.rel_volume >= 1.5 ? "up" : ""], ["Yesterday's range", `${fnum(t.prev_low)}–${fnum(t.prev_high)}`, ""], ["Gap at the open", fpct(s.gap_pct, 1), cls(s.gap_pct)], ["RSI 14", fnum(t.rsi14, 0), t.rsi14 >= 70 ? "warn" : t.rsi14 <= 30 ? "warn" : ""], ["Day score", isNum(s.scores.day) ? Math.round(s.scores.day * 100) + "/100" : "–", ""]]
      : [["5 days", fpct(t.ret_5d, 1), cls(t.ret_5d)], ["1 month", fpct(t.ret_1m, 1), cls(t.ret_1m)], ["vs 20-day avg", fpct(t.dist_sma20_pct, 1), cls(t.dist_sma20_pct)], ["RSI 14", fnum(t.rsi14, 0), t.rsi14 >= 70 || t.rsi14 <= 30 ? "warn" : ""], ["Setup", a.setup ? pretty(a.setup.choice) : "–", ""], ["Checklist", ck ? `${ck.passed}/${ck.total}` : "–", ck ? (ck.passed >= 8 ? "up" : ck.passed >= 6 ? "warn" : "down") : ""]];
    const who = whoHtml(s);
    return `${head}${chart}${range52}${reads}${why}${planHtml}${wlCrowdOdds(x.t)}
      <div class="wd-stats">${stats.map(([k, v, c]) => `<div><span>${k}</span><b class="${c}">${esc(String(v))}</b></div>`).join("")}</div>
      ${who ? `<div class="wd-who"><h5>Who is buying</h5>${who}</div>` : ""}
      <div class="wd-act"><button type="button" class="btn" data-wl-open="${esc(x.t)}">Full analysis</button><button type="button" class="btn ghost" data-wl-page="${esc(x.t)}">Open page</button><a class="btn ghost" href="${tvLink(x.t)}" target="_blank" rel="noopener">Chart</a><button type="button" class="btn ghost wd-rm" data-wl-remove="${esc(x.t)}">Remove</button></div>`;
  }
  function wlBody(r) {
    const { all, rows } = wlItems(r);
    if (!all.length) return `<div class="wl-empty"><b>Your watchlist is empty</b><p>Type a ticker or company in the box above. Stocks, ETFs and crypto all work.</p><div class="wl-sugg">${["NVDA", "AAPL", "TSLA", "SPY", "AMD", "META"].map((t) => `<button type="button" data-wl-add="${t}">+ ${t}</button>`).join("")}</div></div>`;
    if (!wlSel || !all.some((x) => x.t === wlSel)) wlSel = (rows[0] || all[0]).t;
    const sel = all.find((x) => x.t === wlSel);
    const fcount = (k) => (k === "all" ? all.length : all.filter((x) => x.tone === k).length);
    const filters = WL_FILTERS.map(([k, lbl]) => `<button type="button" class="${k === wlFilter ? "on" : ""}" data-wl-filter="${k}">${lbl}<i>${fcount(k)}</i></button>`).join("");
    const sorts = `<label class="wl-sortl">Sort <select data-wl-sort aria-label="Sort the list">${WL_SORTS.map(([k, lbl]) => `<option value="${k}" ${k === wlSort ? "selected" : ""}>${lbl}</option>`).join("")}</select></label>`;
    const list = rows.map((x) => wlRow(x) + (x.t === wlSel ? `<li class="wl-inline" aria-hidden="false">${wlDetail(x, r, "m")}</li>` : "")).join("");
    return `${wlSummary(all)}
      <div class="wl-split">
        <div class="wl-left">
          <div class="wl-tools"><div class="pz-seg">${filters}</div>${sorts}</div>
          <div class="wl-colh"><span>Name</span><span>30 days</span><span>Price</span><span>Read · ${esc(HORIZONS.find((h) => h[0] === horizon)[1])}</span><span>Setup</span><span></span></div>
          <ul class="wl-list" role="listbox" aria-label="Watchlist">${list || `<li class="wl-none">Nothing matches this filter.</li>`}</ul>
        </div>
        <aside class="wl-detail" aria-live="polite">${wlDetail(sel, r, "d")}</aside>
      </div>`;
  }
  function secWatchPage(r) {
    const names = Object.keys(lists.lists);
    const tabs = names.map((n) => `<button class="ltab ${n === lists.active ? "active" : ""}" data-list="${esc(n)}">${esc(n)}<span class="cnt">${lists.lists[n].length}</span></button>`).join("");
    return `<section class="wl2">
      <div class="wl-bar">
        <div class="wl-lists">${tabs}<button class="ltab ghost" data-newlist title="Create another list">+ New list</button><span class="wl-lists-actions"><button class="lnk" data-renamelist>Rename</button><button class="lnk" data-deletelist>Delete</button></span></div>
        <div class="wl-newbar" id="list-new" hidden><input class="wl-newinput" placeholder="Name the list, then press Enter" maxlength="30"><button class="lnk" data-newcancel>cancel</button></div>
        <div class="wl-addrow"><div class="wl-add hud-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg><input id="search" type="search" placeholder="Add a ticker or company" autocomplete="off" spellcheck="false" aria-label="Add a ticker to your watchlist"><kbd>/</kbd><div id="search-results" class="search-results" hidden></div></div>
          <span class="wl-saved">${activeList().length} ${activeList().length === 1 ? "name" : "names"} · ${user ? "saved to your account" : "kept in this browser"}</span></div>
      </div>
      <div class="wl2-body">${wlBody(r)}</div>
    </section>`;
  }
  function rerenderWatch(focusSel) {
    if (currentView !== "watch" || !report) return;
    const b = $("#app .wl2-body"); if (!b) return;
    const view = $("#app .view"); const y = view ? view.scrollTop : 0; const wy = window.scrollY;
    b.innerHTML = wlBody(report);
    if (view) view.scrollTop = y; window.scrollTo(0, wy);
    if (focusSel) { const el = b.querySelector(".wl-row.on"); if (el) el.focus({ preventScroll: true }); }
    if (matchMedia("(max-width: 900px)").matches && focusSel) { const il = b.querySelector(".wl-inline"); if (il) il.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  }
  document.addEventListener("click", (e) => {
    const root = e.target.closest(".wl2"); if (!root) return;
    const rm = e.target.closest("[data-wl-remove]"); if (rm) { e.stopPropagation(); const t = rm.getAttribute("data-wl-remove"); if (t === wlSel) wlSel = null; removeTicker(t); return; }
    const op = e.target.closest("[data-wl-open]"); if (op) { openDetail(op.getAttribute("data-wl-open")); return; }
    const pg = e.target.closest("[data-wl-page]"); if (pg) { openTicker(pg.getAttribute("data-wl-page")); return; }
    const an = e.target.closest("[data-wl-analyze]"); if (an) { requestAnalysis(an.getAttribute("data-wl-analyze")); rerenderWatch(); return; }
    const hz = e.target.closest("[data-wl-hz]"); if (hz) { setHorizon(hz.getAttribute("data-wl-hz")); return; }
    const fl = e.target.closest("[data-wl-filter]"); if (fl) { wlFilter = fl.getAttribute("data-wl-filter"); saveWlUi(); rerenderWatch(); return; }
    const add = e.target.closest("[data-wl-add]"); if (add) { addTicker(add.getAttribute("data-wl-add")); return; }
    const sel = e.target.closest("[data-wl-sel]"); if (sel && !e.target.closest("a,.wl-inline")) { const t = sel.getAttribute("data-wl-sel"); if (t !== wlSel) { wlSel = t; rerenderWatch(true); } }
  });
  document.addEventListener("change", (e) => { const s = e.target.closest && e.target.closest("[data-wl-sort]"); if (s) { wlSort = s.value; saveWlUi(); rerenderWatch(); } });
  document.addEventListener("keydown", (e) => {
    const row = e.target.closest && e.target.closest(".wl-row"); if (!row) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); row.click(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); const rows = [...document.querySelectorAll("#app .wl-row")]; const i = rows.indexOf(row); const nx = rows[i + (e.key === "ArrowDown" ? 1 : -1)];
      if (nx) { wlSel = nx.getAttribute("data-wl-sel"); rerenderWatch(true); }
    }
  });
  function watchStrip(r) {
    const tickers = activeList();
    const chips = tickers.map((t) => { const s = stockFor(t); const q = s || (r.lite || {})[t] || {}; const st = s && s.ai && s.ai.stance ? s.ai.stance.choice : null;
      return `<span class="chip-t ${analyzing.has(t) ? "busy" : ""}"><button class="chip-open" data-ticker-page="${esc(t)}" title="Open ${esc(t)}"><i class="st-dot ${st ? ST.cls[st] : "none"}"></i><b>${esc(t)}</b><span class="delta ${cls(qp(t, q).chg)}">${isNum(qp(t, q).chg) ? fpct(qp(t, q).chg, 1) : ""}</span></button><button class="chip-x" data-remove="${esc(t)}" title="Remove ${esc(t)} from your watchlist" aria-label="Remove ${esc(t)}">×</button></span>`; }).join("");
    const names = Object.keys(lists.lists);
    const tabs = names.map((n) => `<button class="ltab ${n === lists.active ? "active" : ""}" data-list="${esc(n)}">${esc(n)}<span class="cnt">${lists.lists[n].length}</span></button>`).join("");
    return `<div class="wl-strip">
      <div class="wl-lists">${tabs}<button class="ltab ghost" data-newlist title="Create another list">+ New list</button><span class="wl-lists-actions"><button class="lnk" data-renamelist>Rename</button><button class="lnk" data-deletelist>Delete</button></span></div>
      <div class="wl-newbar" id="list-new" hidden><input class="wl-newinput" placeholder="Name the list, then press Enter" maxlength="30"><button class="lnk" data-newcancel>cancel</button></div>
      <div class="wl-head"><div><b>${esc(lists.active)}</b><span class="muted"> · ${tickers.length} ${tickers.length === 1 ? "name" : "names"} · ${user ? "saved to your account" : "kept in this browser"}</span></div><span class="muted wl-hint">Type a ticker to add · press × to remove · click a name for its page</span></div>
      <div class="wl-chips">${chips}<div class="wl-add hud-search"><input id="search" type="search" placeholder="Add ticker or company" autocomplete="off" spellcheck="false" aria-label="Add a ticker to your watchlist"><div id="search-results" class="search-results" hidden></div></div></div>
    </div>`;
  }
  function secWorld(r) {
    const W = (r.world || []).filter((x) => isNum(x.last)).map((x) => ({ ...x, chg_pct: qchg(x) }));
    if (!W.length) return "";
    const up = W.filter((x) => (x.chg_pct || 0) > 0.2).length, dn = W.filter((x) => (x.chg_pct || 0) < -0.2).length;
    const asia = W.filter((x) => ["Japan", "Hong Kong", "China", "Korea", "India", "Australia"].includes(x.region)), eu = W.filter((x) => ["UK", "Germany", "Europe"].includes(x.region));
    const tone = (g) => { const u = g.filter((x) => (x.chg_pct || 0) > 0.2).length, d = g.filter((x) => (x.chg_pct || 0) < -0.2).length; return u > d ? "up" : d > u ? "down" : "mixed"; };
    const line = `Asia ${tone(asia)}, Europe ${tone(eu)}: ${up > dn + 2 ? "risk appetite abroad is firm; the US open has a tailwind." : dn > up + 2 ? "selling abroad; expect a defensive US open." : "no lead from abroad; the US sets its own tone."}`;
    return `<section class="world"><h3>Around the world <span class="muted">${esc(line)}</span></h3><div class="world-grid">${W.map((x) => `<div class="wi ${cls(x.chg_pct)}"><span class="wi-r">${esc(x.region)}</span><b>${esc(x.label)}</b><span class="mono">${fnum(x.last, 0)}</span><span class="delta ${cls(x.chg_pct)}">${arrow(x.chg_pct)} ${fpct(x.chg_pct)}</span></div>`).join("")}</div></section>`;
  }
  const INDEX_ETFS = { SPY: "S&P 500", QQQ: "Nasdaq 100", DIA: "Dow 30", IWM: "Small caps" };
  // FIX 3: one source for sector performance. Every "leading" label on the page comes from the top row of this list.
  function sectorRows(r) {
    return ((r.flows || {}).sectors || []).map((x) => ({ ...x, chg: qp(x.symbol, { chg_pct: x.chg_1d, last: x.last }).chg })).filter((x) => isNum(x.chg)).sort((a, b) => b.chg - a.chg);
  }
  function leadingSector(r) { const rows = sectorRows(r); return rows.length ? rows[0] : null; }
  const leaderLabel = (r, fallback) => { const l = leadingSector(r); return l ? `${l.label} (${fpct(l.chg, 1)})` : fallback; };
  // FIX 2: the activity phrase is derived from the same classification as the verdict pill, so the two can never disagree.
  function pressingFor(v, q) {
    const code = v && v.code;
    if (["selling_today", "momentum_down", "drifting_down", "trend_down", "short_setup", "avoid"].includes(code)) return ["sellers pressing", "down"];
    if (["buying_today", "momentum_up", "drifting_up", "pullback_in_uptrend", "trend_up", "buy_now", "buy_the_dip"].includes(code)) return ["buyers pressing", "up"];
    if (code) return ["two-way", "flat"];
    const d = q && q.direction;                        // no verdict at all: fall back to the scanner's direction
    return d === "up" ? ["buyers pressing", "up"] : d === "down" ? ["sellers pressing", "down"] : ["two-way", "flat"];
  }
  const bigCap = (t, r) => { const s = stockFor(t); if (s && isNum((s.fundamentals || {}).market_cap)) return s.fundamentals.market_cap >= 10e9; const q = (r.lite || {})[t]; return !!(q && isNum(q.avg_dollar_volume) && q.avg_dollar_volume >= 1e9 && q.kind !== "ETF"); };
  const flowOf = (t, r) => { const q = Q.map[t] || {}; if (isNum(q.rvol)) return q; const l = ((r.lite || {})[t] || {}).scan; return l ? { rvol: l.rvol_tod, above_vwap: l.above_vwap, score: l.score, direction: l.direction } : {}; };
  function secBigMoney(r) {
    const sectors = sectorRows(r);
    const idx = Object.keys(INDEX_ETFS).map((t) => { const q = qp(t, (r.lite || {})[t] || (r.indices || []).find((i) => i.symbol === t)); const f = flowOf(t, r); return { t, q, f }; }).filter((x) => isNum(x.q.last));
    const tile = (x) => { const busy = isNum(x.f.rvol) ? (x.f.rvol >= 1.5 ? "up" : x.f.rvol <= 0.7 ? "down" : "flat") : "flat";
      const act = isNum(x.f.rvol) ? `<b class="${busy}">${x.f.rvol.toFixed(1)}×</b> the usual activity` : '<span class="muted">activity n/a</span>';
      const side = x.f.above_vwap == null ? "" : x.f.above_vwap ? '<span class="up">holding above the day\'s average price</span>' : '<span class="down">below the day\'s average price</span>';
      return `<div class="bm-tile ${cls(x.q.chg)}" data-ticker-page="${esc(x.t)}"><div class="bm-h"><b>${esc(x.t)}</b><span class="muted">${INDEX_ETFS[x.t]}</span></div>${priceHtml(x.t, null)}<div class="bm-act">${act}</div><div class="bm-side">${side}</div></div>`; };
    const large = Object.entries(Q.map).filter(([t, q]) => bigCap(t, r) && isNum(q.rvol) && q.rvol >= 1.3 && isNum(q.last)).map(([t, q]) => ({ t, q })).sort((a, b) => (b.q.dollar_vol || 0) - (a.q.dollar_vol || 0) || b.q.rvol - a.q.rvol).slice(0, 8);
    const nm = (t) => { const s = stockFor(t); return (s && s.name) || ((r.lite || {})[t] || {}).name || ""; };
    const rows = large.slice(0, 6).map(({ t, q }) => { const v = verdictFor(stockFor(t)); return `<tr class="clickable" data-ticker-page="${esc(t)}"><td class="sym"><b>${esc(t)}</b><div class="meta2">${esc(nm(t))}</div></td><td class="num">${priceHtml(t, null)}</td><td class="num"><b>${isNum(q.dollar_vol) ? fcap(q.dollar_vol) : "–"}</b><div class="meta2">traded today</div></td><td class="num"><b class="${q.rvol >= 2 ? "up" : ""}">${q.rvol.toFixed(1)}×</b><div class="meta2 ${pressingFor(v, q)[1]}">${pressingFor(v, q)[0]}</div></td><td>${v ? `<span class="pill ${v.cls}">${v.word}</span>` : '<span class="muted">not analysed</span>'}</td></tr>`; }).join("");
    const mx = Math.max(0.1, ...sectors.map((x) => Math.abs(x.chg)));
    const lead = sectors[0], lag = sectors[sectors.length - 1];
    const secLine = lead && lag && Math.abs(lead.chg) >= 0.15 ? `${esc(lead.label)} is the strongest group (${fpct(lead.chg, 1)}), ${esc(lag.label)} the weakest (${fpct(lag.chg, 1)}).` : sectors.length ? "No sector stands out yet: every group is within a fraction of a percent." : "";
    const bars = sectors.map((x) => `<div class="tb" data-ticker-page="${esc(x.symbol)}"><span class="tb-l">${esc(x.label)}</span><span class="tb-bar"><i class="${cls(x.chg)}" style="width:${(Math.abs(x.chg) / mx * 100).toFixed(0)}%"></i></span><span class="mono ${cls(x.chg)}">${fpct(x.chg, 1)}</span></div>`).join("");
    const stamp = `<span class="muted" data-qstamp>${quoteStamp()}</span>`;
    return `<section class="bigmoney"><h3>Where the big money is moving ${stamp}</h3>
      ${explain("The four funds below are where most professional money trades. When one trades far more than usual for the time of day, big players are moving. Below them: the largest companies trading unusually heavily right now, and which industry groups lead or lag.")}
      <div class="bm-grid">${idx.map(tile).join("") || '<div class="muted">Index quotes are not in this build.</div>'}</div>
      <div class="bm-two"><div><h4>Large companies with unusual activity ${large.length ? "" : '<span class="muted">none right now</span>'}</h4>${large.length ? `<table class="tbl bm-tbl"><thead><tr><th>Name</th><th>Price</th><th>Dollars</th><th>Activity</th><th>Read</th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty">${Q.liveAt ? "No large company is trading unusually heavily right now. Quiet tape among the big names." : "The minute-by-minute scan has not reported yet; this fills in shortly after the app connects."}</div>`}</div>
      <div><h4>Industry groups today</h4><div class="meta2" style="margin-bottom:6px">${secLine}</div><div class="tb-list">${bars || '<span class="muted">no sector data</span>'}</div></div></div>
    </section>`;
  }
  let brief = null;                     // {date, briefs: {morning, midday, close}}
  async function pollBrief() {
    if (STATIC_MODE) return;
    try { const res = await api("/api/brief", { cache: "no-store" }); if (!res.ok) return; const j = await res.json(); const sig = j.status === "ok" ? Object.values(j.briefs || {}).map((b) => b.generated_at).join("|") : ""; if (j.status === "ok" && (!brief || brief.sig !== sig)) { brief = j; brief.sig = sig; if (currentView === "home" && report) { const el = $(".briefs"); const tmp = document.createElement("div"); tmp.innerHTML = secBrief(report); if (el) el.replaceWith(tmp.firstElementChild); else { const pu = $(".view.home .pulse"), cm = $(".view.home .col-main"); if (pu) pu.insertAdjacentElement("afterend", tmp.firstElementChild); else if (cm) cm.prepend(tmp.firstElementChild); } refreshPulse("levels"); wireStocks(); jumpToBrief(); } } } catch (e) { /* server restarting */ }
  }
  const BRIEF_MOVE = { push_higher: ["Pointing higher", "up"], pullback_then_higher: ["Stretched: a dip first is likelier", "flat"], range_bound: ["Range-bound", "flat"], break_lower: ["At risk of breaking lower", "down"], rebound: ["Set up for a rebound", "up2"] };
  const BRIEF_DRIVER = { momentum: "rising averages and higher highs", overbought: "overbought on the 1-hour chart", resistance_overhead: "resistance right overhead", support_nearby: "support close underneath", trend_intact: "the trend held through the last dip", trend_broken: "the trend broke" };
  const BRIEF_SLOTS = [["morning", "Morning briefing", "07:00"], ["direction", "Intraday direction", "every 15 min"], ["close", "After the close", "16:30"]];
  let direction = null;
  async function pollDirection() {
    if (STATIC_MODE) return;
    try { const res = await api("/api/direction", { cache: "no-store" }); if (!res.ok) return; direction = await res.json();
      if (currentView === "home" && report) { const el = $('[data-brief-slot="direction"]'); if (el) { const tmp = document.createElement("div"); tmp.innerHTML = directionCard(); el.replaceWith(tmp.firstElementChild); wireStocks(); } } } catch (e) { /* server restarting */ }
  }
  const DIR = { higher: ["Higher into the close", "up"], lower: ["Lower into the close", "down"], sideways: ["Sideways into the close", "flat"] };
  const DIR_DRIVER = { trend_and_vwap: "price is on the same side of the day's average price as the 1-hour trend", level_break: "a level just gave way", level_hold: "a level held on the test", exhaustion: "the move is stretched and stalling", sentiment: "the crowd's mood is the deciding factor", no_edge: "nothing clear, so sideways is the honest read" };
  function directionCard() {
    const d = direction; const open = briefOpen === "direction";
    if (!d || d.status !== "ok" || !d.latest) return `<article class="bcard pending" data-brief-slot="direction"><div class="bcard-h"><b>Intraday direction</b><span class="muted">every 15 min</span></div><div class="muted">${d && d.market_state === "open" ? "First read of the session arrives within 15 minutes." : "Runs every 15 minutes while the market is open (09:30 to 16:00 ET): technicals plus the crowd's mood, scored after the close."}</div></article>`;
    const L = d.latest, f = L.facts || {}, sp = f.spy || {}, qq = f.qqq || {}, sm = f.sentiment || {};
    const m = DIR[L.expected] || ["No read", "flat"];
    const facts = f.spy ? `<div class="meta2">SPY ${fnum(sp.last)} · ${sp.above_vwap == null ? "" : sp.above_vwap ? "above" : "below"} the day's average price · ${isNum(sp.range_pos) ? Math.round(sp.range_pos * 100) + "% of the day's range" : ""} · 1-hour RSI ${fnum((sp.hourly || {}).rsi_1h, 0)}</div><div class="meta2">QQQ ${fnum(qq.last)} · ${qq.above_vwap == null ? "" : qq.above_vwap ? "above" : "below"} the day's average price · RSI ${fnum((qq.hourly || {}).rsi_1h, 0)}${isNum(f.breadth_pct_above_20d) ? ` · breadth ${f.breadth_pct_above_20d}% above the 20-day` : ""}</div><div class="meta2">Mood: Reddit on SPY ${esc(sm.reddit_spy || "none")}, on QQQ ${esc(sm.reddit_qqq || "none")}${sm.stocktwits_spy && sm.stocktwits_spy.label ? ` · StockTwits on SPY ${esc(String(sm.stocktwits_spy.label).toLowerCase().replace(/_/g, " "))} (${sm.stocktwits_spy.score_0_100}/100)` : ""} · the President's recent posts ${esc(sm.trump_lean_recent || "none")}</div>` : "";
    const strip = (d.today || []).map((r) => { const k = DIR[r.expected] ? DIR[r.expected][1] : "flat"; const t = new Date(r.ts * 1000).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }); return `<span class="dir-dot ${k} ${r.hit === 1 ? "hit" : r.hit === 0 ? "miss" : ""}" title="${t} ET: ${r.expected || "–"}${r.hit == null ? "" : r.hit ? " · hit" : " · miss"}">${r.expected === "higher" ? "▲" : r.expected === "lower" ? "▼" : "▬"}</span>`; }).join("");
    const st = (d.stats || {}).totals || {};
    const scoredToday = (d.today || []).filter((r) => r.hit != null); const hitsToday = scoredToday.filter((r) => r.hit === 1).length;
    const verdict = d.market_state !== "open" && scoredToday.length ? `<div class="day-verdict"><b>Day verdict</b> ${hitsToday} of ${scoredToday.length} reads right (${Math.round(hitsToday / scoredToday.length * 100)}%). ${hitsToday / scoredToday.length >= 0.6 ? "The desk read the tape well today." : hitsToday / scoredToday.length >= 0.4 ? "A mixed day: the tape flipped on the desk more than once." : "The desk was wrong-footed today; the reads are logged for the model to learn from."}</div>` : "";
    return `<article class="bcard ${open ? "open" : ""}" data-brief-slot="direction">
      <div class="bcard-h"><b>Intraday direction</b><span class="muted">${esc((L.at || "").slice(11, 16))} ET · ${d.market_state === "open" ? (isNum(d.next_in_s) ? `next in ${Math.ceil(d.next_in_s / 60)} min` : "live") : "last read of the session"}</span></div>
      <div class="bc-idx"><span class="pill ${m[1]}">${m[0]}</span> ${convTag(L.confidence)}${user && user.role === "admin" ? ` <a class="lnk small" href="#view=check" data-view-link="check">today's reads →</a>` : ""}${L.source === "rules" ? ` <span class="src-badge" title="The model read service was unavailable, so this read comes from OneView's backup rules (same facts, fixed rules, conviction capped at MED).">backup read</span>` : ""}<div class="meta2">${L.driver ? "Mainly " + (DIR_DRIVER[L.driver] || pretty(L.driver)) + "." : ""}</div></div>
      ${facts}
      <div class="dir-strip">${strip || '<span class="muted">no reads yet today</span>'}</div>
      ${verdict}
      <div class="bc-more"><div class="meta2">Every 15 minutes during the regular session the desk reads SPY and QQQ against the day's average price, the day's range, the 1-hour trend, RSI and levels, plus the crowd's mood, and says which way the market is likelier to go into the close. After the close each read is scored against where SPY actually finished. ${isNum(st.scored) && st.scored ? `Last 30 days: ${st.hits || 0} of ${st.scored} reads right (${Math.round((st.hits || 0) / st.scored * 100)}%).` : "Scores appear after the first close."} Monitoring only, not advice.</div></div>
      <button type="button" class="lnk bc-toggle" data-brief-toggle="direction">${open ? "less" : "more"}</button>
    </article>`;
  }
  let briefOpen = null;
  function jumpToBrief() {                       // email link "#view=home&brief=1": open the morning card and bring it into view
    let want = /brief=1/.test(location.hash); try { if (sessionStorage.getItem("mu-open-brief") === "1") { want = true; } } catch (e) {}
    if (!want) return;
    try { sessionStorage.removeItem("mu-open-brief"); } catch (e) {}
    const el = $(".briefs"); if (!el) return;
    briefOpen = "morning"; const d = el.querySelector('[data-brief-slot="morning"]'); if (d) d.classList.add("open");
    el.scrollIntoView({ block: "start", behavior: "smooth" });
    try { history.replaceState(null, "", "#view=home"); } catch (e) {}
  }
  function briefCard(b, slot, label, at, today) {
    if (!b) return `<article class="bcard pending" data-brief-slot="${slot}"><div class="bcard-h"><b>${label}</b><span class="muted">${at} ET</span></div><div class="muted">${slot === "morning" ? "Arrives at 07:00 every day." : slot === "midday" ? "Arrives at 13:00 on market days." : "Arrives after the close on market days."}</div></article>`;
    const tape = Object.fromEntries((b.tape || []).map((x) => [x.symbol, x]));
    const y = b.yields || {};
    const chip = (l, v) => `<span class="bc-chip"><i>${esc(l)}</i>${v}</span>`;
    const tp = (sym, l) => { const x = tape[sym]; return x && isNum(x.chg_pct) ? chip(l, `<b class="${cls(x.chg_pct)}">${fpct(x.chg_pct, 1)}</b>`) : ""; };
    const ses = b.session || {}; const sidx = Object.fromEntries((ses.indexes || []).map((x) => [x.symbol, x]));
    const chips = slot === "morning"
      ? [tp("ES=F", "S&P fut"), tp("NQ=F", "Nasdaq fut"), tp("CL=F", "Oil"), tp("GC=F", "Gold"), tp("BTC-USD", "BTC"), isNum(y["10y"]) ? chip("10-yr", `<b>${fnum(y["10y"], 2)}%</b>`) : "", isNum(y["5y"]) ? chip("5-yr", `<b>${fnum(y["5y"], 2)}%</b>`) : ""].join("")
      : [["SPY", "S&P 500"], ["QQQ", "Nasdaq 100"], ["IWM", "Small caps"]].map(([k, l]) => sidx[k] && isNum(sidx[k].chg_pct) ? chip(l, `<b class="${cls(sidx[k].chg_pct)}">${fpct(sidx[k].chg_pct, 1)}</b>`) : "").join("") + tp("CL=F", "Oil") + tp("GC=F", "Gold") + tp("BTC-USD", "BTC");
    const idx = ["SPY", "QQQ"].map((sym) => { const x = (b.indexes || {})[sym]; if (!x) return ""; const a = (x.ai || {}).next_move; const mv = a ? BRIEF_MOVE[a.choice] : null; const dr = (x.ai || {}).driver; const pl = x.plan || {};
      const plan = slot === "morning" && (pl.see || []).length ? `<div class="bc-plan"><div><i>What we see:</i> ${esc(pl.see.join("; "))}.</div>${pl.shape ? `<div><i>Next 1 to 4 hours:</i> ${esc(pl.shape)}.</div>` : ""}${(pl.levels || []).length ? `<ul>${pl.levels.slice(0, 4).map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}</div>` : "";
      return `<div class="bc-idx"><b>${sym}</b> ${mv ? `<span class="pill ${mv[1]}">${mv[0]}</span> ${convTag(a.confidence)}` : '<span class="muted">no read</span>'}<div class="meta2">${dr ? "Mainly " + (BRIEF_DRIVER[dr.choice] || pretty(dr.choice)) + " · " : ""}RSI ${fnum(x.rsi_1h, 0)} · support ${fnum(x.nearest_support)} · resistance ${fnum(x.nearest_resistance)}</div>${plan}</div>`; }).join("");
    const mega = (b.mega || []).slice(0, 8).map((m) => `<span class="bf-mega" data-ticker-page="${esc(m.ticker)}"><b>${esc(m.ticker)}</b><span class="delta ${cls(m.chg_pct)}">${fpct(m.chg_pct, 1)}</span></span>`).join("");
    const movers = (ses.movers || []).slice(0, 5).map((m) => `<span class="bf-mega" data-ticker-page="${esc(m.ticker)}"><b>${esc(m.ticker)}</b><span class="delta ${cls(m.chg_pct)}">${fpct(m.chg_pct, 1)}</span>${m.read ? `<i>${esc(m.read.toLowerCase())}</i>` : ""}</span>`).join("");
    const sectors = (ses.leaders || []).length ? `<div class="meta2">Leading: ${ses.leaders.map((x) => `${esc(x.label)} ${fpct(x.chg_pct, 1)}`).join(", ")} · Lagging: ${(ses.laggards || []).map((x) => `${esc(x.label)} ${fpct(x.chg_pct, 1)}`).join(", ")}</div>` : "";
    const trump = (b.trump || []).map((p) => { const a = p.ai || {}; const d = a.direction ? TP.dir[a.direction.choice] : null; return `<li><span class="pill ${d ? d[1] : "flat"}">${d ? d[0] : "read"}</span> ${esc(p.text.slice(0, 140))}${p.text.length > 140 ? "…" : ""} ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">open</a>` : ""}</li>`; }).join("");
    const ev = (b.events || []).slice(0, 4).map((c) => `<li><samp>${esc(c.time_et)}</samp> ${esc(c.title)}</li>`).join("");
    const open = briefOpen === slot;
    let share = "";
    if (slot === "morning") {                          // FIX 4: plain-text summary for WhatsApp, morning briefing only
      const lv = ["SPY", "QQQ"].map((sym) => { const x = (b.indexes || {})[sym]; if (!x) return null; const a = (x.ai || {}).next_move; return `${sym} ${fnum(x.last)} · support ${fnum(x.nearest_support)} · resistance ${fnum(x.nearest_resistance)}${a && BRIEF_MOVE[a.choice] ? " · " + BRIEF_MOVE[a.choice][0].toLowerCase() : ""}`; }).filter(Boolean);
      const mv = (b.mega || []).filter((m) => isNum(m.chg_pct)).sort((a, c) => Math.abs(c.chg_pct) - Math.abs(a.chg_pct)).slice(0, 4).map((m) => `${m.ticker} ${fpct(m.chg_pct, 1)}`);
      const text = [`OneView morning briefing · ${b.date || ""}`, "", b.summary || "", "", "Key levels:", ...lv, mv.length ? "" : null, mv.length ? "Notable movers: " + mv.join(", ") : null, "", "Full briefing: " + (APP_URL || location.origin + location.pathname) + "#view=home&brief=1", "", "Information only, not financial advice."].filter((x) => x !== null).join("\n");
      share = `<a class="lnk bc-share" href="https://wa.me/?text=${encodeURIComponent(text)}" target="_blank" rel="noopener" title="Share this briefing on WhatsApp">Share on WhatsApp</a>`;
    }
    return `<article class="bcard ${open ? "open" : ""}" data-brief-slot="${slot}">
      <div class="bcard-h"><b>${label}</b><span class="muted">${esc((b.generated_at || "").slice(11, 16))} ET${today ? "" : " · " + esc(b.date || "")}</span></div>
      <p class="bc-summary">${esc(b.summary || "")}</p>
      <div class="bc-chips">${chips}</div>
      <div class="bc-idx-row">${idx}</div>
      ${slot === "close" && b.scorecard ? (() => { const sc = b.scorecard; const mm = sc.morning_call ? (BRIEF_MOVE[sc.morning_call] || [pretty(sc.morning_call), "flat"])[0] : null; return `<div class="scorecard"><div class="sc-h">Scorecard <span class="muted">expectation vs what the market did</span></div>
        <div class="scr-row"><span>Intraday reads</span><b>${sc.scored ? `${sc.hits} of ${sc.scored} right · ${sc.hit_rate}%` : (sc.reads ? "not scored" : "none today")}</b></div>
        <div class="scr-row"><span>Morning call on SPY</span><b>${mm ? `${mm} → SPY ${fpct(sc.spy_day_pct, 2)} · ${sc.morning_hit === 1 ? '<i class="up">hit</i>' : sc.morning_hit === 0 ? '<i class="down">miss</i>' : "no direction"}` : "no call"}</b></div>
        <div class="dir-strip">${(sc.timeline || []).map((r) => `<span class="dir-dot ${DIR[r.expected] ? DIR[r.expected][1] : "flat"} ${r.hit === 1 ? "hit" : r.hit === 0 ? "miss" : ""}" title="${new Date(r.at * 1000).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false })} ET: ${r.expected}, SPY then ${fpct(r.move_spy_pct, 2)} to the close">${r.expected === "higher" ? "▲" : r.expected === "lower" ? "▼" : "▬"}</span>`).join("")}</div>
        <div class="meta2">${esc(sc.how || "")}</div></div>`; })() : ""}
      <div class="bc-more">
        ${slot === "morning" ? `<h5>Mega caps overnight</h5><div class="bf-megas">${mega || '<span class="muted">no quotes</span>'}</div>` : `<h5>Biggest moves</h5><div class="bf-megas">${movers || '<span class="muted">none</span>'}</div>${sectors}`}
        ${trump ? `<h5>The President, market-relevant</h5><ul class="bf-list">${trump}</ul>` : ""}
        ${ev ? `<h5>${slot === "close" ? "Tomorrow" : "Today"}</h5><ul class="bf-list">${ev}</ul>` : ""}
        <div class="meta2">${esc(b.note || "")}</div>
      </div>
      <div class="bc-actions"><button type="button" class="lnk bc-toggle" data-brief-toggle="${slot}">${open ? "less" : "more"}</button>${share}</div>
    </article>`;
  }
  function secBrief(r) {
    const j = brief; if (!j) return "";
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    const isToday = j.date === today;
    const cards = BRIEF_SLOTS.map(([slot, label, at]) => slot === "direction" ? directionCard() : briefCard((j.briefs || {})[slot], slot, label, at, isToday)).join("");
    return `<section class="briefs"><div class="briefs-h"><h3>Briefings <span class="muted">${isToday ? "today" : esc(j.date || "")} · morning at 07:00, a direction read every 15 minutes of the session, after the close at 16:30 ET · monitoring only, not advice</span></h3></div><div class="briefs-row">${cards}</div></section>`;
  }
  let crowd = null;
  async function pollCrowd() {
    if (STATIC_MODE) return;
    try { const res = await api("/api/stocktwits", { cache: "no-store" }); if (!res.ok) return; const j = await res.json(); crowd = j;
      if (currentView === "home" && report) { refreshPulse("gauge"); refreshPulse("crowd"); const el = $(".crowd"); const tmp = document.createElement("div"); tmp.innerHTML = secCrowd(report); if (el) { if (tmp.firstElementChild) el.replaceWith(tmp.firstElementChild); else el.remove(); } else if (tmp.firstElementChild) { const hero = $(".home-hero"); if (hero) hero.insertAdjacentElement("afterend", tmp.firstElementChild); } wireStocks(); } } catch (e) { /* server restarting */ }
  }
  const ST_LABEL = { BULLISH: ["Bullish", "up"], EXTREMELY_BULLISH: ["Extremely bullish", "up"], BEARISH: ["Bearish", "down"], EXTREMELY_BEARISH: ["Extremely bearish", "down"], NEUTRAL: ["Neutral", "flat"] };
  // ======================= THE CROWD (StockTwits): mood versus normal, and what people are saying =======================
  // StockTwits' score (0-100) compares the crowd with that stock's own normal: 50 is a normal day. The raw share of
  // bullish-tagged posts always runs high (the crowd leans long), so it is shown only as a footnote.
  const CROWD_WORD = (sc) => (!isNum(sc) ? ["no read", "flat"] : sc < 20 ? ["Extremely bearish", "down"] : sc < 40 ? ["Bearish", "down"] : sc < 46 ? ["Slightly bearish", "down"] : sc <= 54 ? ["Normal", "flat"] : sc <= 60 ? ["Slightly bullish", "up"] : sc <= 80 ? ["Bullish", "up"] : ["Extremely bullish", "up"]);
  const CROWD_LBL = { EXTREMELY_BULLISH: ["Extremely bullish", "up"], BULLISH: ["Bullish", "up"], SLIGHTLY_BULLISH: ["Slightly bullish", "up"], NEUTRAL: ["Normal", "flat"], SLIGHTLY_BEARISH: ["Slightly bearish", "down"], BEARISH: ["Bearish", "down"], EXTREMELY_BEARISH: ["Extremely bearish", "down"] };
  const crowdWordFor = (x) => CROWD_LBL[String((x && x.label) || "").toUpperCase().replace(/\s+/g, "_")] || CROWD_WORD(x && x.score);   // StockTwits' own label wins
  let crowdSym = null;
  const agoShort = (iso) => { if (!iso) return ""; const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 90 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
  function crowdMeter(sc, w) {
    w = w || CROWD_WORD(sc);
    return `<div class="cr-meter" title="50 is this stock's normal mood. Higher is more bullish than usual, lower is more bearish than usual."><span class="cr-mid"></span>${isNum(sc) ? `<i class="${w[1]}" style="left:${Math.max(0, Math.min(100, sc))}%"></i>` : ""}</div>`;
  }
  function crowdLine(series) {
    const v = (series || []).map((x) => x.v).filter(isNum); if (v.length < 2) return "";
    const W = 260, H = 54, y = (x) => H - 3 - (x / 100) * (H - 6);
    const pts = v.map((x, i) => `${((i / (v.length - 1)) * W).toFixed(1)},${y(x).toFixed(1)}`).join(" ");
    const last = v[v.length - 1], first = v[0];
    return `<svg class="cr-line ${last >= 50 ? "up" : "down"}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Crowd mood over the last week, from ${first} to ${last}"><line x1="0" x2="${W}" y1="${y(50).toFixed(1)}" y2="${y(50).toFixed(1)}" class="cr-50"/><polyline points="${pts}"/></svg>`;
  }
  function crowdMood(c, sym, name) {
    const x = (c.moods || {})[sym]; if (!x) return "";
    const wk = crowdWordFor(x); const tk = (c.talk || {})[sym];
    const last = tk && tk.last50 && isNum(tk.last50.share) ? tk.last50 : null;
    const w = last ? leanWord(last.share) : wk;
    const clash = last && wk && ((wk[1] === "up" && w[1] === "down") || (wk[1] === "down" && w[1] === "up"));
    return `<div class="cr-card" data-ticker-page="${esc(sym)}" role="button" tabindex="0">
      <div class="cr-card-h"><span><b>${esc(sym)}</b><i>${esc(name)}</i></span>${x.volume_label ? `<span class="cr-chat" title="How much people are posting versus normal">chatter ${esc(String(x.volume_label).toLowerCase().replace(/_/g, " "))}</span>` : ""}</div>
      <div class="cr-word ${w[1]}">${w[0]}<small>${last ? "right now" : "this week"}</small></div>
      ${last ? `<div class="cr-now2">Latest ${last.bull + last.bear} tagged posts: <b class="up">${last.bull} bullish</b> · <b class="down">${last.bear} bearish</b> · of ${tk.posts} read over ${esc(spanWords(tk))}</div>` : ""}
      ${tk ? timelineBars(tk.timeline) : ""}
      <div class="cr-weekrow"><span>Week mood vs normal</span>${crowdMeter(x.score, wk)}<b class="${wk[1]}">${wk[0]} · ${isNum(x.score) ? x.score : "–"}/100</b></div>
      ${clash ? `<div class="cr-now clash">The latest chatter is going against the week's mood.</div>` : ""}
    </div>`;
  }

  // the crowd on names outside the snapshot (the user's watchlist), fetched on demand and kept for 15 minutes
  const crowdExtra = {}; const crowdBusy = new Set();
  async function loadCrowdSym(sym) {
    if (STATIC_MODE || crowdBusy.has(sym)) return;
    const have = crowdExtra[sym]; if (have && Date.now() - have.at < 900000) return;
    crowdBusy.add(sym);
    try { const res = await api(`/api/crowd/${encodeURIComponent(sym)}`, { cache: "no-store" }); const j = res.ok ? await res.json() : { status: "error" };
      crowdExtra[sym] = { at: Date.now(), ok: j.status === "ok" && !!j.talk, talk: j.talk, mood: j.mood };
    } catch (e) { crowdExtra[sym] = { at: Date.now(), ok: false }; }
    crowdBusy.delete(sym);
    const el = $("[data-crowd-talk]"); if (el && crowd && crowdSym === sym) { const tmp = document.createElement("div"); tmp.innerHTML = crowdTalk(crowd); el.replaceWith(tmp.firstElementChild); }
    if (currentView === "watch" && wlSel === sym) rerenderWatch();
  }
  const talkFor = (sym) => (crowd && crowd.talk && crowd.talk[sym]) || (crowdExtra[sym] && crowdExtra[sym].talk) || null;
  const spanWords = (t) => { if (!t.oldest || !t.newest) return ""; const h = (Date.parse(t.newest) - Date.parse(t.oldest)) / 3600000; return h < 1 ? `${Math.max(1, Math.round(h * 60))} minutes` : h < 48 ? `${Math.round(h)} hours` : `${Math.round(h / 24)} days`; };
  function talkBody(t, sym) {
    const tagged = t.bull + t.bear, bs = tagged ? Math.round((t.bull / tagged) * 100) : 0;
    const lean = !tagged ? "Nobody tagged a side" : bs >= 65 ? "Mostly bullish talk" : bs >= 55 ? "Leaning bullish" : bs <= 35 ? "Mostly bearish talk" : bs <= 45 ? "Leaning bearish" : "An even fight";
    const topics = (t.topics || []).map((x) => `<span class="cr-topic">${esc(x.label)}<i>${x.n}</i></span>`).join("");
    const also = (t.also || []).map((x) => `<span class="cr-also" data-ticker-page="${esc(String(x.symbol).replace(/\.X$/, "-USD"))}">$${esc(x.symbol)}</span>`).join("");
    const o = t.older || {}, n = t.newer || {};
    const d = isNum(o.bull_share) && isNum(n.bull_share) ? n.bull_share - o.bull_share : null;
    const shift = d == null ? "" : `<div class="cr-shift"><span class="cr-lbl">Shift</span><div class="cr-shift-bars">
        <div><i>older ${Math.floor(t.posts / 2)} posts</i><span class="cr-mini"><b style="width:${o.bull_share}%"></b></span><em>${o.bull_share}% bullish</em></div>
        <div><i>newer ${Math.ceil(t.posts / 2)} posts</i><span class="cr-mini"><b style="width:${n.bull_share}%"></b></span><em>${n.bull_share}% bullish</em></div></div>
        <span class="cr-shift-w ${d >= 8 ? "up" : d <= -8 ? "down" : "flat"}">${d >= 8 ? "turning more bullish" : d <= -8 ? "turning more bearish" : "steady"}</span></div>`;
    const q = (side) => (t.quotes[side] || []).map((m) => `<blockquote class="cr-q ${side === "bull" ? "up" : "down"}"><p>${esc(m.text)}</p><footer>${agoShort(m.at)}${m.id ? ` · <a href="https://stocktwits.com/message/${encodeURIComponent(m.id)}" target="_blank" rel="noopener">open</a>` : ""}</footer></blockquote>`).join("") || `<div class="cr-none">No clean ${side === "bull" ? "bullish" : "bearish"} post in this sample.</div>`;
    return `<div class="cr-sum"><b>${lean}</b> on ${esc(sym)}: <span class="up">${t.bull} bullish</span> vs <span class="down">${t.bear} bearish</span> in the last <b>${t.posts} posts</b>${t.untagged ? ` (${t.untagged} took no side)` : ""}, covering the last ${spanWords(t) || "stretch"}.</div>
      <div class="cr-split" aria-hidden="true"><i class="up" style="width:${tagged ? bs : 50}%"></i><i class="down" style="width:${tagged ? 100 - bs : 50}%"></i></div>
      ${shift}
      ${topics ? `<div class="cr-row"><span class="cr-lbl">Hot topics</span><div class="cr-topics">${topics}</div></div>` : ""}
      ${also ? `<div class="cr-row"><span class="cr-lbl">Also mentioned</span><div class="cr-topics">${also}</div></div>` : ""}
      <div class="cr-quotes"><div><h5 class="up">The bull side</h5>${q("bull")}</div><div><h5 class="down">The bear side</h5>${q("bear")}</div></div>`;
  }
  function crowdTalk(c) {
    const order = c.talk_order || Object.keys(c.talk || {}); if (!order.length) return "";
    const mine = activeList().filter((s) => !order.includes(s) && !/[-=^]/.test(s));
    if (!crowdSym || (!order.includes(crowdSym) && !mine.includes(crowdSym))) crowdSym = order[0];
    const tabs = order.map((s) => `<button type="button" class="${s === crowdSym ? "on" : ""}" data-crowd-sym="${esc(s)}">${esc(s)}</button>`).join("");
    const pick = mine.length && !STATIC_MODE ? `<label class="cr-pick"><span>Your watchlist</span><select data-crowd-pick aria-label="See the crowd on one of your names"><option value="">pick a name</option>${mine.map((s) => `<option value="${esc(s)}" ${s === crowdSym ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></label>` : "";
    const t = talkFor(crowdSym); const ex = crowdExtra[crowdSym];
    const body = t ? talkBody(t, crowdSym) : crowdBusy.has(crowdSym) || !ex ? `<div class="cr-loading">Reading the last 200 posts on ${esc(crowdSym)}. The first look at a name takes about half a minute.</div>` : `<div class="cr-none">No StockTwits posts to read on ${esc(crowdSym)} right now.</div>`;
    if (!t && !ex && !crowdBusy.has(crowdSym)) setTimeout(() => loadCrowdSym(crowdSym), 0);
    return `<div class="cr-talk" data-crowd-talk>
      <div class="cr-talk-h"><h4>What people are saying</h4><div class="cr-talk-ctl"><div class="pz-seg">${tabs}</div>${pick}</div></div>
      ${body}
      <div class="pz-foot">Real posts from StockTwits, newest first, about 200 per name. Usernames are hidden and posts with insults or slurs are left out. Opinions, not advice.</div>
    </div>`;
  }
  function secCrowd(r) {
    const c = crowd; if (!c || c.status !== "ok") return "";
    const m = c.moods || {};
    const bigs = ["NVDA", "AAPL", "MSFT", "AMZN", "META", "TSLA", "GOOGL", "AVGO"].filter((s) => m[s]).map((s) => { const x = m[s]; const w = crowdWordFor(x); const q = qp(s, (r.stocks || []).find((z) => z.ticker === s));
      return `<li data-ticker-page="${esc(s)}"><b>${esc(s)}</b>${crowdMeter(x.score, w)}<span class="cr-bw ${w[1]}">${w[0]}</span><span class="cr-bs">${isNum(x.score) ? x.score : "–"}</span>${(() => { const ch = isNum(q.chg) && Math.abs(q.chg) < 0.05 ? 0 : q.chg; return `<span class="delta ${cls(ch)}">${ch === 0 ? "0.0%" : fpct(ch, 1)}</span>`; })()}</li>`; }).join("");
    const trend = (c.trending || []).slice(0, 8).map((t) => `<div class="cr-tr" data-ticker-page="${esc(t.symbol)}" role="button" tabindex="0"><div class="cr-tr-h"><b>${esc(t.symbol)}</b><span class="delta ${cls(t.change_pct)}">${fpct(t.change_pct, 1)}</span></div><i class="cr-tr-n">${esc(t.title || "")}</i>${spark(t.spark, (t.spark || []).length > 1 ? cls(t.spark[t.spark.length - 1] - t.spark[0]) : "flat")}<span class="cr-tr-w" title="The line is the latest session${t.session && /POST|OVERNIGHT|PRE/.test(t.session) ? " (extended hours)" : ""}">${isNum(t.watchers) ? fvol(t.watchers) + " watching" : ""}</span></div>`).join("");
    return `<section class="crowd crowd2">
      <div class="cr-head"><h3>The crowd <span class="muted">StockTwits · updated ${esc(etTime(c.as_of))} ET · every 10 minutes in market hours</span></h3></div>
      <p class="cr-how">Each score compares today's mood with that stock's normal. <b>50 is a normal day</b>, higher is more bullish than usual, lower is more bearish than usual. A crowd at an extreme is a warning that a trade is crowded, not a signal to follow it.</p>
      <div class="cr-top">${crowdMood(c, "SPY", "S&P 500")}${crowdMood(c, "QQQ", "Nasdaq 100")}</div>
      ${crowdTalk(c)}
      <div class="cr-bottom">
        ${bigs ? `<div class="cr-bigs"><h4>Big caps vs their normal mood</h4><ul>${bigs}</ul></div>` : ""}
        ${trend ? `<div class="cr-trend"><h4>Trending on StockTwits right now</h4><div class="cr-tr-grid">${trend}</div></div>` : ""}
      </div>
    </section>`;
  }
  document.addEventListener("change", (e) => {
    const p = e.target.closest && e.target.closest("[data-crowd-pick]"); if (!p || !p.value || !crowd) return;
    crowdSym = p.value; const el = $("[data-crowd-talk]"); if (!el) return;
    const tmp = document.createElement("div"); tmp.innerHTML = crowdTalk(crowd); el.replaceWith(tmp.firstElementChild);
  });
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-crowd-sym]"); if (!b || !crowd) return;
    crowdSym = b.getAttribute("data-crowd-sym"); const el = $("[data-crowd-talk]"); if (!el) return;
    const tmp = document.createElement("div"); tmp.innerHTML = crowdTalk(crowd); el.replaceWith(tmp.firstElementChild); wireStocks();
  });
  let social = null, socialAll = false;
  const TP = {
    theme: { tariffs_trade: "Tariffs & trade", fed_rates: "Fed & rates", taxes_spending: "Taxes & spending", geopolitics: "Geopolitics", energy_oil: "Energy & oil", specific_company_or_sector: "A company or industry", crypto: "Crypto", immigration_labor: "Immigration & labor", not_market: "Not about markets" },
    dir: { bullish_for_stocks: ["Leans bullish", "up"], bearish_for_stocks: ["Leans bearish", "down"], mixed_or_unclear: ["Unclear", "flat"] },
    who: { broad_market: "the whole market", large_cap_tech: "big tech", chips_semis: "chip makers", industrials_manufacturing: "manufacturers", autos: "car makers", energy: "energy", banks_financials: "banks", defense: "defense", healthcare_pharma: "healthcare", crypto_linked: "crypto names", retail_consumer: "retailers", no_clear_group: "" },
  };
  const agoIso = (iso) => { if (!iso) return ""; const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
  function secVoices(r) {
    const S = social || r.social; if (!S) return "";
    const T = S.trump || {}, C = S.crowd || {};
    const posts = (T.posts || []);
    const relevant = posts.filter((p) => p.ai && p.ai.market_relevance && p.ai.market_relevance.p >= 0.5);
    const shown = socialAll ? posts : relevant.length ? relevant.slice(0, 4) : posts.slice(0, 2);
    const post = (p) => { const a = p.ai || {}; const d = a.direction ? TP.dir[a.direction.choice] : null; const rel = a.market_relevance ? a.market_relevance.p >= 0.5 : null;
      return `<li class="tp-post ${rel === false ? "dim" : ""}"><div class="tp-meta"><samp>${agoIso(p.posted)}</samp>${a.theme && a.theme.choice !== "not_market" ? `<span class="tag acc">${TP.theme[a.theme.choice] || pretty(a.theme.choice)}</span>` : ""}${d && rel ? `<span class="pill ${d[1]}">${d[0]}</span>` : ""}${a.who_benefits && TP.who[a.who_benefits.choice] && rel ? `<span class="muted">hits ${TP.who[a.who_benefits.choice]}</span>` : ""}${rel === false ? '<span class="muted">not market-moving</span>' : !a.market_relevance ? '<span class="muted">not read yet</span>' : ""}</div>
        <div class="tp-text">${esc(p.text.length > 260 ? p.text.slice(0, 257) + "…" : p.text)}</div>
        <div class="meta2">${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">open the post</a>` : ""}${isNum(p.reposts) ? ` · ${fvol(p.reposts)} reposts` : ""}</div></li>`; };
    const rows = (C.rows || []).slice(0, 8).map((x) => { const st = stockFor(x.ticker); const v = verdictFor(st); const q = qp(x.ticker, (r.lite || {})[x.ticker]); const d = isNum(x.mentions) && isNum(x.mentions_24h_ago) && x.mentions_24h_ago ? (x.mentions / x.mentions_24h_ago - 1) * 100 : null;
      const mood = x.wsb_sentiment ? `<span class="${x.wsb_sentiment === "Bullish" ? "up" : "down"}">${x.wsb_sentiment.toLowerCase()}</span>` : '<span class="muted">–</span>';
      return `<tr class="clickable" data-ticker-page="${esc(x.ticker)}"><td class="sym"><b>${esc(x.ticker)}</b><div class="meta2">${esc((x.name || "").slice(0, 26))}</div></td><td class="num"><b>${isNum(x.mentions) ? x.mentions : "–"}</b>${isNum(d) ? `<div class="delta ${cls(d)}">${fpct(d, 0)} 24h</div>` : ""}</td><td>${mood}${isNum(x.wsb_comments) ? `<div class="meta2">${x.wsb_comments} comments</div>` : ""}</td><td class="num">${isNum(q.last) ? priceHtml(x.ticker, null) : '<span class="muted">–</span>'}</td><td>${v ? `<span class="pill ${v.cls}">${v.word}</span>` : '<span class="muted">not analysed</span>'}</td></tr>`; }).join("");
    const clash = (C.rows || []).slice(0, 10).filter((x) => { const v = verdictFor(stockFor(x.ticker)); return v && x.wsb_sentiment === "Bullish" && v.cls === "down"; }).map((x) => x.ticker);
    const srcLine = `${T.source ? esc(T.source) : "Trump feed unavailable"} · ${(C.sources || []).length ? "Reddit via " + esc((C.sources || []).map((x) => x.split(" (")[0]).join(" + ")) : "Reddit feed unavailable"}`;
    return `<section class="voices"><h3>Voices moving the tape <span class="muted" data-qstamp-src>free public feeds</span></h3>
      ${explain(`The President's posts and a sudden Reddit crowd have both moved prices without warning. The model reads each post once: does it matter, which way, and for whom. Reddit numbers are mention counts, not a forecast; a spike means a crowded name, and crowded names reverse hard. <span class="muted">Sources: ${srcLine}.</span>`)}
      <div class="voices-grid">
        <div class="tp-col"><h4>Trump on the tape ${T.status === "unavailable" ? '<span class="tag warn">feed unavailable</span>' : `<span class="muted">${relevant.length} of ${posts.length} recent posts read as market-moving</span>`}</h4>
          <ul class="tp-list">${shown.map(post).join("") || '<li class="muted">No posts in the feed right now.</li>'}</ul>
          ${posts.length > shown.length || socialAll ? `<button class="lnk" data-social-all>${socialAll ? "show only market-moving posts" : `show all ${posts.length} recent posts`}</button>` : ""}</div>
        <div class="cr-col"><h4>Where the crowd is going ${C.status === "unavailable" ? '<span class="tag warn">feed unavailable</span>' : '<span class="muted">Reddit mentions, last 24 hours</span>'}</h4>
          ${rows ? `<table class="tbl cr-tbl"><thead><tr><th>Name</th><th>Mentions</th><th>Crowd mood</th><th>Price</th><th>Desk read</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No crowd data right now.</div>'}
          ${clash.length ? `<div class="meta2 warn" style="margin-top:6px">Crowd bullish, desk bearish: ${clash.join(", ")}. That gap is where crowded trades usually end.</div>` : ""}</div>
      </div></section>`;
  }
  async function pollSocial() {
    if (STATIC_MODE || !report) return;
    try { const res = await api("/api/social", { cache: "no-store" }); if (!res.ok) return; social = await res.json();
      if (currentView === "home") { const el = $(".voices"); if (el) { const tmp = document.createElement("div"); tmp.innerHTML = secVoices(report); el.replaceWith(tmp.firstElementChild); wireStocks(); } } } catch (e) { /* server restarting */ }
  }
  function secRunners(r) {
    const rows = [];
    const S = (!STATIC_MODE && liveScan && liveScan.rows) ? liveScan : r.scan;
    ((S && S.rows) || []).filter((x) => x.qualifies !== false && !bigCap(x.ticker, r) && !(x.ticker in INDEX_ETFS)).slice(0, 14).forEach((x) => { const a = x.ai || {}; const rd = a.read ? a.read.choice : null; const q = qp(x.ticker, x);
      rows.push({ t: x.ticker, name: x.name, chg: q.chg, vol: isNum(x.rvol_tod) ? x.rvol_tod : ((x.session || {}).rvol_time_of_day), why: rd ? SC.read[rd][0] : `volume building, strongest on the ${x.lead || x.lead_timeframe} chart`, cls: rd ? SC.read[rd][1] : (x.direction === "up" ? "up" : x.direction === "down" ? "down" : "flat"), play: a.play ? SC.play[a.play.choice] || pretty(a.play.choice) : "", src: "scanner" }); });
    ((r.low_float || {}).rows || []).filter((x) => isNum(x.float_turnover) && x.float_turnover >= 0.5).slice(0, 6).forEach((x) => { const a = x.ai || {}; const q = qp(x.ticker, x); rows.push({ t: x.ticker, name: x.name, chg: q.chg, vol: x.rel_volume, why: `changed hands ${x.float_turnover.toFixed(1)}× over today · only ${(x.float / 1e6).toFixed(1)}M shares available${a.state ? " · " + LF.state[a.state.choice][0] : ""}`, cls: a.state ? LF.state[a.state.choice][1] : "flat", play: a.play ? LF.play[a.play.choice] || pretty(a.play.choice) : "", src: "thin stock" }); });
    const seen = new Set(); const uniq = rows.filter((x) => { if (seen.has(x.t)) return false; seen.add(x.t); return true; }).sort((a, b) => Math.abs(b.chg || 0) - Math.abs(a.chg || 0)).slice(0, 12);
    if (!uniq.length) return `<section class="action"><h3>Small-cap runners</h3><div class="empty">Nothing small is running right now. Quiet tape.</div></section>`;
    return `<section class="action"><h3>Small-cap runners <span class="muted">smaller names trading far above normal or changing hands fast · click to open</span></h3>
      <table class="tbl act-tbl"><thead><tr><th>Name</th><th>Price</th><th>Activity</th><th>What is happening</th><th>Sensible play</th><th></th></tr></thead><tbody>${uniq.map((x) => `<tr class="clickable" data-ticker-page="${esc(x.t)}"><td class="sym"><b>${esc(x.t)}</b><div class="meta2">${esc(x.name || "")} · ${x.src}</div></td><td class="num">${priceHtml(x.t, null)}</td><td class="num"><b class="${isNum(x.vol) && x.vol >= 2 ? "up" : ""}">${isNum(x.vol) ? x.vol.toFixed(1) + "×" : "–"}</b><div class="meta2">vs normal</div></td><td><span class="pill ${x.cls}">${esc(x.why)}</span></td><td class="meta2">${esc(x.play)}</td><td>${isWatched(x.t) ? '<span class="muted">on list</span>' : `<button class="btn sm ghost" data-add-ticker="${esc(x.t)}" data-stop>+ Watch</button>`}</td></tr>`).join("")}</tbody></table></section>`;
  }
  function secThemes(r) {
    const sec = ((r.flows || {}).sectors || []).filter((x) => isNum(x.chg_1d)).slice().sort((a, b) => b.chg_1d - a.chg_1d);
    const T_ = r.theme || {}; const groups = (T_.groups || []).filter((g) => isNum(g.avg_ret_1m)).slice().sort((a, b) => b.avg_ret_1m - a.avg_ret_1m);
    if (!sec.length && !groups.length) return "";
    const mx = Math.max(0.1, ...sec.map((x) => Math.abs(x.chg_1d)));
    const bar = (x) => `<div class="tb"><span class="tb-l">${esc(x.label)}</span><span class="tb-bar"><i class="${cls(x.chg_1d)}" style="width:${(Math.abs(x.chg_1d) / mx * 100).toFixed(0)}%"></i></span><span class="mono ${cls(x.chg_1d)}">${fpct(x.chg_1d, 1)}</span><span class="mono muted">${fpct(x.chg_5d, 1)} 5d</span></div>`;
    const lead = sec[0], lag = sec[sec.length - 1];
    const line = lead && lag && Math.abs(lead.chg_1d) >= 0.15 ? `${esc(lead.label)} leads (${fpct(lead.chg_1d, 1)}), ${esc(lag.label)} lags (${fpct(lag.chg_1d, 1)}).` : "no group stands out yet";
    const tg = groups.slice(0, 4).map((g) => `<div class="tg"><b>${TH.group[g.group] || pretty(g.group)}</b><span class="mono ${cls(g.avg_ret_1m)}">${fpct(g.avg_ret_1m, 1)} 1m</span><span class="muted">${Math.round((g.share_in_uptrend || 0) * 100)}% in uptrend</span></div>`).join("");
    const stage = T_.ai && T_.ai.stage ? `<span class="pill ${{ early: "up", building: "up2", crowded: "flat", broken: "down" }[T_.ai.stage.choice] || "flat"}">${pretty(T_.ai.stage.choice)}</span>` : "";
    return `<section class="themes"><h3>What is moving <span class="muted">${line}</span></h3>
      <div class="themes-grid"><div class="tb-list">${sec.map(bar).join("")}</div>
      <div class="tg-list"><div class="tg-h">${esc(T_.name || "Theme")} ${stage}<span class="muted">${T_.ai && T_.ai.next_group ? "next leg: " + (TH.group[T_.ai.next_group.choice] || pretty(T_.ai.next_group.choice)) : ""}</span></div>${tg}</div></div></section>`;
  }
  function secAction(r) {
    const rows = [];
    const S = (!STATIC_MODE && liveScan && liveScan.rows) ? liveScan : r.scan;
    ((S && S.rows) || []).filter((x) => x.qualifies !== false).slice(0, 12).forEach((x) => { const a = x.ai || {}; const rd = a.read ? a.read.choice : null; if (rd && !["breakout_with_volume", "selling_with_volume", "building_toward_breakout", "climax_or_exhaustion"].includes(rd)) return;
      rows.push({ t: x.ticker, name: x.name, px: x.price, chg: x.chg_pct, vol: isNum(x.rvol_tod) ? x.rvol_tod : ((x.session || {}).rvol_time_of_day), why: rd ? SC.read[rd][0] : `volume build ${(x.score || 0).toFixed(0)}/100 on ${x.lead || x.lead_timeframe}`, cls: rd ? SC.read[rd][1] : (x.direction === "up" ? "up" : x.direction === "down" ? "down" : "flat"), play: a.play ? pretty(a.play.choice) : "", src: "scanner" }); });
    ((r.low_float || {}).rows || []).filter((x) => isNum(x.float_turnover) && x.float_turnover >= 1).slice(0, 4).forEach((x) => { const a = x.ai || {}; rows.push({ t: x.ticker, name: x.name, px: x.price, chg: x.chg_pct, vol: x.rel_volume, why: `float traded ${x.float_turnover.toFixed(1)}× · ${(x.float / 1e6).toFixed(1)}M float${a.state ? " · " + LF.state[a.state.choice][0] : ""}`, cls: a.state ? LF.state[a.state.choice][1] : "flat", play: a.play ? pretty(a.play.choice) : "", src: "low float" }); });
    (r.stocks || []).filter((x) => isNum(x.chg_pct) && Math.abs(x.chg_pct) >= 3 && x.ai && x.ai.stance).slice(0, 6).forEach((x) => { const st = x.ai.stance.choice; rows.push({ t: x.ticker, name: x.name, px: x.last_price, chg: x.chg_pct, vol: x.rel_volume, why: `${x.ai.setup ? pretty(x.ai.setup.choice) : "big move"} · ${x.ai.catalyst ? pretty(x.ai.catalyst.choice) : ""}`, cls: ST.cls[st], play: ST.stance[st][0], src: "mover" }); });
    const seen = new Set(); const uniq = rows.filter((x) => { if (seen.has(x.t)) return false; seen.add(x.t); return true; }).sort((a, b) => Math.abs(b.chg || 0) - Math.abs(a.chg || 0)).slice(0, 12);
    if (!uniq.length) return `<section class="action"><h3>Where the action is</h3><div class="empty">Nothing is qualifying right now. Quiet tape.</div></section>`;
    return `<section class="action"><h3>Where the action is <span class="muted">names with a real signal now: volume breaks, float rotations, big moves with a verdict · click to open</span></h3>
      <table class="tbl act-tbl"><thead><tr><th>Name</th><th>Move</th><th>Volume</th><th>Signal</th><th>Play</th><th></th></tr></thead><tbody>${uniq.map((x) => `<tr class="clickable" data-ticker-page="${esc(x.t)}"><td class="sym"><b>${esc(x.t)}</b><div class="meta2">${esc(x.name || "")} · ${x.src}</div></td><td class="num">${fnum(x.px)}<div class="delta ${cls(x.chg)}">${arrow(x.chg)} ${fpct(x.chg)}</div></td><td class="num"><b class="${isNum(x.vol) && x.vol >= 2 ? "up" : ""}">${isNum(x.vol) ? x.vol.toFixed(1) + "×" : "–"}</b></td><td><span class="pill ${x.cls}">${esc(x.why)}</span></td><td>${esc(x.play)}</td><td>${isWatched(x.t) ? '<span class="muted">on list</span>' : `<button class="btn sm ghost" data-add-ticker="${esc(x.t)}" data-stop>+ Watch</button>`}</td></tr>`).join("")}</tbody></table></section>`;
  }
  function secBoard(r) {
    const tickers = activeList();
    const others = r.stocks.filter((s) => !isWatched(s.ticker) && s.tags.includes("swing")).sort((a, b) => b.scores.swing - a.scores.swing).slice(0, 4);
    const cards = tickers.map((t) => { const s = stockFor(t); if (s) return watchCard(s, false, r); const q = r.lite && r.lite[t]; return q ? liteCard(t, q, r) : pendingCard(t); });
    const watchHtml = cards.length ? `<div class="board">${cards.join("")}</div>`
      : `<div class="empty">Your watchlist is empty. Type a ticker or company name in the box above (press <kbd>/</kbd>) and pick a result: stocks and ETFs both work. Each name gets a verdict, a plan and a checklist here.</div>`;
    return `<section class="top">
      ${watchStrip(r)}
      ${watchHtml}
      ${others.length ? `<div class="ideas"><h3>Ideas outside your list <span class="muted">top ${others.length} swing setups from the scan · click to open</span></h3><table class="tbl ideas-tbl"><thead><tr><th>Name</th><th>Price</th><th>Verdict</th><th>Setup</th><th>Swing</th><th>Day</th><th></th></tr></thead><tbody>${others.map((s) => { const a = s.ai || {}; const st = a.stance ? a.stance.choice : null; return `<tr class="clickable" data-ticker-page="${esc(s.ticker)}"><td class="sym"><b>${esc(s.ticker)}</b><div class="meta2">${esc(s.name)}</div></td><td class="num">${fnum(s.last_price)}<div class="delta ${cls(s.chg_pct)}">${fpct(s.chg_pct)}</div></td><td>${st ? `<span class="pill ${ST.cls[st]}">${ST.stance[st][0]}</span>` : "–"}</td><td>${a.setup ? pretty(a.setup.choice) : "–"}</td><td class="num"><b>${(s.scores.swing * 100).toFixed(0)}</b></td><td class="num">${(s.scores.day * 100).toFixed(0)}</td><td><button class="btn sm ghost" data-add-ticker="${esc(s.ticker)}" data-stop>+ Watch</button></td></tr>`; }).join("")}</tbody></table></div>` : ""}
    </section>`;
  }

  // ---------------------------------------------------------------- options flow
  const OP = {
    read: { aggressive_call_buying: ["Aggressive call buying", "Speculators are paying up for near-dated upside.", "up"], call_positioning_measured: ["Measured call positioning", "Steady bullish positioning in longer or at-the-money strikes.", "up2"], put_hedging: ["Put hedging", "Holders buying protection under a rising stock, not a bearish bet.", "flat"], put_buying_bearish: ["Bearish put buying", "Directional downside bet in near-dated puts.", "down"], two_sided_or_premium_selling: ["Two-sided / premium selling", "Spreads or income trades; no clean direction.", "flat"], quiet: ["Quiet", "Nothing unusual against open interest.", "flat"] },
    intensity: ["ordinary", "elevated", "heavy", "extreme"],
    pos: { complacent: "Complacent: low put/call, call-heavy single-stock flow, little hedging. Crowded long.", bullish_healthy: "Bullish and healthy: call-leaning flow with normal index hedging.", balanced: "Balanced: no side dominant.", hedged: "Hedged: index puts elevated while single-stock calls stay active.", fearful: "Fearful: put buying across categories." },
  };
  const opBadge = (s) => { const o = s && s.options; if (!o || !o.ai) return ""; const rd = OP.read[o.ai.read.choice]; const cl = { up: "ok", up2: "ok", down: "bad", flat: "" }[rd[2]] || ""; return `<span class="tag ${cl}" title="${esc(rd[1])} Intensity ${OP.intensity[Math.round(o.ai.intensity.score)]}, put/call ${o.pc_volume ?? "–"}.">options: ${rd[0].toLowerCase()}${o.ai.intensity.score >= 2 ? " · heavy" : ""}</span>`; };
  function secOptions(r) {
    const O = r.options; if (!O || !O.rows || !O.rows.length) return `<section><h2>Options flow</h2><div class="muted">No options data this build.</div></section>`;
    const cb = O.cboe || {}; const rt = cb.ratios || {};
    const tile = (l, v, sub) => `<div class="tile"><div class="tile-label">${l}</div><div class="tile-value">${v}</div><div class="tile-sub">${sub || ""}</div></div>`;
    const ratioTiles = ["TOTAL PUT/CALL RATIO", "INDEX PUT/CALL RATIO", "EQUITY PUT/CALL RATIO", "EXCHANGE TRADED PRODUCTS PUT/CALL RATIO"].filter((k) => isNum(rt[k])).map((k) => tile(k.replace(" PUT/CALL RATIO", " put/call").toLowerCase(), rt[k].toFixed(2), k.startsWith("TOTAL") ? (rt[k] > 1 ? "more puts than calls" : rt[k] < 0.7 ? "call-heavy" : "normal") : "")).join("");
    const agg = O.scanned || {};
    const head = `<div class="grid c6" style="margin-bottom:12px">
      ${ratioTiles}
      ${tile("scanned names put/call", isNum(agg.aggregate_put_call) ? agg.aggregate_put_call.toFixed(2) : "–", `${fvol(agg.aggregate_call_volume)} calls · ${fvol(agg.aggregate_put_volume)} puts across ${agg.n} names`)}
      ${O.ai ? `<div class="tile"><div class="tile-label">Positioning read</div><div class="tile-value small">${pretty(O.ai.positioning.choice)}</div>${explain(OP.pos[O.ai.positioning.choice] || "")}<div class="tile-sub">${convTag(O.ai.positioning.confidence)} · most dollars in <b>${pretty(O.ai.where_volume_flows.choice)}</b></div></div>` : ""}
    </div>`;
    const rows = O.rows.map((o) => { const a = o.ai || {}; const rd = a.read ? OP.read[a.read.choice] : null; const tc = (o.top_calls || [])[0], tp = (o.top_puts || [])[0];
      return `<tr>
        <td class="sym"><b>${esc(o.ticker)}</b><div class="meta2">${isNum(o.spot) ? fnum(o.spot) : ""} · IV ${isNum(o.atm_iv) ? (o.atm_iv * 100).toFixed(0) + "%" : "–"}</div></td>
        <td class="num">${fcap(o.total_notional)}<div class="meta2">${fcap(o.call_notional)} calls · ${fcap(o.put_notional)} puts</div></td>
        <td class="num"><span class="up">${fvol(o.call_volume)}</span> / <span class="down">${fvol(o.put_volume)}</span><div class="meta2">P/C ${o.pc_volume ?? "–"} · OI P/C ${o.pc_oi ?? "–"}</div></td>
        <td><div class="brd" style="grid-template-columns:1fr 44px;margin:0"><span class="bar" style="width:100%"><span class="bar-fill up" style="width:${isNum(o.call_share) ? (o.call_share * 100).toFixed(0) : 0}%"></span></span><span class="num">${isNum(o.call_share) ? (o.call_share * 100).toFixed(0) + "%" : "–"}</span></div><div class="meta2">share of $ in calls</div></td>
        <td>${tc ? `<b>${fnum(tc.strike, 0)}C</b> ${tc.dte}d <span class="muted">${fvol(tc.volume)} vol · ${fcap(tc.notional)}${isNum(tc.otm_pct) ? " · " + fpct(tc.otm_pct, 0) + " OTM" : ""}</span>` : "–"}<div class="meta2">${tp ? `<b>${fnum(tp.strike, 0)}P</b> ${tp.dte}d ${fvol(tp.volume)} vol · ${fcap(tp.notional)}` : ""}</div></td>
        <td>${(o.unusual || []).slice(0, 2).map((u) => `<div><span class="${u.side === "call" ? "up" : "down"}">${fnum(u.strike, 0)}${u.side === "call" ? "C" : "P"}</span> ${u.dte}d · ${fvol(u.volume)} vol vs ${fvol(u.oi)} OI (${u.vol_oi}×) · ${fcap(u.notional)}</div>`).join("") || '<span class="muted">none</span>'}</td>
        <td>${rd ? `<span class="pill ${rd[2]}">${rd[0]}</span> ${convTag(a.read.confidence)}<div class="meta2">${OP.intensity[Math.round(a.intensity.score)]} · ${esc(rd[1])}</div>` : "–"}</td></tr>`; }).join("");
    const heavy = (O.heavy || []).slice(0, 12).map((u) => `<li><b>${esc(u.ticker)}</b> <span class="${u.side === "call" ? "up" : "down"}">${fnum(u.strike, 0)} ${u.side}</span> · ${esc(u.expiry)} (${u.dte}d) · ${fvol(u.volume)} contracts vs ${fvol(u.oi)} open (${u.vol_oi}×) · <b>${fcap(u.notional)}</b>${isNum(u.otm_pct) ? ` · ${fpct(u.otm_pct, 0)} from spot` : ""}</li>`).join("");
    return `<section class="op-section"><h2>Options flow: where the bets are going <span class="muted">source: Yahoo option chains, 15-minute delayed, refreshed every 30 min · Cboe daily totals as of ${esc(cb.as_of || "–")} · "unusual" = today's contracts ≥ 3× the ones already open and ≥ $250k</span></h2>
      ${explain("Calls are bets on up, puts on down or protection. Notional is contracts × price × 100, the dollars actually traded. When volume swamps open interest, the positions are new today, which is the closest public proxy for aggressive buying.")}
      ${head}
      <h3 style="margin-top:4px">Heaviest new positioning today</h3>
      <div class="heavy-strip">${(O.heavy || []).slice(0, 10).map((u) => `<div class="hv ${u.side}"><div class="hv-t"><b>${esc(u.ticker)}</b> <span class="${u.side === "call" ? "up" : "down"}">${fnum(u.strike, 0)} ${u.side.toUpperCase()}</span></div><div class="hv-n">${fcap(u.notional)}</div><div class="meta2">${u.dte}d · ${fvol(u.volume)} contracts${u.vol_oi ? ` · ${u.vol_oi}× OI` : " · OI not posted"}${isNum(u.otm_pct) ? ` · ${fpct(u.otm_pct, 0)}` : ""}</div></div>`).join("") || '<div class="muted">nothing unusual</div>'}</div>
      <div class="tbl-wrap" style="margin-top:12px"><table class="tbl op-tbl"><thead><tr><th>Ticker</th><th>$ traded</th><th>Call / put vol</th><th>Call share</th><th>Top strikes</th><th>Unusual</th><th>Model read</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`;
  }

  // ---------------------------------------------------------------- smart money
  const SM = {
    conv: ["Distribution: insiders selling, institutions trimming.", "Quiet: routine activity only.", "Accumulation: a real insider buy or clear institutional adds.", "Cluster buying: several informed buyers with real money."],
    who: { insiders_buying: "Insiders are buying on the open market.", insiders_selling: "Insiders are selling beyond routine diversification.", institutions_adding: "Top holders added in the latest filings.", institutions_trimming: "Top holders trimmed.", politicians_buying: "Members of Congress reported purchases.", shorts_pressing: "Short interest is rising into the move.", nobody: "No informative activity." },
  };
  const smBadge = (s) => {
    const m = s && s.smart; if (!m || !m.ai) return "";
    const c = m.ai.conviction.score;
    const label = c >= 2.5 ? "smart money: cluster buying" : c >= 1.5 ? "smart money: buying" : c < 0.5 ? "smart money: selling" : "smart money: quiet";
    const cl = c >= 1.5 ? "ok" : c < 0.5 ? "bad" : "";
    return `<span class="tag ${cl}" title="${esc(SM.conv[Math.round(c)])} Score ${c.toFixed(1)} of 3.">${label}</span>`;
  };
  function secSmart(r) {
    const S = r.smart_money; if (!S || !S.rows || !S.rows.length) return "";
    const rows = S.rows.filter((m) => m.ai).slice().sort((a, b) => b.ai.conviction.score - a.ai.conviction.score);
    const sig = (m) => {
      const ins = m.insider || {}, inst = m.institutions || {}, sh = m.short || {}, cg = m.congress || [];
      const buys = (ins.open_market_buys_90d || []).length, sells = (ins.open_market_sales_90d || []).length;
      const cells = [
        { k: "Insiders", st: buys ? "yes" : sells ? "no" : "na", t: buys ? `${buys} buy${buys > 1 ? "s" : ""} · ${fcap(ins.buy_value_90d)}` : sells ? `${sells} sale${sells > 1 ? "s" : ""} · ${fcap(ins.sell_value_90d)}` : "quiet" },
        { k: "Funds", st: isNum(inst.top10_avg_change) ? (inst.top10_avg_change > 0.01 ? "yes" : inst.top10_avg_change < -0.01 ? "no" : "na") : "na", t: isNum(inst.top10_avg_change) ? `top-10 ${fpct(inst.top10_avg_change * 100, 0)}` : "no data" },
        { k: "Congress", st: cg.some((c) => c.type === "buy") ? "yes" : cg.some((c) => c.type === "sale") ? "no" : "na", t: cg.length ? `${cg.filter((c) => c.type === "buy").length} buy · ${cg.filter((c) => c.type === "sale").length} sell` : "none" },
        { k: "Shorts", st: isNum(sh.change_pct) ? (sh.change_pct < -5 ? "yes" : sh.change_pct > 5 ? "no" : "na") : "na", t: isNum(sh.change_pct) ? `${fpct(sh.change_pct, 0)} m/m · ${isNum(sh.short_pct_float) ? (sh.short_pct_float * 100).toFixed(0) + "% float" : ""}` : "no data" },
      ];
      return `<div class="sig">${cells.map((c) => `<div class="sig-cell ${c.st}" title="${esc(c.k)}: ${esc(c.t)}"><span class="sig-k">${c.k}</span><span class="sig-v">${esc(c.t)}</span></div>`).join("")}</div>`;
    };
    const meter = (v) => `<div class="meter" title="conviction ${v.toFixed(1)} of 3">${[0, 1, 2].map((i) => `<span class="${v >= i + 0.5 ? "on" : ""}"></span>`).join("")}</div>`;
    const dataWho = (m) => {                       // the card's label comes from the filings themselves, so the heading can never contradict the line under it
      const ins = m.insider || {}, inst = m.institutions || {}, cg = m.congress || [], sh = m.short || {};
      const buys = (ins.open_market_buys_90d || []).length, sells = (ins.open_market_sales_90d || []).length || ((ins.sell_value_90d || 0) > 0 ? 1 : 0);
      if (buys && sells) return ["insiders mixed", "flat"]; if (buys) return ["insiders buying", "up"]; if (sells) return ["insiders selling", "down"];
      if (isNum(inst.top10_avg_change) && inst.top10_avg_change > 0.01) return ["big holders adding", "up"]; if (isNum(inst.top10_avg_change) && inst.top10_avg_change < -0.01) return ["big holders trimming", "down"];
      if (cg.some((c) => c.type === "buy")) return ["congress buying", "up"]; if (isNum(sh.change_pct) && sh.change_pct > 5) return ["shorts pressing", "down"]; return ["quiet", "flat"]; };
    const card = (m) => { const c = m.ai.conviction.score; const b = (m.insider.open_market_buys_90d || [])[0]; const [wl, wc] = dataWho(m);
      const headline = b ? `${b.insider} (${(b.position || "").toLowerCase().replace("chief executive officer", "CEO").replace("chief financial officer", "CFO")}) bought ${fcap(b.value)} · ${b.date.slice(5)}` : wl === "insiders selling" ? `${fcap(m.insider.sell_value_90d)} sold by insiders in 90 days` : SM.who[m.ai.who.choice];
      return `<article class="sm-card ${c >= 1.5 ? "acc" : c < 0.5 ? "dist" : "quiet"}" data-open="${esc(m.ticker)}">
        <div class="sm-head"><b class="sm-t">${esc(m.ticker)}</b>${meter(c)}<span class="sm-who pill ${wc}">${wl}</span></div>
        <div class="sm-line">${esc(headline)}</div>
        ${sig(m)}
      </article>`; };
    const groups = [["Accumulating", rows.filter((m) => m.ai.conviction.score >= 1.5), "Informed money is adding"], ["Quiet", rows.filter((m) => m.ai.conviction.score >= 0.5 && m.ai.conviction.score < 1.5), "Nothing informative either way"], ["Distributing", rows.filter((m) => m.ai.conviction.score < 0.5), "Insiders or funds are selling"]];
    const allBuys = rows.flatMap((m) => (m.insider.open_market_buys_90d || []).map((b) => ({ t: m.ticker, ...b }))).filter((b) => b.value).sort((a, b) => b.value - a.value);
    const allSells = rows.map((m) => ({ t: m.ticker, v: m.insider.sell_value_90d || 0 })).filter((x) => x.v).sort((a, b) => b.v - a.v);
    const tot = (arr, f) => arr.reduce((n, x) => n + f(x), 0);
    const stat = (l, v, sub, cl) => `<div class="tile"><div class="tile-label">${l}</div><div class="tile-value ${cl || ""}">${v}</div><div class="tile-sub">${sub || ""}</div></div>`;
    const cg = S.congress_top || [];
    const head = `<div class="grid c5" style="margin-bottom:12px">
      ${stat("Accumulating / quiet / distributing", `<span class="up">${groups[0][1].length}</span> / ${groups[1][1].length} / <span class="down">${groups[2][1].length}</span>`, `${rows.length} names scored by the model`)}
      ${stat("Insider buying, 90 days", fcap(tot(allBuys, (b) => b.value)), allBuys[0] ? `largest: ${allBuys[0].t} ${fcap(allBuys[0].value)} (${allBuys[0].insider})` : "none", "up")}
      ${stat("Insider selling, 90 days", fcap(tot(allSells, (x) => x.v)), allSells[0] ? `largest: ${allSells[0].t} ${fcap(allSells[0].v)}` : "none", "down")}
      ${stat("Congress most bought", cg[0] ? `${cg[0].ticker} ×${cg[0].buys}` : "–", cg.slice(1, 4).map((x) => `${x.ticker} ×${x.buys}`).join(" · "))}
      ${stat("Read the strip", '<span class="sig demo"><span class="sig-cell yes"><span class="sig-k">buying</span></span><span class="sig-cell na"><span class="sig-k">quiet</span></span><span class="sig-cell no"><span class="sig-k">selling</span></span></span>', "insiders · funds · Congress · shorts, left to right")}
    </div>`;
    const cols = groups.map(([name, arr, sub]) => `<div class="sm-col"><h3>${name} <span class="muted">${arr.length} · ${sub}</span></h3>${arr.map(card).join("") || '<div class="empty">none</div>'}</div>`).join("");
    const src = `<div class="src-line"><b>Sources and delays:</b> insider trades from SEC filings via Yahoo, posted up to 2 business days after the trade · big holders from quarterly filings, up to 45 days old · Congress trades from STOCK Act filings, 30 to 45 days late · short interest published twice a month. ${S.rows.some((m) => m.congress && m.congress.length) ? "" : "Congress feed: nothing returned this build."}</div>`;
    return `<section class="sm-section"><h2>Filings and flow <span class="muted">what insiders, big holders and Congress have reported · click a card for the full analysis</span></h2>
      ${src}${head}
      <div class="sm-board">${cols}</div></section>`;
  }

  // ---------------------------------------------------------------- theme screen: who can run
  const TH = {
    stage: { early: "Early: leaders just breaking out, most groups still flat.", mid: "Mid: leaders extended, second-tier groups turning up; participation broadening.", late: "Late: nearly every group up and extended; laggards running.", exhausted: "Exhausted: leaders rolling over while laggards spike.", broken: "Broken: most groups in downtrends." },
    phase: { leader: "Leading the group", catching_up: "Catching up", laggard: "Lagging", extended: "Extended after a vertical run", broken: "Broken" },
    lev: ["peripheral", "meaningful", "core", "pure play"],
    levPlain: ["Barely tied to the theme", "Partly tied to the theme", "Core to the theme", "Pure play on the theme"],
    move: ["market-like", "amplified", "explosive", "parabolic candidate"],
    movePlain: ["Moves like the market", "Moves more than the market", "Can move a lot in a day", "Can go parabolic"],
    phasePlain: { leader: "Already leading. Chase less; buy pullbacks.", catching_up: "Just starting to move. Often the better entry.", laggard: "Has not moved yet. Needs a trigger first.", extended: "Ran too far, too fast. Wait for a rest.", broken: "Trend is broken. Leave it alone." },
    phaseCls: { leader: "up", catching_up: "up2", laggard: "flat", extended: "warn", broken: "down" },
    fund: ["story only", "mixed", "supported", "underpriced"],
    group: { compute: "Compute", memory_storage: "Memory & storage", networking_optics: "Networking & optics", servers_cooling: "Servers & cooling", power: "Power", semicap: "Chip equipment", real_estate: "Data-center REITs", platforms: "Hyperscalers & clouds" },
  };
  let themeGroup = "all";
  function secTheme(r) {
    const T_ = r.theme; if (!T_ || !T_.rows || !T_.rows.length) return "";
    const ai = T_.ai;
    const head = ai ? `<div class="hz-cross th-cross">
        <div class="tile"><div class="tile-label">Where the theme is</div><div class="tile-value small">${pretty(ai.stage.choice)}</div>${explain(TH.stage[ai.stage.choice] || "")}<div class="tile-sub">${convTag(ai.stage.confidence)}</div></div>
        <div class="tile"><div class="tile-label">Likely next leg</div><div class="tile-value small">${TH.group[ai.next_group.choice] || pretty(ai.next_group.choice)}</div>${explain("The part of the stack whose relative strength is turning while the leaders rest.")}<div class="tile-sub">${convTag(ai.next_group.confidence)}</div></div>
        <div class="tile"><div class="tile-label">How to read the strip below</div><div class="tile-value small">Pick a part of the stack</div>${explain("Each box is one part of the data-center build-out. The number is how the group did against the S&P over one month; the bar is how many of its names are in an uptrend. Money rotates through these boxes: the leaders run first, then the next ones. Click a box to see its names.")}</div>
      </div>` : "";
    const groups = ["all", ...Object.keys(TH.group).filter((k) => T_.rows.some((x) => x.group === k))];
    const gstat = (k) => (T_.groups || []).find((g) => g.group === k) || {};
    const allRel = (T_.groups || []).filter((g) => isNum(g.avg_rel_vs_spy_1m)); const allAvg = allRel.length ? allRel.reduce((n, g) => n + g.avg_rel_vs_spy_1m, 0) / allRel.length : null;
    const tabs = groups.map((k) => { const g = k === "all" ? { avg_rel_vs_spy_1m: allAvg, share_in_uptrend: allRel.length ? allRel.reduce((n, x) => n + (x.share_in_uptrend || 0), 0) / allRel.length : null, n: T_.rows.length } : gstat(k);
      const rel = g.avg_rel_vs_spy_1m, up = g.share_in_uptrend, c = cls(rel);
      return `<button class="gsel ${themeGroup === k ? "active" : ""} ${c}" data-theme-group="${k}"><span class="gsel-n">${k === "all" ? "All names" : TH.group[k]}</span><span class="gsel-v mono ${c}">${isNum(rel) ? fpct(rel, 1) : "–"}</span><span class="gsel-s"><i class="gsel-bar"><b style="width:${isNum(up) ? (up * 100).toFixed(0) : 0}%"></b></i>${isNum(up) ? Math.round(up * 100) + "% in uptrend" : ""}${isNum(g.n) ? ` · ${g.n}` : ""}</span></button>`; }).join("");
    const rows = T_.rows.filter((x) => themeGroup === "all" || x.group === themeGroup).map((x) => {
      const a = x.ai || {}, t = x.technicals, f = x.fundamentals || {};
      const ph = a.phase ? a.phase.choice : "";
      const rk = x.rank || 0, rkWord = words(rk, 1.0001, SCORE_WORDS), rkCls = rk >= 0.75 ? "up" : rk >= 0.5 ? "up2" : rk >= 0.25 ? "flat" : "down";
      const lev = a.theme_leverage ? Math.round(a.theme_leverage.score) : null, mv = a.move_potential ? Math.round(a.move_potential.score) : null;
      const flags = [...(x.tags || []).map((g) => `<span class="tag ${g === "extended" ? "bad" : g === "earnings_soon" ? "warn" : g === "new_high" ? "ok" : "acc"}">${pretty(g)}</span>`), smBadge(x), opBadge(x)].filter(Boolean).join("");
      return `<tr>
        <td class="sym"><b>${esc(x.ticker)}</b><div class="meta2">${esc(x.name || "")} · ${TH.group[x.group] || x.group}</div></td>
        <td class="th-run"><b class="${rkCls}">${rkWord}</b><span class="mono muted">${(rk * 100).toFixed(0)}</span><div class="th-bar"><i class="${rkCls}" style="width:${(rk * 100).toFixed(0)}%"></i></div></td>
        <td class="th-ph">${ph ? `<span class="pill ${TH.phaseCls[ph] || "flat"}">${TH.phase[ph] || pretty(ph)}</span><div class="meta2">${TH.phasePlain[ph] || ""}</div>` : '<span class="muted">–</span>'}</td>
        <td class="th-lv">${lev != null ? `<div class="dots">${[0, 1, 2].map((i) => `<i class="${i < lev ? "on" : ""}"></i>`).join("")}</div><div class="meta2">${TH.levPlain[lev]}</div>` : '<span class="muted">–</span>'}</td>
        <td class="th-mv">${mv != null ? `<div class="dots mv">${[0, 1, 2].map((i) => `<i class="${i < mv ? "on" : ""}"></i>`).join("")}</div><div class="meta2">${TH.movePlain[mv]}</div>` : '<span class="muted">–</span>'}</td>
        <td class="num">${fnum(x.last_price)}<div class="delta ${cls(x.chg_pct)}">${arrow(x.chg_pct)} ${fpct(x.chg_pct)}</div></td>
        <td class="num"><span class="${cls(x.rel_1m)}">${fpct(x.rel_1m, 0)}</span><div class="meta2">vs S&amp;P, 1 month</div></td>
        <td class="th-fl">${flags || '<span class="muted">–</span>'}</td>
        <td><a class="btn sm ghost" href="${tvLink(x.ticker)}" target="_blank" rel="noopener">Chart</a></td></tr>`;
    }).join("");
    const legend = `<div class="th-legend"><span><b>Run score</b> how likely the name is to move if the theme runs: strong, good, modest or weak.</span><span><b>Phase</b> where it is in its own move.</span><span><b>Theme tie</b> how much of its business is the theme (dots: one to three).</span><span><b>Move size</b> how big its moves tend to be.</span></div>`;
    return `<section class="th-section"><h2>${esc(T_.name)}: who can run <span class="muted">${T_.rows.length} names by role in the stack · ranked by theme leverage × move potential × trend × volatility × relative strength · SPY ${fpct(T_.spy_ret_1m, 1)} / ${fpct(T_.spy_ret_3m, 1)} over 1 / 3 months</span></h2>
      ${head}
      <div class="gstrip">${tabs}</div>
      ${legend}
      <div class="tbl-wrap"><table class="tbl th-tbl"><thead><tr><th>Name</th><th>Run score</th><th>Phase</th><th>Theme tie</th><th>Move size</th><th>Price</th><th>1 month</th><th>Flags</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  // ---------------------------------------------------------------- big picture: 1 / 3 / 6 / 12 months
  function secHorizons(r) {
    const H = r.horizons; if (!H || !H.assets || !H.assets.length) return "";
    const cx = H.ai;
    const keys = Object.keys(H.windows);
    const cell = (a, k) => {
      const h = a.horizons[k] || {}; const y = a.kind === "yield";
      const v = y ? h.change_bp : h.return_pct; const c = cls(v, y);
      const pos = h.range_pos;
      return `<td class="num hz ${c}"><div class="hz-v">${arrow(v)} ${y ? fbp(v) : fpct(v, 1)}</div><div class="hz-pos" title="where price sits in this window's range"><span class="bar"><span class="bar-fill" style="width:${isNum(pos) ? (pos * 100).toFixed(0) : 0}%"></span></span><span class="muted">${isNum(pos) ? (pos * 100).toFixed(0) + "% of range" : "–"}</span></div><div class="meta2">dd ${fpct(h.max_drawdown_pct, 1)} · ${pretty(h.structure || "")}</div></td>`;
    };
    const rows = H.assets.map((a) => {
      const ai = a.ai || {}; const y = a.kind === "yield";
      const read = ai.regime ? `<div class="hz-read"><b>${pretty(ai.regime.choice)}</b> ${conf(ai.regime.confidence)}<div class="explain">${HZ.regime[ai.regime.choice] || ""} ${HZ.alignment[(ai.alignment || {}).choice] || ""} ${ai.strength ? HZ.strength[Math.round(ai.strength.score)] : ""}</div></div>` : "";
      return `<tr class="clickable hz-row" data-hz="${esc(a.symbol)}">
        <td class="sym"><b>${esc(a.label)}</b><div class="meta2">${esc(a.symbol)} · ${y ? fnum(a.last, 3) + "%" : fnum(a.last)} <span class="delta ${cls(a.chg_pct, y)}">${fpct(a.chg_pct)}</span></div><div class="meta2">${a.above_sma50 == null ? "" : (a.above_sma50 ? "above" : "below") + " 50d · "}${a.above_sma200 == null ? "" : (a.above_sma200 ? "above" : "below") + " 200d"} · RSI ${fnum(a.rsi14, 0)}</div></td>
        ${keys.map((k) => cell(a, k)).join("")}
        <td class="hz-readcell">${read}</td></tr>
      <tr class="hz-chart-row" data-hz-chart="${esc(a.symbol)}" hidden><td colspan="${keys.length + 2}"><div class="chart" data-chart-weekly="${esc(a.symbol)}"></div><div class="legend"><span>52 weekly candles · </span><span><i class="k1"></i>10-week average</span><span><i class="k2"></i>40-week average</span></div></td></tr>`;
    }).join("");
    const cross = cx ? `<div class="hz-cross">
        <div class="tile"><div class="tile-label">Macro picture, last 3–6 months</div><div class="tile-value small">${pretty(cx.macro_read.choice)}</div>${explain(HZ.macro[cx.macro_read.choice] || "")}<div class="tile-sub">${convTag(cx.macro_read.confidence)}</div></div>
        <div class="tile"><div class="tile-label">Equity lean, next 3 months</div><div class="tile-value small ${{ higher: "up", lower: "down" }[cx.equity_lean_3m.choice] || "flat"}">${cx.equity_lean_3m.choice}</div>${explain(HZ.lean[cx.equity_lean_3m.choice] || "")}<div class="tile-sub">${convTag(cx.equity_lean_3m.confidence)} · a lean, not a forecast</div></div>
        <div class="tile"><div class="tile-label">Biggest risk to the trend</div><div class="tile-value small">${pretty(cx.biggest_risk.choice)}</div>${explain(HZ.risk[cx.biggest_risk.choice] || "")}<div class="tile-sub">${convTag(cx.biggest_risk.confidence)}</div></div>
      </div>` : "";
    return `<section class="hz-section"><h2>Big picture: 1, 3, 6 and 12 months <span class="muted">S&amp;P futures, Nasdaq 100, gold, oil, 10-year · return, position in range, drawdown, structure · click a row for the weekly chart</span></h2>
      ${cross}
      <div class="tbl-wrap"><table class="tbl hz-tbl"><thead><tr><th>Asset</th>${keys.map((k) => `<th>${k.replace("m", " month").replace("1 month", "1 month").replace("12 month", "12 months").replace("3 month", "3 months").replace("6 month", "6 months")}</th>`).join("")}<th>Model read</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  function weeklyChart(el, bars, levels, height) {
    if (!window.LightweightCharts || !bars || !bars.length) { el.innerHTML = '<div class="muted" style="padding:20px">chart unavailable</div>'; return; }
    const dark = document.documentElement.getAttribute("data-theme") === "dark" || (!document.documentElement.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
    const chart = LightweightCharts.createChart(el, { height: height || 220, layout: { background: { color: "transparent" }, textColor: cssVar("--muted") || "#888", fontSize: 11 },
      grid: { vertLines: { color: dark ? "#26262a" : "#eeede9" }, horzLines: { color: dark ? "#26262a" : "#eeede9" } },
      rightPriceScale: { borderColor: cssVar("--border") }, timeScale: { borderColor: cssVar("--border") }, crosshair: { mode: 0 }, handleScroll: false, handleScale: false });
    const up = cssVar("--up"), down = cssVar("--down");
    const s = chart.addCandlestickSeries({ upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down });
    s.setData(bars.map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c })));
    const sma = (n) => { const out = []; for (let i = n - 1; i < bars.length; i++) { let a = 0; for (let j = i - n + 1; j <= i; j++) a += bars[j].c; out.push({ time: bars[i].t, value: a / n }); } return out; };
    if (bars.length >= 10) chart.addLineSeries({ color: cssVar("--s1"), lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(sma(10));
    if (bars.length >= 40) chart.addLineSeries({ color: cssVar("--s2"), lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(sma(40));
    (levels || []).forEach((l) => { if (isNum(l.price)) s.createPriceLine({ price: l.price, color: l.color || cssVar("--muted"), lineWidth: l.width || 1, lineStyle: l.style == null ? 2 : l.style, axisLabelVisible: true, title: l.title }); });
    chart.timeScale().fitContent();
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth })); ro.observe(el);
    charts.push({ chart, ro });
  }

  // ---------------------------------------------------------------- HOME right column: live news feed
  function feedItems(r) { return newsItems.length ? newsItems : (r.headlines || []); }
  function feedHtml(r) {
    const items = feedItems(r).filter((h) => h.ai && ((h.ai.actionable && h.ai.actionable.p >= 0.5) || (h.ai.impact && h.ai.impact.score >= 1.5))).slice(0, 40);
    if (!items.length) return '<li class="muted" style="padding:8px 0">Nothing market-moving in the last hours. Headlines that cannot move prices are left out on purpose.</li>';
    return items.map((h) => { const a = h.ai; const d = a ? a.direction.choice : null; const dc = { bullish: "up", bearish: "down" }[d] || "flat";
      return `<li class="feed-item ${h._new ? "fresh" : ""}"><div class="feed-meta"><samp>${esc(timeET(h.published).slice(6))}</samp>${(h.related_tickers || []).slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}${a ? `<span class="pill ${dc}">${arrow({ bullish: 1, bearish: -1 }[d] || 0)} ${d}</span><span class="muted">impact ${a.impact.score.toFixed(1)}</span>` : ""}</div>
        ${h.url ? `<a class="feed-h" href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.headline)}</a>` : `<span class="feed-h">${esc(h.headline)}</span>`}
        <div class="meta2">${esc(h.source || "")}${a && a.theme ? ` · ${pretty(a.theme.choice)}` : ""}</div></li>`; }).join("");
  }
  async function pollNews() {
    if (STATIC_MODE || !report) return;
    try {
      const j = await (await api("/api/news", { cache: "no-store" })).json();
      const items = j.items || [];
      items.forEach((x) => { x._new = newsSeen.size > 0 && !newsSeen.has(x.id); });
      items.forEach((x) => newsSeen.add(x.id));
      newsItems = items;
      const el = $("#feed"); if (el) { el.innerHTML = feedHtml(report); }
      const st = $("#feed-stamp"); if (st) st.textContent = "live · " + new Date().toTimeString().slice(0, 5);
    } catch (e) { /* server restarting */ }
  }
  function secToday(r) {
    const cal = (r.calendar || []).slice(0, 4).map((c) => `<li><samp>${esc(c.time_et)}</samp> ${esc(c.title)}</li>`).join("") || "<li class=\"muted\">no relevant events</li>";
    const earn = (r.earnings || []).slice(0, 5).map((e) => `<b>${esc(e.symbol)}</b> <span class="muted">${esc(e.report_time)}</span>`).join(" · ") || '<span class="muted">none</span>';
    return `<aside class="today">
      ${discPanel()}
      <section class="panel"><h3>Today, ${esc(r.session_date)}</h3><ul class="list">${cal}</ul><div class="meta2" style="margin-top:6px">Earnings: ${earn}</div></section>
      <section class="panel feed-panel"><h3>News that can move the market <span id="feed-stamp" class="muted" style="letter-spacing:0;text-transform:none">${STATIC_MODE ? "from the latest build" : "live · every headline read once, only the ones that matter stay"}</span></h3>
        <ul class="feed" id="feed">${feedHtml(r)}</ul></section>
    </aside>`;
  }
  // ---------------------------------------------------------------- sections
  function secRegime(r) {
    const g = r.regime;
    if (!g) return `<section class="card"><div class="muted">${r.ai_enabled ? "Regime call unavailable this build." : "AI judgments disabled for this build."}</div></section>`;
    const volL = ["Quiet", "Normal", "Elevated", "Extreme"];
    const toneCls = { risk_on: "up", risk_off: "down", mixed: "flat" }[g.tone.choice];
    const tile = (label, value, sub, why) => `<div class="tile"><div class="tile-label">${label}</div><div class="tile-value small">${value}</div>${explain(why)}<div class="tile-sub">${sub}</div></div>`;
    const vi = Math.round(g.volatility.score);
    return `<section><h2>How the market feels today <span class="muted">model read of the overnight tape, rates, flows and news</span></h2><div class="regime">
      <div class="tile hero"><div class="tile-label">Mood</div><div class="tile-value ${toneCls}">${pretty(g.tone.choice).toUpperCase()}</div>${explain(EX.tone[g.tone.choice])}<div class="tile-sub">${convTag(g.tone.confidence)}</div></div>
      <div class="tile"><div class="tile-label">Expected swings</div><div class="tile-value small">${volL[vi]}</div>${explain(EX.vol[vi])}<div class="tile-sub">${bar(g.volatility.score, 3)} ${volL[vi].toLowerCase()} ${convTag(g.volatility.confidence)}</div></div>
      ${tile("What's driving it", pretty(g.driver.choice), convTag(g.driver.confidence), EX.driver[g.driver.choice] || "")}
      ${tile("Who should lead", esc(leaderLabel(r, pretty(g.leadership.choice))), leadingSector(r) ? "top of today's industry table" : convTag(g.leadership.confidence), (leadingSector(r) ? "The strongest industry group in today's table leads the tape. " : "") + (EX.lead[g.leadership.choice] ? "Model view: " + EX.lead[g.leadership.choice] : ""))}
      ${tile("Interest rates", `<span class="${{ tailwind: "up", headwind: "down", growth_scare: "warn" }[g.rates_read.choice] || "flat"}">${pretty(g.rates_read.choice)}</span>`, convTag(g.rates_read.confidence), EX.rates[g.rates_read.choice] || "")}
      ${tile("Where money is going", pretty(g.flow_read.choice), convTag(g.flow_read.confidence), EX.flow[g.flow_read.choice] || "")}
    </div></section>`;
  }

  function secMacro(r) {
    const inv = new Set(["^VIX", "^TNX", "DX-Y.NYB"]);
    const tiles = r.macro.map((m) => {
      const c = cls(m.change_pct, inv.has(m.symbol));
      const val = m.kind === "yield" ? fnum(m.last, 2) + "%" : fnum(m.last, (m.last || 0) < 1000 ? 2 : 1);
      const chg = m.kind === "yield" ? `${arrow(m.change)} ${fbp((m.change || 0) * 100)}` : `${arrow(m.change_pct)} ${fpct(m.change_pct)}`;
      return `<div class="tape-item"><div class="tile-label">${esc(m.label)}</div><div class="tile-row"><span class="tile-value">${val}</span><span class="delta ${c}">${chg}</span></div>${spark(m.spark, c)}</div>`;
    }).join("");
    return `<section><h2>What moved overnight <span class="muted">futures, ${term("vix", "VIX")}, yields, dollar, oil, gold, bitcoin · change vs prior close · 5-day line</span></h2><div class="tape">${tiles}</div></section>`;
  }

  function secIndexesWeekly(r) {
    const cards = r.indices.map((i) => {
      const t = i.technicals, c = cls(i.chg_pct), L = i.weekly_levels || {};
      const trendCls = { up: "up", down: "down", mixed: "flat" }[t.trend];
      return `<div class="card idx">
        <div class="detail-head"><b>${esc(i.symbol)}</b><span class="muted">${esc(i.name)}</span><span class="px">${fnum(i.last)}</span><span class="delta ${c}">${arrow(i.chg_pct)} ${fpct(i.chg_pct)}</span><span class="tag ${trendCls}">trend ${t.trend}</span>${L.structure ? `<span class="tag">${pretty(L.structure).replace("hh hl", "").replace("lh ll", "").trim()}</span>` : ""}</div>
        <div class="chart wk" data-chart-weekly-idx="${esc(i.symbol)}"></div>
        <div class="lvl"><span class="lvl-r"><i></i>Resistance ${fnum(L.resistance)} <span class="muted">${isNum(L.resistance_pct) ? fpct(L.resistance_pct, 1) : ""}</span></span><span class="lvl-s"><i></i>Support ${fnum(L.support)} <span class="muted">${isNum(L.support_pct) ? fpct(L.support_pct, 1) : ""}</span></span><span class="lvl-x"><i></i>52-week ${fnum(L.lo52)} – ${fnum(L.hi52)}</span><span class="muted">${term("rsi", "RSI")} ${fnum(t.rsi14, 0)} · 1m <span class="${cls(t.ret_1m)}">${fpct(t.ret_1m, 1)}</span> · 3m <span class="${cls(t.ret_3m)}">${fpct(t.ret_3m, 1)}</span></span></div>
      </div>`;
    }).join("");
    return `<section class="idx-section"><h2>The big indexes, weekly <span class="muted">52 weekly candles · support and resistance are the nearest weekly swing low and high · thin lines: 10 and 40-week averages</span></h2><div class="idx-grid">${cards}</div></section>`;
  }
  function secIndices(r) {
    const cards = r.indices.map((i) => {
      const t = i.technicals, c = cls(i.chg_pct);
      const pos = t.range_pos_52w;
      const trendCls = { up: "up", down: "down", mixed: "flat" }[t.trend];
      const b = (v) => (v == null ? '<span class="muted">–</span>' : v ? '<span class="up">above</span>' : '<span class="down">below</span>');
      return `<div class="card">
        <div class="detail-head"><b>${esc(i.symbol)}</b><span class="muted">${esc(i.name)}</span><span class="px">${fnum(i.last)}</span><span class="delta ${c}">${arrow(i.chg_pct)} ${fpct(i.chg_pct)}</span><span class="tag ${trendCls}">trend ${t.trend}</span></div>
        <div class="chart" data-chart="${esc(i.symbol)}"></div>${i.price_action && i.price_action.pattern ? explain(`${PA.structure[i.price_action.structure] || ""} Last candle: ${pretty(i.price_action.pattern)}, closed ${(i.price_action.close_location * 100).toFixed(0)}% up its range on ${isNum(i.price_action.volume_vs_avg) ? i.price_action.volume_vs_avg.toFixed(1) + "× average volume" : "unknown volume"}.`) : ""}
        <div class="legend"><span><i class="k1"></i>SMA 20</span><span><i class="k2"></i>SMA 50</span><span>dashed lines: prior high / low, pivot</span></div>
        <div class="grid c2" style="margin-top:12px">
          <dl class="kv"><dt>${term("sma", "SMA 20 / 50 / 200")}</dt><dd>${b(t.above_sma20)} / ${b(t.above_sma50)} / ${b(t.above_sma200)}</dd><dt>${term("rsi", "RSI 14")}</dt><dd>${fnum(t.rsi14, 1)}</dd><dt>${term("atr", "ATR 14")}</dt><dd>${fnum(t.atr14)} (${fpct(t.atr_pct, 2, false)})</dd></dl>
          <dl class="kv"><dt>5d / 1m / 3m</dt><dd><span class="${cls(t.ret_5d)}">${fpct(t.ret_5d, 1)}</span> / <span class="${cls(t.ret_1m)}">${fpct(t.ret_1m, 1)}</span> / <span class="${cls(t.ret_3m)}">${fpct(t.ret_3m, 1)}</span></dd><dt>From 52w high</dt><dd class="${cls(t.pct_from_hi52)}">${fpct(t.pct_from_hi52, 1)}</dd><dt>52w range position</dt><dd>${isNum(pos) ? (pos * 100).toFixed(0) + "%" : "–"}</dd>
          <dt>Prev H / L / C</dt><dd>${fnum(t.prev_high)} / ${fnum(t.prev_low)} / ${fnum(t.prev_close)}</dd><dt>${term("pivot", "Pivot R1 / P / S1")}</dt><dd>${fnum(t.pivots.r1)} / ${fnum(t.pivots.p)} / ${fnum(t.pivots.s1)}</dd><dt>20d high / low</dt><dd>${fnum(t.hi20)} / ${fnum(t.lo20)}</dd></dl>
        </div></div>`;
    }).join("");
    return `<section><h2>The big indexes <span class="muted">S&amp;P 500, Nasdaq 100, Russell 2000, Dow · where price sits versus its ${term("sma", "moving averages")} and yesterday's range</span></h2><div class="grid c2">${cards}</div></section>`;
  }

  function secRates(r) {
    const R = r.rates || {};
    if (!R.curve || !R.curve.length) return `<section><h2>Rates</h2><div class="card muted">Yield curve unavailable.</div></section>`;
    const pts = (key) => R.curve.filter((c) => isNum(c[key])).map((c) => ({ x: Math.log(c.tenor_years * 12 + 1), y: c[key], title: `${c.label} ${c[key].toFixed(2)}%` }));
    const xl = R.curve.map((c) => ({ x: Math.log(c.tenor_years * 12 + 1), text: c.label })).filter((_, i) => i % 2 === 0 || i === R.curve.length - 1);
    const curve = lineChart([{ cls: "l3", points: pts("year_ago") }, { cls: "l2", points: pts("month_ago") }, { cls: "l1", points: pts("today"), dots: true }], { w: 620, h: 220, xlabels: xl, yfmt: (v) => v.toFixed(1) + "%" });
    const sp = R.spreads || {};
    const hist = (s) => ((s && s.history) || []).map((p, i) => ({ x: i, y: p.v }));
    const h2 = hist(sp["2s10s"]), h3 = hist(sp["3m10y"]);
    const n = Math.max(h2.length, 1);
    const lab = (s) => { const H = (s && s.history) || []; return [0, Math.floor(H.length / 2), H.length - 1].filter((i) => H[i]).map((i) => ({ x: i, text: H[i].t.slice(0, 7) })); };
    const spreads = lineChart([{ cls: "l2", points: h3 }, { cls: "l1", points: h2, area: true }], { w: 620, h: 200, xlabels: lab(sp["2s10s"]), yfmt: (v) => v.toFixed(0), zero: true });
    const ten = lineChart([{ cls: "l1", points: (R.ten_year_history || []).map((p, i) => ({ x: i, y: p.v })) }], { w: 620, h: 160, xlabels: [0, Math.floor((R.ten_year_history || []).length / 2), (R.ten_year_history || []).length - 1].filter((i) => (R.ten_year_history || [])[i]).map((i) => ({ x: i, text: R.ten_year_history[i].t.slice(0, 7) })), yfmt: (v) => v.toFixed(2) + "%" });
    const live = (R.live || []).map((y) => `<div class="tile mini"><div class="tile-label">${esc(y.label)} live</div><div class="tile-row"><span class="tile-value">${fnum(y.last, 3)}%</span><span class="delta ${cls(y.change_bp, true)}">${fbp(y.change_bp)}</span></div></div>`).join("");
    const s2 = (sp["2s10s"] || {}).latest, s3 = (sp["3m10y"] || {}).latest;
    return `<section><h2>Interest rates <span class="muted">the ${term("curve", "yield curve")} from FRED as of ${esc(R.as_of || "–")} · live yields from Yahoo</span></h2>
      ${explain(`Higher yields make bonds more attractive than stocks and hurt growth names most. The ${term("spread2s10s", "2s10s spread")} is ${fbp(s2)}: ${isNum(s2) && s2 < 0 ? "inverted, a classic recession warning" : "positive, the normal shape"}. The 10-year moved ${fbp(R.chg_10y_1m_bp)} over the last month.`)}
      <div class="grid c4" style="margin-bottom:12px">${live}
        <div class="tile mini"><div class="tile-label">2s10s spread</div><div class="tile-row"><span class="tile-value ${isNum(s2) && s2 < 0 ? "down" : ""}">${fbp(s2)}</span><span class="muted">3m10y ${fbp(s3)}</span></div></div>
        <div class="tile mini"><div class="tile-label">1-month change</div><div class="tile-row"><span class="muted">2Y</span><span class="delta ${cls(R.chg_2y_1m_bp, true)}">${fbp(R.chg_2y_1m_bp)}</span><span class="muted">10Y</span><span class="delta ${cls(R.chg_10y_1m_bp, true)}">${fbp(R.chg_10y_1m_bp)}</span></div></div>
      </div>
      <div class="grid c2">
        <div class="card"><h3>Treasury curve</h3>${curve}<div class="legend"><span><i class="k1"></i>today</span><span><i class="k2"></i>1 month ago</span><span><i class="k3"></i>1 year ago</span></div></div>
        <div class="card"><h3>Curve spreads, 1 year (bp)</h3>${spreads}<div class="legend"><span><i class="k1"></i>2s10s</span><span><i class="k2"></i>3m10y</span><span class="muted">below zero = inverted</span></div><h3>10-year yield, 1 year</h3>${ten}</div>
      </div></section>`;
  }

  function secFlows(r) {
    const F = r.flows || {}; const B = F.breadth || {};
    const gauges = (F.gauges || []).map((g) => {
      const c = cls(g.chg_5d, g.key === "vixterm");
      return `<div class="tile mini"><div class="tile-label">${esc(g.label)}</div><div class="tile-row"><span class="tile-value">${fnum(g.value, g.value < 2 ? 3 : 2)}</span><span class="delta ${cls(g.chg_1d, g.key === "vixterm")}">${fpct(g.chg_1d)}</span></div>${spark(g.spark, c)}<div class="meta2">5d <span class="${cls(g.chg_5d, g.key === "vixterm")}">${fpct(g.chg_5d, 1)}</span> · 1m <span class="${cls(g.chg_1m, g.key === "vixterm")}">${fpct(g.chg_1m, 1)}</span><br>↑ = ${esc(g.up_means)}</div></div>`;
    }).join("");
    const bl = (label, v, n, colour) => `<div class="brd"><span class="muted">${label}</span><span class="bar"><span class="bar-fill ${colour || ""}" style="width:${n ? (v / n * 100).toFixed(0) : 0}%"></span></span><span class="num">${n ? (v / n * 100).toFixed(0) : 0}% <span class="muted">(${v})</span></span></div>`;
    const breadth = `<div class="card"><h3>${term("breadth", "Breadth")}: how many of ${B.n || 0} stocks are joining in</h3>
      ${bl("> SMA 20", B.above20, B.n)}${bl("> SMA 50", B.above50, B.n)}${bl("> SMA 200", B.above200, B.n)}
      ${bl("Advancing", B.adv, B.n, "up")}${bl("Declining", B.dec, B.n, "down")}
      <div class="meta2" style="margin-top:6px">20-day highs ${B.new_high_20d} · 20-day lows ${B.new_low_20d} · unchanged ${B.unch}</div></div>`;
    const sectors = (F.sectors || []).map((s) => `<tr><td class="sym"><b>${esc(s.label)}</b> <span class="muted">${esc(s.symbol)}</span></td>
      <td class="num ${cls(s.chg_1d)}">${fpct(s.chg_1d)}</td><td class="num ${cls(s.chg_5d)}">${fpct(s.chg_5d)}</td><td class="num ${cls(s.chg_1m)}">${fpct(s.chg_1m)}</td><td class="num ${cls(s.rel_1m)}">${fpct(s.rel_1m)}</td></tr>`).join("");
    return `<section><h2>Where the money is going <span class="muted">each gauge divides one asset by another; rising means the first is winning · ${term("breadth", "breadth")} · sector returns</span></h2>
      <div class="grid c4" style="margin-bottom:12px">${gauges}</div>
      <div class="grid c2"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Sector ETF</th><th>1D</th><th>5D</th><th>1M</th><th>vs SPY 1M</th></tr></thead><tbody>${sectors}</tbody></table></div>${breadth}</div></section>`;
  }

  function secHeadlines(r) {
    const rows = r.headlines.map((h) => {
      const a = h.ai; const link = h.url ? `<a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.headline)}</a>` : esc(h.headline);
      if (!a) return `<tr><td class="num">–</td><td>–</td><td class="hl">${link}<div class="meta2">${esc(h.source)} · ${timeET(h.published)} ET</div></td></tr>`;
      const d = a.direction.choice, dc = { bullish: "up", bearish: "down" }[d] || "flat";
      return `<tr><td class="num">${bar(a.impact.score, 3, `impact ${a.impact.score.toFixed(2)} of 3`)}<span class="mono">${a.impact.score.toFixed(1)}</span></td>
        <td><span class="pill ${dc}">${arrow({ bullish: 1, bearish: -1 }[d] || 0)} ${d}</span> ${convTag(a.direction.confidence)}</td>
        <td class="hl">${link}<div class="meta2">${esc(h.source)} · ${timeET(h.published)} ET · <span class="tag">${pretty(a.scope.choice)}</span><span class="tag">${pretty(a.theme.choice)}</span>${a.actionable.p >= 0.6 ? ' <span class="tag ok">worth acting on</span>' : ""}</div></td></tr>`;
    }).join("") || '<tr><td colspan="3" class="muted">No headlines in the lookback window.</td></tr>';
    return `<section><h2>News that actually matters <span class="muted">${r.headlines.length} kept · ${r.headlines_dropped} listicles and fluff dropped out of ${r.headlines_judged} judged</span></h2>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Impact</th><th>Lean</th><th>Headline</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  // ---------------------------------------------------------------- stocks
  function stockRows(r) {
    let list = r.stocks.slice();
    const tab = subTab.stock || stockTab;
    if (tab === "day") list = list.filter((s) => s.tags.includes("day"));
    if (tab === "swing") list = list.filter((s) => s.tags.includes("swing"));
    if (tab === "large") list = list.filter((s) => isNum((s.fundamentals || {}).market_cap) && s.fundamentals.market_cap >= 10e9);
    if (tab === "small") list = list.filter((s) => isNum((s.fundamentals || {}).market_cap) && s.fundamentals.market_cap < 2e9);
    if (tab === "gappers") list = list.filter((s) => s.is_gapper);
    if (tab === "watchlist") list = list.filter((s) => isWatched(s.ticker));
    const keyf = { score: (s) => Math.max(s.scores.day, s.scores.swing), day: (s) => s.scores.day, swing: (s) => s.scores.swing, atr: (s) => s.technicals.atr_pct || 0, chg: (s) => Math.abs(s.chg_pct || 0), rvol: (s) => s.rel_volume || 0 }[sortKey];
    list.sort((a, b) => keyf(b) - keyf(a));
    return list;
  }

  function tagHtml(t) {
    const m = { gapper: ["acc", "gapper"], watchlist: ["acc", "watchlist"], day: ["ok", "day trade"], swing: ["ok", "swing"], event_risk: ["warn", "event risk"], extended: ["bad", "extended"], heavy_options: ["acc", "heavy options"] }[t] || ["", t];
    return `<span class="tag ${m[0]}">${m[1]}</span>`;
  }

  function secStocks(r) {
    const tabs = "";
    const th = (k, l) => `<th class="sortable ${sortKey === k ? "active" : ""}" data-sort="${k}">${l}${sortKey === k ? " ▾" : ""}</th>`;
    const list = stockRows(r);
    if (!list.some((s) => s.ticker === selectedTicker)) selectedTicker = list.length ? list[0].ticker : null;   // the detail always belongs to the group on screen
    const rows = list.map((s) => {
      const a = s.ai || {}, t = s.technicals, c = cls(s.chg_pct);
      const bias = a.bias ? `<span class="pill ${{ long: "up", short: "down" }[a.bias.choice] || "flat"}">${a.bias.choice}</span>` : '<span class="muted">–</span>';
      return `<tr class="clickable ${selectedTicker === s.ticker ? "selected" : ""}" data-ticker="${esc(s.ticker)}">
        <td class="sym"><b>${esc(s.ticker)}</b><div class="meta2">${esc(s.name)}</div></td>
        <td class="num">${priceHtml(s.ticker, s)}</td>
        <td>${(() => { const v = readFor(s); return v ? `<span class="pill ${v.cls}">${v.word}</span> ${convTag(v.conviction)}` : bias; })()}<div class="meta2">${a.setup ? pretty(a.setup.choice) : ""}</div></td>
        <td class="num sc2"><span title="Swing score">S <b>${(s.scores.swing * 100).toFixed(0)}</b></span><span title="Day score">D <b>${(s.scores.day * 100).toFixed(0)}</b></span><div class="meta2">${fpct(t.atr_pct, 1, false)}/day${isNum(s.rel_volume) ? " · " + s.rel_volume.toFixed(1) + "× vol" : ""}</div></td></tr>`;
    }).join("") || `<tr><td colspan="4" class="muted">Nothing in this group right now. Pick another group in the left menu.</td></tr>`;
    const sel = list.find((s) => s.ticker === selectedTicker);
    const tabName = (SUBTABS.stock.find(([k]) => k === (subTab.stock || "all")) || ["", "All names"])[1];
    return `<section><h2>Stocks · ${esc(tabName)} <span class="muted">${stockRows(r).length} of ${r.stocks.length} analysed names (${r.stocks_scanned} liquid stocks scanned) · pick a group in the left menu · click a row for the full breakdown</span></h2>
      ${subTabs("stock")}
      <div class="tbl-wrap"><table class="tbl stk-list" id="stocks-tbl"><thead><tr><th>Stock</th>${th("chg", "Price")}<th>Read · ${HZ_NAME[horizon].toLowerCase()}</th>${th("swing", "Swing · Day")}</tr></thead><tbody>${rows}</tbody></table></div>
      <div id="stock-detail" class="detail">${sel ? stockDetail(sel, r) : '<div class="card muted">Nothing to show for this group. Pick another group in the left menu.</div>'}</div></section>`;
  }

  const probRows = (obj) => `<div class="tile-sub">${convTag(obj && isNum(obj.confidence) ? obj.confidence : 0)}</div>`;   // conviction word instead of a probability table

  function stockDetail(s, r) {
    const t = s.technicals, f = s.fundamentals, a = s.ai, c = cls(s.chg_pct);
    const b = (v) => (v == null ? "–" : v ? '<span class="up">above</span>' : '<span class="down">below</span>');
    const dayL = { 0: "too quiet / thin", 1: "ordinary", 2: "in play", 3: "prime" }, swingL = { 0: "no edge", 1: "marginal", 2: "reasonable", 3: "high quality" };
    const judg = a ? `<div class="judg">
        <div class="tile"><div class="tile-label">Lean, next 1–5 days</div><div class="tile-value small ${{ long: "up", short: "down" }[a.bias.choice] || "flat"}">${a.bias.choice}</div>${explain(EX.bias[a.bias.choice])}${probRows(a.bias)}</div>
        <div class="tile"><div class="tile-label">Chart setup</div><div class="tile-value small">${pretty(a.setup.choice)}</div>${explain(EX.setup[a.setup.choice] || "")}${probRows(a.setup)}</div>
        <div class="tile"><div class="tile-label">Day-trade fit</div><div class="tile-value small">${a.day_trade_fit.score.toFixed(1)} / 3 · ${dayL[Math.round(a.day_trade_fit.score)]}</div>${explain(EX.day[Math.round(a.day_trade_fit.score)])}${probRows(a.day_trade_fit, dayL)}</div>
        <div class="tile"><div class="tile-label">Swing fit</div><div class="tile-value small">${a.swing_fit.score.toFixed(1)} / 3 · ${swingL[Math.round(a.swing_fit.score)]}</div>${explain(EX.swing[Math.round(a.swing_fit.score)])}${probRows(a.swing_fit, swingL)}</div>
        <div class="tile"><div class="tile-label">Why it's moving</div><div class="tile-value small">${pretty(a.catalyst.choice)}</div>${explain(EX.catalyst[a.catalyst.choice] || "")}${probRows(a.catalyst)}</div>
        <div class="tile"><div class="tile-label">Watch out for</div><div class="tile-sub" style="margin-top:2px"><span class="tag ${a.event_risk.p >= 0.6 ? "warn" : ""}">${a.event_risk.p >= 0.6 ? "event ahead" : "no event this week"}</span><span class="tag ${a.extended.p >= 0.6 ? "bad" : ""}">${a.extended.p >= 0.6 ? "stretched" : "not stretched"}</span></div>
          ${explain(`${a.event_risk.p >= 0.6 ? "Something scheduled (earnings, a decision) could gap this stock against you within a week." : "No scheduled event inside the next week."} ${a.extended.p >= 0.6 ? "It has run far from its averages, so chasing here is risky." : "It is close to its averages, so entries are not chasing."}`)}</div>
      </div>` : '<div class="card muted">Model judgments disabled for this build.</div>';
    const news = s.headlines.length ? s.headlines.slice(0, 6).map((h) => `<li>${h.url ? `<a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.headline)}</a>` : esc(h.headline)} <span class="muted">· ${esc(h.source)} ${timeET(h.published)}</span></li>`).join("") : '<li class="muted">No recent headlines.</li>';
    const pv = t.pivots || {};
    return `<div class="card">
      <div class="detail-head"><b style="font-size:18px">${esc(s.ticker)}</b><span class="muted">${esc(s.name)} · ${esc(s.sector)}${s.industry ? " · " + esc(s.industry) : ""}</span>${priceHtml(s.ticker, s)}<span class="muted">prev close ${fnum(s.prev_close)}</span>${s.tags.map(tagHtml).join("")}</div>
      <div class="detail-grid">
        <div class="col">
          <div><div class="chart tall" data-chart="${esc(s.ticker)}"></div><div class="legend"><span><i class="k1"></i>SMA 20</span><span><i class="k2"></i>SMA 50</span><span>dashed: prior high / low, pivot, 20-day high / low, swing levels</span></div></div>
          ${paTile(s)}
          <div class="tile"><div class="tile-label">Before you take the position</div>${explain("Ten checks a disciplined trader runs before pressing the button. Each line says why it passed or failed.")}${checklistHtml(checklist(s, r), true)}</div>
          ${judg}
        </div>
        <div class="col">
          ${verdictFor(s) ? `<div class="tile"><div class="tile-label">Verdict</div>${verdictBlock(s)}</div>` : ""}
          ${s.scan ? `<div class="tile"><div class="tile-label">Intraday volume scan</div><div class="tile-value small ${s.scan.direction === "up" ? "up" : s.scan.direction === "down" ? "down" : ""}">${s.scan.score.toFixed(0)} / 100 · ${s.scan.lead} ${s.scan.direction}</div><div class="tile-sub">${Object.entries(s.scan.timeframes || {}).map(([k, v]) => `${k}: ${v.vol_ratio_3bar}× vol, ${v.building_bars} rising`).join(" · ")}${isNum(s.scan.rvol_tod) ? ` · ${s.scan.rvol_tod.toFixed(1)}× RVOL by time of day` : ""}${s.scan.above_vwap == null ? "" : s.scan.above_vwap ? " · above VWAP" : " · below VWAP"}</div>${s.scan.read ? explain(SC.read[s.scan.read][2]) : ""}</div>` : ""}
          <div class="tile"><div class="tile-label">Who is buying</div>${whoHtml(s) || '<div class="muted">no smart-money data for this name</div>'}</div>
          <div class="tile"><div class="tile-label">How much it moves</div><dl class="kv"><dt>${term("atr", "ATR 14")}</dt><dd>${fnum(t.atr14)} (${fpct(t.atr_pct, 2, false)})</dd><dt>Realized vol 20d</dt><dd>${fpct(t.rv20, 0, false)}</dd><dt>Prev day range</dt><dd>${fpct(t.prev_range_pct, 1, false)}</dd><dt>${term("beta", "Beta")}</dt><dd>${fnum(f.beta, 2)}</dd><dt>${term("relvol", "Volume vs normal")}</dt><dd>${isNum(s.rel_volume) ? s.rel_volume.toFixed(2) + "×" : "n/a"}</dd><dt>Avg $ volume</dt><dd>${fcap(s.avg_dollar_volume)}</dd><dt>Volatility rank</dt><dd>#${s.volatility_rank} / ${s.volatility_universe}</dd></dl></div>
          <div class="tile"><div class="tile-label">Trend and key levels</div><dl class="kv"><dt>Trend</dt><dd class="${{ up: "up", down: "down" }[t.trend] || "flat"}">${t.trend}</dd><dt>${term("sma", "SMA 20 / 50 / 200")}</dt><dd>${b(t.above_sma20)} / ${b(t.above_sma50)} / ${b(t.above_sma200)}</dd><dt>Distance from SMA 20</dt><dd class="${cls(t.dist_sma20_pct)}">${fpct(t.dist_sma20_pct, 1)}</dd><dt>${term("rsi", "RSI 14")}</dt><dd>${fnum(t.rsi14, 1)}</dd><dt>5d / 1m / 3m return</dt><dd><span class="${cls(t.ret_5d)}">${fpct(t.ret_5d, 1)}</span> / <span class="${cls(t.ret_1m)}">${fpct(t.ret_1m, 1)}</span> / <span class="${cls(t.ret_3m)}">${fpct(t.ret_3m, 1)}</span></dd><dt>From 52w high / low</dt><dd>${fpct(t.pct_from_hi52, 1)} / ${fpct(t.pct_from_lo52, 1)}</dd><dt>Prev H / L</dt><dd>${fnum(t.prev_high)} / ${fnum(t.prev_low)}</dd><dt>${term("pivot", "Pivot R1 / P / S1")}</dt><dd>${fnum(pv.r1)} / ${fnum(pv.p)} / ${fnum(pv.s1)}</dd><dt>20d high / low</dt><dd>${fnum(t.hi20)} / ${fnum(t.lo20)}</dd></dl></div>
          <div class="tile"><div class="tile-label">The business${["forward_pe", "ps", "rev_growth"].every((k) => !isNum(f[k])) ? ' <span class="tag warn">data feed empty this build</span>' : f.profile_stale ? ` <span class="tag">as of ${new Date(f.profile_as_of * 1000).toLocaleDateString()}</span>` : ""}</div><dl class="kv"><dt>Market cap</dt><dd>${fcap(f.market_cap)}</dd><dt>P/E trailing / fwd</dt><dd>${fnum(f.trailing_pe, 1)} / ${fnum(f.forward_pe, 1)}</dd><dt>P/S</dt><dd>${fnum(f.ps, 1)}</dd><dt>Revenue growth</dt><dd class="${cls(f.rev_growth)}">${isNum(f.rev_growth) ? fpct(f.rev_growth * 100, 1) : "–"}</dd><dt>EPS growth</dt><dd class="${cls(f.eps_growth)}">${isNum(f.eps_growth) ? fpct(f.eps_growth * 100, 1) : "–"}</dd><dt>Profit margin</dt><dd>${isNum(f.margins) ? fpct(f.margins * 100, 1, false) : "–"}</dd><dt>${term("shortfloat", "Short % float")}</dt><dd class="${isNum(f.short_float) && f.short_float > 0.15 ? "warn" : ""}">${isNum(f.short_float) ? fpct(f.short_float * 100, 1, false) : "–"}</dd><dt>Analysts / target</dt><dd>${pretty(f.analyst) || "–"} / ${fnum(f.target)}</dd><dt>Next earnings</dt><dd class="${isNum(f.days_to_earnings) && f.days_to_earnings >= 0 && f.days_to_earnings <= 7 ? "warn" : ""}">${f.next_earnings || "–"}${isNum(f.days_to_earnings) ? ` (${f.days_to_earnings}d)` : ""}</dd></dl></div>
          <div class="tile"><div class="tile-label">What people are saying</div><ul style="margin:6px 0 0;padding-left:18px;font-size:12.5px">${news}</ul></div>
        </div></div></div>`;
  }

  function paTile(s) {
    const pa = s.price_action || {}, a = s.ai || {};
    if (!pa.pattern) return "";
    const ctrl = a.price_action ? `<div class="tile-value small">${pretty(a.price_action.choice)}</div>${explain(PA.control[a.price_action.choice] || "")}` : "";
    const entry = a.entry_quality ? `<div class="wc-scores" style="margin-top:6px"><span>Entry quality ${bar(a.entry_quality.score, 3)}<b class="mono">${a.entry_quality.score.toFixed(1)}/3</b> · ${PA.entry[Math.round(a.entry_quality.score)]}</span></div>` : "";
    const sh = (pa.swing_highs || []).map((p) => fnum(p.v)).join(" → "), sl = (pa.swing_lows || []).map((p) => fnum(p.v)).join(" → ");
    return `<div class="tile"><div class="tile-label">Price action · who is in control</div>${ctrl}${entry}
      <div class="grid c2" style="margin-top:10px">
        <dl class="kv"><dt>${term("candle", "Last candle")}</dt><dd>${pretty(pa.pattern)}</dd><dt>${term("closeloc", "Closed")}</dt><dd>${isNum(pa.close_location) ? (pa.close_location * 100).toFixed(0) + "% up its range" : "–"}</dd><dt>Body</dt><dd>${isNum(pa.body_pct) ? (pa.body_pct * 100).toFixed(0) + "% of range" : "–"}</dd><dt>Size vs ATR</dt><dd>${isNum(pa.range_vs_atr) ? pa.range_vs_atr.toFixed(2) + "×" : "–"}</dd><dt>Volume vs 20d avg</dt><dd>${isNum(pa.volume_vs_avg) ? pa.volume_vs_avg.toFixed(2) + "×" : "–"}</dd><dt>Streak</dt><dd>${isNum(pa.streak_days) ? `${Math.abs(pa.streak_days)} ${pa.streak_days > 0 ? "up" : pa.streak_days < 0 ? "down" : ""} day${Math.abs(pa.streak_days) === 1 ? "" : "s"}` : "–"}</dd><dt>Opened</dt><dd>${fpct(pa.gap_open_pct)} vs prior close</dd></dl>
        <dl class="kv"><dt>${term("structure", "Structure")}</dt><dd>${pretty(pa.structure)}</dd><dt>${term("swinglvl", "Swing highs")}</dt><dd>${sh || "–"}</dd><dt>${term("swinglvl", "Swing lows")}</dt><dd>${sl || "–"}</dd><dt>Nearest resistance</dt><dd>${fnum(pa.nearest_resistance)}</dd><dt>Nearest support</dt><dd>${fnum(pa.nearest_support)}</dd><dt>Broke last swing high</dt><dd class="${pa.broke_last_swing_high ? "up" : ""}">${pa.broke_last_swing_high ? "yes" : "no"}</dd><dt>Broke last swing low</dt><dd class="${pa.broke_last_swing_low ? "down" : ""}">${pa.broke_last_swing_low ? "yes" : "no"}</dd></dl>
      </div>${explain(`${esc(pa.pattern_read || "")}. ${PA.structure[pa.structure] || ""}`)}</div>`;
  }

  function secCalendar(r) {
    const rows = r.calendar.map((c) => `<tr class="${c.relevance >= 2 ? "hi" : ""}"><td class="mono">${esc(c.time_et)}</td><td><span class="tag">${esc(c.country)}</span></td><td>${esc(c.title)}</td><td class="num">${bar(c.relevance, 3)}<span class="mono">${c.relevance.toFixed(1)}</span></td><td class="mono">${esc(c.forecast) || "–"}</td><td class="mono">${esc(c.previous) || "–"}</td></tr>`).join("") || '<tr><td colspan="6" class="muted">No relevant scheduled events.</td></tr>';
    return `<section><h2>Today's economic events <span class="muted">${esc(r.session_label)} · times ET · relevance for US stocks judged by the model · highlighted rows can move the whole market</span></h2><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Ccy</th><th>Event</th><th>Relevance</th><th>Forecast</th><th>Previous</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  function secEarnings(r) {
    const rows = r.earnings.map((e) => `<tr class="${e.attention >= 2 ? "hi" : ""}"><td class="sym"><b>${esc(e.symbol)}</b><div class="meta2">${esc(e.name)}</div></td><td>${esc(e.report_time)}</td><td class="num">${fcap(e.market_cap)}</td><td class="mono">${esc(e.eps_forecast) || "–"}<div class="meta2">yr ago ${esc(e.last_year_eps) || "–"}</div></td><td class="num">${bar(e.attention, 3)}<span class="mono">${e.attention.toFixed(1)}</span></td><td>${e.ai ? `<span class="tag">${pretty(e.ai.read_through.choice)}</span>` : "–"}</td></tr>`).join("") || '<tr><td colspan="6" class="muted">No earnings.</td></tr>';
    return `<section><h2>Companies reporting earnings <span class="muted">${r.earnings.length} shown of ${r.earnings_total} reporting · attention score says how many traders will care</span></h2><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Company</th><th>When</th><th>Mkt cap</th><th>EPS est.</th><th>Attention</th><th>Read-through</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  // ---------------------------------------------------------------- render

  // ---------------------------------------------------------------- watchlists (dynamic)
  function loadLists() { try { const j = JSON.parse(localStorage.getItem(LISTS_KEY)); if (j && j.lists && j.active in j.lists) return j; } catch (e) {} return null; }
  function ensureLists(r) {
    if (lists) return;
    const P = user && user.profile;
    if (P && P.lists && Object.keys(P.lists).length) { lists = { active: P.active in P.lists ? P.active : Object.keys(P.lists)[0], lists: Object.fromEntries(Object.entries(P.lists).map(([k, v]) => [k, v.slice()])) }; return; }
    const fromProfile = P && Array.isArray(P.tickers) && P.tickers.length ? P.tickers.slice() : null;
    const saved = loadLists();
    if (!fromProfile && saved && saved.lists && Object.keys(saved.lists).length) { lists = saved; if (!(lists.active in lists.lists)) lists.active = Object.keys(lists.lists)[0]; return; }
    const tickers = fromProfile || (r.default_watchlist || r.watchlist || []).slice(0, 7);
    lists = { active: "My watchlist", lists: { "My watchlist": tickers } };
  }
  function newList() {
    const bar = $("#list-new"); if (!bar) return;
    bar.hidden = false; const inp = bar.querySelector("input"); inp.value = ""; inp.focus();
  }
  function createList(name) {
    const n = (name || "").trim().slice(0, 30); if (!n || lists.lists[n]) return;
    lists.lists[n] = []; lists.active = n; saveLists(); renderAll();
  }
  function renameList(name) {
    const n = (name || "").trim().slice(0, 30); if (!n || n === lists.active || lists.lists[n]) return;
    const out = {}; Object.entries(lists.lists).forEach(([k, v]) => { out[k === lists.active ? n : k] = v; }); lists.lists = out; lists.active = n; saveLists(); renderAll();
  }
  function deleteList() {
    const names = Object.keys(lists.lists); if (names.length <= 1) { notice("You need at least one list. Create another before deleting this one.", true); return; }
    if (!confirm(`Delete the list "${lists.active}" and its ${lists.lists[lists.active].length} names?`)) return;
    delete lists.lists[lists.active]; lists.active = Object.keys(lists.lists)[0]; saveLists(); renderAll();
  }
  let profileTimer = null;
  function saveLists() {
    try { localStorage.setItem(LISTS_KEY, JSON.stringify(lists)); } catch (e) {}
    syncServerWatchlist();
    if (!STATIC_MODE && user && user.profile) {           // every list lives with the account, so they follow the user to any browser
      user.profile.tickers = activeList().slice(); user.profile.lists = Object.fromEntries(Object.entries(lists.lists).map(([k, v]) => [k, v.slice()])); user.profile.active = lists.active;
      clearTimeout(profileTimer);
      profileTimer = setTimeout(() => api("/api/profile/tickers", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lists: lists.lists, active: lists.active }) }).catch(() => {}), 600);
    } else if (STATIC_MODE && user) { user.profile = Object.assign({}, user.profile, { tickers: activeList().slice() }); try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch (e) {} }
  }
  const activeList = () => (lists && lists.lists[lists.active]) || [];
  const isWatched = (t) => activeList().includes(t);
  const stockFor = (t) => report && report.stocks.find((s) => s.ticker === t);
  let syncTimer = null;
  function syncServerWatchlist() {
    if (STATIC_MODE) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { const all = [...new Set(Object.values(lists.lists).flat())]; api("/api/watchlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tickers: all }) }).catch(() => {}); }, 800);
  }
  function addTicker(t) {
    t = (t || "").toUpperCase().trim(); if (!t || !report) return;
    ensureLists(report);
    const l = lists.lists[lists.active];
    if (!l.includes(t)) { l.push(t); saveLists(); }
    wlSel = t; if (wlFilter !== "all") { wlFilter = "all"; saveWlUi(); }      // the new name is selected and visible straight away
    if (!stockFor(t) && !STATIC_MODE) requestAnalysis(t);
    closeSearch(); if (currentView !== "home" && currentView !== "watch") switchView("watch"); else renderAll();
  }
  function removeTicker(t) {
    const l = lists.lists[lists.active]; const i = l.indexOf(t); if (i < 0) return;
    l.splice(i, 1); saveLists();
    if (currentView === "ticker" && tickerSel === t) { currentView = "home"; try { history.replaceState(null, "", "#view=home"); } catch (e) {} }
    renderAll();
  }
  function openTicker(t) {
    tickerSel = t; currentView = "ticker"; try { history.replaceState(null, "", "#view=ticker&t=" + encodeURIComponent(t)); } catch (e) {}
    if (report && !stockFor(t) && !STATIC_MODE) requestAnalysis(t);
    if (report) renderAll();
    const m = $("main"); if (m) m.scrollTop = 0;
  }
  async function requestAnalysis(t, attempt = 0) {
    if (analyzing.has(t) && attempt === 0) return;
    analyzing.add(t); delete analyzeError[t];
    try {
      const res = await api(`/api/stock/${encodeURIComponent(t)}`, { cache: "no-store" });
      if (res.status === 202) { if (attempt < 30) setTimeout(() => requestAnalysis(t, attempt + 1), 5000); return; }
      const j = await res.json();
      if (!res.ok) throw new Error(j.detail || res.statusText);
      const rec = j.stock; rec.on_watchlist = true; rec.adhoc = j.source === "adhoc";
      const i = report.stocks.findIndex((s) => s.ticker === t);
      if (i >= 0) report.stocks[i] = rec; else report.stocks.push(rec);
      analyzing.delete(t);
    } catch (e) { analyzing.delete(t); analyzeError[t] = e.message || "failed"; }
    if (currentView === "home" || currentView === "stock") renderAll();
  }
  function refreshAdhoc() {                        // after a new report: names the build did not cover get re-analysed on this build
    if (STATIC_MODE || !lists) return;
    [...new Set(Object.values(lists.lists).flat())].forEach((t) => { const s = stockFor(t); if (!s || s.adhoc) requestAnalysis(t); });
  }

  // ---------------------------------------------------------------- ticker search (menu bar)
  function symbolEntries(r) {
    const m = new Map();
    Object.entries(r.lite || {}).forEach(([t, q]) => m.set(t, [t, q.name, q.kind, ""]));
    r.stocks.forEach((s) => m.set(s.ticker, [s.ticker, s.name, s.kind || "Stock", ""]));
    return m;
  }
  async function loadSymbols() {
    if (symbolIndex || symbolLoading) return; symbolLoading = true;
    try {
      const emb = document.getElementById("symbols-data");
      if (emb) symbolIndex = JSON.parse(emb.textContent);
      else { const res = await (API ? api("/symbols.json") : fetch("./symbols.json")); if (res.ok) symbolIndex = await res.json(); }
    } catch (e) { /* search still works over the report's own names */ } finally { symbolLoading = false; }
    if (symbolIndex && document.activeElement === $("#search")) renderSearch();
  }
  function searchSymbols(q) {
    q = q.trim().toUpperCase(); if (!q || !report) return [];
    const seen = new Set(), out = [];
    const test = (row) => { const sym = row[0], name = (row[1] || "").toUpperCase(); if (sym === q) return 0; if (sym.startsWith(q)) return 1; if (name.startsWith(q)) return 2; if (name.split(/[\s,.\-&]+/).some((w) => w.startsWith(q))) return 3; if (q.length >= 3 && name.includes(q)) return 4; return -1; };
    const consider = (row, bonus) => { const k = test(row); if (k < 0 || seen.has(row[0])) return; seen.add(row[0]); out.push({ row, rank: k + bonus }); };
    symbolEntries(report).forEach((row) => consider(row, -0.25));
    (symbolIndex || []).forEach((row) => consider(row, 0));
    return out.sort((a, b) => a.rank - b.rank || a.row[0].length - b.row[0].length || a.row[0].localeCompare(b.row[0])).slice(0, 12).map((x) => x.row);
  }
  function searchState(t) {
    if (isWatched(t)) return ["in this list", "ok"];
    if (stockFor(t)) return ["full analysis ready", "ok"];
    if (report.lite && report.lite[t]) return ["quote + technicals", ""];
    return STATIC_MODE ? ["not in this build", "dim"] : ["analysed on add", ""];
  }
  function renderSearch() {
    const box = $("#search-results"), q = $("#search").value;
    searchRows = searchSymbols(q);
    if (!q.trim()) { box.hidden = true; return; }
    searchSel = Math.min(searchSel, Math.max(0, searchRows.length - 1));
    box.innerHTML = searchRows.length ? searchRows.map((row, i) => { const [st, cl] = searchState(row[0]); return `<button class="sr ${i === searchSel ? "sel" : ""}" data-add="${esc(row[0])}"><b>${esc(row[0])}</b><span class="sr-name">${esc(row[1] || "")}</span><span class="tag ${row[2] === "ETF" ? "acc" : ""}">${esc(row[2] || "Stock")}</span><span class="sr-state ${cl}">${row[3] ? esc(row[3]) + " · " : ""}${st}</span></button>`; }).join("")
      : `<div class="sr-empty">${symbolIndex ? "No match. Try the ticker symbol." : "Loading the symbol directory…"}</div>`;
    box.hidden = false;
    box.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("mousedown", (e) => { e.preventDefault(); addTicker(b.getAttribute("data-add")); }));
  }
  function closeSearch() { const i = $("#search"); if (i) { i.value = ""; i.blur(); } const b = $("#search-results"); if (b) b.hidden = true; searchSel = 0; }
  function wireSearch() {
    const input = $("#search"); if (!input || input.dataset.wired) return; input.dataset.wired = "1";
    input.addEventListener("focus", () => { loadSymbols(); renderSearch(); });
    input.addEventListener("input", () => { searchSel = 0; renderSearch(); });
    input.addEventListener("blur", () => setTimeout(() => { const b = $("#search-results"); if (b) b.hidden = true; }, 150));
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); searchSel = Math.min(searchRows.length - 1, searchSel + 1); renderSearch(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); searchSel = Math.max(0, searchSel - 1); renderSearch(); }
      else if (e.key === "Enter" || e.key === "Return" || e.keyCode === 13) { e.preventDefault(); const row = searchRows[searchSel] || (input.value.trim() && [input.value.trim().toUpperCase()]); if (row) addTicker(row[0]); }
      else if (e.key === "Escape") { closeSearch(); }
    });
  }

  // ---------------------------------------------------------------- lite / pending cards
  function liteCard(t, q, r) {
    const tech = q.technicals || {}, c = cls(q.chg_pct), sc = q.scan;
    const sub = STATIC_MODE ? "quote and daily technicals · the hourly build runs the full model read only for names in watchlist.txt"
      : analyzing.has(t) ? "analysing: technicals, smart money, options and the model verdict · about 20 seconds" : analyzeError[t] ? `analysis failed: ${esc(analyzeError[t])}` : "quote and daily technicals · press Analyze for the full read";
    return `<article class="wcard lite" data-ticker="${esc(t)}">
      <div class="wc-head"><div><span class="wc-ticker">${esc(t)}</span><span class="wc-name">${esc(q.name || "")}</span> <span class="tag ${q.kind === "ETF" ? "acc" : ""}">${esc(q.kind || "Stock")}</span></div><div class="wc-price">${priceHtml(t, q)}<button class="wc-x" data-remove="${esc(t)}" title="Remove from this list">×</button></div></div>
      ${q.kind === "ETF" ? verdictBlock({ ...q, ticker: t }, { noWhy: true }) : ""}
      <div class="wc-lean"><span class="lean flat">${analyzing.has(t) ? "WORKING" : "QUOTE"}</span><span class="wc-leansub" style="text-transform:none">${sub}</span></div>
      <dl class="kv lite-kv"><dt>Trend</dt><dd class="${{ up: "up", down: "down" }[tech.trend] || "flat"}">${tech.trend || "–"}</dd><dt>${term("rsi", "RSI 14")}</dt><dd>${fnum(tech.rsi14, 0)}</dd><dt>Moves a day</dt><dd>${fpct(tech.atr_pct, 1, false)}</dd><dt>vs 20-day avg</dt><dd class="${cls(tech.dist_sma20_pct)}">${fpct(tech.dist_sma20_pct, 1)}</dd><dt>1m / 3m</dt><dd><span class="${cls(tech.ret_1m)}">${fpct(tech.ret_1m, 1)}</span> / <span class="${cls(tech.ret_3m)}">${fpct(tech.ret_3m, 1)}</span></dd><dt>${term("relvol", "Volume vs normal")}</dt><dd>${isNum(q.rel_volume) ? q.rel_volume.toFixed(2) + "×" : "n/a"}</dd>${sc ? `<dt>Volume scan</dt><dd class="${sc.direction === "up" ? "up" : sc.direction === "down" ? "down" : ""}">${sc.score}/100 · ${sc.lead} ${sc.direction}</dd>` : ""}</dl>
      <div class="wc-actions">${STATIC_MODE ? "" : `<button class="btn sm" data-analyze="${esc(t)}" ${analyzing.has(t) ? "disabled" : ""}>${analyzing.has(t) ? "Analysing…" : "Analyze"}</button>`}<a class="btn sm ghost" href="${tvLink(t)}" target="_blank" rel="noopener">Open chart</a></div>
    </article>`;
  }
  function pendingCard(t) {
    const msg = STATIC_MODE ? "Not in this build's data. The hourly build quotes about 250 names and fully analyses the ones in watchlist.txt; other tickers show here once you run the server locally."
      : analyzing.has(t) ? "Fetching a year of history, news, smart money and options, then asking the model. About 20 seconds." : analyzeError[t] ? `Analysis failed: ${esc(analyzeError[t])}.` : "Not analysed yet.";
    return `<article class="wcard lite pending" data-ticker="${esc(t)}">
      <div class="wc-head"><div><span class="wc-ticker">${esc(t)}</span></div><div class="wc-price"><button class="wc-x" data-remove="${esc(t)}" title="Remove from this list">×</button></div></div>
      <div class="wc-lean"><span class="lean flat">${analyzing.has(t) ? "WORKING" : "NO DATA"}</span><span class="wc-leansub" style="text-transform:none">${msg}</span></div>
      <div class="wc-actions">${STATIC_MODE ? "" : `<button class="btn sm" data-analyze="${esc(t)}" ${analyzing.has(t) ? "disabled" : ""}>${analyzing.has(t) ? "Analysing…" : "Analyze"}</button>`}<a class="btn sm ghost" href="${tvLink(t)}" target="_blank" rel="noopener">Open chart</a></div>
    </article>`;
  }
  // ---------------------------------------------------------------- volume scanner + low float
  const SC = {
    read: { breakout_with_volume: ["Breakout on volume", "up", "Price is clearing its recent range on rising volume and closing near the highs of its bars: buyers are pressing."],
            building_toward_breakout: ["Building toward breakout", "up2", "Volume is rising bar over bar while price holds near the highs or above VWAP. No clean break yet."],
            climax_or_exhaustion: ["Climax / exhaustion", "flat", "A huge volume spike after a big move, with the bar closing well off its extreme. The move may be ending."],
            selling_with_volume: ["Selling on volume", "down", "The range is breaking down on heavy volume with price below VWAP and closing near the lows: sellers are in control."],
            pullback_on_lighter_volume: ["Pullback, lighter volume", "flat", "Price is easing back toward VWAP on volume lighter than the impulse bars. Constructive if the trend is up."],
            noise: ["Noise", "flat", "Volume is up but price is going nowhere. No confirmation from VWAP or the range."] },
    cont: ["poor", "below even", "decent", "strong"],
    play: { long_breakout: "Buy strength through the range high, stop under the breakout bar.", buy_pullback_to_vwap: "Wait for a dip to VWAP or the old range top and buy the hold.", short_pop: "Fade a spike into resistance after an exhaustion bar, stop above the high.", short_breakdown: "Short the break of the range low, stop above the breakdown bar.", no_trade: "Nothing clean here." },
    playCls: { long_breakout: "up", buy_pullback_to_vwap: "up2", short_pop: "down", short_breakdown: "down", no_trade: "flat" },
  };
  const LF = {
    state: { squeeze_in_progress: ["Squeeze in progress", "up", "Heavy short interest, the float rotating and price holding near the highs: shorts are being forced out."],
             momentum_run: ["Momentum run", "up2", "The float is turning over on a big up move with volume still rising; shorts are not the main driver."],
             fading_after_spike: ["Fading after spike", "flat", "The big volume is spent and price is well off the high or below VWAP: the run is being sold."],
             selling_pressure: ["Selling pressure", "down", "Down hard on heavy volume near the low of the day: distribution or dilution being absorbed."],
             quiet_low_float: ["Quiet", "flat", "Volume is elevated but the move is modest. A name to watch, not a move yet."] },
    risk: ["ordinary", "elevated", "high", "extreme"],
    play: { long_momentum: "Buy the next VWAP hold or consolidation break while volume keeps rising.", wait_for_pullback: "Let it base; buy only a higher low with volume returning.", short_the_fade: "Short a failed retest of the high after the climax, hard stop.", avoid: "Too extended or too thin; halts and reversals are likely." },
    playCls: { long_momentum: "up", wait_for_pullback: "up2", short_the_fade: "down", avoid: "down" },
  };
  const sessionLabel = (r, S) => (S.market_state === "open" ? "live · bars to " + (S.last_bar || "").slice(11, 16) + " ET" : `last session ${S.as_of || ""} · ${S.market_state === "pre" ? "pre-market, waiting for the open" : "market closed"}`);
  async function pollLiveScan() {
    if (STATIC_MODE || !report) return;
    try {
      const res = await api("/api/scan/live", { cache: "no-store" });
      if (res.status === 202) return;
      const j = await res.json(); liveScan = j; liveScan.received = Date.now();
      applyLiveQuotes(j); refreshQuotes();
      if (currentView === "scan" && subTab.scan === "scanner") { const sec = $(".sc-section"); if (sec) { const tmp = document.createElement("div"); tmp.innerHTML = secScan(report); sec.replaceWith(tmp.firstElementChild); wireStocks(); } }
      if (currentView === "home") { const bm = $(".bigmoney"); if (bm) { const tmp = document.createElement("div"); tmp.innerHTML = secBigMoney(report); bm.replaceWith(tmp.firstElementChild); wireStocks(); } }
    } catch (e) { /* server restarting */ }
  }
  function liveCountdown() {
    const el = $("#sc-next"); if (!el || !liveScan) return;
    const left = Math.max(0, Math.round((liveScan.next_in_s || 60) - (Date.now() - liveScan.received) / 1000));
    el.textContent = `next scan in ${left}s`;
  }
  function secScan(r) {
    const live = !STATIC_MODE && liveScan && liveScan.rows;
    const S = live ? liveScan : r.scan; if (!S) return `<section class="sc-section"><h2>Volume scanner</h2><div class="muted">No scan this build.</div></section>`;
    const tfs = ["15m", "30m", "1h", "2h"].filter((k) => (S.rows[0] && S.rows[0].timeframes && S.rows[0].timeframes[k]) || (S.settings && (S.settings.timeframes || []).includes(k)));
    let rows = S.rows.filter((x) => x.qualifies !== false);
    if (scanTf !== "lead") rows.sort((a, b) => ((b.timeframes[scanTf] || {}).score || 0) - ((a.timeframes[scanTf] || {}).score || 0));
    const lead = (x) => x.lead || x.lead_timeframe;
    const tfCell = (x, k) => { const v = x.timeframes[k]; if (!v) return `<td class="tf"><span class="muted">–</span></td>`;
      const sc = v.score || 0, dir = v.direction || x.direction; return `<td class="tf ${lead(x) === k ? "lead" : ""}"><div class="tf-score ${dir === "up" ? "up" : dir === "down" ? "down" : ""}">${sc.toFixed(0)}</div><div class="tf-bar"><i class="${dir}" style="width:${sc}%"></i></div><div class="tf-meta">${v.vol_ratio_3bar}× <span class="muted">vol</span> · ${v.building_bars}<span class="muted">↑</span> · <span class="${cls(v.chg_3bar_pct)}">${fpct(v.chg_3bar_pct, 1)}</span>${v.breakout ? ' <span class="up">▲brk</span>' : v.breakdown ? ' <span class="down">▼brk</span>' : ""}</div></td>`; };
    const body = rows.slice(0, 30).map((x) => { const a = x.ai || {}, ses = x.session || {}, rd = a.read ? SC.read[a.read.choice] : null, t = x.ticker;
      const vw = x.above_vwap != null ? x.above_vwap : ses.above_vwap, rp = isNum(x.range_pos) ? x.range_pos : ses.range_pos, rv = isNum(x.rvol_tod) ? x.rvol_tod : ses.rvol_time_of_day;
      return `<tr class="clickable sc-row ${x.qualifies === false ? "dim" : ""}" data-ticker-page="${esc(t)}" title="Open ${esc(t)}: chart, verdict, smart money">
        <td class="sym"><b>${esc(t)}</b><div class="meta2">${esc(x.name || "")}</div></td>
        <td class="num">${priceHtml(t, x)}</td>
        <td class="num rv"><b class="${isNum(rv) && rv >= 2 ? "up" : ""}">${isNum(rv) ? rv.toFixed(1) + "×" : "–"}</b><div class="meta2">${fvol(ses.session_volume)} today</div></td>
        ${tfs.map((k) => tfCell(x, k)).join("")}
        <td class="ses"><span class="${vw ? "up" : "down"}">${vw == null ? "–" : vw ? "above VWAP" : "below VWAP"}</span><div class="meta2">${isNum(rp) ? (rp * 100).toFixed(0) + "% of range" : ""}${isNum(ses.chg_from_open_pct) ? ` · open <span class="${cls(ses.chg_from_open_pct)}">${fpct(ses.chg_from_open_pct, 1)}</span>` : ""}</div></td>
        <td class="num total"><b class="${x.direction === "up" ? "up" : x.direction === "down" ? "down" : ""}">${(x.score || 0).toFixed(0)}</b><div class="meta2">${lead(x)} · ${x.direction}</div></td>
        <td class="read">${rd ? `<span class="pill ${rd[1]}">${rd[0]}</span><div class="meta2">${SC.cont[Math.round(a.continuation.score)]} odds · ${pretty(a.play.choice)}</div>` : '<span class="muted">numbers only</span>'}</td></tr>`; }).join("") || `<tr><td colspan="${6 + tfs.length}" class="muted">Nothing passed the filters this session.</td></tr>`;
    const tabs = [["lead", "Best timeframe"], ...tfs.map((k) => [k, k])].map(([k, l]) => `<button class="tab ${scanTf === k ? "active" : ""}" data-scan-tf="${k}">${l}</button>`).join("");
    const stamp = live ? `<span class="live-dot"></span> live · scanned ${new Date(S.as_of * 1000).toTimeString().slice(0, 8)} · <span id="sc-next">next scan in ${S.next_in_s}s</span>` : `${STATIC_MODE ? "hourly build · the minute-by-minute scan runs on the app server" : "warming up the live scan…"} · ${sessionLabel(r, S)}`;
    return `<section class="sc-section"><div class="sc-head"><h2>Volume scanner <span class="muted">${S.scanned} names checked · ${rows.length} trading far above normal${rows.length !== S.qualified ? ` (${S.qualified} qualified, ${Math.min(rows.length, 30)} shown)` : ""}</span></h2><div class="sc-stamp">${stamp}</div></div>
      <div class="sc-bar"><div class="tabs">${tabs}</div><div class="chips"><span class="chip">15m · 30m · 1h · 2h</span><span class="chip">activity ≥ ${(S.settings || {}).min_rvol || 1.5}× normal for the time of day</span><span class="chip">price ≥ $${(S.settings || {}).min_price || 2}</span><span class="chip">click a name for chart, verdict and smart money</span></div></div>
      <div class="tbl-wrap"><table class="tbl sc-tbl"><thead><tr><th>Stock</th><th>Price</th><th>Activity vs normal</th>${tfs.map((k) => `<th>${k} chart</th>`).join("")}<th>Today</th><th>Score</th><th>Model read</th></tr></thead><tbody>${body}</tbody></table></div>
    </section>`;
  }
  function secLowFloat(r) {
    const F = r.low_float; if (!F) return `<section><h2>Low float</h2><div class="muted">No low-float data this build.</div></section>`;
    const M = (x) => (isNum(x) ? (x / 1e6).toFixed(1) + "M" : "–");
    const body = (F.rows || []).map((x) => { const a = x.ai || {}, st = a.state ? LF.state[a.state.choice] : null, it = x.intraday, risk = a.risk ? Math.round(a.risk.score) : null;
      return `<tr>
        <td class="sym"><b>${esc(x.ticker)}</b>${x.micro ? ' <span class="tag bad">micro</span>' : ""}<div class="meta2">${esc(x.name || "")}${x.sector ? " · " + esc(x.sector) : ""}</div></td>
        <td class="num">${priceHtml(x.ticker, x)}</td>
        <td class="num">${fvol(x.volume)}<div class="meta2">${isNum(x.rel_volume) ? x.rel_volume.toFixed(1) + "× normal" : ""}</div></td>
        <td class="num"><b>${M(x.float)}</b><div class="meta2">of ${M(x.shares_outstanding)} out</div></td>
        <td class="num"><b class="${isNum(x.float_turnover) && x.float_turnover >= 1 ? "warn" : ""}">${isNum(x.float_turnover) ? x.float_turnover.toFixed(1) + "×" : "–"}</b><div class="meta2">float traded today</div></td>
        <td class="num">${isNum(x.short_pct_float) ? fpct(x.short_pct_float * 100, 1, false) : "–"}<div class="meta2">${isNum(x.days_to_cover) ? x.days_to_cover.toFixed(1) + "d to cover" : ""}</div></td>
        <td class="num">${isNum(x.insiders_pct) ? (x.insiders_pct * 100).toFixed(0) + "%" : "–"} / ${isNum(x.institutions_pct) ? (x.institutions_pct * 100).toFixed(0) + "%" : "–"}<div class="meta2">${fcap(x.market_cap)}</div></td>
        <td class="num">${isNum(x.range_pos) ? (x.range_pos * 100).toFixed(0) + "%" : "–"}<div class="meta2">${isNum(x.pct_from_hi52) ? fpct(x.pct_from_hi52, 0) + " vs 52w high" : ""}</div></td>
        <td>${it ? `<span class="${it.direction === "up" ? "up" : it.direction === "down" ? "down" : ""}">${it.score.toFixed(0)}/100</span><div class="meta2">${it.lead} ${it.direction}${isNum(it.rvol_tod) ? " · " + it.rvol_tod.toFixed(1) + "× RVOL" : ""}${it.above_vwap == null ? "" : it.above_vwap ? " · above VWAP" : " · below VWAP"}</div>` : '<span class="muted">no bars</span>'}</td>
        <td>${st ? `<span class="pill ${st[1]}">${st[0]}</span>${risk != null ? ` <span class="tag ${risk >= 2 ? "bad" : risk >= 1 ? "warn" : ""}">${LF.risk[risk]} risk</span>` : ""}<div class="meta2">${esc(st[2])} <b>${pretty(a.play.choice)}</b>: ${LF.play[a.play.choice]} ${convTag(a.state.confidence)}</div>` : '<span class="muted">numbers only</span>'}</td></tr>`; }).join("") || `<tr><td colspan="10" class="muted">No low-float names passed the screen (${esc(F.status)}).</td></tr>`;
    return `<section class="lf-section"><h2>Thin stocks (low float) <span class="muted">fewer than ${M(F.settings.max_float)} shares available to trade · price $${F.settings.price[0]}–${F.settings.price[1]} · volume ≥ ${fvol(F.settings.min_volume)} · ${F.candidates} candidates from Yahoo's screens, ${F.checked} checked · ${(F.as_of || "").slice(0, 16).replace("T", " ")} ET</span></h2>
      ${explain("Float is the number of shares actually available to trade. A small float plus heavy volume means the whole supply can change hands several times in a day, which is what makes these names move 30–300% and halt. Turnover = today's volume divided by the float. Short % of float and days to cover show how much fuel a squeeze has. Owners = insiders / institutions. The model labels each name (squeeze, momentum run, fading, selling, quiet), rates the risk of a violent reversal or halt, and suggests the sensible play, which is often to avoid.")}
      <div class="tbl-wrap"><table class="tbl lf-tbl"><thead><tr><th>Stock</th><th>Price</th><th>Volume</th><th>Float</th><th>Turnover</th><th>${term("shortfloat", "Short % float")}</th><th>Owners</th><th>Day range</th><th>Intraday volume</th><th>Model read</th></tr></thead><tbody>${body}</tbody></table></div>
    </section>`;
  }


  // ---------------------------------------------------------------- left menu
  // The rail must fit on one line for a reader (9 items) and the admin (12 items) at any width:
  // try full labels, then compact labels, then icons with the active label only, then allow a sideways scroll.
  // Priority menu: full labels -> compact labels -> the items that do not fit move into a "More" tray
  // (the active item always stays on the rail) -> icons only as the last resort. Phones scroll sideways instead.
  const MORE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg>';
  function navTray() {
    let t = $("#nav-tray");
    if (!t) { t = document.createElement("div"); t.id = "nav-tray"; t.className = "nav-tray"; t.hidden = true; t.setAttribute("role", "menu"); const h = $("#side"); if (h) h.appendChild(t); }
    return t;
  }
  function closeTray() { const t = $("#nav-tray"), m = $("#nav [data-more]"); if (t) t.hidden = true; if (m) { m.setAttribute("aria-expanded", "false"); m.classList.remove("open"); } }
  function toggleTray() {
    const t = navTray(), m = $("#nav [data-more]"), h = $("#side"); if (!m || !h) return;
    if (!t.hidden) { closeTray(); return; }
    const hr = h.getBoundingClientRect(), mr = m.getBoundingClientRect();
    t.style.right = Math.max(8, Math.round(hr.right - mr.right)) + "px";
    t.hidden = false; m.setAttribute("aria-expanded", "true"); m.classList.add("open");
    const first = t.querySelector(".side-item"); if (first) first.focus({ preventScroll: true });
  }
  addEventListener("click", (e) => { const t = $("#nav-tray"); if (!t || t.hidden) return; if (e.target.closest("#nav-tray") || e.target.closest("[data-more]")) return; closeTray(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape") closeTray(); });
  function fitNav() {
    const nav = $("#nav"); if (!nav) return;
    const tray = navTray(); const more = nav.querySelector("[data-more]");
    tray.querySelectorAll(".side-item").forEach((b) => nav.insertBefore(b, more));   // reset: everything back on the rail
    tray.hidden = true; nav.classList.remove("dense", "icons", "has-more");
    if (more) { more.hidden = true; more.classList.remove("open"); more.setAttribute("aria-expanded", "false"); }
    const fits = () => nav.scrollWidth <= nav.clientWidth + 1;
    if (fits()) return;
    nav.classList.add("dense"); if (fits()) return;
    if (!more || matchMedia("(max-width: 700px)").matches) return;                   // phones: the rail scrolls sideways
    more.hidden = false; nav.classList.add("has-more");
    const spare = [...nav.querySelectorAll(".side-item:not([data-more]):not(.active)")];
    while (!fits() && spare.length) tray.insertBefore(spare.pop(), tray.firstChild);  // popped from the end, so the tray keeps the menu order
    if (!fits()) nav.classList.add("icons");
    more.title = tray.children.length + " more";
  }
  let fitTimer = null;
  addEventListener("resize", () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitNav, 120); });
  // The menu: four places at the top (five for the admin), the rest one tap away in a labelled panel.
  const NAV_ICON = {
    markets: '<svg viewBox="0 0 24 24"><path d="M4 19h16"/><path d="M5 15l4-4 3 3 6-7"/><path d="M15 7h3v3"/></svg>',
    research: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/><path d="M8 11.5 10 9.5l1.5 1.5L13 9"/></svg>',
    chev: '<svg class="nv-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>',
  };
  const MENU = [
    { k: "home" }, { k: "watch" },
    { g: "markets", label: "Markets", icon: NAV_ICON.markets, items: [["macro", "The bigger picture: trend, rates, rotation"], ["theme", "Ten US themes, split into sectors"], ["stock", "Every analysed name in one table"], ["scan", "Unusual volume and low-float movers"]] },
    { g: "research", label: "Research", icon: NAV_ICON.research, items: [["map", "Type a company, see how it connects"], ["smart", "Insiders, big holders, Congress, options"], ["record", "Every call scored against the market"]] },
    { g: "admin", label: "Admin", admin: true, icon: ICONS.admin, items: [["desk", "Three scores per name and the big-cap scan"], ["check", "Every 15-minute read, scored"], ["admin", "Users, sessions and traffic"]] },
  ];
  let navOpen = null;
  function navPop() {
    let p = $("#nav-pop");
    if (!p) { p = document.createElement("div"); p.id = "nav-pop"; p.className = "nav-pop"; p.hidden = true; p.setAttribute("role", "menu"); document.body.appendChild(p); }   // on the body: the blurred header would trap a fixed panel
    return p;
  }
  function closeNavPop() { const p = $("#nav-pop"); if (p) p.hidden = true; document.querySelectorAll("#nav [data-grp]").forEach((b) => { b.setAttribute("aria-expanded", "false"); b.classList.remove("open"); }); navOpen = null; }
  function openNavPop(g, btn) {
    const m = MENU.find((x) => x.g === g); if (!m) return;
    if (navOpen === g) { closeNavPop(); return; }
    closeNavPop();
    const p = navPop(); const label = (k) => (VIEWS.find((v) => v[0] === k) || [k, k, ""]);
    p.innerHTML = `<div class="np-h">${esc(m.label)}</div>` + m.items.map(([k, d]) => { const [, l, n] = label(k);
      return `<button type="button" class="np-it ${currentView === k ? "on" : ""}" data-view="${k}" role="menuitem"><span class="np-ic">${ICONS[k] || ""}</span><span class="np-tx"><b>${esc(l)}</b><i>${esc(d)}</i></span>${n ? `<kbd>${n}</kbd>` : ""}</button>`; }).join("");
    const br = btn.getBoundingClientRect();
    p.style.left = Math.max(8, Math.min(innerWidth - 348, br.left - 8)) + "px"; p.style.top = (br.bottom + 8) + "px";
    p.hidden = false; btn.setAttribute("aria-expanded", "true"); btn.classList.add("open"); navOpen = g;
    p.querySelectorAll(".np-it").forEach((it) => { it.onclick = () => { closeNavPop(); switchView(it.getAttribute("data-view")); }; });
    const first = p.querySelector(".np-it.on") || p.querySelector(".np-it"); if (first) first.focus({ preventScroll: true });
  }
  addEventListener("click", (e) => { if (!navOpen) return; if (e.target.closest("#nav-pop") || e.target.closest("[data-grp]")) return; closeNavPop(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && navOpen) closeNavPop(); });
  addEventListener("resize", () => { if (navOpen) closeNavPop(); });
  addEventListener("scroll", () => { if (navOpen && !matchMedia("(max-width: 700px)").matches) closeNavPop(); }, true);
  function renderNav() {
    const label = (k) => VIEWS.find((v) => v[0] === k);
    const isAdmin = user && user.role === "admin";
    navTray().innerHTML = "";
    closeNavPop();
    $("#nav").innerHTML = MENU.filter((m) => !m.admin || isAdmin).map((m) => {
      if (m.k) { const [k, l] = label(m.k); const on = currentView === k;
        return `<button class="side-item v-${k} ${on ? "active" : ""}" data-view="${k}" title="${l}" aria-label="${l}" aria-current="${on ? "page" : "false"}"><span class="nav-ico">${ICONS[k]}</span><span class="side-label">${l}${k === "watch" && lists ? ` <span class="cnt">${activeList().length}</span>` : ""}</span></button>`; }
      const on = m.items.some(([k]) => k === currentView); const cur = on ? label(currentView)[1] : "";
      return `<button class="side-item nv-grp ${on ? "active" : ""}" data-grp="${m.g}" aria-haspopup="menu" aria-expanded="false" title="${esc(m.label)}${cur ? ": " + esc(cur) : ""}" aria-label="${esc(m.label)}${cur ? ", now on " + esc(cur) : ""}"><span class="nav-ico">${m.icon}</span><span class="side-label">${esc(m.label)}${cur ? `<em class="nv-cur">${esc(cur)}</em>` : ""}</span>${NAV_ICON.chev}</button>`;
    }).join("");
    const gb = $("#guide-btn"); if (gb) { gb.onclick = () => switchView("guide"); gb.classList.toggle("on", currentView === "guide"); }
    fitNav();
    const sw = $("#side-watch"); if (sw) sw.innerHTML = sideWatch();
    const foot = $("#side-foot");
    if (foot) foot.innerHTML = user ? `<div class="side-user"><span class="st-dot up"></span><b>${esc(user.name || user.email.split("@")[0])}</b>${user.role === "admin" ? ' <span class="tag acc">admin</span>' : ""}</div><div class="side-mail" title="${esc(user.email)}">${esc(user.email)}</div><div class="side-links">watchlist saved to your account · <button class="lnk" data-signout>Sign out</button></div>`
      : `<div class="side-links">Watchlist kept in this browser · <button class="lnk" data-signin>${STATIC_MODE ? "Sign in / sign up on the app" : "Sign in or sign up"}</button></div>`;
    if (foot) foot.insertAdjacentHTML("beforeend", `<a class="lnk invite" href="https://wa.me/?text=${encodeURIComponent(inviteText())}" target="_blank" rel="noopener">Invite friends on WhatsApp</a>`);
    const si = foot && foot.querySelector("[data-signin]"); if (si) si.addEventListener("click", () => { gateOpen = true; renderGate(); });
    const so = foot && foot.querySelector("[data-signout]"); if (so) so.addEventListener("click", signOut);
    wireNav();
  }
  function inviteText() {
    const link = APP_URL || ((document.querySelector('meta[property="og:url"]') || {}).content || location.origin + "/").replace(/\/$/, "") + "/";
    return ["OneView - a clearer market desk for day trades, swing setups and long-term decisions", "", "Desk: " + link, "Group: " + WA_GROUP, "",
      "Sign in with your email (one-time link, no password). Then you get:",
      "- A verdict for every stock you follow: buy, buy the dip, wait, hold, avoid or short, with the reason",
      "- Day trade, swing and long-term reads side by side on your watchlist",
      "- A volume scanner that runs every minute on 15m and 30m bars",
      "- Low-float movers with float, turnover and short interest",
      "- Who is buying: insiders, institutions, Congress and options flow",
      "- What today's numbers mean, in plain words: VIX, yields, breadth, the curve",
      "- Markets around the world and the themes that are moving",
      "", "Information only, not financial advice. You trade at your own risk."].join("\n");
  }
  function wireNav() {                       // the menu re-renders on its own, so it binds its own handlers (assignment, never duplicates)
    const root = $("#side"); if (!root) return;
    root.querySelectorAll("#nav .side-item[data-view]").forEach((b) => { b.onclick = () => { closeTray(); closeNavPop(); switchView(b.getAttribute("data-view")); }; });
    root.querySelectorAll("#nav [data-grp]").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); openNavPop(b.getAttribute("data-grp"), b); }; });
    const more = root.querySelector("[data-more]"); if (more) more.onclick = (e) => { e.stopPropagation(); toggleTray(); };
    root.querySelectorAll("[data-sub]").forEach((b) => { b.onclick = () => { const [v, k] = b.getAttribute("data-sub").split(":"); subTab[v] = k; renderAll(); }; });
    root.querySelectorAll("[data-ticker-page]").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); openTicker(b.getAttribute("data-ticker-page")); }; });
    root.querySelectorAll("[data-remove]").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); removeTicker(b.getAttribute("data-remove")); }; });
  }
  function sideWatch() {
    if (!lists || !report) return "";
    const rows = activeList().map((t) => { const s = stockFor(t); const q = s || (report.lite || {})[t] || {}; const px = q.last_price, ch = q.chg_pct; const st = s && s.ai && s.ai.stance ? s.ai.stance.choice : null;
      return `<div class="side-tick ${currentView === "ticker" && tickerSel === t ? "active" : ""}"><button class="st-open" data-ticker-page="${esc(t)}" title="Open ${esc(t)}'s page"><span class="st-dot ${st ? ST.cls[st] : "none"}"></span><b>${esc(t)}</b><span class="st-px">${isNum(px) ? fnum(px) : "–"}</span><span class="delta ${cls(ch)}">${isNum(ch) ? fpct(ch, 1) : ""}</span></button><button class="st-x" data-remove="${esc(t)}" title="Remove ${esc(t)}">×</button></div>`; }).join("");
    return rows ? rows + `<div class="side-count">${activeList().length} ${activeList().length === 1 ? "name" : "names"} · analysed every hour</div>` : `<div class="side-empty">No names yet. Add your first ticker above and its card appears on the home page.</div>`;
  }
  function marketStateNow() {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date());
    const get = (k) => (p.find((x) => x.type === k) || {}).value; const wd = get("weekday"), m = parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10);
    if (["Sat", "Sun"].includes(wd)) return "closed";
    return m >= 570 && m < 960 ? "open" : m >= 240 && m < 570 ? "pre" : m >= 960 && m < 1200 ? "post" : "closed";
  }
  function flash(text, sub) {
    let f = $("#flash"); if (!f) { f = document.createElement("div"); f.id = "flash"; document.body.appendChild(f); }
    f.innerHTML = `<div class="flash-in"><div class="flash-word">${text}</div><div class="flash-sub">${sub || ""}</div></div>`; f.classList.add("on");
    clearTimeout(flash._t); flash._t = setTimeout(() => f.classList.remove("on"), 9000);
  }
  function marketWatch() {
    const st = marketStateNow();
    if (lastMarketState && lastMarketState !== "open" && st === "open") flash("MARKET OPEN", "9:30 ET · regular session under way");
    if (lastMarketState === "open" && st === "post") flash("MARKET CLOSED", "4:00 ET · after-hours session");
    lastMarketState = st;
    const ms = $("#market-state"); if (ms && report && report.market_state !== st) { ms.textContent = { pre: "pre-market", open: "market open", post: "after hours", closed: "closed" }[st]; ms.className = "badge " + st; }
  }
  function scheduleHourly() {
    const now = new Date(); nextRefreshAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 5).getTime();
  }
  async function hourlyTick() {
    const el = $("#refresh-count"); if (!nextRefreshAt) scheduleHourly();
    const left = Math.max(0, nextRefreshAt - Date.now());
    if (el) { const ms = marketStateNow(); el.textContent = ms === "open" || ms === "pre" ? "Updates every 10 min while the market is open" : "Updates every 4 h while the market is closed"; el.classList.remove("soon"); }
    if (left > 0) return;
    scheduleHourly();
    if (!STATIC_MODE) { poll(); return; }
    if (STATIC_MODE) { try { const res = await fetch("./report.json", { cache: "no-store" }); if (res.ok) { const fresh = await res.json(); if (fresh.build_id !== report.build_id) { pendingReport = fresh; applyPending(); } } } catch (e) {} }
    else { try { await api("/api/refresh", { method: "POST" }); } catch (e) {} poll(); }
  }
  function initSide() {
    const shell = $("#shell"), tg = $("#side-toggle"); if (!shell || !tg) return;
    const c = false;                                   // OneView: the navigation is a top bar, never collapsed
    shell.classList.toggle("collapsed", c); tg.textContent = c ? "›" : "‹";
    tg.addEventListener("click", () => { const now = !shell.classList.contains("collapsed"); shell.classList.toggle("collapsed", now); tg.textContent = now ? "›" : "‹"; try { localStorage.setItem("mu-side", now ? "collapsed" : "open"); } catch (e) {} window.dispatchEvent(new Event("resize")); });
  }

  // ---------------------------------------------------------------- sign-in gate + onboarding
  async function loadUser() {
    if (STATIC_MODE) { user = null; try { localStorage.removeItem(USER_KEY); } catch (e) {} }
    else { try { const res = await api("/api/me", { cache: "no-store" }); user = res.ok ? await res.json() : null; } catch (e) { user = null; } }
    lists = null;                                   // rebuild the watchlist from the account on every (re)load
    if (user && user.profile && !(user.profile.tickers || []).length) {   // first sign-in from this browser: keep what was built here
      const saved = loadLists(); const mine = saved && saved.lists[saved.active];
      if (mine && mine.length) { user.profile.tickers = mine.slice(); if (!STATIC_MODE) api("/api/profile/tickers", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tickers: mine }) }).catch(() => {}); }
    }
  }
  const discThisSession = () => { try { return sessionStorage.getItem("mu-disc-s") === "1"; } catch (e) { return false; } };
  const gateNeeded = () => (STATIC_MODE ? true : (!user || !user.name || !discThisSession()));
  function disclaimerHtml() {
    const needName = !STATIC_MODE && !(user && user.name);
    return `<div class="ov-login disc-stage"><section class="ov-formpanel disc-panel-wrap"><div class="disc-logo-wrap">${brandLogo(190)}</div><div class="ov-form ov-form-wide disc-card" id="lg-card">
      ${brandLogo(170)}<button class="gate-x" data-decline title="Close without agreeing (signs you out)" aria-label="Close">×</button>
      ${user ? `<div class="ov-eyebrow">Signed in as ${esc(user.email)} · step 2 of 2</div>` : ""}
      <h1 class="disc-h">Before you continue: this is not financial advice.</h1>
      <div class="disc-body">
        <p>OneView is an information tool. It shows market data, arithmetic over that data (levels, ranges, volume, scores) and model reads produced by typed questions. None of it is investment, legal or tax advice, and nothing here is a recommendation or solicitation to buy, sell or hold any security, option or other instrument.</p>
        <p>Markets move fast and against you. Thinly traded names halt and gap. Data from public sources can be late or wrong, and model reads are probabilities, not predictions. Past patterns do not guarantee future results. You alone decide what to trade, and you alone carry the risk of loss, which can exceed your original stake with leverage or options.</p>
        <p>Nothing on this site creates an adviser, broker or fiduciary relationship. If you need advice, consult a licensed professional who knows your situation.</p>
      </div>
      ${needName ? `<div class="ov-fields"><label for="name-input">Your name (shown in the menu)</label><input id="name-input" maxlength="60" autocomplete="name" value="${esc(user.email.split("@")[0])}"></div>` : ""}
      <label class="ck"><input type="checkbox" id="disc-ok"><span>I have read this. I understand that nothing on OneView is financial advice and that I trade at my own risk.</span></label>
      <div class="gate-actions"><button class="ov-primary" id="disc-go" disabled>I agree, continue to my desk</button><button type="button" class="lnk decline" data-decline>I do not agree · sign out</button><span id="disc-status" class="gate-status" role="status" aria-live="polite"></span></div>
    </div></section></div>`;
  }
  function leaveGate(then) {                     // one short fade (guide: 120-180 ms), nothing staged
    const g = $("#gate"); if (!g || g.hidden) { then(); return; }
    g.classList.add("leaving");
    setTimeout(() => { g.classList.remove("leaving"); then(); const m = $("#app"); if (m) m.focus({ preventScroll: true }); }, 160);
  }
  const hexSteps = (n) => { const steps = ["Sign in", "Disclaimer", "Dashboard"]; return `<div class="hexflow" aria-label="Setup steps">${steps.map((l, i) => `<div class="hex ${i < n ? "done" : i === n ? "on" : ""}"><svg viewBox="0 0 100 100"><path d="M50 4 90 27v46L50 96 10 73V27z"/></svg><span class="hex-n">${i + 1}</span><span class="hex-l">${l}</span></div>${i < 2 ? '<i class="hex-line"></i>' : ""}`).join("")}</div>`; };
  const gateBrand = () => brandLogo(170);
  const pillBtn = (label, attrs = "") => `<button class="pill-btn" ${attrs}><span>${label}</span><i aria-hidden="true">↗</i></button>`;
  function mailLine() {
    if (STATIC_MODE) return "";
    if (!mailStatus) return `<div class="mail-line muted">Checking the mail service…</div>`;
    return mailStatus.configured ? `<div class="mail-line ok">Links are sent by <b>${esc(mailStatus.from_name)}</b>. Check your spam folder the first time.</div>`
      : `<div class="mail-line warn">No mail service is connected yet (${esc(mailStatus.problem || "")}). The site owner adds a sender and one transport to <code>.env</code>; until then the link appears here for local use.</div>`;
  }
  const WA_GROUP = "https://chat.whatsapp.com/C4NROWURa0SI1hoegnfHOc?mode=gi_t";
  const waJoin = () => `<a class="wa-join" href="${WA_GROUP}" target="_blank" rel="noopener"><span class="wa-ic" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 1.8a8.2 8.2 0 1 1-4.2 15.3l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 0 1 12 3.8zm-3 4.4c-.2 0-.5 0-.7.3-.3.3-1 1-1 2.4s1 2.8 1.2 3c.1.2 2 3.2 5 4.4 2.5 1 3 .8 3.5.7.5 0 1.7-.7 1.9-1.4.2-.7.2-1.2.2-1.4-.1-.1-.3-.2-.6-.3l-2-1c-.3-.1-.5-.1-.7.1l-.9 1.1c-.2.2-.3.2-.6.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.6-1.2.1-.2 0-.4 0-.5l-.9-2.1c-.2-.6-.5-.5-.7-.5z"/></svg></span><span class="wa-t"><b>Join the OneView group on WhatsApp</b><span>The team's latest moves, posted as they happen: what we are watching, buying and stepping away from.</span></span><i aria-hidden="true">Join ›</i></a>`;
  const brandLogo = (w) => `<img class="ov-logo" src="static/brand/oneview-logo.png?v=6" alt="OneView" width="${w || 190}" style="height:auto">`;
  function loginHtml() {
    const form = STATIC_MODE
      ? `<div class="ov-form" id="login-core"><h1>Welcome to OneView</h1><p>Sign-in runs on the app server; this copy is not connected to one yet.</p>
        ${APP_URL ? `<a class="ov-primary" href="${esc(APP_URL)}/?signin=1">Go to the sign-in page</a>` : `<p class="ov-hint">Ask the site owner for the app link.</p>`}</div>`
      : `<div class="ov-form" id="login-core">
        <span class="lg-kicker">Sign in or create your desk</span>
        <h1>Welcome to OneView</h1>
        <p>Enter your email and we send a one-time link. No password, no card.</p>
        <form id="login-form" class="ov-fields" novalidate>
          <label for="login-email">Email address</label>
          <input type="email" id="login-email" name="email" placeholder="you@example.com" required autocomplete="email" inputmode="email" autofocus>
          <button class="ov-primary lg-btn" type="submit" id="login-submit"><span>Send my sign-in link</span><i aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6"/></svg></i></button>
          <div class="ov-hint">No password needed.</div>
        </form>
        <div id="login-status" class="gate-status" role="status" aria-live="polite">${signedOutNote ? "Thank you, see you back again." : ""}</div>
        ${mailLine()}
        ${waJoin()}
      </div>`;
    const live = (() => { try { if (!report) return ""; const pick = [["SPY", "S&P 500"], ["QQQ", "Nasdaq 100"], ["^VIX", "VIX"], ["BTC-USD", "Bitcoin"]];
      const items = pick.map(([sym, lbl]) => { const o = (report.indices || []).find((x) => x.symbol === sym) || (report.macro || []).find((x) => x.symbol === sym); if (!o) return ""; const q = qp(sym, o); if (!isNum(q.last)) return "";
        return `<span><i>${lbl}</i><b>${fnum(q.last, q.last < 100 ? 2 : 2)}</b><em class="${cls(q.chg)}">${fpct(q.chg, 2)}</em></span>`; }).join("");
      return items ? `<div class="lg-live"><span class="lg-dot"></span><span class="lg-live-l">Live now</span>${items}</div>` : ""; } catch (e) { return ""; } })();
    const bars = [38, 52, 44, 61, 57, 70, 64, 48, 42, 35].map((h, i) => `<i class="${h >= 55 ? "up" : h <= 45 ? "down" : ""}" style="height:${h}%;animation-delay:${i * 60}ms"></i>`).join("");
    return `<div class="ov-login login-stage lg2"><div class="lg-aurora" aria-hidden="true"><i></i><i></i><i></i></div><div class="lg-grain" aria-hidden="true"></div>
      <section class="ov-brand lg-left" aria-label="OneView">
        ${brandLogo(220)}
        <span class="lg-eyebrow"><i></i>Formerly Webex Traders · free to use</span>
        <h2 class="ov-tagline">Read the market.<br><span>Own your next move.</span></h2>
        <p class="lg-sub">One page that shows what is happening and what could happen next, from the crowd, the proven traders and the money on the line.</p>
        <div class="lg-proof">
          <div class="lg-tile"><div class="lg-core"><div class="lg-vis lg-bars" aria-hidden="true">${bars}</div><b>What people are saying</b><span>About 200 posts per name, read newest first, so the headline is the mood right now.</span></div></div>
          <div class="lg-tile"><div class="lg-core"><div class="lg-vis lg-badge" aria-hidden="true"><em>70%+</em><small>right</small></div><b>Top traders, measured</b><span>Every call scored against what the price did. Only the ones who are right 70% of the time or more.</span></div></div>
          <div class="lg-tile"><div class="lg-core"><div class="lg-vis lg-stack" aria-hidden="true"><i class="a"></i><i class="b"></i><i class="c"></i></div><b>Real-money odds</b><span>The Fed, the S&amp;P 500 and your names, priced by Polymarket and Kalshi.</span></div></div>
        </div>
        ${live}
        <p class="ov-fine">Market data, model reads and scans are information, not advice.</p>
      </section>
      <section class="ov-formpanel lg-right" aria-label="Sign in"><div class="lg-shell">${form}</div></section>
    </div>`;
  }
  function sentHtml(email, j) {
    const mins = j.expires_in_min || 10;
    return `<h1>Check your inbox</h1>
      <p>If <b>${esc(email)}</b> can receive mail, a one-time sign-in link is on its way. Open it on this device and you land on your desk.</p>
      ${j.dev_link ? `<a class="ov-primary" href="${esc(j.dev_link)}">Open my sign-in link</a><div class="ov-hint">No mail service is connected on this machine, so the link is shown here for local use.</div>` : ""}
      <div class="sent-timer"><b id="sent-count">${mins}:00</b><span>Valid for ${mins} minutes. Opening an expired link sends a fresh one automatically.</span></div>
      <p class="ov-hint">Nothing there? Check spam once, then <button type="button" class="lnk" data-resend>send it again</button>.</p>`;
  }
  let sentTimer = null;
  function startSentTimer(total) {
    clearInterval(sentTimer); const t0 = Date.now();
    sentTimer = setInterval(() => { const el = $("#sent-count"); if (!el) { clearInterval(sentTimer); return; }
      const left = Math.max(0, total - Math.floor((Date.now() - t0) / 1000)); el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
      if (!left) { clearInterval(sentTimer); el.textContent = "expired"; } }, 1000);
  }
  function startLoginFx() { /* OneView: no decorative motion on the sign-in page */ }
  // FIX 1: a visible gate covers the working area only. The navigation element (#side) is a top bar in this layout, so the gate
  // starts below it; if the shell ever uses a vertical sidebar again (236px, 64px collapsed) the gate starts to its right instead.
  function positionGate() {
    const g = $("#gate"), side = $("#side"); if (!g) return;
    const mobile = innerWidth <= 900;
    let left = 0, top = 0;
    if (side && !mobile) { const b = side.getBoundingClientRect(); if (b.height > b.width) left = Math.round(b.width); else top = Math.round(b.bottom); }
    else if (side && mobile) { const b = side.getBoundingClientRect(); if (b.width >= innerWidth - 2) top = Math.round(b.bottom); }
    g.style.setProperty("--gate-left", left + "px"); g.style.setProperty("--gate-top", top + "px");
  }
  addEventListener("resize", positionGate);
  function renderGate() {
    const g = $("#gate"); if (!g) return;
    const lb = $("#logout-btn"); if (lb) { lb.hidden = !user; if (user) setLabel(lb, `Sign out · ${(user.name || user.email.split("@")[0]).slice(0, 14)}`); }
    if (!gateNeeded()) { g.hidden = true; g.setAttribute("aria-hidden", "true"); g.innerHTML = ""; renderNav(); return; }
    const html = (STATIC_MODE ? (gateOpen ? loginHtml() : disclaimerHtml()) : (!user ? loginHtml() : disclaimerHtml()));
    g.hidden = false; g.removeAttribute("aria-hidden"); g.innerHTML = html; positionGate();
    wireGate(); startLoginFx();
    document.querySelectorAll("[data-gate-close]").forEach((gc) => gc.addEventListener("click", () => { gateOpen = false; if (gateNeeded()) renderGate(); else leaveGate(() => renderGate()); }));
    const decline = () => { try { sessionStorage.removeItem("mu-disc-s"); } catch (e) {} signOut(); };
    document.querySelectorAll("[data-decline]").forEach((d) => d.addEventListener("click", decline));
    if ($("#disc-go")) { const onKey = (e) => { if (e.key === "Escape" && $("#disc-go")) { removeEventListener("keydown", onKey); decline(); } }; addEventListener("keydown", onKey); }
    const dgo = $("#disc-go"); if (dgo) {
      const ok = $("#disc-ok"); ok.addEventListener("change", () => { dgo.disabled = !ok.checked; });
      dgo.addEventListener("click", async () => {
        const st = $("#disc-status"); st.textContent = "Saving…";
        try { localStorage.setItem("mu-disc", "1"); sessionStorage.setItem("mu-disc-s", "1"); } catch (e) {}
        if (!STATIC_MODE && user) {
          const nm = $("#name-input") ? $("#name-input").value.trim() : "";
          try {
            if (nm && !user.name) { const r1 = await api("/api/profile/name", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: nm }) }); if (r1.ok) user.name = (await r1.json()).name; }
            const r2 = await api("/api/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accepted: true, tickers: (user.profile && user.profile.tickers) || [] }) });
            if (!r2.ok) { st.className = "gate-status err"; st.textContent = "Could not save. Try again."; return; }
            user.profile = (await r2.json()).profile; if (!user.name) user.name = user.email.split("@")[0];
          } catch (e) { st.className = "gate-status err"; st.textContent = "The server is not reachable right now."; return; }
          lists = null; ensureLists(report);
        }
        leaveGate(() => { renderGate(); renderAll(); if (!STATIC_MODE && lists) refreshAdhoc(); });
      });
    }

    if (!user && !STATIC_MODE && !mailStatus) api("/api/auth/mail-status").then((r) => r.json()).then((j) => { mailStatus = j; const m = $("#gate .mail-line"); if (m) m.outerHTML = mailLine(); }).catch(() => {});
  }
  function wireGate() {
    const lf = $("#login-form");
    if (lf) lf.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = $("#login-email").value.trim().toLowerCase(), st = $("#login-status"); st.className = "gate-status"; signedOutNote = false;
      if (STATIC_MODE) return;
      const inp = $("#login-email"); if (!inp.checkValidity() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { st.className = "gate-status err"; st.textContent = "Enter a valid email address."; inp.focus(); return; }
      const btn = $("#login-submit"); if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
      st.textContent = "Sending your link…";
      try {
        const res = await api("/api/auth/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
        const j = await res.json();
        if (!res.ok) { st.className = "gate-status err"; st.textContent = j.detail || "The link could not be sent. Try again in a moment."; if (btn) { btn.disabled = false; btn.textContent = "Send sign-in link"; } inp.focus(); return; }
        const core = $("#login-core"); if (core) { core.innerHTML = sentHtml(email, j); startSentTimer(j.expires_in_s || 600);
          const rs = core.querySelector("[data-resend]"); if (rs) { rs.disabled = true; setTimeout(() => { rs.disabled = false; }, 60000); rs.addEventListener("click", async () => { rs.textContent = "sending…"; try { const r2 = await api("/api/auth/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) }); const j2 = await r2.json(); rs.textContent = r2.ok ? "sent again" : (j2.detail || "try later"); if (r2.ok) startSentTimer(j2.expires_in_s || 600); } catch (err) { rs.textContent = "try later"; } }); } }
      } catch (err) { st.className = "gate-status err"; st.textContent = "The server is not reachable right now. Try again in a moment."; const b2 = $("#login-submit"); if (b2) { b2.disabled = false; b2.textContent = "Send my sign-in link"; } }
    });
    const go = $("#picks-go"); if (!go) return;
    const state = () => { const ok = $("#disc-ok").checked; const vals = [...new Set([...document.querySelectorAll("#picks .pick")].map((i) => i.value.trim().toUpperCase()).filter(Boolean))]; go.disabled = !(ok && vals.length >= 3); const st = $("#picks-status"); if (st && !st.classList.contains("err")) st.textContent = ok ? (vals.length >= 3 ? "" : `${3 - vals.length} more to go`) : "Tick the box above first"; return vals; };
    $("#disc-ok").addEventListener("change", state);
    function wirePicks() {
      document.querySelectorAll("#picks .pick").forEach((inp) => inp.addEventListener("input", () => {
        state();
        const q = inp.value.trim().toUpperCase(); const dl = $("#sym-list"); if (!dl) return;
        loadSymbols();
        dl.innerHTML = searchSymbols(q).slice(0, 8).map((r) => `<option value="${esc(r[0])}">${esc(r[1] || "")}</option>`).join("");
      }));
    }
    wirePicks();
    go.addEventListener("click", async () => {
      const vals = state(); if (vals.length < 3) return;
      const kind = "stocks";
      const st = $("#picks-status"); st.className = "gate-status"; st.textContent = "Saving…";
      const profile = { accepted_disclaimer_at: new Date().toISOString(), kind, tickers: vals.slice(0, 4) };
      if (STATIC_MODE) { user.profile = profile; try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch (e) {} }
      else {
        try {
          const res = await api("/api/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accepted: true, kind, tickers: profile.tickers }) });
          const j = await res.json(); if (!res.ok) { st.className = "gate-status err"; st.textContent = j.detail || "Could not save."; return; }
          user.profile = j.profile;
        } catch (e) { st.className = "gate-status err"; st.textContent = "The server is not reachable right now."; return; }
      }
      applyProfile();
    });
  }
  function disclaimerBanner() { /* replaced by the right-side panel */ }
  const discAgreed = () => { try { return localStorage.getItem("mu-disc") === "1"; } catch (e) { return false; } };
  function discPanel() {
    return (discAgreed() || (user && user.profile && user.profile.accepted_disclaimer_at))
      ? `<section class="panel disc-panel agreed"><span class="disc-mini"><b>Not financial advice.</b> Data, arithmetic and model reads only. <span class="muted">Agreed</span></span></section>`
      : `<section class="panel disc-panel"><h3>Not financial advice</h3><p>Everything on this page is market data, arithmetic over that data, and model reads from typed questions. None of it is a recommendation to buy or sell anything. You trade at your own risk.</p><button class="pill-btn small" data-agree><span>I agree</span><i aria-hidden="true">✓</i></button></section>`;
  }
  function applyProfile() {
    const picks = (user.profile && user.profile.tickers) || [];
    lists = { active: "My watchlist", lists: { "My watchlist": picks.slice() } };
    try { localStorage.setItem(LISTS_KEY, JSON.stringify(lists)); } catch (e) {}
    syncServerWatchlist();
    picks.forEach((t) => { if (!stockFor(t) && !STATIC_MODE) requestAnalysis(t); });
    renderGate(); if (currentView !== "home") currentView = "home"; renderAll();
  }
  let signedOutNote = false;
  async function signOut() {
    signedOutNote = true;
    if (STATIC_MODE) { try { localStorage.removeItem(USER_KEY); } catch (e) {} }
    else { try { await api("/api/auth/logout", { method: "POST" }); } catch (e) {} }
    authToken = null; try { localStorage.removeItem("mu-token"); } catch (e) {}
    user = null; lists = null; try { sessionStorage.removeItem("mu-disc-s"); } catch (e) {}
    if (report) { ensureLists(report); renderAll(); }        // fall back to the browser copy of the list
    renderGate();
  }

  let lastRenderedView = null;
  function renderAll() {
    const r = report;
    // same view re-render: do not jump to the top. Whatever scrolls (window, main, or a wrapper) keeps its place.
    const scrollers = []; for (let el = $("#app"); el; el = el.parentElement) { if (el.scrollTop > 0) scrollers.push([el, el.scrollTop]); }
    const viewEl = $("#app .view");   // the view pane is the real scroller and is rebuilt on every render
    const keepY = lastRenderedView === currentView ? { win: window.scrollY, els: scrollers, view: viewEl ? viewEl.scrollTop : 0 } : null;
    ensureLists(r); seedQuotes(r);
    destroyCharts();
    $("#session-line").textContent = r.session_label.split(",")[0] + " " + r.session_date.slice(5).replace("-", "/");
    const ms = $("#market-state"); ms.textContent = { pre: "pre-market", open: "market open", post: "after hours", closed: "closed" }[r.market_state] || r.market_state; ms.className = "badge " + r.market_state;
    $("#generated-line").textContent = `report ${r.generated_at.slice(11, 16)} ET`;
    const app = $("#app");
    renderNav();
    const tape = $("#tape"); if (tape) { const items = [...(r.indices || []).map((i) => ({ t: i.symbol, l: i.symbol, o: i })), ...(r.macro || []).map((m) => ({ t: m.symbol, l: m.label || m.symbol, o: m })), ...(r.world || []).map((w) => ({ t: w.symbol, l: w.label, o: w }))].filter((x) => isNum(qp(x.t, x.o).last));
      const row = items.map((x) => `<span class="tp"><b>${esc(x.l)}</b>${priceHtml(x.t, x.o)}</span>`).join("");
      tape.innerHTML = `<div class="tape-track">${row}${row}</div>`; tape.hidden = !items.length; }
    const ttl = $("#hud-title"), sub = $("#hud-sub");
    if (ttl) { ttl.textContent = currentView === "ticker" ? (tickerSel || "Ticker") : (PAGE_TITLES[currentView] || "Your market overview"); }
    horizonBar();
    const mini = $("#hud-mini"); if (mini) { mini.hidden = currentView !== "home"; mini.innerHTML = currentView === "home" ? heroMini(r) : ""; }
    if (sub) { sub.innerHTML = `${esc(r.session_label.split(",")[0])} ${esc(r.session_date.slice(5).replace("-", "/"))} · report ${esc(r.generated_at.slice(11, 16))} ET · <span data-qstamp>${quoteStamp()}</span>`; }
    app.innerHTML = viewHtml(r);
    firstRender = false;
    if (keepY != null) { window.scrollTo(0, keepY.win); keepY.els.forEach(([el, y]) => { el.scrollTop = y; }); const nv = $("#app .view"); if (nv && keepY.view) nv.scrollTop = keepY.view; }
    lastRenderedView = currentView;
    const st = r.ai_stats;
    $("#footer").innerHTML = `<div class="foot">Prices: Yahoo Finance, 15-minute delayed · change is versus the prior close · report built ${r.generated_at.slice(11, 16)} ET${r.ai_enabled ? "" : " · model reads off this build"} · OneView is information, not advice.</div>`;
    mountCharts();
    wireStocks();
    if (currentView === "home") jumpToBrief();
  }

  // ======================= THE PULSE: the market in ten seconds =======================
  // Everything here is arithmetic on data already in the report (prices, averages, ATR, flows, the
  // model's tone read, the StockTwits crowd). Nothing is a forecast; the scenarios are "if this, then that".
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const scoreOn = (x, lo, hi) => (isNum(x) ? Math.round(clamp01((x - lo) / (hi - lo)) * 100) : null);
  const macroOf = (r, sym) => (r.macro || []).find((m) => m.symbol === sym);
  const idxOf = (r, sym) => (r.indices || []).find((i) => i.symbol === sym);
  const gaugeOf = (r, key) => (((r.flows || {}).gauges) || []).find((g) => g.key === key);
  let pulseSym = "SPY", pulsePeriod = "1d";
  const PULSE_BANDS = [[0, 25, "Fear", "down"], [25, 45, "Nervous", "warn"], [45, 56, "Neutral", "flat"], [56, 76, "Confident", "up"], [76, 101, "FOMO", "up"]];
  const bandOf = (s) => PULSE_BANDS.find(([lo, hi]) => s >= lo && s < hi) || PULSE_BANDS[2];
  const rsiWord = (x) => (!isNum(x) ? "" : x < 35 ? "oversold" : x < 45 ? "weak" : x < 60 ? "steady" : x < 70 ? "strong" : "overheated");
  const vixWord = (x) => (!isNum(x) ? "" : x < 15 ? "calm" : x < 20 ? "normal" : x < 30 ? "nervous" : "panic");
  function pulseInputs(r) {
    const spy = idxOf(r, "SPY"), t = (spy && spy.technicals) || {};
    const out = [];
    const above = [t.above_sma20, t.above_sma50, t.above_sma200].filter((x) => x === true).length;
    if (spy) out.push({ k: "Trend", s: Math.round(above / 3 * 100), v: `${above} of 3`, note: `S&P 500 is above ${above} of its 3 key averages (20, 50 and 200 day)` });
    if (isNum(t.rsi14)) out.push({ k: "Momentum", s: scoreOn(t.rsi14, 30, 70), v: `RSI ${fnum(t.rsi14, 0)}`, note: `14-day RSI ${fnum(t.rsi14, 0)}: ${rsiWord(t.rsi14)}. Under 30 is washed out, over 70 is overheated` });
    const vix = macroOf(r, "^VIX"); const vl = vix ? qp("^VIX", vix).last : null;
    if (isNum(vl)) out.push({ k: "Fear gauge", s: scoreOn(vl, 30, 12), v: `VIX ${fnum(vl, 1)}`, note: `VIX ${fnum(vl, 1)}: ${vixWord(vl)}. Under 15 is calm, over 30 is panic` });
    const br = gaugeOf(r, "breadth");
    if (br && isNum(br.chg_1m)) out.push({ k: "Breadth", s: scoreOn(br.chg_1m, -5, 5), v: fpct(br.chg_1m, 1), note: br.chg_1m < 0 ? "The average stock is lagging the S&P over the month: a few giants are doing the lifting" : "The average stock is keeping up with the S&P: the rally is broad" });
    const ap = ["credit", "size", "offense"].map((k) => gaugeOf(r, k)).filter((g) => g && isNum(g.chg_1m));
    if (ap.length) { const m = ap.reduce((a, g) => a + g.chg_1m, 0) / ap.length; out.push({ k: "Risk appetite", s: scoreOn(m, -5, 5), v: fpct(m, 1), note: "Junk bonds vs Treasuries, small vs large caps, and discretionary vs staples over one month" }); }
    const tp = ((r.regime || {}).tone || {}).probabilities;
    if (tp) { const d = (tp.risk_on || 0) - (tp.risk_off || 0); out.push({ k: "Model read", s: Math.round(50 + 50 * d), v: pretty(r.regime.tone.choice).replace(/^./, (c) => c.toUpperCase()), note: "OneView's read of futures, the fear gauge, rates and headlines" }); }
    const pl = prosSnap && prosSnap.status === "ok" && ((prosSnap.consensus || {}).tickers || []).find((x) => x.sym === "SPY");
    if (pl && isNum(pl.lean) && pl.bull + pl.bear >= 3) out.push({ k: "Top traders", s: Math.round(pl.lean * 100), v: `${pl.bull}↑ ${pl.bear}↓`, note: "Calls on SPY in the last 72 hours from the StockTwits traders with a measured 70%+ hit rate, weighted by their records" });
    const cm = crowd && crowd.status === "ok" && (crowd.moods || {}).SPY;
    const ct = crowd && crowd.status === "ok" && (crowd.talk || {}).SPY;
    if (ct && ct.last50 && isNum(ct.last50.share)) out.push({ k: "Crowd now", s: ct.last50.share, v: `${ct.last50.bull}↑ ${ct.last50.bear}↓`, note: "The latest tagged StockTwits posts on SPY: share that are bullish. A crowd at an extreme is a crowding warning, not a signal" });
    else if (cm && isNum(cm.score)) out.push({ k: "Crowd", s: Math.round(cm.score), v: `${Math.round(cm.score)}/100`, note: "StockTwits mood on SPY versus its normal (50 = normal). Extremes are a crowding warning, not a signal" });
    return out.filter((x) => isNum(x.s));
  }
  // A segmented meter: five zones along an arc, the current zone lit, a marker riding the arc to the score.
  const MOOD_ZONES = [[0, 25, "Fear", "#FF6B85"], [25, 45, "Nervous", "#F7A85A"], [45, 56, "Neutral", "#B9B9C4"], [56, 76, "Confident", "#8EDFA8"], [76, 100, "FOMO", "#3DDC97"]];
  function moodMeter(score) {
    const cx = 130, cy = 124, R = 100, W = 16;
    const pt = (v, rad) => { const t = Math.PI * (1 - v / 100); return [cx + rad * Math.cos(t), cy - rad * Math.sin(t)]; };
    const arc = (v1, v2, rad) => { const [x1, y1] = pt(v1, rad), [x2, y2] = pt(v2, rad); return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${rad} ${rad} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`; };
    const zone = MOOD_ZONES.find(([lo, hi]) => score >= lo && score < hi) || MOOD_ZONES[MOOD_ZONES.length - 1];
    const gap = 0.9;
    const segs = MOOD_ZONES.map(([lo, hi, name, col]) => { const on = zone[2] === name;
      return `<path d="${arc(lo + (lo ? gap : 0), hi - (hi < 100 ? gap : 0), R)}" class="mm-seg ${on ? "on" : ""}" stroke="${col}"/>`; }).join("");
    const ticks = [0, 25, 50, 75, 100].map((v) => { const [x1, y1] = pt(v, R - W / 2 - 6), [x2, y2] = pt(v, R - W / 2 - 11); return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" class="mm-tick"/>`; }).join("");
    const labels = "";
    const [kx, ky] = pt(0, R);                         // the marker starts at 0 and turns to the score
    const deg = (score / 100) * 180;
    return `<div class="mm" style="--mm:${zone[3]}">
      <svg viewBox="16 12 228 124" role="img" aria-label="Market mood ${score} out of 100: ${zone[2]}">
        <path d="${arc(0, 100, R)}" class="mm-track"/>
        ${segs}${ticks}${labels}
        <g class="mm-knob" style="--deg:${deg}deg;transform-origin:${cx}px ${cy}px">
          <circle cx="${kx}" cy="${ky}" r="13" class="mm-knob-o"/><circle cx="${kx}" cy="${ky}" r="6" class="mm-knob-i"/>
        </g>
      </svg>
      <div class="mm-read"><b>${score}</b><span>${zone[2]}</span><i>out of 100</i></div>
      <div class="mm-scale">${MOOD_ZONES.map(([lo, hi, name, col]) => `<span class="${zone[2] === name ? "on" : ""}" style="--c:${col}"><i></i>${name}</span>`).join("")}</div>
    </div>`;
  }
  function pulseGauge(r) {
    const ins = pulseInputs(r); if (!ins.length) return "";
    const score = Math.round(ins.reduce((a, x) => a + x.s, 0) / ins.length); const [, , word, bc] = bandOf(score);
    const bars = ins.map((x) => { const b = bandOf(x.s); return `<li title="${esc(x.note)}"><span class="pg-k">${esc(x.k)}</span><span class="pg-bar"><i class="${b[3]}" style="width:${Math.max(4, x.s)}%"></i></span><span class="pg-v">${esc(x.v)}</span></li>`; }).join("");
    return `<article class="pz pz-gauge" data-pz="gauge">
      <div class="pz-h"><span class="pz-eye">Market mood</span><span class="pz-hint" title="The average of the bars below, each scored 0 (fear) to 100 (FOMO). Hover a bar to see what it measures. A mood, not a forecast.">what's this?</span></div>
      ${moodMeter(score)}
      <ul class="pg-list">${bars}</ul>
    </article>`;
  }
  function areaSpark(values, cl, id) {
    const v = (values || []).filter(isNum); if (v.length < 2) return "";
    const w = 200, h = 56, lo = Math.min(...v), hi = Math.max(...v), rg = hi - lo || 1;
    const pts = v.map((x, i) => [(i / (v.length - 1)) * w, h - 4 - ((x - lo) / rg) * (h - 10)]);
    const line = pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
    return `<svg class="aspark ${cl}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".32"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><polygon points="0,${h} ${line} ${w},${h}" fill="url(#${id})"/><polyline points="${line}"/></svg>`;
  }
  const IDX_NAMES = { SPY: "S&P 500", QQQ: "Nasdaq 100", IWM: "Small caps", DIA: "Dow 30" };
  function pulseIndexes(r) {
    const tiles = ["SPY", "QQQ", "IWM", "DIA"].map((sym) => { const x = idxOf(r, sym); if (!x) return ""; const t = x.technicals || {};
      const closes = (x.ohlc || []).slice(-30).map((c) => c.c); const m1 = closes.length > 1 ? (closes[closes.length - 1] / closes[0] - 1) * 100 : null;
      const q = qp(sym, x); const pos = isNum(t.hi52) && isNum(t.lo52) && isNum(q.last) ? clamp01((q.last - t.lo52) / (t.hi52 - t.lo52)) : null;
      const tr = t.above_sma50 && t.above_sma200 ? ["Uptrend", "up"] : !t.above_sma50 && !t.above_sma200 ? ["Downtrend", "down"] : ["Mixed trend", "warn"];
      return `<div class="pi-tile" data-ticker-page="${sym}" role="button" tabindex="0">
        <div class="pi-top"><span><b>${sym}</b><i>${IDX_NAMES[sym]}</i></span><span class="pi-chip ${tr[1]}">${tr[0]}</span></div>
        <div class="pi-px">${priceHtml(sym, x)}</div>
        ${areaSpark(closes, cls(m1), "pa" + sym)}
        <div class="pi-foot"><span>30 days <b class="${cls(m1)}">${fpct(m1, 1)}</b></span>${pos != null ? `<span class="pi-52" title="Where the price sits between its 52-week low and high"><i style="left:${(pos * 100).toFixed(1)}%"></i></span><span>${isNum(t.pct_from_hi52) ? (t.pct_from_hi52 > -0.5 ? "at the 52-wk high" : fpct(t.pct_from_hi52, 1) + " from high") : ""}</span>` : ""}</div>
      </div>`; }).join("");
    return `<article class="pz pz-idx" data-pz="idx"><div class="pz-h"><span class="pz-eye">The big four</span><span class="pz-hint">tap one for its page</span></div><div class="pi-grid">${tiles}</div></article>`;
  }
  function levelsFor(r, sym) {
    const x = idxOf(r, sym); if (!x) return null; const t = x.technicals || {}, pa = x.price_action || {};
    const last = qp(sym, x).last; const atr = t.atr14; if (!isNum(last) || !isNum(atr)) return null;
    const bi = brief && brief.briefs && brief.briefs.morning && (brief.briefs.morning.indexes || {})[sym];
    let S = bi && isNum(bi.nearest_support) && bi.nearest_support < last ? bi.nearest_support : null;
    let R = bi && isNum(bi.nearest_resistance) && bi.nearest_resistance > last ? bi.nearest_resistance : null;
    const highs = (pa.swing_highs || []).map((p) => p.v).filter(isNum), lows = (pa.swing_lows || []).map((p) => p.v).filter(isNum);
    if (R == null) { const a = highs.filter((v) => v > last); R = a.length ? Math.min(...a) : (isNum(t.hi52) && t.hi52 > last + atr * 0.25 ? t.hi52 : last + atr * 1.5); }
    if (S == null) { const b = lows.filter((v) => v < last); S = b.length ? Math.max(...b) : (isNum(t.sma20) && t.sma20 < last ? t.sma20 : last - atr * 1.5); }
    const upNext = [...highs.filter((v) => v > R + atr * 0.2), isNum(t.hi52) && t.hi52 > R + atr * 0.2 ? t.hi52 : null].filter(isNum);
    const up2 = upNext.length ? Math.min(...upNext) : R + atr;
    const dnNext = [...lows.filter((v) => v < S - atr * 0.2), isNum(t.sma50) && t.sma50 < S - atr * 0.2 ? t.sma50 : null].filter(isNum);
    const dn2 = dnNext.length ? Math.max(...dnNext) : S - atr;
    const trend = t.above_sma50 && t.above_sma200 ? "up" : !t.above_sma50 && !t.above_sma200 ? "down" : "mixed";
    return { sym, last, atr, S, R, up2, dn2, trend, sma50: t.sma50, atrPct: t.atr_pct };
  }
  function pulseLevels(r) {
    const L = levelsFor(r, pulseSym) || levelsFor(r, (pulseSym = "SPY")); if (!L) return "";
    const lo = Math.min(L.dn2, L.last - L.atr) , hi = Math.max(L.up2, L.last + L.atr); const pad = (hi - lo) * 0.06; const a = lo - pad, b = hi + pad;
    const at = (v) => (((v - a) / (b - a)) * 100).toFixed(2) + "%";
    const gap = (u, v) => Math.abs(u - v) / (b - a) * 100;          // in track percent: under ~9 the two labels would touch
    const tightDn = gap(L.dn2, L.S) < 9 ? " tight" : "", tightUp = gap(L.up2, L.R) < 9 ? " tight" : "";
    const pct = (v) => fpct((v / L.last - 1) * 100, 1);
    const inRange = clamp01((L.last - L.S) / (L.R - L.S));
    const where = inRange > 0.66 ? "closer to the ceiling" : inRange < 0.34 ? "closer to the floor" : "in the middle of the box";
    const seg = ["SPY", "QQQ", "IWM"].map((s) => `<button type="button" class="${s === pulseSym ? "on" : ""}" data-pulse-sym="${s}">${s}</button>`).join("");
    const lean = (k) => (L.trend === k ? `<em class="pl-lean">with the trend</em>` : "");
    return `<article class="pz pz-levels" data-pz="levels">
      <div class="pz-h"><span class="pz-eye">What could happen next</span><div class="pz-seg" role="tablist">${seg}</div></div>
      <p class="pl-lede"><b>${L.sym} ${fnum(L.last)}</b> is ${where}. A normal day moves it about <b>±${fnum(L.atr)}</b> (${fnum(L.atrPct, 1)}%).</p>
      <div class="pl-track" aria-hidden="true">
        <span class="pl-zone" style="left:${at(L.S)};width:calc(${at(L.R)} - ${at(L.S)})"></span>
        <span class="pl-atr" style="left:${at(L.last - L.atr)};width:calc(${at(L.last + L.atr)} - ${at(L.last - L.atr)})"></span>
        <span class="pl-mk dn2${tightDn}" style="left:${at(L.dn2)}"><i></i><b>${fnum(L.dn2)}</b></span>
        <span class="pl-mk s" style="left:${at(L.S)}"><i></i><b>${fnum(L.S)}</b><em>floor</em></span>
        <span class="pl-mk px" style="left:${at(L.last)}"><i></i><em>now ${fnum(L.last)}</em></span>
        <span class="pl-mk r" style="left:${at(L.R)}"><i></i><b>${fnum(L.R)}</b><em>ceiling</em></span>
        <span class="pl-mk up2${tightUp}" style="left:${at(L.up2)}"><i></i><b>${fnum(L.up2)}</b></span>
      </div>
      <div class="pl-legend"><span><i class="z"></i>the box</span><span><i class="a"></i>a normal day's move</span></div>
      <ol class="pl-scen">
        <li class="up"><span class="pl-if">Breaks above <b>${fnum(L.R)}</b> <small>${pct(L.R)}</small></span><span class="pl-then">Buyers take over. Next stop <b>${fnum(L.up2)}</b> ${lean("up")}</span></li>
        <li class="flat"><span class="pl-if">Stays between <b>${fnum(L.S)}</b> and <b>${fnum(L.R)}</b></span><span class="pl-then">Chop. Bounces off both edges, no real trend ${L.trend === "mixed" ? `<em class="pl-lean">trend is mixed</em>` : ""}</span></li>
        <li class="down"><span class="pl-if">Drops below <b>${fnum(L.S)}</b> <small>${pct(L.S)}</small></span><span class="pl-then">Sellers take over. Next floor <b>${fnum(L.dn2)}</b> ${lean("down")}</span></li>
      </ol>
      <div class="pz-foot">Levels are recent swing highs and lows. "If this, then that", not a prediction.</div>
    </article>`;
  }
  const VITALS = [
    ["^VIX", "Fear gauge", (q) => vixWord(q.last), (q) => (q.last >= 20 ? "warn" : "up")],
    ["^TNX", "10-yr yield", (q) => (q.chg > 0 ? "rising" : q.chg < 0 ? "easing" : "flat"), (q) => (q.chg > 0 ? "down" : q.chg < 0 ? "up" : "flat")],
    ["DX-Y.NYB", "US dollar", (q) => (q.chg > 0 ? "stronger" : q.chg < 0 ? "weaker" : "flat"), () => "flat"],
    ["CL=F", "Oil", (q) => (q.chg > 0 ? "inflation risk" : q.chg < 0 ? "relief" : "flat"), (q) => (q.chg > 0 ? "warn" : "flat")],
    ["GC=F", "Gold", (q) => (q.chg > 0 ? "safety bid" : q.chg < 0 ? "fear fading" : "flat"), () => "flat"],
    ["BTC-USD", "Bitcoin", (q) => (q.chg > 0 ? "risk-on" : q.chg < 0 ? "cooling" : "flat"), (q) => cls(q.chg)],
  ];
  function pulseVitals(r) {
    const tiles = VITALS.map(([sym, label, word, tone]) => { const m = macroOf(r, sym); if (!m) return ""; const q = qp(sym, m);
      return `<div class="pv-tile"><div class="pv-h"><span>${label}</span><em class="${tone(q)}">${esc(word(q))}</em></div><div class="pv-px">${priceHtml(sym, m)}</div>${spark(m.spark, cls(q.chg))}</div>`; }).join("");
    return `<article class="pz pz-vitals" data-pz="vitals"><div class="pz-h"><span class="pz-eye">Vital signs</span><span class="pz-hint">the things that move everything</span></div><div class="pv-grid">${tiles}</div></article>`;
  }
  function pulseSectors(r) {
    const key = { "1d": "chg_1d", "1w": "chg_5d", "1m": "chg_1m" }[pulsePeriod];
    const rows = ((r.flows || {}).sectors || []).map((x) => ({ ...x, v: pulsePeriod === "1d" ? qp(x.symbol, { chg_pct: x.chg_1d, last: x.last }).chg : x[key] })).filter((x) => isNum(x.v)).sort((a, b) => b.v - a.v);
    if (!rows.length) return "";
    const mx = Math.max(0.5, ...rows.map((x) => Math.abs(x.v)));
    const bars = rows.map((x) => { const w = (Math.abs(x.v) / mx) * 50; return `<li><span class="ps-l">${esc(x.label)}</span><span class="ps-bar"><i class="${cls(x.v)}" style="${x.v >= 0 ? `left:50%` : `right:50%`};width:${w.toFixed(1)}%"></i></span><span class="ps-v ${cls(x.v)}">${fpct(x.v, 1)}</span></li>`; }).join("");
    const seg = [["1d", "Today"], ["1w", "Week"], ["1m", "Month"]].map(([k, l]) => `<button type="button" class="${k === pulsePeriod ? "on" : ""}" data-pulse-period="${k}">${l}</button>`).join("");
    const top = rows[0], bot = rows[rows.length - 1];
    return `<article class="pz pz-sectors" data-pz="sectors"><div class="pz-h"><span class="pz-eye">Where the money went</span><div class="pz-seg">${seg}</div></div>
      <p class="pl-lede"><b class="${cls(top.v)}">${esc(top.label)}</b> led, <b class="${cls(bot.v)}">${esc(bot.label)}</b> lagged.</p><ul class="ps-list">${bars}</ul></article>`;
  }
  const RADAR = { breadth: ["More stocks joining in", "Only the giants carrying it"], size: ["Small caps winning", "Big caps preferred"], offense: ["Offense over defense", "Defense over offense"], credit: ["Bond market relaxed", "Bond market nervous"], growth: ["Growth beating fear", "Fear beating growth"], semis: ["Chips leading", "Chips lagging"] };
  function pulseRadar(r) {
    const gs = (((r.flows || {}).gauges) || []);
    const items = gs.map((g) => { if (g.key === "vixterm") { if (!isNum(g.value)) return ""; const st = g.value > 1; return `<li class="${st ? "down" : "up"}"><span class="pr-ar">${st ? "!" : "✓"}</span><span><b>${st ? "Short-term stress" : "No short-term stress"}</b><i>VIX vs 3-month VIX ${fnum(g.value, 2)}</i></span></li>`; }
      const t = RADAR[g.key]; if (!t || !isNum(g.chg_1m)) return ""; const up = g.chg_1m >= 0; const good = up;
      return `<li class="${good ? "up" : "down"}"><span class="pr-ar">${up ? "▲" : "▼"}</span><span><b>${t[up ? 0 : 1]}</b><i>${esc(g.label)} · ${fpct(g.chg_1m, 1)} in a month</i></span></li>`; }).join("");
    if (!items) return "";
    return `<article class="pz pz-radar" data-pz="radar"><div class="pz-h"><span class="pz-eye">Risk radar</span><span class="pz-hint">green = risk-on</span></div><ul class="pr-list">${items}</ul></article>`;
  }
  function pulseHeat(r) {
    const list = activeList(); if (!list.length) return "";
    const tiles = list.map((t) => { const s = (r.stocks || []).find((x) => x.ticker === t); const q = qp(t, s); const v = s ? verdictFor(s) : null;
      const ch = isNum(q.chg) && Math.abs(q.chg) < 0.05 ? 0 : q.chg;       // no "-0.0%": a move that rounds to nothing is flat
      const k = isNum(ch) ? Math.min(1, Math.abs(ch) / 4) : 0; const c = cls(ch);
      return `<button type="button" class="ph-tile ${c}" style="--k:${(0.12 + k * 0.6).toFixed(2)}" data-ticker-page="${esc(t)}"><b>${esc(t)}</b><span class="ph-chg">${isNum(ch) && ch === 0 ? "0.0%" : fpct(ch, 1)}</span>${v ? `<em>${esc(v.word)}</em>` : ""}</button>`; }).join("");
    const ups = list.filter((t) => { const s = (r.stocks || []).find((x) => x.ticker === t); return (qp(t, s).chg || 0) > 0; }).length;
    return `<article class="pz pz-heat" data-pz="heat"><div class="pz-h"><span class="pz-eye">Your watchlist · ${esc(lists.active)}</span><span class="pz-hint">${ups} of ${list.length} green · colour = size of the move</span></div><div class="ph-grid">${tiles}</div></article>`;
  }
  function pulseLine(r) {
    const spy = idxOf(r, "SPY"); const q = spy ? qp("SPY", spy) : {}; const tone = ((r.regime || {}).tone || {}).choice;
    const mv = isNum(q.chg) ? (Math.abs(q.chg) < 0.15 ? "went nowhere" : q.chg > 0 ? `rose ${fpct(q.chg, 1)}` : `fell ${fpct(Math.abs(q.chg), 1, false)}`) : "";
    const day = r.market_state === "open" ? "today" : "last session";
    return `The S&P 500 ${mv} ${day}. ${tone && EX.tone[tone] ? esc(EX.tone[tone]) : ""}`;
  }
  function secPulse(r) {
    const st = { pre: "Pre-market", open: "Market open", post: "After hours", closed: "Market closed" }[r.market_state] || "";
    return `<section class="pulse">
      <div class="pulse-head"><span class="pz-live ${r.market_state === "open" ? "on" : ""}"><i></i>${st} · updated ${esc(r.generated_at.slice(11, 16))} ET</span>
        <h2>The market in 10 seconds</h2><p>${pulseLine(r)}</p></div>
      <div class="pulse-grid">${pulseGauge(r)}${heroCrowd(r)}${heroPros(r)}${heroBets(r)}${pulseLevels(r)}${pulseVitals(r)}${pulseSectors(r)}${pulseRadar(r)}${pulseHeat(r)}</div>
      <div class="deep-h"><span>Deep dive</span><i>briefings, big money, the President's posts, the crowd and today's runners</i></div>
    </section>`;
  }
  function refreshPulse(which) {
    if (currentView !== "home" || !report) return;
    const make = { gauge: pulseGauge, levels: pulseLevels, sectors: pulseSectors, crowd: heroCrowd, pros: heroPros, bets: heroBets }[which]; const el = $(`.pz[data-pz="${which}"]`); if (!make || !el) return;
    const tmp = document.createElement("div"); tmp.innerHTML = make(report); if (tmp.firstElementChild) { tmp.firstElementChild.classList.add("no-anim"); el.replaceWith(tmp.firstElementChild); }
  }
  document.addEventListener("click", (e) => {
    const s = e.target.closest("[data-pulse-sym]"); if (s) { pulseSym = s.getAttribute("data-pulse-sym"); refreshPulse("levels"); return; }
    const p = e.target.closest("[data-pulse-period]"); if (p) { pulsePeriod = p.getAttribute("data-pulse-period"); refreshPulse("sectors"); }
  });

  function viewHtml(r) {
    switch (currentView) {
      case "home": return `<div class="view home"><div class="col-main">${secPulse(r)}${secBrief(r)}<div class="home-hero">${secBigMoney(r)}${secVoices(r)}</div>${secCrowd(r)}${secPros(r)}${secOdds(r)}<div class="home-top">${moodPanel(r)}${verdictPanel(r)}</div>${secRunners(r)}${secMeaning(r)}</div>${secToday(r)}</div>`;
      case "map": setTimeout(() => { mountMap(); if (!mapData && !mapBusy && mapSym) loadMap(mapSym); }, 0); return `<div class="view one cm-view">${secMap()}</div>`;
      case "record": return `<div class="view one">${secRecord()}</div>`;
      case "check": if (!(user && user.role === "admin")) { currentView = "home"; return viewHtml(r); } return `<div class="view one">${secCheck()}</div>`;
      case "desk": if (!(user && user.role === "admin")) { currentView = "home"; return viewHtml(r); } return `<div class="view one">${secDesk()}</div>`;
      case "guide": return `<div class="view one">${secGuide()}</div>`;
      case "watch": return `<div class="view one">${secWatchPage(r)}</div>`;
      case "ticker": return `<div class="view one ticker-view">${secTickerPage(r)}</div>`;
      case "admin": if (!(user && user.role === "admin")) { currentView = "home"; return viewHtml(r); } return `<div class="view one admin-view">${secAdmin()}</div>`;
      case "scan": return `<div class="view sub">${subTabs("scan")}<div class="subview">${subTab.scan === "lowfloat" ? secLowFloat(r) : secScan(r)}</div></div>`;
      case "stock": return `<div class="view stock">${secStocks(r)}</div>`;
      case "theme": return `<div class="view one tms-view">${secUsThemes(r)}</div>`;
      case "smart": return `<div class="view sub">${subTabs("smart")}<div class="subview">${subTab.smart === "options" ? secOptions(r) : secSmart(r)}</div></div>`;
      case "macro": return `<div class="view one ctx-view">${secContext(r)}</div>`;
      default: currentView = "home"; return viewHtml(r);
    }
  }
  function secTickerPage(r) {
    const t = tickerSel; if (!t) { currentView = "home"; return viewHtml(r); }
    const s = stockFor(t), q = (r.lite || {})[t], src = s || q || {};
    const a = (s && s.ai) || {}; const st = a.stance ? a.stance.choice : null; const it = a.intraday ? ST.intraday[a.intraday.choice] : null;
    const watched = isWatched(t);
    const hero = `<header class="tk-hero">
      <button class="btn sm ghost" data-back-home>‹ Home</button>
      <div class="tk-id"><div class="tk-sym">${esc(t)}</div><div class="tk-name">${esc(src.name || "")}${src.sector ? ` <span class="muted">· ${esc(src.sector)}</span>` : ""}${src.kind ? ` <span class="tag ${src.kind === "ETF" ? "acc" : ""}">${esc(src.kind)}</span>` : ""}</div></div>
      <div class="tk-price">${priceHtml(t, src)}<span class="muted" data-qstamp style="font-size:10px">${quoteStamp()}</span></div>
      ${verdictFor(s || (q ? { ...q, ticker: t } : null)) ? `<div class="tk-verdict">${verdictBlock(s || { ...q, ticker: t }, { whyN: 4 })}</div>` : `<div class="tk-verdict verdict flat"><div class="verdict-word">${analyzing.has(t) ? "ANALYSING" : s ? "NO VERDICT" : "QUOTE ONLY"}</div><div class="verdict-why">${analyzing.has(t) ? "About 20 seconds: history, news, smart money, options and the model reads." : s ? "The model did not return a stance for this build." : STATIC_MODE ? "Daily technicals only on the public copy." : "Press Analyze for the full model read."}</div></div>`}
      <div class="tk-actions">${!s && !STATIC_MODE ? `<button class="btn sm" data-analyze="${esc(t)}" ${analyzing.has(t) ? "disabled" : ""}>${analyzing.has(t) ? "Analysing…" : "Analyze"}</button>` : ""}<a class="btn sm ghost" href="${tvLink(t)}" target="_blank" rel="noopener">Open chart</a>${watched ? `<button class="btn sm ghost" data-remove="${esc(t)}">Remove from watchlist</button>` : `<button class="btn sm" data-add-ticker="${esc(t)}">Add to watchlist</button>`}</div>
    </header>`;
    let body;
    if (s) body = stockDetail(s, r);
    else if (q) { const tech = q.technicals || {}; body = `<div class="card"><div class="grid c4" style="border:0"><div class="tile"><div class="tile-label">Trend</div><div class="tile-value small ${{ up: "up", down: "down" }[tech.trend] || "flat"}">${tech.trend || "–"}</div></div><div class="tile"><div class="tile-label">${term("rsi", "RSI 14")}</div><div class="tile-value">${fnum(tech.rsi14, 0)}</div></div><div class="tile"><div class="tile-label">Moves a day</div><div class="tile-value">${fpct(tech.atr_pct, 1, false)}</div></div><div class="tile"><div class="tile-label">vs 20-day avg</div><div class="tile-value ${cls(tech.dist_sma20_pct)}">${fpct(tech.dist_sma20_pct, 1)}</div></div><div class="tile"><div class="tile-label">1m / 3m</div><div class="tile-value"><span class="${cls(tech.ret_1m)}">${fpct(tech.ret_1m, 1)}</span> / <span class="${cls(tech.ret_3m)}">${fpct(tech.ret_3m, 1)}</span></div></div><div class="tile"><div class="tile-label">${term("relvol", "Volume vs normal")}</div><div class="tile-value">${isNum(q.rel_volume) ? q.rel_volume.toFixed(2) + "×" : "n/a"}</div></div><div class="tile"><div class="tile-label">20-day high / low</div><div class="tile-value small">${fnum(tech.hi20)} / ${fnum(tech.lo20)}</div></div><div class="tile"><div class="tile-label">Prev high / low</div><div class="tile-value small">${fnum(tech.prev_high)} / ${fnum(tech.prev_low)}</div></div></div>${q.scan ? explain(`Intraday volume scan: ${q.scan.score.toFixed(0)}/100 on ${q.scan.lead}, ${q.scan.direction}.`) : ""}</div>`; }
    else body = `<div class="card muted">${STATIC_MODE ? "This ticker is not in the public build's data." : analyzing.has(t) ? "Analysing…" : analyzeError[t] ? "Analysis failed: " + esc(analyzeError[t]) : "Not analysed yet."}</div>`;
    return `<section class="tk-page">${hero}${body}</section>`;
  }
  function secGuide() {
    const sec = (t, body) => `<section class="gd"><h3>${t}</h3>${body}</section>`;
    const li = (items) => `<ul class="gd-list">${items.map(([k, v]) => `<li><b>${k}</b> ${v}</li>`).join("")}</ul>`;
    return `<section class="guide"><h2>How to use OneView <span class="muted">what each part shows, what to focus on, and why it matters for day, intraday and swing traders</span></h2>
      ${explain("OneView reads the market three ways: the numbers (price, volume, levels), the model's read in plain words with its reasons, and the crowd (Reddit, StockTwits, the President's posts). Everything is information, not advice.")}
      ${sec("Start here", li([["Sign in.", "Enter your email, open the one-time link on the device you use. No password."], ["Watchlist.", "Add the names you follow (ticker or company name). The desk personalises around that list."], ["Every morning at 07:00 ET", "the briefing lands at the top of the Overview: the numbers and the reads on your names."]]))}
      ${sec("The Overview, top to bottom", li([["Briefings.", "Morning at 07:00: futures, oil, gold, bitcoin, 10- and 5-year yields, mega caps, the President's market-relevant posts, today's events, and for SPY and QQQ what we see on the 1-hour chart, the likeliest next 1 to 4 hours and the levels that decide it. Middle card: a direction read every 15 minutes of the session (Higher, Lower, Sideways into the close, with the reason). After the close at 16:30: what the session did and a scorecard of the day's reads."], ["Where the big money is moving.", "SPY, QQQ, DIA and IWM against their normal activity for the time of day, the largest companies trading unusually heavily, and the groups leading or lagging."], ["Voices moving the tape.", "The President's posts read once each, and where the Reddit crowd is piling in."], ["StockTwits crowd.", "The crowd's mood on SPY, QQQ and the largest names (0 to 100), how loud the chatter is, and what is trending."], ["Market mood and assessments.", "The overall tape, then one line per name on your list: swing read, today's read, the first reason, and LOW, MED or HIGH conviction. Never a percentage."], ["Small-cap runners.", "Smaller names trading far above normal or changing hands fast, with a sensible play."], ["Today's numbers in plain words.", "Futures, VIX, yields, the dollar, breadth, overseas markets, one sentence each."], ["News that can move the market.", "Every headline read once; only the ones that can move prices stay."]]))}
      ${sec("The other sections", li([["Watchlist.", "One row per name with its price, a 30-day chart, the read and a setup score. Click a row for its full story on the right: the chart, the day, swing and long-term reads, the trade plan and the key numbers. Filter by bullish, neutral or bearish, sort by movers or best setup, and use the arrow keys to move through the list. The Day / Swing / Long term switch changes every read at once."], ["Scanner.", "Names trading far above normal on the 15-minute to 2-hour charts, plus thin low-float names that move violently."], ["Stocks.", "Every analysed name in one table, full breakdown on click."], ["Themes.", "The data-centre build-out by part of the stack, who leads and who could run next."], ["Filings & flow.", "Insiders, big holders and Congress, each source's delay stated, plus options flow."], ["Market context.", "The bigger picture in one screen: the primary trend, the asset race over 1 to 12 months, the yield curve, how many stocks are joining in, where money is rotating between sectors, and the weekly index charts."], ["Company map.", "Type a company such as NVIDIA: a draggable map of its customers, suppliers, partners and rivals with single points of failure marked, where its money went, four years of growth, the balance sheet, its biggest customers from the annual report, the spending wave flowing in, and what the price assumes. Click any company on the map to map it next."], ["Track record.", "Every verdict and every direction read scored against what the market did, day by day."], ["The crowd and the betting markets.", "On the Overview: about 200 StockTwits posts per name read into a bull/bear split, the shift and the hot topics, plus Polymarket and Kalshi odds on the Fed, the next S&P 500 and Nasdaq close, and your names. Every bet shows the money behind it; under $1,000 is marked thin."]]))}
      ${sec("What to focus on", li([["Day and intraday traders:", "the morning levels for SPY and QQQ, the Intraday direction card, the Scanner, Small-cap runners and Where the big money is moving. Trade the levels, not the words."], ["Swing traders:", "Assessments and the swing column on your cards (BUY, BUY THE DIP, WAIT FOR BREAKOUT, HOLD, AVOID with reasons), Filings & flow, and the after-close briefing."], ["Longer horizons:", "the long-term column, Themes, Market context, and the crowd mood as a contrarian check when it is extreme."]]))}
      ${sec("What sets it apart", li([["Plain words with reasons.", "Two to four reasons per read and a conviction word instead of a fake-precision percentage."], ["The right kind of call.", "Funds get a trend read, big companies a momentum read, everything else the model's stance."], ["Three feeds in one place.", "The numbers, the model, and the crowd."], ["A public scorecard.", "The desk logs every call with its price and grades itself after the close."], ["One price everywhere.", "Every panel reads from the same quote store, 15-minute delayed, time stamped."]]))}
      <div class="meta2">Information, not advice. Data is delayed and can be wrong. Reads are probabilities, not predictions. You decide what to trade and you carry the risk.</div>
    </section>`;
  }
  // FIX 5: alerts settings, saved on this device only. Push delivery is a later step; nothing is sent from here yet.
  const ALERTS_KEY = "mu-alerts";
  function loadAlerts() { try { const j = JSON.parse(localStorage.getItem(ALERTS_KEY) || "null"); if (j && j.lists) return j; } catch (e) {} return { lists: {}, updated: null }; }
  function saveAlerts(a) { a.updated = new Date().toISOString(); try { localStorage.setItem(ALERTS_KEY, JSON.stringify(a)); } catch (e) {} }
  function alertLists() { const names = lists && lists.lists ? Object.keys(lists.lists) : []; return names.length ? names : ["Tech", "Banks"]; }
  function openAlerts() {
    let m = $("#alerts-modal");
    if (!m) { m = document.createElement("div"); m.id = "alerts-modal"; m.className = "modal"; m.setAttribute("role", "dialog"); m.setAttribute("aria-modal", "true"); m.setAttribute("aria-labelledby", "alerts-title"); document.body.appendChild(m); }
    const a = loadAlerts();
    const rows = alertLists().map((name) => { const c = a.lists[name] || { enabled: false, threshold: 3 }; return `<li class="al-row"><label class="al-name"><input type="checkbox" data-al-on="${esc(name)}" ${c.enabled ? "checked" : ""}> <b>${esc(name)}</b></label><label class="al-th">alert when a name trades <input type="number" min="1.5" max="20" step="0.5" value="${isNum(c.threshold) ? c.threshold : 3}" data-al-th="${esc(name)}" aria-label="Volume threshold for ${esc(name)}"> × its average volume</label></li>`; }).join("");
    m.innerHTML = `<div class="modal-card"><div class="modal-h"><h3 id="alerts-title">Volume alerts <span class="pro-badge">Pro</span></h3><button type="button" class="gate-x" data-alerts-close aria-label="Close">×</button></div>
      <p class="muted">Pick the watchlists to watch and the volume spike that should trigger an alert, as a multiple of each name's average volume. Settings are saved on this device. <b>Push delivery is coming later</b>: this is the settings screen only, nothing is sent yet.</p>
      <ul class="al-list">${rows}</ul>
      <div class="modal-actions"><button type="button" class="btn" data-alerts-save>Save settings</button><span class="meta2" id="alerts-status">${a.updated ? "Saved " + new Date(a.updated).toLocaleString() : "Not saved yet"}</span></div></div>`;
    m.hidden = false;
    const close = () => { m.hidden = true; const b = $("#alerts-btn"); if (b) b.focus(); };
    m.querySelector("[data-alerts-close]").addEventListener("click", close);
    m.addEventListener("click", (e) => { if (e.target === m) close(); });
    m.querySelector("[data-alerts-save]").addEventListener("click", () => {
      const out = { lists: {} };
      m.querySelectorAll("[data-al-on]").forEach((cb) => { const name = cb.getAttribute("data-al-on"); const th = parseFloat((m.querySelector(`[data-al-th="${CSS.escape(name)}"]`) || {}).value); out.lists[name] = { enabled: cb.checked, threshold: isNum(th) ? Math.min(20, Math.max(1.5, th)) : 3 }; });
      saveAlerts(out); const st = $("#alerts-status"); if (st) st.textContent = "Saved " + new Date(out.updated).toLocaleString() + " · delivery coming later";
    });
    const onKey = (e) => { if (e.key === "Escape") { close(); removeEventListener("keydown", onKey); } }; addEventListener("keydown", onKey);
    const first = m.querySelector("input"); if (first) first.focus();
  }
  let recordData = null;
  async function loadRecord() { try { const res = await api("/api/track-record", { cache: "no-store" }); if (res.ok) { recordData = await res.json(); if (currentView === "record") renderAll(); } } catch (e) {} }
  function secRecord() {
    if (STATIC_MODE) return `<section><h2>Track record</h2><div class="muted">The scored history lives on the app server.</div></section>`;
    const j = recordData; if (!j) { loadRecord(); return `<section><h2>Track record</h2><div class="muted">Loading the scored history…</div></section>`; }
    const T = j.totals || {}; const rate = (h, n) => (n ? Math.round(h / n * 100) + "%" : "–"); const pct = (x) => (isNum(x) ? fpct(x, 1) : "–");
    const tile = (l, v, sub) => `<div class="tile"><div class="tile-label">${l}</div><div class="tile-value">${v}</div><div class="tile-sub">${sub || ""}</div></div>`;
    const byv = (j.by_verdict || []).map((x) => `<tr><td>${esc(x.kind)}</td><td><b>${esc(pretty(x.verdict))}</b></td><td class="num">${x.n}</td><td class="num">${x.scored || 0}</td><td class="num">${x.hits || 0}</td><td class="num"><b>${rate(x.hits || 0, x.scored || 0)}</b></td><td class="num ${cls(x.avg_move_pct)}">${pct(x.avg_move_pct)}</td></tr>`).join("") || '<tr><td colspan="7" class="muted">No calls scored yet: the first swing windows close 7 days after the first build with the ledger on.</td></tr>';
    const byt = (j.by_ticker || []).map((x) => `<tr class="clickable" data-ticker-page="${esc(x.ticker)}"><td><b>${esc(x.ticker)}</b></td><td class="num">${x.n}</td><td class="num">${x.scored || 0}</td><td class="num">${x.hits || 0}</td><td class="num"><b>${rate(x.hits || 0, x.scored || 0)}</b></td><td class="num ${cls(x.avg_move_pct)}">${pct(x.avg_move_pct)}</td></tr>`).join("") || '<tr><td colspan="6" class="muted">Nothing scored yet.</td></tr>';
    const rec = (j.recent || []).map((x) => `<tr class="clickable" data-ticker-page="${esc(x.ticker)}"><td class="mono">${new Date(x.ts * 1000).toLocaleString()}</td><td><b>${esc(x.ticker)}</b></td><td>${esc(x.kind)}</td><td>${esc(pretty(x.verdict))}</td><td class="num">${fnum(x.price)}</td><td class="num">${fnum(x.eval_price)}</td><td class="${x.hit === 1 ? "up" : x.hit === 0 ? "down" : "muted"}">${x.hit === 1 ? "hit" : x.hit === 0 ? "miss" : x.eval_ts ? "no direction" : "open"}</td></tr>`).join("");
    return `<section class="record"><h2>Track record <span class="muted">every verdict, scored against the price after its window · public page: <a href="${esc(API || "")}/track-record" target="_blank" rel="noopener">${esc((API || location.origin) + "/track-record")}</a></span></h2>
      ${explain("Each time the desk publishes a verdict, the price at that moment is written down. After the window closes (1 day for a day-trade read, 7 days for a swing read, 90 days for a long-term view) the price is checked again. Up after a bullish call, or down after a bearish one, counts as a hit. Calls with no direction (wait, hold, range, flat) are listed but not scored. This is the desk keeping itself honest, not advice.")}
      <div class="grid c3" style="margin-bottom:12px">${tile("Calls logged", T.n || 0, T.since ? "since " + new Date(T.since * 1000).toLocaleDateString() : "")}${tile("Scored so far", T.scored || 0, "windows that have closed")}${tile("Hit rate", rate(T.hits || 0, T.scored || 0), `${T.hits || 0} hits`)}</div>
      <h3>By verdict</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Window</th><th>Verdict</th><th>Calls</th><th>Scored</th><th>Hits</th><th>Hit rate</th><th>Avg move</th></tr></thead><tbody>${byv}</tbody></table></div>
      <h3 style="margin-top:14px">By name</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Calls</th><th>Scored</th><th>Hits</th><th>Hit rate</th><th>Avg move</th></tr></thead><tbody>${byt}</tbody></table></div>
      ${j.direction ? (() => { const md = Object.fromEntries((j.analysis_days || []).map((x) => [x.day, x])); return `<h3 style="margin-top:14px">Market direction, day by day <span class="muted">the morning call and every 15-minute read, scored at the close · click a day</span></h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Day</th><th>Morning call</th><th>Intraday reads</th><th>Scored</th><th>Hits</th><th>Hit rate</th></tr></thead><tbody>${(j.direction.by_day || []).map((x) => { const m = md[x.day] || {}; return `<tr class="clickable" data-day="${esc(x.day)}"><td>${esc(x.day)}</td><td>${m.morning_scored ? (m.morning_hits ? '<span class="up">hit</span>' : '<span class="down">miss</span>') : (m.morning_calls ? "open" : "–")}</td><td class="num">${x.n}</td><td class="num">${x.scored || 0}</td><td class="num">${x.hits || 0}</td><td class="num"><b>${rate(x.hits || 0, x.scored || 0)}</b></td></tr><tr class="day-detail" data-day-detail="${esc(x.day)}" hidden><td colspan="6"><div class="muted">Loading…</div></td></tr>`; }).join("") || '<tr><td colspan="6" class="muted">No reads yet. The first session with the desk running fills this in.</td></tr>'}</tbody></table></div>`; })() : ""}
      <h3 style="margin-top:14px">Most recent calls</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Name</th><th>Window</th><th>Verdict</th><th>Price then</th><th>Price after</th><th>Result</th></tr></thead><tbody>${rec || '<tr><td colspan="7" class="muted">No calls logged yet.</td></tr>'}</tbody></table></div></section>`;
  }
  async function pollAdmin() {
    if (STATIC_MODE || !user || user.role !== "admin") return;
    try { const res = await api("/api/admin/overview", { cache: "no-store" }); if (res.ok) { adminData = await res.json(); if (currentView === "admin") renderAll(); } } catch (e) {}
    try { const r2 = await api("/api/stocktwits/status", { cache: "no-store" }); if (r2.ok) { const j = await r2.json(); const el = $("#st-status"); if (el) el.textContent = j.connected ? `Connected · token renews itself · callback ${j.callback}` : `Not connected yet. The sign-in returns to ${j.callback}.`; } } catch (e) {}
  }
  const ago = (t) => { if (!t) return "–"; const s = Math.max(0, (Date.now() / 1000) - t); return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${(s / 3600).toFixed(1)} h ago` : `${Math.round(s / 86400)} d ago`; };
  let deskData = null, deskOpen = null, deskScope = "mine", deskScan = null, deskScanTimer = null, deskScanFilter = "all";
  async function loadDeskScan(start) {
    if (STATIC_MODE) return;
    try {
      const res = await api("/api/desk/scan", start ? { method: "POST" } : { cache: "no-store" });
      const j = await res.json();
      deskScan = j;
      if (j.status === "running") { if (!deskScanTimer) deskScanTimer = setInterval(() => loadDeskScan(false), 5000); }
      else if (deskScanTimer) { clearInterval(deskScanTimer); deskScanTimer = null; }
      if (currentView === "desk") renderAll();
    } catch (e) {}
  }
  const GAUGE_NAMES = { "RSP/SPY": "Breadth: equal vs cap weight", "10Y-2Y": "Yield curve", "HYG/LQD": "Credit: junk vs safe bonds", "IWM/SPY": "Small caps vs large", "SPY/TLT": "Stocks vs bonds", "XLY/XLP": "Cyclicals vs staples" };
  function gaugeDetail(t) {
    const x = String(t || "");
    const m = x.match(/ratio (above|below) SMA(\d+), SMA\d+ (rising|falling)/);
    if (m) return `${m[1]} its ${m[2]}-day average, which is ${m[3]}`;
    const sp = x.match(/spread ([+-]?[\d.]+),? ?(steepening|flattening)?/);
    if (sp) return `${sp[1]} points${sp[2] ? ", " + sp[2] : ""}${/level only/.test(x) ? " (level only)" : ""}`;
    return x;
  }
  function skelRows(n, cols) { return Array.from({ length: n }, (_, i) => `<tr class="skel-row" style="--i:${i}"><td colspan="${cols}"><div class="skel"></div></td></tr>`).join(""); }
  function deskRow(c, opts) {
    const o = opts || {}; const held = !!deskHold[c.ticker]; const dec = o.flatOnly ? c.flat : held ? c.holding : c.flat;
    const key = (o.prefix || "") + c.ticker; const open = deskOpen === key; const fl = c.flags || {}; const ind = c.indicators || {};
    const flagList = [...(fl.rebound || []).map((x) => ["ok", "Bounce", x]), ...(fl.exhaustion || []).map((x) => ["warn2", "Tiring", x]), ...(fl.bearish || []).map((x) => ["warn", "Weak", x])];
    const bucketWord = { mega: "Mega cap", large: "Large cap", mid: "Mid cap" };
    const capTxt = isNum(c.market_cap) ? (c.market_cap >= 1e12 ? "$" + (c.market_cap / 1e12).toFixed(1) + "T" : "$" + (c.market_cap / 1e9).toFixed(0) + "B") : "";
    const extra = o.scan ? `<td class="col-size small">${esc(bucketWord[c.bucket] || c.bucket || "")}${capTxt ? `<div class="meta2">${capTxt}</div>` : ""}</td><td class="col-sector small">${esc(c.sector || "")}</td>` : "";
    const cols = (o.scan ? 9 : 8) + (o.pro ? 6 : 0);
    const kv = [["Price", fnum(c.price)], ["20-day line", fnum(ind.ema20)], ["50-day line", fnum(ind.ema50)], ["200-day line", fnum(ind.ema200)], ["RSI (14)", isNum(ind.rsi14) ? ind.rsi14.toFixed(0) : "–"], ["MACD histogram", isNum(ind.macd_hist) ? ind.macd_hist.toFixed(2) : "–"], ["Stretch vs 20-day", fpct(fl.stretch_pct, 1)], ["Bollinger %B", isNum(ind.percent_b) ? ind.percent_b.toFixed(2) : "–"], ["Daily bars", c.n_bars || "–"]];
    return `<tr class="desk-row ${open ? "open" : ""}" data-desk-open="${esc(key)}" data-sym="${esc(c.ticker)}"><td class="sym"><b>${esc(c.ticker)}</b><div class="meta2">${esc(c.name || "")}</div></td>${extra}
        <td class="num mono col-price">${fnum(c.price)}</td>
        <td class="col-meter" data-l="Trend">${pillarMeter(c.trend.score)}</td><td class="col-meter" data-l="Momentum">${pillarMeter(c.momentum.score)}</td><td class="col-meter col-macro" data-l="Macro">${pillarMeter(c.macro)}</td>
        <td class="num col-total"><span class="tot ${c.total > 0 ? "up" : c.total < 0 ? "down" : ""}">${c.total > 0 ? "+" : ""}${c.total}</span>${o.max != null ? `<span class="tot-max">/ ${o.max > 0 ? "+" : ""}${o.max}</span>` : ""}</td>
        ${o.pro ? proCells(c) : ""}
        <td class="col-read"><span class="pill ${dec.cls}">${esc(dec.word)}</span>${c.source === "tradingview" ? ' <span class="src-badge tv" title="Scored on daily bars read from TradingView Desktop">TV</span>' : ""}${fl.death_cross ? ' <span class="tag warn" title="50-day line below the 200-day line and price below the 50-day">downtrend</span>' : ""}</td>
        ${o.flatOnly ? "" : `<td class="col-you"><button class="hold-btn ${held ? "on" : ""}" type="button" data-desk-hold="${esc(c.ticker)}" title="Tell the desk which side you are on. The read changes between 'should I get in' and 'should I stay in'."><span class="hold-dot"></span>${held ? "I hold it" : "I'm flat"}</button></td>`}</tr>
        ${open ? `<tr class="desk-detail"><td colspan="${cols}"><div class="dd-grid">
          <div class="dd-main"><div class="dd-head"><span class="pill ${dec.cls}">${esc(dec.word)}</span><span class="muted">${o.flatOnly || !held ? "read for someone who is flat" : "read for someone who holds it"}</span></div>
            <p class="dd-plain">${esc(dec.plain)}</p><p class="dd-frame">${esc(dec.rationale)} ${esc(dec.framing)}</p>
            <div class="dd-flags">${flagList.length ? flagList.map(([k, l, x]) => `<span class="flag ${k}"><b>${l}</b> ${esc(x)}</span>`).join("") : '<span class="muted">No bounce, tiring or weakness signals right now.</span>'}</div>
            <div class="dd-detail muted">Trend: ${esc(c.trend.detail)} · Momentum: ${esc(c.momentum.detail)}</div></div>
          <dl class="dd-ind">${kv.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>
        </div></td></tr>` : ""}`;
  }
  function secDeskScan(d) {
    const S = deskScan; const running = S && S.status === "running";
    const btn = `<button class="btn primary" type="button" data-desk-scan ${running ? "disabled" : ""}>${running ? "Scanning…" : S && S.status === "ok" ? "Scan again" : "Scan mid to mega caps"}</button>`;
    let body = "";
    if (!S || S.status === "none") body = `<p class="lede">Runs the rulebook over every S&amp;P 500 and S&amp;P 400 name, about 900 stocks from mid cap to mega cap, and keeps the ones where trend and momentum are both positive. About a minute.</p>`;
    else if (S.status === "loading") body = `<table class="tbl"><tbody>${skelRows(3, 9)}</tbody></table>`;
    else if (running) body = `<p class="lede">Downloading two years of daily bars for about 900 names and scoring them${S.started ? ` · ${Math.round(Date.now() / 1000 - S.started)} s` : ""}</p><table class="tbl"><tbody>${skelRows(4, 9)}</tbody></table>`;
    else if (S.status === "error") body = `<p class="lede down">The scan failed: ${esc(S.detail || "")}. Press the button to try again.</p>`;
    else if (S.status === "warming") body = `<p class="lede">The first report is still building; try again in a minute.</p>`;
    else if (S.status === "ok") {
      const R = S.by_read || {}, B = S.by_bucket || {};
      const filters = [["all", "All strong", S.strong_total || 0], ["re_entry", "Fresh entry", R.re_entry || 0], ["tactical_rebound", "Quick bounce", R.tactical_rebound || 0], ["wait", "Healthy, wait", R.wait || 0], ["mega", "Mega cap", B.mega || 0], ["mid", "Mid cap", B.mid || 0]];
      let rows = S.strong || [];
      if (["re_entry", "tactical_rebound", "wait"].includes(deskScanFilter)) rows = rows.filter((c) => c.flat.code === deskScanFilter);
      else if (["mega", "mid"].includes(deskScanFilter)) rows = rows.filter((c) => c.bucket === deskScanFilter);
      const dist = Object.entries(S.distribution || {}).map(([k, v]) => [Number(k), v]).sort((a, b) => a[0] - b[0]);
      const total = dist.reduce((a, [, v]) => a + v, 0) || 1;
      const bar = dist.map(([k, v]) => `<span class="dseg ${k >= 3 ? "up" : k <= -3 ? "down" : k > 0 ? "up2" : k < 0 ? "down2" : ""}" style="flex:${v}" title="${k > 0 ? "+" : ""}${k}: ${v} names"></span>`).join("");
      const labels = dist.map(([k, v]) => `<span style="flex:${v}"><b>${k > 0 ? "+" : ""}${k}</b><i>${v}</i></span>`).join("");
      body = `<div class="scan-result">
        <div class="scan-hero"><div class="scan-n"><b>${S.strong_total}</b><span>strong of ${S.usable} scored</span></div><ul class="scan-meaning">${(S.meaning || []).map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>
        <div class="dist"><div class="dist-bar">${bar}</div><div class="dist-labels">${labels}</div><div class="meta2">How all ${S.usable} names score, from −4 on the left to +4 on the right. Strong names are the two right-hand groups.</div></div>
        <div class="seg">${filters.map(([k, l, n]) => `<button class="seg-btn ${deskScanFilter === k ? "active" : ""}" type="button" data-desk-scan-filter="${k}">${l}<em>${n}</em></button>`).join("")}</div>
        <div class="tbl-wrap"><table class="tbl desk-tbl"><thead><tr><th>Name</th><th class="col-size">Size</th><th class="col-sector">Sector</th><th class="num">Price</th><th class="col-meter">Trend</th><th class="col-meter">Momentum</th><th class="col-meter col-macro">Macro</th><th class="num">Total</th>${deskPro ? proHead() : ""}<th>Read</th></tr></thead><tbody>${rows.map((c) => deskRow(c, { scan: true, flatOnly: true, prefix: "scan:", max: S.max_total, pro: deskPro })).join("") || '<tr><td colspan="9" class="muted empty">Nothing in this group right now.</td></tr>'}</tbody></table></div>
        <div class="meta2">Universe: ${esc(S.universe || "")}. Kept: ${esc(S.criteria || "")}. Scanned ${esc((S.generated_at || "").slice(11, 16))} ET; a result is reused for 30 minutes. Click a row for the reasons.</div></div>`;
    }
    const tv = "";
    return `<section class="panel scan"><div class="scan-head"><div><h3>Mid cap to mega cap scan</h3><div class="kicker">Which big names score high on all three, out of how many, and what it means</div></div>${btn}</div>${body}${tv}</section>`;
  }
  let deskHold = {}; try { deskHold = JSON.parse(localStorage.getItem("mu-desk-hold") || "{}") || {}; } catch (e) { deskHold = {}; }
  function toggleHold(t) { deskHold[t] = !deskHold[t]; try { localStorage.setItem("mu-desk-hold", JSON.stringify(deskHold)); } catch (e) {} rerenderDesk(); }
  async function loadDesk() {
    if (STATIC_MODE) return;
    try { const res = await api("/api/desk", { cache: "no-store" }); if (res.ok) { deskData = await res.json(); if (currentView === "desk") rerenderDesk(); } } catch (e) {}
  }
  function pillarMeter(v) {
    const n = isNum(v) ? Math.max(-2, Math.min(2, Math.round(v))) : null;
    const cells = [-2, -1, 0, 1, 2].map((k) => { let cls = ""; if (n != null) { if (n > 0 && k > 0 && k <= n) cls = "up"; else if (n < 0 && k < 0 && k >= n) cls = "down"; else if (n === 0 && k === 0) cls = "zero"; } return `<i class="${cls}"></i>`; }).join("");
    return `<span class="meter" title="${n == null ? "no data" : (n > 0 ? "+" : "") + n + " on a scale from −2 to +2"}"><span class="meter-cells">${cells}</span><span class="meter-n ${n > 0 ? "up" : n < 0 ? "down" : ""}">${n == null ? "–" : n > 0 ? "+" + n : n}</span></span>`;
  }
  function wireDesk() {
    document.querySelectorAll("[data-desk-hold]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); toggleHold(b.getAttribute("data-desk-hold")); }));
    document.querySelectorAll("[data-desk-open]").forEach((b) => b.addEventListener("click", () => { const t = b.getAttribute("data-desk-open"); deskOpen = deskOpen === t ? null : t; rerenderDesk(); }));
    const pt = $("[data-desk-pro]"); if (pt) pt.addEventListener("click", () => { deskPro = !deskPro; try { localStorage.setItem("mu-desk-pro", deskPro ? "1" : "0"); } catch (e) {} rerenderDesk(); });
    document.querySelectorAll("[data-desk-jump]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); const t = b.getAttribute("data-desk-jump"); deskScope = "mine"; deskOpen = t; rerenderDesk(); const row = document.querySelector(`.desk-main tr[data-sym="${t}"]`); if (row) row.scrollIntoView({ block: "center", behavior: "smooth" }); }));
    const fb = $("[data-desk-find]"); if (fb) { fb.addEventListener("input", () => { deskFind = fb.value; applyDeskFind(); }); if (deskFind) applyDeskFind(); }
    const scb = $("[data-desk-scan]"); if (scb) scb.addEventListener("click", () => { deskScan = { status: "running", started: Date.now() / 1000 }; rerenderDesk(); loadDeskScan(true); });
    document.querySelectorAll("[data-desk-scan-filter]").forEach((b) => b.addEventListener("click", () => { deskScanFilter = b.getAttribute("data-desk-scan-filter"); rerenderDesk(); }));
    const tvb = $("[data-desk-tv]"); if (tvb) tvb.addEventListener("click", async () => {
      const d = deskData || {}; const mine = new Set(((lists && lists.lists && lists.lists[lists.active]) || []).map((x) => (typeof x === "string" ? x : x.ticker || "").toUpperCase()));
      let syms = (d.cards || []).filter((c) => deskScope === "mine" ? mine.has(c.ticker) : deskScope === "index" ? (d.index || []).includes(c.ticker) || (d.sectors || []).includes(c.ticker) : true).map((c) => c.ticker);
      if (deskScope === "mine") syms = [...new Set([...syms, ...mine])];
      syms = syms.slice(0, d.tv_max || 12);
      const msg = $("#desk-tv-msg"); tvb.disabled = true; if (msg) msg.textContent = `Reading ${syms.length} names from your TradingView chart… about ${Math.ceil(syms.length * 12 / 60)} min.`;
      try {
        const res = await api("/api/desk/tv", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: syms }) });
        const j = await res.json();
        if (j.status === "ok") { (j.cards || []).forEach((c) => { const i = (deskData.cards || []).findIndex((x) => x.ticker === c.ticker); if (i >= 0) deskData.cards[i] = c; else deskData.cards.push(c); }); rerenderDesk(); const m2 = $("#desk-tv-msg"); if (m2) m2.textContent = `Done: ${(j.pulled || []).length} re-scored from TradingView${(j.missing || []).length ? ", not found: " + j.missing.join(", ") : ""}.`; }
        else if (msg) msg.textContent = j.detail || j.status;
      } catch (e) { if (msg) msg.textContent = "The pull failed."; }
      tvb.disabled = false;
    });
    document.querySelectorAll("[data-desk-scope]").forEach((b) => b.addEventListener("click", () => { deskScope = b.getAttribute("data-desk-scope"); rerenderDesk(); }));
  }
  let deskFind = "";
  // Re-draw only the desk section. The view pane (the scroller) stays put, so nothing jumps.
  function rerenderDesk() {
    const sec = $("#app .desk");
    if (!sec) { renderAll(); return; }
    sec.outerHTML = secDesk();
    wireDesk();
  }
  let deskPro = false; try { deskPro = localStorage.getItem("mu-desk-pro") === "1"; } catch (e) {}
  function proHead() { return `<th class="col-pro num" title="One-month return minus the S&amp;P 500's">vs S&amp;P 1m</th><th class="col-pro num" title="Three-month return minus the S&amp;P 500's">vs S&amp;P 3m</th><th class="col-pro num" title="Today's volume against the 20-day average">Vol ×</th><th class="col-pro num" title="Average money traded per day, last 20 days">$/day</th><th class="col-pro num" title="Distance below the 52-week high">52w</th><th class="col-pro num" title="Days to the next earnings report, when known">Earn</th>`; }
  function proCells(c) {
    const st = c.stats || {}; const rel = (x) => (isNum(x) ? `<span class="${x > 0 ? "up" : x < 0 ? "down" : ""}">${fpct(x, 1)}</span>` : "–");
    const money = isNum(st.dollar_vol) ? (st.dollar_vol >= 1e9 ? "$" + (st.dollar_vol / 1e9).toFixed(1) + "B" : "$" + (st.dollar_vol / 1e6).toFixed(0) + "M") : "–";
    const vr = isNum(st.vol_ratio) ? `<span class="${st.vol_ratio >= 1.5 ? "up" : st.vol_ratio < 0.7 ? "muted" : ""}">${st.vol_ratio.toFixed(1)}×</span>` : "–";
    const earn = isNum(st.days_to_earnings) ? `<span class="${st.days_to_earnings <= 5 ? "down" : ""}">${st.days_to_earnings}d</span>` : "–";
    return `<td class="col-pro num mono">${rel(st.rel_1m)}</td><td class="col-pro num mono">${rel(st.rel_3m)}</td><td class="col-pro num mono">${vr}</td><td class="col-pro num mono">${money}</td><td class="col-pro num mono">${isNum(st.pct_from_hi52) ? fpct(st.pct_from_hi52, 1) : "–"}</td><td class="col-pro num mono">${earn}</td>`;
  }
  function applyDeskFind() { const q = deskFind.trim().toUpperCase(); document.querySelectorAll(".desk-main tr[data-sym]").forEach((tr) => { const hit = !q || tr.getAttribute("data-sym").includes(q) || (tr.querySelector(".meta2") || {}).textContent.toUpperCase().includes(q); tr.hidden = !hit; const det = tr.nextElementSibling; if (det && det.classList.contains("desk-detail")) det.hidden = !hit; }); }
  function secDesk() {
    if (STATIC_MODE) return `<section class="desk"><div class="panel empty-state"><h3>Trading desk</h3><p>The desk runs on the app server. Open the app link rather than the static copy.</p></div></section>`;
    const d = deskData;
    const isAdmin = user && user.role === "admin";
    const head = (meta) => `<div class="desk-head"><div><div class="kicker">Three scores per name · one fixed rulebook</div><p class="lede">Trend, momentum and the market backdrop, each from −2 to +2, turned into one read per name by a published rulebook. Information, not advice.</p></div><div class="desk-meta">${meta}</div></div>`;
    if (!d) { loadDesk(); return `<section class="desk">${head('<span class="muted">Loading…</span>')}<div class="panel"><table class="tbl"><tbody>${skelRows(6, 8)}</tbody></table></div></section>`; }
    if (d.status !== "ok") return `<section class="desk">${head('<span class="muted">Warming up</span>')}<div class="panel empty-state"><h3>First scorecards on the way</h3><p>They arrive about a minute after the first report build. This page refreshes on its own.</p></div></section>`;
    if (isAdmin && deskScan === null) { deskScan = { status: "loading" }; loadDeskScan(false); }
    const m = d.macro || {}; const mc = m.pillar > 0 ? "up" : m.pillar < 0 ? "down" : "flat";
    const mine = new Set(((lists && lists.lists && lists.lists[lists.active]) || []).map((x) => (typeof x === "string" ? x : x.ticker || "").toUpperCase()));
    const byT = {}; (d.cards || []).forEach((c) => { byT[c.ticker] = c; });
    const scopes = [["mine", lists && lists.active ? lists.active : "My list", [...mine].filter((t) => byT[t]).length], ["index", "Indexes & sectors", (d.cards || []).filter((c) => (d.index || []).includes(c.ticker) || (d.sectors || []).includes(c.ticker)).length], ["all", "Everything", (d.cards || []).length]];
    let cards = d.cards || [];
    if (deskScope === "mine") cards = cards.filter((c) => mine.has(c.ticker));
    else if (deskScope === "index") cards = cards.filter((c) => (d.index || []).includes(c.ticker) || (d.sectors || []).includes(c.ticker));
    const missing = deskScope === "mine" ? [...mine].filter((t) => !byT[t]) : [];
    const gauges = (m.components || []).map((c) => `<li class="gauge ${!c.available ? "na" : c.signal > 0 ? "up" : c.signal < 0 ? "down" : "flat"}" title="${esc(c.ratio)}: ${esc(c.available ? gaugeDetail(c.detail) : "no data")}"><span class="g-arrow" aria-hidden="true">${!c.available ? "·" : c.signal > 0 ? "▲" : c.signal < 0 ? "▼" : "▬"}</span><span class="g-text"><span class="g-name">${esc(GAUGE_NAMES[c.ratio] || c.name)}</span><span class="g-detail">${esc(c.plain || (c.available ? gaugeDetail(c.detail) : "no data"))}</span></span></li>`).join("");
    const counts = Object.entries(d.counts || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => { const w = (DESK_WORDS[k] || pretty(k)); return `<span class="cnt-chip"><b>${v}</b>${esc(w)}</span>`; }).join("");
    const maxTotal = isNum(m.pillar) ? 4 + m.pillar : null;
    const rows = cards.map((c) => deskRow(c, { max: maxTotal, pro: deskPro })).join("");
    // your run today: what the rulebook says about the active list, grouped by what to do
    const mineCards = (d.cards || []).filter((c) => mine.has(c.ticker));
    const side = (c) => (deskHold[c.ticker] ? c.holding : c.flat);
    const grp = (codes) => mineCards.filter((c) => codes.includes(side(c).code));
    const runGroups = [["Act on", grp(["re_entry"]), "up", "bounce with healthy structure: confirm with a strong day and heavy trading"], ["Protect", grp(["exit_trim", "exit"]), "down", "you hold it and the rulebook says take profit or leave"], ["Careful", grp(["tactical_rebound", "hold_review"]), "caution", "quick bounce or weakening hold: small size, tight leash"], ["Sit tight", grp(["wait", "hold_ride"]), "flat", "healthy but no fresh trigger: wait for a pullback, or hold and watch"], ["Leave alone", grp(["stay_out", "observe"]), "flat", "nothing to do"]];
    const weakening = mineCards.filter((c) => ((c.flags || {}).bearish || []).length >= 2 && !["stay_out", "exit", "exit_trim"].includes(side(c).code));
    const runHtml = mineCards.length ? `<ol class="run-list">${runGroups.filter(([, xs]) => xs.length).map(([l, xs, cls, why]) => `<li><span class="pill ${cls}">${l}</span><span class="run-names">${xs.map((c) => `<b data-desk-jump="${esc(c.ticker)}">${esc(c.ticker)}</b>`).join(" ")}</span><span class="run-why">${why}</span></li>`).join("")}${weakening.length ? `<li><span class="pill caution">Watch</span><span class="run-names">${weakening.map((c) => `<b data-desk-jump="${esc(c.ticker)}">${esc(c.ticker)}</b>`).join(" ")}</span><span class="run-why">two or more weakness signals showing</span></li>` : ""}</ol>` : `<p class="muted">Add names to ${esc(lists && lists.active ? lists.active : "your list")} and this becomes your daily run: what to act on, protect, and leave alone.</p>`;
    const strongMine = mineCards.filter((c) => c.trend.score >= 1 && c.momentum.score >= 1).length;
    const fresh = (d.counts || {}).re_entry || 0;
    const readout = `<div class="readout" aria-label="desk readout">
      <div class="ro"><span class="ro-l">Backdrop</span><span class="ro-v word ${(m.verdict || {}).cls || mc}">${esc((m.headline || m.regime || "–").toUpperCase())}</span></div>
      <div class="ro"><span class="ro-l">Macro</span><span class="ro-v digit ${mc}">${m.pillar == null ? "--" : (m.pillar > 0 ? "+" : m.pillar < 0 ? "" : " ") + m.pillar}</span></div>
      <div class="ro"><span class="ro-l">${esc(lists && lists.active ? lists.active : "My list")} strong</span><span class="ro-v digit">${String(strongMine).padStart(2, "0")}<i>/${String(mineCards.length).padStart(2, "0")}</i></span></div>
      <div class="ro"><span class="ro-l">Fresh entries</span><span class="ro-v digit up">${String(fresh).padStart(3, "0")}</span></div>
      <div class="ro"><span class="ro-l">Names scored</span><span class="ro-v digit">${String((d.cards || []).length).padStart(3, "0")}</span></div>
      <div class="ro"><span class="ro-l">Updated</span><span class="ro-v digit">${esc((d.generated_at || "").slice(11, 16) || "--:--")}</span></div>
    </div>`;
    const empty = deskScope === "mine"
      ? `<tr><td colspan="8"><div class="empty-state inline"><h3>Nothing from ${esc(lists && lists.active ? lists.active : "your list")} is scored yet</h3><p>Add names on the Watchlist page; the desk picks them up on its next pass (every 30 minutes in market hours).</p><a class="btn sm ghost" href="#view=watch" data-view-link="watch">Open the watchlist</a></div></td></tr>`
      : `<tr><td colspan="8" class="muted empty">No names in this group.</td></tr>`;
    return `<section class="desk">
      ${head(`<span class="st-dot up"></span>Updated ${esc((d.generated_at || "").slice(11, 16))} ET · every 30 min in market hours · daily bars, today included`)}
      ${readout}
      <div class="desk-top">
        <div class="panel backdrop">
          <h3>Market backdrop <span class="muted">what the whole market is doing, in plain words</span></h3>
          <div class="bd-hero"><span class="mood-tone ${mc}">${esc(m.headline || m.regime || "–")}</span><div class="bd-side"><span class="pill ${(m.verdict || {}).cls || mc}">${esc((m.verdict || {}).word || "")} · macro ${m.pillar > 0 ? "+" : ""}${m.pillar == null ? "–" : m.pillar}</span><span class="bd-label">${esc(m.summary || "")}</span></div></div>
          <p class="bd-plain">${esc((m.verdict || {}).text || m.regime_plain || "")}${m.inflationary ? " Stocks and bonds are falling together, which is the inflation flag." : ""}</p>
          <ul class="gauges">${gauges}</ul>
        </div>
        <div class="right-col">
        <div class="panel run"><h3>Your run today <span class="muted">${esc(lists && lists.active ? lists.active : "my list")}</span></h3>${runHtml}</div>
        <details class="panel howto"><summary><h3>How to read it</h3></summary>
          <dl class="legend-list">
            <div><dt>Trend</dt><dd>Price against its 20-, 50- and 200-day lines, and which way the 200-day is sloping.</dd></div>
            <div><dt>Momentum</dt><dd>RSI, the MACD histogram and TRIX: is the move still gaining or fading.</dd></div>
            <div><dt>Macro</dt><dd>The backdrop score on the left, the same for every name today.</dd></div>
          </dl>
          <div class="legend-scale">${pillarMeter(-2)}<span>negative</span>${pillarMeter(0)}<span>neutral</span>${pillarMeter(2)}<span>strong</span></div>
          <div class="legend-reads">${[["re_entry", "up"], ["hold_ride", "up"], ["wait", "flat"], ["tactical_rebound", "caution"], ["exit_trim", "down"], ["stay_out", "down"]].map(([k, cls]) => `<span class="pill ${cls}">${esc(DESK_WORDS[k])}</span>`).join("")}</div>
          <p class="meta2">Total runs from −6 to +6; today's best possible is ${maxTotal == null ? "–" : (maxTotal > 0 ? "+" : "") + maxTotal} because the macro score is ${m.pillar > 0 ? "+" : ""}${m.pillar == null ? "–" : m.pillar}. Switch "I'm flat / I hold it" on a row to see the read from your side of the trade.</p>
        </details>
        </div>
      </div>
      ${isAdmin ? secDeskScan(d) : ""}
      <div class="desk-tools">
        <div class="seg">${scopes.map(([k, l, n]) => `<button class="seg-btn ${deskScope === k ? "active" : ""}" type="button" data-desk-scope="${k}">${esc(l)}<em>${n}</em></button>`).join("")}</div>
        <label class="find"><input type="search" placeholder="Find a name" value="${esc(deskFind)}" data-desk-find autocomplete="off"></label>
        <button class="pro-toggle ${deskPro ? "on" : ""}" type="button" data-desk-pro title="Adds what a desk checks beside the score: strength against the S&P 500, volume against normal, money traded per day, distance from the 52-week high, days to earnings">${deskPro ? "Institution view on" : "Institution view"}</button>
        <div class="counts">${counts}</div>
      </div>
      ${missing.length ? `<div class="meta2 missing">Not scored yet (fewer than 60 daily bars, or not in this pass): ${missing.map(esc).join(", ")}</div>` : ""}
      <div class="panel desk-main"><div class="tbl-wrap"><table class="tbl desk-tbl"><thead><tr><th>Name</th><th class="num">Price</th><th class="col-meter">Trend</th><th class="col-meter">Momentum</th><th class="col-meter col-macro">Macro</th><th class="num">Total</th>${deskPro ? proHead() : ""}<th>Read</th><th class="col-you">Your side</th></tr></thead><tbody>${rows || empty}</tbody></table></div></div>
      <p class="desk-foot muted">Framework and maths: <a href="${esc((d.source || {}).url || "#")}" target="_blank" rel="noopener">Agentic Trading Desk</a> by ${esc((d.source || {}).author || "")}, open source (MIT), run on OneView data and shown as information. OneView never places orders. Every read here is logged and scored in the Track record.</p>
    </section>`;
  }
  const DESK_WORDS = { re_entry: "Fresh entry", tactical_rebound: "Quick bounce only", hold_ride: "Hold", hold_review: "Hold, watch closely", wait: "Wait, do not chase", exit_trim: "Take profit", exit: "Exit", stay_out: "Stay out", observe: "No action" };
  let checkData = null, checkDay = "";
  async function loadCheck(day) {
    if (STATIC_MODE) return;
    if (day !== undefined) checkDay = day;
    try { const res = await api("/api/direction/check" + (checkDay ? `?day=${encodeURIComponent(checkDay)}` : ""), { cache: "no-store" }); if (res.ok) { checkData = await res.json(); if (currentView === "check") renderAll(); } } catch (e) {}
  }
  const CHECK_STATUS = { on_track: ["On track", "up"], against: ["Against us", "down"], hit: ["Right", "up"], miss: ["Wrong", "down"], pending: ["Waiting", "flat"], flat: ["Flat so far", "flat"], no_read: ["No read (service down)", "flat"] };
  function secCheck() {
    if (STATIC_MODE) return `<section><h2>Intraday check</h2><div class="muted">The live check runs on the app server: open the app link, not the static copy.</div></section>`;
    const j = checkData; if (!j) { loadCheck(); return `<section><h2>Intraday check</h2><div class="muted">Loading today's reads…</div></section>`; }
    const S = j.summary || {}, st = j.stats || {}, T = st.totals || {};
    const rate = (h, n) => (n ? Math.round(h / n * 100) + "%" : "–");
    const mv = (x) => (isNum(x) ? `<span class="${x > 0.05 ? "up" : x < -0.05 ? "down" : ""}">${x > 0 ? "+" : ""}${x.toFixed(2)}%</span>` : "–");
    const tile = (l, v, sub) => `<div class="tile"><div class="tile-label">${l}</div><div class="tile-value">${v}</div><div class="tile-sub">${sub || ""}</div></div>`;
    const tm = (ts) => new Date(ts * 1000).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
    const spy = j.spy || {}, m = j.morning || {};
    const mst = CHECK_STATUS[m.status] || ["–", "flat"];
    const rows = (j.reads || []).map((r) => {
      const c = CHECK_STATUS[r.status] || ["–", "flat"]; const d = DIR[r.expected];
      return `<tr class="${r.status === "no_read" ? "dim" : ""}"><td class="num">${tm(r.ts)}</td><td>${d ? `<span class="pill ${d[1]}">${pretty(r.expected)}</span>` : '<span class="muted">none</span>'}</td><td>${r.expected ? convTag(r.confidence) : ""}</td><td class="small">${r.driver ? (DIR_DRIVER[r.driver] ? pretty(r.driver) : pretty(r.driver)) : "–"}</td><td class="small">${r.source === "rules" ? '<span class="src-badge">backup</span>' : r.expected ? "model" : "–"}</td><td class="num">${fnum(r.spy)}</td><td class="num">${mv(r.move_15)}</td><td class="num">${mv(r.move_30)}</td><td class="num">${mv(r.move_60)}${r.hit_60 === 1 ? ' <span class="up">✓</span>' : r.hit_60 === 0 ? ' <span class="down">✗</span>' : ""}</td><td class="num">${mv(r.move_now)}</td><td><span class="tag ${c[1] === "up" ? "ok" : c[1] === "down" ? "warn" : ""}">${c[0]}</span></td></tr>`;
    }).join("") || '<tr><td colspan="11" class="muted">No reads for this day. Reads run every 15 minutes while the market is open.</td></tr>';
    const brk = (label, rows, key, fmt) => `<div class="card"><h3>${label}</h3><table class="tbl"><thead><tr><th>${label.split(" ")[1] || ""}</th><th class="num">Reads</th><th class="num">Right at close</th><th class="num">Right at +1 h</th><th class="num">Avg move to close</th></tr></thead><tbody>${(rows || []).map((x) => `<tr><td>${fmt ? fmt(x[key]) : pretty(String(x[key]))}</td><td class="num">${x.n}</td><td class="num"><b>${rate(x.hits, x.scored)}</b> <span class="muted">${x.scored ? "of " + x.scored : ""}</span></td><td class="num">${rate(x.hits_60, x.scored_60)}</td><td class="num">${isNum(x.avg_move) ? fpct(x.avg_move, 2) : "–"}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">Nothing scored yet.</td></tr>'}</tbody></table></div>`;
    const lessons = (j.lessons || []).map((l) => `<li>${esc(l)}</li>`).join("");
    const dayNav = `<div class="wc-actions"><button class="btn sm" type="button" data-check-day="${prevDay(j.day)}">← ${prevDay(j.day)}</button><b>${esc(j.day)}</b>${j.day < todayET() ? `<button class="btn sm" type="button" data-check-day="${nextDay(j.day)}">${nextDay(j.day)} →</button><button class="btn sm" type="button" data-check-day="">Today</button>` : ""}</div>`;
    return `<section class="check">
      <h2>Intraday check <span class="muted">what we said every 15 minutes, and what the market did next · ${j.market_state === "open" ? "live, refreshes every minute" : "market closed"}</span></h2>
      ${dayNav}
      <div class="grid c6" style="margin:12px 0">
        ${tile("SPY now", isNum(spy.last) ? fnum(spy.last) : "–", isNum(spy.chg_pct) ? fpct(spy.chg_pct, 2) + " today" : "")}
        ${tile("Morning call", m.call && m.call.SPY ? pretty(m.call.SPY) : "none", m.call && m.call.SPY ? `<span class="${mst[1]}">${mst[0]}</span>${m.source === "rules" ? " · backup" : ""}` : "")}
        ${tile("Reads today", S.reads || 0, S.no_read ? `${S.no_read} with no read` : "every 15 min")}
        ${tile(j.market_state === "open" ? "On track now" : "Right at the close", `${S.on_track || 0} / ${S.judged || 0}`, rate(S.on_track || 0, S.judged || 0))}
        ${tile("30-day record", rate(T.hits, T.scored), `${T.scored || 0} reads scored`)}
        ${tile("Right at +1 h", rate(T.hits_60, T.scored_60), `${T.scored_60 || 0} reads`)}
      </div>
      <div class="card" style="margin-bottom:12px"><h3>Today's reads <span class="muted">${esc(j.how || "")}</span></h3>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Time ET</th><th>Call</th><th>Conviction</th><th>Reason</th><th>Engine</th><th class="num">SPY at read</th><th class="num">+15 m</th><th class="num">+30 m</th><th class="num">+1 h</th><th class="num">${j.market_state === "open" && j.day === todayET() ? "Now" : "Close"}</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div></div>
      <div class="card" style="margin-bottom:12px"><h3>What works, what does not <span class="muted">last ${st.days || 30} days, scored reads only</span></h3><ul class="lessons">${lessons || "<li>Nothing scored yet.</li>"}</ul></div>
      <div class="admin-grid">
        ${brk("By reason", st.by_driver, "driver")}
        ${brk("By call", st.by_expected, "expected")}
        ${brk("By hour", st.by_hour, "hour", (h) => h + ":00 ET")}
        ${brk("By conviction", st.by_conviction, "conviction", (c) => String(c).toUpperCase())}
        ${brk("By engine", st.by_source, "source", (x) => (x === "rules" ? "Backup rules" : "Model"))}
        ${brk("By day", st.by_day, "day")}
      </div>
      <p class="muted small" style="margin-top:10px">Information, not advice. Every read is stored with its inputs; the close briefing scores the day and the model is shown its own hit rates on the next read.</p>
    </section>`;
  }
  function todayET() { return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); }
  function prevDay(d) { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); }
  function nextDay(d) { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); }
  function secAdmin() {
    const A = adminData; if (!A) return `<section><h2>Admin</h2><div class="muted">Loading the overview…</div></section>`;
    const T = A.traffic, mx = Math.max(1, ...T.series.map((x) => x.requests));
    const bars = T.series.map((x, i) => `<rect x="${i * 6}" y="${60 - (x.requests / mx) * 58}" width="5" height="${(x.requests / mx) * 58}" class="${x.pages ? "pg" : ""}"><title>${new Date(x.minute * 60000).toTimeString().slice(0, 5)}: ${x.requests} requests, ${x.pages} page loads</title></rect>`).join("");
    const tile = (l, v, sub) => `<div class="tile"><div class="tile-label">${l}</div><div class="tile-value">${v}</div><div class="tile-sub">${sub || ""}</div></div>`;
    const online = A.online.map((u) => `<tr><td class="sym"><b>${esc(u.name || u.email.split("@")[0])}</b><div class="meta2">${esc(u.email)}</div></td><td>${ago(u.last_seen)}</td><td>${ago(u.since)}</td><td class="num">${u.sessions}</td><td class="hl small">${esc((u.user_agent || "").slice(0, 70))}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">Nobody is signed in right now.</td></tr>';
    const users = A.users.map((u) => `<tr><td class="sym"><span class="st-dot ${u.online ? "up" : "none"}"></span> <b>${esc(u.name || u.email.split("@")[0])}</b><div class="meta2">${esc(u.email)}</div></td><td>${u.online ? '<span class="up">online</span>' : "offline"}</td><td>${ago(u.last_login)}</td><td class="num">${u.tickers}</td><td>${u.accepted_disclaimer_at ? "yes" : "no"}</td><td>${ago(u.created)}</td></tr>`).join("");
    const recent = A.recent.map((x) => `<tr><td class="num">${new Date(x.at * 1000).toTimeString().slice(0, 8)}</td><td>${esc(x.email || "–")}</td><td><span class="tag ${{ login: "ok", logout: "", link_requested: "acc", watchlist: "acc", analyzed: "warn" }[x.action] || ""}">${pretty(x.action)}</span></td><td class="hl small">${esc(x.detail || "")}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">No activity yet.</td></tr>';
    return `<section class="admin"><h2>Admin dashboard <span class="muted">${esc(A.admin)} · refreshed ${new Date(A.as_of * 1000).toTimeString().slice(0, 8)} · sessions table in market_update.db</span></h2>
      <div class="grid c6" style="margin-bottom:12px">${tile("Signed in now", A.online.length, "distinct users")}${tile("Active sessions", A.active_sessions, "browsers with a live login")}${tile("Requests, last hour", T.requests_last_hour, `${T.requests_24h} in 24 h`)}${tile("Page loads, 24 h", T.pages_24h, "")}${tile("Logins, 24 h", T.logins_24h, "")}${tile("Accounts", A.users_total, `build ${A.build.build_id || "–"}${A.build.building ? " · building" : ""}`)}</div>
      <div class="card" style="margin-bottom:12px"><h3>Intraday check <span class="muted">what we said every 15 minutes vs what the market did; scored at the close and one hour on</span></h3>
        <div class="wc-actions" style="margin-top:8px"><a class="btn sm" href="#view=check" data-view-link="check">Open the intraday check</a><a class="btn sm ghost" href="/track-record" target="_blank" rel="noopener">Public track record</a><span class="meta2">App link for the group: ${esc(location.origin)}/#view=check (sign-in required)</span></div></div>
      <div class="card" style="margin-bottom:12px"><h3>StockTwits connector <span class="muted">reads crowd sentiment through StockTwits' official connector; sign in once as the owner</span></h3>
        <div id="st-status" class="meta2">Checking…</div>
        <div class="wc-actions" style="margin-top:8px"><button class="btn sm" type="button" data-st-connect>Connect StockTwits</button><span class="meta2" id="st-connect-msg"></span></div></div>
      <div class="card" style="margin-bottom:12px"><h3>Traffic flow <span class="muted">requests per minute, last two hours · lighter bars include page loads</span></h3><svg class="traffic" viewBox="0 0 ${T.series.length * 6} 62" preserveAspectRatio="none">${bars}</svg></div>
      <div class="admin-grid">
        <div class="card"><h3>Logged-in users</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>User</th><th>Last seen</th><th>Signed in</th><th>Sessions</th><th>Browser</th></tr></thead><tbody>${online}</tbody></table></div></div>
        <div class="card"><h3>Recent activity</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead><tbody>${recent}</tbody></table></div></div>
        <div class="card wide"><h3>All accounts</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>User</th><th>Status</th><th>Last login</th><th>Tickers</th><th>Disclaimer</th><th>Created</th></tr></thead><tbody>${users}</tbody></table></div></div>
      </div></section>`;
  }
  function subTabs(v) { return `<div class="tabs subtabs">${SUBTABS[v].map(([k, l]) => `<button class="tab ${subTab[v] === k ? "active" : ""}" data-sub="${v}:${k}">${l}</button>`).join("")}</div>`; }
  function switchView(k) {
    if (!VIEWS.some((v) => v[0] === k)) return;
    if (ADMIN_VIEWS.includes(k) && !(user && user.role === "admin")) return;
    if (k === "record") loadRecord();
    if (k === "check") loadCheck();
    if (k === "desk") { loadDesk(); if (!deskScan && user && user.role === "admin") loadDeskScan(false); }
    currentView = k; try { history.replaceState(null, "", "#view=" + k); } catch (e) {}
    if (report) renderAll();
  }

  function mountCharts() {
    const r = report;
    document.querySelectorAll("[data-chart-weekly-idx]").forEach((el) => {
      if (el.childElementCount > 0) return;
      const i = r.indices.find((x) => x.symbol === el.getAttribute("data-chart-weekly-idx")); if (!i) return;
      const L = i.weekly_levels || {};
      weeklyChart(el, i.weekly, [{ price: L.resistance, title: "R", color: cssVar("--down"), style: 0, width: 2 }, { price: L.support, title: "S", color: cssVar("--up"), style: 0, width: 2 },
        { price: L.hi52, title: "52w H", color: cssVar("--muted") }, { price: L.lo52, title: "52w L", color: cssVar("--muted") }], 250);
    });
    document.querySelectorAll("[data-chart]").forEach((el) => {
      if (el.childElementCount > 0) return;            // already mounted (partial re-render)
      const sym = el.getAttribute("data-chart");
      const idx = r.indices.find((i) => i.symbol === sym);
      const st = r.stocks.find((s) => s.ticker === sym);
      const src = idx || st; if (!src) return;
      const t = src.technicals, pv = t.pivots || {};
      const levels = [{ price: t.prev_high, title: "PDH" }, { price: t.prev_low, title: "PDL" }, { price: pv.p, title: "P", color: cssVar("--accent") }];
      if (st) levels.push({ price: t.hi20, title: "20dH", color: cssVar("--s3") }, { price: t.lo20, title: "20dL", color: cssVar("--s3") });
      const pa = src.price_action || {};
      if (isNum(pa.nearest_resistance)) levels.push({ price: pa.nearest_resistance, title: "R", color: cssVar("--down") });
      if (isNum(pa.nearest_support)) levels.push({ price: pa.nearest_support, title: "S", color: cssVar("--up") });
      candleChart(el, src.ohlc, levels, el.classList.contains("tall"));
    });
  }

  function openDetail(ticker) {
    selectedTicker = ticker;
    if (currentView !== "stock") { switchView("stock"); return; }
    rerenderStocks();
    const el = $("#stock-detail"); if (el) el.scrollTop = 0;
  }

  function wireStocks() {
    document.querySelectorAll("[data-stop]").forEach((b) => b.addEventListener("click", (e) => e.stopPropagation()));
    document.querySelectorAll("#app .nav-btn").forEach((b) => b.addEventListener("click", () => switchView(b.getAttribute("data-view"))));
    document.querySelectorAll("[data-theme-group]").forEach((b) => b.addEventListener("click", () => {
      themeGroup = b.getAttribute("data-theme-group");
      const sec = document.querySelector(".th-section"); const tmp = document.createElement("div"); tmp.innerHTML = secTheme(report); sec.replaceWith(tmp.firstElementChild); wireStocks();
    }));
    document.querySelectorAll("tr.hz-row").forEach((tr) => tr.addEventListener("click", () => {
      const sym = tr.getAttribute("data-hz"); const row = document.querySelector(`tr[data-hz-chart="${CSS.escape(sym)}"]`); if (!row) return;
      row.hidden = !row.hidden;
      if (!row.hidden) { const el = row.querySelector("[data-chart-weekly]"); if (el && el.childElementCount === 0) { const a = report.horizons.assets.find((x) => x.symbol === sym); weeklyChart(el, a.weekly); } }
    }));
    document.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openDetail(b.getAttribute("data-open"))));
    const ag = $("[data-agree]"); if (ag) ag.addEventListener("click", () => { try { localStorage.setItem("mu-disc", "1"); } catch (e) {} if (user && !STATIC_MODE) api("/api/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accepted: true, tickers: activeList() }) }).catch(() => {}); renderAll(); });
    wireSearch();
    document.querySelectorAll("#app [data-list]").forEach((b) => b.addEventListener("click", () => { lists.active = b.getAttribute("data-list"); saveLists(); renderAll(); }));
    const nl = $("#app [data-newlist]"); if (nl) nl.addEventListener("click", newList);
    const ni = $("#list-new input"); if (ni) { ni.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); createList(ni.value); } if (e.key === "Escape") $("#list-new").hidden = true; }); }
    const nc = $("[data-newcancel]"); if (nc) nc.addEventListener("click", () => { $("#list-new").hidden = true; });
    const rl = $("#app [data-renamelist]"); if (rl) rl.addEventListener("click", () => { const n = prompt("Rename this list:", lists.active); if (n) renameList(n); });
    const dl = $("#app [data-deletelist]"); if (dl) dl.addEventListener("click", deleteList);
    document.querySelectorAll("#app [data-ticker-page]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); openTicker(b.getAttribute("data-ticker-page")); }));
    document.querySelectorAll("[data-back-home]").forEach((b) => b.addEventListener("click", () => switchView("home")));
    const sa = $("[data-social-all]"); if (sa) sa.addEventListener("click", () => { socialAll = !socialAll; const el = $(".voices"); if (el) { const tmp = document.createElement("div"); tmp.innerHTML = secVoices(report); el.replaceWith(tmp.firstElementChild); wireStocks(); } });
    const stc = $("[data-st-connect]"); if (stc) stc.addEventListener("click", async () => { const m = $("#st-connect-msg"); m.textContent = "Opening StockTwits…"; try { const res = await api("/api/stocktwits/connect?json_out=1"); if (res.status === 403) { m.textContent = "Sign in with an admin account first."; return; } const j = await res.json(); if (j.url) location.href = j.url; else m.textContent = j.detail || "Could not start the connection."; } catch (e) { m.textContent = "The server is not reachable right now."; } });
    document.querySelectorAll("tr[data-day]").forEach((tr) => tr.addEventListener("click", async () => { const day = tr.getAttribute("data-day"); const row = document.querySelector(`tr[data-day-detail="${CSS.escape(day)}"]`); if (!row) return; row.hidden = !row.hidden; if (row.hidden) return;
      try { const res = await api(`/api/direction/day?day=${encodeURIComponent(day)}`, { cache: "no-store" }); const j = await res.json();
        const t = (ts) => new Date(ts * 1000).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
        const morning = (j.morning || []).map((m) => `<li><b>${esc(m.symbol)}</b> morning call: ${esc(pretty(m.read || "–"))} at ${fnum(m.price)} → ${isNum(m.outcome_pct) ? fpct(m.outcome_pct, 2) + " by the close" : "open"} ${m.hit === 1 ? '<span class="up">hit</span>' : m.hit === 0 ? '<span class="down">miss</span>' : ""}</li>`).join("");
        const reads = (j.reads || []).map((r) => `<li><samp>${t(r.ts)}</samp> <span class="pill ${DIR[r.expected] ? DIR[r.expected][1] : "flat"}">${esc(r.expected || "–")}</span> ${convTag(r.confidence)} <span class="muted">${r.driver ? (DIR_DRIVER[r.driver] || pretty(r.driver)) : ""}${r.facts && r.facts.spy ? ` · SPY ${r.facts.spy.above_vwap ? "above" : "below"} the day's average price` : ""}${r.facts && r.facts.sentiment ? ` · Reddit ${esc(r.facts.sentiment.reddit_spy || "none")}` : ""}</span> → SPY ${isNum(r.move_spy_pct) ? fpct(r.move_spy_pct, 2) + " to the close" : "open"} ${r.hit === 1 ? '<span class="up">hit</span>' : r.hit === 0 ? '<span class="down">miss</span>' : ""}</li>`).join("");
        row.querySelector("td").innerHTML = `<ul class="bf-list">${morning}${reads || '<li class="muted">no intraday reads that day</li>'}</ul>`; } catch (e) { row.querySelector("td").innerHTML = '<div class="muted">Could not load that day.</div>'; } }));
    document.querySelectorAll("[data-brief-toggle]").forEach((b) => b.addEventListener("click", () => { const slot = b.getAttribute("data-brief-toggle"); briefOpen = briefOpen === slot ? null : slot; const el = $(".briefs"); if (el) { const tmp = document.createElement("div"); tmp.innerHTML = secBrief(report); el.replaceWith(tmp.firstElementChild); wireStocks(); } }));
    document.querySelectorAll("[data-view-link]").forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); switchView(b.getAttribute("data-view-link")); }));
    wireDesk();
    document.querySelectorAll("[data-check-day]").forEach((b) => b.addEventListener("click", () => { checkData = null; loadCheck(b.getAttribute("data-check-day")); renderAll(); }));
    document.querySelectorAll("[data-add-ticker]").forEach((b) => b.addEventListener("click", () => addTicker(b.getAttribute("data-add-ticker"))));
    document.querySelectorAll("#app [data-remove]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); removeTicker(b.getAttribute("data-remove")); }));
    document.querySelectorAll("[data-analyze]").forEach((b) => b.addEventListener("click", () => { requestAnalysis(b.getAttribute("data-analyze")); renderAll(); }));
    document.querySelectorAll("[data-list]").forEach((b) => b.addEventListener("click", () => { lists.active = b.getAttribute("data-list"); saveLists(); renderAll(); }));
    document.querySelectorAll("#app [data-sub]").forEach((b) => b.addEventListener("click", () => { const [v, k] = b.getAttribute("data-sub").split(":"); subTab[v] = k; renderAll(); }));
    document.querySelectorAll("[data-scan-tf]").forEach((b) => b.addEventListener("click", () => { scanTf = b.getAttribute("data-scan-tf"); renderAll(); }));

    document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => { stockTab = b.getAttribute("data-tab"); rerenderStocks(); }));
    document.querySelectorAll("th.sortable").forEach((h) => h.addEventListener("click", () => { sortKey = h.getAttribute("data-sort"); rerenderStocks(); }));
    document.querySelectorAll("tr.clickable").forEach((tr) => tr.addEventListener("click", () => {
      selectedTicker = tr.getAttribute("data-ticker"); rerenderStocks();
      const d = $("#stock-detail"); if (d) d.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }

  function rerenderStocks() {
    const sec = $("#stocks-tbl") && $("#stocks-tbl").closest("section");
    if (!sec) return;
    charts = charts.filter((c) => { const keep = document.body.contains(c.chart.chartElement && c.chart.chartElement()) ; return true; });
    const tmp = document.createElement("div"); tmp.innerHTML = secStocks(report);
    sec.replaceWith(tmp.firstElementChild);
    mountCharts(); wireStocks();
  }

  // ---------------------------------------------------------------- refresh / polling
  const notice = (msg, show = true, actionLabel, action) => {
    const n = $("#notice"); n.textContent = msg; n.hidden = !show;
    if (show && actionLabel) { const b = document.createElement("button"); b.className = "btn"; b.style.marginLeft = "8px"; b.textContent = actionLabel; b.addEventListener("click", action); n.appendChild(b); }
  };
  function applyPending() {
    if (!pendingReport) return;
    const y = window.scrollY;
    const keep = report ? report.stocks.filter((s) => s.adhoc) : [];
    report = pendingReport; pendingReport = null;
    keep.forEach((s) => { if (!stockFor(s.ticker)) report.stocks.push(s); });
    renderAll(); notice("", false); refreshAdhoc();
    window.scrollTo(0, y);
  }

  async function fetchReport() {
    const res = await api("/api/report", { cache: "no-store" });
    if (!res.ok) throw new Error("report " + res.status);
    return res.json();
  }

  // A page that is older than the server's copy reloads itself with a cache-busting URL: at most once every
  // ten minutes per version, so a deploy that is still publishing cannot cause a loop.
  function checkVersion(v) {
    try {
      if (!v || !window.MU_VERSION || v === window.MU_VERSION) return;
      const last = JSON.parse(sessionStorage.getItem("mu-reloaded") || "null");
      if (last && last.v === v && Date.now() - last.at < 600000) return;
      sessionStorage.setItem("mu-reloaded", JSON.stringify({ v, at: Date.now() }));
      const u = new URL(location.href); u.searchParams.set("v", v); location.replace(u.toString());
    } catch (e) {}
  }
  addEventListener("pageshow", (e) => { if (e.persisted) location.reload(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !STATIC_MODE) poll(); });
  async function poll() {
    try {
      const st = await (await api("/api/status", { cache: "no-store" })).json();
      const btn = $("#refresh-btn");
      if (st.building) { btn.disabled = true; setLabel(btn, "Building…"); }
      else if (st.refresh_available_in_s > 0) { btn.disabled = true; setLabel(btn, `Refresh (${st.refresh_available_in_s}s)`); }
      else { btn.disabled = false; setLabel(btn, "Refresh"); }
      if (st.last_error) notice("Last build failed: " + st.last_error);
      checkVersion(st.app_version);
      if (st.build_id && report && st.build_id !== report.build_id && (!pendingReport || pendingReport.build_id !== st.build_id)) {
        pendingReport = await fetchReport();
      }
      if (pendingReport) {
        const idle = Date.now() - lastInteraction > 45000;
        if (idle || document.hidden || window.scrollY < 80) { applyPending(); }
        else { notice(`New data from ${pendingReport.generated_at.slice(11, 16)} ET is ready. `, true, "Update now", applyPending); }
      }
      if (!report && st.build_id) { report = await fetchReport(); renderAll(); refreshAdhoc(); }
    } catch (e) { /* server may be restarting */ }
  }

  async function onRefresh() {
    if (STATIC_MODE) return;
    const btn = $("#refresh-btn"); btn.disabled = true; setLabel(btn, "Building…");
    try {
      const res = await api("/api/refresh", { method: "POST" });
      const j = await res.json();
      if (res.status === 429) notice(`Refresh is rate-limited; try again in ${j.retry_in_s}s.`);
      else notice("Rebuilding: fresh quotes, news and model judgments. This takes about a minute.");
    } catch (e) { notice("Refresh failed: " + e.message); }
  }

  function initTheme() {                        // one mode only: the navy desk
    document.documentElement.removeAttribute("data-theme");
    try { localStorage.removeItem("mu-theme"); } catch (e) {}
  }

  async function init() {
    initTheme();
    addEventListener("keydown", (e) => { if (e.target && /input|textarea/i.test(e.target.tagName)) return; const gt = $("#gate"); if (gt && !gt.hidden) return; if (e.key === "/") { e.preventDefault(); const i = $("#search"); if (i) i.focus(); return; } const v = VIEWS.find((x) => x[2] === e.key); if (v) switchView(v[0]); });
    wireSearch(); initSide(); scheduleHourly(); setInterval(hourlyTick, 1000); hourlyTick();
    lastMarketState = marketStateNow(); setInterval(marketWatch, 5000); setInterval(liveCountdown, 1000);
    if (lastMarketState === "open") { const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(new Date()); const m = parseInt((p.find((x) => x.type === "hour") || {}).value, 10) * 60 + parseInt((p.find((x) => x.type === "minute") || {}).value, 10); if (m - 570 < 3) setTimeout(() => flash("MARKET OPEN", "9:30 ET · regular session under way"), 800); }
    const lb = $("#logout-btn"); if (lb) lb.addEventListener("click", signOut);
    const ab = $("#alerts-btn"); if (ab) ab.addEventListener("click", openAlerts);
    if (/[?&]signin=1/.test(location.search)) { gateOpen = true; }
    if (/signed_in=1/.test(location.search)) { try { history.replaceState(null, "", location.pathname + location.hash); } catch (e) {} }
    try { if (/brief=1/.test(location.hash)) sessionStorage.setItem("mu-open-brief", "1"); } catch (e) {}
    addEventListener("hashchange", () => { const v = (location.hash.match(/view=([a-z]+)/) || [])[1]; const t = (location.hash.match(/[&#]t=([A-Za-z0-9.\-^=]+)/) || [])[1];
      if (v === "ticker" && t) { if (currentView !== "ticker" || tickerSel !== t.toUpperCase()) { tickerSel = t.toUpperCase(); currentView = "ticker"; if (report) renderAll(); } return; }
      if (v && v !== currentView && VIEWS.some((x) => x[0] === v)) { currentView = v; if (report) renderAll(); } });
    $("#refresh-btn").addEventListener("click", onRefresh);
    if (EMBEDDED && API) {
      try { report = JSON.parse(EMBEDDED.textContent); } catch (e) { report = null; }   // seed the first paint from the export; the API takes over below
    }
    if (STATIC_MODE) {
      report = JSON.parse(EMBEDDED.textContent);
      const rb = $("#refresh-btn"); rb.hidden = false; setLabel(rb, "Refresh");
      rb.onclick = async () => { rb.disabled = true; setLabel(rb, "Checking…"); try { const res = await fetch("./report.json", { cache: "no-store" }); if (res.ok) { const fresh = await res.json(); if (fresh.build_id !== report.build_id) { pendingReport = fresh; applyPending(); notice(`Updated to the ${fresh.generated_at.slice(11, 16)} ET build.`); } else notice("You already have the latest build. Forced rebuilds run from the project's Actions page.", true); } } catch (e) { notice("Static snapshot: nothing newer is reachable from here.", true); } rb.disabled = false; setLabel(rb, "Refresh"); };
      await loadUser(); renderAll(); renderGate(); disclaimerBanner();
      // Hosted statically (e.g. GitHub Pages): a scheduled job republishes report.json; pick it up without a reload.
      setInterval(async () => {
        try {
          const res = await fetch("./report.json", { cache: "no-store" });
          if (!res.ok) return;
          const fresh = await res.json();
          if (fresh.build_id && fresh.build_id !== report.build_id && (!pendingReport || pendingReport.build_id !== fresh.build_id)) pendingReport = fresh;
          if (pendingReport) {
            const idle = Date.now() - lastInteraction > 45000;
            if (idle || document.hidden || window.scrollY < 80) applyPending();
            else notice(`New data from ${pendingReport.generated_at.slice(11, 16)} ET is ready. `, true, "Update now", applyPending);
          }
        } catch (e) { /* offline or file:// */ }
      }, 120000);
      return;
    }
    await loadUser();
    try { report = await fetchReport(); (report.headlines || []).forEach((h) => newsSeen.add(h.id)); renderAll(); refreshAdhoc(); }
    catch (e) { console.error("render failed", e); $("#app").innerHTML = `<div class="loading">${report ? "Render error: " + esc(e && e.message) : "First build in progress… this page will fill in automatically."}</div>`; }
    renderGate(); disclaimerBanner();
    setInterval(poll, 15000);
    poll();
    setInterval(pollNews, 60000);
    setTimeout(pollNews, 1500);
    setInterval(pollSocial, 300000);
    setTimeout(pollSocial, 4000);
    setInterval(pollBrief, 300000);
    setTimeout(pollBrief, 2000);
    setInterval(pollDirection, 60000);
    setInterval(() => { if (currentView === "check") loadCheck(); }, 60000);
    setInterval(() => { if (currentView === "desk") loadDesk(); }, 300000);
    setTimeout(pollDirection, 3000);
    setInterval(pollCrowd, 300000);
    setInterval(pollOdds, 600000);
    setInterval(pollPros, 600000);
    setTimeout(pollPros, 5000);
    setTimeout(pollOdds, 4500);
    setTimeout(pollCrowd, 3500);
    setInterval(pollLiveScan, 60000);
    setTimeout(pollLiveScan, 2500);
    setInterval(pollAdmin, 30000);
    setTimeout(pollAdmin, 3000);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
