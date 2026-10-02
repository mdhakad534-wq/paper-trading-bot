import {
  TIMEFRAMES, STARTING_BALANCE, DEFAULT_STRATEGY_PARAMS, STRATEGY_PRESETS,
  initialTradingState, computeEquity, rolloverDay, checkExits, tryOpenPositions,
  fetchTickers, fetchCandles, computeIndicators, computeStrategyDecision,
  callAIAnalysis, combineDecisions,
} from "./_engine.js";
import { kvGetJSON, kvSetJSON } from "./_kv.js";

const DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const bearer = (req.headers.authorization || "") === `Bearer ${secret}`;
  return bearer || req.query.secret === secret;
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  try {
    const symbols = await kvGetJSON("symbols", DEFAULT_SYMBOLS);
    const status = await kvGetJSON("botStatus", "RUNNING");
    const strategyId = await kvGetJSON("activeStrategy", DEFAULT_STRATEGY_PARAMS.id);
    const sp = STRATEGY_PRESETS.find((p) => p.id === strategyId) || DEFAULT_STRATEGY_PARAMS;
    let tradingState = { ...initialTradingState(), ...(await kvGetJSON("tradingState", initialTradingState())) };

    const tickers = await fetchTickers(symbols);
    const marketData = {};
    for (const s of symbols) marketData[s] = tickers[s] ? { price: tickers[s].price } : null;

    const equityNow = computeEquity(tradingState, marketData).totalEquity;
    tradingState = rolloverDay(tradingState, equityNow);
    tradingState = checkExits(tradingState, marketData, sp);

    if (status === "RUNNING" && !tradingState.pauseReason) {
      const aiConfigured = Boolean(process.env.ANTHROPIC_API_KEY);
      const eq = computeEquity(tradingState, marketData).totalEquity || STARTING_BALANCE;
      const entries = await Promise.all(symbols.map(async (symbol) => {
        try {
          const candleSets = await Promise.all(TIMEFRAMES.map((tf) => fetchCandles(symbol, tf, 220)));
          const indicators = {};
          TIMEFRAMES.forEach((tf, i) => { indicators[tf] = candleSets[i].length > 210 ? computeIndicators(candleSets[i]) : null; });
          const ruleDecision = computeStrategyDecision(indicators, sp, eq);
          let aiReview = null, aiError = null;
          if (ruleDecision.decision !== "WAIT" && aiConfigured) {
            try { aiReview = await callAIAnalysis(symbol, indicators, ruleDecision, process.env.ANTHROPIC_API_KEY); }
            catch (err) { aiError = err.message || "AI request failed"; }
          }
          const { final } = combineDecisions(ruleDecision, aiReview, aiError, aiConfigured);
          return [symbol, { finalDecision: final }];
        } catch (err) {
          return [symbol, { finalDecision: { decision: "WAIT", reasonSummary: "Analysis failed: " + err.message, conditions: [], warnings: [] } }];
        }
      }));
      tradingState = tryOpenPositions(tradingState, Object.fromEntries(entries), marketData, status);
    }

    await kvSetJSON("tradingState", tradingState);
    await kvSetJSON("lastTickAt", new Date().toISOString());

    const finalEquity = computeEquity(tradingState, marketData);
    res.status(200).json({ ok: true, ranAt: new Date().toISOString(), status, equity: finalEquity.totalEquity, openPositions: tradingState.openPositions.length, pauseReason: tradingState.pauseReason });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
