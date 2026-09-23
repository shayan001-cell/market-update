"""Every TypeSafe question and every threshold used by Market Update.

This is the file to review. Code elsewhere fetches data and renders HTML;
the *meaning* of the AI layer is defined entirely here.

Primitives (see https://docs.typesafe.ai/primitives):
  Choice -> one option from a set (+ probabilities, confidence)
  Noul   -> probability that a condition holds (0..1)
  Score  -> probability-weighted position on an ordered rubric (0..len-1)
"""
from __future__ import annotations

from typesafe_sdk import Choice, Noul, Score

# ---------------------------------------------------------------------------
# Shared option sets
# ---------------------------------------------------------------------------
THEMES = {
    "fed_rates": "Federal Reserve, interest rates, Treasury yields, bond market",
    "macro_data": "Economic data: inflation, jobs, GDP, PMI, consumer, housing",
    "earnings": "Company earnings, guidance, or pre-announcements",
    "ai_tech": "AI, semiconductors, big tech products, cloud and capex",
    "geopolitics": "Wars, sanctions, tariffs, trade policy, elections",
    "energy_commodities": "Oil, gas, metals, agriculture and their producers",
    "crypto": "Bitcoin, ether, stablecoins, crypto exchanges and miners",
    "deals": "M&A, IPOs, buybacks, offerings, activist stakes",
    "regulatory_legal": "Antitrust, FDA, lawsuits, government policy on an industry",
    "other": "None of the above",
}

GROUPS = {
    "mega_cap_tech": "Apple, Microsoft, Nvidia, Amazon, Alphabet, Meta, Tesla and the Nasdaq 100",
    "semis": "Semiconductor makers and equipment",
    "small_caps_cyclicals": "Russell 2000, industrials, transports, regional banks",
    "financials": "Large banks, brokers, payments, insurers",
    "energy_materials": "Oil and gas, miners, metals, chemicals",
    "healthcare_biotech": "Pharma, biotech, devices, insurers",
    "consumer": "Retail, restaurants, travel, autos",
    "defensives": "Utilities, staples, real estate, gold",
    "crypto_linked": "Bitcoin miners, exchanges, treasury-holding companies",
    "none": "Idiosyncratic; no meaningful read-through to a group",
}

CATALYSTS = {
    "earnings": "Quarterly results or guidance just reported",
    "preannouncement_guidance": "Guidance change or pre-announcement outside a scheduled report",
    "analyst_action": "Upgrade, downgrade, initiation, or price-target change",
    "deal": "M&A, takeover interest, strategic investment, major contract or partnership",
    "regulatory_legal": "FDA decision, trial data, antitrust, lawsuit, or government action",
    "offering_dilution": "Secondary offering, convertible, insider share sale, or lockup expiry",
    "sympathy_macro": "Moving with a peer's news, sector rotation, index rebalance, or macro data rather than its own news",
    "technical_only": "No news; the move is technical (level break, squeeze, momentum) or the stock is simply volatile",
}

# ---------------------------------------------------------------------------
# 1. Headlines. State per item: {headline, summary, source, published, related_tickers}
# ---------------------------------------------------------------------------
HEADLINE_QUESTIONS = {
    "actionable": Noul(
        instructions=(
            "Is this news item something a US equity trader should know before the next "
            "market open? Judge `headline` and `summary` from `source`, published at `published`."
        ),
        criteria={
            "true": (
                "New, time-sensitive information: a macro data release or central bank action, "
                "a notable overnight market move, or a specific company catalyst (earnings, "
                "guidance, deal, regulatory decision, analyst action, major product or legal news)."
            ),
            "false": (
                "Evergreen or educational content, personal-finance or retirement advice, listicles "
                "such as '3 stocks to buy', retrospective explainers, opinion pieces with no new "
                "facts, or promotional content."
            ),
        },
    ),
    "direction": Choice(
        instructions="For the assets this item is about, which way does the information point for the next US session?",
        criteria={
            "bullish": "Supports higher prices for the affected asset(s)",
            "bearish": "Pressures prices of the affected asset(s) lower",
            "mixed": "Contains both positive and negative implications, or the reaction is genuinely ambiguous",
            "none": "No directional implication: not market news, or purely descriptive",
        },
    ),
    "scope": Choice(
        instructions="How broad is the market impact of this item?",
        criteria={
            "market_wide": "Affects the whole US equity market: Fed, macro data, geopolitics, broad risk sentiment, index-level moves",
            "sector": "Affects a whole sector or theme, such as semis, banks, energy, biotech, or crypto-linked stocks",
            "single_stock": "Affects one company, or one company plus close peers in sympathy",
            "not_market": "Not about tradable markets",
        },
    ),
    "impact": Score(
        instructions="How much could this item move prices in the next US session?",
        criteria=[
            "Background noise; prices already reflect it or it is not price-relevant",
            "Worth knowing; might nudge a stock or sector but unlikely to drive the tape",
            "Likely to move a stock or sector several percent or set the tone for a group",
            "Likely to move the whole market at the open or define the day's narrative",
        ],
    ),
    "theme": Choice(instructions="Which theme does this item belong to?", criteria=THEMES),
}

