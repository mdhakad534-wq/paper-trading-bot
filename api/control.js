import { STRATEGY_PRESETS, DEFAULT_STRATEGY_PARAMS, initialTradingState, validateSymbolInput } from "./_engine.js";
import { kvGetJSON, kvSetJSON } from "./_kv.js";

const DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers["x-control-key"] !== secret) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { action } = body;

    if (action === "setStatus") {
      if (!["RUNNING", "STOPPED", "PAUSED"].includes(body.status)) return res.status(400).json({ ok: false, error: "invalid status" });
      await kvSetJSON("botStatus", body.status);
      if (body.status === "STOPPED") {
        const st = { ...initialTradingState(), ...(await kvGetJSON("tradingState", initialTradingState())) };
        await kvSetJSON("tradingState", { ...st, lastStoppedAt: Date.now() });
      }
    } else if (action === "resume") {
      const st = { ...initialTradingState(), ...(await kvGetJSON("tradingState", initialTradingState())) };
      await kvSetJSON("tradingState", { ...st, pauseReason: null, consecutiveLosses: 0 });
    } else if (action === "reset") {
      await kvSetJSON("tradingState", initialTradingState());
    } else if (action === "setStrategy") {
      const preset = STRATEGY_PRESETS.find((p) => p.id === body.id);
      if (!preset) return res.status(400).json({ ok: false, error: "unknown strategy" });
      await kvSetJSON("activeStrategy", preset.id);
    } else if (action === "addSymbol") {
      const symbols = await kvGetJSON("symbols", DEFAULT_SYMBOLS);
      const result = validateSymbolInput(String(body.symbol || ""), symbols.length);
      if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
      if (!symbols.includes(result.symbol)) await kvSetJSON("symbols", [...symbols, result.symbol]);
    } else if (action === "removeSymbol") {
      const symbols = await kvGetJSON("symbols", DEFAULT_SYMBOLS);
      await kvSetJSON("symbols", symbols.filter((s) => s !== body.symbol));
    } else {
      return res.status(400).json({ ok: false, error: "unknown action" });
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
