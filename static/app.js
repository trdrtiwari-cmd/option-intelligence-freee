"use strict";

const STORE_KEY = "oi_paper_v4";
const OLD_KEYS = ["oi_paper_v3", "oi_paper_v2"];
const SYMBOL_KEY = "oi_symbol";
const POLL_MS = 30000;
const QUOTE_POLL_MS = 10000;
const MAX_TRADES = 200;
const DEFAULT_LOT = { NIFTY: 65, BANKNIFTY: 30 }; // Jan-2026 NSE lot sizes - verify, they are reviewed periodically

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
const r05 = x => (Math.round(x / 0.05) * 0.05).toFixed(2);

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
let state = { analysis: null, quote: null };
let controller = null;
let selType = "CE";
let selStrike = null;
let legacyDropped = false;

function defaultPaper() {
  return { capital: 100000, realized: 0, open: null, trades: [] };
}

function normTrade(t) {
  if (t.instrument) return t;
  // trade saved by the older index-based version
  return {
    time: t.time, instrument: `${t.symbol || ""} ${t.type || ""} (index)`, qty: t.units,
    entry: t.entry, sl: t.sl ?? t.trigger, trail: "--", target: t.target, exit: t.exit, pnl: t.pnl, status: t.status,
  };
}

function loadPaper() {
  try {
    const raw = [STORE_KEY, ...OLD_KEYS].map(safeGet).find(Boolean);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === "object") {
        let open = p.open && p.open.optType ? p.open : null;
        if (open && open.trail === undefined) { // saved before trailing stops existed
          open.sl = open.trigger ?? open.sl;
          open.trailMode = null;
          open.trailVal = null;
          open.trail = "off";
        }
        if (p.open && !open) legacyDropped = true;
        return {
          capital: Number.isFinite(p.capital) ? p.capital : 100000,
          realized: Number.isFinite(p.realized) ? p.realized : 0,
          open,
          trades: (Array.isArray(p.trades) ? p.trades : []).map(normTrade),
        };
      }
    }
  } catch (e) { console.warn("Could not read saved paper account", e); }
  return defaultPaper();
}

let paper = loadPaper();

function persist() {
  if (paper.trades.length > MAX_TRADES) paper.trades.length = MAX_TRADES;
  safeSet(STORE_KEY, JSON.stringify(paper));
}

function savePaper() {
  persist();
  renderPaper();
}

function getLot(sym) {
  const v = Number(safeGet("oi_lot_" + sym));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_LOT[sym];
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
    pollQuote();
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
  setText("marketSource", (m.source || "--") + (m.volume_source ? " + " + m.volume_source + " volume (proxy)" : ""));
  setText("candleCount", (m.candles || []).length || "--");
  const sess = $("session");
  sess.textContent = s.status || "--";
  sess.className = "pill " + (s.status === "OPEN" ? "pos" : s.status ? "neg" : "");
  setText("dayRange", i.day_low != null ? fmt(i.day_low) + " – " + fmt(i.day_high) : "--");

  setText("ema9", fmt(i.ema9));
  setText("ema21", fmt(i.ema21));
  setText("vwap", i.vwap == null ? "n/a (no volume feed)" : fmt(i.vwap) + (m.volume_proxy ? " (ETF vol)" : ""));
  setText("rsi", fmt(i.rsi));
  setText("atr", fmt(i.atr));
  setText("adx", fmt(i.adx));
  setText("di", i.plus_di == null ? "--" : fmt(i.plus_di) + " / " + fmt(i.minus_di));
  setText("volratio", i.volume_ratio == null ? "n/a" : fmt(i.volume_ratio) + "x" + (m.volume_proxy ? " (ETF)" : ""));

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

  renderChain(c);
  renderPaper();
}

/* ---------------------------------------------------- option chain / picker */
function chainOf() {
  const c = state.analysis && state.analysis.symbol === symbol ? state.analysis.option_chain : null;
  return c && c.ok && Array.isArray(c.rows) && c.rows.length ? c : null;
}

function legFromChain(strike, type) {
  const c = chainOf();
  const row = c && c.rows.find(r => r.strike === strike);
  return row ? (type === "CE" ? row.ce : row.pe) : null;
}