# ---------------------------------------------------------------------------
# 2. Stock cards. State per stock:
#    {ticker, name, sector, industry, price:{last, prev_close, chg_pct, gap_pct},
#     volatility:{atr_pct, realized_vol_20d, beta, rel_volume, prev_range_pct},
#     trend:{trend, above_sma20/50/200, dist_sma20_pct, rsi14, pct_from_52w_high,
#            pct_from_52w_low, ret_5d, ret_1m, new_high_20d, new_low_20d},
#     levels:{prev_high, prev_low, hi_20d, lo_20d},
#     fundamentals:{market_cap, forward_pe, rev_growth, short_float, analyst, days_to_earnings},
#     price_action:{pattern, pattern_read, direction, close_location, body_pct, range_vs_atr, volume_vs_avg,
#                   streak_days, gap_open_pct, structure, swing_highs, swing_lows, nearest_support,
#                   nearest_resistance, broke_last_swing_high, broke_last_swing_low},
#     market_state, headlines:[{headline, summary, published, source}]}
# ---------------------------------------------------------------------------
STOCK_QUESTIONS = {
    "bias": Choice(
        instructions=(
            "Weighing `trend`, `price`, `volatility`, `levels`, `fundamentals` and `headlines` "
            "for `ticker`, which directional bias is best supported for the next one to five sessions?"
        ),
        criteria={
            "long": "Uptrend or fresh positive catalyst with momentum; dips likely bought",
            "short": "Downtrend or fresh negative catalyst; rallies likely sold",
            "neutral": "Conflicting signals, range-bound, or no edge either way",
        },
    ),
    "setup": Choice(
        instructions=(
            "Which technical setup best describes `ticker` right now, given `trend`, `levels`, "
            "`price` and `headlines`?"
        ),
        criteria={
            "breakout": "At or through 20-day or 52-week highs with expanding range or volume",
            "pullback_in_uptrend": "Above rising averages, pulling back toward the 20-day area after a leg up",
            "breakdown": "At or through 20-day or 52-week lows with expanding range",
            "bounce_in_downtrend": "Below falling averages, bouncing on short covering or oversold conditions",
            "extended_reversal_risk": "Far from its averages after a large run; momentum stalling",
            "range": "Oscillating between defined levels with no trend",
            "news_gap": "Gapping on fresh news; prior structure matters less than the catalyst",
            "no_clear_setup": "Nothing actionable",
        },
    ),
    "day_trade_fit": Score(
        instructions=(
            "How suitable is `ticker` for an intraday trade in the coming session, judging from "
            "`volatility`, `price`, `levels`, `market_state` and `headlines`?"
        ),
        criteria=[
            "Too quiet or too thin: small daily range, ordinary volume, no catalyst",
            "Tradeable but ordinary: normal range, no special reason to focus on it today",
            "In play: elevated range or volume, a catalyst or a clear level to trade against",
            "Prime: large expected range, heavy volume, fresh catalyst and clean levels",
        ],
    ),
    "swing_fit": Score(
        instructions=(
            "How suitable is `ticker` for a multi-day swing position (two to ten sessions), judging "
            "from `trend`, `levels`, `fundamentals` (including `days_to_earnings`) and `headlines`?"
        ),
        criteria=[
            "No edge: trendless, or a binary event makes holding overnight a coin flip",
            "Marginal: some trend or catalyst but poorly defined risk",
            "Reasonable: aligned trend with a defined level for entry and invalidation",
            "High quality: strong trend, clear entry and stop, room to a logical target, no imminent event",
        ],
    ),
    "catalyst": Choice(
        instructions="What best explains `ticker`'s recent activity, based on `headlines` and `price`?",
        criteria=CATALYSTS,
    ),
    "event_risk": Noul(
        instructions=(
            "Is there a scheduled binary event for `ticker` within the next five sessions "
            "(earnings per `days_to_earnings`, FDA or court decision, index rebalance, lockup) "
            "that could gap the stock against a position?"
        ),
        criteria={"true": "A dated event inside five sessions, or one implied by the headlines",
                  "false": "No such event within five sessions"},
    ),
    "extended": Noul(
        instructions=(
            "Is `ticker` overextended from its moving averages (see `trend.dist_sma20_pct`, "
            "`trend.rsi14`, `trend.ret_5d`) such that chasing in the direction of the move here has poor risk/reward?"
        ),
        criteria={"true": "Stretched: several ATRs from the 20-day average, RSI at an extreme, or a parabolic run",
                  "false": "Near its averages or consolidating; entries are not chasing"},
    ),
    "price_action": Choice(
        instructions=(
            "Reading `price_action` for `ticker` (the last candle's pattern, where it closed in its range, "
            "its size versus ATR, its volume versus average, the streak of up or down closes, the swing "
            "structure and whether the last swing high or low was broken), who is in control right now?"
        ),
        criteria={
            "buyers_in_control": "Up candles closing near their highs, higher highs and higher lows, breaks of swing highs on volume",
            "sellers_in_control": "Down candles closing near their lows, lower highs and lower lows, breaks of swing lows on volume",
            "buyers_exhausting": "Still rising but with shrinking bodies, long upper wicks, a shooting star or doji after a run, or weak volume on new highs",
            "sellers_exhausting": "Still falling but with hammers, long lower wicks, a doji after a drop, or weak volume on new lows",
            "indecision": "Small bodies, inside bars, overlapping ranges; neither side has pressed an advantage",
        },
    ),
    "entry_quality": Score(
        instructions=(
            "How clean is an entry in `ticker` right now, in the direction the technicals favour, judging from "
            "`price_action` (structure, last candle, nearest support and resistance), `levels`, `trend` and `volatility`?"
        ),
        criteria=[
            "No entry: price is mid-range with no level close by, or the last candle contradicts the trend",
            "Early: the idea is forming but needs a confirming close or a retest of the level",
            "Reasonable: price is at a level with a supportive candle, and the stop is a normal distance away",
            "Textbook: structure, level, candle and volume all agree, with a tight, obvious stop",
        ],
    ),
}

