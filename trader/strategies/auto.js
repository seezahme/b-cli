// Runs a strategy file (strategy-files/<name>.json): on each closed candle it computes the
// file's indicators, enters on the first matching rule and places the stop/target that rule
// defines. Between candles it watches the price for the stop, target and trailing stop.
const { fmtPrice, takeSellable } = require("../lib/util");
const R = require("../lib/rules");

const defaults = { strategy: "adaptive", pollSeconds: 10, interval: null, maxLossUsdt: null, cooldownBars: 0 };

const describe = {
  strategy: "strategy file to run (bb-cli strategy list)",
  interval: "candle size in minutes; null = the file's own",
  maxLossUsdt: "halt once realized losses reach this (default 20% of budget)",
  cooldownBars: "candles to wait after a losing trade",
};

const MS = { D: 1440 };
const cache = {};
const strategyOf = (cfg) => (cache[cfg.strategy] ??= R.load(cfg.strategy));
const intervalOf = (cfg) => String(cfg.interval ?? strategyOf(cfg).interval);

function validate(cfg, inst) {
  delete cache[cfg.strategy]; // re-read the file on every start
  const st = strategyOf(cfg);
  R.paramValues(st, cfg);
  if (!["1", "3", "5", "15", "30", "60", "120", "240", "360", "720", "D"].includes(intervalOf(cfg))) throw new Error("interval must be a Bybit kline interval");
  if (cfg.budgetUsdt < inst.minAmt * 1.1) throw new Error(`budgetUsdt must be at least ${(inst.minAmt * 1.1).toFixed(2)} USDT`);
}

function init(ctx) {
  ctx.s.auto = { pos: null, lastCandle: 0, coolUntil: 0, wins: 0, losses: 0, show: [] };
}

// Sells the whole position. `price` is set in backtests, where the stop/target is hit inside a candle.
async function exit(ctx, why, price) {
  const { s, inst, broker, tk, log } = ctx;
  const x = s.auto;
  const p = x.pos;
  const dustBefore = s.dust || 0;
  const q = takeSellable(s, p.qty, inst);
  const at = price ?? tk.bid;
  if (Number(q) * at < inst.minAmt) {
    s.dust = dustBefore;
    log(`${why}: position ${q} is below the min order value, kept`, "warn");
    return;
  }
  const f = await broker.marketSell(q, price ? { ...tk, bid: price } : tk);
  const pnl = f.value - p.cost;
  s.realizedPnl += pnl;
  s.cycles += 1;
  pnl >= 0 ? x.wins++ : x.losses++;
  if (pnl < 0 && ctx.cfg.cooldownBars > 0) x.coolUntil = x.lastCandle + ctx.cfg.cooldownBars * (MS[intervalOf(ctx.cfg)] ?? Number(intervalOf(ctx.cfg))) * 60000;
  log(`SELL ${why} [${p.rule}] ${q} @ ~${fmtPrice(f.price)}, PnL ${pnl.toFixed(4)} USDT (won ${x.wins} lost ${x.losses})`, "trade");
  x.pos = null;
}

