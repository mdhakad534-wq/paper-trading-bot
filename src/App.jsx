import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  LayoutDashboard, LineChart as LineChartIcon, Wallet, History, Brain, Settings as SettingsIcon,
  Info, Plus, X, TrendingUp, TrendingDown, Octagon, PauseCircle,
  AlertTriangle, RefreshCw, WifiOff, ChevronRight, Check, Minus, PlayCircle
} from "lucide-react";
import { LineChart, Line, ResponsiveContainer, YAxis, XAxis, Tooltip, BarChart, Bar, Cell, CartesianGrid } from "recharts";

// ---------------------------------------------------------------------------
// PHASE 5 — Paper trading engine
//
// The strategy engine (Phase 4) now actually feeds a simulation instead of
// just displaying a decision:
//   - A background loop re-evaluates the multi-timeframe decision for every
//     watched symbol every 60s
//   - When a symbol returns LONG/SHORT (never on WAIT), the risk manager
//     checks: bot must be RUNNING, no conflicting open position on that
//     symbol, under the max-open-positions cap, not paused for daily loss
//     or consecutive losses, and enough virtual cash for the position
//   - If all checks pass, a position is opened at the current price with
//     simulated slippage and a fee deducted -- never at whatever price the
//     decision was computed from
//   - Every 15s (same cycle as live prices), open positions are checked
//     against their stop-loss / take-profit and closed with slippage + fees
//     if triggered -- this check runs regardless of bot status, because
//     existing risk must always be managed even when new trades are halted
//   - Daily loss limit and max consecutive losses actually halt new trade
//     generation (existing positions keep being monitored). Position size
//     is fixed by the 1% risk rule every time -- never increased after a
//     loss, no martingale, no averaging down
//   - State (cash, open positions, closed trades) persists across reloads
//     via the browser-scoped storage API
//
// Still not real: no live AI reasoning (Phase 7), no backtesting (Phase 6),
// no real exchange connection of any kind (this only ever touches
// public read-only market data endpoints).
// ---------------------------------------------------------------------------

// Data provider: Kraken's public REST API. Chosen after Binance (geo-blocked
// for US connections, inconsistent CORS) and CryptoCompare (restructured
// under CoinDesk through 2024-2026, free keyless tier retired) both turned
// out to be dead ends -- see README.md for the full trail. Kraken is a real
// exchange, not geo-restricted for US users the way Binance is, and its
// public market-data endpoints are what a long-standing "public-only browser
// client" community package is built on top of, which only makes sense if
// CORS actually works. One real limitation: Kraken's public OHLC endpoint
// only ever returns the most recent ~720 candles with no way to page further
// back -- see fetchHistoricalCandles and BACKTEST_DAY_OPTIONS below for how
// that's handled honestly rather than silently truncated.
const KRAKEN_BASE = "https://api.kraken.com/0/public";
const PRICE_POLL_MS = 15000;
const ANALYSIS_POLL_MS = 60000;
const STALE_MS = 90000;
const TIMEFRAMES = ["4h", "1h", "15m", "5m"];
const TF_LABEL = { "4h": "4H", "1h": "1H", "15m": "15M", "5m": "5M" };
const TF_ROLE = { "4h": "Trend", "1h": "Confirmation", "15m": "Setup", "5m": "Entry timing" };

const STARTING_BALANCE = 10000;
// Market-structural constants -- not strategy choices, apply regardless of
// which strategy preset is active.
const MARKET_SETTINGS = {
  maxOpenPositions: 2,
  feeRatePct: 0.075,
  slippagePct: 0.05,
};

// Strategy Lab: everything here IS a strategy choice, and can differ by
// preset. "balanced" reproduces the exact numbers the app shipped with
// through Phase 9, kept as the default so nothing changes underfoot until a
// person explicitly activates something else.
const STRATEGY_PRESETS = [
  {
    id: "balanced", name: "Balanced",
    description: "The original defaults — moderate RSI bands, needs 3 of 4 soft conditions, 1.5x ATR stop, 1:1.5 min R:R.",
    riskPerTradePct: 1, minRiskReward: 1.5, atrStopMultiplier: 1.5,
    rsiLongMin: 40, rsiLongMax: 70, rsiShortMin: 30, rsiShortMax: 60,
    softPassRequired: 3, maxDailyLossPct: 3, maxConsecutiveLosses: 3,
  },
  {
    id: "conservative", name: "Conservative",
    description: "Tighter RSI bands, requires every soft condition to agree, wider stop, higher min R:R, smaller risk per trade. Trades less often.",
    riskPerTradePct: 0.5, minRiskReward: 2, atrStopMultiplier: 2,
    rsiLongMin: 45, rsiLongMax: 65, rsiShortMin: 35, rsiShortMax: 55,
    softPassRequired: 4, maxDailyLossPct: 2, maxConsecutiveLosses: 2,
  },
  {
    id: "aggressive", name: "Aggressive",
    description: "Wider RSI bands, only needs 2 of 4 soft conditions, tighter stop, lower min R:R, bigger risk per trade. Trades more often, more exposure.",
    riskPerTradePct: 1.5, minRiskReward: 1.2, atrStopMultiplier: 1.2,
    rsiLongMin: 35, rsiLongMax: 75, rsiShortMin: 25, rsiShortMax: 65,
    softPassRequired: 2, maxDailyLossPct: 4, maxConsecutiveLosses: 4,
  },
  {
    id: "momentum", name: "Momentum-focused",
    description: "Narrower RSI band favoring strong existing momentum rather than mean-reversion zones, standard stop, higher min R:R to let winners run.",
    riskPerTradePct: 1, minRiskReward: 1.75, atrStopMultiplier: 1.5,
    rsiLongMin: 50, rsiLongMax: 72, rsiShortMin: 28, rsiShortMax: 50,
    softPassRequired: 3, maxDailyLossPct: 3, maxConsecutiveLosses: 3,
  },
];
const DEFAULT_STRATEGY_PARAMS = STRATEGY_PRESETS[0];
const STRATEGY_STORAGE_KEY = "paper-trading-active-strategy";

const STORAGE_KEY = "paper-trading-state-v1";
const AI_KEY_STORAGE = "paper-trading-anthropic-key"; // stored locally on this machine only, never sent anywhere but api.anthropic.com

const statusMeta = {
  RUNNING: { label: "RUNNING", color: "#3DDC97", dot: "#3DDC97" },
  ANALYZING: { label: "ANALYZING", color: "#F0B429", dot: "#F0B429" },
  STOPPED: { label: "STOPPED", color: "#E5484D", dot: "#E5484D" },
  PAUSED: { label: "PAUSED", color: "#8A8F98", dot: "#8A8F98" },
};

// Internal symbol representation stays a single concatenated string (e.g.
// "BTCUSDT") throughout the app for minimal churn; splitSymbol derives the
// base/quote pair Kraken's pair-code format needs, right at the data
// layer boundary.
const toBinanceSymbol = (s) => s.replace("/", "").toUpperCase(); // kept for the add-symbol flow; name is historical
const toDisplaySymbol = (s) => {
  const quotes = ["USDT", "USDC", "BUSD", "BTC", "ETH"];
  const q = quotes.find((q) => s.endsWith(q) && s.length > q.length);
  return q ? `${s.slice(0, -q.length)}/${q}` : s;
};
const splitSymbol = (s) => {
  const quotes = ["USDT", "USDC", "BUSD", "BTC", "ETH"];
  const q = quotes.find((q) => s.endsWith(q) && s.length > q.length);
  return q ? { base: s.slice(0, -q.length), quote: q } : { base: s, quote: "USD" };
};

// --- Phase 9: input validation ----------------------------------------------
// A symbol typed into the "add symbol" field ends up directly in a fetch URL.
// Only allow the character set exchanges actually use for ticker symbols, so
// nothing else can ever reach a request path or a rendered label.
const SYMBOL_PATTERN = /^[A-Z0-9]{2,20}$/;
const MAX_WATCHED_SYMBOLS = 10;
function validateSymbolInput(raw, existingCount) {
  const cleaned = raw.replace("/", "").toUpperCase().trim();
  if (!cleaned) return { ok: false, error: "Enter a symbol." };
  if (!SYMBOL_PATTERN.test(cleaned)) return { ok: false, error: "Only letters and numbers, e.g. ADAUSDT." };
  if (existingCount >= MAX_WATCHED_SYMBOLS) return { ok: false, error: `Max ${MAX_WATCHED_SYMBOLS} watched symbols.` };
  return { ok: true, symbol: cleaned };
}