# ---------------------------------------------------------------------------
# 3. Session regime. State:
#    {session_date, market_state, macro_tape:[...], indices:[...], rates:{...},
#     flows:{gauges:[...], breadth:{...}, sectors:[...]}, top_headlines:[...], calendar_today:[...]}
# ---------------------------------------------------------------------------
REGIME_QUESTIONS = {
    "tone": Choice(
        instructions=(
            "Considering `macro_tape` (overnight changes in index futures, VIX, the 10-year yield, "
            "the dollar, oil, gold and bitcoin), `indices`, `top_headlines` and `calendar_today`, "
            "what is the risk tone heading into the US session on `session_date`?"
        ),
        criteria={
            "risk_on": "Index futures up, VIX down or flat, and news supportive; buyers in control",
            "risk_off": "Futures down, VIX or yields spiking, or negative news; sellers in control",
            "mixed": "Signals conflict or overnight moves are small; no clear tone",
        },
    ),
    "volatility": Score(
        instructions="How volatile is the coming US session likely to be, judging from `macro_tape`, `indices`, `top_headlines` and `calendar_today`?",
        criteria=[
            "Quiet: small overnight moves, VIX low, no major scheduled events",
            "Normal: typical two-way trade; some data or earnings but nothing extraordinary",
            "Elevated: a major data release, Fed event, or a large overnight move likely to produce wide ranges",
            "Extreme: crisis-type headlines or index futures gapping several percent",
        ],
    ),
    "driver": Choice(
        instructions="What is the dominant driver of the session's narrative, judging from `macro_tape`, `rates`, `top_headlines` and `calendar_today`?",
        criteria={**{k: v for k, v in THEMES.items() if k != "other"},
                  "no_dominant_driver": "Nothing stands out; a technical, flow-driven session"},
    ),
    "leadership": Choice(
        instructions="Which group is most likely to lead the session, judging from `flows` (sector returns and ratio gauges), `macro_tape` and `top_headlines`?",
        criteria={**{k: v for k, v in GROUPS.items() if k != "none"}, "unclear": "No group stands out"},
    ),
    "rates_read": Choice(
        instructions=(
            "Reading `rates` (the Treasury curve today versus a month ago, the 2s10s and 3m10y spreads, "
            "and one-month changes in 2-year and 10-year yields), what are rates doing to equities?"
        ),
        criteria={
            "tailwind": "Yields falling or the curve steepening benignly; supportive for stocks, especially long-duration growth",
            "headwind": "Yields rising, especially the long end, or a bear flattening; pressure on valuations",
            "neutral": "Little change or offsetting moves",
            "growth_scare": "Yields falling fast with the curve bull-steepening on weak data; supportive for bonds and defensives, not cyclicals",
        },
    ),
    "flow_read": Choice(
        instructions=(
            "Reading `flows.gauges` (each with what a rising ratio means and its 1-day, 5-day and "
            "1-month changes), `flows.breadth` and `flows.sectors`, where is money flowing?"
        ),
        criteria={
            "into_growth_tech": "Semis and mega-cap tech leading; equal-weight and small caps lagging",
            "into_cyclicals_small_caps": "Small caps, equal weight, copper and discretionary leading",
            "into_defensives": "Staples, utilities, gold and Treasuries leading while credit and small caps lag",
            "into_bonds_cash": "Broad de-risking: bonds up, equities and credit down, VIX term structure stressed",
            "broad_risk_on": "Most equity groups and credit rising together with breadth expanding",
            "broad_risk_off": "Most equity groups falling together with breadth contracting",
            "mixed": "No consistent direction across gauges",
        },
    ),
}