function selectContract(type, strike) {
  selType = type;
  selStrike = strike;
  $("selType").value = type;
  renderChain(state.analysis?.option_chain || {});
  renderSelInfo();
}

function renderChain(c) {
  const body = $("chainRows");
  const ok = c && c.ok && Array.isArray(c.rows) && c.rows.length;
  if (!ok) {
    body.innerHTML = '<tr><td colspan="5" class="muted">Option chain unavailable - live premiums cannot be tracked until it loads (see the Option Intelligence card for the reason).</td></tr>';
    setText("chainMeta", "");
    $("selStrike").innerHTML = '<option value="">Chain unavailable</option>';
    renderSelInfo();
    return;
  }

  const atm = c.atm_strike;
  if (selStrike == null) selStrike = atm ?? c.rows[Math.floor(c.rows.length / 2)].strike;

  const idx = Math.max(0, c.rows.findIndex(r => r.strike === atm));
  const near = c.rows.slice(Math.max(0, idx - 6), idx + 7);
  const cell = (r, t) => {
    const leg = t === "CE" ? r.ce : r.pe;
    const sel = selType === t && selStrike === r.strike ? " sel" : "";
    return `<td class="pick${sel}" data-type="${t}" data-strike="${r.strike}">${fmt(leg.ltp)}</td>`;
  };
  body.innerHTML = near.map(r =>
    `<tr class="${r.strike === atm ? "atm" : ""}"><td>${fmt(r.ce.oi)}</td>${cell(r, "CE")}` +
    `<td><b>${fmt(r.strike)}</b></td>${cell(r, "PE")}<td>${fmt(r.pe.oi)}</td></tr>`
  ).join("");
  setText("chainMeta", `${symbol} · expiry ${c.expiry || "--"} · spot ${fmt(c.underlying)} · ${c.source || ""}`);

  // strike dropdown (keep the current choice even if it scrolled out of the window)
  const strikes = c.rows.map(r => r.strike);
  if (!strikes.includes(selStrike)) strikes.push(selStrike);
  strikes.sort((a, b) => a - b);
  $("selStrike").innerHTML = strikes.map(k =>
    `<option value="${k}">${fmt(k)}${k === atm ? " (ATM)" : ""}</option>`).join("");
  $("selStrike").value = String(selStrike);
  renderSelInfo();
}

function renderSelInfo() {
  const el = $("selInfo");
  const leg = selStrike != null ? legFromChain(selStrike, selType) : null;
  if (!leg) { el.textContent = "Select a strike from the chain (live premiums need the option chain to load)."; return; }
  const lots = num("lots") ?? 1;
  const lot = num("lotSize") ?? getLot(symbol);
  const qty = lots * lot;
  const ltp = leg.ltp;
  el.textContent = ltp
    ? `${symbol} ${fmt(selStrike)} ${selType} · live premium ${money(ltp)} · qty ${qty} · cost ${money(ltp * qty)}` +
      (leg.iv ? ` · IV ${leg.iv}%` : "") + (leg.oi ? ` · OI ${fmt(leg.oi)}` : "")
    : `${symbol} ${fmt(selStrike)} ${selType} has no traded price yet - pick a more liquid strike.`;
}

/* ---------------------------------------------------------- paper trading */
function clientIstMinutes() {
  const now = new Date();
  const ist = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 330 * 60000);
  return { minutes: ist.getHours() * 60 + ist.getMinutes(), day: ist.getDay() };
}