async function tick(ctx) {
  const { cfg, s, inst, broker, tk, log } = ctx;
  const x = s.auto;
  const st = strategyOf(cfg);
  const params = R.paramValues(st, cfg);

  // 1) stop / target between candles (backtests use the candle's low/high)
  if (x.pos) {
    const p = x.pos;
    const low = tk.low ?? tk.bid;
    const high = tk.high ?? tk.bid;
    const stopWhy = p.stop > p.initialStop ? "trailing stop" : "stop-loss";
    if (low <= p.stop) return exit(ctx, stopWhy, tk.low != null ? Math.min(p.stop, tk.open ?? p.stop) : undefined).then(() => true);
    if (p.target && high >= p.target) return exit(ctx, "take-profit", tk.high != null ? Math.max(p.target, tk.open ?? p.target) : undefined).then(() => true);
  }

  // 2) rules run once per closed candle
  const { warm } = R.series(st, null, params);
  const k = await ctx.candles(intervalOf(cfg), Math.min(1000, warm + 50));
  if (k.length < warm) return true;
  const last = k[k.length - 1];
  if (last.t === x.lastCandle) return true;
  x.lastCandle = last.t;
  const { series } = R.series(st, k, params);
  const i = k.length - 1;
  const ev = { k, series, params, entry: x.pos?.entry };
  x.show = st.show.map((v) => [v.label, v.fn(ev, i)]);

  if (x.pos) {
    const p = x.pos;
    const rule = st.rules[p.ruleIndex];
    p.bars += 1;
    if (rule?.trailing) {
      const d = rule.trailing(ev, i);
      if (d > 0) p.stop = Math.max(p.stop, last.c - d);
    }
    const hit = [...(rule?.exit || []), ...st.exit].some((c) => c(ev, i));
    if (hit) await exit(ctx, "exit rule");
    return true;
  }

  const maxLoss = cfg.maxLossUsdt ?? cfg.budgetUsdt * 0.2;
  if (s.realizedPnl <= -maxLoss) {
    s.haltReason = `loss limit reached (${s.realizedPnl.toFixed(2)} USDT)`;
    log(s.haltReason, "warn");
    return false;
  }
  if (last.t < x.coolUntil) return true;

  const ruleIndex = st.rules.findIndex((r) => r.when.every((c) => c(ev, i)));
  if (ruleIndex < 0) return true;
  const rule = st.rules[ruleIndex];
  // check the levels at the expected price before buying; skip rules that give nonsense
  const levels = (entry) => {
    const e = { ...ev, entry };
    return { stop: rule.stopLoss(e, i), target: rule.takeProfit ? rule.takeProfit(e, i) : null };
  };
  const pre = levels(tk.ask);
  if (!(pre.stop > 0 && pre.stop < tk.ask) || (pre.target != null && !(pre.target > tk.ask))) {
    log(`[${rule.name}] skipped: stop ${fmtPrice(pre.stop)} / target ${fmtPrice(pre.target)} don't fit price ${fmtPrice(tk.ask)}`, "warn");
    return true;
  }
  const spend = Math.min(cfg.budgetUsdt, cfg.budgetUsdt + s.realizedPnl);
  if (spend < inst.minAmt * 1.05) {
    s.haltReason = "budget depleted by losses";
    log(s.haltReason, "warn");
    return false;
  }
  const fill = await broker.marketBuy(Math.floor(spend * 100) / 100, tk);
  const entry = fill.price || tk.ask;
  const lv = levels(entry);
  x.pos = {
    qty: fill.qty, cost: fill.value, entry, rule: rule.name, ruleIndex, bars: 0,
    stop: lv.stop, initialStop: lv.stop, target: lv.target,
  };
  log(`BUY  [${rule.name}] ${fill.qty} @ ~${fmtPrice(entry)} (${fill.value.toFixed(2)} USDT), stop ${fmtPrice(lv.stop)}${lv.target ? `, target ${fmtPrice(lv.target)}` : ""}`, "trade");
  return true;
}

async function stop(ctx, sell, reason) {
  ctx.log(`stopping (${reason})${sell ? ", selling position at market" : ""}`, "warn");
  if (sell && ctx.s.auto?.pos) await exit(ctx, "manual");
}

const position = (s) => ({ qty: s.auto?.pos?.qty || 0, cost: s.auto?.pos?.cost || 0 });

function info(s, cfg) {
  const x = s.auto;
  if (!x) return "";
  const score = `won ${x.wins} lost ${x.losses}`;
  if (x.pos) return `${x.pos.rule} | stop @ ${fmtPrice(x.pos.stop)}${x.pos.target ? ` sell @ ${fmtPrice(x.pos.target)}` : ""} | ${score}`;
  const vals = (x.show || []).map(([l, v]) => `${l} ${v == null ? "-" : Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2)}`);
  return [`${cfg.strategy}: waiting`, ...vals, score].join(" | ");
}

const openOrders = () => 0;

module.exports = { defaults, describe, validate, init, tick, stop, position, info, openOrders };
