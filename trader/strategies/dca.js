// DCA: buy a fixed amount on a schedule, adding only after a dip; sell everything at take-profit.
const { floorTo, fmtPrice, takeSellable } = require("../lib/util");

const defaults = { buyUsdt: 6, maxBuys: null, intervalMin: 60, dipPct: 1.5, takeProfitPct: 2, stopLossPct: null };

const describe = {
  buyUsdt: "USDT spent per buy",
  maxBuys: "max buys per cycle (default budget / buyUsdt)",
  intervalMin: "minimum minutes between buys",
  dipPct: "next buy only if price is this far below the last buy, %",
  takeProfitPct: "sell everything this far above the average entry, %",
  stopLossPct: "sell everything and halt this far below the average entry, % (null = off)",
};

const maxBuys = (cfg) => cfg.maxBuys ?? Math.floor(cfg.budgetUsdt / cfg.buyUsdt);

function validate(cfg, inst) {
  if (cfg.buyUsdt < inst.minAmt * 1.1) throw new Error(`buyUsdt must be at least ${(inst.minAmt * 1.1).toFixed(2)} USDT`);
  if (maxBuys(cfg) * cfg.buyUsdt > cfg.budgetUsdt + 1e-9) throw new Error("maxBuys * buyUsdt exceeds budgetUsdt");
  if (maxBuys(cfg) < 1) throw new Error("budget too small for one buy");
  if (!(cfg.takeProfitPct > 0)) throw new Error("takeProfitPct must be > 0");
}

function init(ctx) {
  ctx.s.dca = { qty: 0, cost: 0, buys: 0, lastBuyPrice: null, lastBuyAt: 0 };
}

async function sellAll(ctx, why) {
  const { s, inst, broker, tk, log } = ctx;
  const d = s.dca;
  const dustBefore = s.dust || 0;
  const q = takeSellable(s, d.qty, inst);
  if (Number(q) * tk.bid < inst.minAmt) {
    s.dust = dustBefore;
    log(`${why}: position ${q} below min order value, cannot sell`, "warn");
    return false;
  }
  const f = await broker.marketSell(q, tk);
  const pnl = f.value - d.cost;
  s.realizedPnl += pnl;
  s.cycles += 1;
  log(`SELL ${why} ${q} @ ~${fmtPrice(f.price)}, PnL ${pnl.toFixed(4)} USDT`, "trade");
  Object.assign(d, { qty: 0, cost: 0, buys: 0, lastBuyPrice: null, lastBuyAt: 0 });
  return true;
}

async function tick(ctx) {
  const { cfg, s, inst, broker, tk, log, now } = ctx;
  const d = s.dca;

  if (d.qty > 0) {
    const avg = d.cost / d.qty;
    if (tk.bid >= avg * (1 + cfg.takeProfitPct / 100)) {
      await sellAll(ctx, "take-profit");
      return true;
    }
    if (cfg.stopLossPct != null && tk.bid <= avg * (1 - cfg.stopLossPct / 100)) {
      if (await sellAll(ctx, "stop-loss")) {
        s.haltReason = "stop-loss hit";
        return false;
      }
    }
  }

  const due = now - d.lastBuyAt >= cfg.intervalMin * 60000;
  const dipOk = d.buys === 0 || tk.ask <= d.lastBuyPrice * (1 - cfg.dipPct / 100);
  if (d.buys < maxBuys(cfg) && due && dipOk) {
    const f = await broker.marketBuy(cfg.buyUsdt, tk);
    d.qty += f.qty;
    d.cost += f.value;
    d.buys += 1;
    d.lastBuyPrice = f.price || tk.ask;
    d.lastBuyAt = now;
    log(`BUY  #${d.buys} ${floorTo(f.qty, inst.qtyStep)} @ ~${fmtPrice(d.lastBuyPrice)} (${f.value.toFixed(2)} USDT)`, "trade");
  }
  return true;
}

async function stop(ctx, sell, reason) {
  ctx.log(`stopping (${reason})${sell ? ", selling position at market" : ""}`, "warn");
  if (sell && ctx.s.dca.qty > 0) await sellAll(ctx, "manual");
}

const position = (s) => ({ qty: s.dca?.qty || 0, cost: s.dca?.cost || 0 });

function info(s, cfg) {
  const d = s.dca;
  if (!d) return "";
  const parts = [`buys ${d.buys}/${maxBuys(cfg)}`];
  if (d.qty > 0) parts.push(`TP ${fmtPrice((d.cost / d.qty) * (1 + cfg.takeProfitPct / 100))}`);
  if (d.buys > 0 && d.buys < maxBuys(cfg)) parts.push(`next ≤${fmtPrice(d.lastBuyPrice * (1 - cfg.dipPct / 100))}`);
  return parts.join(" · ");
}

const openOrders = () => 0;

module.exports = { defaults, describe, validate, init, tick, stop, position, info, openOrders };
