/* Market Update client. Renders the report JSON (embedded or fetched) and
   handles refresh, auto-update polling, theme, tabs and stock detail. */
(function () {
  "use strict";

  // ---------------------------------------------------------------- state
  const EMBEDDED = document.getElementById("report-data");
  const API = ((document.querySelector('meta[name="mu-api-url"]') || {}).content || "").replace(/__API_URL__/, "").replace(/\/$/, "");
  const STATIC_MODE = !!EMBEDDED && !API;          // a static copy with an API behind it behaves like the app
  let authToken = null; try { authToken = localStorage.getItem("mu-token"); } catch (e) {}
  const mst = (location.hash.match(/[#&]st=([A-Za-z0-9_\-.]+)/) || [])[1];
  if (mst) { authToken = mst; try { localStorage.setItem("mu-token", mst); } catch (e) {} try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {} }
  const api = (path, opts) => { const o = Object.assign({}, opts || {}); o.headers = Object.assign({}, o.headers || {}); if (API) o.credentials = "include"; if (authToken) o.headers["Authorization"] = "Bearer " + authToken; return fetch(API + path, o); };
  let report = null;
  let selectedTicker = null;
  let stockTab = "all";
  let sortKey = "swing";
  const tvLink = (t) => `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(t.replace("-", "."))}`;
  let charts = [];
  let firstRender = true;
  const VIEWS = [["home", "Overview", "1"], ["watch", "Watchlist", "2"], ["scan", "Scanner", "3"], ["stock", "Stocks", "4"], ["theme", "Themes", "5"], ["smart", "Filings & flow", "6"], ["macro", "Market context", "7"], ["admin", "Admin", "8"], ["record", "Track record", "9"]];
  const PAGE_TITLES = { home: "Your market overview", watch: "Your watchlist", scan: "Scanner", stock: "Stocks", theme: "Themes", smart: "Filings and flow", macro: "Market context", admin: "Admin", record: "Track record" };
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
    theme: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></svg>',
    smart: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 6.5v11M15 9.2c0-1.4-1.3-2.2-3-2.2s-3 .8-3 2.1c0 2.9 6 1.6 6 4.6 0 1.4-1.4 2.3-3 2.3s-3-.9-3-2.3"/></svg>',
    record: '<svg viewBox="0 0 24 24"><path d="M4 19V5"/><path d="M4 19h16"/><path d="M7 15l4-5 3 3 5-7"/></svg>',
    macro: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/></svg>',
    watch: '<svg viewBox="0 0 24 24"><path d="M12 3.5 14.6 9l6 .6-4.5 4 1.4 5.9L12 16.4 6.5 19.5 7.9 13.6l-4.5-4 6-.6z"/></svg>',
    admin: '<svg viewBox="0 0 24 24"><path d="M12 3 4 6.5v5c0 4.6 3.4 8.4 8 9.5 4.6-1.1 8-4.9 8-9.5v-5z"/><path d="m9 12 2 2 4-4"/></svg>',
  };
  const SUBTABS = { scan: [["scanner", "Volume scanner"], ["lowfloat", "Low float"]], stock: [["all", "All names"], ["day", "Day trade"], ["swing", "Swing trade"], ["large", "Large cap"], ["small", "Small cap"], ["gappers", "Gapping"], ["watchlist", "Watchlist"]], smart: [["money", "Insiders, institutions, Congress"], ["options", "Options flow"]], macro: [["picture", "Big picture"], ["indexes", "Indexes, weekly"], ["rates", "Rates"], ["flows", "Money flows"]] };
  const NAV_GROUPS = [["Workspace", ["home", "watch", "scan", "stock", "theme"]], ["Money", ["smart"]], ["Macro", ["macro", "record"]], ["Admin", ["admin"]]];
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
    Object.entries(j.quotes).forEach(([t, q]) => qset(t, q.last, q.chg_pct, ts, { rvol: q.rvol, above_vwap: q.above_vwap, dollar_vol: q.dollar_vol, vol: q.vol, score: q.score, direction: q.direction, range_pos: q.range_pos, live: true }));
    Q.liveAt = ts; Q.at = Math.max(Q.at, ts);
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
      lead && lead !== "unclear" ? `Leadership: ${pretty(lead)}. Trade in that group first.` : "",
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
    const g = r.regime; if (!g) return `<section class="panel mood flat"><h3>Market mood</h3><div class="muted">Model read unavailable this build.</div></section>`;
    const volL = ["quiet", "normal", "elevated", "extreme"];
    const tone = g.tone.choice, cl = { risk_on: "up", risk_off: "down", mixed: "flat" }[tone];
    const fact = (label, value, c) => `<div class="fact"><span class="fact-l">${label}</span><span class="fact-v ${c || ""}">${value}</span></div>`;
    return `<section class="panel mood ${cl}">
      <h3>Market mood · ${esc(r.session_label.split(",")[0])}</h3>
      <div class="mood-row"><span class="mood-tone">${pretty(tone).toUpperCase()}</span><span class="mood-conf">${convTag(g.tone.confidence)}</span></div>
      <p class="mood-why">${EX.tone[tone]}</p>
      <div class="facts">
        ${fact("Swings", volL[Math.round(g.volatility.score)], g.volatility.score >= 2 ? "warn" : "")}
        ${fact("Driver", pretty(g.driver.choice))}
        ${fact("Leading", pretty(g.leadership.choice))}
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
  function secWatchPage(r) {
    const tickers = activeList();
    const cards = tickers.map((t) => { const s = stockFor(t); if (s) return perspectiveCard(s, r); const q = r.lite && r.lite[t]; return q ? liteCard(t, q, r) : pendingCard(t); });
    return `<section class="watch-page">
      ${watchStrip(r)}
      ${explain("Every name you add is read three ways by the model: today's tape for a day trade, the next one to ten sessions for a swing, and the business plus the primary trend for the next three to twelve months. Verdicts are the model's stance from typed questions, not advice.")}
      ${cards.length ? `<div class="pboard">${cards.join("")}</div>` : '<div class="empty">Your watchlist is empty. Add a ticker or company above; stocks, ETFs and crypto all work.</div>'}
    </section>`;
  }
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
  const bigCap = (t, r) => { const s = stockFor(t); if (s && isNum((s.fundamentals || {}).market_cap)) return s.fundamentals.market_cap >= 10e9; const q = (r.lite || {})[t]; return !!(q && isNum(q.avg_dollar_volume) && q.avg_dollar_volume >= 1e9 && q.kind !== "ETF"); };
  const flowOf = (t, r) => { const q = Q.map[t] || {}; if (isNum(q.rvol)) return q; const l = ((r.lite || {})[t] || {}).scan; return l ? { rvol: l.rvol_tod, above_vwap: l.above_vwap, score: l.score, direction: l.direction } : {}; };
  function secBigMoney(r) {
    const sectors = ((r.flows || {}).sectors || []).map((x) => ({ ...x, chg: qp(x.symbol, { chg_pct: x.chg_1d, last: x.last }).chg })).filter((x) => isNum(x.chg)).sort((a, b) => b.chg - a.chg);
    const idx = Object.keys(INDEX_ETFS).map((t) => { const q = qp(t, (r.lite || {})[t] || (r.indices || []).find((i) => i.symbol === t)); const f = flowOf(t, r); return { t, q, f }; }).filter((x) => isNum(x.q.last));
    const tile = (x) => { const busy = isNum(x.f.rvol) ? (x.f.rvol >= 1.5 ? "up" : x.f.rvol <= 0.7 ? "down" : "flat") : "flat";
      const act = isNum(x.f.rvol) ? `<b class="${busy}">${x.f.rvol.toFixed(1)}×</b> the usual activity` : '<span class="muted">activity n/a</span>';
      const side = x.f.above_vwap == null ? "" : x.f.above_vwap ? '<span class="up">holding above the day\'s average price</span>' : '<span class="down">below the day\'s average price</span>';
      return `<div class="bm-tile ${cls(x.q.chg)}" data-ticker-page="${esc(x.t)}"><div class="bm-h"><b>${esc(x.t)}</b><span class="muted">${INDEX_ETFS[x.t]}</span></div>${priceHtml(x.t, null)}<div class="bm-act">${act}</div><div class="bm-side">${side}</div></div>`; };
    const large = Object.entries(Q.map).filter(([t, q]) => bigCap(t, r) && isNum(q.rvol) && q.rvol >= 1.3 && isNum(q.last)).map(([t, q]) => ({ t, q })).sort((a, b) => (b.q.dollar_vol || 0) - (a.q.dollar_vol || 0) || b.q.rvol - a.q.rvol).slice(0, 8);
    const nm = (t) => { const s = stockFor(t); return (s && s.name) || ((r.lite || {})[t] || {}).name || ""; };
    const rows = large.slice(0, 6).map(({ t, q }) => { const v = verdictFor(stockFor(t)); return `<tr class="clickable" data-ticker-page="${esc(t)}"><td class="sym"><b>${esc(t)}</b><div class="meta2">${esc(nm(t))}</div></td><td class="num">${priceHtml(t, null)}</td><td class="num"><b>${isNum(q.dollar_vol) ? fcap(q.dollar_vol) : "–"}</b><div class="meta2">traded today</div></td><td class="num"><b class="${q.rvol >= 2 ? "up" : ""}">${q.rvol.toFixed(1)}×</b><div class="meta2 ${q.direction === "up" ? "up" : q.direction === "down" ? "down" : ""}">${q.direction === "up" ? "buyers pressing" : q.direction === "down" ? "sellers pressing" : "two-way"}</div></td><td>${v ? `<span class="pill ${v.cls}">${v.word}</span>` : '<span class="muted">not analysed</span>'}</td></tr>`; }).join("");
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
    try { const res = await api("/api/brief", { cache: "no-store" }); if (!res.ok) return; const j = await res.json(); const sig = j.status === "ok" ? Object.values(j.briefs || {}).map((b) => b.generated_at).join("|") : ""; if (j.status === "ok" && (!brief || brief.sig !== sig)) { brief = j; brief.sig = sig; if (currentView === "home" && report) { const el = $(".briefs"); const tmp = document.createElement("div"); tmp.innerHTML = secBrief(report); if (el) el.replaceWith(tmp.firstElementChild); else { const cm = $(".view.home .col-main"); if (cm) cm.prepend(tmp.firstElementChild); } wireStocks(); jumpToBrief(); } } } catch (e) { /* server restarting */ }
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
    const facts = f.spy ? `<div class="meta2">SPY ${fnum(sp.last)} · ${sp.above_vwap == null ? "" : sp.above_vwap ? "above" : "below"} the day's average price · ${isNum(sp.range_pos) ? Math.round(sp.range_pos * 100) + "% of the day's range" : ""} · 1-hour RSI ${fnum((sp.hourly || {}).rsi_1h, 0)}</div><div class="meta2">QQQ ${fnum(qq.last)} · ${qq.above_vwap == null ? "" : qq.above_vwap ? "above" : "below"} the day's average price · RSI ${fnum((qq.hourly || {}).rsi_1h, 0)}${isNum(f.breadth_pct_above_20d) ? ` · breadth ${f.breadth_pct_above_20d}% above the 20-day` : ""}</div><div class="meta2">Mood: Reddit on SPY ${esc(sm.reddit_spy || "none")}, on QQQ ${esc(sm.reddit_qqq || "none")} · the President's recent posts ${esc(sm.trump_lean_recent || "none")}</div>` : "";
    const strip = (d.today || []).map((r) => { const k = DIR[r.expected] ? DIR[r.expected][1] : "flat"; const t = new Date(r.ts * 1000).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }); return `<span class="dir-dot ${k} ${r.hit === 1 ? "hit" : r.hit === 0 ? "miss" : ""}" title="${t} ET: ${r.expected || "–"}${r.hit == null ? "" : r.hit ? " · hit" : " · miss"}">${r.expected === "higher" ? "▲" : r.expected === "lower" ? "▼" : "▬"}</span>`; }).join("");
    const st = (d.stats || {}).totals || {};
    const scoredToday = (d.today || []).filter((r) => r.hit != null); const hitsToday = scoredToday.filter((r) => r.hit === 1).length;
    const verdict = d.market_state !== "open" && scoredToday.length ? `<div class="day-verdict"><b>Day verdict</b> ${hitsToday} of ${scoredToday.length} reads right (${Math.round(hitsToday / scoredToday.length * 100)}%). ${hitsToday / scoredToday.length >= 0.6 ? "The desk read the tape well today." : hitsToday / scoredToday.length >= 0.4 ? "A mixed day: the tape flipped on the desk more than once." : "The desk was wrong-footed today; the reads are logged for the model to learn from."}</div>` : "";
    return `<article class="bcard ${open ? "open" : ""}" data-brief-slot="direction">
      <div class="bcard-h"><b>Intraday direction</b><span class="muted">${esc((L.at || "").slice(11, 16))} ET · ${d.market_state === "open" ? (isNum(d.next_in_s) ? `next in ${Math.ceil(d.next_in_s / 60)} min` : "live") : "last read of the session"}</span></div>
      <div class="bc-idx"><span class="pill ${m[1]}">${m[0]}</span> ${convTag(L.confidence)}<div class="meta2">${L.driver ? "Mainly " + (DIR_DRIVER[L.driver] || pretty(L.driver)) + "." : ""}</div></div>
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
    return `<article class="bcard ${open ? "open" : ""}" data-brief-slot="${slot}">
      <div class="bcard-h"><b>${label}</b><span class="muted">${esc((b.generated_at || "").slice(11, 16))} ET${today ? "" : " · " + esc(b.date || "")}</span></div>
      <p class="bc-summary">${esc(b.summary || "")}</p>
      <div class="bc-chips">${chips}</div>
      <div class="bc-idx-row">${idx}</div>
      ${slot === "close" && b.scorecard ? (() => { const sc = b.scorecard; const mm = sc.morning_call ? (BRIEF_MOVE[sc.morning_call] || [pretty(sc.morning_call), "flat"])[0] : null; return `<div class="scorecard"><div class="sc-h">Scorecard <span class="muted">expectation vs what the market did</span></div>
        <div class="sc-row"><span>Intraday reads</span><b>${sc.scored ? `${sc.hits} of ${sc.scored} right · ${sc.hit_rate}%` : (sc.reads ? "not scored" : "none today")}</b></div>
        <div class="sc-row"><span>Morning call on SPY</span><b>${mm ? `${mm} → SPY ${fpct(sc.spy_day_pct, 2)} · ${sc.morning_hit === 1 ? '<i class="up">hit</i>' : sc.morning_hit === 0 ? '<i class="down">miss</i>' : "no direction"}` : "no call"}</b></div>
        <div class="dir-strip">${(sc.timeline || []).map((r) => `<span class="dir-dot ${DIR[r.expected] ? DIR[r.expected][1] : "flat"} ${r.hit === 1 ? "hit" : r.hit === 0 ? "miss" : ""}" title="${new Date(r.at * 1000).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false })} ET: ${r.expected}, SPY then ${fpct(r.move_spy_pct, 2)} to the close">${r.expected === "higher" ? "▲" : r.expected === "lower" ? "▼" : "▬"}</span>`).join("")}</div>
        <div class="meta2">${esc(sc.how || "")}</div></div>`; })() : ""}
      <div class="bc-more">
        ${slot === "morning" ? `<h5>Mega caps overnight</h5><div class="bf-megas">${mega || '<span class="muted">no quotes</span>'}</div>` : `<h5>Biggest moves</h5><div class="bf-megas">${movers || '<span class="muted">none</span>'}</div>${sectors}`}
        ${trump ? `<h5>The President, market-relevant</h5><ul class="bf-list">${trump}</ul>` : ""}
        ${ev ? `<h5>${slot === "close" ? "Tomorrow" : "Today"}</h5><ul class="bf-list">${ev}</ul>` : ""}
        <div class="meta2">${esc(b.note || "")}</div>
      </div>
      <button type="button" class="lnk bc-toggle" data-brief-toggle="${slot}">${open ? "less" : "more"}</button>
    </article>`;
  }
  function secBrief(r) {
    const j = brief; if (!j) return "";
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    const isToday = j.date === today;
    const cards = BRIEF_SLOTS.map(([slot, label, at]) => slot === "direction" ? directionCard() : briefCard((j.briefs || {})[slot], slot, label, at, isToday)).join("");
    return `<section class="briefs"><div class="briefs-h"><h3>Briefings <span class="muted">${isToday ? "today" : esc(j.date || "")} · morning at 07:00, a direction read every 15 minutes of the session, after the close at 16:30 ET · monitoring only, not advice</span></h3></div><div class="briefs-row">${cards}</div></section>`;
  }
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
      ${tile("Who should lead", pretty(g.leadership.choice), convTag(g.leadership.confidence), EX.lead[g.leadership.choice] || "")}
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
  function renderNav() {
    const label = (k) => VIEWS.find((v) => v[0] === k);
    const isAdmin = user && user.role === "admin";
    $("#nav").innerHTML = NAV_GROUPS.filter(([g]) => g !== "Admin" || isAdmin).map(([g, keys]) => `<div class="side-group">${g}</div>` + keys.map((k) => { const [, l, n] = label(k); const subs = SUBTABS[k];
      return `<button class="side-item v-${k} ${currentView === k ? "active" : ""}" data-view="${k}" title="${l}" aria-label="${l}" aria-current="${currentView === k ? "page" : "false"}"><span class="nav-ico">${ICONS[k]}</span><span class="side-label">${l}${k === "watch" && lists ? ` <span class="cnt">${Object.keys(lists.lists).length > 1 ? Object.keys(lists.lists).length + " lists" : activeList().length}</span>` : ""}</span><kbd>${n}</kbd></button>` +
        (subs && currentView === k ? `<div class="side-sub">${subs.map(([sk, sl]) => `<button class="${subTab[k] === sk ? "active" : ""}" data-sub="${k}:${sk}">${sl}</button>`).join("")}</div>` : ""); }).join("")).join("")
;
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
    root.querySelectorAll(".side-item").forEach((b) => { b.onclick = () => switchView(b.getAttribute("data-view")); });
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
        <h1>Welcome to OneView</h1>
        <p>Enter your email to receive a one-time sign-in link.</p>
        <form id="login-form" class="ov-fields" novalidate>
          <label for="login-email">Email address</label>
          <input type="email" id="login-email" name="email" placeholder="you@example.com" required autocomplete="email" inputmode="email" autofocus>
          <button class="ov-primary" type="submit" id="login-submit">Send sign-in link</button>
          <div class="ov-hint">No password needed.</div>
        </form>
        <div id="login-status" class="gate-status" role="status" aria-live="polite">${signedOutNote ? "Thank you, see you back again." : ""}</div>
        ${mailLine()}
        ${waJoin()}
      </div>`;
    return `<div class="ov-login login-stage"><div class="ov-lines" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
      <section class="ov-brand" aria-label="OneView">
        ${brandLogo(235)}<span class="ov-badge">Formerly Webex Traders</span>
        <div class="ov-statement"><h2 class="ov-tagline">Read the market.<br><span>Own your next move.</span></h2><p>A clearer view for day trades, swing setups, and long-term decisions.</p></div>
        <p class="ov-fine">Market data, model reads and scans are information, not advice.</p>
      </section>
      <section class="ov-formpanel" aria-label="Sign in">${form}</section>
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
  function renderGate() {
    const g = $("#gate"); if (!g) return;
    const lb = $("#logout-btn"); if (lb) { lb.hidden = !user; if (user) setLabel(lb, `Sign out · ${(user.name || user.email.split("@")[0]).slice(0, 14)}`); }
    if (!gateNeeded()) { g.hidden = true; g.innerHTML = ""; renderNav(); return; }
    const html = (STATIC_MODE ? (gateOpen ? loginHtml() : disclaimerHtml()) : (!user ? loginHtml() : disclaimerHtml()));
    g.hidden = false; g.innerHTML = html;
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
      } catch (err) { st.className = "gate-status err"; st.textContent = "The server is not reachable right now. Try again in a moment."; const b2 = $("#login-submit"); if (b2) { b2.disabled = false; b2.textContent = "Send sign-in link"; } }
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

  function renderAll() {
    const r = report;
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
    if (sub) { sub.innerHTML = `${esc(r.session_label.split(",")[0])} ${esc(r.session_date.slice(5).replace("-", "/"))} · report ${esc(r.generated_at.slice(11, 16))} ET · <span data-qstamp>${quoteStamp()}</span>`; }
    app.innerHTML = viewHtml(r);
    firstRender = false;
    const st = r.ai_stats;
    $("#footer").innerHTML = `<div class="foot">Prices: Yahoo Finance, 15-minute delayed · change is versus the prior close · report built ${r.generated_at.slice(11, 16)} ET${r.ai_enabled ? "" : " · model reads off this build"} · OneView is information, not advice.</div>`;
    mountCharts();
    wireStocks();
    if (currentView === "home") jumpToBrief();
  }

  function viewHtml(r) {
    switch (currentView) {
      case "home": return `<div class="view home"><div class="col-main">${secBrief(r)}<div class="home-hero">${secBigMoney(r)}${secVoices(r)}</div><div class="home-top">${moodPanel(r)}${verdictPanel(r)}</div>${secRunners(r)}${secMeaning(r)}</div>${secToday(r)}</div>`;
      case "record": return `<div class="view one">${secRecord()}</div>`;
      case "watch": return `<div class="view one">${secWatchPage(r)}</div>`;
      case "ticker": return `<div class="view one ticker-view">${secTickerPage(r)}</div>`;
      case "admin": if (!(user && user.role === "admin")) { currentView = "home"; return viewHtml(r); } return `<div class="view one admin-view">${secAdmin()}</div>`;
      case "scan": return `<div class="view sub">${subTabs("scan")}<div class="subview">${subTab.scan === "lowfloat" ? secLowFloat(r) : secScan(r)}</div></div>`;
      case "stock": return `<div class="view stock">${secStocks(r)}</div>`;
      case "theme": return `<div class="view one">${secTheme(r)}</div>`;
      case "smart": return `<div class="view sub">${subTabs("smart")}<div class="subview">${subTab.smart === "options" ? secOptions(r) : secSmart(r)}</div></div>`;
      case "macro": return `<div class="view sub">${subTabs("macro")}<div class="subview ${subTab.macro}">${{ picture: () => secRegime(r) + secHorizons(r), indexes: () => secMacro(r) + secIndexesWeekly(r), rates: () => secRates(r), flows: () => secFlows(r) }[subTab.macro]()}</div></div>`;
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
    if (k === "admin" && !(user && user.role === "admin")) return;
    if (k === "record") loadRecord();
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

  async function poll() {
    try {
      const st = await (await api("/api/status", { cache: "no-store" })).json();
      const btn = $("#refresh-btn");
      if (st.building) { btn.disabled = true; setLabel(btn, "Building…"); }
      else if (st.refresh_available_in_s > 0) { btn.disabled = true; setLabel(btn, `Refresh (${st.refresh_available_in_s}s)`); }
      else { btn.disabled = false; setLabel(btn, "Refresh"); }
      if (st.last_error) notice("Last build failed: " + st.last_error);
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
    setTimeout(pollDirection, 3000);
    setInterval(pollLiveScan, 60000);
    setTimeout(pollLiveScan, 2500);
    setInterval(pollAdmin, 30000);
    setTimeout(pollAdmin, 3000);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
