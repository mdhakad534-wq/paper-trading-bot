import { DEFAULT_STRATEGY_PARAMS, initialTradingState } from "./_engine.js";
import { kvGetJSON } from "./_kv.js";

const DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

export default async function handler(req, res) {
  try {
    const [tradingState, status, symbols, activeStrategy, lastTickAt] = await Promise.all([
      kvGetJSON("tradingState", initialTradingState()),
      kvGetJSON("botStatus", "RUNNING"),
      kvGetJSON("symbols", DEFAULT_SYMBOLS),
      kvGetJSON("activeStrategy", DEFAULT_STRATEGY_PARAMS.id),
      kvGetJSON("lastTickAt", null),
    ]);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: true, tradingState, status, symbols, activeStrategy, lastTickAt });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
