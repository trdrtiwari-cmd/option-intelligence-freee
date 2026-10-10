"use strict";

const STORE_KEY = "oi_paper_v3";
const LEGACY_KEY = "oi_paper_v2";
const SYMBOL_KEY = "oi_symbol";
const POLL_MS = 30000;
const CANDLE_SECONDS = 300;
const MAX_TRADES = 200;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, ch => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
));
const fmt = x => (x == null || x === "" || Number.isNaN(Number(x)))
  ? "--"
  : Number(x).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const money = x => {
  const v = Number(x || 0);
  return (v < 0 ? "-" : "") + "₹" + Math.abs(v).toLocaleString("en-IN", { maximumFractionDigits: 2 });
};

function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage disabled */ } }

function setText(id, v) {
  const el = $(id);
  if (el) el.textContent = (v == null || v === "") ? "--" : v;
}

function num(id) {
  const el = $(id);
  if (!el || String(el.value).trim() === "") return null;
  const v = Number(el.value);
  return Number.isFinite(v) ? v : null;
}

/* ------------------------------------------------------------------ state */
let symbol = safeGet(SYMBOL_KEY) === "BANKNIFTY" ? "BANKNIFTY" : "NIFTY";
let state = { analysis: null };
let controller = null;

function defaultPaper() {
  return { capital: 100000, realized: 0, open: null, trades: [] };
}

function loadPaper() {
  try {
    const raw = safeGet(STORE_KEY) || safeGet(LEGACY_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === "object") {
        return {
          capital: Number.isFinite(p.capital) ? p.capital : 100000,
          realized: Number.isFinite(p.realized) ? p.realized : 0,
          open: p.open && typeof p.open === "object" ? p.open : null,
          trades: Array.isArray(p.trades) ? p.trades : [],
        };
      }
    }
  } catch (e) { console.warn("Could not read saved paper account", e); }
  return defaultPaper();
}

let paper = loadPaper();

function savePaper() {
  if (paper.trades.length > MAX_TRADES) paper.trades.length = MAX_TRADES;
  safeSet(STORE_KEY, JSON.stringify(paper));
  renderPaper();
}