# ---------------------------------------------------------------------------
# 3b. Big picture, per asset. State:
#    {asset, kind, last, sma50, sma200, above_sma50, above_sma200, rsi14,
#     horizons:{"1m":{return_pct|change_bp, range_pos, max_drawdown_pct, structure,...}, "3m":..., "6m":..., "12m":...}}
# ---------------------------------------------------------------------------
HORIZON_ASSET_QUESTIONS = {
    "regime": Choice(
        instructions=(
            "Reading `horizons` for `asset` (1, 3, 6 and 12-month return or change, where price sits in each "
            "window's range, drawdown from the window high, and the swing structure), plus `above_sma50`, "
            "`above_sma200` and `rsi14`, what phase is this market in?"
        ),
        criteria={
            "strong_uptrend": "Rising across most horizons, near the top of its 6 and 12-month ranges, above both averages",
            "uptrend_pulling_back": "Up over 6 and 12 months but the 1-month is negative or stalling; a dip inside a rising trend",
            "range": "Flat over 3 to 6 months, oscillating inside a band, averages flattening",
            "topping": "12-month gains fading, lower highs on the 1 to 3-month windows, momentum rolling over near the highs",
            "downtrend": "Falling across most horizons, near the bottom of its ranges, below both averages",
            "bottoming": "Down over 6 and 12 months but the 1 to 3-month windows are turning up from the lows",
        },
    ),
    "alignment": Choice(
        instructions="Do the short horizons (1 and 3 months) agree with the long horizons (6 and 12 months) for `asset`?",
        criteria={
            "all_up": "Every horizon points up",
            "all_down": "Every horizon points down",
            "short_up_long_down": "Recent strength inside a longer decline: a counter-trend bounce or an early turn",
            "short_down_long_up": "Recent weakness inside a longer rise: a pullback or an early top",
            "mixed": "No consistent direction",
        },
    ),
    "strength": Score(
        instructions="How strong is the dominant trend in `asset` across `horizons`?",
        criteria=[
            "No trend: returns near zero and price mid-range on most horizons",
            "Mild: a lean in one direction with meaningful pullbacks",
            "Strong: consistent direction, shallow pullbacks, price near the extreme of its ranges",
            "Extreme: parabolic or capitulating, far beyond its averages, a move that rarely persists",
        ],
    ),
}

# ---------------------------------------------------------------------------
# 3c. Big picture, cross-asset. State: {assets:[per-asset summaries incl. 3m and 12m moves], rates:{...}}
# ---------------------------------------------------------------------------
HORIZON_CROSS_QUESTIONS = {
    "macro_read": Choice(
        instructions=(
            "Reading `assets` together (S&P futures, Nasdaq 100, gold, oil and the 10-year yield over 1, 3, 6 and "
            "12 months), which macro picture best fits the last three to six months?"
        ),
        criteria={
            "growth_boom": "Equities strong, oil firm, yields rising with growth; gold lagging",
            "disinflation_rally": "Equities strong while yields and oil fall; the market pricing easier money",
            "inflation_scare": "Yields and oil rising while equities stall or fall; gold holding or rising",
            "growth_scare": "Yields falling with equities and oil; gold bid as a haven",
            "liquidity_melt_up": "Equities and gold both rising strongly while yields drift; everything except cash is up",
            "risk_off": "Equities down over most horizons, gold up, yields down",
            "mixed": "No coherent macro story across the five",
        },
    ),
    "equity_lean_3m": Choice(
        instructions=(
            "Given `assets` and `rates`, what is the more likely path for US equities over the next three months? "
            "This is a lean from the cross-asset picture, not a forecast."
        ),
        criteria={
            "higher": "Trend, breadth of the rally across assets and easing yields favour continued gains",
            "sideways": "Extended equities against rising yields or oil favour consolidation",
            "lower": "Deteriorating equity trend with a rates or oil headwind favours a correction",
        },
    ),
    "biggest_risk": Choice(
        instructions="Which of these is the biggest risk to the equity trend, judging from `assets` and `rates`?",
        criteria={
            "rates": "Yields rising or curve dynamics tightening financial conditions",
            "oil": "An energy price shock",
            "extension": "Equities stretched far above their averages after a long run",
            "growth": "Falling yields and oil signalling weakening growth",
            "none_obvious": "No single risk stands out",
        },
    ),
}

