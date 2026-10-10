# Option Intelligence Free — Paper Trading

Free intraday option-buyer dashboard for NIFTY / BANKNIFTY with a decision engine
and a client-side paper-trading simulator. **No broker account, no real orders.**

## Project layout (folder structure matters!)

```
app.py              FastAPI app + decision engine
indicators.py       EMA, RSI, ATR, ADX (Wilder), session VWAP
market_data.py      Yahoo candles + NSE option chain (cached, with fallbacks)
requirements.txt
render.yaml
.gitignore
static/
  index.html
  app.js
  style.css
```

`index.html`, `app.js` and `style.css` **must** live inside a `static/` folder.

## Run locally

```
pip install -r requirements.txt
uvicorn app:app --reload
# open http://127.0.0.1:8000
```

## Deploy on Render

1. Push this folder to a GitHub repository (keep the `static/` folder).
2. Render → New + → Web Service → connect the repo (or use the Blueprint / `render.yaml`).
3. Build: `pip install -r requirements.txt`
4. Start: `uvicorn app:app --host 0.0.0.0 --port $PORT`
5. Plan: Free. (Free services sleep after ~15 min idle; the first load can take 30–60 s.)

## How the signal works

Factors (weight): price vs EMA9 (1), EMA9 vs EMA21 (2), price vs VWAP (2, only if the
feed has volume), RSI zone (2, graded), ADX trend direction via +DI/−DI (1),
volume confirmation (1, only if available), PCR (1, only if option chain loads).

Scores are measured against the points that are **actually available**. BUY CALL / BUY
PUT needs ≥ 70% alignment and a ≥ 40% lead over the other side. It is forced to WAIT
when ADX < 18, when the market is closed or the data is stale, before 09:30 IST and
after 15:00 IST. Tunable constants are at the top of `app.py`.

## Paper trading rules (option premium, live)

* Pick a strike by clicking a CE/PE premium in the **Option Chain** card (or use the
  dropdowns). You always BUY the option; entry defaults to the live premium (last traded
  price from the option chain).
* Stop-loss trigger, stop-loss price and target are in **option premium ₹**. Quantity =
  lots × lot size (defaults NIFTY 65, BANKNIFTY 30 as of Jan 2026 - edit the field if
  NSE has revised them). "Quick levels" fills SL/target from percentages.
* The open trade is refreshed about every 10 s from `/api/option-quote` (served from a
  20 s chain cache) and shows live premium, unrealized P&L (after the charges you enter),
  and the highest/lowest premium seen.
* Exits only see prices the app actually polled - a spike between two refreshes can be
  missed. A stop fills at the observed premium (flagged "gapped" if below the stop-loss
  price); a target fills at the target price.
* Optional auto square-off at 15:25 IST (needs the tab open). Trades are only tracked
  against the **nearest expiry**; if it expires/rolls you are told to close manually.
* Needs the option chain to load (Dhan keys recommended on Render). Without it the app
  cannot track premiums and will not open a trade.
* The account is stored in your browser (localStorage); use **Reset account** to clear it.

## Data sources & limits

* Yahoo Finance 5m index candles. Index candles carry zero volume, so VWAP and volume
  ratio are shown as unavailable (never faked).
* NSE option chain (OI, PCR, IV, support/resistance, max pain). NSE often blocks cloud IPs.
  The app tries the current `option-chain-v3` API, then the legacy endpoint. If both fail
  you will see a short reason in the Option Intelligence card and the engine simply ignores PCR.
  Optional: set the `NSE_PROXY` environment variable to route NSE calls via a proxy.
* **Reliable option chain on Render: Dhan.** Set `DHAN_CLIENT_ID` and `DHAN_ACCESS_TOKEN`
  in Render → Environment. The app then uses Dhan's `/v2/optionchain` (NIFTY id 13,
  BANKNIFTY id 25) first and NSE only as a fallback. Needs a Dhan account with the Data API
  enabled (may be a paid add-on); Dhan web-generated tokens expire (about 24 h), so refresh
  the token when the card shows a Dhan HTTP 401/806 error. Dhan allows 1 option-chain call per
  3 s; the app caches for 45 s.
* For reliable live option data, replace these public endpoints with a licensed
  broker/market-data API.

Educational use only. Not investment advice.