function openPaper() {
  if (paper.open) { alert("Close the existing paper trade first."); return; }

  const a = state.analysis;
  const c = chainOf();
  if (!a || a.symbol !== symbol) { alert("Data for " + symbol + " is still loading. Try again in a moment."); return; }
  if (!c) {
    alert("The option chain is not loading, so live option premiums cannot be tracked. " +
          "Fix the data source first (see the Option Intelligence card; Dhan keys on Render are the reliable fix).");
    return;
  }
  if (selStrike == null) { alert("Select a strike first."); return; }

  const leg = legFromChain(selStrike, selType);
  const live = leg && leg.ltp > 0 ? leg.ltp : null;
  const manual = num("manualEntry");
  const entry = manual ?? live;
  const sl = num("manualSL");
  const trailVal = num("trailVal");
  const trailMode = $("trailMode").value;
  const target = num("manualTarget");
  const lots = num("lots") ?? 1;
  const lotSize = num("lotSize") ?? getLot(symbol);
  const charges = num("charges") ?? 0;

  if (entry == null || entry <= 0) { alert("This strike has no live premium. Pick another strike or type an entry premium."); return; }
  if (sl == null || target == null) {
    alert("Enter an initial stop-loss and a target (in option premium ₹), or use the Quick levels button.");
    return;
  }
  if (trailVal != null && (trailVal < 0 || (trailMode === "pct" && trailVal >= 100))) {
    alert("Trailing distance must be positive (and below 100% when using %). Leave it blank for a fixed stop.");
    return;
  }
  if (!Number.isInteger(lots) || lots < 1) { alert("Lots must be a whole number of at least 1."); return; }
  if (lotSize < 1) { alert("Lot size must be at least 1."); return; }
  if (!(target > entry && sl < entry && sl >= 0)) {
    alert("You are BUYING the option, so: target above entry and the initial stop-loss below entry (and not negative).");
    return;
  }

  const qty = lots * lotSize;
  if (entry * qty > paper.capital) {
    alert("Premium cost " + money(entry * qty) + " is more than your virtual capital " + money(paper.capital) + ". Reduce the lots.");
    return;
  }

  const status = a.market?.session?.status;
  if (status && status !== "OPEN" &&
      !confirm("The market is " + status + ". Premiums are from the last session and will not move until it reopens. Continue?")) return;
  if (manual != null && live != null && Math.abs(manual - live) / live > 0.1 &&
      !confirm("Your entry (" + fmt(manual) + ") is more than 10% away from the live premium (" + fmt(live) + "). Continue?")) return;

  safeSet("oi_lot_" + symbol, String(lotSize));
  paper.open = {
    symbol, optType: selType, strike: selStrike, expiry: c.expiry || null,
    entry, sl, target, lots, lotSize, qty, charges,
    trailMode: trailVal ? trailMode : null,
    trailVal: trailVal || null,
    trail: trailVal ? (trailMode === "pct" ? trailVal + "%" : "₹" + trailVal) : "off",
    spotAtEntry: c.underlying ?? null,
    time: new Date().toLocaleString("en-IN"),
    entryTs: Math.floor(Date.now() / 1000),
    entrySource: manual != null ? "MANUAL" : "LIVE PREMIUM",
    lastLtp: live, maxLtp: live, minLtp: live,
  };
  state.quote = null;
  savePaper();
  pollQuote();
}

function closePaper(exitPrice, status) {
  const t = paper.open;
  if (!t) return;
  const pnl = (exitPrice - t.entry) * t.qty - (t.charges || 0);
  paper.realized += pnl;
  paper.capital += pnl;
  paper.trades.unshift({
    time: t.time,
    instrument: `${t.symbol} ${fmt(t.strike)} ${t.optType}`,
    qty: t.qty, entry: t.entry, sl: t.sl, trail: t.trail || "off", peak: t.maxLtp ?? null, target: t.target,
    exit: exitPrice, pnl, status, expiry: t.expiry,
  });
  paper.open = null;
  state.quote = null;
  savePaper();
}

function manualClose() {
  const t = paper.open;
  if (!t) return;
  const q = quoteFor(t);
  let price = q && q.ok && q.ltp > 0 ? q.ltp : null;
  if (price == null) {
    const typed = prompt("Live premium is unavailable. Enter the exit premium ₹ to close at:", t.lastLtp ?? "");
    if (typed == null) return;
    price = Number(typed);
    if (!Number.isFinite(price) || price < 0) { alert("Enter a valid premium."); return; }
  }
  closePaper(price, "MANUAL CLOSE");
}

/* Current stop = the higher of the initial stop-loss and (peak premium - trail distance).
   The peak only ever rises, so the stop only ever ratchets up. Stops/targets only see prices
   we actually polled (no tick data on the free feed): a stop fills at the observed premium,
   a target fills at the target price. */
function stopLevel(t) {
  const peak = Math.max(t.entry, t.maxLtp ?? t.entry);
  let stop = t.sl;
  if (t.trailVal) {
    const dist = t.trailMode === "pct" ? peak * t.trailVal / 100 : t.trailVal;
    stop = Math.max(stop, peak - dist);
  }
  return Math.max(0, Number(r05(stop)));
}

