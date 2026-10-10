"""Market data access: Yahoo Finance 5m candles + NSE option chain.

Both sources are public, unofficial endpoints. This module therefore:
  * caches results briefly (protects you from rate limits / IP blocks),
  * serves the last good copy (clearly flagged) if a refresh fails,
  * never invents numbers: anything unavailable is returned as None / ok=False.
"""
import asyncio
import os
import time
from datetime import datetime, timezone

import httpx

from indicators import IST

NSE_BASE = "https://www.nseindia.com"
NSE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nseindia.com/option-chain",
    "Connection": "keep-alive",
}
NSE_PAGE_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

YAHOO = {"NIFTY": "^NSEI", "BANKNIFTY": "^NSEBANK"}
YAHOO_HOSTS = ("query1.finance.yahoo.com", "query2.finance.yahoo.com")
YAHOO_HEADERS = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}

CANDLE_SECONDS = 300
MARKET_TTL = 10          # seconds a market snapshot is reused
CHAIN_TTL = 45           # seconds an option-chain snapshot is reused
CHAIN_FAIL_BACKOFF = 30  # seconds to wait before retrying NSE after a failure
STALE_AFTER = 900        # data older than this during market hours = STALE


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------
def _short_err(e):
    if e is None:
        return "unknown error"
    if isinstance(e, httpx.HTTPStatusError):
        u = e.request.url
        return f"HTTP {e.response.status_code} from {u.host}{u.path}"
    if isinstance(e, httpx.TimeoutException):
        return "request timed out"
    if isinstance(e, httpx.RequestError):
        return f"{type(e).__name__} (network error)"
    return f"{type(e).__name__}: {str(e)[:140]}"


def _num(x):
    return x if isinstance(x, (int, float)) and not isinstance(x, bool) else 0


_CACHE = {}
_LOCKS = {}


async def cached(key, ttl, fetch, max_stale=300):
    """TTL cache with a per-key lock; falls back to the last good value."""
    hit = _CACHE.get(key)
    if hit and time.monotonic() - hit[0] < ttl:
        return hit[1]
    lock = _LOCKS.setdefault(key, asyncio.Lock())
    async with lock:
        hit = _CACHE.get(key)
        if hit and time.monotonic() - hit[0] < ttl:
            return hit[1]
        try:
            value = await fetch()
        except Exception:
            if hit and time.monotonic() - hit[0] < max_stale:
                stale = dict(hit[1])
                stale["served_from_cache"] = True
                stale["cache_age_s"] = round(time.monotonic() - hit[0])
                return stale
            raise
        _CACHE[key] = (time.monotonic(), value)
        return value


def session_info(last_data_ts, now=None):
    """Market session status from the clock and the age of the newest data."""
    now = time.time() if now is None else now
    dt = datetime.fromtimestamp(now, tz=IST)
    hm = (dt.hour, dt.minute)
    in_hours = dt.weekday() < 5 and (9, 15) <= hm <= (15, 30)
    age = None if last_data_ts is None else max(0.0, now - last_data_ts)
    if not in_hours:
        status = "CLOSED"
    elif age is not None and age <= STALE_AFTER:
        status = "OPEN"
    else:
        status = "STALE"
    return {
        "status": status,
        "data_age_s": None if age is None else round(age),
        "ist_time": dt.strftime("%d %b %Y %H:%M:%S IST"),
        "ist_minutes": dt.hour * 60 + dt.minute,
    }


# --------------------------------------------------------------------------
# Yahoo Finance candles
# --------------------------------------------------------------------------
def _parse_yahoo(j):
    chart = j.get("chart") or {}
    if chart.get("error"):
        raise RuntimeError(str(chart["error"])[:140])
    result = (chart.get("result") or [None])[0]
    if not result:
        raise RuntimeError("Yahoo returned no result")
    q = result["indicators"]["quote"][0]
    stamps = result.get("timestamp") or []

    def at(series, i):
        series = series or []
        return series[i] if i < len(series) else None

    candles, seen = [], set()
    for i, ts in enumerate(stamps):
        o, h, l, c = at(q.get("open"), i), at(q.get("high"), i), at(q.get("low"), i), at(q.get("close"), i)
        if None in (ts, o, h, l, c) or ts in seen:
            continue
        seen.add(ts)
        candles.append({
            "time": int(ts),
            "open": float(o), "high": float(h), "low": float(l), "close": float(c),
            "volume": float(at(q.get("volume"), i) or 0),
        })
    candles.sort(key=lambda x: x["time"])
    return candles, result.get("meta") or {}


