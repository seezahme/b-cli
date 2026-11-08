// Spot grid: buy on each level below price, sell one level higher, repeat.
const { floorTo, roundTo, fmtPrice, takeSellable } = require("../lib/util");

const defaults = { levels: 5, rangePct: 4, lower: null, upper: null, stopLossPct: 3, sellOnStop: true };

const describe = {
  levels: "number of grid levels (budget is split evenly)",
  rangePct: "range above and below the start price, % (used when lower/upper are null)",
  lower: "fixed bottom of the grid (null = from rangePct)",
  upper: "fixed top of the grid (null = from rangePct)",
  stopLossPct: "halt this far below the bottom of the grid, %",
  sellOnStop: "sell holdings at market when the stop-loss hits (true/false)",
};

function validate(cfg, inst) {
  if (!(cfg.levels >= 1)) throw new Error("levels must be >= 1");
  const perLevel = cfg.budgetUsdt / cfg.levels;
  if (perLevel < inst.minAmt * 1.05) {
    throw new Error(`budget per level ${perLevel.toFixed(2)} USDT is below Bybit minimum ${inst.minAmt} USDT (+5% for fees)`);
  }
}

function init(ctx) {
  const { cfg, s, inst, tk } = ctx;
  const lower = cfg.lower ?? tk.last * (1 - cfg.rangePct / 100);
  const upper = cfg.upper ?? tk.last * (1 + cfg.rangePct / 100);
  if (!(upper > lower)) throw new Error("grid upper must be above lower");
  const step = (upper - lower) / cfg.levels;
  if (step / lower <= 2 * cfg.feeRate) throw new Error("grid step is smaller than round-trip fees; widen range or reduce levels");
  s.grid = {
    lower,
    upper,
    slots: Array.from({ length: cfg.levels }, (_, i) => ({
      i,
      buyPrice: roundTo(lower + i * step, inst.tick),
      sellPrice: roundTo(lower + (i + 1) * step, inst.tick),
      quote: cfg.budgetUsdt / cfg.levels,
      state: "idle",
      orderId: null,
      qty: null,
      cost: null,
    })),
  };
}

const active = (x) => x.state === "buying" || x.state === "selling";
const sideOf = (x) => (x.state === "buying" ? "Buy" : "Sell");

function applyFill(ctx, slot, f) {
  const { s, inst, log } = ctx;
  if (f.status === "filled" && slot.state === "buying") {
    Object.assign(slot, { state: "holding", orderId: null, qty: f.qty, cost: f.value });
    log(`BUY  filled L${slot.i} ${f.qty.toFixed(8)} @ ${slot.buyPrice} (${f.value.toFixed(2)} USDT)`, "trade");
  } else if (f.status === "filled" && slot.state === "selling") {
    const pnl = f.value - slot.cost;
    s.realizedPnl += pnl;
    s.cycles += 1;
    log(`SELL filled L${slot.i} ${f.qty} @ ${slot.sellPrice}, PnL ${pnl.toFixed(4)} USDT`, "trade");
    Object.assign(slot, { state: "idle", orderId: null, qty: null, cost: null });
  } else if (f.status === "cancelled") {
    if (f.reason && f.reason !== "EC_NoError") log(`L${slot.i} ${sideOf(slot)} order cancelled: ${f.reason}`, "warn");
    if (slot.state === "buying" && f.qty > 0) {
      Object.assign(slot, { state: "holding", orderId: null, qty: f.qty, cost: f.value });
    } else if (slot.state === "buying") {
      Object.assign(slot, { state: "idle", orderId: null, qty: null });
    } else {
      Object.assign(slot, { state: "holding", orderId: null, qty: Number(slot.qty) });
    }
  }
}

async function tick(ctx) {
  const { cfg, s, inst, broker, tk, log } = ctx;
  const g = s.grid;

  for (const slot of g.slots.filter(active)) {
    applyFill(ctx, slot, await broker.check(slot.orderId, sideOf(slot), tk));
  }

  const stopPrice = g.lower * (1 - cfg.stopLossPct / 100);
  if (tk.last < stopPrice) {
    s.haltReason = `stop-loss: price ${fmtPrice(tk.last)} below ${fmtPrice(stopPrice)}`;
    await stop(ctx, cfg.sellOnStop, s.haltReason);
    return false;
  }

  for (const slot of g.slots) {
    if (slot.state === "holding" && Number(slot.sellPrice) > tk.bid) {
      if (Number(slot.qty) * Number(slot.sellPrice) < inst.minAmt) continue;
      const dustBefore = s.dust || 0;
      const q = takeSellable(s, slot.qty, inst);
      try {
        slot.orderId = await broker.limit("Sell", q, slot.sellPrice);
      } catch (e) {
        s.dust = dustBefore;
        throw e;
      }
      Object.assign(slot, { state: "selling", qty: q });
      log(`SELL placed L${slot.i} ${q} @ ${slot.sellPrice}`);
    } else if (slot.state === "idle" && Number(slot.buyPrice) < tk.ask) {
      const qty = floorTo(slot.quote / Number(slot.buyPrice), inst.qtyStep);
      if (Number(qty) < inst.minQty || Number(qty) * Number(slot.buyPrice) < inst.minAmt) continue;
      slot.qty = qty;
      slot.orderId = await broker.limit("Buy", qty, slot.buyPrice);
      slot.state = "buying";
      log(`BUY  placed L${slot.i} ${qty} @ ${slot.buyPrice}`);
    }
  }
  return true;
}

async function stop(ctx, sell, reason) {
  const { s, inst, broker, log } = ctx;
  const slots = s.grid.slots;
  log(`stopping (${reason})${sell ? ", selling holdings at market" : ""}`, "warn");
  const open = slots.filter(active);
  await broker.cancel(open.map((x) => x.orderId));
  for (const slot of open) {
    applyFill(ctx, slot, broker.settle ? await broker.settle(slot.orderId, sideOf(slot)) : await broker.check(slot.orderId, sideOf(slot), ctx.tk));
  }
  const holding = slots.filter((x) => x.state === "holding");
  const qty = holding.reduce((a, x) => a + Number(x.qty), 0);
  if (!sell || qty <= 0) return;
  const dustBefore = s.dust || 0;
  const q = takeSellable(s, qty, inst);
  if (Number(q) * ctx.tk.bid < inst.minAmt) {
    s.dust = dustBefore;
    return log(`holdings ${q} below min order value, kept`, "warn");
  }
  const f = await broker.marketSell(q, ctx.tk);
  const pnl = f.value - holding.reduce((a, x) => a + x.cost, 0);
  s.realizedPnl += pnl;
  s.cycles += 1;
  for (const x of holding) Object.assign(x, { state: "idle", qty: null, cost: null });
  log(`SELL market ${q} @ ~${fmtPrice(f.price)}, PnL ${pnl.toFixed(4)} USDT`, "trade");
}

function position(s) {
  const held = s.grid ? s.grid.slots.filter((x) => x.state === "holding" || x.state === "selling") : [];
  return { qty: held.reduce((a, x) => a + Number(x.qty), 0), cost: held.reduce((a, x) => a + x.cost, 0) };
}

function info(s) {
  if (!s.grid) return "";
  const g = s.grid;
  const busy = g.slots.filter((x) => x.state !== "idle").length;
  return `range ${fmtPrice(g.lower)}-${fmtPrice(g.upper)} | ${busy}/${g.slots.length} levels in use`;
}

const openOrders = (s) => (s.grid ? s.grid.slots.filter(active).length : 0);

module.exports = { defaults, describe, validate, init, tick, stop, position, info, openOrders };