function checkOption(t, ltp) {
  const stop = stopLevel(t);
  if (ltp <= stop) {
    return { price: ltp, status: stop > t.sl + 1e-9 ? "TRAILING STOP HIT" : "STOP-LOSS HIT" };
  }
  if (ltp >= t.target) return { price: t.target, status: "TARGET HIT" };
  return null;
}

function quoteFor(t) {
  const q = state.quote;
  return q && t && q.symbol === t.symbol && q.strike === t.strike && q.type === t.optType ? q : null;
}

let quoteBusy = false;
async function pollQuote() {
  const t = paper.open;
  if (!t || quoteBusy) return;
  quoteBusy = true;
  try {
    const url = "/api/option-quote?symbol=" + encodeURIComponent(t.symbol) +
      "&strike=" + encodeURIComponent(t.strike) + "&kind=" + t.optType +
      (t.expiry ? "&expiry=" + encodeURIComponent(t.expiry) : "");
    const r = await fetch(url, { cache: "no-store" });
    const q = await r.json();
    if (!paper.open || paper.open.entryTs !== t.entryTs) return; // closed meanwhile
    state.quote = q;

    if (q.ok && q.ltp > 0) {
      t.lastLtp = q.ltp;
      t.lastTs = Date.now();
      t.maxLtp = Math.max(t.maxLtp ?? q.ltp, q.ltp);
      t.minLtp = Math.min(t.minLtp ?? q.ltp, q.ltp);
      persist();

      const hit = checkOption(t, q.ltp);
      if (hit) { closePaper(hit.price, hit.status); return; }

      const { minutes, day } = clientIstMinutes();
      if ($("autoSquare").checked && day >= 1 && day <= 5 && minutes >= 15 * 60 + 25 && minutes <= 15 * 60 + 40) {
        closePaper(q.ltp, "AUTO SQUARE-OFF 15:25");
        return;
      }
    }
    renderPaper();
  } catch (e) {
    console.warn("quote poll failed", e);
  } finally {
    quoteBusy = false;
  }
}

function renderOpenTrade() {
  const panel = $("openPanel");
  const t = paper.open;
  panel.hidden = !t;
  if (!t) { return; }

  const q = quoteFor(t);
  const live = q && q.ok && q.ltp > 0 ? q.ltp : null;
  const ltp = live ?? t.lastLtp;
  const un = ltp == null ? null : (ltp - t.entry) * t.qty - (t.charges || 0);

  setText("opContract", `${t.symbol} ${fmt(t.strike)} ${t.optType} · ${t.expiry || "--"}`);
  setText("opEntry", money(t.entry));
  setText("opLtp", ltp == null ? "--" : money(ltp) + (live == null ? " (last seen)" : ""));
  const pnl = $("opPnl");
  pnl.textContent = un == null ? "--" : money(un) + " (" + ((ltp - t.entry) / t.entry * 100).toFixed(1) + "%)";
  pnl.className = un > 0 ? "pos" : un < 0 ? "neg" : "";
  const stop = stopLevel(t);
  setText("opSl", `${money(stop)} · ` + (stop > t.sl + 1e-9 ? "trailing ↑ (initial " + money(t.sl) + ")" : t.trailVal ? "initial, trail " + t.trail : "fixed"));
  setText("opTarget", money(t.target));
  setText("opRange", t.maxLtp == null ? "--" : `${money(t.maxLtp)} / ${money(t.minLtp)}`);
  setText("opQty", `${t.qty} (${t.lots} lot × ${t.lotSize})`);

  let meta;
  if (q && q.expired) {
    meta = "⚠ " + q.error + " Close the trade manually at the settlement premium.";
  } else if (q && !q.ok) {
    meta = "⚠ Live premium unavailable: " + (q.error || "unknown") + ". Showing the last seen value.";
  } else if (q) {
    meta = `Source: ${q.source || "option chain"}` +
      (q.served_from_cache ? ` · cached ${q.cache_age_s ?? "?"} s ago (refresh failed)` : "") +
      ` · underlying ${fmt(q.underlying)} (at entry ${fmt(t.spotAtEntry)}) · updated ${new Date().toLocaleTimeString("en-IN")}`;
  } else {
    meta = "Fetching live premium...";
  }
  setText("opMeta", meta);
}

