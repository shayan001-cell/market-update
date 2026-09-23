/* Market Update client. Renders the report JSON (embedded or fetched) and
   handles refresh, auto-update polling, theme, tabs and stock detail. */
(function () {
  "use strict";

  // ---------------------------------------------------------------- state
  const EMBEDDED = document.getElementById("report-data");
  const STATIC_MODE = !!EMBEDDED;
  let report = null;
  let selectedTicker = null;
  let stockTab = "all";
  let sortKey = "swing";
  const tvLink = (t) => `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(t.replace("-", "."))}`;
  let charts = [];
  let firstRender = true;
  const VIEWS = [["home", "HOME", "1"], ["stock", "STOCK", "2"], ["theme", "THEME", "3"], ["smart", "SMART $", "4"], ["macro", "MACRO", "5"], ["market", "MARKET", "6"], ["flows", "FLOWS", "7"], ["news", "NEWS", "8"], ["options", "OPTIONS", "9"]];
  let currentView = (location.hash.match(/view=([a-z]+)/) || [])[1] || "home";
  let lastInteraction = Date.now();
  let pendingReport = null;
  ["scroll", "pointerdown", "keydown", "wheel", "touchstart"].forEach((ev) => addEventListener(ev, () => { lastInteraction = Date.now(); }, { passive: true }));

  // ---------------------------------------------------------------- utils
  const $ = (sel, el) => (el || document).querySelector(sel);
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
  const arrow = (x) => (!isNum(x) ? "" : x > 0 ? ICON_UP : x < 0 ? ICON_DOWN : ICON_FLAT);
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
    reason: { trend_and_entry: "because of the trend and the entry", extended: "because it has run too far from its averages", resistance: "because of overhead resistance", event_risk: "because of a dated event ahead", smart_money: "because of who is buying or selling", market_tone: "because of the market mood", poor_reward: "because the reward does not justify the risk" },
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
  const conf = (c) => (isNum(c) && c < 0.5 ? `<span class="tag lowconf" title="model confidence ${c.toFixed(2)}">low conf</span>` : "");
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
    const t = s.technicals, a = s.ai, px = s.last_price;
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

  function watchCard(s, compact, r) {
    const a = s.ai || {}, t = s.technicals, c = cls(s.chg_pct), pa = s.price_action || {};
    const lean = a.bias ? a.bias.choice : "neutral";
    const leanCls = { long: "up", short: "down" }[lean] || "flat";
    const pl = plan(s);
    const flags = s.tags.filter((x) => x === "event_risk" || x === "extended").map(tagHtml).join("");
    const earn = s.fundamentals && isNum(s.fundamentals.days_to_earnings) && s.fundamentals.days_to_earnings >= 0 && s.fundamentals.days_to_earnings <= 10 ? `<span class="tag warn">earnings in ${s.fundamentals.days_to_earnings}d</span>` : "";
    const st = a.stance ? a.stance.choice : null;
    const it = a.intraday ? ST.intraday[a.intraday.choice] : null;
    const verdict = st ? `<div class="verdict ${ST.cls[st]}"><div class="verdict-word">${ST.stance[st][0]}</div><div class="verdict-why">${ST.stance[st][1]} ${a.main_reason ? "Mainly " + ST.reason[a.main_reason.choice] + "." : ""} ${a.stance.confidence < 0.45 ? '<span class="tag lowconf">low confidence</span>' : `<span class="muted">${(a.stance.confidence * 100).toFixed(0)}% sure</span>`}</div>${it ? `<div class="verdict-intra"><span class="pill ${it[2]}">Intraday: ${it[0]}</span> <span class="muted">${it[1]}${a.intraday.confidence < 0.45 ? " Low confidence." : ""}</span></div>` : ""}</div>` : "";
    return `<article class="wcard ${leanCls}" data-ticker="${esc(s.ticker)}">
      <div class="wc-head"><div><span class="wc-ticker">${esc(s.ticker)}</span><span class="wc-name">${esc(s.name)}</span></div><div class="wc-price"><span class="px">${fnum(s.last_price)}</span> <span class="delta ${c}">${arrow(s.chg_pct)} ${fpct(s.chg_pct)}</span></div></div>
      ${verdict}
      <div class="wc-lean"><span class="lean ${leanCls}">${lean.toUpperCase()}</span><span class="wc-leansub">${a.bias ? `${(a.bias.confidence * 100).toFixed(0)}% sure` : "no model read"} · ${a.setup ? pretty(a.setup.choice) : "–"}</span></div>
      <div class="wc-scores"><span title="Swing setup quality, 0–100">Swing setup: <b>${words(s.scores.swing, 1.0001, SCORE_WORDS)}</b> <span class="muted">${(s.scores.swing * 100).toFixed(0)}</span></span><span title="Day-trade fit, 0–100">Day trade: <b>${words(s.scores.day, 1.0001, SCORE_WORDS)}</b> <span class="muted">${(s.scores.day * 100).toFixed(0)}</span></span><span title="Average daily move">Moves ${fpct(t.atr_pct, 1, false)} a day</span></div>
      ${compact ? "" : `<div class="wc-who"><div class="wc-who-h">Who is buying</div>${whoHtml(s)}</div>`}
      ${a.price_action ? `<div class="wc-pa">${PA.control[a.price_action.choice] || ""} ${PA.structure[pa.structure] || ""} Last candle: ${pretty(pa.pattern || "ordinary")}.</div>` : ""}
      ${pl ? `<div class="wc-plan ${pl.lean}">${pl.text}</div>` : '<div class="wc-plan">Model read unavailable for this build.</div>'}
      ${checklistHtml(checklist(s, r || report))}
      ${flags || earn || smBadge(s) || opBadge(s) ? `<div class="wc-flags">${earn}${flags}${smBadge(s)}${opBadge(s)}</div>` : ""}
      ${compact ? "" : ""}
      <div class="wc-actions"><button class="btn sm" data-open="${esc(s.ticker)}">Full analysis</button><a class="btn sm ghost" href="${tvLink(s.ticker)}" target="_blank" rel="noopener">Open chart</a></div>
    </article>`;
  }

  function moodPanel(r) {
    const g = r.regime; if (!g) return `<section class="panel mood flat"><h3>Market mood</h3><div class="muted">Model read unavailable this build.</div></section>`;
    const volL = ["quiet", "normal", "elevated", "extreme"];
    const tone = g.tone.choice, cl = { risk_on: "up", risk_off: "down", mixed: "flat" }[tone];
    const fact = (label, value, c) => `<div class="fact"><span class="fact-l">${label}</span><span class="fact-v ${c || ""}">${value}</span></div>`;
    return `<section class="panel mood ${cl}">
      <h3>Market mood · ${esc(r.session_label.split(",")[0])}</h3>
      <div class="mood-row"><span class="mood-tone">${pretty(tone).toUpperCase()}</span><span class="mood-conf muted">${(g.tone.confidence * 100).toFixed(0)}% sure</span></div>
      <p class="mood-why">${EX.tone[tone]}</p>
      <div class="facts">
        ${fact("Swings", volL[Math.round(g.volatility.score)], g.volatility.score >= 2 ? "warn" : "")}
        ${fact("Driver", pretty(g.driver.choice))}
        ${fact("Leading", pretty(g.leadership.choice))}
        ${fact("Rates", pretty(g.rates_read.choice), { tailwind: "up", headwind: "down" }[g.rates_read.choice] || "")}
        ${fact("Money flow", pretty(g.flow_read.choice))}
      </div>
    </section>`;
  }

  function whatsappMessage(r) {
    const B = (t) => `*${t}*`, I = (t) => `_${t}_`;
    const NB = " "; const IND = NB + NB + NB + NB;            // indent that WhatsApp keeps
    const DIV = "━━━━━━━━━━━━━━━━━━━━";
    const role = (p) => { p = (p || "").toLowerCase(); if (p.includes("chief executive")) return "CEO"; if (p.includes("chief financial")) return "CFO"; if (p.includes("chief technology")) return "CTO"; if (p.includes("chief operating")) return "COO"; if (p.includes("president")) return "President"; if (p.includes("director")) return "Director"; if (p.includes("10%")) return "10% owner"; if (p.includes("officer")) return "Officer"; return p ? p[0].toUpperCase() + p.slice(1, 18) : "Insider"; };
    const dm = (d) => { const [y, m, day] = d.split("-"); return `${parseInt(day, 10)} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][parseInt(m, 10) - 1]}`; };
    const name = (n) => { const parts = (n || "").split(" "); return parts.length > 1 ? `${parts.slice(1).join(" ")} ${parts[0]}` : n; }; // "Cohen Ryan" -> "Ryan Cohen"
    const rows = (r.smart_money && r.smart_money.rows) || [];
    const buys = rows.flatMap((m) => (m.insider.open_market_buys_90d || []).map((b) => ({ t: m.ticker, ...b }))).filter((b) => (b.value || 0) > 0).sort((a, b) => b.value - a.value).slice(0, 8);
    const g = r.regime;
    const L = [];
    L.push(`📟 ${B("MARKET UPDATE")} · ${dm(r.session_date)} ${r.session_date.slice(0, 4)}`);
    L.push(DIV);
    if (g) {
      const me = { risk_on: "🟢", risk_off: "🔴", mixed: "🟡" }[g.tone.choice];
      L.push(`${me} ${B("MOOD: " + pretty(g.tone.choice).toUpperCase())} ${I((g.tone.confidence * 100).toFixed(0) + "% sure")}`);
      L.push(`${IND}⚡ Driver: ${pretty(g.driver.choice)}`);
      L.push(`${IND}🏦 Rates: ${pretty(g.rates_read.choice)}`);
      L.push(`${IND}💸 Money flow: ${pretty(g.flow_read.choice)}`);
      L.push("");
    }
    L.push(`💼 ${B("INSIDERS ARE BUYING")}`);
    L.push(I("SEC Form 4 · open-market buys · last 90 days"));
    if (buys.length) buys.forEach((b) => { L.push(`🟢 ${B(b.t)} · ${name(b.insider)}, ${role(b.position)}`); L.push(`${IND}💵 ${fcap(b.value)} · ${dm(b.date)}`); });
    else L.push("▪️ No open-market insider buys in the analysed names.");
    const sells = rows.filter((m) => (m.insider.sell_value_90d || 0) > 20e6).sort((a, b) => b.insider.sell_value_90d - a.insider.sell_value_90d).slice(0, 4);
    if (sells.length) { L.push(""); L.push(`🚪 ${B("INSIDERS SELLING")}`); sells.forEach((m) => L.push(`🔻 ${B(m.ticker)} · ${fcap(m.insider.sell_value_90d)} sold`)); }
    const cg = (r.smart_money && r.smart_money.congress_top) || [];
    if (cg.length) { L.push(""); L.push(`🏛️ ${B("CONGRESS BUYING")}`); L.push(`${IND}${cg.slice(0, 6).map((x) => `${x.ticker} ×${x.buys}`).join("  ·  ")}`); }
    const hv = ((r.options && r.options.heavy) || []).slice(0, 5);
    if (hv.length) { L.push(""); L.push(`📊 ${B("HEAVY OPTIONS BUYING")}`); L.push(I("volume swamping open interest · today")); hv.forEach((u) => L.push(`${u.side === "call" ? "📈" : "📉"} ${B(u.ticker)} ${fnum(u.strike, 0)}${u.side === "call" ? "C" : "P"} ${u.dte}d · ${fvol(u.volume)} contracts · ${fcap(u.notional)}`)); }
    const watch = r.stocks.filter((s) => s.on_watchlist && s.ai && s.ai.stance);
    if (watch.length) {
      L.push(""); L.push(`🎯 ${B("WATCHLIST VERDICTS")}`); L.push(I("swing · intraday"));
      watch.forEach((s) => { const st = s.ai.stance.choice; const e = { buy_now: "✅", buy_the_dip: "🟢", wait_for_breakout: "⏳", hold_dont_add: "✋", avoid: "⛔", short_setup: "🔻" }[st];
        L.push(`${e} ${B(s.ticker)} ${fnum(s.last_price)} (${fpct(s.chg_pct)})`);
        L.push(`${IND}📈 Swing: ${B(ST.stance[st][0])}`);
        if (s.ai.intraday) L.push(`${IND}⏱ Intraday: ${ST.intraday[s.ai.intraday.choice][0]}`); });
    }
    L.push(DIV);
    L.push(I("Model reads from typed questions, not advice. Full board on the Market Update dashboard."));
    return L.join("\n");
  }
  function sharePanel(r) {
    const msg = whatsappMessage(r);
    const href = "https://wa.me/?text=" + encodeURIComponent(msg);
    const html = esc(msg).replace(/\*([^*\n]+)\*/g, "<b>$1</b>").replace(/_([^_\n]+)_/g, "<i>$1</i>").replace(/━{6,}/g, '<span class="wa-div"></span>').split("\n").map((l) => `<div class="wa-line${/^(💼|🚪|🏛️|🎯|📟|🟢 <b>MOOD)/.test(l) ? " wa-head" : ""}">${l || "&nbsp;"}</div>`).join("");
    return `<details class="share">
      <summary><span class="wa-logo" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5.1-1.3A10 10 0 1 0 12 2zm0 1.8a8.2 8.2 0 1 1-4.2 15.3l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 0 1 12 3.8zm-3 4.4c-.2 0-.5 0-.7.3-.3.3-.9.9-.9 2.2s.9 2.6 1.1 2.8c.1.2 1.8 2.8 4.4 3.8 2.2.9 2.6.7 3.1.6.5 0 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.2-.2-.5-.3l-1.7-.8c-.2-.1-.4-.1-.6.1-.2.3-.7.8-.8 1-.2.2-.3.2-.6.1-.3-.1-1.1-.4-2.1-1.3-.8-.7-1.3-1.5-1.5-1.8-.1-.3 0-.4.1-.5l.4-.5.3-.4c.1-.2 0-.3 0-.5l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5z"/></svg></span>
        <span class="share-title">WhatsApp brief: what insiders are buying</span>
        <span class="muted">${(r.smart_money && r.smart_money.rows || []).reduce((n, m) => n + (m.insider.open_market_buys_90d || []).length, 0)} insider buys · ${r.stocks.filter((s) => s.on_watchlist).length} verdicts · tap to preview</span>
        <a class="btn wa" href="${href}" target="_blank" rel="noopener" data-stop>Send on WhatsApp</a>
        <button class="btn ghost sm" data-copy data-stop>Copy text</button>
      </summary>
      <div class="chat"><div class="bubble"><div class="bubble-text">${html}</div><div class="bubble-meta">${r.generated_at.slice(11, 16)} ✓✓</div></div></div>
      <textarea class="share-src" hidden>${esc(msg)}</textarea>
    </details>`;
  }

  function verdictPanel(r) {
    const watch = r.stocks.filter((s) => s.on_watchlist && s.ai && s.ai.stance);
    if (!watch.length) return `<section class="panel verdicts"><h3>Final verdicts</h3><div class="muted">No verdicts yet.</div></section>`;
    const order = ["buy_now", "buy_the_dip", "wait_for_breakout", "hold_dont_add", "avoid", "short_setup"];
    watch.sort((a, b) => order.indexOf(a.ai.stance.choice) - order.indexOf(b.ai.stance.choice) || b.scores.swing - a.scores.swing);
    const counts = order.map((k) => [k, watch.filter((s) => s.ai.stance.choice === k).length]).filter(([, n]) => n);
    const rows = watch.map((s) => { const st = s.ai.stance; return `<li class="vrow" data-open="${esc(s.ticker)}">
        <span class="v-t">${esc(s.ticker)}</span>
        <span class="pill ${ST.cls[st.choice]}">${ST.stance[st.choice][0]}</span>
        <span class="pill v-intra ${s.ai.intraday ? ST.intraday[s.ai.intraday.choice][2] : "flat"}">${s.ai.intraday ? ST.intraday[s.ai.intraday.choice][0] : "–"}</span>
        <span class="v-why">${s.ai.main_reason ? esc(ST.reason[s.ai.main_reason.choice].replace(/^because of /, "").replace(/^because /, "")) : ""}</span>
        <span class="v-conf muted">${st.confidence < 0.45 ? "low conf" : (st.confidence * 100).toFixed(0) + "%"}</span></li>`; }).join("");
    return `<section class="panel verdicts">
      <h3>Final verdicts · ${watch.length} on watchlist <span class="muted" style="text-transform:none;letter-spacing:0">swing · intraday</span></h3>
      <div class="v-summary">${counts.map(([k, n]) => `<span class="pill ${ST.cls[k]}">${n} ${ST.stance[k][0].toLowerCase()}</span>`).join("")}</div>
      <ul class="vlist">${rows}</ul>
      <div class="meta2">Verdict = the model's stance from every read combined. Click a row for the full analysis.</div>
    </section>`;
  }

  function secBoard(r) {
    const mood = "";
    const watch = r.stocks.filter((s) => s.on_watchlist).sort((a, b) => b.scores.swing - a.scores.swing);
    const others = r.stocks.filter((s) => !s.on_watchlist && s.tags.includes("swing")).sort((a, b) => b.scores.swing - a.scores.swing).slice(0, 4);
    const watchHtml = watch.length ? `<div class="board">${watch.map((s) => watchCard(s, false, r)).join("")}</div>`
      : `<div class="empty">Your watchlist is empty. Add one ticker per line to <code>watchlist.txt</code> and rebuild; each name gets a lean, a plan and full analysis here.</div>`;
    return `<section class="top">
      <h2>Your watchlist <span class="muted">lean for the next 1–5 sessions · plan uses yesterday's range, the 20-day average and 20-day high/low</span></h2>
      ${watchHtml}
      ${others.length ? `<h2>Best swing setups outside your list <span class="muted">top ${others.length} by swing score</span></h2><div class="board">${others.map((s) => watchCard(s, true, r)).join("")}</div>` : ""}
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
      ${O.ai ? `<div class="tile"><div class="tile-label">Positioning read</div><div class="tile-value small">${pretty(O.ai.positioning.choice)}</div>${explain(OP.pos[O.ai.positioning.choice] || "")}<div class="tile-sub">${(O.ai.positioning.confidence * 100).toFixed(0)}% ${conf(O.ai.positioning.confidence)} · most notional in <b>${pretty(O.ai.where_volume_flows.choice)}</b></div></div>` : ""}
    </div>`;
    const rows = O.rows.map((o) => { const a = o.ai || {}; const rd = a.read ? OP.read[a.read.choice] : null; const tc = (o.top_calls || [])[0], tp = (o.top_puts || [])[0];
      return `<tr>
        <td class="sym"><b>${esc(o.ticker)}</b><div class="meta2">${isNum(o.spot) ? fnum(o.spot) : ""} · IV ${isNum(o.atm_iv) ? (o.atm_iv * 100).toFixed(0) + "%" : "–"}</div></td>
        <td class="num">${fcap(o.total_notional)}<div class="meta2">${fcap(o.call_notional)} calls · ${fcap(o.put_notional)} puts</div></td>
        <td class="num"><span class="up">${fvol(o.call_volume)}</span> / <span class="down">${fvol(o.put_volume)}</span><div class="meta2">P/C ${o.pc_volume ?? "–"} · OI P/C ${o.pc_oi ?? "–"}</div></td>
        <td><div class="brd" style="grid-template-columns:1fr 44px;margin:0"><span class="bar" style="width:100%"><span class="bar-fill up" style="width:${isNum(o.call_share) ? (o.call_share * 100).toFixed(0) : 0}%"></span></span><span class="num">${isNum(o.call_share) ? (o.call_share * 100).toFixed(0) + "%" : "–"}</span></div><div class="meta2">share of $ in calls</div></td>
        <td>${tc ? `<b>${fnum(tc.strike, 0)}C</b> ${tc.dte}d <span class="muted">${fvol(tc.volume)} vol · ${fcap(tc.notional)}${isNum(tc.otm_pct) ? " · " + fpct(tc.otm_pct, 0) + " OTM" : ""}</span>` : "–"}<div class="meta2">${tp ? `<b>${fnum(tp.strike, 0)}P</b> ${tp.dte}d ${fvol(tp.volume)} vol · ${fcap(tp.notional)}` : ""}</div></td>
        <td>${(o.unusual || []).slice(0, 2).map((u) => `<div><span class="${u.side === "call" ? "up" : "down"}">${fnum(u.strike, 0)}${u.side === "call" ? "C" : "P"}</span> ${u.dte}d · ${fvol(u.volume)} vol vs ${fvol(u.oi)} OI (${u.vol_oi}×) · ${fcap(u.notional)}</div>`).join("") || '<span class="muted">none</span>'}</td>
        <td>${rd ? `<span class="pill ${rd[2]}">${rd[0]}</span> ${conf(a.read.confidence)}<div class="meta2">${OP.intensity[Math.round(a.intensity.score)]} · ${esc(rd[1])}</div>` : "–"}</td></tr>`; }).join("");
    const heavy = (O.heavy || []).slice(0, 12).map((u) => `<li><b>${esc(u.ticker)}</b> <span class="${u.side === "call" ? "up" : "down"}">${fnum(u.strike, 0)} ${u.side}</span> · ${esc(u.expiry)} (${u.dte}d) · ${fvol(u.volume)} contracts vs ${fvol(u.oi)} open (${u.vol_oi}×) · <b>${fcap(u.notional)}</b>${isNum(u.otm_pct) ? ` · ${fpct(u.otm_pct, 0)} from spot` : ""}</li>`).join("");
    return `<section class="op-section"><h2>Options flow: where the volume is going <span class="muted">Yahoo chains, nearest three expiries, cached 30 min · Cboe daily ratios as of ${esc(cb.as_of || "–")} · "unusual" = volume ≥ 3× open interest and ≥ $250k</span></h2>
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
    const card = (m) => { const c = m.ai.conviction.score, who = m.ai.who.choice; const b = (m.insider.open_market_buys_90d || [])[0];
      const headline = b ? `${b.insider} (${(b.position || "").toLowerCase().replace("chief executive officer", "CEO").replace("chief financial officer", "CFO")}) bought ${fcap(b.value)} · ${b.date.slice(5)}` : SM.who[who];
      return `<article class="sm-card ${c >= 1.5 ? "acc" : c < 0.5 ? "dist" : "quiet"}" data-open="${esc(m.ticker)}">
        <div class="sm-head"><b class="sm-t">${esc(m.ticker)}</b>${meter(c)}<span class="sm-who pill ${{ insiders_buying: "up", institutions_adding: "up", politicians_buying: "up", insiders_selling: "down", institutions_trimming: "down", shorts_pressing: "down" }[who] || "flat"}">${pretty(who)}</span></div>
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
    return `<section class="sm-section"><h2>Smart money <span class="muted">who is positioning · insider open-market trades (SEC Form 4), 13F holder changes, congressional STOCK Act filings, short interest · click a card for the full analysis</span></h2>
      ${head}
      <div class="sm-board">${cols}</div></section>`;
  }

  // ---------------------------------------------------------------- theme screen: who can run
  const TH = {
    stage: { early: "Early: leaders just breaking out, most groups still flat.", mid: "Mid: leaders extended, second-tier groups turning up; participation broadening.", late: "Late: nearly every group up and extended; laggards running.", exhausted: "Exhausted: leaders rolling over while laggards spike.", broken: "Broken: most groups in downtrends." },
    phase: { leader: "Leading the group", catching_up: "Catching up", laggard: "Lagging", extended: "Extended after a vertical run", broken: "Broken" },
    lev: ["peripheral", "meaningful", "core", "pure play"],
    move: ["market-like", "amplified", "explosive", "parabolic candidate"],
    fund: ["story only", "mixed", "supported", "underpriced"],
    group: { compute: "Compute", memory_storage: "Memory & storage", networking_optics: "Networking & optics", servers_cooling: "Servers & cooling", power: "Power", semicap: "Chip equipment", real_estate: "Data-center REITs", platforms: "Hyperscalers & clouds" },
  };
  let themeGroup = "all";
  function secTheme(r) {
    const T_ = r.theme; if (!T_ || !T_.rows || !T_.rows.length) return "";
    const ai = T_.ai;
    const head = ai ? `<div class="hz-cross th-cross">
        <div class="tile"><div class="tile-label">Where the theme is</div><div class="tile-value small">${pretty(ai.stage.choice)}</div>${explain(TH.stage[ai.stage.choice] || "")}<div class="tile-sub">${(ai.stage.confidence * 100).toFixed(0)}% confidence ${conf(ai.stage.confidence)}</div></div>
        <div class="tile"><div class="tile-label">Likely next leg</div><div class="tile-value small">${TH.group[ai.next_group.choice] || pretty(ai.next_group.choice)}</div>${explain("The part of the stack whose relative strength is turning while the leaders rest.")}<div class="tile-sub">${(ai.next_group.confidence * 100).toFixed(0)}% confidence ${conf(ai.next_group.confidence)}</div></div>
        <div class="tile"><div class="tile-label">Group scoreboard, 1 month vs SPY</div><div class="th-groups">${T_.groups.slice().sort((a, b) => (b.avg_rel_vs_spy_1m || 0) - (a.avg_rel_vs_spy_1m || 0)).map((g) => `<div class="th-g"><span>${TH.group[g.group] || g.group}</span><span class="num ${cls(g.avg_rel_vs_spy_1m)}">${fpct(g.avg_rel_vs_spy_1m, 1)}</span><span class="muted">${(g.share_in_uptrend * 100).toFixed(0)}% in uptrend</span></div>`).join("")}</div></div>
      </div>` : "";
    const groups = ["all", ...Object.keys(TH.group).filter((k) => T_.rows.some((x) => x.group === k))];
    const tabs = groups.map((k) => `<button class="tab ${themeGroup === k ? "active" : ""}" data-theme-group="${k}">${k === "all" ? "All" : TH.group[k]}</button>`).join("");
    const rows = T_.rows.filter((x) => themeGroup === "all" || x.group === themeGroup).map((x) => {
      const a = x.ai || {}, t = x.technicals, f = x.fundamentals || {}, pa = x.price_action || {};
      const ph = a.phase ? a.phase.choice : "";
      return `<tr>
        <td class="sym"><b>${esc(x.ticker)}</b> <span class="tag">${TH.group[x.group] || x.group}</span><div class="meta2">${esc(x.name || "")}</div></td>
        <td class="num">${fnum(x.last_price)}<div class="delta ${cls(x.chg_pct)}">${arrow(x.chg_pct)} ${fpct(x.chg_pct)}</div></td>
        <td class="num"><span class="${cls(t.ret_1m)}">${fpct(t.ret_1m, 1)}</span> / <span class="${cls(t.ret_3m)}">${fpct(t.ret_3m, 1)}</span><div class="meta2">vs SPY <span class="${cls(x.rel_1m)}">${fpct(x.rel_1m, 1)}</span> / <span class="${cls(x.rel_3m)}">${fpct(x.rel_3m, 1)}</span></div></td>
        <td><span class="${{ up: "up", down: "down" }[t.trend] || "flat"}">${t.trend}</span><div class="meta2">${pretty(pa.structure || "")} · ${fpct(t.dist_sma20_pct, 0)} vs 20d · RSI ${fnum(t.rsi14, 0)}</div></td>
        <td class="num">${fpct(t.atr_pct, 1, false)}<div class="meta2">β ${fnum(f.beta, 1)} · short ${isNum(f.short_float) ? (f.short_float * 100).toFixed(0) + "%" : "–"}</div></td>
        <td class="num">${isNum(f.rev_growth) ? fpct(f.rev_growth * 100, 0) : "–"}<div class="meta2">fwd P/E ${fnum(f.forward_pe, 0)} · ${a.fundamental_support ? TH.fund[Math.round(a.fundamental_support.score)] : "–"}</div></td>
        <td>${a.theme_leverage ? `${bar(a.theme_leverage.score, 3)}<span class="mono">${TH.lev[Math.round(a.theme_leverage.score)]}</span>` : "–"}</td>
        <td>${a.move_potential ? `${bar(a.move_potential.score, 3)}<span class="mono">${TH.move[Math.round(a.move_potential.score)]}</span>` : "–"}</td>
        <td><span class="pill ${{ leader: "up", catching_up: "up", broken: "down", extended: "warn" }[ph] || "flat"}">${pretty(ph)}</span> ${a.phase ? conf(a.phase.confidence) : ""}</td>
        <td class="num">${bar(x.rank, 1)}<span class="mono">${(x.rank * 100).toFixed(0)}</span><div class="meta2">${smBadge(x)}${opBadge(x)}${(x.tags || []).map((g) => `<span class="tag ${g === "extended" ? "bad" : g === "earnings_soon" ? "warn" : g === "new_high" ? "ok" : "acc"}">${pretty(g)}</span>`).join("")}</div></td>
        <td><a class="btn sm ghost" href="${tvLink(x.ticker)}" target="_blank" rel="noopener">Chart</a></td></tr>`;
    }).join("");
    return `<section class="th-section"><h2>${esc(T_.name)}: who can run <span class="muted">${T_.rows.length} names by role in the stack · ranked by theme leverage × move potential × trend × volatility × relative strength · SPY ${fpct(T_.spy_ret_1m, 1)} / ${fpct(T_.spy_ret_3m, 1)} over 1 / 3 months</span></h2>
      ${head}
      <div class="tabs">${tabs}</div>
      <div class="tbl-wrap"><table class="tbl th-tbl"><thead><tr><th>Name</th><th>Price</th><th>1m / 3m</th><th>Trend</th><th>Daily range</th><th>Rev growth</th><th>Theme leverage</th><th>Move potential</th><th>Phase</th><th>Run score</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
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
        <div class="tile"><div class="tile-label">Macro picture, last 3–6 months</div><div class="tile-value small">${pretty(cx.macro_read.choice)}</div>${explain(HZ.macro[cx.macro_read.choice] || "")}<div class="tile-sub">${(cx.macro_read.confidence * 100).toFixed(0)}% confidence ${conf(cx.macro_read.confidence)}</div></div>
        <div class="tile"><div class="tile-label">Equity lean, next 3 months</div><div class="tile-value small ${{ higher: "up", lower: "down" }[cx.equity_lean_3m.choice] || "flat"}">${cx.equity_lean_3m.choice}</div>${explain(HZ.lean[cx.equity_lean_3m.choice] || "")}<div class="tile-sub">${(cx.equity_lean_3m.confidence * 100).toFixed(0)}% confidence ${conf(cx.equity_lean_3m.confidence)} · a lean, not a forecast</div></div>
        <div class="tile"><div class="tile-label">Biggest risk to the trend</div><div class="tile-value small">${pretty(cx.biggest_risk.choice)}</div>${explain(HZ.risk[cx.biggest_risk.choice] || "")}<div class="tile-sub">${(cx.biggest_risk.confidence * 100).toFixed(0)}% confidence ${conf(cx.biggest_risk.confidence)}</div></div>
      </div>` : "";
    return `<section class="hz-section"><h2>Big picture: 1, 3, 6 and 12 months <span class="muted">S&amp;P futures, Nasdaq 100, gold, oil, 10-year · return, position in range, drawdown, structure · click a row for the weekly chart</span></h2>
      ${cross}
      <div class="tbl-wrap"><table class="tbl hz-tbl"><thead><tr><th>Asset</th>${keys.map((k) => `<th>${k.replace("m", " month").replace("1 month", "1 month").replace("12 month", "12 months").replace("3 month", "3 months").replace("6 month", "6 months")}</th>`).join("")}<th>Model read</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  function weeklyChart(el, bars) {
    if (!window.LightweightCharts || !bars || !bars.length) { el.innerHTML = '<div class="muted" style="padding:20px">chart unavailable</div>'; return; }
    const dark = document.documentElement.getAttribute("data-theme") === "dark" || (!document.documentElement.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
    const chart = LightweightCharts.createChart(el, { height: 220, layout: { background: { color: "transparent" }, textColor: cssVar("--muted") || "#888", fontSize: 11 },
      grid: { vertLines: { color: dark ? "#26262a" : "#eeede9" }, horzLines: { color: dark ? "#26262a" : "#eeede9" } },
      rightPriceScale: { borderColor: cssVar("--border") }, timeScale: { borderColor: cssVar("--border") }, crosshair: { mode: 0 }, handleScroll: false, handleScale: false });
    const up = cssVar("--up"), down = cssVar("--down");
    const s = chart.addCandlestickSeries({ upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down });
    s.setData(bars.map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c })));
    const sma = (n) => { const out = []; for (let i = n - 1; i < bars.length; i++) { let a = 0; for (let j = i - n + 1; j <= i; j++) a += bars[j].c; out.push({ time: bars[i].t, value: a / n }); } return out; };
    if (bars.length >= 10) chart.addLineSeries({ color: cssVar("--s1"), lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(sma(10));
    if (bars.length >= 40) chart.addLineSeries({ color: cssVar("--s2"), lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(sma(40));
    chart.timeScale().fitContent();
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth })); ro.observe(el);
    charts.push({ chart, ro });
  }

  // ---------------------------------------------------------------- HOME right column: today's sheet
  function secToday(r) {
    const cal = (r.calendar || []).slice(0, 5).map((c) => `<li><samp>${esc(c.time_et)}</samp> ${esc(c.title)} <span class="muted">${c.relevance.toFixed(1)}</span></li>`).join("") || "<li class=\"muted\">no relevant events</li>";
    const earn = (r.earnings || []).slice(0, 4).map((e) => `<li><b>${esc(e.symbol)}</b> ${esc(e.report_time)} <span class="muted">${e.attention.toFixed(1)}</span></li>`).join("") || "<li class=\"muted\">none</li>";
    const news = (r.headlines || []).slice(0, 5).map((h) => { const a = h.ai || {}; const d = a.direction ? a.direction.choice : ""; return `<li><span class="${{ bullish: "up", bearish: "down" }[d] || "flat"}">${d === "bullish" ? "▲" : d === "bearish" ? "▼" : "•"}</span> ${h.url ? `<a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.headline)}</a>` : esc(h.headline)}</li>`; }).join("");
    const H = r.horizons && r.horizons.ai; const T_ = r.theme && r.theme.ai;
    return `<aside class="today">
      <section class="panel"><h3>Today, ${esc(r.session_date)}</h3><ul class="list">${cal}</ul></section>
      <section class="panel"><h3>Earnings today</h3><ul class="list">${earn}</ul></section>
      <section class="panel"><h3>News that matters</h3><ul class="list news">${news}</ul></section>
      <section class="panel"><h3>How to read a card</h3><ul class="list help">
        <li><b>Verdict</b> is the model's stance from every read combined: buy, buy the dip, wait for breakout, hold, avoid or short. It says why in one line.</li>
        <li><b>LONG / SHORT / NEUTRAL</b> is the 1–5 day lean and how sure the model is.</li>
        <li><b>Swing setup / Day trade</b> are 0–100 quality scores: weak, modest, good, strong.</li>
        <li><b>Who is buying</b> reads SEC insider filings, the latest 13F holder changes, congressional trades and short interest. YES means they are buying.</li>
        <li><b>The plan</b> is arithmetic on the chart: entry, stop, target, reward for each dollar risked.</li>
        <li><b>Checklist</b> counts ten things a careful trader checks before buying.</li>
      </ul></section>
      <section class="panel"><h3>Market reads</h3><dl class="kv">
        ${H ? `<dt>MACRO</dt><dd>${pretty(H.macro_read.choice)}</dd><dt>3M EQUITY LEAN</dt><dd>${H.equity_lean_3m.choice}</dd><dt>BIGGEST RISK</dt><dd class="down">${pretty(H.biggest_risk.choice)}</dd>` : ""}
        ${r.options && r.options.ai ? `<dt>OPTIONS</dt><dd>${pretty(r.options.ai.positioning.choice)}</dd>` : ""}
        ${T_ ? `<dt>DATA-CENTER THEME</dt><dd>${pretty(T_.stage.choice)}</dd><dt>NEXT LEG</dt><dd>${TH.group[T_.next_group.choice] || pretty(T_.next_group.choice)}</dd>` : ""}
      </dl></section>
    </aside>`;
  }

  // ---------------------------------------------------------------- sections
  function secRegime(r) {
    const g = r.regime;
    if (!g) return `<section class="card"><div class="muted">${r.ai_enabled ? "Regime call unavailable this build." : "AI judgments disabled for this build."}</div></section>`;
    const volL = ["Quiet", "Normal", "Elevated", "Extreme"];
    const toneCls = { risk_on: "up", risk_off: "down", mixed: "flat" }[g.tone.choice];
    const probs = Object.entries(g.tone.probabilities).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${pretty(k)} ${(v * 100).toFixed(0)}%`).join(" · ");
    const tile = (label, value, sub, why) => `<div class="tile"><div class="tile-label">${label}</div><div class="tile-value small">${value}</div>${explain(why)}<div class="tile-sub">${sub}</div></div>`;
    const vi = Math.round(g.volatility.score);
    return `<section><h2>How the market feels today <span class="muted">model read of the overnight tape, rates, flows and news</span></h2><div class="regime">
      <div class="tile hero"><div class="tile-label">Mood</div><div class="tile-value ${toneCls}">${pretty(g.tone.choice).toUpperCase()}</div>${explain(EX.tone[g.tone.choice])}<div class="tile-sub">${esc(probs)} ${conf(g.tone.confidence)}</div></div>
      <div class="tile"><div class="tile-label">Expected swings</div><div class="tile-value small">${volL[vi]}</div>${explain(EX.vol[vi])}<div class="tile-sub">${bar(g.volatility.score, 3)} ${g.volatility.score.toFixed(1)} / 3 ${conf(g.volatility.confidence)}</div></div>
      ${tile("What's driving it", pretty(g.driver.choice), `${(g.driver.confidence * 100).toFixed(0)}% confidence ${conf(g.driver.confidence)}`, EX.driver[g.driver.choice] || "")}
      ${tile("Who should lead", pretty(g.leadership.choice), `${(g.leadership.confidence * 100).toFixed(0)}% confidence ${conf(g.leadership.confidence)}`, EX.lead[g.leadership.choice] || "")}
      ${tile("Interest rates", `<span class="${{ tailwind: "up", headwind: "down", growth_scare: "warn" }[g.rates_read.choice] || "flat"}">${pretty(g.rates_read.choice)}</span>`, `${(g.rates_read.confidence * 100).toFixed(0)}% confidence ${conf(g.rates_read.confidence)}`, EX.rates[g.rates_read.choice] || "")}
      ${tile("Where money is going", pretty(g.flow_read.choice), `${(g.flow_read.confidence * 100).toFixed(0)}% confidence ${conf(g.flow_read.confidence)}`, EX.flow[g.flow_read.choice] || "")}
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
        <td><span class="pill ${dc}">${arrow({ bullish: 1, bearish: -1 }[d] || 0)} ${d}</span> ${conf(a.direction.confidence)}</td>
        <td class="hl">${link}<div class="meta2">${esc(h.source)} · ${timeET(h.published)} ET · <span class="tag">${pretty(a.scope.choice)}</span><span class="tag">${pretty(a.theme.choice)}</span> actionable ${(a.actionable.p * 100).toFixed(0)}%</div></td></tr>`;
    }).join("") || '<tr><td colspan="3" class="muted">No headlines in the lookback window.</td></tr>';
    return `<section><h2>News that actually matters <span class="muted">${r.headlines.length} kept · ${r.headlines_dropped} listicles and fluff dropped out of ${r.headlines_judged} judged</span></h2>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Impact</th><th>Lean</th><th>Headline</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  // ---------------------------------------------------------------- stocks
  function stockRows(r) {
    let list = r.stocks.slice();
    if (stockTab === "day") list = list.filter((s) => s.tags.includes("day"));
    if (stockTab === "swing") list = list.filter((s) => s.tags.includes("swing"));
    if (stockTab === "gappers") list = list.filter((s) => s.is_gapper);
    if (stockTab === "watchlist") list = list.filter((s) => s.on_watchlist);
    const keyf = { score: (s) => Math.max(s.scores.day, s.scores.swing), day: (s) => s.scores.day, swing: (s) => s.scores.swing, atr: (s) => s.technicals.atr_pct || 0, chg: (s) => Math.abs(s.chg_pct || 0), rvol: (s) => s.rel_volume || 0 }[sortKey];
    list.sort((a, b) => keyf(b) - keyf(a));
    return list;
  }

  function tagHtml(t) {
    const m = { gapper: ["acc", "gapper"], watchlist: ["acc", "watchlist"], day: ["ok", "day trade"], swing: ["ok", "swing"], event_risk: ["warn", "event risk"], extended: ["bad", "extended"], heavy_options: ["acc", "heavy options"] }[t] || ["", t];
    return `<span class="tag ${m[0]}">${m[1]}</span>`;
  }

  function secStocks(r) {
    const tabs = [["all", "All"], ["day", "Day trade"], ["swing", "Swing"], ["gappers", "Gapping"], ["watchlist", "Watchlist"]]
      .map(([k, l]) => `<button class="tab ${stockTab === k ? "active" : ""}" data-tab="${k}">${l}</button>`).join("");
    const th = (k, l) => `<th class="sortable ${sortKey === k ? "active" : ""}" data-sort="${k}">${l}${sortKey === k ? " ▾" : ""}</th>`;
    const rows = stockRows(r).map((s) => {
      const a = s.ai || {}, t = s.technicals, c = cls(s.chg_pct);
      const bias = a.bias ? `<span class="pill ${{ long: "up", short: "down" }[a.bias.choice] || "flat"}">${a.bias.choice}</span> ${conf(a.bias.confidence)}` : "–";
      return `<tr class="clickable ${selectedTicker === s.ticker ? "selected" : ""}" data-ticker="${esc(s.ticker)}">
        <td class="sym"><b>${esc(s.ticker)}</b><div class="meta2">${esc(s.name)}</div></td>
        <td class="num">${fnum(s.last_price)}<div class="delta ${c}">${arrow(s.chg_pct)} ${fpct(s.chg_pct)}</div></td>
        <td class="num">${fpct(t.atr_pct, 1, false)}<div class="meta2">#${s.volatility_rank} of ${s.volatility_universe}</div></td>
        <td class="num">${isNum(s.rel_volume) ? s.rel_volume.toFixed(2) + "×" : '<span class="muted">n/a</span>'}</td>
        <td>${a.stance ? `<span class="pill ${ST.cls[a.stance.choice]}">${ST.stance[a.stance.choice][0]}</span>` : bias}</td>
        <td>${a.setup ? `<span class="tag">${pretty(a.setup.choice)}</span> ${conf(a.setup.confidence)}` : "–"}</td>
        <td class="num">${bar(s.scores.day, 1)}<span class="mono">${(s.scores.day * 100).toFixed(0)}</span></td>
        <td class="num">${bar(s.scores.swing, 1)}<span class="mono">${(s.scores.swing * 100).toFixed(0)}</span></td>
        <td>${s.tags.map(tagHtml).join("")}</td></tr>`;
    }).join("") || `<tr><td colspan="9" class="muted">Nothing in this filter.</td></tr>`;
    const sel = r.stocks.find((s) => s.ticker === selectedTicker);
    return `<section><h2>Stocks worth watching <span class="muted">${r.stocks.length} most volatile and gapping names out of ${r.stocks_scanned} liquid stocks · ranked by ${term("day", "day-trade")} / ${term("swing", "swing")} score · click a row for the full breakdown</span></h2>
      <div class="tabs">${tabs}</div>
      <div class="tbl-wrap"><table class="tbl" id="stocks-tbl"><thead><tr><th>Stock</th>${th("chg", "Price / change")}${th("atr", `Daily range`)}${th("rvol", "Volume vs normal")}<th>Verdict</th><th>Setup</th>${th("day", "Day score")}${th("swing", "Swing score")}<th>Flags</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div id="stock-detail" class="detail">${sel ? stockDetail(sel, r) : '<div class="card muted">Select a stock to see its chart, levels, fundamentals, news and model judgments.</div>'}</div></section>`;
  }

  function probRows(obj, labels) {
    const entries = Object.entries(obj.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const top = obj.choice != null ? obj.choice : String(Math.round(obj.score));
    return `<div class="probs">${entries.map(([k, v]) => `<div class="row ${k === top ? "top" : ""}"><span>${esc(labels ? labels[k] || pretty(k) : pretty(k))}</span><span class="bar"><span class="bar-fill" style="width:${(v * 100).toFixed(0)}%"></span></span><span class="num">${(v * 100).toFixed(0)}%</span></div>`).join("")}</div>`;
  }

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
        <div class="tile"><div class="tile-label">Watch out for</div><div class="tile-sub" style="margin-top:2px"><span class="tag ${a.event_risk.p >= 0.6 ? "warn" : ""}">event risk ${(a.event_risk.p * 100).toFixed(0)}%</span><span class="tag ${a.extended.p >= 0.6 ? "bad" : ""}">extended ${(a.extended.p * 100).toFixed(0)}%</span></div>
          ${explain(`${a.event_risk.p >= 0.6 ? "Something scheduled (earnings, a decision) could gap this stock against you within a week." : "No scheduled event inside the next week."} ${a.extended.p >= 0.6 ? "It has run far from its averages, so chasing here is risky." : "It is close to its averages, so entries are not chasing."}`)}</div>
      </div>` : '<div class="card muted">Model judgments disabled for this build.</div>';
    const news = s.headlines.length ? s.headlines.slice(0, 6).map((h) => `<li>${h.url ? `<a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.headline)}</a>` : esc(h.headline)} <span class="muted">· ${esc(h.source)} ${timeET(h.published)}</span></li>`).join("") : '<li class="muted">No recent headlines.</li>';
    const pv = t.pivots || {};
    return `<div class="card">
      <div class="detail-head"><b style="font-size:18px">${esc(s.ticker)}</b><span class="muted">${esc(s.name)} · ${esc(s.sector)}${s.industry ? " · " + esc(s.industry) : ""}</span><span class="px">${fnum(s.last_price)}</span><span class="delta ${c}">${arrow(s.chg_pct)} ${fpct(s.chg_pct)}</span><span class="muted">prev close ${fnum(s.prev_close)}</span>${s.tags.map(tagHtml).join("")}</div>
      <div class="detail-grid">
        <div class="col">
          <div><div class="chart tall" data-chart="${esc(s.ticker)}"></div><div class="legend"><span><i class="k1"></i>SMA 20</span><span><i class="k2"></i>SMA 50</span><span>dashed: prior high / low, pivot, 20-day high / low, swing levels</span></div></div>
          ${paTile(s)}
          <div class="tile"><div class="tile-label">Before you take the position</div>${explain("Ten checks a disciplined trader runs before pressing the button. Each line says why it passed or failed.")}${checklistHtml(checklist(s, r), true)}</div>
          ${judg}
        </div>
        <div class="col">
          ${a && a.stance ? `<div class="tile"><div class="tile-label">Verdict</div><div class="verdict ${ST.cls[a.stance.choice]}"><div class="verdict-word">${ST.stance[a.stance.choice][0]}</div><div class="verdict-why">${ST.stance[a.stance.choice][1]} ${a.main_reason ? "Mainly " + ST.reason[a.main_reason.choice] + "." : ""}</div></div>${probRows(a.stance, Object.fromEntries(Object.entries(ST.stance).map(([k, v]) => [k, v[0].toLowerCase()])))}</div>` : ""}
          <div class="tile"><div class="tile-label">Who is buying</div>${whoHtml(s) || '<div class="muted">no smart-money data for this name</div>'}</div>
          <div class="tile"><div class="tile-label">How much it moves</div><dl class="kv"><dt>${term("atr", "ATR 14")}</dt><dd>${fnum(t.atr14)} (${fpct(t.atr_pct, 2, false)})</dd><dt>Realized vol 20d</dt><dd>${fpct(t.rv20, 0, false)}</dd><dt>Prev day range</dt><dd>${fpct(t.prev_range_pct, 1, false)}</dd><dt>${term("beta", "Beta")}</dt><dd>${fnum(f.beta, 2)}</dd><dt>${term("relvol", "Volume vs normal")}</dt><dd>${isNum(s.rel_volume) ? s.rel_volume.toFixed(2) + "×" : "n/a"}</dd><dt>Avg $ volume</dt><dd>${fcap(s.avg_dollar_volume)}</dd><dt>Volatility rank</dt><dd>#${s.volatility_rank} / ${s.volatility_universe}</dd></dl></div>
          <div class="tile"><div class="tile-label">Trend and key levels</div><dl class="kv"><dt>Trend</dt><dd class="${{ up: "up", down: "down" }[t.trend] || "flat"}">${t.trend}</dd><dt>${term("sma", "SMA 20 / 50 / 200")}</dt><dd>${b(t.above_sma20)} / ${b(t.above_sma50)} / ${b(t.above_sma200)}</dd><dt>Distance from SMA 20</dt><dd class="${cls(t.dist_sma20_pct)}">${fpct(t.dist_sma20_pct, 1)}</dd><dt>${term("rsi", "RSI 14")}</dt><dd>${fnum(t.rsi14, 1)}</dd><dt>5d / 1m / 3m return</dt><dd><span class="${cls(t.ret_5d)}">${fpct(t.ret_5d, 1)}</span> / <span class="${cls(t.ret_1m)}">${fpct(t.ret_1m, 1)}</span> / <span class="${cls(t.ret_3m)}">${fpct(t.ret_3m, 1)}</span></dd><dt>From 52w high / low</dt><dd>${fpct(t.pct_from_hi52, 1)} / ${fpct(t.pct_from_lo52, 1)}</dd><dt>Prev H / L</dt><dd>${fnum(t.prev_high)} / ${fnum(t.prev_low)}</dd><dt>${term("pivot", "Pivot R1 / P / S1")}</dt><dd>${fnum(pv.r1)} / ${fnum(pv.p)} / ${fnum(pv.s1)}</dd><dt>20d high / low</dt><dd>${fnum(t.hi20)} / ${fnum(t.lo20)}</dd></dl></div>
          <div class="tile"><div class="tile-label">The business</div><dl class="kv"><dt>Market cap</dt><dd>${fcap(f.market_cap)}</dd><dt>P/E trailing / fwd</dt><dd>${fnum(f.trailing_pe, 1)} / ${fnum(f.forward_pe, 1)}</dd><dt>P/S</dt><dd>${fnum(f.ps, 1)}</dd><dt>Revenue growth</dt><dd class="${cls(f.rev_growth)}">${isNum(f.rev_growth) ? fpct(f.rev_growth * 100, 1) : "–"}</dd><dt>EPS growth</dt><dd class="${cls(f.eps_growth)}">${isNum(f.eps_growth) ? fpct(f.eps_growth * 100, 1) : "–"}</dd><dt>Profit margin</dt><dd>${isNum(f.margins) ? fpct(f.margins * 100, 1, false) : "–"}</dd><dt>${term("shortfloat", "Short % float")}</dt><dd class="${isNum(f.short_float) && f.short_float > 0.15 ? "warn" : ""}">${isNum(f.short_float) ? fpct(f.short_float * 100, 1, false) : "–"}</dd><dt>Analysts / target</dt><dd>${pretty(f.analyst) || "–"} / ${fnum(f.target)}</dd><dt>Next earnings</dt><dd class="${isNum(f.days_to_earnings) && f.days_to_earnings >= 0 && f.days_to_earnings <= 7 ? "warn" : ""}">${f.next_earnings || "–"}${isNum(f.days_to_earnings) ? ` (${f.days_to_earnings}d)` : ""}</dd></dl></div>
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
  function renderAll() {
    const r = report;
    destroyCharts();
    $("#session-line").textContent = r.session_date + " · " + r.session_label.split(",")[0].toUpperCase();
    const ms = $("#market-state"); ms.textContent = { pre: "pre-market", open: "market open", post: "after hours", closed: "closed" }[r.market_state] || r.market_state; ms.className = "badge " + r.market_state;
    $("#generated-line").textContent = `UPD ${r.generated_at.slice(11, 16)} ET · ${r.elapsed_s}S`;
    const app = $("#app");
    const wa = $("#wa-btn"); if (wa) { wa.href = "https://wa.me/?text=" + encodeURIComponent(whatsappMessage(r)); }
    $("#nav").innerHTML = VIEWS.map(([k, l, n]) => `<button class="nav-btn ${currentView === k ? "active" : ""}" data-view="${k}"><kbd>${n}</kbd> ${l}</button>`).join("");
    app.innerHTML = viewHtml(r);
    firstRender = false;
    const st = r.ai_stats;
    $("#footer").innerHTML = `<div class="foot">${r.ai_enabled ? `TypeSafe (model jev): ${st.calls} judgment calls, ${st.failures} failed, ${st.input_tokens.toLocaleString()} input / ${st.output_tokens.toLocaleString()} output tokens.` : "AI judgments disabled for this build."} Watchlist: ${esc((r.watchlist || []).join(", ") || "none")}.</div>
      <div>Data: Yahoo Finance (quotes, history, extended-hours bars, news, fundamentals), FRED (Treasury curve), ForexFactory (economic calendar), Nasdaq (earnings calendar). Change is the last print, including extended hours, versus the prior regular-session close. Bias, setup, fit scores, catalyst, relevance and regime are model outputs from typed questions in <code>market_update/judgments.py</code>: calibrated probabilities, not recommendations. Nothing here is investment advice.</div>`;
    mountCharts();
    wireStocks();
  }

  function viewHtml(r) {
    switch (currentView) {
      case "home": return `<div class="view home"><div class="col-main"><div class="home-top">${moodPanel(r)}${verdictPanel(r)}</div>${secBoard(r)}</div>${secToday(r)}</div>`;
      case "stock": return `<div class="view stock">${secStocks(r)}</div>`;
      case "theme": return `<div class="view one">${secTheme(r)}</div>`;
      case "smart": return `<div class="view one">${secSmart(r)}</div>`;
      case "macro": return `<div class="view one">${secRegime(r)}${secHorizons(r)}</div>`;
      case "market": return `<div class="view one">${secMacro(r)}${secIndices(r)}${secRates(r)}</div>`;
      case "flows": return `<div class="view one">${secFlows(r)}</div>`;
      case "news": return `<div class="view news"><div>${secHeadlines(r)}</div><div>${secCalendar(r)}${secEarnings(r)}</div></div>`;
      case "options": return `<div class="view one">${secOptions(r)}</div>`;
      default: currentView = "home"; return viewHtml(r);
    }
  }
  function switchView(k) {
    if (!VIEWS.some((v) => v[0] === k)) return;
    currentView = k; try { history.replaceState(null, "", "#view=" + k); } catch (e) {}
    if (report) renderAll();
  }

  function mountCharts() {
    const r = report;
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
    document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async (e) => { e.preventDefault(); const src = b.closest(".share").querySelector(".share-src"); try { await navigator.clipboard.writeText(src.value); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy text"), 1500); } catch (err) { src.hidden = false; src.select(); } }));
    document.querySelectorAll(".nav-btn").forEach((b) => b.addEventListener("click", () => switchView(b.getAttribute("data-view"))));
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
    report = pendingReport; pendingReport = null;
    renderAll(); notice("", false);
    window.scrollTo(0, y);
  }

  async function fetchReport() {
    const res = await fetch("/api/report", { cache: "no-store" });
    if (!res.ok) throw new Error("report " + res.status);
    return res.json();
  }

  async function poll() {
    try {
      const st = await (await fetch("/api/status", { cache: "no-store" })).json();
      const btn = $("#refresh-btn");
      if (st.building) { btn.disabled = true; btn.textContent = "Building…"; }
      else if (st.refresh_available_in_s > 0) { btn.disabled = true; btn.textContent = `Refresh (${st.refresh_available_in_s}s)`; }
      else { btn.disabled = false; btn.textContent = "Refresh"; }
      if (st.last_error) notice("Last build failed: " + st.last_error);
      if (st.build_id && report && st.build_id !== report.build_id && (!pendingReport || pendingReport.build_id !== st.build_id)) {
        pendingReport = await fetchReport();
      }
      if (pendingReport) {
        const idle = Date.now() - lastInteraction > 45000;
        if (idle || document.hidden || window.scrollY < 80) { applyPending(); }
        else { notice(`New data from ${pendingReport.generated_at.slice(11, 16)} ET is ready. `, true, "Update now", applyPending); }
      }
      if (!report && st.build_id) { report = await fetchReport(); renderAll(); }
    } catch (e) { /* server may be restarting */ }
  }

  async function onRefresh() {
    if (STATIC_MODE) return;
    const btn = $("#refresh-btn"); btn.disabled = true; btn.textContent = "Building…";
    try {
      const res = await fetch("/api/refresh", { method: "POST" });
      const j = await res.json();
      if (res.status === 429) notice(`Refresh is rate-limited; try again in ${j.retry_in_s}s.`);
      else notice("Rebuilding: fresh quotes, news and model judgments. This takes about a minute.");
    } catch (e) { notice("Refresh failed: " + e.message); }
  }

  function initTheme() {
    let saved = null; try { saved = localStorage.getItem("mu-theme"); } catch (e) {}
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    $("#theme-btn").addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      const next = cur === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("mu-theme", next); } catch (e) {}
      if (report) renderAll();
    });
  }

  async function init() {
    initTheme();
    addEventListener("keydown", (e) => { if (e.target && /input|textarea/i.test(e.target.tagName)) return; const v = VIEWS.find((x) => x[2] === e.key); if (v) switchView(v[0]); });
    $("#refresh-btn").addEventListener("click", onRefresh);
    if (STATIC_MODE) {
      report = JSON.parse(EMBEDDED.textContent);
      const rb = $("#refresh-btn"); rb.hidden = false; rb.textContent = "REFRESH";
      rb.onclick = async () => { rb.disabled = true; rb.textContent = "CHECKING…"; try { const res = await fetch("./report.json", { cache: "no-store" }); if (res.ok) { const fresh = await res.json(); if (fresh.build_id !== report.build_id) { pendingReport = fresh; applyPending(); notice(`Updated to the ${fresh.generated_at.slice(11, 16)} ET build.`); } else notice("You already have the latest build. Forced rebuilds run from the project's Actions page.", true); } } catch (e) { notice("Static snapshot: nothing newer is reachable from here.", true); } rb.disabled = false; rb.textContent = "REFRESH"; };
      renderAll();
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
    try { report = await fetchReport(); renderAll(); }
    catch (e) { $("#app").innerHTML = '<div class="loading">First build in progress… this page will fill in automatically.</div>'; }
    setInterval(poll, 15000);
    poll();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
