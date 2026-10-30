// Scalper: reacts to second-by-second moves. On a quick dip (or breakout) it bids with a post-only
// limit at the best bid, then offers the position a little higher with another post-only limit.
// Stop-loss and max-hold exits go out at market. One position at a time.
const { floorTo, decimals, fmtPrice, takeSellable } = require("../lib/util");

const defaults = {
  pollSeconds: 1, signal: "dip", windowSec: 60, entryPct: 0.15, takeProfitPct: 0.3, stopLossPct: 0.4,
  orderTimeoutSec: 15, maxHoldMin: 15, cooldownSec: 20, maxLossUsdt: null,
};

const describe = {
  pollSeconds: "seconds between price checks",
  signal: "dip = buy a quick drop from the recent high · breakout = buy a quick rise to a new high",
  windowSec: "look-back window for the recent high/low, in seconds",
  entryPct: "move from the window high (dip) or low (breakout) that triggers a buy, %",
  takeProfitPct: "sell target above the entry, % (must beat round-trip fees)",
  stopLossPct: "sell at market this far below the entry, %",
  orderTimeoutSec: "cancel an unfilled buy after this many seconds",
  maxHoldMin: "sell at market if the target isn't reached within this many minutes",
  cooldownSec: "pause after each closed trade, seconds",
  maxLossUsdt: "halt once realized losses reach this (default 10% of budget)",
};

const ceilTo = (x, step) => (Math.ceil(Number(x) / Number(step) - 1e-9) * Number(step)).toFixed(decimals(step));

function validate(cfg, inst) {
  if (!["dip", "breakout"].includes(cfg.signal)) throw new Error('signal must be "dip" or "breakout"');
  const fees = cfg.feeRate * 200;
  if (!(cfg.takeProfitPct > fees)) throw new Error(`takeProfitPct must be above round-trip fees (${fees.toFixed(2)}%)`);
  if (!(cfg.entryPct > 0 && cfg.stopLossPct > 0)) throw new Error("entryPct and stopLossPct must be > 0");
  if (!(cfg.windowSec >= 5)) throw new Error("windowSec must be >= 5");
  if (!(cfg.pollSeconds >= 1)) throw new Error("pollSeconds must be >= 1");
  if (cfg.budgetUsdt < inst.minAmt * 1.1) throw new Error(`budgetUsdt must be at least ${(inst.minAmt * 1.1).toFixed(2)} USDT`);
}

function init(ctx) {
  ctx.s.scalp = {
    state: "flat", hist: [], orderId: null, orderPrice: null, placedAt: 0,
    qty: 0, cost: 0, entry: null, filledAt: 0, sold: { qty: 0, value: 0 },
    coolUntil: 0, wins: 0, losses: 0, move: 0,
  };
}

// Cancels the open order and returns what filled before the cancel took effect.
async function closeOrder(ctx, side) {
  const { broker, tk } = ctx;
  const x = ctx.s.scalp;
  await broker.cancel([x.orderId]);
  const f = broker.settle ? await broker.settle(x.orderId, side) : await broker.check(x.orderId, side, tk);
  x.orderId = null;
  if (side === "Sell") sellEnded(ctx, f);
  return f;
}

// A sell order ended: count what filled, and give back the dust it had absorbed if part is unsold.
function sellEnded(ctx, f) {
  const x = ctx.s.scalp;
  x.sold.qty += f.qty || 0;
  x.sold.value += f.value || 0;
  if (f.status !== "filled") ctx.s.dust = x.dustBefore || 0;
}

function finish(ctx, proceeds, why) {
  const { cfg, s, log } = ctx;
  const x = s.scalp;
  const pnl = proceeds - x.cost;
  s.realizedPnl += pnl;
  s.cycles += 1;
  pnl >= 0 ? x.wins++ : x.losses++;
  log(`SELL ${why} @ ~${fmtPrice(x.sold.qty ? x.sold.value / x.sold.qty : 0)}, PnL ${pnl.toFixed(4)} USDT (W${x.wins}/L${x.losses})`, "trade");
  Object.assign(x, { state: "flat", qty: 0, cost: 0, entry: null, sold: { qty: 0, value: 0 }, coolUntil: ctx.now + cfg.cooldownSec * 1000 });
}