function renderPaper() {
  setText("capital", money(paper.capital));
  const pnl = $("pnl");
  pnl.textContent = money(paper.realized);
  pnl.className = paper.realized > 0 ? "pos" : paper.realized < 0 ? "neg" : "";

  const t = paper.open;
  const q = quoteFor(t);
  const ltp = t ? ((q && q.ok && q.ltp > 0 ? q.ltp : null) ?? t.lastLtp) : null;
  const unreal = t && ltp != null ? (ltp - t.entry) * t.qty - (t.charges || 0) : 0;
  setText("equity", money(paper.capital + unreal));

  const wins = paper.trades.filter(x => x.pnl > 0).length;
  const rate = paper.trades.length ? Math.round(wins / paper.trades.length * 100) + "%" : "--";
  setText("tradeCount", paper.trades.length + " / " + rate);

  renderOpenTrade();

  const body = $("tradeRows");
  if (!body) return;
  body.innerHTML = paper.trades.map(x =>
    `<tr>
      <td>${esc(x.time)}</td>
      <td>${esc(x.instrument)}</td>
      <td>${fmt(x.qty)}</td>
      <td>${fmt(x.entry)}</td>
      <td>${fmt(x.sl)}</td>
      <td>${esc(x.trail ?? "--")}</td>
      <td>${fmt(x.peak)}</td>
      <td>${fmt(x.target)}</td>
      <td>${fmt(x.exit)}</td>
      <td class="${x.pnl > 0 ? "pos" : x.pnl < 0 ? "neg" : ""}">${money(x.pnl)}</td>
      <td>${esc(x.status)}</td>
    </tr>`
  ).join("");
}

function applyPct() {
  const leg = selStrike != null ? legFromChain(selStrike, selType) : null;
  const entry = num("manualEntry") ?? (leg && leg.ltp > 0 ? leg.ltp : null);
  if (entry == null) { alert("No live premium for the selected strike yet."); return; }
  const slPct = num("slPct") ?? 20;
  const tgPct = num("tgtPct") ?? 40;
  $("manualSL").value = Math.max(0, Number(r05(entry * (1 - slPct / 100)))).toFixed(2);
  $("trailVal").value = slPct;
  $("trailMode").value = "pct";
  $("manualTarget").value = Number(r05(entry * (1 + tgPct / 100))).toFixed(2);
}

/* --------------------------------------------------------------- controls */
function setSymbol(s) {
  if (s === symbol) return;
  symbol = s;
  safeSet(SYMBOL_KEY, s);
  state.analysis = null;
  selStrike = null;
  $("lotSize").value = getLot(symbol);
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
$("refresh").onclick = () => { load(); pollQuote(); };
$("callTrade").onclick = openPaper;
$("closeTrade").onclick = manualClose;
$("applyPct").onclick = applyPct;
$("resetPaper").onclick = () => {
  if (confirm("Reset the paper account to ₹1,00,000 and delete all trades?")) {
    paper = defaultPaper();
    savePaper();
  }
};
$("selType").onchange = e => { selType = e.target.value; renderChain(state.analysis?.option_chain || {}); };
$("selStrike").onchange = e => {
  const v = Number(e.target.value);
  if (Number.isFinite(v)) { selStrike = v; renderChain(state.analysis?.option_chain || {}); }
};
$("chainRows").addEventListener("click", e => {
  const td = e.target.closest(".pick");
  if (td) selectContract(td.dataset.type, Number(td.dataset.strike));
});
["lots", "lotSize"].forEach(id => $(id).addEventListener("input", renderSelInfo));
$("lotSize").addEventListener("change", () => {
  const v = num("lotSize");
  if (v && v > 0) safeSet("oi_lot_" + symbol, String(v));
});
$("autoSquare").checked = safeGet("oi_autosq") !== "0";
$("autoSquare").onchange = e => safeSet("oi_autosq", e.target.checked ? "1" : "0");

syncSymbolButtons();
$("lotSize").value = getLot(symbol);
renderPaper();
if (legacyDropped) alert("An open index-based paper trade from the older version was discarded. Paper trading now uses option premiums.");
load();
pollQuote();
setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
setInterval(() => { if (!document.hidden && paper.open) pollQuote(); }, QUOTE_POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { load(); pollQuote(); } });
