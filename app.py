import asyncio
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from indicators import calculate_indicators
from market_data import get_market_snapshot, get_nse_option_chain, session_info

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Option Intelligence Free", version="2.0.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

SYMBOL_RE = "^(NIFTY|BANKNIFTY)$"

# ---- decision-engine tuning -------------------------------------------------
MIN_SHARE = 0.70          # winning side must hold >= 70% of the AVAILABLE points
MIN_LEAD = 0.40           # ...and lead the other side by >= 40% of them
ADX_MIN = 18              # below this the market is treated as range-bound
NO_TRADE_BEFORE = 9 * 60 + 30    # IST minutes: skip the opening 15 min
NO_NEW_TRADE_AFTER = 15 * 60     # IST minutes: no fresh entries after 15:00
SL_ATR = 1.2
TARGET_ATR = 2.0


def _now():
    return datetime.now(timezone.utc).isoformat()


def _err(e):
    return f"{type(e).__name__}: {str(e)[:200]}"


@app.get("/")
async def home():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
async def health():
    return {"ok": True, "time": _now()}


@app.get("/api/market")
async def market(symbol: str = Query("NIFTY", pattern=SYMBOL_RE)):
    try:
        data = dict(await get_market_snapshot(symbol))
        data["session"] = session_info(data.get("last_data_ts"))
        return data
    except Exception as e:
        return {"ok": False, "symbol": symbol, "error": _err(e), "candles": [], "timestamp": _now()}


@app.get("/api/option-chain")
async def option_chain(symbol: str = Query("NIFTY", pattern=SYMBOL_RE)):
    try:
        return await get_nse_option_chain(symbol)
    except Exception as e:
        return {"ok": False, "symbol": symbol, "source": "NSE", "error": _err(e), "timestamp": _now()}


@app.get("/api/analysis")
async def analysis(symbol: str = Query("NIFTY", pattern=SYMBOL_RE)):
    market_res, chain_res = await asyncio.gather(
        get_market_snapshot(symbol),
        get_nse_option_chain(symbol),
        return_exceptions=True,
    )

    if isinstance(market_res, BaseException):
        return {
            "ok": False,
            "symbol": symbol,
            "market": {"ok": False, "symbol": symbol, "error": _err(market_res), "candles": []},
            "indicators": {"close": None},
            "option_chain": {"ok": False, "error": "Not evaluated because market data failed"},
            "decision": {
                "signal": "WAIT",
                "condition": "MARKET DATA UNAVAILABLE",
                "score": 0,
                "confidence": 0,
                "components": [],
                "reason": "Market data request failed. Check the data provider and server logs.",
            },
            "timestamp": _now(),
        }

    market_data = dict(market_res)
    market_data["session"] = session_info(market_data.get("last_data_ts"))

    if isinstance(chain_res, BaseException):
        chain = {"ok": False, "error": str(chain_res)[:220]}
    else:
        chain = chain_res

    ind = calculate_indicators(market_data.get("candles", []))
    decision = build_decision(market_data, ind, chain, market_data["session"])

    return {
        "ok": True,
        "symbol": symbol,
        "market": market_data,
        "indicators": ind,
        "option_chain": chain,
        "decision": decision,
        "timestamp": _now(),
    }