function fmtUsd(n) {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPrice(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const decimals = n >= 100 ? 2 : n >= 1 ? 3 : 5;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}
function fmtNum(n, decimals = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function fmtTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}
function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

// --- Market data layer (Kraken) -----------------------------------------------

// Phase 9: every network call goes through this so a hung request can never
// block the app indefinitely -- fail safe means failing FAST, not waiting
// forever for a stale connection.
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Request timed out");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Kraken asset codes differ from the rest of the industry for a few legacy
// coins (BTC -> XBT being the big one). Everything else passes through as-is.
const KRAKEN_BASE_ASSET_MAP = { BTC: "XBT" };
const toKrakenPair = (symbol) => {
  const { base, quote } = splitSymbol(symbol);
  return `${KRAKEN_BASE_ASSET_MAP[base] || base}${quote}`;
};
// Kraken's response object keys its single result entry unpredictably
// (sometimes "XBTUSDT", sometimes a legacy "XXBTZUSD"-style key) -- rather
// than trying to predict it, just take whichever key is there.
const firstResultValue = (result, excludeKeys = []) => {
  if (!result) return null;
  const key = Object.keys(result).find((k) => !excludeKeys.includes(k));
  return key ? result[key] : null;
};

async function fetchTickers(symbols) {
  const bySymbol = {};
  await Promise.all(
    symbols.map(async (s) => {
      try {
        const url = `${KRAKEN_BASE}/Ticker?pair=${toKrakenPair(s)}`;
        const res = await fetchWithTimeout(url);
        if (!res.ok) { bySymbol[s] = null; return; }
        const data = await res.json();
        const t = firstResultValue(data.result);
        if (!t || (data.error && data.error.length)) { bySymbol[s] = null; return; }
        const last = parseFloat(t.c[0]);
        const open = parseFloat(t.o);
        bySymbol[s] = {
          price: last,
          change24h: open ? ((last - open) / open) * 100 : 0,
          high: parseFloat(t.h[1]),
          low: parseFloat(t.l[1]),
          volume: parseFloat(t.v[1]),
        };
      } catch {
        bySymbol[s] = null;
      }
    })
  );
  if (symbols.length && symbols.every((s) => bySymbol[s] === null)) {
    throw new Error("Could not reach exchange (Kraken) — network or CORS issue");
  }
  return bySymbol;
}

const KR_TF_MAP = { "5m": 5, "15m": 15, "1h": 60, "4h": 240 };

async function fetchSparkline(symbol, interval = "15m", limit = 32) {
  const url = `${KRAKEN_BASE}/OHLC?pair=${toKrakenPair(symbol)}&interval=${KR_TF_MAP[interval]}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) return null;
  const data = await res.json();
  const rows = firstResultValue(data.result, ["last"]);
  if (!Array.isArray(rows)) return null;
  return rows.slice(-limit).map((r) => parseFloat(r[4]));
}

async function fetchCandles(symbol, interval, limit = 220) {
  const url = `${KRAKEN_BASE}/OHLC?pair=${toKrakenPair(symbol)}&interval=${KR_TF_MAP[interval]}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Exchange returned ${res.status}`);
  const data = await res.json();
  if (data.error && data.error.length) throw new Error(data.error[0] || "Unknown symbol on exchange");
  const rows = firstResultValue(data.result, ["last"]);
  if (!Array.isArray(rows)) throw new Error("Unknown symbol on exchange");
  // Kraken's public OHLC only ever returns the most recent ~720 candles, so
  // "limit" here just trims what we asked for -- there's no older data to page into.
  return rows.slice(-limit).map((r) => ({ time: r[0] * 1000, open: parseFloat(r[1]), high: parseFloat(r[2]), low: parseFloat(r[3]), close: parseFloat(r[4]), volume: parseFloat(r[6]) }));
}

// Kraken's public OHLC endpoint has a hard cap of ~720 most-recent candles per
// call with NO way to page further into the past ("older data cannot be
// retrieved, regardless of the value of since" -- their own docs). So unlike
// a paginated fetch, this just takes whatever's in that 720-candle window and
// clips it to [startTime, endTime]. Practically this bounds how far back a
// backtest can usefully go on the faster timeframes (see BACKTEST_DAY_OPTIONS).
async function fetchHistoricalCandles(symbol, interval, startTime, endTime) {
  const url = `${KRAKEN_BASE}/OHLC?pair=${toKrakenPair(symbol)}&interval=${KR_TF_MAP[interval]}`;
  const res = await fetchWithTimeout(url, {}, 15000);
  if (!res.ok) throw new Error(`Exchange returned ${res.status}`);
  const data = await res.json();
  if (data.error && data.error.length) throw new Error(data.error[0] || "Unknown symbol/range");
  const rows = firstResultValue(data.result, ["last"]);
  if (!Array.isArray(rows)) throw new Error("Unknown symbol on exchange");
  return rows
    .map((r) => ({ time: r[0] * 1000, open: parseFloat(r[1]), high: parseFloat(r[2]), low: parseFloat(r[3]), close: parseFloat(r[4]), volume: parseFloat(r[6]) }))
    .filter((d) => d.time >= startTime && d.time <= endTime);
}

// --- Indicator math (pure functions over arrays) ---------------------------

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  for (let i = 0; i < values.length; i++) {
    if (i === period - 1) out[i] = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    else if (i >= period) out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}
function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let gainSum = 0, lossSum = 0, prevAvgGain = null, prevAvgLoss = null;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = Math.max(change, 0), loss = Math.max(-change, 0);
    if (i <= period) {
      gainSum += gain; lossSum += loss;
      if (i === period) {
        prevAvgGain = gainSum / period; prevAvgLoss = lossSum / period;
        out[i] = prevAvgLoss === 0 ? 100 : 100 - 100 / (1 + prevAvgGain / prevAvgLoss);
      }
    } else {
      const avgGain = (prevAvgGain * (period - 1) + gain) / period;
      const avgLoss = (prevAvgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      prevAvgGain = avgGain; prevAvgLoss = avgLoss;
    }
  }
  return out;
}
function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) => (emaFast[i] !== null && emaSlow[i] !== null) ? emaFast[i] - emaSlow[i] : null);
  const macdValues = macdLine.filter((v) => v !== null);
  const signalRaw = ema(macdValues, signalPeriod);
  const signalLine = new Array(closes.length).fill(null);
  let j = 0;
  for (let i = 0; i < closes.length; i++) { if (macdLine[i] !== null) { signalLine[i] = signalRaw[j] ?? null; j++; } }
  const histogram = closes.map((_, i) => (macdLine[i] !== null && signalLine[i] !== null) ? macdLine[i] - signalLine[i] : null);
  return { macdLine, signalLine, histogram };
}
function atr(candles, period = 14) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
  const out = new Array(candles.length).fill(null);
  let avg = null;
  for (let i = 0; i < tr.length; i++) {
    if (i === period - 1) { avg = tr.slice(0, period).reduce((a, b) => a + b, 0) / period; out[i] = avg; }
    else if (i >= period) { avg = (avg * (period - 1) + tr[i]) / period; out[i] = avg; }
  }
  return out;
}
function bollinger(closes, period = 20, mult = 2) {
  const middle = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = middle[i];
    const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = mean + mult * sd; lower[i] = mean - mult * sd;
  }
  return { middle, upper, lower };
}
function findSwingLevels(candles, lookback = 3, maxZones = 3) {
  const highs = [], lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const window = candles.slice(i - lookback, i + lookback + 1);
    const c = candles[i];
    if (c.high === Math.max(...window.map((w) => w.high))) highs.push({ price: c.high, idx: i });
    if (c.low === Math.min(...window.map((w) => w.low))) lows.push({ price: c.low, idx: i });
  }
  return {
    resistance: highs.slice(-maxZones).map((h) => h.price).sort((a, b) => b - a),
    support: lows.slice(-maxZones).map((l) => l.price).sort((a, b) => b - a),
  };
}
function detectBreakout(candles, levels, volMA) {
  const last = candles[candles.length - 1];
  const resistance = levels.resistance[0];
  const support = levels.support[levels.support.length - 1];
  const volConfirmed = volMA && last.volume > volMA;
  if (resistance && last.close > resistance) return { type: "BULLISH_BREAKOUT", label: volConfirmed ? "Bullish breakout (volume confirmed)" : "Bullish breakout (low volume)" };
  if (support && last.close < support) return { type: "BEARISH_BREAKDOWN", label: volConfirmed ? "Bearish breakdown (volume confirmed)" : "Bearish breakdown (low volume)" };
  return { type: "NONE", label: "No breakout — price inside range" };
}
function detectCandlePattern(candles) {
  if (candles.length < 2) return "Not enough data";
  const prev = candles[candles.length - 2];
  const cur = candles[candles.length - 1];
  const curRange = cur.high - cur.low || 1e-9;
  const curBody = Math.abs(cur.close - cur.open);
  const prevBullish = prev.close > prev.open;
  const curBullish = cur.close > cur.open;
  if (curBody / curRange < 0.1) return "Doji — indecision";
  if (!prevBullish && curBullish && cur.open <= prev.close && cur.close >= prev.open) return "Bullish engulfing";
  if (prevBullish && !curBullish && cur.open >= prev.close && cur.close <= prev.open) return "Bearish engulfing";
  return "No clear pattern";
}
function computeIndicators(candles) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const ema20 = ema(closes, 20), ema50 = ema(closes, 50), ema200 = ema(closes, 200);
  const rsi14 = rsi(closes, 14);
  const { macdLine, signalLine, histogram } = macd(closes);
  const atr14 = atr(candles, 14);
  const bb = bollinger(closes, 20, 2);
  const volMA = sma(volumes, 20);
  const levels = findSwingLevels(candles);
  const last = candles.length - 1;
  let trend = "UNKNOWN";
  if (ema20[last] && ema50[last] && ema200[last]) {
    if (ema20[last] > ema50[last] && ema50[last] > ema200[last]) trend = "BULLISH";
    else if (ema20[last] < ema50[last] && ema50[last] < ema200[last]) trend = "BEARISH";
    else trend = "SIDEWAYS";
  }
  return {
    series: { closes, ema20, ema50, ema200, rsi14, macdLine, signalLine, histogram, atr14, bbUpper: bb.upper, bbMiddle: bb.middle, bbLower: bb.lower, volumes, volMA },
    latest: {
      price: closes[last], ema20: ema20[last], ema50: ema50[last], ema200: ema200[last],
      rsi14: rsi14[last], macd: macdLine[last], signal: signalLine[last], histogram: histogram[last],
      atr14: atr14[last], bbUpper: bb.upper[last], bbMiddle: bb.middle[last], bbLower: bb.lower[last],
      volume: volumes[last], volMA: volMA[last],
    },
    trend, levels,
    breakout: detectBreakout(candles, levels, volMA[last]),
    pattern: detectCandlePattern(candles),
  };
}

// --- Phase 4: strategy engine (rule-based, multi-timeframe) -----------------

function evaluateSide(side, ind4h, ind1h, ind15m, ind5m, sp) {
  const bullish = side === "LONG";
  const htfTrendOk = bullish ? ind4h.trend === "BULLISH" : ind4h.trend === "BEARISH";
  const confirmOk = bullish ? ind1h.trend !== "BEARISH" : ind1h.trend !== "BULLISH";
  const momentumOk = bullish
    ? ind15m.latest.rsi14 >= sp.rsiLongMin && ind15m.latest.rsi14 <= sp.rsiLongMax && (ind15m.latest.histogram ?? 0) > 0
    : ind15m.latest.rsi14 <= sp.rsiShortMax && ind15m.latest.rsi14 >= sp.rsiShortMin && (ind15m.latest.histogram ?? 0) < 0;
  const volumeOk = ind5m.latest.volume > (ind5m.latest.volMA ?? Infinity);
  const notExtendedOk = bullish
    ? ind5m.latest.price <= (ind5m.latest.bbUpper ?? Infinity)
    : ind5m.latest.price >= (ind5m.latest.bbLower ?? -Infinity);
  const noConflict = true;
  const conditions = [
    { label: `4H trend ${bullish ? "bullish" : "bearish"}`, pass: htfTrendOk, core: true },
    { label: `1H does not conflict`, pass: confirmOk, core: true },
    { label: `15M momentum supportive (RSI + MACD histogram)`, pass: momentumOk, core: false },
    { label: `5M volume above average`, pass: volumeOk, core: false },
    { label: `Price not excessively extended`, pass: notExtendedOk, core: false },
    { label: `No conflicting open position`, pass: noConflict, core: false },
  ];
  const coreOk = conditions.filter((c) => c.core).every((c) => c.pass);
  const softPassed = conditions.filter((c) => !c.core && c.pass).length;
  const softTotal = conditions.filter((c) => !c.core).length;
  return { conditions, setupOk: coreOk && softPassed >= sp.softPassRequired, softPassed, softTotal };
}

function computeStrategyDecision(mtf, sp, currentEquity) {
  const missing = TIMEFRAMES.filter((tf) => !mtf[tf]);
  if (missing.length) {
    return { decision: "WAIT", reasonSummary: `Insufficient data — missing ${missing.map((m) => TF_LABEL[m]).join(", ")} candles`, conditions: [], warnings: ["Cannot evaluate a trade without all four timeframes."] };
  }
  const [ind4h, ind1h, ind15m, ind5m] = TIMEFRAMES.map((tf) => mtf[tf]);
  const long = evaluateSide("LONG", ind4h, ind1h, ind15m, ind5m, sp);
  const short = evaluateSide("SHORT", ind4h, ind1h, ind15m, ind5m, sp);

  if (long.setupOk && short.setupOk) {
    return { decision: "WAIT", reasonSummary: "Conflicting signals across timeframes", conditions: [], warnings: ["LONG and SHORT setups both partially triggered — sitting out."] };
  }
  const candidate = long.setupOk ? "LONG" : short.setupOk ? "SHORT" : null;
  if (!candidate) {
    const closer = long.softPassed >= short.softPassed ? long : short;
    return { decision: "WAIT", reasonSummary: "Timeframes do not agree strongly enough to trade", conditions: closer.conditions, warnings: ["Bot is deliberately sitting out — not enough conditions align."] };
  }
  const entry = ind5m.latest.price;
  const setupAtr = ind15m.latest.atr14 ?? (ind5m.latest.atr14 ?? entry * 0.005);
  const stopLoss = candidate === "LONG" ? entry - sp.atrStopMultiplier * setupAtr : entry + sp.atrStopMultiplier * setupAtr;
  const riskPerUnit = Math.abs(entry - stopLoss);
  const takeProfit = candidate === "LONG" ? entry + sp.minRiskReward * riskPerUnit : entry - sp.minRiskReward * riskPerUnit;
  if (riskPerUnit <= 0 || !isFinite(riskPerUnit)) {
    return { decision: "WAIT", reasonSummary: "Could not compute a valid stop distance (ATR unavailable)", conditions: candidate === "LONG" ? long.conditions : short.conditions, warnings: ["Volatility data insufficient to size a safe stop."] };
  }
  const riskAmount = currentEquity * (sp.riskPerTradePct / 100);
  const positionSize = riskAmount / riskPerUnit;
  const notional = positionSize * entry;
  return {
    decision: candidate,
    reasonSummary: `${TF_LABEL["4h"]} trend + setup conditions aligned for ${candidate}`,
    conditions: candidate === "LONG" ? long.conditions : short.conditions,
    entry, stopLoss, takeProfit, riskReward: sp.minRiskReward,
    riskAmount, positionSize, notional,
    warnings: ["This is a rule-based simulation output, not investment advice.", "Confidence in this setup is not a probability of profit."],
  };
}

// --- Phase 6: backtesting engine --------------------------------------------
//
// Runs the exact same rule-based decision logic from Phase 4/evaluateSide
// against historical candles instead of live ones, stepping bar-by-bar on
// the 5M timeframe. At every step it only looks at 4H/1H/15M candles that
// have already fully closed as of that point in simulated time -- no future
// candle is ever visible to the decision at step i (no look-ahead bias).
// Position sizing, fees, slippage, the daily-loss halt and the consecutive-
// loss halt all reuse the same numbers as the live paper trading engine so
// the backtest and the live bot are testing the same rules, not two
// different ones.

const INTERVAL_MS = { "4h": 4 * 3600000, "1h": 3600000, "15m": 900000, "5m": 300000 };

function computeTrendSeries(ema20, ema50, ema200) {
  return ema20.map((v, i) => {
    if (ema20[i] == null || ema50[i] == null || ema200[i] == null) return "UNKNOWN";
    if (ema20[i] > ema50[i] && ema50[i] > ema200[i]) return "BULLISH";
    if (ema20[i] < ema50[i] && ema50[i] < ema200[i]) return "BEARISH";
    return "SIDEWAYS";
  });
}

function buildFullSeries(candles) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const ema20 = ema(closes, 20), ema50 = ema(closes, 50), ema200 = ema(closes, 200);
  const rsi14 = rsi(closes, 14);
  const { histogram } = macd(closes);
  const atr14 = atr(candles, 14);
  const bb = bollinger(closes, 20, 2);
  const volMA = sma(volumes, 20);
  const trend = computeTrendSeries(ema20, ema50, ema200);
  return { time: candles.map((c) => c.time), close: closes, high: candles.map((c) => c.high), low: candles.map((c) => c.low), trend, rsi14, histogram, volume: volumes, volMA, bbUpper: bb.upper, bbLower: bb.lower, atr14 };
}

// snapshot-based version of evaluateSide (Phase 4) that reads from precomputed
// full series at given indices instead of a live `.latest` object
function evaluateSideAtIndex(side, s4h, i4h, s1h, i1h, s15m, i15m, s5m, i5m, sp) {
  const bullish = side === "LONG";
  const htfTrendOk = bullish ? s4h.trend[i4h] === "BULLISH" : s4h.trend[i4h] === "BEARISH";
  const confirmOk = bullish ? s1h.trend[i1h] !== "BEARISH" : s1h.trend[i1h] !== "BULLISH";
  const rsi15 = s15m.rsi14[i15m], hist15 = s15m.histogram[i15m] ?? 0;
  const momentumOk = bullish
    ? (rsi15 >= sp.rsiLongMin && rsi15 <= sp.rsiLongMax && hist15 > 0)
    : (rsi15 <= sp.rsiShortMax && rsi15 >= sp.rsiShortMin && hist15 < 0);
  const volumeOk = s5m.volume[i5m] > (s5m.volMA[i5m] ?? Infinity);
  const price5 = s5m.close[i5m];
  const notExtendedOk = bullish ? price5 <= (s5m.bbUpper[i5m] ?? Infinity) : price5 >= (s5m.bbLower[i5m] ?? -Infinity);
  const conditions = [
    { pass: htfTrendOk, core: true }, { pass: confirmOk, core: true },
    { pass: momentumOk, core: false }, { pass: volumeOk, core: false }, { pass: notExtendedOk, core: false }, { pass: true, core: false },
  ];
  const coreOk = conditions.filter((c) => c.core).every((c) => c.pass);
  const softPassed = conditions.filter((c) => !c.core && c.pass).length;
  return coreOk && softPassed >= sp.softPassRequired;
}

function statsFromTrades(trades, startEquity) {
  if (!trades.length) return null;
  const wins = trades.filter((t) => t.pl > 0);
  const losses = trades.filter((t) => t.pl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pl, 0));
  const finalEquity = startEquity + trades.reduce((s, t) => s + t.pl, 0);
  let maxConsecWins = 0, maxConsecLosses = 0, curWin = 0, curLoss = 0;
  for (const t of trades) {
    if (t.pl > 0) { curWin++; curLoss = 0; } else { curLoss++; curWin = 0; }
    maxConsecWins = Math.max(maxConsecWins, curWin);
    maxConsecLosses = Math.max(maxConsecLosses, curLoss);
  }
  return {
    totalTrades: trades.length, wins: wins.length, losses: losses.length,
    winRate: (wins.length / trades.length) * 100,
    totalReturnPct: ((finalEquity - startEquity) / startEquity) * 100,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    largestWin: wins.length ? Math.max(...wins.map((t) => t.pl)) : 0,
    largestLoss: losses.length ? Math.min(...losses.map((t) => t.pl)) : 0,
    maxConsecWins, maxConsecLosses, finalEquity,
  };
}

function maxDrawdownPct(equityCurve) {
  let peak = -Infinity, maxDd = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - point.equity) / peak);
  }
  return maxDd * 100;
}

function runBacktest(symbol, candlesByTf, cfg) {
  const series = {};
  for (const tf of TIMEFRAMES) series[tf] = buildFullSeries(candlesByTf[tf]);
  const s5m = series["5m"];
  const n = s5m.close.length;
  const warmup = 210; // bars needed for a valid EMA200 read on the fastest series driving the loop

  let cash = cfg.startingBalance;
  let position = null;
  const trades = [];
  const equityCurve = [];
  let dayKey = null, dayStartEquity = cfg.startingBalance, consecutiveLosses = 0, pauseReason = null;

  let p4h = -1, p1h = -1, p15m = -1;
  const advance = (s, p, t, intervalMs) => { while (p + 1 < s.time.length && s.time[p + 1] + intervalMs <= t) p++; return p; };

  for (let i = warmup; i < n; i++) {
    const t = s5m.time[i] + INTERVAL_MS["5m"]; // this 5m bar has just closed
    p4h = advance(series["4h"], p4h, t, INTERVAL_MS["4h"]);
    p1h = advance(series["1h"], p1h, t, INTERVAL_MS["1h"]);
    p15m = advance(series["15m"], p15m, t, INTERVAL_MS["15m"]);
    if (p4h < 209 || p1h < 209 || p15m < 209) continue; // not enough closed history yet on a higher timeframe

    const dayOfBar = new Date(t).toISOString().slice(0, 10);
    if (dayKey === null) dayKey = dayOfBar;
    if (dayOfBar !== dayKey) {
      dayKey = dayOfBar;
      dayStartEquity = cash + (position ? position.notional : 0);
      if (pauseReason === "DAILY_LOSS_LIMIT") pauseReason = null;
    }

    // manage an open position first: check this bar's high/low for SL/TP (conservative: SL checked first)
    if (position) {
      const bar = { high: s5m.high[i], low: s5m.low[i] };
      let hit = null;
      if (position.side === "LONG") { if (bar.low <= position.stopLoss) hit = "SL"; else if (bar.high >= position.takeProfit) hit = "TP"; }
      else { if (bar.high >= position.stopLoss) hit = "SL"; else if (bar.low <= position.takeProfit) hit = "TP"; }
      if (hit) {
        const rawExit = hit === "SL" ? position.stopLoss : position.takeProfit;
        const slip = cfg.slippagePct / 100;
        const exitPrice = position.side === "LONG" ? rawExit * (1 - slip) : rawExit * (1 + slip);
        const grossPL = position.side === "LONG" ? (exitPrice - position.entry) * position.qty : (position.entry - exitPrice) * position.qty;
        const exitFee = exitPrice * position.qty * (cfg.feeRatePct / 100);
        const pl = grossPL - exitFee;
        cash += position.notional + pl;
        trades.push({ symbol, side: position.side, entry: position.entry, exit: exitPrice, qty: position.qty, pl, entryTime: position.entryTime, exitTime: t, exitReason: hit === "SL" ? "Stop loss hit" : "Take profit hit" });
        consecutiveLosses = pl < 0 ? consecutiveLosses + 1 : 0;
        if (consecutiveLosses >= cfg.maxConsecutiveLosses && !pauseReason) pauseReason = "CONSECUTIVE_LOSSES";
        position = null;
      }
    }

    const equityNow = cash + (position ? position.notional : 0);
    if (!pauseReason && equityNow <= dayStartEquity * (1 - cfg.maxDailyLossPct / 100)) pauseReason = "DAILY_LOSS_LIMIT";

    // only look for a new entry if flat
    if (!position && !pauseReason) {
      const longOk = evaluateSideAtIndex("LONG", series["4h"], p4h, series["1h"], p1h, series["15m"], p15m, s5m, i, cfg);
      const shortOk = evaluateSideAtIndex("SHORT", series["4h"], p4h, series["1h"], p1h, series["15m"], p15m, s5m, i, cfg);
      const candidate = longOk && !shortOk ? "LONG" : shortOk && !longOk ? "SHORT" : null;
      if (candidate) {
        const entryRaw = s5m.close[i];
        const setupAtr = series["15m"].atr14[p15m] ?? entryRaw * 0.005;
        const stopLoss = candidate === "LONG" ? entryRaw - cfg.atrStopMultiplier * setupAtr : entryRaw + cfg.atrStopMultiplier * setupAtr;
        const riskPerUnit = Math.abs(entryRaw - stopLoss);
        if (riskPerUnit > 0 && isFinite(riskPerUnit)) {
          const slip = cfg.slippagePct / 100;
          const fillPrice = candidate === "LONG" ? entryRaw * (1 + slip) : entryRaw * (1 - slip);
          const riskAmount = equityNow * (cfg.riskPerTradePct / 100);
          const qty = riskAmount / riskPerUnit;
          const notional = fillPrice * qty;
          const entryFee = notional * (cfg.feeRatePct / 100);
          if (qty > 0 && isFinite(qty) && notional + entryFee <= cash) {
            const takeProfit = candidate === "LONG" ? entryRaw + cfg.minRiskReward * riskPerUnit : entryRaw - cfg.minRiskReward * riskPerUnit;
            cash -= (notional + entryFee);
            position = { side: candidate, entry: fillPrice, qty, notional, stopLoss, takeProfit, entryTime: t };
          }
        }
      }
    }

    equityCurve.push({ time: t, equity: cash + (position ? position.notional : 0) });
  }

  // close anything still open at the mark of the last bar so stats reflect a clean end
  if (position) {
    const lastPrice = s5m.close[n - 1];
    const grossPL = position.side === "LONG" ? (lastPrice - position.entry) * position.qty : (position.entry - lastPrice) * position.qty;
    const exitFee = lastPrice * position.qty * (cfg.feeRatePct / 100);
    const pl = grossPL - exitFee;
    cash += position.notional + pl;
    trades.push({ symbol, side: position.side, entry: position.entry, exit: lastPrice, qty: position.qty, pl, entryTime: position.entryTime, exitTime: s5m.time[n - 1], exitReason: "Backtest window ended (mark-to-close)" });
    if (equityCurve.length) equityCurve[equityCurve.length - 1].equity = cash;
  }

  const splitIdx = Math.floor(trades.length * 0.7);
  const inSample = trades.slice(0, splitIdx);
  const outOfSample = trades.slice(splitIdx);
  const splitEquity = cfg.startingBalance + inSample.reduce((s, t) => s + t.pl, 0);

  return {
    trades, equityCurve,
    overall: statsFromTrades(trades, cfg.startingBalance),
    overallMaxDrawdown: maxDrawdownPct(equityCurve.length ? equityCurve : [{ equity: cfg.startingBalance }]),
    inSample: statsFromTrades(inSample, cfg.startingBalance),
    outOfSample: statsFromTrades(outOfSample, splitEquity),
  };
}

// --- Phase 7: AI analysis layer ---------------------------------------------
//
// The AI never sees raw price ticks or trades on its own -- it only receives
// the same structured indicator snapshot a human would look at (spec section
// 5's exact shape: symbol, price, trend, RSI, MACD, EMAs, ATR, volume,
// support/resistance, per-timeframe summary) plus the rule engine's
// candidate direction, and must return strict JSON. It is called only when
// the rule-based engine has already found a candidate (LONG/SHORT) --
// most cycles resolve to WAIT before ever reaching the AI, which keeps this
// a genuine confirmation/veto layer rather than the sole decision-maker.
// The AI can only ever narrow a trade toward WAIT, never invent one the rule
// engine didn't already propose, and it never sets the executed stop-loss /
// take-profit -- those stay ATR-based numbers from the strategy engine so a
// bad AI number can't size a real (paper) position. If the call fails,
// times out, or returns something that doesn't parse, the system fails
// safe: no trade, logged as "AI unavailable."

const CLAUDE_MODEL = "claude-sonnet-4-6";

function buildAIPayload(symbol, indicators, ruleDecision) {
  const tf15 = indicators["15m"]?.latest || {};
  const tf5 = indicators["5m"]?.latest || {};
  const perTf = {};
  TIMEFRAMES.forEach((tf) => {
    const ind = indicators[tf];
    if (ind) perTf[tf] = { trend: ind.trend, rsi: Number(ind.latest.rsi14?.toFixed(1)), macd_histogram: Number((ind.latest.histogram ?? 0).toFixed(4)) };
  });
  return {
    symbol: toDisplaySymbol(symbol),
    current_price: tf5.price ?? tf15.price,
    trend: indicators["4h"]?.trend || "UNKNOWN",
    RSI: tf15.rsi14, MACD: { line: tf15.macd, signal: tf15.signal, histogram: tf15.histogram },
    EMA20: tf15.ema20, EMA50: tf15.ema50, EMA200: tf15.ema200, ATR: tf15.atr14,
    volume: tf5.volume, volume_avg: tf5.volMA,
    support: indicators["15m"]?.levels?.support || [], resistance: indicators["15m"]?.levels?.resistance || [],
    timeframe_data: perTf,
    rule_based_candidate: {
      decision: ruleDecision.decision, entry: ruleDecision.entry, stop_loss: ruleDecision.stopLoss,
      take_profit: ruleDecision.takeProfit, risk_reward: ruleDecision.riskReward,
      conditions_passed: ruleDecision.conditions.filter((c) => c.pass).map((c) => c.label),
    },
  };
}

const AI_SYSTEM_PROMPT = `You are the AI analysis layer inside a crypto PAPER-trading simulator (virtual money only, no real orders). You receive structured technical indicator data and a candidate direction already proposed by a separate rule-based strategy engine. Independently judge whether the data actually supports that candidate.

Rules you must follow:
- Respond with ONLY minified JSON, no prose, no markdown code fences, matching exactly this schema:
{"decision":"LONG|SHORT|WAIT","confidence":0-100,"trend":"BULLISH|BEARISH|SIDEWAYS","reason":"...","entry_zone":"...","stop_loss":"...","take_profit":"...","risk_reward":"...","warnings":["..."]}
- You may only output the SAME direction as rule_based_candidate.decision, or WAIT. Never output a direction the rule engine did not already propose.
- "confidence" reflects how well the given data supports the setup. It is NOT a probability of profit and must never be described or implied as one anywhere in "reason" or "warnings".
- If the indicators are ambiguous, weak, contradict the candidate, or you are not confident the data supports it, output WAIT even though a candidate was given.
- Do not invent any indicator values you were not given. Base "reason" only on the provided numbers, citing 2-3 specific ones.
- Keep "reason" under 40 words. Always include at least one entry in "warnings" noting this is a simulation, not financial advice, and no AI can predict markets with certainty.`;

async function callAIAnalysis(symbol, indicators, ruleDecision, apiKey) {
  const payload = buildAIPayload(symbol, indicators, ruleDecision);
  const response = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Required for calling the API directly from a browser instead of a backend.
      // Anthropic disables browser CORS by default because it means your API key
      // is visible to anyone who opens devtools on this page. That's an acceptable
      // tradeoff for a tool you run for yourself on your own machine; it is NOT
      // acceptable if you deploy this publicly (see README) -- use a small server
      // proxy in that case so the key never reaches the browser.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1000,
      system: AI_SYSTEM_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(payload) }],
    }),
  }, 20000);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error?.message || `AI service returned ${response.status}`);
  }
  const data = await response.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("AI returned no text content");
  const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch { throw new Error("AI response was not valid JSON"); }
  if (!["LONG", "SHORT", "WAIT"].includes(parsed.decision)) throw new Error("AI returned an invalid decision value");
  if (parsed.decision !== "WAIT" && parsed.decision !== ruleDecision.decision) parsed.decision = "WAIT"; // hard safety clamp
  parsed.confidence = Math.max(0, Math.min(100, Number(parsed.confidence) || 0));
  if (!Array.isArray(parsed.warnings)) parsed.warnings = [];
  return parsed;
}

function combineDecisions(ruleDecision, aiReview, aiError, aiConfigured) {
  if (ruleDecision.decision === "WAIT") return { final: ruleDecision, aiSkipped: true };
  if (!aiConfigured) {
    return { final: { ...ruleDecision, warnings: [...ruleDecision.warnings, "AI confirmation is off (no API key set in Settings) — trading on the rule engine alone."] }, aiSkipped: true };
  }
  if (aiError) {
    return { final: { ...ruleDecision, decision: "WAIT", reasonSummary: "AI analysis unavailable — failing safe, no trade generated", warnings: [...ruleDecision.warnings, `AI error: ${aiError}`] }, aiSkipped: false };
  }
  if (!aiReview) return { final: ruleDecision, aiSkipped: false, aiPending: true };
  if (aiReview.decision !== ruleDecision.decision) {
    return { final: { ...ruleDecision, decision: "WAIT", reasonSummary: "AI did not confirm the rule-based setup — sitting out" }, aiSkipped: false };
  }
  return { final: ruleDecision, aiSkipped: false };
}

// --- Phase 5: paper trading engine (pure functions over trading state) -----

// --- Phase 10: exchange adapter (testnet scaffolding, not wired to a real exchange) ----
//
// The spec's architecture keeps LIVE order execution behind its own adapter,
// completely separate from the AI and the strategy engine -- the AI never
// calls this, and never will; only a confirmed, risk-checked decision could
// ever reach it. That separation is real in this code. What is NOT real:
// actually placing an order. This is a client-only artifact with no backend,
// which means there is nowhere to hold an exchange API secret that counts as
// "secure secret storage" -- browser state and this app's persistent storage
// are both readable by anyone with the page open, and any signed request
// built here would expose the secret in the browser's own network inspector
// regardless of HTTPS. Rather than pretend that's safe, this adapter is left
// intentionally unimplemented: it validates key *format* only, never
// transmits or persists a key anywhere, and placeOrder always throws. Wiring
// a real exchange (even testnet) needs a server component to hold the secret
// and sign requests -- that's a different, backend-having build, not this one.

function looksLikeApiKeyFormat(key) {
  return /^[A-Za-z0-9]{16,128}$/.test(key.trim());
}

const exchangeAdapter = {
  // Intentionally never implemented in this build -- see comment block above.
  async placeOrder() {
    throw new Error("No exchange adapter is wired up in this build. LIVE mode cannot place orders here by design.");
  },
};

function initialTradingState() {
  return {
    availableCash: STARTING_BALANCE,
    openPositions: [],
    closedTrades: [],
    dayKey: todayKey(),
    dayStartEquity: STARTING_BALANCE,
    consecutiveLosses: 0,
    pauseReason: null, // null | 'DAILY_LOSS_LIMIT' | 'CONSECUTIVE_LOSSES'
    lastStoppedAt: null,
    lastEvent: null,
  };
}

function computeEquity(tradingState, marketData) {
  let openPositionValue = 0, unrealizedPL = 0;
  for (const p of tradingState.openPositions) {
    const cur = marketData[p.symbol]?.price ?? p.entry;
    const grossU = p.side === "LONG" ? (cur - p.entry) * p.qty : (p.entry - cur) * p.qty;
    const estExitFee = cur * p.qty * (MARKET_SETTINGS.feeRatePct / 100);
    const netU = grossU - estExitFee;
    openPositionValue += p.notional + netU;
    unrealizedPL += netU;
  }
  const realizedPL = tradingState.closedTrades.reduce((s, t) => s + t.pl, 0);
  const totalEquity = tradingState.availableCash + openPositionValue;
  const totalPL = totalEquity - STARTING_BALANCE;
  return {
    availableCash: tradingState.availableCash, openPositionValue, unrealizedPL, realizedPL,
    totalEquity, totalPL, returnPct: (totalPL / STARTING_BALANCE) * 100,
  };
}

function rolloverDay(state, currentEquity) {
  const today = todayKey();
  if (state.dayKey === today) return state;
  return { ...state, dayKey: today, dayStartEquity: currentEquity, pauseReason: state.pauseReason === "DAILY_LOSS_LIMIT" ? null : state.pauseReason };
}

function checkExits(state, marketData, sp) {
  let next = state;
  let changed = false;
  const remaining = [];
  const newClosed = [];
  for (const p of next.openPositions) {
    const cur = marketData[p.symbol]?.price;
    if (!cur) { remaining.push(p); continue; } // fail-safe: no fresh price, don't touch the position
    let hit = null;
    if (p.side === "LONG") { if (cur <= p.stopLoss) hit = "SL"; else if (cur >= p.takeProfit) hit = "TP"; }
    else { if (cur >= p.stopLoss) hit = "SL"; else if (cur <= p.takeProfit) hit = "TP"; }
    if (!hit) { remaining.push(p); continue; }
    const slip = MARKET_SETTINGS.slippagePct / 100;
    const exitPrice = p.side === "LONG" ? cur * (1 - slip) : cur * (1 + slip);
    const grossPL = p.side === "LONG" ? (exitPrice - p.entry) * p.qty : (p.entry - exitPrice) * p.qty;
    const exitFee = exitPrice * p.qty * (MARKET_SETTINGS.feeRatePct / 100);
    const netPL = grossPL - exitFee;
    newClosed.push({
      ...p, exit: exitPrice, pl: netPL, fees: p.entryFee + exitFee, exitTime: Date.now(),
      exitReason: hit === "SL" ? "Stop loss hit" : "Take profit hit",
    });
    changed = true;
  }
  if (!changed) return state;
  let cashDelta = 0;
  let consecutiveLosses = next.consecutiveLosses;
  let pauseReason = next.pauseReason;
  for (const t of newClosed) {
    cashDelta += t.notional + t.pl;
    consecutiveLosses = t.pl < 0 ? consecutiveLosses + 1 : 0;
    if (consecutiveLosses >= sp.maxConsecutiveLosses && !pauseReason) pauseReason = "CONSECUTIVE_LOSSES";
  }
  const lastEvent = newClosed.length
    ? { type: "CLOSE", text: `${newClosed[newClosed.length - 1].exitReason}: ${toDisplaySymbol(newClosed[newClosed.length - 1].symbol)} ${newClosed[newClosed.length - 1].pl >= 0 ? "+" : ""}${fmtUsd(newClosed[newClosed.length - 1].pl)}`, time: Date.now() }
    : next.lastEvent;
  next = {
    ...next,
    availableCash: next.availableCash + cashDelta,
    openPositions: remaining,
    closedTrades: [...newClosed.reverse(), ...next.closedTrades].slice(0, 100),
    consecutiveLosses, pauseReason, lastEvent,
  };
  const equity = computeEquity(next, marketData);
  if (!next.pauseReason && equity.totalEquity <= next.dayStartEquity * (1 - sp.maxDailyLossPct / 100)) {
    next = { ...next, pauseReason: "DAILY_LOSS_LIMIT" };
  }
  return next;
}

function tryOpenPositions(state, symbolAnalysis, marketData, botStatus) {
  if (botStatus !== "RUNNING" || state.pauseReason) return state;
  let next = state;
  for (const symbol of Object.keys(symbolAnalysis)) {
    if (next.openPositions.length >= MARKET_SETTINGS.maxOpenPositions) break;
    const decision = symbolAnalysis[symbol]?.finalDecision;
    if (!decision || decision.decision === "WAIT") continue;
    if (next.openPositions.some((p) => p.symbol === symbol)) continue;
    const cur = marketData[symbol]?.price;
    if (!cur) continue;
    const slip = MARKET_SETTINGS.slippagePct / 100;
    const fillPrice = decision.decision === "LONG" ? cur * (1 + slip) : cur * (1 - slip);
    const qty = decision.positionSize;
    if (!qty || qty <= 0 || !isFinite(qty)) continue;
    const notional = fillPrice * qty;
    const entryFee = notional * (MARKET_SETTINGS.feeRatePct / 100);
    if (notional + entryFee > next.availableCash) continue; // insufficient virtual balance — fail safe
    const position = {
      id: `${symbol}-${Date.now()}`, symbol, side: decision.decision, entry: fillPrice, qty, notional, entryFee,
      stopLoss: decision.stopLoss, takeProfit: decision.takeProfit, entryTime: Date.now(),
      reasonLabels: decision.conditions.filter((c) => c.pass).map((c) => c.label), riskAmount: decision.riskAmount,
    };
    next = {
      ...next,
      availableCash: next.availableCash - (notional + entryFee),
      openPositions: [...next.openPositions, position],
      lastEvent: { type: "OPEN", text: `Opened ${decision.decision} ${toDisplaySymbol(symbol)} at ${fmtPrice(fillPrice)}`, time: Date.now() },
    };
  }
  return next;
}

// --- small presentational pieces -------------------------------------------

function PLText({ value, size = "text-sm" }) {
  const positive = value >= 0;
  return <span className={`${size} font-medium tabular-nums`} style={{ color: positive ? "#3DDC97" : "#E5484D" }}>{positive ? "+" : ""}{fmtUsd(value)}</span>;
}
function InfoTip({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block align-middle ml-1">
      <button onClick={() => setOpen((o) => !o)} className="text-[#8A8F98] active:text-[#F0B429]" aria-label="Info"><Info size={13} /></button>
      {open && <span className="absolute z-20 left-1/2 -translate-x-1/2 top-5 w-48 text-[11px] leading-snug bg-[#1C2129] text-[#C7CCD4] border border-[#2A303B] rounded-lg p-2 shadow-lg">{text}</span>}
    </span>
  );
}
function Card({ children, className = "" }) {
  return <div className={`bg-[#131820] border border-[#1F2530] rounded-2xl p-4 ${className}`}>{children}</div>;
}
function Sparkline({ points, positive }) {
  if (!points || points.length < 2) return <div className="w-16 h-6 flex items-center justify-center text-[#4A505C] text-[9px]">···</div>;
  const min = Math.min(...points), max = Math.max(...points), range = max - min || 1;
  const w = 64, h = 24, step = w / (points.length - 1);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(h - ((p - min) / range) * h).toFixed(1)}`).join(" ");
  return <svg width={w} height={h} className="shrink-0"><path d={d} fill="none" stroke={positive ? "#3DDC97" : "#E5484D"} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}
function DataStatusBar({ lastUpdated, isStale, error, loading, onRefresh }) {
  const timeStr = lastUpdated ? lastUpdated.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
  if (error && isStale) {
    return (
      <div className="flex items-center gap-2 bg-[#2A1518] border border-[#4A2226] rounded-xl p-3 text-[11px] text-[#F5A3A6]">
        <WifiOff size={14} className="shrink-0" /><span className="flex-1">⚠ STALE DATA — TRADING PAUSED · {error}</span>
        <button onClick={onRefresh} className="shrink-0 p-1 rounded-md bg-[#331A1E]"><RefreshCw size={12} className={loading ? "animate-spin" : ""} /></button>
      </div>
    );
  }
  if (isStale) {
    return (
      <div className="flex items-center gap-2 bg-[#1C1508] border border-[#3A2C0F] rounded-xl p-3 text-[11px] text-[#E0B84B]">
        <AlertTriangle size={14} className="shrink-0" /><span className="flex-1">⚠ Market data is stale (last update {timeStr})</span>
        <button onClick={onRefresh} className="shrink-0 p-1 rounded-md bg-[#2A2410]"><RefreshCw size={12} className={loading ? "animate-spin" : ""} /></button>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between text-[11px] text-[#6B7280] px-1">
      <span>Market data updated: <span className="tabular-nums text-[#8A8F98]">{timeStr}</span></span>
      <button onClick={onRefresh} className="flex items-center gap-1 text-[#8A8F98] active:text-[#F0B429]"><RefreshCw size={11} className={loading ? "animate-spin" : ""} /></button>
    </div>
  );
}
function BotStatusBar({ displayStatus, userStatus, setStatus, dataStale, pauseReason, onResume }) {
  const meta = statusMeta[displayStatus];
  return (
    <Card>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: meta.dot, boxShadow: `0 0 8px ${meta.dot}` }} />
          <div><div className="text-[11px] text-[#8A8F98]">Bot status</div><div className="text-sm font-semibold" style={{ color: meta.color }}>{meta.label}{dataStale ? " (data stale)" : ""}</div></div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setStatus(userStatus === "PAUSED" ? "RUNNING" : "PAUSED")} className="p-2 rounded-full bg-[#1C2129] active:bg-[#242B36]" aria-label="Pause bot"><PauseCircle size={18} color="#C7CCD4" /></button>
          <button onClick={() => setStatus("STOPPED")} className="p-2 rounded-full bg-[#2A1518] active:bg-[#331A1E]" aria-label="Stop bot"><Octagon size={18} color="#E5484D" /></button>
        </div>
      </div>
      {pauseReason && (
        <div className="mt-3 pt-3 border-t border-[#1F2530] flex items-center justify-between gap-2">
          <div className="text-[11px] text-[#E0B84B] flex items-center gap-1.5">
            <AlertTriangle size={12} className="shrink-0" />
            {pauseReason === "DAILY_LOSS_LIMIT" ? "Daily loss limit reached — new trades halted until tomorrow" : "Max consecutive losses reached — new trades halted"}
          </div>
          <button onClick={onResume} className="shrink-0 flex items-center gap-1 text-[10px] px-2 py-1 rounded-md bg-[#1C2129] text-[#C7CCD4]">
            <PlayCircle size={12} /> Resume
          </button>
        </div>
      )}
    </Card>
  );
}
function PortfolioCard({ equity }) {
  const rows = [
    ["Available cash", fmtUsd(equity.availableCash), null],
    ["Open position value", fmtUsd(equity.openPositionValue), null],
    ["Unrealized P/L", null, equity.unrealizedPL],
    ["Realized P/L", null, equity.realizedPL],
  ];
  return (
    <Card>
      <div className="flex items-baseline justify-between mb-1"><div className="text-[11px] text-[#8A8F98]">Virtual balance</div><div className="text-[11px] px-2 py-0.5 rounded-full bg-[#1C2129] text-[#F0B429]">PAPER</div></div>
      <div className="text-3xl font-semibold tabular-nums mb-1">{fmtUsd(equity.totalEquity)}</div>
      <div className="flex items-center gap-2 mb-4"><PLText value={equity.totalPL} /><span className="text-xs text-[#8A8F98]">({equity.returnPct >= 0 ? "+" : ""}{equity.returnPct.toFixed(2)}% return)</span></div>
      <div className="grid grid-cols-2 gap-y-3 gap-x-2 pt-3 border-t border-[#1F2530]">
        {rows.map(([label, value, pl]) => (
          <div key={label}><div className="text-[11px] text-[#8A8F98]">{label}</div>{pl !== null ? <PLText value={pl} /> : <div className="text-sm tabular-nums">{value}</div>}</div>
        ))}
      </div>
    </Card>
  );
}
function MarketOverview({ marketData, onRemove, onAdd, loading, onSelect }) {
  const [adding, setAdding] = useState(false);
  const [symbol, setSymbol] = useState("");
  const [addError, setAddError] = useState(null);
  const handleAdd = () => {
    const result = onAdd(symbol);
    if (!result.ok) { setAddError(result.error); return; }
    setSymbol(""); setAddError(null); setAdding(false);
  };
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-medium">Market overview</div>
        <button onClick={() => { setAdding((a) => !a); setAddError(null); }} className="p-1.5 rounded-full bg-[#1C2129] active:bg-[#242B36]" aria-label="Add symbol">{adding ? <X size={14} color="#C7CCD4" /> : <Plus size={14} color="#C7CCD4" />}</button>
      </div>
      {adding && (
        <div className="mb-3">
          <div className="flex gap-2">
            <input value={symbol} onChange={(e) => { setSymbol(e.target.value.toUpperCase()); setAddError(null); }} onKeyDown={(e) => e.key === "Enter" && handleAdd()} placeholder="e.g. ADA/USDT" className="flex-1 bg-[#0D1117] border border-[#2A303B] rounded-lg px-3 py-2 text-sm outline-none focus:border-[#F0B429]" />
            <button onClick={handleAdd} className="px-3 rounded-lg bg-[#F0B429] text-[#0D1117] text-sm font-medium">Add</button>
          </div>
          {addError && <div className="text-[11px] text-[#E5484D] mt-1.5">{addError}</div>}
        </div>
      )}
      <div className="divide-y divide-[#1F2530]">
        {marketData.map((m) => (
          <button key={m.symbol} onClick={() => onSelect && onSelect(m.symbol)} className="w-full flex items-center justify-between py-2.5 gap-2 text-left">
            <div><div className="text-sm font-medium">{toDisplaySymbol(m.symbol)}</div>{m.error && <div className="text-[10px] text-[#E5484D]">{m.error}</div>}</div>
            <div className="flex items-center gap-3">
              <Sparkline points={m.sparkline} positive={(m.change24h ?? 0) >= 0} />
              <div className="text-right">
                <div className="text-sm tabular-nums">{loading && m.price === null ? "…" : fmtPrice(m.price)}</div>
                {m.change24h !== null && <div className="text-xs tabular-nums flex items-center gap-0.5 justify-end" style={{ color: m.change24h >= 0 ? "#3DDC97" : "#E5484D" }}>{m.change24h >= 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}{Math.abs(m.change24h).toFixed(2)}%</div>}
              </div>
              <span onClick={(e) => { e.stopPropagation(); onRemove(m.symbol); }} className="text-[#8A8F98] active:text-[#E5484D]"><X size={14} /></span>
            </div>
          </button>
        ))}
        {marketData.length === 0 && <div className="text-xs text-[#8A8F98] py-3 text-center">No symbols selected. Tap + to add one.</div>}
      </div>
    </Card>
  );
}
function OpenPositionsCard({ positions, marketData }) {
  return (
    <Card>
      <div className="flex items-center justify-between mb-3"><div className="text-sm font-medium">Open positions</div><div className="text-[10px] text-[#4A505C]">{positions.length}/{MARKET_SETTINGS.maxOpenPositions}</div></div>
      {positions.length === 0 ? (
        <div className="text-xs text-[#8A8F98] py-2 text-center">No open positions. The bot opens one automatically when the strategy engine agrees across timeframes.</div>
      ) : (
        <div className="space-y-3">
          {positions.map((p) => {
            const cur = marketData[p.symbol]?.price ?? p.entry;
            const grossU = p.side === "LONG" ? (cur - p.entry) * p.qty : (p.entry - cur) * p.qty;
            const estExitFee = cur * p.qty * (MARKET_SETTINGS.feeRatePct / 100);
            const netU = grossU - estExitFee;
            return (
              <div key={p.id} className="pb-3 border-b border-[#1F2530] last:border-0 last:pb-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{toDisplaySymbol(p.symbol)}</span>
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ color: p.side === "LONG" ? "#3DDC97" : "#E5484D", backgroundColor: p.side === "LONG" ? "#132A22" : "#2A1518" }}>{p.side}</span>
                  </div>
                  <PLText value={netU} />
                </div>
                <div className="grid grid-cols-3 gap-2 text-[11px] text-[#8A8F98] mb-1.5">
                  <div>Entry <span className="text-[#C7CCD4] tabular-nums block">{fmtPrice(p.entry)}</span></div>
                  <div>Current <span className="text-[#C7CCD4] tabular-nums block">{fmtPrice(cur)}</span></div>
                  <div>Qty <span className="text-[#C7CCD4] tabular-nums block">{fmtNum(p.qty, 5)}</span></div>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-[#6B7280]">
                  <span>SL {fmtPrice(p.stopLoss)}</span><span>TP {fmtPrice(p.takeProfit)}</span><span>Opened {fmtTime(p.entryTime)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
function RecentTradesCard({ trades }) {
  return (
    <Card>
      <div className="text-sm font-medium mb-3">Recent trades</div>
      {trades.length === 0 ? (
        <div className="text-xs text-[#8A8F98] py-2 text-center">No closed trades yet.</div>
      ) : (
        <div className="space-y-3">
          {trades.map((t) => (
            <div key={t.id} className="pb-3 border-b border-[#1F2530] last:border-0 last:pb-0">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{toDisplaySymbol(t.symbol)}</span>
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ color: t.side === "LONG" ? "#3DDC97" : "#E5484D", backgroundColor: t.side === "LONG" ? "#132A22" : "#2A1518" }}>{t.side}</span>
                </div>
                <PLText value={t.pl} />
              </div>
              <div className="text-xs text-[#8A8F98] tabular-nums mb-1">Entry {fmtPrice(t.entry)} → Exit {fmtPrice(t.exit)} · {fmtTime(t.exitTime)}</div>
              <div className="text-xs text-[#6B7280]">{t.exitReason} · fees {fmtUsd(t.fees)}</div>
              {t.reasonLabels?.length > 0 && <div className="text-[10px] text-[#4A505C] mt-1">{t.reasonLabels.join(" · ")}</div>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
function PlaceholderView({ title, note }) {
  return <div className="px-4 pt-6 pb-4"><div className="text-lg font-semibold mb-2">{title}</div><Card className="text-sm text-[#8A8F98] leading-relaxed">{note}</Card></div>;
}

// --- Phase 8: performance analytics -----------------------------------------
//
// Everything here is derived from the real closed-trade history the paper
// trading engine (Phase 5) has produced -- no mock numbers. With zero closed
// trades every chart below just says so instead of rendering an empty axis.

function buildPerformanceData(closedTrades, startingBalance) {
  const chronological = [...closedTrades].reverse(); // engine stores newest-first
  let equity = startingBalance, peak = startingBalance, maxDD = 0;
  const equityCurve = [{ t: 0, equity }];
  const dailyPL = {}, dailyCount = {}, bySymbol = {}, byExitReason = {};
  let wins = 0, losses = 0;
  const plValues = [];

  chronological.forEach((t, i) => {
    equity += t.pl;
    equityCurve.push({ t: i + 1, equity });
    peak = Math.max(peak, equity);
    if (peak > 0) maxDD = Math.max(maxDD, ((peak - equity) / peak) * 100);
    const day = new Date(t.exitTime).toISOString().slice(0, 10);
    dailyPL[day] = (dailyPL[day] || 0) + t.pl;
    dailyCount[day] = (dailyCount[day] || 0) + 1;
    const sym = bySymbol[t.symbol] || { trades: 0, wins: 0, losses: 0, pl: 0 };
    sym.trades++; sym.pl += t.pl; if (t.pl > 0) sym.wins++; else sym.losses++;
    bySymbol[t.symbol] = sym;
    const r = byExitReason[t.exitReason] || { count: 0, pl: 0 };
    r.count++; r.pl += t.pl; byExitReason[t.exitReason] = r;
    if (t.pl > 0) wins++; else losses++;
    plValues.push(t.pl);
  });

  const dailyPLSeries = Object.entries(dailyPL).sort(([a], [b]) => a.localeCompare(b)).map(([day, pl]) => ({ day: day.slice(5), pl }));
  const tradeFrequency = Object.entries(dailyCount).sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({ day: day.slice(5), count }));

  let distribution = [];
  if (plValues.length) {
    const min = Math.min(...plValues, 0), max = Math.max(...plValues, 0);
    const bucketCount = Math.min(8, Math.max(4, plValues.length));
    const width = (max - min) / bucketCount || 1;
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({ from: min + i * width, to: min + (i + 1) * width, count: 0 }));
    for (const v of plValues) {
      let idx = Math.floor((v - min) / width);
      if (idx >= bucketCount) idx = bucketCount - 1;
      if (idx < 0) idx = 0;
      buckets[idx].count++;
    }
    distribution = buckets.map((b) => ({ label: `${b.from >= 0 ? "+" : ""}${b.from.toFixed(0)}`, count: b.count, positive: (b.from + b.to) / 2 >= 0 }));
  }

  return {
    equityCurve, dailyPLSeries, tradeFrequency, distribution, bySymbol, byExitReason,
    totalTrades: chronological.length, wins, losses,
    winRate: chronological.length ? (wins / chronological.length) * 100 : 0,
    totalPL: equity - startingBalance, maxDrawdownPct: maxDD, finalEquity: equity,
  };
}

function BotStatisticsCard({ perf }) {
  return (
    <Card>
      <div className="text-sm font-medium mb-3">Bot statistics</div>
      <div className="grid grid-cols-3 gap-3 text-center">
        <div><div className="text-lg font-semibold tabular-nums">{perf.totalTrades}</div><div className="text-[10px] text-[#6B7280]">Trades</div></div>
        <div><div className="text-lg font-semibold tabular-nums text-[#3DDC97]">{perf.wins}</div><div className="text-[10px] text-[#6B7280]">Wins</div></div>
        <div><div className="text-lg font-semibold tabular-nums text-[#E5484D]">{perf.losses}</div><div className="text-[10px] text-[#6B7280]">Losses</div></div>
        <div><div className="text-lg font-semibold tabular-nums">{perf.winRate.toFixed(1)}%</div><div className="text-[10px] text-[#6B7280]">Win rate</div></div>
        <div><PLText value={perf.totalPL} size="text-lg" /><div className="text-[10px] text-[#6B7280]">Total P/L</div></div>
        <div><div className="text-lg font-semibold tabular-nums text-[#E5484D]">{perf.maxDrawdownPct.toFixed(1)}%</div><div className="text-[10px] text-[#6B7280]">Max drawdown</div></div>
      </div>
    </Card>
  );
}

function EmptyChart({ text }) {
  return <div className="h-28 flex items-center justify-center text-xs text-[#4A505C]">{text}</div>;
}

function EquityCurveCard({ curve }) {
  return (
    <Card>
      <div className="text-sm font-medium mb-2">Equity curve</div>
      {curve.length < 2 ? <EmptyChart text="No closed trades yet — nothing to chart." /> : (
        <div className="h-32 -mx-2">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={curve}>
              <YAxis domain={["auto", "auto"]} hide />
              <Tooltip contentStyle={{ background: "#1C2129", border: "1px solid #2A303B", borderRadius: 8, fontSize: 11 }} formatter={(v) => [fmtUsd(v), "Equity"]} labelFormatter={() => ""} />
              <Line type="monotone" dataKey="equity" stroke="#F0B429" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

function DailyPLCard({ series }) {
  return (
    <Card>
      <div className="text-sm font-medium mb-2">Daily P/L</div>
      {series.length === 0 ? <EmptyChart text="No closed trades yet." /> : (
        <div className="h-28 -mx-2">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={series}>
              <XAxis dataKey="day" tick={{ fontSize: 9, fill: "#6B7280" }} axisLine={false} tickLine={false} />
              <YAxis hide />
              <Tooltip contentStyle={{ background: "#1C2129", border: "1px solid #2A303B", borderRadius: 8, fontSize: 11 }} formatter={(v) => [fmtUsd(v), "P/L"]} />
              <Bar dataKey="pl" radius={[3, 3, 0, 0]}>
                {series.map((d, i) => <Cell key={i} fill={d.pl >= 0 ? "#3DDC97" : "#E5484D"} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

function TradeFrequencyCard({ series }) {
  return (
    <Card>
      <div className="text-sm font-medium mb-2">Trade frequency</div>
      {series.length === 0 ? <EmptyChart text="No closed trades yet." /> : (
        <div className="h-24 -mx-2">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={series}>
              <XAxis dataKey="day" tick={{ fontSize: 9, fill: "#6B7280" }} axisLine={false} tickLine={false} />
              <YAxis hide allowDecimals={false} />
              <Tooltip contentStyle={{ background: "#1C2129", border: "1px solid #2A303B", borderRadius: 8, fontSize: 11 }} formatter={(v) => [v, "Trades"]} />
              <Bar dataKey="count" fill="#5B9DFF" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

function DistributionCard({ distribution }) {
  return (
    <Card>
      <div className="text-sm font-medium mb-2">Win/loss distribution</div>
      {distribution.length === 0 ? <EmptyChart text="No closed trades yet." /> : (
        <div className="h-28 -mx-2">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={distribution}>
              <XAxis dataKey="label" tick={{ fontSize: 8, fill: "#6B7280" }} axisLine={false} tickLine={false} />
              <YAxis hide allowDecimals={false} />
              <Tooltip contentStyle={{ background: "#1C2129", border: "1px solid #2A303B", borderRadius: 8, fontSize: 11 }} formatter={(v) => [v, "Trades"]} labelFormatter={(l) => `~${fmtUsd(Number(l))}`} />
              <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                {distribution.map((d, i) => <Cell key={i} fill={d.positive ? "#3DDC97" : "#E5484D"} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

function BreakdownCard({ title, rows, emptyText }) {
  const entries = Object.entries(rows);
  return (
    <Card>
      <div className="text-sm font-medium mb-2">{title}</div>
      {entries.length === 0 ? <div className="text-xs text-[#8A8F98] py-2 text-center">{emptyText}</div> : (
        <div className="space-y-2">
          {entries.map(([key, r]) => (
            <div key={key} className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <span className="text-[#C7CCD4]">{key}</span>
                <span className="text-[10px] text-[#6B7280]">{r.trades ? `${r.trades} trades · ${((r.wins / r.trades) * 100).toFixed(0)}% win` : `${r.count} trades`}</span>
              </div>
              <PLText value={r.pl} />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function PerformanceView({ closedTrades }) {
  const perf = useMemo(() => buildPerformanceData(closedTrades, STARTING_BALANCE), [closedTrades]);
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 bg-[#0F1A2A] border border-[#1E3050] rounded-xl p-3 text-[11px] text-[#8CB4E8] leading-snug">
        <Info size={14} className="shrink-0 mt-0.5" />
        <span>Based on closed (realized) paper trades only — open positions' unrealized P/L isn't included in this curve since it isn't final yet.</span>
      </div>
      <BotStatisticsCard perf={perf} />
      <EquityCurveCard curve={perf.equityCurve} />
      <DailyPLCard series={perf.dailyPLSeries} />
      <TradeFrequencyCard series={perf.tradeFrequency} />
      <DistributionCard distribution={perf.distribution} />
      <BreakdownCard title="Performance by cryptocurrency" rows={Object.fromEntries(Object.entries(perf.bySymbol).map(([s, v]) => [toDisplaySymbol(s), v]))} emptyText="No closed trades yet." />
      <BreakdownCard title="Performance by exit reason" rows={perf.byExitReason} emptyText="No closed trades yet." />
      <div className="text-[10px] text-[#4A505C] px-1">Every trade currently uses the same 4H/1H/15M/5M setup, so a breakdown by timeframe isn't meaningful yet — it will become useful once multiple strategy/timeframe configurations exist.</div>
    </div>
  );
}

// --- technical + strategy view -----------------------------------------

function Gauge({ value, min, max, zones }) {
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const zone = zones.find((z) => value >= z.from && value <= z.to) || zones[0];
  return (
    <div>
      <div className="h-1.5 rounded-full bg-[#1F2530] overflow-hidden relative"><div className="h-full rounded-full" style={{ width: `${pct * 100}%`, backgroundColor: zone.color }} /></div>
      <div className="text-[10px] mt-1" style={{ color: zone.color }}>{zone.label}</div>
    </div>
  );
}
function IndicatorChart({ series }) {
  const data = series.closes.map((c, i) => ({ i, close: c, ema20: series.ema20[i], ema50: series.ema50[i], ema200: series.ema200[i] })).slice(-120);
  return (
    <div className="h-40 -mx-2">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
          <YAxis domain={["auto", "auto"]} hide />
          <Tooltip contentStyle={{ background: "#1C2129", border: "1px solid #2A303B", borderRadius: 8, fontSize: 11 }} labelFormatter={() => ""} formatter={(v, name) => [fmtPrice(v), name]} />
          <Line type="monotone" dataKey="close" stroke="#C7CCD4" strokeWidth={1.5} dot={false} isAnimationActive={false} name="Price" />
          <Line type="monotone" dataKey="ema20" stroke="#F0B429" strokeWidth={1} dot={false} isAnimationActive={false} connectNulls name="EMA 20" />
          <Line type="monotone" dataKey="ema50" stroke="#5B9DFF" strokeWidth={1} dot={false} isAnimationActive={false} connectNulls name="EMA 50" />
          <Line type="monotone" dataKey="ema200" stroke="#B265F0" strokeWidth={1} dot={false} isAnimationActive={false} connectNulls name="EMA 200" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
function MultiTimeframePanel({ mtf }) {
  const trendColor = { BULLISH: "#3DDC97", BEARISH: "#E5484D", SIDEWAYS: "#8A8F98", UNKNOWN: "#6B7280" };
  return (
    <Card>
      <div className="text-sm font-medium mb-3">Multi-timeframe read</div>
      <div className="grid grid-cols-4 gap-2">
        {TIMEFRAMES.map((tf) => {
          const ind = mtf[tf];
          return (
            <div key={tf} className="bg-[#0D1117] rounded-lg p-2 text-center">
              <div className="text-[10px] text-[#6B7280]">{TF_LABEL[tf]}</div>
              <div className="text-[9px] text-[#4A505C] mb-1">{TF_ROLE[tf]}</div>
              {ind ? (<><div className="text-[10px] font-semibold" style={{ color: trendColor[ind.trend] }}>{ind.trend}</div><div className="text-[9px] text-[#8A8F98] tabular-nums mt-0.5">RSI {fmtNum(ind.latest.rsi14, 0)}</div></>) : (<div className="text-[10px] text-[#4A505C]">…</div>)}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
function AIReviewBlock({ ruleDecision, aiReview, aiError, aiConfigured }) {
  if (ruleDecision.decision === "WAIT") return null;
  if (!aiConfigured) {
    return (
      <div className="rounded-lg p-2.5 mb-3 bg-[#0D1117] border border-[#1F2530] text-[11px] text-[#8A8F98] flex items-start gap-2">
        <Brain size={13} color="#6B7280" className="shrink-0 mt-0.5" />
        <span>AI confirmation is off — trading on the rule engine alone. Add an Anthropic API key in Settings to enable this layer.</span>
      </div>
    );
  }
  if (aiError) {
    return (
      <div className="rounded-lg p-2.5 mb-3 bg-[#2A1518] border border-[#4A2226] text-[11px] text-[#F5A3A6] flex items-start gap-2">
        <WifiOff size={13} className="shrink-0 mt-0.5" /><span>AI unavailable ({aiError}) — failing safe, treating as WAIT.</span>
      </div>
    );
  }
  if (!aiReview) {
    return <div className="rounded-lg p-2.5 mb-3 bg-[#0D1117] text-[11px] text-[#8A8F98] flex items-center gap-2"><RefreshCw size={12} className="animate-spin" /> Waiting on AI confirmation…</div>;
  }
  const agrees = aiReview.decision === ruleDecision.decision;
  return (
    <div className="rounded-lg p-3 mb-3 bg-[#0D1117] border border-[#1F2530]">
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-xs font-medium flex items-center gap-1.5"><Brain size={13} color="#B265F0" /> AI review</div>
        <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: agrees ? "#3DDC97" : "#E5484D", backgroundColor: agrees ? "#132A22" : "#2A1518" }}>{agrees ? "Confirmed" : "Vetoed → WAIT"}</span>
      </div>
      <div className="text-[11px] text-[#C7CCD4] mb-2">{aiReview.reason}</div>
      <div className="flex items-center gap-3 text-[10px] text-[#8A8F98]">
        <span>Confidence <span className="text-[#F0B429] font-medium">{aiReview.confidence}</span></span>
        <InfoTip text="Confidence reflects how well the data supports this setup — it is not a probability of profit or a guarantee of any outcome." />
      </div>
      {aiReview.warnings?.length > 0 && <div className="mt-2 pt-2 border-t border-[#1F2530] space-y-1">{aiReview.warnings.map((w) => (<div key={w} className="text-[10px] text-[#6B7280]">⚠ {w}</div>))}</div>}
    </div>
  );
}

function StrategyDecisionCard({ ruleDecision, aiReview, aiError, aiConfigured, finalDecision, riskSettings, hasOpenPosition }) {
  const d = finalDecision;
  const color = d.decision === "LONG" ? "#3DDC97" : d.decision === "SHORT" ? "#E5484D" : "#F0B429";
  const bg = d.decision === "LONG" ? "#0F2A20" : d.decision === "SHORT" ? "#2A1518" : "#1C1508";
  return (
    <Card>
      <div className="flex items-center justify-between mb-3"><div className="text-sm font-medium">Strategy decision</div><div className="text-[10px] text-[#4A505C]">rule engine + AI review</div></div>
      <div className="rounded-xl p-3 mb-3" style={{ backgroundColor: bg }}>
        <div className="text-lg font-bold tracking-wide" style={{ color }}>{d.decision}</div>
        <div className="text-xs mt-0.5" style={{ color }}>{d.reasonSummary}</div>
        {hasOpenPosition && d.decision !== "WAIT" && <div className="text-[10px] mt-1 text-[#8A8F98]">Already holding a position in this symbol — bot will not add to it.</div>}
      </div>

      <AIReviewBlock ruleDecision={ruleDecision} aiReview={aiReview} aiError={aiError} aiConfigured={aiConfigured} />

      {ruleDecision.conditions.length > 0 && (
        <div className="space-y-1.5 mb-3">
          <div className="text-[10px] text-[#6B7280] mb-1">Rule-based checklist</div>
          {ruleDecision.conditions.map((c) => (
            <div key={c.label} className="flex items-center gap-2 text-xs">{c.pass ? <Check size={13} color="#3DDC97" /> : <Minus size={13} color="#6B7280" />}<span className={c.pass ? "text-[#C7CCD4]" : "text-[#6B7280]"}>{c.label}</span></div>
          ))}
        </div>
      )}
      {d.decision !== "WAIT" && (
        <div className="pt-3 border-t border-[#1F2530] space-y-2">
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div><div className="text-[#6B7280]">Entry zone</div><div className="tabular-nums text-[#C7CCD4]">{fmtPrice(d.entry)}</div></div>
            <div><div className="text-[#6B7280]">Stop loss</div><div className="tabular-nums text-[#E5484D]">{fmtPrice(d.stopLoss)}</div></div>
            <div><div className="text-[#6B7280]">Take profit</div><div className="tabular-nums text-[#3DDC97]">{fmtPrice(d.takeProfit)}</div></div>
          </div>
          <div className="text-[11px] text-[#8A8F98] bg-[#0D1117] rounded-lg p-2.5">
            Risk {fmtUsd(d.riskAmount)} ({riskSettings.riskPerTradePct}% of equity) to potentially target {fmtUsd(d.riskAmount * d.riskReward)} — risk/reward 1:{d.riskReward}.
            <div className="text-[#6B7280] mt-1">Suggested size: {fmtNum(d.positionSize, 5)} units (~{fmtUsd(d.notional)} notional). Stop/target are ATR-based from the strategy engine — the AI never sets executable price levels itself.</div>
          </div>
        </div>
      )}
      <div className="pt-3 mt-3 border-t border-[#1F2530] space-y-1">
        {d.warnings.map((w) => (<div key={w} className="text-[10px] text-[#6B7280] flex items-start gap-1"><AlertTriangle size={11} className="shrink-0 mt-0.5" />{w}</div>))}
      </div>
    </Card>
  );
}

// Capped to what Kraken's public API can actually deliver on 5m candles
// without pagination (~720 candles = 2.5 days at 5-minute resolution) --
// see the fetchHistoricalCandles comment above for why.
const BACKTEST_DAY_OPTIONS = [1, 2];

function BacktestStatRow({ label, value, tone }) {
  return (
    <div className="flex items-center justify-between text-xs py-1">
      <span className="text-[#8A8F98]">{label}</span>
      <span className={`tabular-nums font-medium ${tone === "good" ? "text-[#3DDC97]" : tone === "bad" ? "text-[#E5484D]" : "text-[#C7CCD4]"}`}>{value}</span>
    </div>
  );
}

function BacktestStatsBlock({ title, stats, startEquity }) {
  if (!stats) return <Card className="text-xs text-[#8A8F98]">{title}: not enough trades in this segment.</Card>;
  return (
    <Card>
      <div className="text-sm font-medium mb-2">{title}</div>
      <BacktestStatRow label="Total trades" value={stats.totalTrades} />
      <BacktestStatRow label="Wins / Losses" value={`${stats.wins} / ${stats.losses}`} />
      <BacktestStatRow label="Win rate" value={`${stats.winRate.toFixed(1)}%`} />
      <BacktestStatRow label="Total return" value={`${stats.totalReturnPct >= 0 ? "+" : ""}${stats.totalReturnPct.toFixed(2)}%`} tone={stats.totalReturnPct >= 0 ? "good" : "bad"} />
      <BacktestStatRow label="Profit factor" value={isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : "∞"} />
      <BacktestStatRow label="Avg win / Avg loss" value={`${fmtUsd(stats.avgWin)} / ${fmtUsd(stats.avgLoss)}`} />
      <BacktestStatRow label="Largest win / loss" value={`${fmtUsd(stats.largestWin)} / ${fmtUsd(stats.largestLoss)}`} />
      <BacktestStatRow label="Max consecutive wins" value={stats.maxConsecWins} />
      <BacktestStatRow label="Max consecutive losses" value={stats.maxConsecLosses} />
      <BacktestStatRow label="Ending equity" value={fmtUsd(stats.finalEquity)} />
    </Card>
  );
}

function BacktestModal({ symbols, onClose, activeStrategyParams }) {
  const [symbol, setSymbol] = useState(symbols[0] || "BTCUSDT");
  const [days, setDays] = useState(BACKTEST_DAY_OPTIONS[0]);
  const [startingBalance, setStartingBalance] = useState(10000);
  const [feeRatePct, setFeeRatePct] = useState(MARKET_SETTINGS.feeRatePct);
  const [slippagePct, setSlippagePct] = useState(MARKET_SETTINGS.slippagePct);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const run = async () => {
    setRunning(true); setError(null); setResult(null);
    try {
      const endTime = Date.now();
      const startTime = endTime - days * 86400000;
      const candlesByTf = {};
      for (const tf of TIMEFRAMES) {
        candlesByTf[tf] = await fetchHistoricalCandles(symbol, tf, startTime, endTime);
      }
      if (candlesByTf["5m"].length < 250) throw new Error("Not enough 5M history returned for this symbol/range.");
      const cfg = {
        ...activeStrategyParams,
        startingBalance: clamp(Number(startingBalance) || 10000, 100, 10000000),
        feeRatePct: clamp(Number(feeRatePct) || 0, 0, 5),
        slippagePct: clamp(Number(slippagePct) || 0, 0, 5),
      };
      const r = runBacktest(symbol, candlesByTf, cfg);
      setResult(r);
    } catch (err) {
      setError(err.message || "Backtest failed");
    } finally {
      setRunning(false);
    }
  };

  const chartData = result?.equityCurve.filter((_, i) => i % Math.max(1, Math.floor(result.equityCurve.length / 150)) === 0).map((p) => ({ equity: p.equity })) || [];

  return (
    <div className="fixed inset-0 bg-black/70 z-50 overflow-y-auto">
      <div className="max-w-md mx-auto min-h-screen bg-[#0D1117] p-4 pb-10">
        <div className="flex items-center justify-between mb-3">
          <div className="text-base font-semibold">Backtest</div>
          <button onClick={onClose} className="p-2 rounded-full bg-[#1C2129]"><X size={16} color="#C7CCD4" /></button>
        </div>

        <div className="flex items-start gap-2 bg-[#1C1508] border border-[#3A2C0F] rounded-xl p-3 text-[11px] text-[#E0B84B] leading-snug mb-3">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>Past performance does not guarantee future results. This runs the live strategy engine's exact rules against history — it is not re-tuned or optimized for this period, but a strategy can still overfit to any single stretch of data. Treat this as a sanity check, not a guarantee.</span>
        </div>

        <Card className="mb-3 space-y-3">
          <div>
            <div className="text-[11px] text-[#8A8F98] mb-1.5">Symbol</div>
            <div className="flex gap-2 flex-wrap">
              {symbols.map((s) => (
                <button key={s} onClick={() => setSymbol(s)} className="px-3 py-1.5 rounded-full text-xs font-medium border" style={{ borderColor: symbol === s ? "#F0B429" : "#1F2530", color: symbol === s ? "#F0B429" : "#8A8F98", backgroundColor: symbol === s ? "#1C1508" : "transparent" }}>{toDisplaySymbol(s)}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-[#8A8F98] mb-1.5">Date range</div>
            <div className="flex gap-2">
              {BACKTEST_DAY_OPTIONS.map((d) => (
                <button key={d} onClick={() => setDays(d)} className="flex-1 py-2 rounded-lg text-xs font-medium" style={{ backgroundColor: days === d ? "#F0B429" : "#0D1117", color: days === d ? "#0D1117" : "#8A8F98", border: "1px solid #1F2530" }}>Last {d}d</button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <div className="text-[11px] text-[#8A8F98] mb-1">Balance</div>
              <input type="number" value={startingBalance} onChange={(e) => setStartingBalance(e.target.value)} className="w-full bg-[#0D1117] border border-[#2A303B] rounded-lg px-2 py-1.5 text-xs outline-none focus:border-[#F0B429]" />
            </div>
            <div>
              <div className="text-[11px] text-[#8A8F98] mb-1">Fee %</div>
              <input type="number" step="0.01" value={feeRatePct} onChange={(e) => setFeeRatePct(e.target.value)} className="w-full bg-[#0D1117] border border-[#2A303B] rounded-lg px-2 py-1.5 text-xs outline-none focus:border-[#F0B429]" />
            </div>
            <div>
              <div className="text-[11px] text-[#8A8F98] mb-1">Slippage %</div>
              <input type="number" step="0.01" value={slippagePct} onChange={(e) => setSlippagePct(e.target.value)} className="w-full bg-[#0D1117] border border-[#2A303B] rounded-lg px-2 py-1.5 text-xs outline-none focus:border-[#F0B429]" />
            </div>
          </div>
          <div className="text-[10px] text-[#4A505C]">Strategy: {activeStrategyParams.name} (rule-based multi-timeframe engine). Compare other presets in Settings → Strategy Lab.</div>
          <button onClick={run} disabled={running} className="w-full py-2.5 rounded-lg bg-[#F0B429] text-[#0D1117] text-sm font-semibold disabled:opacity-50">
            {running ? "Running backtest…" : "Run backtest"}
          </button>
        </Card>

        {error && <Card className="text-xs text-[#E5484D] mb-3">{error}</Card>}

        {result && (
          <div className="space-y-3">
            {result.equityCurve.length > 1 && (
              <Card>
                <div className="text-sm font-medium mb-2">Equity curve</div>
                <div className="h-32 -mx-2">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData}>
                      <YAxis domain={["auto", "auto"]} hide />
                      <Line type="monotone" dataKey="equity" stroke="#F0B429" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="text-[11px] text-[#8A8F98] mt-1">Max drawdown: <span className="text-[#E5484D] font-medium">{result.overallMaxDrawdown.toFixed(2)}%</span></div>
              </Card>
            )}
            <BacktestStatsBlock title="Overall" stats={result.overall} startEquity={Number(startingBalance)} />
            <div className="text-[11px] text-[#6B7280] px-1">In-sample / out-of-sample split (first 70% of trades vs. last 30%, by time) — a rough check for whether performance held up on the later, unseen-during-the-first-pass portion of the window. Same fixed rules were used for both; nothing was re-tuned in between.</div>
            <BacktestStatsBlock title="In-sample (first 70%)" stats={result.inSample} />
            <BacktestStatsBlock title="Out-of-sample (last 30%)" stats={result.outOfSample} />
          </div>
        )}
      </div>
    </div>
  );
}

function TechnicalAnalysisView({ symbols, symbolAnalysis, onRefresh, openPositions, aiConfigured, activeStrategyParams }) {
  const [selected, setSelected] = useState(symbols[0] || null);
  const [detailTf, setDetailTf] = useState("15m");
  const [showBacktest, setShowBacktest] = useState(false);

  useEffect(() => { if (!symbols.includes(selected)) setSelected(symbols[0] || null); }, [symbols]); // eslint-disable-line react-hooks/exhaustive-deps

  const entry = selected ? symbolAnalysis[selected] : null;
  const mtfIndicators = entry?.indicators || {};
  const waitPlaceholder = { decision: "WAIT", reasonSummary: "Waiting for first analysis cycle…", conditions: [], warnings: [] };
  const ruleDecision = entry?.ruleDecision || waitPlaceholder;
  const finalDecision = entry?.finalDecision || waitPlaceholder;
  const isStale = entry?.lastUpdated ? Date.now() - entry.lastUpdated.getTime() > STALE_MS + ANALYSIS_POLL_MS : true;
  const detailInd = mtfIndicators[detailTf];
  const trendColor = { BULLISH: "#3DDC97", BEARISH: "#E5484D", SIDEWAYS: "#8A8F98", UNKNOWN: "#6B7280" };
  const hasOpenPosition = selected ? openPositions.some((p) => p.symbol === selected) : false;

  return (
    <div className="px-4 pt-2 space-y-3">
      <div className="flex items-start gap-2 bg-[#0F1A2A] border border-[#1E3050] rounded-xl p-3 text-[11px] text-[#8CB4E8] leading-snug">
        <Info size={14} className="shrink-0 mt-0.5" />
        <span>Runs in the background every {ANALYSIS_POLL_MS / 1000}s for every watched symbol. The rule engine proposes a direction; Claude reviews the same indicator data and can confirm or veto it to WAIT — it never invents a direction the rule engine didn't already flag, and it never sets the stop/target itself.</span>
      </div>
      <button onClick={() => setShowBacktest(true)} className="w-full py-2.5 rounded-xl bg-[#131820] border border-[#1F2530] text-sm font-medium text-[#C7CCD4] flex items-center justify-center gap-2">
        <History size={15} color="#F0B429" /> Backtest this strategy
      </button>
      {showBacktest && <BacktestModal symbols={symbols} onClose={() => setShowBacktest(false)} activeStrategyParams={activeStrategyParams} />}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {symbols.map((s) => (
          <button key={s} onClick={() => setSelected(s)} className="shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border" style={{ borderColor: selected === s ? "#F0B429" : "#1F2530", color: selected === s ? "#F0B429" : "#8A8F98", backgroundColor: selected === s ? "#1C1508" : "transparent" }}>
            {toDisplaySymbol(s)}
          </button>
        ))}
      </div>
      {!selected ? (
        <Card className="text-sm text-[#8A8F98]">Add a symbol on the Markets tab to analyze it here.</Card>
      ) : (
        <>
          <DataStatusBar lastUpdated={entry?.lastUpdated || null} isStale={isStale} error={entry?.error} loading={entry?.loading} onRefresh={() => onRefresh(selected)} />
          <StrategyDecisionCard ruleDecision={ruleDecision} aiReview={entry?.aiReview} aiError={entry?.aiError} aiConfigured={aiConfigured} finalDecision={finalDecision} riskSettings={activeStrategyParams} hasOpenPosition={hasOpenPosition} />
          <MultiTimeframePanel mtf={mtfIndicators} />
          <div className="flex gap-2">
            {TIMEFRAMES.map((tf) => (
              <button key={tf} onClick={() => setDetailTf(tf)} className="flex-1 py-2 rounded-lg text-xs font-medium" style={{ backgroundColor: detailTf === tf ? "#F0B429" : "#131820", color: detailTf === tf ? "#0D1117" : "#8A8F98", border: "1px solid #1F2530" }}>{TF_LABEL[tf]}</button>
            ))}
          </div>
          {!detailInd ? (
            <Card className="text-sm text-[#8A8F98]">{entry?.loading ? "Loading candles…" : `Not enough ${TF_LABEL[detailTf]} candle history yet for a full indicator read.`}</Card>
          ) : (
            <>
              <Card>
                <div className="flex items-center justify-between mb-1">
                  <div><div className="text-2xl font-semibold tabular-nums">{fmtPrice(detailInd.latest.price)}</div><div className="text-[11px] text-[#8A8F98]">{toDisplaySymbol(selected)} · {TF_LABEL[detailTf]}</div></div>
                  <div className="text-right"><div className="text-[11px] text-[#8A8F98]">Regime</div><div className="text-sm font-semibold" style={{ color: trendColor[detailInd.trend] }}>{detailInd.trend}</div></div>
                </div>
                <IndicatorChart series={detailInd.series} />
                <div className="flex gap-4 text-[10px] text-[#8A8F98] justify-center mt-1">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full inline-block" style={{ background: "#F0B429" }} />EMA20</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full inline-block" style={{ background: "#5B9DFF" }} />EMA50</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full inline-block" style={{ background: "#B265F0" }} />EMA200</span>
                </div>
              </Card>
              <Card>
                <div className="text-sm font-medium mb-3">Momentum</div>
                <div className="mb-4">
                  <div className="flex items-center justify-between text-xs mb-1"><span className="text-[#8A8F98]">RSI (14) <InfoTip text="Below 30 = oversold, above 70 = overbought. Neither is a buy/sell signal on its own." /></span><span className="tabular-nums font-medium">{fmtNum(detailInd.latest.rsi14, 1)}</span></div>
                  <Gauge value={detailInd.latest.rsi14 ?? 50} min={0} max={100} zones={[{ from: 0, to: 30, color: "#3DDC97", label: "Oversold" }, { from: 30, to: 70, color: "#8A8F98", label: "Neutral" }, { from: 70, to: 100, color: "#E5484D", label: "Overbought" }]} />
                </div>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div><div className="text-[#8A8F98] mb-0.5">MACD line</div><div className="tabular-nums">{fmtNum(detailInd.latest.macd, 2)}</div></div>
                  <div><div className="text-[#8A8F98] mb-0.5">Signal line</div><div className="tabular-nums">{fmtNum(detailInd.latest.signal, 2)}</div></div>
                  <div className="col-span-2"><div className="text-[#8A8F98] mb-0.5">Histogram</div><div className="tabular-nums font-medium" style={{ color: (detailInd.latest.histogram ?? 0) >= 0 ? "#3DDC97" : "#E5484D" }}>{(detailInd.latest.histogram ?? 0) >= 0 ? "+" : ""}{fmtNum(detailInd.latest.histogram, 2)} — {(detailInd.latest.histogram ?? 0) >= 0 ? "bullish momentum" : "bearish momentum"}</div></div>
                </div>
              </Card>
              <Card>
                <div className="text-sm font-medium mb-3">Volatility</div>
                <div className="grid grid-cols-2 gap-3 text-xs mb-3">
                  <div><div className="text-[#8A8F98] mb-0.5">ATR (14) <InfoTip text="Average true range — typical price movement per candle. Used for sizing stops, not direction." /></div><div className="tabular-nums">{fmtPrice(detailInd.latest.atr14)}</div></div>
                  <div><div className="text-[#8A8F98] mb-0.5">BB width</div><div className="tabular-nums">{fmtPrice((detailInd.latest.bbUpper ?? 0) - (detailInd.latest.bbLower ?? 0))}</div></div>
                </div>
                <div className="flex items-center justify-between text-xs bg-[#0D1117] rounded-lg p-2.5">
                  <div><div className="text-[#6B7280]">Lower</div><div className="tabular-nums">{fmtPrice(detailInd.latest.bbLower)}</div></div>
                  <div className="text-center"><div className="text-[#6B7280]">Middle</div><div className="tabular-nums">{fmtPrice(detailInd.latest.bbMiddle)}</div></div>
                  <div className="text-right"><div className="text-[#6B7280]">Upper</div><div className="tabular-nums">{fmtPrice(detailInd.latest.bbUpper)}</div></div>
                </div>
              </Card>
              <Card>
                <div className="text-sm font-medium mb-3">Volume</div>
                <div className="flex items-center justify-between text-xs">
                  <div><div className="text-[#8A8F98] mb-0.5">Latest candle</div><div className="tabular-nums">{fmtNum(detailInd.latest.volume, 1)}</div></div>
                  <div className="text-right"><div className="text-[#8A8F98] mb-0.5">20-period avg</div><div className="tabular-nums">{fmtNum(detailInd.latest.volMA, 1)}</div></div>
                </div>
                <div className="text-[11px] mt-2" style={{ color: detailInd.latest.volume > (detailInd.latest.volMA ?? Infinity) ? "#3DDC97" : "#8A8F98" }}>{detailInd.latest.volume > (detailInd.latest.volMA ?? Infinity) ? "Above average — participation confirms the move" : "Below average — move lacks volume confirmation"}</div>
              </Card>
              <Card>
                <div className="text-sm font-medium mb-3">Price action</div>
                <div className="grid grid-cols-2 gap-3 text-xs mb-3">
                  <div><div className="text-[#8A8F98] mb-1">Resistance zones</div>{detailInd.levels.resistance.length ? detailInd.levels.resistance.map((r) => <div key={r} className="tabular-nums text-[#E5484D]">{fmtPrice(r)}</div>) : <div className="text-[#4A505C]">—</div>}</div>
                  <div><div className="text-[#8A8F98] mb-1">Support zones</div>{detailInd.levels.support.length ? detailInd.levels.support.map((s) => <div key={s} className="tabular-nums text-[#3DDC97]">{fmtPrice(s)}</div>) : <div className="text-[#4A505C]">—</div>}</div>
                </div>
                <div className="pt-3 border-t border-[#1F2530] space-y-1.5">
                  <div className="flex items-center justify-between text-xs"><span className="text-[#8A8F98]">Breakout</span><span className="font-medium" style={{ color: detailInd.breakout.type === "BULLISH_BREAKOUT" ? "#3DDC97" : detailInd.breakout.type === "BEARISH_BREAKDOWN" ? "#E5484D" : "#8A8F98" }}>{detailInd.breakout.label}</span></div>
                  <div className="flex items-center justify-between text-xs"><span className="text-[#8A8F98]">Candlestick pattern</span><span className="font-medium text-[#C7CCD4]">{detailInd.pattern}</span></div>
                </div>
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}

// --- Phase 9: self-test suite ------------------------------------------
//
// Lightweight assertion-based tests for the pure functions this whole app
// depends on (indicator math, the trading engine's open/close/risk rules,
// input validation). No test framework needed -- each test is just a
// function that throws on failure. Run on demand from Settings, not on
// every load, so it never costs the user anything they didn't ask for.

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

const SELF_TESTS = [
  {
    name: "sma: matches hand-computed average",
    fn: () => {
      const out = sma([1, 2, 3, 4, 5], 3);
      assert(out[1] === null, "expected null before warm-up");
      assert(approx(out[2], 2), `expected 2, got ${out[2]}`);
      assert(approx(out[4], 4), `expected 4, got ${out[4]}`);
    },
  },
  {
    name: "ema: seeds with SMA then converges toward the trend",
    fn: () => {
      const values = Array.from({ length: 30 }, (_, i) => 100 + i);
      const out = ema(values, 10);
      assert(out[8] === null, "should be null before period");
      assert(out[9] !== null, "should seed at index period-1");
      assert(out[29] > out[9], "EMA should trend upward with rising input");
    },
  },
  {
    name: "rsi: stays within 0-100 and hits extremes on one-directional data",
    fn: () => {
      const allUp = Array.from({ length: 30 }, (_, i) => 100 + i);
      const rUp = rsi(allUp, 14);
      assert(approx(rUp[29], 100, 0.5), `expected ~100 on all-gains series, got ${rUp[29]}`);
      const allDown = Array.from({ length: 30 }, (_, i) => 200 - i);
      const rDown = rsi(allDown, 14);
      assert(approx(rDown[29], 0, 0.5), `expected ~0 on all-losses series, got ${rDown[29]}`);
    },
  },
  {
    name: "atr: never negative",
    fn: () => {
      const candles = Array.from({ length: 30 }, (_, i) => ({ high: 105 + i, low: 95 + i, close: 100 + i }));
      const out = atr(candles, 14);
      out.filter((v) => v !== null).forEach((v) => assert(v >= 0, `ATR went negative: ${v}`));
    },
  },
  {
    name: "bollinger: upper >= middle >= lower",
    fn: () => {
      const closes = Array.from({ length: 30 }, () => 100 + Math.random() * 10 - 5);
      const { upper, middle, lower } = bollinger(closes, 20, 2);
      for (let i = 19; i < closes.length; i++) {
        assert(upper[i] >= middle[i] && middle[i] >= lower[i], `band ordering broken at index ${i}`);
      }
    },
  },
  {
    name: "computeStrategyDecision: WAITs when a timeframe is missing (no look-ahead-free data)",
    fn: () => {
      const d = computeStrategyDecision({ "4h": null, "1h": null, "15m": null, "5m": null }, DEFAULT_STRATEGY_PARAMS, 10000);
      assert(d.decision === "WAIT", "should refuse to decide without full timeframe data");
    },
  },
  {
    name: "tryOpenPositions: never opens when bot status is not RUNNING",
    fn: () => {
      const state = initialTradingState();
      const analysis = { BTCUSDT: { finalDecision: { decision: "LONG", entry: 100, stopLoss: 95, takeProfit: 110, riskReward: 2, riskAmount: 100, positionSize: 20, notional: 2000, conditions: [] } } };
      const market = { BTCUSDT: { price: 100 } };
      const next = tryOpenPositions(state, analysis, market, "PAUSED");
      assert(next.openPositions.length === 0, "must not open a position while paused");
    },
  },
  {
    name: "tryOpenPositions: respects max open positions cap",
    fn: () => {
      let state = initialTradingState();
      state = { ...state, openPositions: Array.from({ length: MARKET_SETTINGS.maxOpenPositions }, (_, i) => ({ symbol: `X${i}`, side: "LONG", entry: 1, qty: 1, notional: 1, stopLoss: 0.5, takeProfit: 2, entryTime: Date.now() })) };
      const analysis = { BTCUSDT: { finalDecision: { decision: "LONG", entry: 100, stopLoss: 95, takeProfit: 110, riskReward: 2, riskAmount: 100, positionSize: 20, notional: 2000, conditions: [] } } };
      const market = { BTCUSDT: { price: 100 } };
      const next = tryOpenPositions(state, analysis, market, "RUNNING");
      assert(next.openPositions.length === MARKET_SETTINGS.maxOpenPositions, "must not exceed max open positions");
    },
  },
  {
    name: "checkExits: closes a LONG when price falls through stop-loss",
    fn: () => {
      let state = initialTradingState();
      state = { ...state, availableCash: 8000, openPositions: [{ id: "1", symbol: "BTCUSDT", side: "LONG", entry: 100, qty: 10, notional: 1000, entryFee: 1, stopLoss: 95, takeProfit: 110, entryTime: Date.now() }] };
      const next = checkExits(state, { BTCUSDT: { price: 90 } }, DEFAULT_STRATEGY_PARAMS);
      assert(next.openPositions.length === 0, "position should have closed");
      assert(next.closedTrades.length === 1, "should record one closed trade");
      assert(next.closedTrades[0].pl < 0, "closing below entry on a LONG must be a loss");
    },
  },
  {
    name: "checkExits: closes a SHORT when price falls through take-profit",
    fn: () => {
      let state = initialTradingState();
      state = { ...state, availableCash: 8000, openPositions: [{ id: "1", symbol: "ETHUSDT", side: "SHORT", entry: 100, qty: 10, notional: 1000, entryFee: 1, stopLoss: 105, takeProfit: 90, entryTime: Date.now() }] };
      const next = checkExits(state, { ETHUSDT: { price: 85 } }, DEFAULT_STRATEGY_PARAMS);
      assert(next.openPositions.length === 0, "position should have closed");
      assert(next.closedTrades[0].pl > 0, "closing below entry on a SHORT must be a win");
    },
  },
  {
    name: "checkExits: leaves position open when price data is missing (fail-safe)",
    fn: () => {
      let state = initialTradingState();
      state = { ...state, openPositions: [{ id: "1", symbol: "BTCUSDT", side: "LONG", entry: 100, qty: 10, notional: 1000, entryFee: 1, stopLoss: 95, takeProfit: 110, entryTime: Date.now() }] };
      const next = checkExits(state, {}, DEFAULT_STRATEGY_PARAMS);
      assert(next.openPositions.length === 1, "must not touch a position when there's no fresh price");
    },
  },
  {
    name: "computeEquity: equals available cash when nothing is open",
    fn: () => {
      const state = { ...initialTradingState(), availableCash: 9000 };
      const eq = computeEquity(state, {});
      assert(approx(eq.totalEquity, 9000), `expected 9000, got ${eq.totalEquity}`);
    },
  },
  {
    name: "validateSymbolInput: accepts a normal pair, rejects junk and duplicates-at-cap",
    fn: () => {
      assert(validateSymbolInput("ada/usdt", 0).ok === true, "ADA/USDT should be valid");
      assert(validateSymbolInput("<script>", 0).ok === false, "should reject non-alphanumeric input");
      assert(validateSymbolInput("", 0).ok === false, "should reject empty input");
      assert(validateSymbolInput("BTCUSDT", MAX_WATCHED_SYMBOLS).ok === false, "should reject once at the watch-list cap");
    },
  },
  {
    name: "toBinanceSymbol / toDisplaySymbol: round-trip on a typical pair",
    fn: () => {
      assert(toBinanceSymbol("BTC/USDT") === "BTCUSDT", "should strip the slash and uppercase");
      assert(toDisplaySymbol("BTCUSDT") === "BTC/USDT", "should reinsert the slash before the quote asset");
    },
  },
];

function runSelfTests() {
  return SELF_TESTS.map((t) => {
    try { t.fn(); return { name: t.name, pass: true }; }
    catch (err) { return { name: t.name, pass: false, error: err.message }; }
  });
}

function DiagnosticsCard() {
  const [results, setResults] = useState(null);
  const [running, setRunning] = useState(false);
  const run = () => {
    setRunning(true);
    // yield a frame so the button's pressed state paints before the (synchronous) suite runs
    setTimeout(() => { setResults(runSelfTests()); setRunning(false); }, 30);
  };
  const passCount = results?.filter((r) => r.pass).length ?? 0;
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-medium">Diagnostics</div>
        {results && <div className="text-[11px] tabular-nums" style={{ color: passCount === results.length ? "#3DDC97" : "#E5484D" }}>{passCount}/{results.length} passing</div>}
      </div>
      <div className="text-[11px] text-[#8A8F98] mb-3">Runs assertion-based checks against the indicator math and the paper trading engine's open/close/risk logic — the same functions the live bot uses, not a separate copy.</div>
      <button onClick={run} disabled={running} className="w-full py-2.5 rounded-lg bg-[#131820] border border-[#1F2530] text-sm font-medium text-[#C7CCD4] disabled:opacity-50">
        {running ? "Running…" : "Run self-tests"}
      </button>
      {results && (
        <div className="mt-3 pt-3 border-t border-[#1F2530] space-y-1.5">
          {results.map((r) => (
            <div key={r.name} className="flex items-start gap-2 text-[11px]">
              {r.pass ? <Check size={13} color="#3DDC97" className="shrink-0 mt-0.5" /> : <X size={13} color="#E5484D" className="shrink-0 mt-0.5" />}
              <div>
                <div className={r.pass ? "text-[#C7CCD4]" : "text-[#E5484D]"}>{r.name}</div>
                {!r.pass && <div className="text-[#8A8F98]">{r.error}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function SecurityCard() {
  const rows = [
    "No exchange API keys, private keys, seed phrases, or passwords are ever transmitted or persisted by this app. Keys pasted into the Exchange connection panel live only in that tab's memory for format-checking and are gone on reload.",
    "Every network call goes to a public, read-only market data endpoint (Kraken), the AI review endpoint, or nowhere (the exchange adapter is a stub — see Exchange connection above) — never anything that can place a real order.",
    "The AI review layer never receives account, balance, key, or any identifying information — only anonymized indicator numbers for the symbol being analyzed.",
    "Symbols you add are validated against a strict allow-list pattern before ever reaching a request URL or being rendered.",
    "All requests carry a hard timeout so a hung connection can never block the app indefinitely — a failed or slow request always fails safe into 'no trade', never a stale one treated as fresh.",
    "LIVE order execution has no working code path in this build, by design — a browser-only artifact has nowhere to hold an exchange secret that qualifies as secure storage, so that piece is deliberately left unbuilt rather than faked.",
  ];
  return (
    <Card>
      <div className="text-sm font-medium mb-3">Security posture</div>
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r} className="flex items-start gap-2 text-[11px] text-[#8A8F98] leading-snug"><Check size={12} color="#3DDC97" className="shrink-0 mt-0.5" />{r}</div>
        ))}
      </div>
    </Card>
  );
}

function LiveModeConfirmModal({ onClose, onAcknowledge }) {
  const [understandRisk, setUnderstandRisk] = useState(false);
  const [noWithdrawal, setNoWithdrawal] = useState(false);
  const [typed, setTyped] = useState("");
  const canConfirm = understandRisk && noWithdrawal && typed.trim().toUpperCase() === "ENABLE LIVE";
  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-[#131820] border border-[#1F2530] rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-3 text-[#E5484D]"><AlertTriangle size={18} /><div className="text-sm font-semibold">Enable LIVE mode?</div></div>
        <div className="text-xs text-[#C7CCD4] leading-relaxed mb-3">
          LIVE mode would place real orders with real funds. This build does not include a working exchange adapter (see Security below), so confirming here cannot actually place any order — but the gate itself works exactly like it would if it did, since that gate should never be the weak point of a real system.
        </div>
        <label className="flex items-start gap-2 mb-2 text-xs text-[#8A8F98]">
          <input type="checkbox" checked={understandRisk} onChange={(e) => setUnderstandRisk(e.target.checked)} className="mt-0.5" />
          I understand LIVE mode risks real money and past paper performance does not guarantee future results.
        </label>
        <label className="flex items-start gap-2 mb-3 text-xs text-[#8A8F98]">
          <input type="checkbox" checked={noWithdrawal} onChange={(e) => setNoWithdrawal(e.target.checked)} className="mt-0.5" />
          My exchange API key has trading permission only — I have NOT granted withdrawal permission.
        </label>
        <div className="text-[11px] text-[#8A8F98] mb-1.5">Type <span className="text-[#C7CCD4] font-medium">ENABLE LIVE</span> to confirm:</div>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} className="w-full bg-[#0D1117] border border-[#2A303B] rounded-lg px-3 py-2 text-xs outline-none focus:border-[#F0B429] mb-4" />
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-lg bg-[#1C2129] text-sm text-[#C7CCD4]">Cancel</button>
          <button onClick={onAcknowledge} disabled={!canConfirm} className="flex-1 py-2.5 rounded-lg bg-[#E5484D] text-sm text-white font-medium disabled:opacity-40">Confirm</button>
        </div>
      </div>
    </div>
  );
}

function ExchangeConnectionCard() {
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [checkResult, setCheckResult] = useState(null);
  const [liveRequested, setLiveRequested] = useState(false);
  const [liveAcknowledged, setLiveAcknowledged] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const checkFormat = () => {
    const keyOk = looksLikeApiKeyFormat(apiKey);
    const secretOk = looksLikeApiKeyFormat(apiSecret);
    setCheckResult({ ok: keyOk && secretOk, keyOk, secretOk });
  };
  const clearKeys = () => { setApiKey(""); setApiSecret(""); setCheckResult(null); };

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-medium">Exchange connection</div>
        <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ color: liveAcknowledged ? "#E5484D" : "#F0B429", backgroundColor: liveAcknowledged ? "#2A1518" : "#1C1508" }}>{liveAcknowledged ? "LIVE requested" : "PAPER"}</span>
      </div>

      <div className="flex items-start gap-2 bg-[#0D1117] rounded-lg p-2.5 text-[11px] text-[#8A8F98] leading-snug mb-3">
        <Info size={13} className="shrink-0 mt-0.5" />
        Testnet keys only. Keys are held in memory for this session and are never saved to storage, sent to the AI, or transmitted anywhere — closing or reloading the tab clears them. No order can actually be placed in this build (see Security posture below for why).
      </div>

      <div className="space-y-2 mb-3">
        <div>
          <div className="text-[11px] text-[#8A8F98] mb-1">Testnet API key</div>
          <input value={apiKey} onChange={(e) => { setApiKey(e.target.value); setCheckResult(null); }} type="password" placeholder="Paste testnet key — not saved" className="w-full bg-[#0D1117] border border-[#2A303B] rounded-lg px-3 py-2 text-xs outline-none focus:border-[#F0B429]" />
        </div>
        <div>
          <div className="text-[11px] text-[#8A8F98] mb-1">Testnet API secret</div>
          <input value={apiSecret} onChange={(e) => { setApiSecret(e.target.value); setCheckResult(null); }} type="password" placeholder="Paste testnet secret — not saved" className="w-full bg-[#0D1117] border border-[#2A303B] rounded-lg px-3 py-2 text-xs outline-none focus:border-[#F0B429]" />
        </div>
      </div>
      <div className="flex gap-2 mb-2">
        <button onClick={checkFormat} disabled={!apiKey || !apiSecret} className="flex-1 py-2 rounded-lg bg-[#1C2129] text-xs font-medium text-[#C7CCD4] disabled:opacity-40">Check format</button>
        <button onClick={clearKeys} className="px-3 py-2 rounded-lg bg-[#1C2129] text-xs font-medium text-[#C7CCD4]">Clear</button>
      </div>
      {checkResult && (
        <div className="text-[11px] mb-3" style={{ color: checkResult.ok ? "#3DDC97" : "#E5484D" }}>
          {checkResult.ok ? "Format looks valid. This checks shape only — no request is made and no connection to an exchange is established." : "Doesn't look like a valid key/secret format."}
        </div>
      )}

      <div className="pt-3 border-t border-[#1F2530]">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-[#C7CCD4]">LIVE mode</div>
            <div className="text-[10px] text-[#6B7280]">Disabled by default. Requires explicit confirmation.</div>
          </div>
          <button
            onClick={() => { if (!liveAcknowledged) setShowConfirm(true); else setLiveAcknowledged(false); }}
            className="px-3 py-1.5 rounded-full text-xs font-medium"
            style={{ backgroundColor: liveAcknowledged ? "#2A1518" : "#1C2129", color: liveAcknowledged ? "#E5484D" : "#8A8F98" }}
          >
            {liveAcknowledged ? "Revert to PAPER" : "Enable…"}
          </button>
        </div>
        {liveAcknowledged && (
          <div className="mt-2 text-[11px] text-[#E0B84B] bg-[#1C1508] border border-[#3A2C0F] rounded-lg p-2.5">
            Confirmed, but nothing changed functionally — this build has no exchange adapter wired up, so it keeps paper trading regardless. See "Security posture" for why that's intentional.
          </div>
        )}
      </div>

      {showConfirm && (
        <LiveModeConfirmModal
          onClose={() => setShowConfirm(false)}
          onAcknowledge={() => { setLiveAcknowledged(true); setShowConfirm(false); }}
        />
      )}
    </Card>
  );
}

function AIConfigCard({ apiKey, setApiKey }) {
  const [draft, setDraft] = useState(apiKey);
  const [visible, setVisible] = useState(false);
  const save = () => setApiKey(draft.trim());
  const clear = () => { setDraft(""); setApiKey(""); };
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-medium">AI configuration</div>
        <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ color: apiKey ? "#3DDC97" : "#8A8F98", backgroundColor: apiKey ? "#132A22" : "#1C2129" }}>{apiKey ? "AI review on" : "Rule engine only"}</span>
      </div>
      <div className="text-[11px] text-[#8A8F98] leading-relaxed mb-3">
        Paste an Anthropic API key (from <span className="text-[#C7CCD4]">console.anthropic.com</span>) to enable the AI confirmation layer. Stored only in this browser's local storage on this machine — never sent anywhere except api.anthropic.com. Without a key, the bot still trades, just on the rule engine alone (no AI veto step).
      </div>
      <div className="flex gap-2 mb-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          type={visible ? "text" : "password"}
          placeholder="sk-ant-..."
          className="flex-1 bg-[#0D1117] border border-[#2A303B] rounded-lg px-3 py-2 text-xs outline-none focus:border-[#F0B429]"
        />
        <button onClick={() => setVisible((v) => !v)} className="px-3 rounded-lg bg-[#1C2129] text-xs text-[#C7CCD4]">{visible ? "Hide" : "Show"}</button>
      </div>
      <div className="flex gap-2">
        <button onClick={save} className="flex-1 py-2 rounded-lg bg-[#F0B429] text-[#0D1117] text-xs font-semibold">Save key</button>
        <button onClick={clear} className="px-3 py-2 rounded-lg bg-[#1C2129] text-xs text-[#C7CCD4]">Clear</button>
      </div>
      <div className="mt-3 pt-3 border-t border-[#1F2530] text-[10px] text-[#6B7280] leading-relaxed">
        ⚠ This calls the Anthropic API directly from your browser, which means the key is visible in this page's network requests. That's fine for running the app yourself on your own machine. If you ever deploy this publicly (Vercel, Netlify, etc.), do not ship your key in the client bundle — put this call behind a small server/serverless function instead. See README.md.
      </div>
    </Card>
  );
}

function StrategyLabModal({ symbols, activeStrategyParams, onActivate, onClose }) {
  const [symbol, setSymbol] = useState(symbols[0] || "BTCUSDT");
  const [days, setDays] = useState(BACKTEST_DAY_OPTIONS[0]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [results, setResults] = useState(null); // [{preset, backtest}]

  const run = async () => {
    setRunning(true); setError(null); setResults(null);
    try {
      const endTime = Date.now();
      const startTime = endTime - days * 86400000;
      const candlesByTf = {};
      for (const tf of TIMEFRAMES) candlesByTf[tf] = await fetchHistoricalCandles(symbol, tf, startTime, endTime);
      if (candlesByTf["5m"].length < 250) throw new Error("Not enough 5M history returned for this symbol/range.");
      // candles are identical for every preset -- only the strategy logic differs -- so fetch once, backtest N times
      const rows = STRATEGY_PRESETS.map((preset) => {
        const cfg = { ...preset, startingBalance: 10000, feeRatePct: MARKET_SETTINGS.feeRatePct, slippagePct: MARKET_SETTINGS.slippagePct };
        return { preset, backtest: runBacktest(symbol, candlesByTf, cfg) };
      });
      rows.sort((a, b) => (b.backtest.overall?.totalReturnPct ?? -Infinity) - (a.backtest.overall?.totalReturnPct ?? -Infinity));
      setResults(rows);
    } catch (err) {
      setError(err.message || "Comparison failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 overflow-y-auto">
      <div className="max-w-md mx-auto min-h-screen bg-[#0D1117] p-4 pb-10">
        <div className="flex items-center justify-between mb-3">
          <div className="text-base font-semibold">Strategy Lab</div>
          <button onClick={onClose} className="p-2 rounded-full bg-[#1C2129]"><X size={16} color="#C7CCD4" /></button>
        </div>

        <div className="flex items-start gap-2 bg-[#1C1508] border border-[#3A2C0F] rounded-xl p-3 text-[11px] text-[#E0B84B] leading-snug mb-3">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>Backtests every preset on the SAME historical data so the comparison is apples-to-apples. Past performance on this window does not predict future results — a preset winning here can still lose money going forward. Activating a preset only takes effect after you tap Activate below; nothing switches automatically.</span>
        </div>

        <Card className="mb-3 space-y-3">
          <div>
            <div className="text-[11px] text-[#8A8F98] mb-1.5">Symbol</div>
            <div className="flex gap-2 flex-wrap">
              {symbols.map((s) => (
                <button key={s} onClick={() => setSymbol(s)} className="px-3 py-1.5 rounded-full text-xs font-medium border" style={{ borderColor: symbol === s ? "#F0B429" : "#1F2530", color: symbol === s ? "#F0B429" : "#8A8F98", backgroundColor: symbol === s ? "#1C1508" : "transparent" }}>{toDisplaySymbol(s)}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-[#8A8F98] mb-1.5">Date range</div>
            <div className="flex gap-2">
              {BACKTEST_DAY_OPTIONS.map((d) => (
                <button key={d} onClick={() => setDays(d)} className="flex-1 py-2 rounded-lg text-xs font-medium" style={{ backgroundColor: days === d ? "#F0B429" : "#0D1117", color: days === d ? "#0D1117" : "#8A8F98", border: "1px solid #1F2530" }}>Last {d}d</button>
              ))}
            </div>
          </div>
          <button onClick={run} disabled={running} className="w-full py-2.5 rounded-lg bg-[#F0B429] text-[#0D1117] text-sm font-semibold disabled:opacity-50">
            {running ? "Running comparison…" : `Compare all ${STRATEGY_PRESETS.length} strategies`}
          </button>
        </Card>

        {error && <Card className="text-xs text-[#E5484D] mb-3">{error}</Card>}

        {results && (
          <div className="space-y-3">
            {results.map(({ preset, backtest }) => {
              const isActive = activeStrategyParams.id === preset.id;
              const stats = backtest.overall;
              return (
                <Card key={preset.id}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-sm font-medium flex items-center gap-2">
                      {preset.name}
                      {isActive && <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#132A22] text-[#3DDC97]">ACTIVE</span>}
                    </div>
                    {stats && <PLText value={stats.totalReturnPct} size="text-sm" />}
                  </div>
                  <div className="text-[11px] text-[#8A8F98] leading-snug mb-2">{preset.description}</div>
                  {!stats ? (
                    <div className="text-xs text-[#6B7280]">No trades triggered in this window.</div>
                  ) : (
                    <div className="grid grid-cols-4 gap-2 text-[11px] mb-3">
                      <div><div className="text-[#6B7280]">Trades</div><div className="text-[#C7CCD4] tabular-nums">{stats.totalTrades}</div></div>
                      <div><div className="text-[#6B7280]">Win rate</div><div className="text-[#C7CCD4] tabular-nums">{stats.winRate.toFixed(0)}%</div></div>
                      <div><div className="text-[#6B7280]">Profit factor</div><div className="text-[#C7CCD4] tabular-nums">{isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : "∞"}</div></div>
                      <div><div className="text-[#6B7280]">Max drawdown</div><div className="text-[#E5484D] tabular-nums">{backtest.overallMaxDrawdown.toFixed(1)}%</div></div>
                    </div>
                  )}
                  <button
                    onClick={() => onActivate(preset)}
                    disabled={isActive}
                    className="w-full py-2 rounded-lg text-xs font-semibold disabled:opacity-40"
                    style={{ backgroundColor: isActive ? "#1C2129" : "#F0B429", color: isActive ? "#8A8F98" : "#0D1117" }}
                  >
                    {isActive ? "Currently active" : "Activate this strategy"}
                  </button>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function SettingsView({ apiKey, setApiKey, symbols, activeStrategyParams, setActiveStrategyParams }) {
  const [showLab, setShowLab] = useState(false);
  return (
    <div className="px-4 pt-2 space-y-3">
      <Card>
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-medium">Active strategy</div>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#132A22] text-[#3DDC97]">{activeStrategyParams.name}</span>
        </div>
        <div className="text-[11px] text-[#8A8F98] leading-snug mb-3">{activeStrategyParams.description}</div>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div><div className="text-[#6B7280] text-[11px]">Risk per trade</div><div className="text-[#C7CCD4]">{activeStrategyParams.riskPerTradePct}%</div></div>
          <div><div className="text-[#6B7280] text-[11px]">Min risk/reward</div><div className="text-[#C7CCD4]">1:{activeStrategyParams.minRiskReward}</div></div>
          <div><div className="text-[#6B7280] text-[11px]">ATR stop multiplier</div><div className="text-[#C7CCD4]">{activeStrategyParams.atrStopMultiplier}x</div></div>
          <div><div className="text-[#6B7280] text-[11px]">Soft conditions required</div><div className="text-[#C7CCD4]">{activeStrategyParams.softPassRequired}/4</div></div>
          <div><div className="text-[#6B7280] text-[11px]">Max daily loss</div><div className="text-[#C7CCD4]">{activeStrategyParams.maxDailyLossPct}%</div></div>
          <div><div className="text-[#6B7280] text-[11px]">Max consecutive losses</div><div className="text-[#C7CCD4]">{activeStrategyParams.maxConsecutiveLosses}</div></div>
          <div><div className="text-[#6B7280] text-[11px]">Max open positions</div><div className="text-[#C7CCD4]">{MARKET_SETTINGS.maxOpenPositions}</div></div>
          <div><div className="text-[#6B7280] text-[11px]">Fees / slippage</div><div className="text-[#C7CCD4]">{MARKET_SETTINGS.feeRatePct}% / {MARKET_SETTINGS.slippagePct}%</div></div>
        </div>
        <button onClick={() => setShowLab(true)} className="w-full py-2.5 rounded-lg bg-[#131820] border border-[#1F2530] text-sm font-medium text-[#C7CCD4] flex items-center justify-center gap-2">
          <History size={15} color="#F0B429" /> Open Strategy Lab
        </button>
        <div className="text-[10px] text-[#4A505C] mt-2">Compares presets by backtest, one tap to activate — never switches on its own.</div>
      </Card>
      <Card>
        <div className="text-sm font-medium mb-3">Other settings</div>
        <div className="grid grid-cols-2 gap-3">
          <div><div className="text-[#6B7280] text-[11px]">Max watched symbols</div><div className="text-[#C7CCD4]">{MAX_WATCHED_SYMBOLS}</div></div>
          <div><div className="text-[#6B7280] text-[11px]">AI review model</div><div className="text-[#C7CCD4]">{CLAUDE_MODEL}</div></div>
        </div>
      </Card>
      <AIConfigCard apiKey={apiKey} setApiKey={setApiKey} />
      <ExchangeConnectionCard />
      <SecurityCard />
      <DiagnosticsCard />
      {showLab && (
        <StrategyLabModal
          symbols={symbols}
          activeStrategyParams={activeStrategyParams}
          onActivate={(preset) => setActiveStrategyParams(preset)}
          onClose={() => setShowLab(false)}
        />
      )}
    </div>
  );
}

// --- app ---------------------------------------------------------------

const NAV = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "markets", label: "Markets", icon: LineChartIcon },
  { key: "positions", label: "Positions", icon: Wallet },
  { key: "trades", label: "Trades", icon: History },
  { key: "ai", label: "AI Analysis", icon: Brain },
  { key: "settings", label: "Settings", icon: SettingsIcon },
];
const DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

export default function App() {
  const [tab, setTab] = useState("dashboard");
  const [tradesSubview, setTradesSubview] = useState("history");
  const [status, setStatus] = useState("RUNNING");
  const [symbols, setSymbols] = useState(DEFAULT_SYMBOLS);
  const [marketData, setMarketData] = useState(
    DEFAULT_SYMBOLS.reduce((acc, s) => ({ ...acc, [s]: { symbol: s, price: null, change24h: null, high: null, low: null, volume: null, sparkline: null, error: null } }), {})
  );
  const [lastUpdated, setLastUpdated] = useState(null);
  const [priceLoading, setPriceLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [symbolAnalysis, setSymbolAnalysis] = useState({});
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [tradingState, setTradingState] = useState(initialTradingState());
  const [storageReady, setStorageReady] = useState(false);
  const [apiKey, setApiKey] = useState(() => { try { return localStorage.getItem(AI_KEY_STORAGE) || ""; } catch { return ""; } });
  const [activeStrategyParams, setActiveStrategyParams] = useState(() => {
    try {
      const raw = localStorage.getItem(STRATEGY_STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        const preset = STRATEGY_PRESETS.find((p) => p.id === saved.id);
        if (preset) return preset;
      }
    } catch { /* fall through to default */ }
    return DEFAULT_STRATEGY_PARAMS;
  });

  const pricePollRef = useRef(null);
  const analysisPollRef = useRef(null);
  const symbolAnalysisRef = useRef(symbolAnalysis);
  const statusRef = useRef(status);
  const apiKeyRef = useRef(apiKey);
  const activeStrategyParamsRef = useRef(activeStrategyParams);
  useEffect(() => { symbolAnalysisRef.current = symbolAnalysis; }, [symbolAnalysis]);
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => {
    activeStrategyParamsRef.current = activeStrategyParams;
    try { localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ id: activeStrategyParams.id })); } catch { /* storage unavailable */ }
  }, [activeStrategyParams]);
  useEffect(() => {
    apiKeyRef.current = apiKey;
    try { apiKey ? localStorage.setItem(AI_KEY_STORAGE, apiKey) : localStorage.removeItem(AI_KEY_STORAGE); } catch { /* storage unavailable */ }
  }, [apiKey]);

  // --- load persisted trading state on mount (browser localStorage) ---
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setTradingState({ ...initialTradingState(), ...JSON.parse(raw) });
    } catch (e) {
      // no saved state yet, or it was corrupted — start fresh
    } finally {
      setStorageReady(true);
    }
  }, []);

  // --- persist trading state whenever it meaningfully changes ---
  const tradingStateRef = useRef(tradingState);
  useEffect(() => {
    tradingStateRef.current = tradingState;
    if (!storageReady) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tradingState)); } catch (e) { /* storage full or unavailable */ }
  }, [tradingState, storageReady]);

  // --- live prices: poll every 15s, then run exit-checks + rollover + open-attempts ---
  const loadPrices = useCallback(async (currentSymbols) => {
    setPriceLoading(true);
    try {
      const tickers = await fetchTickers(currentSymbols);
      const sparklines = await Promise.all(currentSymbols.map((s) => fetchSparkline(s).catch(() => null)));
      const nextMarketData = {};
      currentSymbols.forEach((s, i) => {
        const t = tickers[s];
        nextMarketData[s] = t ? { symbol: s, ...t, sparkline: sparklines[i], error: null } : { symbol: s, price: null, change24h: null, high: null, low: null, volume: null, sparkline: null, error: "Unknown symbol on exchange" };
      });
      setMarketData(nextMarketData);
      setLastUpdated(new Date());
      setFetchError(null);

      // engine tick: rollover -> exits -> (if RUNNING) open attempts, using freshest data directly
      setTradingState((prev) => {
        const equityNow = computeEquity(prev, nextMarketData).totalEquity;
        let s = rolloverDay(prev, equityNow);
        s = checkExits(s, nextMarketData, activeStrategyParamsRef.current);
        s = tryOpenPositions(s, symbolAnalysisRef.current, nextMarketData, statusRef.current);
        return s;
      });
    } catch (err) {
      setFetchError(err.message || "Failed to reach exchange");
    } finally {
      setPriceLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPrices(symbols);
    pricePollRef.current = setInterval(() => loadPrices(symbols), PRICE_POLL_MS);
    return () => clearInterval(pricePollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbols.join(",")]);

  // --- background multi-timeframe analysis: every 60s for every watched symbol ---
  const runAnalysis = useCallback(async (targetSymbols) => {
    setAnalysisLoading(true);
    const currentApiKey = apiKeyRef.current;
    const currentStrategyParams = activeStrategyParamsRef.current;
    const results = await Promise.all(
      targetSymbols.map(async (symbol) => {
        try {
          const candleSets = await Promise.all(TIMEFRAMES.map((tf) => fetchCandles(symbol, tf, 220)));
          const indicators = {};
          TIMEFRAMES.forEach((tf, i) => { indicators[tf] = candleSets[i].length > 210 ? computeIndicators(candleSets[i]) : null; });
          const equityNow = computeEquity(tradingStateRef.current, marketData).totalEquity;
          const ruleDecision = computeStrategyDecision(indicators, currentStrategyParams, equityNow || STARTING_BALANCE);

          let aiReview = null, aiError = null;
          const aiConfigured = Boolean(currentApiKey);
          if (ruleDecision.decision !== "WAIT" && aiConfigured) {
            try { aiReview = await callAIAnalysis(symbol, indicators, ruleDecision, currentApiKey); }
            catch (err) { aiError = err.message || "AI request failed"; }
          }
          const { final: finalDecision } = combineDecisions(ruleDecision, aiReview, aiError, aiConfigured);
          return [symbol, { indicators, ruleDecision, aiReview, aiError, finalDecision, lastUpdated: new Date(), loading: false, error: null }];
        } catch (err) {
          const waitDecision = { decision: "WAIT", reasonSummary: "Analysis failed", conditions: [], warnings: [err.message] };
          return [symbol, { indicators: {}, ruleDecision: waitDecision, aiReview: null, aiError: null, finalDecision: waitDecision, lastUpdated: null, loading: false, error: err.message }];
        }
      })
    );
    setSymbolAnalysis((prev) => {
      const next = { ...prev };
      results.forEach(([symbol, data]) => { next[symbol] = data; });
      return next;
    });
    setAnalysisLoading(false);
  }, [marketData]);

  useEffect(() => {
    runAnalysis(symbols);
    analysisPollRef.current = setInterval(() => runAnalysis(symbols), ANALYSIS_POLL_MS);
    return () => clearInterval(analysisPollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbols.join(",")]);

  const refreshOneSymbol = useCallback((symbol) => { runAnalysis([symbol]); }, [runAnalysis]);

  const isPriceStale = useMemo(() => (!lastUpdated ? true : Date.now() - lastUpdated.getTime() > STALE_MS), [lastUpdated, tab]);
  const equity = useMemo(() => computeEquity(tradingState, marketData), [tradingState, marketData]);
  const displayStatus = status === "RUNNING" && analysisLoading ? "ANALYZING" : status;

  const handleSetStatus = (next) => {
    setStatus(next);
    if (next === "STOPPED") setTradingState((prev) => ({ ...prev, lastStoppedAt: Date.now() }));
  };
  const handleResumeTrading = () => setTradingState((prev) => ({ ...prev, pauseReason: null, consecutiveLosses: 0 }));
  const handleResetSimulation = () => {
    setTradingState(initialTradingState());
    setConfirmReset(false);
  };

  const addSymbol = (raw) => {
    const result = validateSymbolInput(raw, symbols.length);
    if (!result.ok) return result;
    if (symbols.includes(result.symbol)) return { ok: false, error: "Already watching this symbol." };
    setSymbols((prev) => [...prev, result.symbol]);
    return { ok: true };
  };
  const removeSymbol = (bs) => setSymbols((prev) => prev.filter((s) => s !== bs));
  const goToAnalysis = () => setTab("ai");

  const marketList = symbols.map((s) => marketData[s] || { symbol: s, price: null, change24h: null, sparkline: null, error: null });

  return (
    <div className="min-h-screen bg-[#0D1117] text-[#E6E9EE] font-sans" style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div className="max-w-md mx-auto pb-24">
        <div className="px-4 pt-5 pb-3 flex items-center justify-between">
          <div><div className="text-xs text-[#8A8F98]">Paper Trading Bot</div><div className="text-base font-semibold">Phase 10 — Exchange Scaffolding</div></div>
        </div>

        {tab === "dashboard" && (
          <div className="px-4 space-y-3">
            <div className="flex items-start gap-2 bg-[#1C1508] border border-[#3A2C0F] rounded-xl p-3 text-[11px] text-[#E0B84B] leading-snug">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span>Simulation only — virtual money, no real orders. Trades require both the rule engine and an AI review to agree; AI confidence is never a guarantee of profit. Crypto trading involves substantial risk; paper-trading results do not guarantee future performance.</span>
            </div>
            {tradingState.lastEvent && Date.now() - tradingState.lastEvent.time < 20000 && (
              <div className="flex items-center gap-2 bg-[#0F1A2A] border border-[#1E3050] rounded-xl p-2.5 text-[11px] text-[#8CB4E8]">
                <Info size={13} className="shrink-0" />{tradingState.lastEvent.text}
              </div>
            )}
            <DataStatusBar lastUpdated={lastUpdated} isStale={isPriceStale} error={fetchError} loading={priceLoading} onRefresh={() => loadPrices(symbols)} />
            <BotStatusBar displayStatus={displayStatus} userStatus={status} setStatus={handleSetStatus} dataStale={isPriceStale} pauseReason={tradingState.pauseReason} onResume={handleResumeTrading} />
            <PortfolioCard equity={equity} />
            <MarketOverview marketData={marketList} onRemove={removeSymbol} onAdd={addSymbol} loading={priceLoading} onSelect={goToAnalysis} />
            {tradingState.openPositions.length > 0 && <OpenPositionsCard positions={tradingState.openPositions} marketData={marketData} />}
            <RecentTradesCard trades={tradingState.closedTrades.slice(0, 5)} />
            <div className="flex gap-2 pt-1">
              <button onClick={() => handleSetStatus("STOPPED")} className="flex-1 py-3 rounded-xl bg-[#2A1518] text-[#E5484D] text-sm font-semibold active:bg-[#331A1E]">🛑 STOP BOT</button>
              <button onClick={() => setConfirmReset(true)} className="px-4 py-3 rounded-xl bg-[#1C2129] text-[#C7CCD4] text-sm font-medium active:bg-[#242B36]">Reset</button>
            </div>
          </div>
        )}

        {tab === "markets" && (
          <div className="px-4 pt-2 space-y-3">
            <DataStatusBar lastUpdated={lastUpdated} isStale={isPriceStale} error={fetchError} loading={priceLoading} onRefresh={() => loadPrices(symbols)} />
            <MarketOverview marketData={marketList} onRemove={removeSymbol} onAdd={addSymbol} loading={priceLoading} onSelect={goToAnalysis} />
            <div className="text-[11px] text-[#6B7280] px-1 flex items-center gap-1">Tap a symbol for indicators + strategy decision <ChevronRight size={12} /></div>
          </div>
        )}

        {tab === "positions" && (
          <div className="px-4 pt-2 space-y-3">
            <OpenPositionsCard positions={tradingState.openPositions} marketData={marketData} />
            {tradingState.lastStoppedAt && <div className="text-[11px] text-[#6B7280] px-1">Bot last stopped at {new Date(tradingState.lastStoppedAt).toLocaleTimeString()}</div>}
          </div>
        )}

        {tab === "trades" && (
          <div className="px-4 pt-2 space-y-3">
            <div className="flex gap-2">
              <button onClick={() => setTradesSubview("history")} className="flex-1 py-2 rounded-lg text-xs font-medium" style={{ backgroundColor: tradesSubview === "history" ? "#F0B429" : "#131820", color: tradesSubview === "history" ? "#0D1117" : "#8A8F98", border: "1px solid #1F2530" }}>Trade log</button>
              <button onClick={() => setTradesSubview("performance")} className="flex-1 py-2 rounded-lg text-xs font-medium" style={{ backgroundColor: tradesSubview === "performance" ? "#F0B429" : "#131820", color: tradesSubview === "performance" ? "#0D1117" : "#8A8F98", border: "1px solid #1F2530" }}>Performance</button>
            </div>
            {tradesSubview === "history" ? <RecentTradesCard trades={tradingState.closedTrades} /> : <PerformanceView closedTrades={tradingState.closedTrades} />}
          </div>
        )}

        {tab === "ai" && <TechnicalAnalysisView symbols={symbols} symbolAnalysis={symbolAnalysis} onRefresh={refreshOneSymbol} openPositions={tradingState.openPositions} aiConfigured={Boolean(apiKey)} activeStrategyParams={activeStrategyParams} />}

        {tab === "settings" && <SettingsView apiKey={apiKey} setApiKey={setApiKey} symbols={symbols} activeStrategyParams={activeStrategyParams} setActiveStrategyParams={setActiveStrategyParams} />}
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-[#0F141B]/95 backdrop-blur border-t border-[#1F2530]">
        <div className="max-w-md mx-auto grid grid-cols-6">
          {NAV.map(({ key, label, icon: Icon }) => {
            const active = tab === key;
            return (
              <button key={key} onClick={() => setTab(key)} className="flex flex-col items-center justify-center gap-1 py-2.5">
                <Icon size={18} color={active ? "#F0B429" : "#6B7280"} />
                <span className="text-[9px]" style={{ color: active ? "#F0B429" : "#6B7280" }}>{label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {confirmReset && (
        <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50">
          <div className="max-w-md w-full mx-4 mb-6 sm:mb-0 bg-[#131820] border border-[#1F2530] rounded-2xl p-5">
            <div className="text-sm font-semibold mb-2">Reset simulation?</div>
            <div className="text-xs text-[#8A8F98] mb-4 leading-relaxed">This will close all open positions, clear trade history, and restore your virtual balance to {fmtUsd(STARTING_BALANCE)}. This cannot be undone.</div>
            <div className="flex gap-2">
              <button onClick={() => setConfirmReset(false)} className="flex-1 py-2.5 rounded-lg bg-[#1C2129] text-sm text-[#C7CCD4]">Cancel</button>
              <button onClick={handleResetSimulation} className="flex-1 py-2.5 rounded-lg bg-[#E5484D] text-sm text-white font-medium">Reset</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