# ---------------------------------------------------------------------------
# 3d. Theme screen, per stock. State:
#    {ticker, name, group, theme, price:{last, chg_pct}, technicals:{trend, structure, atr_pct, rsi14, dist_sma20_pct,
#     ret_1m, ret_3m, rel_vs_spy_1m, rel_vs_spy_3m, pct_from_52w_high, new_high_20d},
#     fundamentals:{market_cap, beta, forward_pe, rev_growth, eps_growth, short_float, days_to_earnings}, market_tone}
# ---------------------------------------------------------------------------
THEME_STOCK_QUESTIONS = {
    "theme_leverage": Score(
        instructions="How directly is `ticker` (`name`, role `group`) exposed to the `theme`? Judge from what the company sells and to whom.",
        criteria=[
            "Peripheral: the theme is a small or indirect part of the business",
            "Meaningful: a real but minority revenue driver",
            "Core: the theme is the main growth engine and the market trades the stock on it",
            "Pure play: revenue and valuation depend almost entirely on the buildout",
        ],
    ),
    "phase": Choice(
        instructions="Where is `ticker` in the theme's move, judging from `technicals` (trend, structure, relative strength versus SPY, distance from the 52-week high) and `price`?",
        criteria={
            "leader": "Outperforming the market and the group, in an uptrend near its highs",
            "catching_up": "Lagged the leaders but now turning up with improving relative strength",
            "laggard": "Still underperforming with no turn yet; may be the next to move or may be broken",
            "extended": "Far above its averages after a vertical run; more likely to rest than to accelerate",
            "broken": "Downtrend with lower highs; the theme is not lifting it",
        },
    ),
    "move_potential": Score(
        instructions=(
            "If the market stays risk-on and the theme keeps working, how large a move could `ticker` make over the next one to three months, "
            "relative to a typical large-cap? Weigh `fundamentals.beta`, `technicals.atr_pct`, `fundamentals.short_float`, the room to the 52-week high, "
            "and whether the structure supports continuation."
        ),
        criteria=[
            "Market-like: moves roughly with the index",
            "Amplified: one and a half to two times the market's swings",
            "Explosive: multiples of the market, with squeeze or re-rating potential",
            "Parabolic candidate: thin float, high short interest or a fresh breakout that could go vertical, with matching downside",
        ],
    ),
    "fundamental_support": Score(
        instructions="Do `fundamentals` (revenue growth, earnings growth, forward P/E, market cap) support the stock's move, or is it running on story alone?",
        criteria=[
            "Story only: little growth or unprofitable with a rich valuation",
            "Mixed: growth is real but the valuation already prices most of it",
            "Supported: strong growth at a valuation the growth can justify",
            "Underpriced: growth accelerating faster than the multiple implies",
        ],
    ),
}

# ---------------------------------------------------------------------------
# 3e. Theme, whole-group read. State: {theme, market_tone, groups:[{group, avg_ret_1m, avg_ret_3m, avg_rel_vs_spy_1m, share_in_uptrend, share_extended}]}
# ---------------------------------------------------------------------------
THEME_GROUP_QUESTIONS = {
    "stage": Choice(
        instructions="Reading `groups` for `theme` (average returns, relative strength, share of names in uptrends and share extended), what stage is the theme in?",
        criteria={
            "early": "Leaders just breaking out; most groups still flat; participation narrow",
            "mid": "Leaders extended, second-tier groups now turning up; participation broadening",
            "late": "Nearly every group up and extended; laggards running; risk of exhaustion",
            "exhausted": "Leaders rolling over while laggards spike; relative strength fading",
            "broken": "Most groups in downtrends",
        },
    ),
    "next_group": Choice(
        instructions="Which role in the stack is most likely to lead the next leg, judging from `groups` (lagging relative strength that is turning, versus leaders that are extended)?",
        criteria={
            "compute": "GPUs, CPUs, accelerators, interconnect chips",
            "memory_storage": "DRAM, HBM, NAND, storage systems",
            "networking_optics": "Switches, optical transceivers, lasers",
            "servers_cooling": "Server integrators, liquid cooling, thermal",
            "power": "Utilities, turbines, electrical equipment, nuclear",
            "semicap": "Chip-making equipment",
            "real_estate": "Data-center REITs",
            "platforms": "Hyperscalers and neoclouds",
        },
    ),
}

