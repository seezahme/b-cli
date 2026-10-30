const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const RECV = "5000";

const LOCAL_CRED = path.join(__dirname, "..", ".bybit", "oauth_token.json");

function credCandidates() {
  if (process.env.BYBIT_CRED_DIR) return [path.join(process.env.BYBIT_CRED_DIR, "oauth_token.json")];
  const user = process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "bybit", "oauth_token.json")
    : path.join(os.homedir(), ".bybit", "oauth_token.json");
  return [LOCAL_CRED, user];
}

function credFile() {
  const list = credCandidates();
  return list.find((p) => fs.existsSync(p)) || list.join(" or ");
}

let keyError = null;
function loadKeys() {
  if (process.env.BYBIT_API_KEY && process.env.BYBIT_API_SECRET) {
    return { key: process.env.BYBIT_API_KEY, secret: process.env.BYBIT_API_SECRET };
  }
  try {
    const file = credCandidates().find((p) => fs.existsSync(p));
    if (!file) throw Object.assign(new Error(`no credentials file at ${credCandidates().join(" or ")}`), { code: "ENOENT" });
    const raw = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
    const acc = JSON.parse(raw)["ai-account"];
    if (acc && acc.api_key && acc.api_secret) return { key: acc.api_key, secret: acc.api_secret };
    keyError = "file has no ai-account keys (finish the OAuth sub-account step)";
  } catch (e) {
    keyError = e.code ? `${e.code}: ${e.message}` : e.message;
  }
  return null;
}

// Errors raised before the TCP/TLS connection exists mean the request never reached Bybit.
const CONNECT_ERRORS = new Set(["UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET_BEFORE_SEND"]);

