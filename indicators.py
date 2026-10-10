"""Pure-Python technical indicators for Option Intelligence Free."""
from datetime import datetime, timedelta, timezone

# India has no daylight-saving time, so a fixed offset is exact (and avoids a
# dependency on system tz data, which slim cloud images may not ship).
IST = timezone(timedelta(hours=5, minutes=30))


def ist_date(ts):
    return datetime.fromtimestamp(ts, tz=IST).date()


def ema(values, period):
    if period <= 0 or len(values) < period:
        return None
    k = 2 / (period + 1)
    e = sum(values[:period]) / period
    for x in values[period:]:
        e = x * k + e * (1 - k)
    return e


def sma(values, period):
    if period <= 0 or len(values) < period:
        return None
    return sum(values[-period:]) / period


def rsi(values, period=14):
    """Wilder RSI."""
    if len(values) < period + 1:
        return None
    gains, losses = [], []
    for i in range(1, len(values)):
        d = values[i] - values[i - 1]
        gains.append(max(d, 0.0))
        losses.append(max(-d, 0.0))
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
    if avg_loss == 0:
        return 50.0 if avg_gain == 0 else 100.0
    rs = avg_gain / avg_loss
    return 100 - 100 / (1 + rs)


def _true_ranges(high, low, close):
    return [
        max(high[i] - low[i], abs(high[i] - close[i - 1]), abs(low[i] - close[i - 1]))
        for i in range(1, len(close))
    ]


def atr(high, low, close, period=14):
    """Wilder ATR (smoothed), not a plain average of the last N true ranges."""
    if len(close) < period + 1:
        return None
    tr = _true_ranges(high, low, close)
    a = sum(tr[:period]) / period
    for x in tr[period:]:
        a = (a * (period - 1) + x) / period
    return a


def adx(high, low, close, period=14):
    """Wilder ADX. Returns (adx, +DI, -DI) or (None, None, None)."""
    n = len(close)
    if n < period * 2 + 1:
        return None, None, None
    tr = _true_ranges(high, low, close)
    pdm, mdm = [], []
    for i in range(1, n):
        up = high[i] - high[i - 1]
        dn = low[i - 1] - low[i]
        pdm.append(up if (up > dn and up > 0) else 0.0)
        mdm.append(dn if (dn > up and dn > 0) else 0.0)

    tr_s = sum(tr[:period])
    p_s = sum(pdm[:period])
    m_s = sum(mdm[:period])

    def di_dx(tr_sum, p_sum, m_sum):
        if tr_sum == 0:
            return 0.0, 0.0, 0.0
        pdi = 100 * p_sum / tr_sum
        mdi = 100 * m_sum / tr_sum
        s = pdi + mdi
        dx = 0.0 if s == 0 else 100 * abs(pdi - mdi) / s
        return pdi, mdi, dx

    pdi, mdi, dx = di_dx(tr_s, p_s, m_s)
    dxs = [dx]
    for i in range(period, len(tr)):
        tr_s = tr_s - tr_s / period + tr[i]
        p_s = p_s - p_s / period + pdm[i]
        m_s = m_s - m_s / period + mdm[i]
        pdi, mdi, dx = di_dx(tr_s, p_s, m_s)
        dxs.append(dx)

    if len(dxs) < period:
        return None, None, None
    a = sum(dxs[:period]) / period
    for dx in dxs[period:]:
        a = (a * (period - 1) + dx) / period
    return a, pdi, mdi


def calculate_indicators(candles):
    if not candles:
        return {"close": None}

    h = [x["high"] for x in candles]
    l = [x["low"] for x in candles]
    c = [x["close"] for x in candles]
    v = [x["volume"] for x in candles]

    # --- session split (IST trading day of the newest candle) -------------
    day = ist_date(candles[-1]["time"])
    session = [x for x in candles if ist_date(x["time"]) == day]
    previous = [x for x in candles if ist_date(x["time"]) < day]
    prev_close = previous[-1]["close"] if previous else None

    # --- VWAP: resets every session; unavailable when volume is all zero ---
    usable_volume = sum(x["volume"] for x in session) > 0
    vwap = None
    if usable_volume:
        pv = sum(((x["high"] + x["low"] + x["close"]) / 3) * x["volume"] for x in session)
        vv = sum(x["volume"] for x in session)
        vwap = pv / vv if vv else None

    # --- volume ratio: last COMPLETED candle vs the 20 before it ----------
    volume_ratio = avg_vol = last_done_vol = None
    if usable_volume and len(v) >= 22:
        last_done_vol = v[-2]
        avg_vol = sma(v[:-2], 20)
        if avg_vol and avg_vol > 0:
            volume_ratio = last_done_vol / avg_vol

    adx_v, plus_di, minus_di = adx(h, l, c, 14)

    return {
        "close": c[-1],
        "ema9": ema(c, 9),
        "ema21": ema(c, 21),
        "rsi": rsi(c, 14),
        "atr": atr(h, l, c, 14),
        "adx": adx_v,
        "plus_di": plus_di,
        "minus_di": minus_di,
        "vwap": vwap,
        "vwap_available": vwap is not None,
        "volume": last_done_vol,
        "volume_avg20": avg_vol,
        "volume_ratio": volume_ratio,
        "day_open": session[0]["open"],
        "day_high": max(x["high"] for x in session),
        "day_low": min(x["low"] for x in session),
        "prev_close": prev_close,
        "last_candle_time": candles[-1]["time"],
    }