# ---------------------------------------------------------------------------
# 3f. Smart money, per stock. State:
#    {ticker, name, price_1m_pct, insider:{buy_trans_6m, sell_trans_6m, net_shares_6m, open_market_buys_90d:[...], buy_value_90d, sell_value_90d, distinct_buyers_90d},
#     institutions:{pct_held, top10_avg_change, as_of}, short:{change_pct, short_pct_float, days_to_cover}, congress:[{name, chamber, party, type, size, date}]}
# ---------------------------------------------------------------------------
SMART_MONEY_QUESTIONS = {
    "conviction": Score(
        instructions=(
            "How much conviction are informed holders showing in `ticker`? Weigh open-market insider purchases (size relative to the "
            "buyer's role, number of distinct buyers, recency) far above routine sales, grants and option exercises; then institutional "
            "top-holder changes; then congressional purchases; then whether short interest is rising into the move."
        ),
        criteria=[
            "Distribution: insiders selling on open market, institutions trimming, no buyers",
            "Quiet: routine activity only; nothing informative either way",
            "Accumulation: a meaningful open-market insider buy or clear institutional adds",
            "Cluster buying: several insiders or officers buying with real money, or insiders plus institutions plus politicians all adding",
        ],
    ),
    "who": Choice(
        instructions="Who is doing the most informative positioning in `ticker` right now?",
        criteria={
            "insiders_buying": "Officers or directors buying on the open market",
            "insiders_selling": "Officers or directors selling on the open market beyond routine diversification",
            "institutions_adding": "Top holders increased positions in the latest filings",
            "institutions_trimming": "Top holders reduced positions",
            "politicians_buying": "Members of Congress reported purchases",
            "shorts_pressing": "Short interest rising meaningfully",
            "nobody": "No informative activity",
        },
    ),
}

# ---------------------------------------------------------------------------
# 3g. Stance, second round per stock. State is the composed first-round picture:
#    {ticker, name, lean:{choice, confidence}, setup, control, entry_quality, day_fit, swing_fit, extended_p,
#     event_risk_p, days_to_earnings, plan:{stop_pct, target_pct, reward_to_risk}, checklist:{passed, total, failed:[...]},
#     smart_money:{conviction, who, insider_buy_value_90d, insider_buyers, insider_sell_value_90d, institutions_top10_change, short_change_pct, congress_buys},
#     market_tone}
# ---------------------------------------------------------------------------
STANCE_QUESTIONS = {
    "stance": Choice(
        instructions=(
            "Weighing every read for `ticker` together: the directional `lean` and its confidence, the `setup`, who is in "
            "`control`, `entry_quality`, `swing_fit` and `day_fit`, whether it is `extended_p`, `event_risk_p` and "
            "`days_to_earnings`, the `plan` reward-to-risk, the `checklist` and which items failed, `smart_money` (including "
            "`smart_money.options`: what the options flow says and how intense it is), and "
            "`market_tone`, what is the most sensible stance for a swing trader right now? Be conservative: buying now "
            "needs a clean entry with the trend, not just a strong stock."
        ),
        criteria={
            "buy_now": "Trend, structure, candle and entry all agree, reward at least 1.5x risk, not extended, no event inside a week",
            "buy_the_dip": "Strong trend but the stock is extended or the entry is poor; wait for a pullback toward the 20-day average or a named support",
            "wait_for_breakout": "Constructive but capped under resistance or inside a range; a close through the level is the trigger",
            "hold_dont_add": "Already-long holders can stay with a stop, but new money has no edge here",
            "avoid": "Conflicting reads, a binary event ahead, or informed sellers; no trade",
            "short_setup": "Downtrend with sellers in control and a clean short entry",
        },
    ),
    "intraday": Choice(
        instructions=(
            "For an intraday trade in `ticker` in the coming session, weighing `intraday` (relative volume, ATR as a percent "
            "of price, yesterday's high and low, the pivot, the gap and the session state), `control`, `setup`, `day_fit`, "
            "`extended_p` and `market_tone`, which intraday playbook fits best? Be conservative: momentum plays need volume "
            "above normal; fades need an extended move on thin volume."
        ),
        criteria={
            "long_momentum": "Buy strength through yesterday's high or the opening-range high, volume above normal, trend up",
            "buy_dip_to_support": "Buy the first pullback to the pivot, the 20-day average or yesterday's high acting as support",
            "short_momentum": "Short weakness through yesterday's low, sellers in control, volume above normal",
            "fade_the_gap": "The gap or run is extended on light volume; fade it back toward the pivot",
            "range_scalp": "Trade between yesterday's high and low; no directional edge",
            "no_trade": "Too quiet, too erratic, or an event pending; skip it intraday",
        },
    ),
    "main_reason": Choice(
        instructions="Which single factor most drives that stance for `ticker`?",
        criteria={
            "trend_and_entry": "The trend and the entry quality",
            "extended": "The stock has run too far from its averages",
            "resistance": "Overhead resistance or a range cap",
            "event_risk": "Earnings or another dated event",
            "smart_money": "Insider, institutional or congressional positioning",
            "market_tone": "The overall market mood",
            "poor_reward": "The plan's reward-to-risk",
        },
    ),
}
STANCE_CONFIDENCE_SHOW = 0.45   # below this the page says "low confidence" next to the stance