function createApi(env = "mainnet") {
  const hosts = env === "testnet" ? ["https://api-testnet.bybit.com"] : ["https://api.bybit.com", "https://api.bytick.com"];
  let hostIdx = 0;
  let keys;
  const instCache = {};

  // GETs retry on any network error. POSTs retry only when the connection was never made,
  // because a POST that reached Bybit may have placed an order.
  async function request(pathAndQuery, opts = {}) {
    const isGet = !opts.method || opts.method === "GET";
    const attempts = 2 * hosts.length;
    for (let i = 1; ; i++) {
      try {
        const r = await fetch(hosts[hostIdx] + pathAndQuery, { ...opts, signal: AbortSignal.timeout(15000) });
        return await r.json();
      } catch (e) {
        const code = e.cause?.code || e.name;
        const safe = isGet || CONNECT_ERRORS.has(code);
        if (!safe || i >= attempts) throw new Error(`network error: ${code || e.message}`);
        hostIdx = (hostIdx + 1) % hosts.length;
        await new Promise((res) => setTimeout(res, 500 * i));
      }
    }
  }

  async function pub(endpoint, params) {
    const j = await request(`${endpoint}?${new URLSearchParams(params)}`);
    if (j.retCode !== 0) throw new Error(`${endpoint}: ${j.retMsg} (${j.retCode})`);
    return j.result;
  }

  // Signed requests must be within recv_window of Bybit's clock, so sign with server time, not the local clock.
  let clockOffset = null;
  let offsetAt = 0;
  async function syncClock() {
    const t0 = Date.now();
    const j = await request(`/v5/market/time`);
    const t1 = Date.now();
    clockOffset = Number(j.time) - Math.round((t0 + t1) / 2);
    offsetAt = t1;
  }

  async function priv(method, endpoint, params = {}, retried = false) {
    if (keys === undefined) keys = loadKeys();
    if (!keys) throw new Error(`No API keys (${keyError || "not configured"})`);
    if (clockOffset === null || Date.now() - offsetAt > 10 * 60000) await syncClock();
    const ts = (Date.now() + clockOffset).toString();
    const payload = method === "GET" ? new URLSearchParams(params).toString() : JSON.stringify(params);
    const sign = crypto.createHmac("sha256", keys.secret).update(ts + keys.key + RECV + payload).digest("hex");
    const headers = {
      "X-BAPI-API-KEY": keys.key,
      "X-BAPI-TIMESTAMP": ts,
      "X-BAPI-RECV-WINDOW": RECV,
      "X-BAPI-SIGN": sign,
      "Content-Type": "application/json",
    };
    const url = method === "GET" ? `${endpoint}?${payload}` : endpoint;
    const j = await request(url, { method, headers, body: method === "GET" ? undefined : payload });
    // 10002 = timestamp rejected before processing, so a resend after resyncing cannot duplicate an order.
    if (j.retCode === 10002 && !retried) {
      await syncClock();
      return priv(method, endpoint, params, true);
    }
    if (j.retCode !== 0) throw new Error(`${endpoint}: ${j.retMsg} (${j.retCode})`);
    return j.result;
  }

  const toTicker = (t) => ({
    symbol: t.symbol,
    last: Number(t.lastPrice),
    bid: Number(t.bid1Price),
    ask: Number(t.ask1Price),
    change24h: Number(t.price24hPcnt) * 100,
  });

  return {
    env,
    keyError: () => keyError,
    hasKeys() {
      if (keys === undefined) keys = loadKeys();
      return !!keys;
    },
    pub,
    priv,
    async instrument(symbol) {
      if (instCache[symbol]) return instCache[symbol];
      const i = (await pub("/v5/market/instruments-info", { category: "spot", symbol })).list[0];
      if (!i) throw new Error(`Unknown spot symbol ${symbol}`);
      if (i.status !== "Trading") throw new Error(`${symbol} is not trading (status ${i.status})`);
      return (instCache[symbol] = {
        symbol,
        base: i.baseCoin,
        quote: i.quoteCoin,
        qtyStep: i.lotSizeFilter.basePrecision,
        minQty: Number(i.lotSizeFilter.minOrderQty),
        minAmt: Number(i.lotSizeFilter.minOrderAmt),
        tick: i.priceFilter.tickSize,
      });
    },
    // All trading spot pairs quoted in USDT: [{ symbol, base }].
    async spotSymbols() {
      if (instCache.__all) return instCache.__all;
      const list = [];
      let cursor = "";
      do {
        const r = await pub("/v5/market/instruments-info", { category: "spot", limit: "1000", ...(cursor ? { cursor } : {}) });
        list.push(...r.list);
        cursor = r.nextPageCursor;
      } while (cursor);
      return (instCache.__all = list.filter((i) => i.quoteCoin === "USDT" && i.status === "Trading").map((i) => ({ symbol: i.symbol, base: i.baseCoin })));
    },
    async ticker(symbol) {
      return toTicker((await pub("/v5/market/tickers", { category: "spot", symbol })).list[0]);
    },
    async tickers(symbols) {
      const all = (await pub("/v5/market/tickers", { category: "spot" })).list;
      const want = new Set(symbols);
      return Object.fromEntries(all.filter((t) => want.has(t.symbol)).map((t) => [t.symbol, toTicker(t)]));
    },
    // Oldest first, only closed candles. interval: Bybit kline interval ("1","5","15","60","240","D"...).
    async candles(symbol, interval, limit, end) {
      const params = { category: "spot", symbol, interval, limit: String(Math.min(limit + 1, 1000)) };
      if (end) params.end = String(end);
      const list = (await pub("/v5/market/kline", params)).list;
      const rows = list.map((r) => ({ t: Number(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4] })).reverse();
      if (!end) rows.pop();
      return rows.slice(-limit);
    },
    async funding() {
      const r = await priv("GET", "/v5/asset/transfer/query-account-coins-balance", { accountType: "FUND" });
      return (r.balance || []).filter((b) => Number(b.walletBalance) > 0).map((b) => ({ coin: b.coin, balance: Number(b.walletBalance) }));
    },
    async wallet() {
      const a = (await priv("GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" })).list[0] || {};
      return {
        totalEquity: Number(a.totalEquity) || 0,
        coins: (a.coin || [])
          .filter((x) => Number(x.walletBalance) > 0)
          .map((x) => ({ coin: x.coin, balance: Number(x.walletBalance), usd: Number(x.usdValue), locked: Number(x.locked || 0) })),
      };
    },
  };
}

module.exports = { createApi, loadKeys, credFile };