def build_decision(market, ind, chain, session):
    """Score trend/momentum factors and map them to CALL / PUT / WAIT.

    Scores are normalised against the factors that are actually AVAILABLE.
    (The old engine demanded 7 points but, without VWAP/volume/PCR, only 6 were
    obtainable - so it could never produce a BUY signal.)
    """
    close = ind.get("close")
    ema9, ema21 = ind.get("ema9"), ind.get("ema21")
    rsi_v, atr_v, adx_v = ind.get("rsi"), ind.get("atr"), ind.get("adx")
    plus_di, minus_di = ind.get("plus_di"), ind.get("minus_di")
    vwap, vol_ratio = ind.get("vwap"), ind.get("volume_ratio")

    required = {"close": close, "EMA9": ema9, "EMA21": ema21, "RSI": rsi_v, "ATR": atr_v, "ADX": adx_v}
    missing = [k for k, v in required.items() if v is None]
    if missing:
        return {
            "signal": "WAIT",
            "condition": "DATA INCOMPLETE",
            "score": 0,
            "confidence": 0,
            "components": [],
            "reason": "Waiting for sufficient candle history. Missing: " + ", ".join(missing),
        }

    comps = []

    def add(name, side, weight, note, points=None):
        if points is None:
            points = 0 if side == "neutral" else weight
        comps.append({"name": name, "side": side, "weight": weight, "points": points, "note": note})

    # 1) price vs fast EMA
    add("Price vs EMA 9", "bull" if close > ema9 else "bear" if close < ema9 else "neutral", 1,
        f"{close:.2f} vs {ema9:.2f}")
    # 2) EMA stack
    add("EMA 9 vs EMA 21", "bull" if ema9 > ema21 else "bear" if ema9 < ema21 else "neutral", 2,
        f"{ema9:.2f} vs {ema21:.2f}")
    # 3) VWAP (only when the feed has real volume)
    if vwap is not None:
        add("Price vs VWAP", "bull" if close > vwap else "bear" if close < vwap else "neutral", 2,
            f"{close:.2f} vs {vwap:.2f}")
    # 4) RSI, graded so a 0.1 move does not flip the whole score
    if rsi_v > 75:
        side, pts, note = "bull", 1, "overbought - chase risk"
    elif rsi_v >= 60:
        side, pts, note = "bull", 2, "strong momentum"
    elif rsi_v > 55:
        side, pts, note = "bull", 1, "mild bullish momentum"
    elif rsi_v >= 45:
        side, pts, note = "neutral", 0, "neutral zone"
    elif rsi_v >= 40:
        side, pts, note = "bear", 1, "mild bearish momentum"
    elif rsi_v >= 25:
        side, pts, note = "bear", 2, "strong bearish momentum"
    else:
        side, pts, note = "bear", 1, "oversold - bounce risk"
    add("RSI 14", side, 2, f"{rsi_v:.1f} - {note}", pts)
    # 5) trend strength + direction via +DI / -DI
    if adx_v >= 20 and plus_di is not None and minus_di is not None:
        add("ADX trend direction", "bull" if plus_di > minus_di else "bear", 1,
            f"ADX {adx_v:.1f}, +DI {plus_di:.1f} / -DI {minus_di:.1f}")
    else:
        add("ADX trend direction", "neutral", 1, f"ADX {adx_v:.1f} (<20, no clear trend)")
    # 6) volume confirmation
    if vol_ratio is not None:
        if vol_ratio >= 1.15:
            add("Volume confirmation", "bull" if close > ema9 else "bear", 1, f"{vol_ratio:.2f}x average")
        else:
            add("Volume confirmation", "neutral", 1, f"{vol_ratio:.2f}x average")
    # 7) PCR
    pcr = chain.get("pcr") if isinstance(chain, dict) else None
    if isinstance(pcr, (int, float)):
        if pcr > 1.05:
            add("PCR (OI)", "bull", 1, f"{pcr:.2f} (> 1.05)")
        elif pcr < 0.80:
            add("PCR (OI)", "bear", 1, f"{pcr:.2f} (< 0.80)")
        else:
            add("PCR (OI)", "neutral", 1, f"{pcr:.2f}")

    max_pts = sum(c["weight"] for c in comps)
    bull = sum(c["points"] for c in comps if c["side"] == "bull")
    bear = sum(c["points"] for c in comps if c["side"] == "bear")
    dominant = max(bull, bear)

    if bull / max_pts >= MIN_SHARE and (bull - bear) / max_pts >= MIN_LEAD:
        raw_signal, condition, bias = "BUY CALL", "BULLISH", "BULLISH"
    elif bear / max_pts >= MIN_SHARE and (bear - bull) / max_pts >= MIN_LEAD:
        raw_signal, condition, bias = "BUY PUT", "BEARISH", "BEARISH"
    else:
        raw_signal, condition = "WAIT", "SIDEWAYS / MIXED"
        bias = "BULLISH" if bull > bear else "BEARISH" if bear > bull else "NEUTRAL"

    signal = raw_signal
    confidence = round(100 * dominant / max_pts)
    warnings = []

    if adx_v < ADX_MIN:
        signal, condition = "WAIT", "LOW TREND STRENGTH"
        confidence = min(confidence, 55)
        warnings.append(f"ADX {adx_v:.1f} is below {ADX_MIN}: range-bound market.")

    status = session.get("status")
    minutes = session.get("ist_minutes")
    if status == "CLOSED":
        signal, condition = "WAIT", "MARKET CLOSED"
        warnings.append("Market is closed - scores are informational and based on the last session.")
    elif status == "STALE":
        signal, condition = "WAIT", "STALE DATA"
        warnings.append("Latest candle is old - the feed may be delayed or today may be a holiday.")
    elif minutes is not None and minutes < NO_TRADE_BEFORE:
        signal, condition = "WAIT", "NO-TRADE WINDOW (OPENING)"
        warnings.append("First 15 minutes after the open are skipped - spreads and noise are highest.")
    elif minutes is not None and minutes >= NO_NEW_TRADE_AFTER:
        signal, condition = "WAIT", "NO-TRADE WINDOW (CLOSING)"
        warnings.append("No fresh option-buying entries after 15:00 IST - theta and closing noise.")

    # Sanity notes (do not change the score)
    if isinstance(chain, dict) and chain.get("ok"):
        res, sup = chain.get("resistance"), chain.get("support")
        if signal == "BUY CALL" and isinstance(res, (int, float)) and 0 <= res - close <= atr_v * 1.5:
            warnings.append(f"Heavy call-OI resistance at {res:g} is within 1.5 ATR of price.")
        if signal == "BUY PUT" and isinstance(sup, (int, float)) and 0 <= close - sup <= atr_v * 1.5:
            warnings.append(f"Heavy put-OI support at {sup:g} is within 1.5 ATR of price.")

    unavailable = []
    if vwap is None:
        unavailable.append("VWAP")
    if vol_ratio is None:
        unavailable.append("volume")
    if not isinstance(pcr, (int, float)):
        unavailable.append("PCR/OI")

    reason = (
        f"Bull {bull} / Bear {bear} out of {max_pts} available points "
        f"({round(100 * dominant / max_pts)}% alignment). "
        f"A signal needs >= {round(MIN_SHARE * 100)}% alignment and a >= {round(MIN_LEAD * 100)}% lead. "
        + (f"Unavailable (excluded): {', '.join(unavailable)}. " if unavailable else "")
        + " ".join(warnings)
    ).strip()

    is_call, is_put = signal == "BUY CALL", signal == "BUY PUT"
    return {
        "signal": signal,
        "raw_signal": raw_signal,
        "condition": condition,
        "bias": bias,
        "bull_score": bull,
        "bear_score": bear,
        "max_score": max_pts,
        "score": dominant,
        "confidence": confidence,
        "components": comps,
        "warnings": warnings,
        "reason": reason,
        "entry": close,
        "atr": atr_v,
        "suggested_sl": round(close - atr_v * SL_ATR, 2) if is_call else round(close + atr_v * SL_ATR, 2) if is_put else None,
        "suggested_target": round(close + atr_v * TARGET_ATR, 2) if is_call else round(close - atr_v * TARGET_ATR, 2) if is_put else None,
    }


# Paper trading is intentionally client-side so no broker account is required.