// Sells whatever is left at market and books the trade.
async function exitMarket(ctx, why) {
  const { s, inst, broker, tk, log } = ctx;
  const x = s.scalp;
  if (x.state === "selling") {
    const f = await closeOrder(ctx, "Sell");
    if (f.status === "filled") return finish(ctx, x.sold.value, "take-profit");
  }
  const left = Math.max(0, x.qty - x.sold.qty);
  const dustBefore = s.dust || 0;
  const q = takeSellable(s, left, inst);
  if (Number(q) * tk.bid < inst.minAmt) {
    s.dust = dustBefore + left;
    log(`${why}: ${left.toFixed(8)} left is below the min order value, kept as dust`, "warn");
  } else {
    const f = await broker.marketSell(q, tk);
    x.sold.qty += f.qty;
    x.sold.value += f.value;
  }
  finish(ctx, x.sold.value, why);
}

async function tick(ctx) {
  const { cfg, s, inst, broker, tk, log, now } = ctx;
  const x = s.scalp;

  x.hist.push([now, tk.last]);
  if (tk.high != null) x.hist.push([now, tk.high], [now, tk.low]); // backtest candles
  const from = now - cfg.windowSec * 1000;
  while (x.hist.length && x.hist[0][0] < from) x.hist.shift();
  const prices = x.hist.map((h) => h[1]);
  const hi = Math.max(...prices);
  const lo = Math.min(...prices);
  x.move = cfg.signal === "dip" ? (tk.last / hi - 1) * 100 : (tk.last / lo - 1) * 100;

  if (x.state === "buying") {
    let f = await broker.check(x.orderId, "Buy", tk);
    const stale = now - x.placedAt > cfg.orderTimeoutSec * 1000 || tk.bid > x.orderPrice * (1 + cfg.takeProfitPct / 200);
    if (f.status === "open" && stale) f = await closeOrder(ctx, "Buy");
    if (f.status === "open") return true;
    x.orderId = null;
    if (f.qty > 0) {
      Object.assign(x, { state: "holding", qty: f.qty, cost: f.value, entry: f.value / (f.qty / (1 - cfg.feeRate)), filledAt: now });
      log(`BUY  filled ${f.qty.toFixed(8)} @ ${fmtPrice(x.entry)} (${f.value.toFixed(2)} USDT)`, "trade");
    } else {
      x.state = "flat";
    }
  }

  if (x.state === "holding" || x.state === "selling") {
    const stopPx = x.entry * (1 - cfg.stopLossPct / 100);
    if (tk.bid <= stopPx) return exitMarket(ctx, "stop-loss").then(() => true);
    if (now - x.filledAt > cfg.maxHoldMin * 60000) return exitMarket(ctx, "max-hold").then(() => true);
  }

  if (x.state === "selling") {
    const f = await broker.check(x.orderId, "Sell", tk);
    if (f.status === "filled") {
      sellEnded(ctx, f);
      x.orderId = null;
      finish(ctx, x.sold.value, "take-profit");
    } else if (f.status === "cancelled") {
      sellEnded(ctx, f);
      x.orderId = null;
      x.state = "holding";
      log(`sell order cancelled by exchange${f.reason ? ` (${f.reason})` : ""}, re-placing`, "warn");
    }
    return true;
  }

  if (x.state === "holding") {
    const left = x.qty - x.sold.qty;
    const price = Math.max(Number(ceilTo(x.entry * (1 + cfg.takeProfitPct / 100), inst.tick)), tk.ask);
    const dustBefore = s.dust || 0;
    const q = takeSellable(s, left, inst);
    if (Number(q) * price < inst.minAmt) {
      s.dust = dustBefore;
      return exitMarket(ctx, "too small").then(() => true);
    }
    try {
      x.orderId = await broker.limit("Sell", q, price);
    } catch (e) {
      s.dust = dustBefore;
      throw e;
    }
    Object.assign(x, { state: "selling", dustBefore });
    log(`SELL placed ${q} @ ${fmtPrice(price)}`);
    return true;
  }

  // flat
  const maxLoss = cfg.maxLossUsdt ?? cfg.budgetUsdt * 0.1;
  if (s.realizedPnl <= -maxLoss) {
    s.haltReason = `loss limit reached (${s.realizedPnl.toFixed(2)} USDT)`;
    log(s.haltReason, "warn");
    return false;
  }
  if (now < x.coolUntil || x.hist.length < 3) return true;
  const trigger = cfg.signal === "dip" ? x.move <= -cfg.entryPct : x.move >= cfg.entryPct && tk.last >= hi;
  if (!trigger) return true;

  const spend = Math.min(cfg.budgetUsdt, cfg.budgetUsdt + s.realizedPnl);
  const qty = floorTo(spend / tk.bid, inst.qtyStep);
  if (Number(qty) < inst.minQty || Number(qty) * tk.bid < inst.minAmt) {
    s.haltReason = "budget too small for the minimum order";
    log(s.haltReason, "warn");
    return false;
  }
  x.orderId = await broker.limit("Buy", qty, tk.bid);
  Object.assign(x, { state: "buying", orderPrice: tk.bid, placedAt: now });
  log(`BUY  placed ${qty} @ ${fmtPrice(tk.bid)} (${cfg.signal} ${x.move.toFixed(2)}% in ${cfg.windowSec}s)`);
  return true;
}