# ---------------------------------------------------------------------------
# 3h. Options flow, per stock. State:
#    {ticker, name, spot, chg_pct, trend, nearest_expiries, call_volume, put_volume, put_call_volume, put_call_open_interest,
#     call_notional, put_notional, call_share_of_notional, atm_iv, top_calls:[{strike, otm_pct, dte, volume, oi, notional}],
#     top_puts:[...], unusual:[{side, strike, otm_pct, dte, volume, oi, vol_oi, notional}], unusual_call_notional, unusual_put_notional}
# ---------------------------------------------------------------------------
OPTIONS_QUESTIONS = {
    "read": Choice(
        instructions=(
            "Reading the options activity for `ticker` (call versus put volume and notional, volume versus open interest, "
            "which strikes and expiries carry the volume and how far out of the money they are, the `unusual` contracts "
            "where volume swamps established open interest, `volume_to_open_interest` overall, and `atm_iv`), together with "
            "`trend` and `chg_pct`, what does the flow say? Heed `note`: zero open interest means a new listing, not aggression. "
            "Choose aggressive_call_buying only when the `unusual` list is call-heavy and near-dated; entries with basis "
            "concentrated_new are single strikes taking a large share of the day's dollars before open interest is posted, "
            "which is evidence of fresh positioning but weaker than a volume-versus-open-interest spike."
        ),
        criteria={
            "aggressive_call_buying": "Heavy call volume concentrated in near-dated, out-of-the-money strikes that dwarfs open interest: speculators positioning for upside",
            "call_positioning_measured": "Calls dominate but in longer-dated or near-the-money strikes with volume in line with open interest: steady bullish positioning",
            "put_hedging": "Put volume elevated at strikes below the price in a stock that is rising: holders buying protection, not a bearish bet",
            "put_buying_bearish": "Heavy put volume, especially near-dated and at or below the money, in a stock that is falling or stalling: directional bearish bet",
            "two_sided_or_premium_selling": "Both sides heavy at similar strikes, or volume matching open interest: spreads, income trades, or hedged books",
            "quiet": "Volume ordinary relative to open interest; nothing informative",
        },
    ),
    "intensity": Score(
        instructions="How unusual is today's options activity for `ticker` relative to its open interest and typical flow?",
        criteria=[
            "Ordinary: overall volume below about a third of open interest and the unusual list is empty or trivial",
            "Elevated: a few strikes with volume well above open interest",
            "Heavy: multiple large contracts where volume is several times open interest, notional in the tens of millions",
            "Extreme: flow concentrated in one or two near-dated strikes at a scale that can move the stock itself",
        ],
    ),
}

# ---------------------------------------------------------------------------
# 3i. Options, market-wide. State: {cboe:{as_of, ratios:{...}}, scanned:{n, aggregate_call_volume, aggregate_put_volume, aggregate_put_call},
#     leaders:[{ticker, group, total_notional, call_share, read, intensity}], market_tone}
# ---------------------------------------------------------------------------
OPTIONS_MARKET_QUESTIONS = {
    "positioning": Choice(
        instructions=(
            "Reading `cboe` put/call ratios (total, index, equity, ETF where available), the aggregate call and put volume "
            "across `scanned` names and the `leaders` by notional, how is the options market positioned?"
        ),
        criteria={
            "complacent": "Low put/call ratios, call-heavy single-stock flow, little hedging: crowded long, vulnerable to a shock",
            "bullish_healthy": "Call-leaning flow with a normal amount of index hedging",
            "balanced": "Ratios near their usual middle, no side dominant",
            "hedged": "Index puts elevated while single-stock calls stay active: holders protected but not bearish",
            "fearful": "High put/call ratios across categories, put buying in single names",
        },
    ),
    "where_volume_flows": Choice(
        instructions="Which group carries the most options notional and the most aggressive call flow in `leaders`?",
        criteria={**{k: v for k, v in GROUPS.items() if k != "none"}, "index_etfs": "SPY, QQQ, IWM and other index products"},
    ),
}
OPTIONS_INTENSITY_FLAG = 2.0    # Score >= this earns the "heavy options" tag

# ---------------------------------------------------------------------------
# 4. Economic calendar. State per event: {title, country, time_et, ff_impact, forecast, previous}
# ---------------------------------------------------------------------------
CALENDAR_QUESTIONS = {
    "equity_relevance": Score(
        instructions=(
            "How much attention should a US equity trader pay to this scheduled event? `country` is "
            "the currency of the releasing economy and `ff_impact` is a third-party importance flag "
            "to weigh, not to copy."
        ),
        criteria=[
            "Ignore: foreign minor data, bank holidays, or routine releases that never move US stocks",
            "Note the time: can cause a brief blip in futures or one sector",
            "Plan around it: routinely moves US index futures, such as major US data, Fed speakers on policy, or Treasury auctions in a rate-sensitive tape",
            "Session-defining: FOMC decision, CPI, payrolls, or an equivalent that sets the whole day's direction",
        ],
    ),
}

