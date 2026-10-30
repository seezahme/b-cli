// EMA crossover, long only: buy when fast EMA crosses above slow, exit on cross down, TP or SL.
const { floorTo, fmtPrice, takeSellable } = require("../lib/util");

const defaults = { interval: "15", fast: 9, slow: 21, takeProfitPct: 3, stopLossPct: 2 };

const describe = {
  interval: "candle size in minutes (1, 3, 5, 15, 30, 60, 240, D)",
  fast: "fast EMA period, in candles",
  slow: "slow EMA period, in candles",
  takeProfitPct: "sell this far above the entry, %",
  stopLossPct: "sell this far below the entry, %",
};

function validate(cfg, inst) {
  if (!(cfg.fast >= 2 && cfg.slow > cfg.fast)) throw new Error("need 2 <= fast < slow");
  if (cfg.budgetUsdt < inst.minAmt * 1.1) throw new Error(`budgetUsdt must be at least ${(inst.minAmt * 1.1).toFixed(2)} USDT`);
}

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) out[i] = prev = values[i] * k + prev * (1 - k);
  return out;
}

function init(ctx) {
  ctx.s.trend = { qty: 0, cost: 0, entry: null, lastCandle: 0, fast: null, slow: null };
}

async function exit(ctx, why) {
  const { s, inst, broker, tk, log } = ctx;
  const t = s.trend;
  const dustBefore = s.dust || 0;
  const q = takeSellable(s, t.qty, inst);
  if (Number(q) * tk.bid < inst.minAmt) {
    s.dust = dustBefore;
    log(`${why}: position ${q} below min order value, cannot sell`, "warn");
    return;
  }
  const f = await broker.marketSell(q, tk);
  const pnl = f.value - t.cost;
  s.realizedPnl += pnl;
  s.cycles += 1;
  log(`SELL ${why} ${q} @ ~${fmtPrice(f.price)}, PnL ${pnl.toFixed(4)} USDT`, "trade");
  Object.assign(t, { qty: 0, cost: 0, entry: null });
}

async function tick(ctx) {
  const { cfg, s, inst, broker, tk, log } = ctx;
  const t = s.trend;

  if (t.qty > 0) {
    if (tk.bid >= t.entry * (1 + cfg.takeProfitPct / 100)) return exit(ctx, "take-profit").then(() => true);
    if (tk.bid <= t.entry * (1 - cfg.stopLossPct / 100)) return exit(ctx, "stop-loss").then(() => true);
  }

  const candles = await ctx.candles(cfg.interval, cfg.slow * 4);
  if (candles.length < cfg.slow + 2) return true;
  const last = candles[candles.length - 1];
  if (last.t === t.lastCandle) return true;
  t.lastCandle = last.t;

  const closes = candles.map((x) => x.c);
  const f = ema(closes, cfg.fast);
  const sl = ema(closes, cfg.slow);
  const n = closes.length - 1;
  t.fast = f[n];
  t.slow = sl[n];
  const crossUp = f[n - 1] <= sl[n - 1] && f[n] > sl[n];
  const crossDown = f[n - 1] >= sl[n - 1] && f[n] < sl[n];

  if (crossUp && t.qty === 0) {
    const spend = Math.min(cfg.budgetUsdt, cfg.budgetUsdt + s.realizedPnl);
    if (spend < inst.minAmt * 1.05) {
      s.haltReason = "budget depleted by losses";
      log(s.haltReason, "warn");
      return false;
    }
    const fill = await broker.marketBuy(Math.floor(spend * 100) / 100, tk);
    Object.assign(t, { qty: fill.qty, cost: fill.value, entry: fill.price || tk.ask });
    log(`BUY  cross-up ${t.qty} @ ~${fmtPrice(t.entry)} (${fill.value.toFixed(2)} USDT)`, "trade");
  } else if (crossDown && t.qty > 0) {
    await exit(ctx, "cross-down");
  }
  return true;
}

async function stop(ctx, sell, reason) {
  ctx.log(`stopping (${reason})${sell ? ", selling position at market" : ""}`, "warn");
  if (sell && ctx.s.trend.qty > 0) await exit(ctx, "manual");
}

const position = (s) => ({ qty: s.trend?.qty || 0, cost: s.trend?.cost || 0 });

function info(s, cfg) {
  const t = s.trend;
  if (!t || t.fast == null) return "waiting for candles";
  const dir = t.fast > t.slow ? "▲" : "▼";
  const parts = [`EMA${cfg.fast} ${fmtPrice(t.fast)} ${dir} EMA${cfg.slow} ${fmtPrice(t.slow)}`];
  if (t.qty > 0) parts.push(`SL ${fmtPrice(t.entry * (1 - cfg.stopLossPct / 100))} TP ${fmtPrice(t.entry * (1 + cfg.takeProfitPct / 100))}`);
  return parts.join(" · ");
}

const openOrders = () => 0;

module.exports = { defaults, describe, validate, init, tick, stop, position, info, openOrders, ema };