async function stop(ctx, sell, reason) {
  const x = ctx.s.scalp;
  ctx.log(`stopping (${reason})${sell ? ", selling position at market" : ""}`, "warn");
  if (x.state === "buying") {
    const f = await closeOrder(ctx, "Buy");
    if (f.qty > 0) Object.assign(x, { state: "holding", qty: f.qty, cost: f.value, entry: f.value / (f.qty / (1 - ctx.cfg.feeRate)), filledAt: ctx.now });
    else x.state = "flat";
  }
  if (sell && (x.state === "holding" || x.state === "selling")) return exitMarket(ctx, "manual");
  if (x.state === "selling") {
    const f = await closeOrder(ctx, "Sell");
    if (f.status === "filled") finish(ctx, x.sold.value, "take-profit");
    else x.state = "holding";
  }
}

function position(s) {
  const x = s.scalp;
  if (!x || !(x.state === "holding" || x.state === "selling")) return { qty: 0, cost: 0 };
  const left = x.qty - x.sold.qty;
  return { qty: left, cost: x.cost * (left / x.qty) };
}

function info(s, cfg) {
  const x = s.scalp;
  if (!x) return "";
  const wl = `W${x.wins}/L${x.losses}`;
  const sig = `${cfg.signal} ${x.move >= 0 ? "+" : ""}${x.move.toFixed(2)}%/${cfg.signal === "dip" ? "-" : "+"}${cfg.entryPct}`;
  if (x.state === "buying") return `bid ${fmtPrice(x.orderPrice)} · ${wl}`;
  if (x.state === "holding" || x.state === "selling") {
    return `TP ${fmtPrice(x.entry * (1 + cfg.takeProfitPct / 100))} SL ${fmtPrice(x.entry * (1 - cfg.stopLossPct / 100))} · ${wl}`;
  }
  return `${sig} · ${wl}`;
}

const openOrders = (s) => (s.scalp && (s.scalp.state === "buying" || s.scalp.state === "selling") ? 1 : 0);

module.exports = { defaults, describe, validate, init, tick, stop, position, info, openOrders };
