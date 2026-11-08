const { createApi } = require("./api");
const { paperBroker } = require("./broker");
const R = require("./rules");

const STRATS = {
  grid: require("../strategies/grid"),
  dca: require("../strategies/dca"),
  trend: require("../strategies/trend"),
  scalp: require("../strategies/scalp"),
  auto: require("../strategies/auto"),
};

const INTERVAL_MIN = { 1: 1, 3: 3, 5: 5, 15: 15, 30: 30, 60: 60, 120: 120, 240: 240, 360: 360, 720: 720, D: 1440 };

function resolveConfig(bot) {
  return { feeRate: 0.001, pollSeconds: 15, env: "mainnet", ...STRATS[bot.type].defaults, ...bot };
}

function positionOf(s, price) {
  const p = STRATS[s.type].position(s);
  const qty = p.qty + (s.dust || 0);
  const value = qty * (price || 0);
  return { qty, cost: p.cost, value, upnl: qty > 0 && price ? value - p.cost : 0 };
}

async function fetchHistory(api, symbol, interval, need) {
  let all = await api.candles(symbol, interval, Math.min(1000, need));
  while (all.length < need && all.length) {
    const batch = await api.candles(symbol, interval, Math.min(1000, need - all.length), all[0].t - 1);
    if (!batch.length) break;
    all = batch.concat(all);
  }
  const seen = new Set();
  return all.filter((k) => !seen.has(k.t) && seen.add(k.t)).sort((a, b) => a.t - b.t);
}

function paperEquity(s, price) {
  const P = s.paper;
  let eq = P.usdt + P.base * price;
  for (const o of Object.values(P.orders)) eq += o.side === "Buy" ? o.qty * o.price : o.qty * price;
  return eq;
}

async function backtest(bot, { days = 7, interval } = {}) {
  const cfg = resolveConfig(bot);
  const st = STRATS[cfg.type];
  const api = createApi(cfg.env);
  const inst = await api.instrument(cfg.symbol);
  st.validate(cfg, inst);

  // auto bots trade on their strategy file's candles and need its indicators warmed up
  const strat = cfg.type === "auto" ? R.load(cfg.strategy) : null;
  const step = cfg.type === "trend" ? String(cfg.interval)
    : strat ? String(cfg.interval ?? strat.interval)
    : String(interval || (cfg.type === "scalp" ? "1" : "5"));
  const stepMin = INTERVAL_MIN[step];
  if (!stepMin) throw new Error(`unsupported interval ${step} (${Object.keys(INTERVAL_MIN).join(", ")})`);
  const warm = cfg.type === "trend" ? cfg.slow * 4 : strat ? R.series(strat, null, R.paramValues(strat, cfg)).warm : 0;
  const candles = await fetchHistory(api, cfg.symbol, step, Math.ceil((days * 1440) / stepMin) + warm);
  if (candles.length <= warm + 1) throw new Error("not enough history");

  const s = { name: bot.name, type: cfg.type, symbol: cfg.symbol, mode: "backtest", realizedPnl: 0, cycles: 0 };
  const broker = paperBroker(s, cfg.feeRate, cfg.budgetUsdt);
  const trades = [];
  let idx = warm;
  const ctx = {
    cfg, s, inst, broker, api: null, tk: null, now: 0,
    log: (msg, level) => {
      if (level === "trade") trades.push({ t: ctx.now, msg });
    },
    candles: async (_iv, limit) => candles.slice(Math.max(0, idx + 1 - limit), idx + 1),
  };

  let peak = cfg.budgetUsdt;
  let maxDD = 0;
  let halted = null;
  for (; idx < candles.length; idx++) {
    const k = candles[idx];
    ctx.tk = { last: k.c, bid: k.c, ask: k.c, open: k.o, high: k.h, low: k.l };
    ctx.now = k.t + stepMin * 60000;
    if (idx === warm) st.init(ctx);
    const cont = await st.tick(ctx);
    const eq = paperEquity(s, k.c);
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, (peak - eq) / peak);
    if (cont === false) {
      halted = s.haltReason || "halted";
      break;
    }
  }

  const first = candles[warm];
  const lastK = candles[Math.min(idx, candles.length - 1)];
  const finalEquity = paperEquity(s, lastK.c);
  return {
    cfg, step, from: first.t, to: lastK.t + stepMin * 60000, bars: Math.min(idx, candles.length - 1) - warm + 1,
    trades, cycles: s.cycles, realizedPnl: s.realizedPnl, finalEquity,
    returnPct: (finalEquity / cfg.budgetUsdt - 1) * 100,
    buyHoldPct: (lastK.c / first.c - 1) * 100,
    maxDDPct: maxDD * 100, halted,
    openPosition: positionOf(s, lastK.c),
    state: s,
  };
}

module.exports = { STRATS, INTERVAL_MIN, resolveConfig, positionOf, backtest };
