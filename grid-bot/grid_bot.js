#!/usr/bin/env node
// Spot grid bot for Bybit V5. Paper mode by default; live mode only with --live and an interactive confirmation.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");

const DIR = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"));
const args = new Set(process.argv.slice(2));
const LIVE = args.has("--live");
const MODE = LIVE ? "live" : "paper";
const STATE_FILE = path.join(DIR, `state.${MODE}.json`);
const LOG_FILE = path.join(DIR, `bot.${MODE}.log`);
const API = cfg.env === "testnet" ? "https://api-testnet.bybit.com" : "https://api.bybit.com";
const RECV = "5000";

function log(msg) {
  const line = `[${new Date().toISOString()}] [${MODE}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
}

function loadKeys() {
  if (process.env.BYBIT_API_KEY && process.env.BYBIT_API_SECRET) {
    return { key: process.env.BYBIT_API_KEY, secret: process.env.BYBIT_API_SECRET };
  }
  const p = path.join(process.env.APPDATA || path.join(require("os").homedir(), ".config"), "bybit", "oauth_token.json");
  const acc = fs.existsSync(p) && JSON.parse(fs.readFileSync(p, "utf8"))["ai-account"];
  if (!acc || !acc.api_key) throw new Error("No API keys: set BYBIT_API_KEY/BYBIT_API_SECRET or complete OAuth first");
  return { key: acc.api_key, secret: acc.api_secret };
}

async function publicGet(endpoint, query) {
  const r = await fetch(`${API}${endpoint}?${query}`);
  const j = await r.json();
  if (j.retCode !== 0) throw new Error(`${endpoint}: ${j.retMsg} (${j.retCode})`);
  return j.result;
}

let KEYS = null;
async function signed(method, endpoint, params) {
  const ts = Date.now().toString();
  const payload = method === "GET" ? new URLSearchParams(params).toString() : JSON.stringify(params);
  const sign = crypto.createHmac("sha256", KEYS.secret).update(ts + KEYS.key + RECV + payload).digest("hex");
  const headers = {
    "X-BAPI-API-KEY": KEYS.key,
    "X-BAPI-TIMESTAMP": ts,
    "X-BAPI-RECV-WINDOW": RECV,
    "X-BAPI-SIGN": sign,
    "Content-Type": "application/json",
  };
  const url = method === "GET" ? `${API}${endpoint}?${payload}` : `${API}${endpoint}`;
  const r = await fetch(url, { method, headers, body: method === "GET" ? undefined : payload });
  const j = await r.json();
  if (j.retCode !== 0) throw new Error(`${endpoint}: ${j.retMsg} (${j.retCode})`);
  return j.result;
}

const decimals = (step) => (step.includes(".") ? step.split(".")[1].replace(/0+$/, "").length : 0);
const floorTo = (x, step) => (Math.floor(x / Number(step) + 1e-9) * Number(step)).toFixed(decimals(step));
const roundTo = (x, step) => (Math.round(x / Number(step)) * Number(step)).toFixed(decimals(step));

async function getInstrument() {
  const i = (await publicGet("/v5/market/instruments-info", `category=spot&symbol=${cfg.symbol}`)).list[0];
  return {
    base: i.baseCoin,
    qtyStep: i.lotSizeFilter.basePrecision,
    minQty: Number(i.lotSizeFilter.minOrderQty),
    minAmt: Number(i.lotSizeFilter.minOrderAmt),
    tick: i.priceFilter.tickSize,
  };
}

async function getTicker() {
  const t = (await publicGet("/v5/market/tickers", `category=spot&symbol=${cfg.symbol}`)).list[0];
  return { last: Number(t.lastPrice), bid: Number(t.bid1Price), ask: Number(t.ask1Price) };
}

function buildGrid(price, inst) {
  const lower = cfg.lower ?? price * (1 - cfg.rangePct / 100);
  const upper = cfg.upper ?? price * (1 + cfg.rangePct / 100);
  const n = cfg.levels;
  const step = (upper - lower) / n;
  if (step / lower <= 2 * cfg.feeRate) throw new Error("Grid step is smaller than round-trip fees; widen range or reduce levels");
  const perSlot = cfg.budgetUsdt / n;
  if (perSlot < inst.minAmt * 1.05) throw new Error(`Budget per level ${perSlot.toFixed(2)} USDT is below Bybit minimum ${inst.minAmt} USDT`);
  const slots = [];
  for (let i = 0; i < n; i++) {
    slots.push({
      i,
      buyPrice: roundTo(lower + i * step, inst.tick),
      sellPrice: roundTo(lower + (i + 1) * step, inst.tick),
      quote: perSlot,
      state: "idle",
      orderId: null,
      qty: null,
      cost: null,
    });
  }
  return { lower, upper, slots };
}

function newState(price, inst) {
  const g = buildGrid(price, inst);
  return {
    symbol: cfg.symbol,
    createdAt: new Date().toISOString(),
    lower: g.lower,
    upper: g.upper,
    slots: g.slots,
    realizedPnl: 0,
    cycles: 0,
    stopped: false,
    paper: { usdt: cfg.paperStartUsdt, base: 0 },
  };
}

const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

// ---------- order adapters ----------
const paperBroker = {
  async place(s, slot, side, qty, price) {
    if (side === "Buy") {
      const cost = Number(qty) * Number(price);
      if (cost > s.paper.usdt + 1e-9) throw new Error("paper: insufficient USDT");
      s.paper.usdt -= cost;
    } else {
      if (Number(qty) > s.paper.base + 1e-12) throw new Error("paper: insufficient base");
      s.paper.base -= Number(qty);
    }
    return `paper-${slot.i}-${Date.now()}`;
  },
  async checkFill(s, slot, tk) {
    const p = Number(slot.state === "buying" ? slot.buyPrice : slot.sellPrice);
    const filled = slot.state === "buying" ? tk.last <= p : tk.last >= p;
    if (!filled) return { status: "open" };
    const qty = Number(slot.qty);
    if (slot.state === "buying") {
      s.paper.base += qty * (1 - cfg.feeRate);
      return { status: "filled", qty, value: qty * p };
    }
    const proceeds = qty * p * (1 - cfg.feeRate);
    s.paper.usdt += proceeds;
    return { status: "filled", qty, value: proceeds };
  },
  async cancelAll(s) {
    for (const x of s.slots) {
      if (x.state === "buying") s.paper.usdt += Number(x.qty) * Number(x.buyPrice);
      if (x.state === "selling") s.paper.base += Number(x.qty);
    }
  },
  async checkCancelled(s, slot) {
    return { status: "cancelled", qty: 0, value: 0, reason: "cancel-all" };
  },
  async marketSell(s, qty) {
    const tk = await getTicker();
    const proceeds = Number(qty) * tk.bid * (1 - cfg.feeRate);
    s.paper.base -= Number(qty);
    s.paper.usdt += proceeds;
    return proceeds;
  },
};

const liveBroker = {
  async place(s, slot, side, qty, price) {
    const r = await signed("POST", "/v5/order/create", {
      category: "spot",
      symbol: cfg.symbol,
      side,
      orderType: "Limit",
      qty,
      price,
      timeInForce: "PostOnly",
      orderLinkId: `grid${slot.i}${side[0]}${Date.now()}`,
    });
    return r.orderId;
  },
  async checkFill(s, slot) {
    const open = await signed("GET", "/v5/order/realtime", { category: "spot", symbol: cfg.symbol, orderId: slot.orderId });
    let o = open.list[0];
    if (!o) {
      const hist = await signed("GET", "/v5/order/history", { category: "spot", symbol: cfg.symbol, orderId: slot.orderId });
      o = hist.list[0];
    }
    if (!o) return { status: "open" };
    if (o.orderStatus === "Filled") {
      const qty = Number(o.cumExecQty);
      const value = slot.state === "buying" ? Number(o.cumExecValue) : Number(o.cumExecValue) - Number(o.cumExecFee || 0);
      return { status: "filled", qty, value };
    }
    if (["Cancelled", "Rejected", "PartiallyFilledCanceled", "Deactivated"].includes(o.orderStatus)) {
      return { status: "cancelled", qty: Number(o.cumExecQty || 0), value: Number(o.cumExecValue || 0), reason: o.rejectReason };
    }
    return { status: "open" };
  },
  async cancelAll() {
    await signed("POST", "/v5/order/cancel-all", { category: "spot", symbol: cfg.symbol });
  },
  async checkCancelled(s, slot) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const f = await liveBroker.checkFill(s, slot);
      if (f.status !== "open") return f;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`order ${slot.orderId} still open after cancel-all`);
  },
  async marketSell(s, qty) {
    const tk = await getTicker();
    await signed("POST", "/v5/order/create", {
      category: "spot",
      symbol: cfg.symbol,
      side: "Sell",
      orderType: "Market",
      qty,
      marketUnit: "baseCoin",
    });
    return Number(qty) * tk.bid * (1 - cfg.feeRate);
  },
};

// ---------- core loop ----------
function applyFill(s, slot, f, inst) {
  if (f.status === "filled" && slot.state === "buying") {
    Object.assign(slot, { state: "holding", orderId: null, qty: floorTo(f.qty * (1 - cfg.feeRate), inst.qtyStep), cost: f.value });
    log(`slot ${slot.i}: BUY filled ${f.qty} @ ${slot.buyPrice} (cost ${f.value.toFixed(4)} USDT)`);
  } else if (f.status === "filled" && slot.state === "selling") {
    const pnl = f.value - slot.cost;
    s.realizedPnl += pnl;
    s.cycles += 1;
    log(`slot ${slot.i}: SELL filled ${f.qty} @ ${slot.sellPrice}, cycle PnL ${pnl.toFixed(4)} USDT, total ${s.realizedPnl.toFixed(4)}`);
    Object.assign(slot, { state: "idle", orderId: null, qty: null, cost: null });
  } else if (f.status === "cancelled") {
    log(`slot ${slot.i}: ${slot.state} order cancelled (${f.reason || "no reason"}), filled ${f.qty}`);
    if (slot.state === "buying" && f.qty > 0) {
      Object.assign(slot, { state: "holding", orderId: null, qty: floorTo(f.qty * (1 - cfg.feeRate), inst.qtyStep), cost: f.value });
    } else if (slot.state === "buying") {
      Object.assign(slot, { state: "idle", orderId: null, qty: null });
    } else {
      Object.assign(slot, { state: "holding", orderId: null });
    }
  }
}

async function stopGrid(s, inst, broker, reason, sell) {
  log(`STOP: ${reason}. Cancelling open orders${sell ? " and market-selling holdings" : ""}.`);
  await broker.cancelAll(s);
  for (const slot of s.slots) {
    if (slot.state === "buying" || slot.state === "selling") applyFill(s, slot, await broker.checkCancelled(s, slot), inst);
  }
  const holding = s.slots.filter((x) => x.state === "holding");
  const held = holding.reduce((a, x) => a + Number(x.qty), 0);
  if (sell && held > 0) {
    const tk = await getTicker();
    const q = floorTo(held, inst.qtyStep);
    if (Number(q) * tk.bid >= inst.minAmt) {
      const proceeds = await broker.marketSell(s, q);
      const pnl = proceeds - holding.reduce((a, x) => a + x.cost, 0);
      s.realizedPnl += pnl;
      for (const x of holding) Object.assign(x, { state: "idle", qty: null, cost: null });
      log(`STOP: sold ${q} at market, PnL ${pnl.toFixed(4)} USDT, total ${s.realizedPnl.toFixed(4)}`);
    } else {
      log(`STOP: holdings ${q} below min order value, left as is`);
    }
  }
  s.stopped = true;
  saveState(s);
}

async function tick(s, inst, broker) {
  const tk = await getTicker();

  for (const slot of s.slots) {
    if (slot.state !== "buying" && slot.state !== "selling") continue;
    try {
      applyFill(s, slot, await broker.checkFill(s, slot, tk), inst);
    } catch (e) {
      log(`slot ${slot.i}: error ${e.message}`);
    }
  }

  const stopPrice = s.lower * (1 - cfg.stopLossPct / 100);
  if (tk.last < stopPrice) {
    await stopGrid(s, inst, broker, `price ${tk.last} < stop ${stopPrice.toFixed(1)}`, cfg.sellOnStop);
    return false;
  }

  for (const slot of s.slots) {
    try {
      if (slot.state === "holding" && Number(slot.sellPrice) > tk.bid) {
        if (Number(slot.qty) * Number(slot.sellPrice) < inst.minAmt) {
          log(`slot ${slot.i}: holding ${slot.qty} is below min order value, keeping as dust`);
        } else {
          slot.orderId = await broker.place(s, slot, "Sell", slot.qty, slot.sellPrice);
          slot.state = "selling";
          log(`slot ${slot.i}: placed SELL ${slot.qty} @ ${slot.sellPrice}`);
        }
      }

      if (slot.state === "idle" && Number(slot.buyPrice) < tk.ask) {
        const committed = s.slots.filter((x) => x !== slot && x.state !== "idle").reduce((a, x) => a + x.quote, 0);
        if (committed + slot.quote > cfg.budgetUsdt + 1e-6) continue;
        const qty = floorTo(slot.quote / Number(slot.buyPrice), inst.qtyStep);
        if (Number(qty) < inst.minQty || Number(qty) * Number(slot.buyPrice) < inst.minAmt) continue;
        slot.qty = qty;
        slot.orderId = await broker.place(s, slot, "Buy", qty, slot.buyPrice);
        slot.state = "buying";
        log(`slot ${slot.i}: placed BUY ${qty} @ ${slot.buyPrice}`);
      }
    } catch (e) {
      log(`slot ${slot.i}: error ${e.message}`);
    }
  }
  saveState(s);
  return true;
}

function printStatus(s, tk) {
  const held = s.slots.filter((x) => x.state === "holding" || x.state === "selling").reduce((a, x) => a + Number(x.qty), 0);
  console.log(`\n${s.symbol} grid ${s.lower.toFixed(1)} - ${s.upper.toFixed(1)}, stop below ${(s.lower * (1 - cfg.stopLossPct / 100)).toFixed(1)}`);
  if (tk) console.log(`price ${tk.last}`);
  for (const x of s.slots) console.log(`  slot ${x.i}: buy ${x.buyPrice} -> sell ${x.sellPrice} [${x.state}]${x.qty ? " qty " + x.qty : ""}`);
  console.log(`cycles ${s.cycles}, realized PnL ${s.realizedPnl.toFixed(4)} USDT, held ${held.toFixed(6)} ${s.symbol.replace("USDT", "")}`);
  if (MODE === "paper") {
    const lockedUsdt = s.slots.filter((x) => x.state === "buying").reduce((a, x) => a + Number(x.qty) * Number(x.buyPrice), 0);
    const lockedBase = s.slots.filter((x) => x.state === "selling").reduce((a, x) => a + Number(x.qty), 0);
    const eq = s.paper.usdt + lockedUsdt + (s.paper.base + lockedBase) * (tk ? tk.last : 0);
    console.log(`paper balance: ${s.paper.usdt.toFixed(4)} USDT free + ${lockedUsdt.toFixed(4)} in orders, ${(s.paper.base + lockedBase).toFixed(6)} base, equity ~${eq.toFixed(4)} USDT`);
  }
  if (s.stopped) console.log("STOPPED (delete the state file to start a new grid)");
}

async function confirmLive(s, tk) {
  printStatus(s, tk);
  console.log(`\nLIVE MODE on ${cfg.env}: real orders up to ${cfg.budgetUsdt} USDT will be placed.`);
  if (!process.stdin.isTTY) {
    console.log("Live mode needs an interactive terminal. Aborting.");
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question('Type LIVE to start: ', r));
  rl.close();
  if (answer.trim() !== "LIVE") {
    console.log("Aborted.");
    process.exit(1);
  }
}

(async () => {
  const broker = LIVE ? liveBroker : paperBroker;
  if (LIVE) KEYS = loadKeys();
  const inst = await getInstrument();
  const tk = await getTicker();
  let s = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : null;

  if (args.has("--status")) {
    if (!s) return console.log("No state yet.");
    return printStatus(s, tk);
  }
  if (args.has("--cancel-all")) {
    if (s) return stopGrid(s, inst, broker, "manual --cancel-all", args.has("--sell"));
    await broker.cancelAll(s);
    return log("All open orders cancelled.");
  }

  const fresh = !s;
  if (fresh) s = newState(tk.last, inst);
  if (s.stopped) {
    printStatus(s, tk);
    return;
  }
  if (LIVE) await confirmLive(s, tk);
  if (fresh) {
    saveState(s);
    log(`new grid ${s.lower.toFixed(1)} - ${s.upper.toFixed(1)} with ${cfg.levels} levels, budget ${cfg.budgetUsdt} USDT`);
  }

  const once = args.has("--once");
  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
    console.log("\nStopping after current tick (open orders stay on the exchange; use --cancel-all to remove them).");
  });
  while (!stopping) {
    const ok = await tick(s, inst, broker).catch((e) => (log(`tick error: ${e.message}`), true));
    if (!ok || once) break;
    await new Promise((r) => setTimeout(r, cfg.pollSeconds * 1000));
  }
  printStatus(s, await getTicker());
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