/* ---------------------------------------------------------------- loading */
async function load() {
  if (controller) controller.abort();
  controller = new AbortController();
  const mine = controller;
  const requested = symbol;
  setText("status", "LOADING " + requested + "...");

  try {
    const r = await fetch("/api/analysis?symbol=" + requested, { cache: "no-store", signal: mine.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    if (requested !== symbol) return; // user switched index while this was in flight

    state.analysis = j;
    render(j);
    const t = new Date().toLocaleTimeString("en-IN");
    setText("status", j.market?.ok ? "UPDATED " + t : "DATA SOURCE ERROR (" + t + ")");
    await monitorOpenTrade();
  } catch (e) {
    if (e.name === "AbortError") return;
    console.error(e);
    setText("status", "CONNECTION ERROR");
    const b = $("banner");
    b.hidden = false;
    b.innerHTML = "<div>Cannot reach the server. If it is on Render's free plan it may be waking up (~30-60 s) - it will retry automatically.</div>";
  }
}

function renderBanner(j) {
  const m = j.market || {};
  const s = m.session || {};
  const msgs = [];
  if (j.ok === false || m.ok === false) {
    msgs.push("Market data unavailable: " + (m.error || j.error || "unknown error"));
  }
  if (s.status === "CLOSED") {
    msgs.push("Market is closed (" + (s.ist_time || "") + "). Showing the last available data - signals are informational only.");
  } else if (s.status === "STALE") {
    const mins = s.data_age_s != null ? Math.round(s.data_age_s / 60) : "?";
    msgs.push("Data looks stale (newest update ~" + mins + " min old). The feed may be delayed or today may be a market holiday.");
  }
  if (m.served_from_cache) {
    msgs.push("Live refresh failed; showing cached market data from " + (m.cache_age_s ?? "?") + " s ago.");
  }
  const b = $("banner");
  b.hidden = msgs.length === 0;
  b.innerHTML = msgs.map(x => "<div>" + esc(x) + "</div>").join("");
}

function render(j) {
  const m = j.market || {};
  const i = j.indicators || {};
  const c = j.option_chain || {};
  const d = j.decision || {};
  const s = m.session || {};

  renderBanner(j);

  const price = m.last ?? i.close;
  setText("price", fmt(price));
  const chg = $("change");
  if (price != null && i.prev_close != null && i.prev_close !== 0) {
    const diff = price - i.prev_close;
    const pct = diff / i.prev_close * 100;
    chg.textContent = (diff >= 0 ? "+" : "") + fmt(diff) + " (" + (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%) vs prev close";
    chg.className = "chg " + (diff >= 0 ? "pos" : "neg");
  } else {
    chg.textContent = "--";
    chg.className = "chg";
  }
  setText("marketSource", m.source || "--");
  setText("candleCount", (m.candles || []).length || "--");
  const sess = $("session");
  sess.textContent = s.status || "--";
  sess.className = "pill " + (s.status === "OPEN" ? "pos" : s.status ? "neg" : "");
  setText("dayRange", i.day_low != null ? fmt(i.day_low) + " – " + fmt(i.day_high) : "--");

  setText("ema9", fmt(i.ema9));
  setText("ema21", fmt(i.ema21));
  setText("vwap", i.vwap == null ? "n/a (no index volume)" : fmt(i.vwap));
  setText("rsi", fmt(i.rsi));
  setText("atr", fmt(i.atr));
  setText("adx", fmt(i.adx));
  setText("di", i.plus_di == null ? "--" : fmt(i.plus_di) + " / " + fmt(i.minus_di));
  setText("volratio", i.volume_ratio == null ? "n/a" : fmt(i.volume_ratio) + "x");

  setText("pcr", c.pcr == null ? "--" : Number(c.pcr).toFixed(2));
  setText("pcrnear", c.pcr_near_atm == null ? "--" : Number(c.pcr_near_atm).toFixed(2));
  setText("oi", c.ok ? fmt(c.total_ce_oi) + " / " + fmt(c.total_pe_oi) : "--");
  setText("walls", c.ok ? fmt(c.resistance) + " / " + fmt(c.support) : "--");
  setText("painiv", c.ok ? fmt(c.max_pain) + " / " + (c.atm_iv == null ? "--" : c.atm_iv + "%") : "--");
  setText("expiry", c.expiry || "--");

  let src;
  if (c.ok) {
    src = (c.source || "NSE") + (c.served_from_cache ? " (cached " + c.cache_age_s + " s ago)" : "");
  } else {
    const err = String(c.error || "NSE may block cloud requests");
    src = "NSE unavailable: " + (err.length > 200 ? err.slice(0, 197) + "..." : err);
  }
  setText("oiSource", src);

  setText("condition", d.condition || "WAIT");
  const sig = $("signal");
  sig.textContent = d.signal || "WAIT";
  sig.className = "signal " + (d.signal === "BUY CALL" ? "call" : d.signal === "BUY PUT" ? "put" : "wait");
  setText("confidence", (d.confidence || 0) + "% signal strength" + (d.bias && d.signal === "WAIT" ? " (" + d.bias.toLowerCase() + " lean)" : ""));

  setText("bull", d.bull_score ?? 0);
  setText("bear", d.bear_score ?? 0);
  setText("entry", fmt(d.entry));
  setText("sl", fmt(d.suggested_sl));
  setText("target", fmt(d.suggested_target));
  setText("reason", d.reason || "Waiting...");

  $("breakdown").innerHTML = (d.components || []).map(k =>
    `<li class="${esc(k.side)}"><span>${esc(k.name)}</span>` +
    `<em>${esc(k.points)}/${esc(k.weight)} ${k.side === "neutral" ? "·" : k.side === "bull" ? "▲" : "▼"}</em>` +
    `<small>${esc(k.note)}</small></li>`
  ).join("");

  const me = $("manualEntry");
  if (!me.value && price != null) me.placeholder = "Auto: " + fmt(price);

  renderPaper();
}

/* ---------------------------------------------------------- paper trading */
function currentPriceFor(sym) {
  const a = state.analysis;
  if (!a || a.symbol !== sym) return null;
  return a.market?.last ?? a.indicators?.close ?? null;
}

function openPaper(type) {
  if (paper.open) { alert("Close the existing paper trade first."); return; }

  const a = state.analysis;
  if (!a || a.symbol !== symbol) { alert("Data for " + symbol + " is still loading. Try again in a moment."); return; }

  const current = currentPriceFor(symbol);
  const manual = num("manualEntry");
  const entry = manual ?? current;
  const trigger = num("manualTrigger");
  const sl = num("manualSL");
  const target = num("manualTarget");
  const units = num("manualUnits") ?? 1;

  if (entry == null) { alert("Current index price is unavailable. Enter the entry price manually."); return; }
  if (trigger == null || sl == null || target == null) {
    alert("Enter a stop-loss trigger, stop-loss price, and target before opening a paper trade.");
    return;
  }
  if (units <= 0) { alert("Units / multiplier must be greater than zero."); return; }

  if (type === "CALL" && !(target > entry && trigger < entry && sl <= trigger)) {
    alert("For CALL: Target must be above entry; trigger below entry; stop-loss price at or below trigger.");
    return;
  }
  if (type === "PUT" && !(target < entry && trigger > entry && sl >= trigger)) {
    alert("For PUT: Target must be below entry; trigger above entry; stop-loss price at or above trigger.");
    return;
  }

  const status = a.market?.session?.status;
  if (status && status !== "OPEN" &&
      !confirm("The market is " + status + ". The trade will be evaluated against stale prices until the market reopens. Continue?")) return;
  if (manual != null && current != null && Math.abs(manual - current) / current > 0.005 &&
      !confirm("Your entry (" + fmt(manual) + ") is more than 0.5% away from the current price (" + fmt(current) + "). Continue?")) return;

  paper.open = {
    type, entry, trigger, sl, target, units, symbol,
    time: new Date().toLocaleString("en-IN"),
    entryTs: Math.floor(Date.now() / 1000),
    entrySource: manual != null ? "MANUAL" : "CURRENT INDEX",
  };
  savePaper();
  monitorOpenTrade();
}

function closePaper(exitPrice = null, status = "MANUAL CLOSE") {
  if (!paper.open) return;
  const t = paper.open;

  let price = exitPrice;
  if (price == null) {
    price = currentPriceFor(t.symbol);
    if (price == null) {
      alert("Current " + t.symbol + " price is unavailable. Switch to " + t.symbol + " and retry once data loads.");
      return;
    }
  }

  const dir = t.type === "CALL" ? 1 : -1;
  const pnl = (price - t.entry) * dir * t.units;
  paper.realized += pnl;
  paper.capital += pnl;
  paper.trades.unshift({
    time: t.time, type: t.type, symbol: t.symbol, entry: t.entry, trigger: t.trigger,
    sl: t.sl, target: t.target, exit: price, pnl, status,
  });
  paper.open = null;
  savePaper();
}

/* Did a price range [lo, hi] hit the stop or target? Stop wins ties (conservative).
   Stop fill: at the stop-loss price if the range reached it, otherwise at the
   worst price seen inside the trigger..stop-loss band. Target fills at target. */
function checkTrade(t, hi, lo) {
  if (t.type === "CALL") {
    if (lo <= t.trigger) return { price: lo <= t.sl ? t.sl : lo, status: "STOP-LOSS TRIGGERED" };
    if (hi >= t.target) return { price: t.target, status: "TARGET HIT" };
  } else {
    if (hi >= t.trigger) return { price: hi >= t.sl ? t.sl : hi, status: "STOP-LOSS TRIGGERED" };
    if (lo <= t.target) return { price: t.target, status: "TARGET HIT" };
  }
  return null;
}

function evaluateExit(m) {
  const t = paper.open;
  if (!t || !m || m.symbol !== t.symbol) return;

  // Only candles that START after the entry candle; the live price below covers the rest.
  const entryTs = t.entryTs || Math.floor(Date.now() / 1000);
  const firstFull = Math.floor(entryTs / CANDLE_SECONDS) * CANDLE_SECONDS + CANDLE_SECONDS;

  for (const c of (m.candles || [])) {
    if (c.time < firstFull) continue;
    const r = checkTrade(t, c.high, c.low);
    if (r) { closePaper(r.price, r.status); return; }
  }
  if (m.last != null) {
    const r = checkTrade(t, m.last, m.last);
    if (r) closePaper(r.price, r.status);
  }
}

/* The open trade may belong to the index that is NOT on screen - fetch it too. */
async function monitorOpenTrade() {
  const t = paper.open;
  if (!t) return;
  let m = null;
  if (state.analysis && state.analysis.symbol === t.symbol) {
    m = state.analysis.market;
  } else {
    try {
      const r = await fetch("/api/market?symbol=" + encodeURIComponent(t.symbol), { cache: "no-store" });
      m = await r.json();
    } catch (e) { console.warn("Could not monitor " + t.symbol, e); }
  }
  if (m && m.ok) evaluateExit(m);
}

function renderPaper() {
  setText("capital", money(paper.capital));
  const pnl = $("pnl");
  pnl.textContent = money(paper.realized);
  pnl.className = paper.realized > 0 ? "pos" : paper.realized < 0 ? "neg" : "";

  const wins = paper.trades.filter(t => t.pnl > 0).length;
  const rate = paper.trades.length ? Math.round(wins / paper.trades.length * 100) + "%" : "--";
  setText("tradeCount", paper.trades.length + " / " + rate);

  if (paper.open) {
    const t = paper.open;
    const px = currentPriceFor(t.symbol);
    const un = px == null ? null : (px - t.entry) * (t.type === "CALL" ? 1 : -1) * t.units;
    setText("openTrade",
      `${t.symbol} ${t.type} @ ${fmt(t.entry)} | Trigger ${fmt(t.trigger)} | SL ${fmt(t.sl)} | Target ${fmt(t.target)}` +
      (un == null ? "" : ` | Unrealized ${money(un)}`));
  } else {
    setText("openTrade", "None");
  }

  const body = $("tradeRows");
  if (!body) return;
  body.innerHTML = paper.trades.map(t =>
    `<tr>
      <td>${esc(t.time)}</td>
      <td>${esc(t.symbol || "")} ${esc(t.type)}</td>
      <td>${fmt(t.entry)}</td>
      <td>${fmt(t.trigger)}</td>
      <td>${fmt(t.sl)}</td>
      <td>${fmt(t.target)}</td>
      <td>${fmt(t.exit)}</td>
      <td class="${t.pnl > 0 ? "pos" : t.pnl < 0 ? "neg" : ""}">${money(t.pnl)}</td>
      <td>${esc(t.status)}</td>
    </tr>`
  ).join("");
}

/* --------------------------------------------------------------- controls */
function setSymbol(s) {
  if (s === symbol) return;
  symbol = s;
  safeSet(SYMBOL_KEY, s);
  state.analysis = null;
  syncSymbolButtons();
  render({});
  setText("condition", "LOADING...");
  load();
}

function syncSymbolButtons() {
  $("nifty").classList.toggle("active", symbol === "NIFTY");
  $("bank").classList.toggle("active", symbol === "BANKNIFTY");
}

$("nifty").onclick = () => setSymbol("NIFTY");
$("bank").onclick = () => setSymbol("BANKNIFTY");
$("refresh").onclick = load;
$("callTrade").onclick = () => openPaper("CALL");
$("putTrade").onclick = () => openPaper("PUT");
$("closeTrade").onclick = () => closePaper(null, "MANUAL CLOSE");
$("resetPaper").onclick = () => {
  if (confirm("Reset the paper account to ₹1,00,000 and delete all trades?")) {
    paper = defaultPaper();
    savePaper();
  }
};

syncSymbolButtons();
renderPaper();
load();
setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
