# Webex Market Update

A live market dashboard for day and swing traders, written so that someone with a few
years of market knowledge can read it without a glossary. Code fetches the data;
[TypeSafe](https://typesafe.ai) supplies the judgment calls as typed, calibrated answers;
every judgment is explained in one plain sentence on the page.

## What is on the page

**Verdict per stock.** A second TypeSafe round runs after every other read is in: it sees the
lean and confidence, setup, who is in control, entry quality, day and swing fit, extended
and event-risk probabilities, days to earnings, the plan's reward-to-risk, the ten-item
checklist with its failed items, the smart-money picture (insider buys and sells,
institutional changes, congressional buys, short-interest change) and the market tone,
and answers one question: what is the sensible stance now? Buy, buy the dip, wait for
breakout, hold but don't add, avoid, or short setup, plus the single factor that most
drives it. Cards and the stock view lead with that verdict in plain words. "Who is
buying" lists insiders, institutions, Congress and shorts as YES / NO lines with the
specific evidence. Scores are shown as words (weak, modest, good, strong) with the number
beside them.

**Intraday verdict.** The same second round also answers an intraday question over relative
volume, ATR, yesterday's high and low, the pivot, the gap and the session state: long
momentum, buy dip to support, short momentum, fade the gap, range scalp, or no trade.

**Options flow (view 9).** For the index ETFs, every analysed stock and the top theme names,
Yahoo option chains over the nearest three expiries give call and put volume and open
interest, put/call ratios, dollars traded (contracts × price × 100), the share of dollars
in calls, top strikes, and "unusual" contracts where volume is at least 3× established
open interest and $250k. Cboe's daily market statistics add market-wide put/call ratios
and category volumes. TypeSafe reads each name (aggressive call buying, measured call
positioning, put hedging, bearish put buying, two-sided, quiet; plus an intensity score)
and the market as a whole (complacent, bullish and healthy, balanced, hedged, fearful;
and which group carries the most notional). The options read also feeds each stock's
stance. Caveat: Yahoo posts open interest overnight and its after-hours implied
volatility is unreliable, so new listings are not counted as unusual and IV shows as
unavailable outside market hours.

**Dynamic watchlists (search box in the menu bar).** Type a ticker or a company name
(press `/` to jump to the box); every US-listed stock and ETF is in the index, which
comes from Nasdaq Trader's daily symbol directory (`symbols.json`, refreshed daily).
Pick a result to add it to the active list. Lists live in your browser: create, rename
and delete named lists from the bar above the cards, remove a name with the × on its
card. What a card shows depends on what the build knows: a full card (verdict, plan,
checklist, who is buying) when the name was analysed, a quote card (price, change,
trend, RSI, daily range, distance from the 20-day average, 1/3-month returns, volume
vs normal, the volume-scan score) for the ~250 names every build quotes, and in server
mode any other ticker is analysed on demand in about 20 seconds (`/api/stock/{ticker}`:
technicals, price action, news, smart money, options, the stock read and the stance
round). The server remembers every ticker added from the page, so scheduled builds
analyse them fully from then on. On the public GitHub Pages copy there is no server:
quote cards still work for the build's names, and full analysis follows `watchlist.txt`.

**Volume scanner (SCAN › Volume scanner).** Runs by itself, no input needed. In server
mode it re-runs every minute while the market is pre, open or after hours (every ten
minutes overnight) and the table updates in place with a live stamp and a countdown; the
hourly build adds the model reads. Regular-session 15-minute bars for the whole scan
universe (plus the low-float names) are rolled up into 30-minute, 1-hour and 2-hour
candles; the 15m and 30m columns are the day-trading view, 1h and 2h the context.
Clicking a row opens that name's page (chart, verdict, smart money). Per name: relative volume by time of day
(volume so far versus the same clock time over the prior ten sessions), session VWAP and
position in the day's range; per timeframe: the last three bars' volume against the
20-bar norm, how many bars in a row volume has grown, the bar's range against that
timeframe's ATR, the three-bar move, RSI, and whether price broke the 20-bar range. Each
timeframe scores 0–100 (volume build 40, rising bars 15, range 15, move 15, confirmation
15); the overall score weights 15m/30m/1h/2h at 30/30/25/15. Filters: price ≥ $2, session volume
≥ 300k, RVOL ≥ 1.5× or a three-bar volume ratio ≥ 2× on any timeframe. TypeSafe reads the
top twelve: the kind of move (breakout on volume, building, climax, selling, pullback,
noise), the odds it continues over the next one to two hours, and the sensible play.
When the market is closed the scan shows the last session's tape. All settings are in
`config.py` (`SCAN_*`) and the questions in `judgments.py`.

**Low float (view 2, bottom half).** Candidates come from Yahoo's screener (a custom
small-cap movers query plus the small-cap gainers, aggressive small caps, day gainers
and most-active lists); float, shares outstanding, short % of float, days to cover and
insider / institutional ownership come from each candidate's quote summary (cached a
day). Names with a float under 30M shares are kept (under 10M is tagged micro), ranked by
float turnover (today's volume ÷ float), with day-range position, distance from the
52-week high, the intraday volume-scan score, and a TypeSafe read: state (squeeze in
progress, momentum run, fading after spike, selling pressure, quiet), a 0–3 risk score
for reversals, halts and dilution, and the play, which is often "avoid".

**WhatsApp.** The green icon at the top right opens WhatsApp with a formatted brief:
mood, insider buys, insider sales, congressional buys, heavy options buying and the
watchlist verdicts. Nothing is drawn on the page.

**Top of the page: the action board.** One-line market mood, then a card for every
watchlist stock: LEAN (long / short / neutral with confidence), setup, swing and day
scores, and a plan in one sentence (entry near the current price, stop at the nearest
structural level capped at two ATRs, target at the 20-day extreme, reward-to-risk with a
plain verdict). Two buttons: **Full analysis** opens the complete toolkit for that name,
**Open chart** opens it on TradingView. Each card also carries a **price-action read**
(who is in control, market structure, last candle) and a **pre-position checklist**
scored out of ten. Below that, the best swing setups outside your list. Everything else
lives in collapsible "Deeper analysis" sections.

**Big picture, 1 / 3 / 6 / 12 months.** Right under the watchlist: S&P 500 futures, Nasdaq
100, gold, WTI crude and the 10-year yield, each with return (or basis-point change) over
every horizon, position in that window's range, drawdown from the window high, and swing
structure, plus a 52-week candlestick chart on click. TypeSafe reads each asset (phase,
horizon alignment, trend strength) and the five together (macro picture, three-month equity
lean, biggest risk to the trend).

**Theme screen: AI data-center buildout.** About fifty names by role in the stack (compute,
memory and storage, networking and optics, servers and cooling, power, chip equipment,
data-center REITs, hyperscalers and clouds). Each gets relative strength versus SPY over
1 and 3 months, trend and structure, ATR, beta, short interest, revenue growth and forward
P/E, plus four TypeSafe reads: theme leverage (peripheral to pure play), phase (leader,
catching up, laggard, extended, broken), move potential in a risk-on tape, and fundamental
support. A run score ranks them; a group read says what stage the theme is in and which
part of the stack is likely to lead next.

**Smart money.** For the analysed names and the top theme names: insider open-market buys
and sales (SEC Form 4 via Yahoo, last 90 days, with the 6-month buy/sell counts),
institutional ownership and top-10 holder changes (13F, quarterly), short interest and
its month-on-month change, and congressional STOCK Act trades (via Quiver Quant's public
page, cached 6 hours). TypeSafe scores conviction 0–3 and names who is positioning. There
is no public feed of executive-branch or presidential-family purchases; those appear only
in annual OGE disclosures.

Everything else in the toolkit:

1. **How the market feels today** — mood (risk-on / risk-off / mixed), expected swings, what's driving it, who should lead, what rates are doing to stocks, where money is going. One TypeSafe request over the overnight tape, index technicals, the yield curve, flow gauges, breadth, headlines and calendar.
2. **What moved overnight** — index futures, VIX, 10-year, dollar, oil, gold, bitcoin with 5-day lines.
3. **The big indexes** — SPY, QQQ, IWM, DIA candlestick charts with SMA 20/50, prior-day high/low, pivot, RSI, ATR, 52-week position.
4. **Interest rates** — the full Treasury curve today vs one month and one year ago (FRED), 2s10s and 3m10y spread history, live yields, and a plain-language read.
5. **Where the money is going** — seven ratio gauges (equal vs cap weight, small vs large, discretionary vs staples, high yield vs Treasuries, copper vs gold, semis vs market, VIX term structure), breadth across the scan universe, sector returns over 1D/5D/1M.
6. **News that actually matters** — headlines judged for actionability, ranked by impact, tagged with lean, scope and theme. Listicles are dropped.
7. **Stocks worth watching** — the most volatile and gapping liquid names plus your watchlist. Click a row for a candlestick chart with levels, volatility stats, trend, fundamentals, recent headlines, and model judgments: lean, chart setup, day-trade fit, swing fit, catalyst, event risk, extended. Filter tabs: All / Day trade / Swing / Gapping / Watchlist.
8. **Today's economic events** and **companies reporting earnings**, each scored for relevance.

Hover any dotted-underlined term for a one-line definition.

### Price action and the checklist

`technicals.py` reads the daily candles with no AI: last-candle pattern (doji, hammer,
shooting star, bullish or bearish engulfing, inside bar, outside bar, strong close), close
location in the range, body size, range versus ATR, volume versus the 20-day average, the
up/down streak, gap at the open, and market structure from swing highs and lows (higher
highs and higher lows, lower highs and lower lows, expanding, contracting), with the
nearest swing support and resistance, which are also drawn on the chart as S and R.
TypeSafe then answers two questions over that state: who is in control (buyers, sellers,
either side exhausting, indecision) and entry quality (0–3).

The checklist in `app.js` is plain code over those facts. For a long lean: trend agrees,
structure agrees, market mood agrees, not chasing (within two ATRs of the 20-day average
and not flagged extended), last candle agrees, volume backs it, room to run (reward at
least 1.5× risk), no event inside five sessions, RSI below 70, clean entry (model score
at least 2). Short leans mirror these. Eight or more is "Ready", six or seven "Almost",
fewer "Not yet". Every line shows why it passed or failed.

## Accounts, sessions and the database

`market_update/db.py` keeps a SQLite file (`MU_DATA_DIR/market_update.db`) with four
tables: `users`, `signin_tokens`, `sessions` and `watchlist`. The `sessions` table is the
record of who is logged in: a row per browser with `logged_in` 1 or 0, `last_seen` and an
expiry; `GET /api/auth/status` answers "logged in or not" for the calling browser and
`/api/me` renews the row on every visit. Sign-out flips the row to 0 and clears the
cookie. An older `users.json` is imported into the database on first start.

The page opens on the sign-in card; after the emailed link (valid 10 minutes, auto-resent
if it has run out) the user is asked once for a display name and lands on the dashboard.
The name shows in the menu footer with the email and next to the SIGN OUT button.
`MU_ADMIN_EMAILS` (default `shayan001@live.ca,shayan001@live.cs`) lists admin accounts;
everyone else is a regular user. Admins get an **Admin** entry in the left menu: users
signed in now, active sessions, requests per minute for the last two hours, page loads,
logins, every account with its status, and the recent activity log (logins, logouts, link
requests, watchlist changes, on-demand analyses). Traffic and activity are recorded in
the `traffic` and `activity` tables. The left column starts with **Create My
Watchlist**: type a ticker or company, press Enter, and the name gets a card on the home
page (verdict, a "right now" strip for the current session, lean, plan, checklist, who is
buying), a row in the left column with live price and change, a line in the final
verdicts, and its own page. Names are removed one at a time from the row or the card. The
list lives in the browser until the user signs in ("Sign in to sync it" in the menu
footer), after which it is saved to the account and loads on any device.

The page pulls fresh data at the top of every hour; the counter in the top bar shows the
time to the next pull, and REFRESH forces one.

## Sign-in flow

Sign-in opens as a card from the menu footer. In server mode the flow is passwordless: enter an email,
`POST /api/auth/request` stores a one-time token (57 minutes, single use) and emails a
link; opening `/auth/verify?token=…` sets a signed, HttpOnly session cookie (30 days,
HMAC with `MU_SECRET`, generated into the data directory if unset). The cookie is renewed
on every visit, so the session stays active until the user presses SIGN OUT (top bar or
menu footer) or stays away for 30 days. Opening a link after its 57 minutes shows an
"expired" page and automatically emails a fresh link to the same address (at most one a
minute); a link that was already used says so and points back to sign-in. Email goes out over
SMTP when `MU_SMTP_HOST`, `MU_SMTP_PORT`, `MU_SMTP_USER`, `MU_SMTP_PASS` and `MU_SMTP_FROM`
are set; without a mail server the link is written to the server log and, unless
`MU_DEV_LINKS=0`, handed back to the page so local use still works. `MU_PUBLIC_URL`
fixes the base URL in links behind a proxy.

**Sending the emails.** `market_update/mail.py` sends the branded sign-in email (gold on
black, one button) through whichever transport is configured in `.env` (copy
`.env.example`): a Resend API key, a SendGrid API key, or any SMTP mailbox with STARTTLS
(Gmail with an app password, Outlook / Microsoft 365, a company or Webex-hosted mailbox).
`MU_MAIL_FROM` sets the sender shown to users, e.g. `Webex Market Update <alerts@yourdomain.com>`.
Check it with `market-update mail-test` (prints the transport) or
`market-update mail-test you@example.com` (sends a test message). The sign-in card shows
which transport and sender are active, and says so when none is connected.

Clicking a ticker anywhere opens its own page: hero with price and verdict, chart with
levels, plan, checklist, model reads, who is buying, stats and news.

The public GitHub Pages copy has no server, so there the same card keeps the email and
picks in the browser only and says so; real emailed links need the hosted server
(Docker / Render files are included).

## Layout: left menu, one screen

The page never scrolls on desktop. A collapsible menu on the left holds the logo and six
views with lit icons and sub-menus: HOME (mood, verdicts, the active list, a fixed live
news feed on the right), SCAN (volume scanner, low float), STOCKS (All, Day trade, Swing trade, Large cap, Small cap, Gapping, Watchlist as
sub-menu items), THEMES, SMART MONEY (insiders and institutions, options flow), MACRO (big picture, weekly indexes with
support and resistance, rates, money flows). Keys 1–6 switch views; the hash keeps the
current one. The slim top bar holds the ADD TICKER search, the market state and the
refresh button. Dense tables scroll inside their own
compartment. Below 900px the shell falls back to a single scrolling column.

## Brand and sharing

The mark is a gold neon fox in an open ring on black (`static/logo.svg`, with PNG
favicons and a 1200×630 share card `static/og.png`). The page title is "Webex Market
Update"; Open Graph and Twitter tags give bookmarks and shared links the title, a
description and the card. The share image URL comes from `MU_PUBLIC_URL` (default: the
GitHub Pages address) in exports and from the request host on the server.

## Design

Calm dark terminal: a soft near-black ground, IBM Plex Sans for reading, IBM Plex Mono for
numbers, green for up, red for down, amber for caution, blue for the one accent. 1px
grid lines, 8px radius, no shadows or textures. The one-screen HUD layout with eight
views is unchanged. Earlier explorations (retro Gen-Z tokens and components) remain in
the Figma file "Market Update — Retro Gen-Z Trader Dashboard"
(https://www.figma.com/design/9joJMIMs7X9Ay2l9Im9k9N).

## Run locally

```bash
source ~/.zshrc                      # loads TYPESAFE_API_KEY
.venv/bin/market-update serve        # http://localhost:8000
```

The server rebuilds on a schedule (every 5 min pre-market and during the session, 15 min after hours, hourly otherwise), serves the latest report instantly, and exposes a **Refresh** button with a 2-minute cooldown. New data is applied automatically when you are idle, or offered with an "Update now" button while you are reading.

One-file static export (also what the release zip and GitHub Pages ship):

```bash
.venv/bin/market-update --open       # writes output/index.html + output/report.json
```

`--no-ai` builds without TypeSafe calls.

## Host it for free (GitHub Pages)

The workflow in `.github/workflows/build.yml` rebuilds the dashboard every hour on
weekdays and every four hours at weekends, and publishes it to GitHub Pages. The page
polls `report.json` every two minutes and updates itself without a reload; the REFRESH
button re-checks immediately. A forced rebuild is one click on the workflow's "Run
workflow" button in the repository's Actions tab (owner only). Free tier: about 2,000
Actions minutes a month; this schedule uses roughly 500.

```bash
gh auth login                                   # once
gh repo create market-update --public --source . --push
gh secret set TYPESAFE_API_KEY                  # paste the key when prompted (Actions reads watchlist.txt from the repo)
gh api -X POST repos/{owner}/market-update/pages -f build_type=workflow
gh workflow run build.yml
```

The site appears at `https://<your-user>.github.io/market-update/` after the first run.
Free tier: about 2,000 Actions minutes a month; this schedule uses roughly 600.

## Publish the live app (accounts + email sign-in)

GitHub Pages only serves the static preview. Accounts, emailed sign-in links, the
database and on-demand analysis need the server running somewhere public. The quickest
route is Render's blueprint, which reads `render.yaml`:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/shayan001-cell/market-update)

1. Click the button (a Render account is needed; sign in with GitHub).
2. Render asks for the secret values: `TYPESAFE_API_KEY`, `MU_MAIL_FROM`, `MU_SMTP_HOST`,
   `MU_SMTP_USER`, `MU_SMTP_PASS`. Use the same values as the local `.env`.
3. Deploy. The app comes up at `https://webex-market-update.onrender.com` (or the name
   Render assigns), builds its first report, and every sign-in link is emailed.
4. Put that address into the GitHub repository variable `MU_APP_URL` (Settings → Secrets
   and variables → Actions → Variables) so the public preview's sign-in card links to it.

Any Docker host works the same way with the `Dockerfile`; set the same variables. Optional
tuning: `MU_INTERVAL_MARKET`, `MU_INTERVAL_POST`, `MU_INTERVAL_OFF`, `MU_REFRESH_COOLDOWN`,
`MU_NO_AI=1`.

## Release packaging

```bash
python scripts/package_release.py --version 1.0.0 --release-type market-ready
```

Stamps the version, rebuilds the dashboard, and writes `dist/market-update-<v>-<type>.zip`.

## Files to review

- `market_update/judgments.py` — **every TypeSafe question, threshold and ranking weight.** Read and tune this one.
- `market_update/static/app.js` — the page, including the plain-English explanations (`EX`) and glossary (`G`).
- `market_update/config.py` — symbols, universe, gauges, filters, schedule.
- `watchlist.txt` — tickers analysed on every build (the page's own lists are added on top in server mode).
- `market_update/scanner.py` — the intraday volume scanner (no AI; arithmetic over 30m/1h/2h bars).
- `market_update/fetch.py`, `technicals.py`, `analyze.py`, `server.py`, `render.py`.

## Data sources (all keyless)

Yahoo Finance (quotes, history, extended-hours and 30-minute bars, news, fundamentals,
screener, float and ownership), FRED (Treasury curve, one-day lag), ForexFactory
(economic calendar), Nasdaq (earnings calendar, symbol directory), Quiver Quant
(congressional trades), Cboe (daily options statistics).
Caveats: Yahoo's minute feed does not report extended-hours volume; exchange holidays are
not modelled; ForexFactory rate-limits, so its feed is cached for an hour.

## Cost

A full build is about 290 TypeSafe calls and 400k input tokens, and takes 60–90 seconds.
Nothing here is investment advice.

## Market bell

The page watches the New York clock: at 9:30 ET it flashes MARKET OPEN across the screen
for a few seconds (and MARKET CLOSED at 4:00), and the state badge in the top bar follows
the clock between builds.
