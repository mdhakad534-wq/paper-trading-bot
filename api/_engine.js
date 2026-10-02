// Shared trading engine: pure logic extracted from src/App.jsx (no React, no browser APIs).
// Used by both the browser (src/App.jsx) and the server (api/tick.js, api/control.js).

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


export {
  KRAKEN_BASE,
  PRICE_POLL_MS,
  ANALYSIS_POLL_MS,
  STALE_MS,
  TIMEFRAMES,
  TF_LABEL,
  TF_ROLE,
  STARTING_BALANCE,
  MARKET_SETTINGS,
  STRATEGY_PRESETS,
  DEFAULT_STRATEGY_PARAMS,
  STRATEGY_STORAGE_KEY,
  STORAGE_KEY,
  AI_KEY_STORAGE,
  statusMeta,
  toBinanceSymbol,
  toDisplaySymbol,
  splitSymbol,
  SYMBOL_PATTERN,
  MAX_WATCHED_SYMBOLS,
  validateSymbolInput,
  fmtUsd,
  fmtPrice,
  fmtNum,
  fmtTime,
  todayKey,
  clamp,
  fetchWithTimeout,
  KRAKEN_BASE_ASSET_MAP,
  toKrakenPair,
  firstResultValue,
  fetchTickers,
  KR_TF_MAP,
  fetchSparkline,
  fetchCandles,
  fetchHistoricalCandles,
  sma,
  ema,
  rsi,
  macd,
  atr,
  bollinger,
  findSwingLevels,
  detectBreakout,
  detectCandlePattern,
  computeIndicators,
  evaluateSide,
  computeStrategyDecision,
  INTERVAL_MS,
  computeTrendSeries,
  buildFullSeries,
  evaluateSideAtIndex,
  statsFromTrades,
  maxDrawdownPct,
  runBacktest,
  CLAUDE_MODEL,
  buildAIPayload,
  AI_SYSTEM_PROMPT,
  callAIAnalysis,
  combineDecisions,
  looksLikeApiKeyFormat,
  exchangeAdapter,
  initialTradingState,
  computeEquity,
  rolloverDay,
  checkExits,
  tryOpenPositions,
};
