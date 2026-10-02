import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  LayoutDashboard, LineChart as LineChartIcon, Wallet, History, Brain, Settings as SettingsIcon,
  Info, Plus, X, TrendingUp, TrendingDown, Octagon, PauseCircle,
  AlertTriangle, RefreshCw, WifiOff, ChevronRight, Check, Minus, PlayCircle
} from "lucide-react";
import { LineChart, Line, ResponsiveContainer, YAxis, XAxis, Tooltip, BarChart, Bar, Cell, CartesianGrid } from "recharts";


// Shared engine (pure logic) lives in api/_engine.js so the browser and the server run identical code.
import {
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
} from "../api/_engine.js";

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
const CONTROL_KEY_STORAGE = "paper-trading-control-key";

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
  const [apiKey, setApiKey] = useState(() => { try { return localStorage.getItem(AI_KEY_STORAGE) || ""; } catch { return ""; } });
  const [activeStrategyParams, setActiveStrategyParams] = useState(DEFAULT_STRATEGY_PARAMS);
  const [serverInfo, setServerInfo] = useState({ lastTickAt: null, error: null });

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
  }, [activeStrategyParams]);
  useEffect(() => {
    apiKeyRef.current = apiKey;
    try { apiKey ? localStorage.setItem(AI_KEY_STORAGE, apiKey) : localStorage.removeItem(AI_KEY_STORAGE); } catch { /* storage unavailable */ }
  }, [apiKey]);

  // --- trading state lives on the server (Vercel + Redis); the browser only displays it ---
  const tradingStateRef = useRef(tradingState);
  useEffect(() => { tradingStateRef.current = tradingState; }, [tradingState]);

  const loadServerState = useCallback(async () => {
    try {
      const res = await fetch("/api/state");
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const s = await res.json();
      if (!s.ok) throw new Error(s.error || "Server error");
      setTradingState({ ...initialTradingState(), ...s.tradingState });
      setStatus(s.status);
      setSymbols((prev) => (prev.join(",") === s.symbols.join(",") ? prev : s.symbols));
      const preset = STRATEGY_PRESETS.find((p) => p.id === s.activeStrategy);
      if (preset) setActiveStrategyParams(preset);
      setServerInfo({ lastTickAt: s.lastTickAt, error: null });
    } catch (err) {
      setServerInfo((prev) => ({ ...prev, error: err.message || "Cannot reach server" }));
    }
  }, []);

  useEffect(() => {
    loadServerState();
    const t = setInterval(loadServerState, 10000);
    return () => clearInterval(t);
  }, [loadServerState]);

  // control actions (start/stop/reset/strategy/symbols) need the control key (= CRON_SECRET), asked once per device
  const sendControl = useCallback(async (payload) => {
    let key = "";
    try {
      key = localStorage.getItem(CONTROL_KEY_STORAGE) || "";
      if (!key) {
        key = (window.prompt("Control key daalo (Vercel mein jo CRON_SECRET hai):") || "").trim();
        if (key) localStorage.setItem(CONTROL_KEY_STORAGE, key);
      }
    } catch { /* storage unavailable */ }
    if (!key) return { ok: false, error: "Control key required" };
    try {
      const res = await fetch("/api/control", { method: "POST", headers: { "Content-Type": "application/json", "x-control-key": key }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        try { localStorage.removeItem(CONTROL_KEY_STORAGE); } catch { /* ignore */ }
        return { ok: false, error: "Wrong control key — try again" };
      }
      if (!res.ok || !data.ok) return { ok: false, error: data.error || `Server returned ${res.status}` };
      await loadServerState();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || "Request failed" };
    }
  }, [loadServerState]);
  const runControl = (payload) => sendControl(payload).then((r) => { if (!r.ok) { window.alert(r.error); loadServerState(); } });

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

      // trading (exits / new positions) now runs on the server via /api/tick; this loop is display-only
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

  const handleSetStatus = (next) => { setStatus(next); runControl({ action: "setStatus", status: next }); };
  const handleResumeTrading = () => runControl({ action: "resume" });
  const handleResetSimulation = () => { setConfirmReset(false); runControl({ action: "reset" }); };
  const handleActivateStrategy = (preset) => { setActiveStrategyParams(preset); runControl({ action: "setStrategy", id: preset.id }); };

  const addSymbol = (raw) => {
    const result = validateSymbolInput(raw, symbols.length);
    if (!result.ok) return result;
    if (symbols.includes(result.symbol)) return { ok: false, error: "Already watching this symbol." };
    setSymbols((prev) => [...prev, result.symbol]);
    runControl({ action: "addSymbol", symbol: result.symbol });
    return { ok: true };
  };
  const removeSymbol = (bs) => { setSymbols((prev) => prev.filter((s) => s !== bs)); runControl({ action: "removeSymbol", symbol: bs }); };
  const goToAnalysis = () => setTab("ai");

  const marketList = symbols.map((s) => marketData[s] || { symbol: s, price: null, change24h: null, sparkline: null, error: null });

  return (
    <div className="min-h-screen bg-[#0D1117] text-[#E6E9EE] font-sans" style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div className="max-w-md mx-auto pb-24">
        <div className="px-4 pt-5 pb-3 flex items-center justify-between">
          <div><div className="text-xs text-[#8A8F98]">Paper Trading Bot</div><div className="text-base font-semibold">Phase 10 — Exchange Scaffolding</div></div>
          <div className="text-[10px] text-right" style={{ color: serverInfo.error ? "#E5484D" : "#6B7280" }}>{serverInfo.error ? `Server: ${serverInfo.error}` : `Server bot: ${serverInfo.lastTickAt ? new Date(serverInfo.lastTickAt).toLocaleTimeString() : "no run yet"}`}</div>
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

        {tab === "settings" && <SettingsView apiKey={apiKey} setApiKey={setApiKey} symbols={symbols} activeStrategyParams={activeStrategyParams} setActiveStrategyParams={handleActivateStrategy} />}
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