# ---------------------------------------------------------------------------
# 5. Earnings calendar. State per row: {symbol, name, market_cap, report_time, eps_forecast, last_year_eps, num_estimates}
# ---------------------------------------------------------------------------
EARNINGS_QUESTIONS = {
    "attention": Score(
        instructions="How much trader attention will this earnings report draw?",
        criteria=[
            "Negligible: obscure micro-cap or thinly covered name",
            "Niche: known within its sector; may move close peers modestly",
            "Widely watched: large cap or momentum name; will trade heavily on the print",
            "Market-moving: bellwether whose result shifts index futures or an entire sector",
        ],
    ),
    "read_through": Choice(instructions="Which group is most likely to move in sympathy with this report?", criteria=GROUPS),
}

# ---------------------------------------------------------------------------
# Thresholds and composition (starting points; evaluate on your own data)
# ---------------------------------------------------------------------------
HEADLINE_ACTIONABLE_MIN = 0.55
HEADLINE_IMPACT_MAX = 3.0
CALENDAR_SHOW_MIN = 1.0
CALENDAR_HIGHLIGHT_MIN = 2.0
EARNINGS_SHOW_MIN = 1.0
EARNINGS_HIGHLIGHT_MIN = 2.0
LOW_CONFIDENCE = 0.5
EVENT_RISK_MIN = 0.6          # Noul p -> "event risk" flag
EXTENDED_MIN = 0.6            # Noul p -> "extended" flag
DAY_TAG_MIN = 2.0             # Score -> tagged "day trade"
SWING_TAG_MIN = 2.0           # Score -> tagged "swing"

HEADLINE_WEIGHTS = {"impact": 0.7, "actionable": 0.3}
# Stock composite scores (0..1). AI fit is central; code adds the measurable parts.
DAY_WEIGHTS = {"ai_fit": 0.5, "atr_pct": 0.25, "gap": 0.15, "rel_vol": 0.10}
SWING_WEIGHTS = {"ai_fit": 0.6, "trend": 0.25, "atr_pct": 0.15}
ATR_PCT_SATURATION = 6.0      # ATR% that scores 1.0
GAP_SATURATION = 6.0          # |gap %| that scores 1.0
REL_VOL_SATURATION = 2.0      # 2x average volume scores 1.0


THEME_WEIGHTS = {"leverage": 0.30, "move": 0.25, "trend": 0.20, "vol_beta": 0.15, "rel_strength": 0.10}


def theme_rank(leverage: float | None, move: float | None, trend_alignment: float, atr_pct: float | None, beta: float | None, rel_1m: float | None) -> float:
    """0..1: how much a name can run if the theme keeps working. Semantic reads carry more than raw stats."""
    w = dict(THEME_WEIGHTS)
    if leverage is None:
        w["trend"] += w.pop("leverage")
    if move is None:
        w["vol_beta"] += w.pop("move")
    vb = _sat((atr_pct or 0) * (beta or 1.0), 12.0)      # 6% ATR at beta 2 saturates
    rs = 0.5 + max(-0.5, min(0.5, (rel_1m or 0) / 30.0))  # +-15% vs SPY over a month spans the scale
    return (w.get("leverage", 0) * ((leverage or 0) / 3.0) + w.get("move", 0) * ((move or 0) / 3.0)
            + w["trend"] * trend_alignment + w["vol_beta"] * vb + w["rel_strength"] * rs)


def headline_rank(actionable: float, impact: float) -> float:
    return HEADLINE_WEIGHTS["impact"] * (impact / HEADLINE_IMPACT_MAX) + HEADLINE_WEIGHTS["actionable"] * actionable


def _sat(x: float | None, cap: float) -> float:
    return 0.0 if x is None else max(0.0, min(1.0, abs(x) / cap))


def day_score(ai_fit: float | None, atr_pct: float | None, gap_pct: float | None, rel_vol: float | None) -> float:
    w = dict(DAY_WEIGHTS)
    if ai_fit is None:
        w["atr_pct"] += w.pop("ai_fit")
    if rel_vol is None:
        w["atr_pct"] += w.pop("rel_vol")
    return (w.get("ai_fit", 0) * ((ai_fit or 0) / 3.0)
            + w["atr_pct"] * _sat(atr_pct, ATR_PCT_SATURATION)
            + w["gap"] * _sat(gap_pct, GAP_SATURATION)
            + w.get("rel_vol", 0) * _sat(rel_vol, REL_VOL_SATURATION))


def swing_score(ai_fit: float | None, trend_alignment: float, atr_pct: float | None) -> float:
    """trend_alignment: 0..1, how many of the 20/50/200 averages agree on direction."""
    w = dict(SWING_WEIGHTS)
    if ai_fit is None:
        w["trend"] += w.pop("ai_fit")
    return (w.get("ai_fit", 0) * ((ai_fit or 0) / 3.0)
            + w["trend"] * trend_alignment
            + w["atr_pct"] * _sat(atr_pct, ATR_PCT_SATURATION))