async def yahoo_candles(symbol):
    ticker = YAHOO[symbol]
    params = {"interval": "5m", "range": "5d", "includePrePost": "false"}
    last_err = None
    async with httpx.AsyncClient(timeout=12, headers=YAHOO_HEADERS, follow_redirects=True) as c:
        for attempt in range(2):
            for host in YAHOO_HOSTS:
                try:
                    r = await c.get(f"https://{host}/v8/finance/chart/{ticker}", params=params)
                    r.raise_for_status()
                    return _parse_yahoo(r.json())
                except Exception as e:  # try next host / attempt
                    last_err = e
            if attempt == 0:
                await asyncio.sleep(0.6)
    raise RuntimeError("Yahoo Finance unavailable: " + _short_err(last_err))


async def _build_snapshot(symbol):
    candles, meta = await yahoo_candles(symbol)
    if not candles:
        raise RuntimeError("Yahoo returned no candles")
    has_volume = any(x["volume"] > 0 for x in candles)

    last = candles[-1]["close"]
    last_ts = candles[-1]["time"]
    live = meta.get("regularMarketPrice")
    live_ts = meta.get("regularMarketTime")
    if isinstance(live, (int, float)) and isinstance(live_ts, (int, float)) and live_ts >= last_ts:
        last, last_ts = float(live), int(live_ts)

    return {
        "ok": True,
        "source": "Yahoo Finance 5m candles",
        "symbol": symbol,
        "candles": candles,
        "last": last,
        "last_data_ts": last_ts,
        "volume_available": has_volume,
        "diagnostics": {
            "candles": "OK",
            "volume": "OK" if has_volume else "Yahoo index candles report zero volume; VWAP / volume ratio are unavailable",
            "option_chain": "Fetched separately from NSE; NSE often blocks cloud-hosting IPs",
        },
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


async def get_market_snapshot(symbol):
    return await cached(f"mkt:{symbol}", MARKET_TTL, lambda: _build_snapshot(symbol), max_stale=300)


# --------------------------------------------------------------------------
# NSE option chain
# --------------------------------------------------------------------------
def _parse_expiry(s):
    try:
        return datetime.strptime(s, "%d-%b-%Y").date()
    except Exception:
        return None


def _nearest_expiry(expiries):
    today = datetime.now(IST).date()
    dated = sorted((d, s) for s in expiries if (d := _parse_expiry(s)))
    for d, s in dated:
        if d >= today:
            return s
    return dated[0][1] if dated else (expiries[0] if expiries else None)


def _row_expiry(row):
    return (
        row.get("expiryDate")
        or row.get("expiryDates")
        or (row.get("CE") or {}).get("expiryDate")
        or (row.get("PE") or {}).get("expiryDate")
    )


def parse_chain(j, expiry_hint=None):
    """Turn an NSE option-chain payload into analytics for ONE expiry."""
    if not isinstance(j, dict):
        raise ValueError("unexpected NSE payload")
    records = j.get("records") if isinstance(j.get("records"), dict) else j
    rows_all = records.get("data") or []
    if not rows_all:
        raise ValueError("NSE returned an empty option chain (session likely rejected)")

    expiry = expiry_hint
    if expiry is None:
        expiries = records.get("expiryDates") or []
        expiry = _nearest_expiry(expiries) if expiries else None

    # Legacy payloads contain every expiry. Mixing them corrupts PCR / OI, so
    # keep only the chosen expiry.
    rows, filtered = rows_all, False
    if expiry:
        matching = [r for r in rows_all if _row_expiry(r) == expiry]
        if matching:
            rows, filtered = matching, True
        elif any(_row_expiry(r) for r in rows_all):
            raise ValueError(f"no rows for expiry {expiry}")

    underlying = records.get("underlyingValue") or j.get("underlyingValue")
    if underlying is None:
        for r in rows:
            u = (r.get("CE") or r.get("PE") or {}).get("underlyingValue")
            if u:
                underlying = u
                break

    parsed = []
    tot_ce = tot_pe = chg_ce = chg_pe = 0
    for r in rows:
        strike = r.get("strikePrice")
        ce, pe = r.get("CE"), r.get("PE")
        if strike is None or not (ce or pe):
            continue
        if ce:
            tot_ce += _num(ce.get("openInterest"))
            chg_ce += _num(ce.get("changeinOpenInterest"))
        if pe:
            tot_pe += _num(pe.get("openInterest"))
            chg_pe += _num(pe.get("changeinOpenInterest"))
        parsed.append({
            "strike": strike,
            "ce": {
                "ltp": ce.get("lastPrice") if ce else None,
                "oi": ce.get("openInterest") if ce else None,
                "chg_oi": ce.get("changeinOpenInterest") if ce else None,
                "iv": ce.get("impliedVolatility") if ce else None,
                "volume": ce.get("totalTradedVolume") if ce else None,
            },
            "pe": {
                "ltp": pe.get("lastPrice") if pe else None,
                "oi": pe.get("openInterest") if pe else None,
                "chg_oi": pe.get("changeinOpenInterest") if pe else None,
                "iv": pe.get("impliedVolatility") if pe else None,
                "volume": pe.get("totalTradedVolume") if pe else None,
            },
        })
    if not parsed:
        raise ValueError("option chain had no usable strikes")
    parsed.sort(key=lambda x: x["strike"])

    strikes = [p["strike"] for p in parsed]
    gaps = [b - a for a, b in zip(strikes, strikes[1:]) if b > a]
    step = min(gaps) if gaps else None

    atm = atm_iv = support = resistance = pcr_near = None
    window = parsed
    if underlying is not None:
        atm = min(strikes, key=lambda s: abs(s - underlying))
        if step:
            window = [p for p in parsed if abs(p["strike"] - atm) <= 10 * step] or parsed
        atm_row = next(p for p in parsed if p["strike"] == atm)
        ivs = [x for x in (atm_row["ce"]["iv"], atm_row["pe"]["iv"]) if isinstance(x, (int, float)) and x > 0]
        atm_iv = round(sum(ivs) / len(ivs), 2) if ivs else None

    ce_win = sum(_num(p["ce"]["oi"]) for p in window)
    pe_win = sum(_num(p["pe"]["oi"]) for p in window)
    pcr_near = round(pe_win / ce_win, 3) if ce_win else None
    if ce_win:
        resistance = max(window, key=lambda p: _num(p["ce"]["oi"]))["strike"]
    if pe_win:
        support = max(window, key=lambda p: _num(p["pe"]["oi"]))["strike"]

    # Max pain: strike where option writers' total payout is smallest.
    max_pain, best = None, None
    for k in strikes:
        pain = 0.0
        for p in parsed:
            pain += _num(p["ce"]["oi"]) * max(0.0, k - p["strike"])
            pain += _num(p["pe"]["oi"]) * max(0.0, p["strike"] - k)
        if best is None or pain < best:
            best, max_pain = pain, k

    return {
        "ok": True,
        "source": "NSE",
        "underlying": underlying,
        "expiry": expiry,
        "expiry_filtered": filtered,
        "total_ce_oi": tot_ce,
        "total_pe_oi": tot_pe,
        "ce_oi_change": chg_ce,
        "pe_oi_change": chg_pe,
        "pcr": (tot_pe / tot_ce) if tot_ce else None,
        "pcr_near_atm": pcr_near,
        "atm_strike": atm,
        "atm_iv": atm_iv,
        "support": support,
        "resistance": resistance,
        "max_pain": max_pain,
        "rows": window,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


async def _fetch_nse_json(symbol):
    """Prime a cookie session, then try the current v3 API, then the legacy one."""
    kwargs = dict(timeout=15, headers=NSE_HEADERS, follow_redirects=True)
    proxy = os.getenv("NSE_PROXY")  # optional, e.g. an Indian-IP proxy
    if proxy:
        kwargs["proxy"] = proxy

    errors = []
    async with httpx.AsyncClient(**kwargs) as c:
        try:  # NSE rejects API calls that carry no session cookies
            await c.get(NSE_BASE + "/option-chain", headers=NSE_PAGE_HEADERS)
        except Exception as e:
            errors.append("cookie priming: " + _short_err(e))

        # 1) current API: needs an explicit expiry
        try:
            ir = await c.get(NSE_BASE + "/api/option-chain-contract-info", params={"symbol": symbol})
            ir.raise_for_status()
            expiries = (ir.json() or {}).get("expiryDates") or []
            expiry = _nearest_expiry(expiries)
            if not expiry:
                raise ValueError("no expiry dates returned")
            r = await c.get(
                NSE_BASE + "/api/option-chain-v3",
                params={"type": "Indices", "symbol": symbol, "expiry": expiry},
            )
            r.raise_for_status()
            return r.json(), expiry, "NSE option-chain-v3"
        except Exception as e:
            errors.append("v3: " + _short_err(e))

        # 2) legacy API (may be retired -> 404)
        try:
            r = await c.get(NSE_BASE + "/api/option-chain-indices", params={"symbol": symbol})
            r.raise_for_status()
            return r.json(), None, "NSE option-chain-indices"
        except Exception as e:
            errors.append("legacy: " + _short_err(e))

    raise RuntimeError("; ".join(errors))


# --------------------------------------------------------------------------
# Optional: Dhan (DhanHQ v2) option chain - reliable from cloud hosts
# --------------------------------------------------------------------------
DHAN_BASE = "https://api.dhan.co/v2"
DHAN_UNDERLYING = {"NIFTY": 13, "BANKNIFTY": 25}  # IDX_I security ids


def _dhan_configured():
    return bool(os.getenv("DHAN_CLIENT_ID") and os.getenv("DHAN_ACCESS_TOKEN"))


def _nearest_iso_expiry(expiries):
    today = datetime.now(IST).date()
    dated = []
    for s in expiries:
        try:
            dated.append((datetime.strptime(str(s)[:10], "%Y-%m-%d").date(), str(s)[:10]))
        except Exception:
            continue
    dated.sort()
    for d, s in dated:
        if d >= today:
            return s
    return dated[0][1] if dated else None


def _dhan_to_records(j, expiry):
    """Convert a Dhan /optionchain payload into the NSE-style shape parse_chain reads."""
    data = j.get("data") if isinstance(j, dict) else None
    oc = (data or {}).get("oc") or {}
    if not oc:
        raise ValueError("Dhan returned an empty option chain")
    rows = []
    for key, v in oc.items():
        try:
            strike = float(key)
        except Exception:
            continue
        if strike == int(strike):
            strike = int(strike)

        def leg(x):
            if not isinstance(x, dict):
                return None
            oi = x.get("oi")
            prev = x.get("previous_oi")
            return {
                "openInterest": oi,
                "changeinOpenInterest": (oi - prev) if isinstance(oi, (int, float)) and isinstance(prev, (int, float)) else None,
                "impliedVolatility": x.get("implied_volatility"),
                "lastPrice": x.get("last_price"),
                "totalTradedVolume": x.get("volume"),
            }

        rows.append({"strikePrice": strike, "expiryDate": expiry, "CE": leg(v.get("ce")), "PE": leg(v.get("pe"))})
    return {"records": {"underlyingValue": data.get("last_price"), "expiryDates": [expiry], "data": rows}}


async def _fetch_dhan_json(symbol):
    headers = {
        "access-token": os.environ["DHAN_ACCESS_TOKEN"],
        "client-id": os.environ["DHAN_CLIENT_ID"],
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    scrip = DHAN_UNDERLYING[symbol]

    async def post(c, path, body):
        r = await c.post(DHAN_BASE + path, json=body)
        if r.status_code != 200:
            raise RuntimeError(f"Dhan HTTP {r.status_code} on {path}: {r.text[:120]}")
        j = r.json()
        if isinstance(j, dict) and j.get("status") not in (None, "success"):
            raise RuntimeError(f"Dhan error on {path}: {str(j)[:120]}")
        return j

    async with httpx.AsyncClient(timeout=15, headers=headers) as c:
        async def get_expiries():
            j = await post(c, "/optionchain/expirylist", {"UnderlyingScrip": scrip, "UnderlyingSeg": "IDX_I"})
            return {"expiries": j.get("data") or []}

        exp = await cached(f"dhanexp:{symbol}", 1800, get_expiries, max_stale=86400)
        expiry = _nearest_iso_expiry(exp["expiries"])
        if not expiry:
            raise RuntimeError("Dhan returned no expiry dates")
        j = await post(c, "/optionchain", {"UnderlyingScrip": scrip, "UnderlyingSeg": "IDX_I", "Expiry": expiry})
    return _dhan_to_records(j, expiry), expiry, "Dhan option chain"


_chain_fail = {}


async def get_nse_option_chain(symbol):
    fail = _chain_fail.get(symbol)
    if fail and time.monotonic() - fail[0] < CHAIN_FAIL_BACKOFF:
        raise RuntimeError(fail[1])

    async def fetch():
        errors = []
        if _dhan_configured():  # preferred: works from cloud hosts
            try:
                j, expiry, src = await _fetch_dhan_json(symbol)
                out = parse_chain(j, expiry)
                out["source"] = src
                return out
            except Exception as e:
                errors.append("Dhan: " + _short_err(e))
        try:
            j, expiry, src = await _fetch_nse_json(symbol)
            out = parse_chain(j, expiry)
            out["source"] = src
            return out
        except Exception as e:
            errors.append("NSE: " + _short_err(e))
        raise RuntimeError(" | ".join(errors))

    try:
        out = await cached(f"oc:{symbol}", CHAIN_TTL, fetch, max_stale=600)
        _chain_fail.pop(symbol, None)
        return out
    except Exception as e:
        msg = _short_err(e)
        if len(msg) > 220:
            msg = msg[:217] + "..."
        _chain_fail[symbol] = (time.monotonic(), msg)
        raise RuntimeError(msg)
