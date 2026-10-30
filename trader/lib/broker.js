// Brokers share one contract so strategies don't care about the mode:
//   buy fills  -> { qty: net base received (after fee), value: quote spent }
//   sell fills -> { qty: base sold, value: net quote received (after fee) }
const { sleep } = require("./util");

function paperBroker(s, feeRate, startUsdt) {
  s.paper ??= { usdt: startUsdt, base: 0, orders: {}, seq: 0 };
  const P = s.paper;
  return {
    mode: "paper",
    async limit(side, qty, price) {
      qty = Number(qty);
      price = Number(price);
      if (side === "Buy") {
        if (qty * price > P.usdt + 1e-9) throw new Error("paper: insufficient USDT");
        P.usdt -= qty * price;
      } else {
        if (qty > P.base + 1e-12) throw new Error("paper: insufficient base");
        P.base -= qty;
      }
      const id = `paper-${++P.seq}`;
      P.orders[id] = { side, qty, price };
      return id;
    },
    async check(id, side, tk) {
      const o = P.orders[id];
      if (!o) return { status: "cancelled", qty: 0, value: 0 };
      const hit = o.side === "Buy" ? tk.low ?? tk.last : tk.high ?? tk.last;
      if (o.side === "Buy" ? hit > o.price : hit < o.price) return { status: "open" };
      delete P.orders[id];
      if (o.side === "Buy") {
        const net = o.qty * (1 - feeRate);
        P.base += net;
        return { status: "filled", qty: net, value: o.qty * o.price, price: o.price };
      }
      const proceeds = o.qty * o.price * (1 - feeRate);
      P.usdt += proceeds;
      return { status: "filled", qty: o.qty, value: proceeds, price: o.price };
    },
    async cancel(ids) {
      for (const id of ids) {
        const o = P.orders[id];
        if (!o) continue;
        if (o.side === "Buy") P.usdt += o.qty * o.price;
        else P.base += o.qty;
        delete P.orders[id];
      }
    },
    async marketBuy(usdt, tk) {
      if (usdt > P.usdt + 1e-9) throw new Error("paper: insufficient USDT");
      const net = (usdt / tk.ask) * (1 - feeRate);
      P.usdt -= usdt;
      P.base += net;
      return { status: "filled", qty: net, value: usdt, price: tk.ask };
    },
    async marketSell(qty, tk) {
      qty = Math.min(Number(qty), P.base);
      const proceeds = qty * tk.bid * (1 - feeRate);
      P.base -= qty;
      P.usdt += proceeds;
      return { status: "filled", qty, value: proceeds, price: tk.bid };
    },
  };
}

const CLOSED = ["Cancelled", "Rejected", "PartiallyFilledCanceled", "Deactivated"];

function liveBroker(api, inst, feeRate, tag) {
  const symbol = inst.symbol;
  let seq = 0;
  const linkId = (side) => `${tag}-${side[0]}${Date.now().toString(36)}${(seq++ % 100).toString(36)}`.slice(0, 36);

  async function getOrder(id) {
    let o = (await api.priv("GET", "/v5/order/realtime", { category: "spot", symbol, orderId: id })).list[0];
    if (!o) o = (await api.priv("GET", "/v5/order/history", { category: "spot", symbol, orderId: id })).list[0];
    return o;
  }

  function toFill(o, side) {
    const q = Number(o.cumExecQty) || 0;
    const v = Number(o.cumExecValue) || 0;
    const price = Number(o.avgPrice) || Number(o.price) || 0;
    return side === "Buy" ? { qty: q * (1 - feeRate), value: v, price } : { qty: q, value: v * (1 - feeRate), price };
  }

  async function check(id, side) {
    const o = await getOrder(id);
    if (!o) return { status: "open" };
    if (o.orderStatus === "Filled") return { status: "filled", ...toFill(o, side) };
    if (CLOSED.includes(o.orderStatus)) return { status: "cancelled", ...toFill(o, side), reason: o.rejectReason };
    return { status: "open" };
  }

  async function settle(id, side) {
    for (let i = 0; i < 12; i++) {
      const f = await check(id, side);
      if (f.status !== "open") return f;
      await sleep(500);
    }
    throw new Error(`order ${id} did not settle`);
  }

  return {
    mode: "live",
    async limit(side, qty, price) {
      const r = await api.priv("POST", "/v5/order/create", {
        category: "spot", symbol, side, orderType: "Limit", qty: String(qty), price: String(price),
        timeInForce: "PostOnly", orderLinkId: linkId(side),
      });
      return r.orderId;
    },
    check,
    async cancel(ids) {
      for (const id of ids) {
        try {
          await api.priv("POST", "/v5/order/cancel", { category: "spot", symbol, orderId: id });
        } catch (e) {
          if (!/170213|110001|not exist|too late/i.test(e.message)) throw e;
        }
      }
    },
    settle,
    async marketBuy(usdt) {
      const r = await api.priv("POST", "/v5/order/create", {
        category: "spot", symbol, side: "Buy", orderType: "Market",
        qty: (Math.floor(usdt * 100) / 100).toFixed(2), marketUnit: "quoteCoin", orderLinkId: linkId("Buy"),
      });
      const f = await settle(r.orderId, "Buy");
      if (!(f.qty > 0)) throw new Error(`market buy not filled (${f.reason || f.status})`);
      return f;
    },
    async marketSell(qty) {
      const r = await api.priv("POST", "/v5/order/create", {
        category: "spot", symbol, side: "Sell", orderType: "Market", qty: String(qty), marketUnit: "baseCoin",
        orderLinkId: linkId("Sell"),
      });
      const f = await settle(r.orderId, "Sell");
      if (!(f.qty > 0)) throw new Error(`market sell not filled (${f.reason || f.status})`);
      return f;
    },
  };
}

module.exports = { paperBroker, liveBroker };
