#!/usr/bin/env node
// Runs one bot from bots.json. Usually started by `bb-cli start <name>`; stop it with `bb-cli stop <name>`.
const fs = require("fs");
const readline = require("readline");
const U = require("./lib/util");
const { createApi } = require("./lib/api");
const { paperBroker, liveBroker } = require("./lib/broker");
const { STRATS, resolveConfig } = require("./lib/engine");

const name = process.argv[2];
const LIVE = process.argv.includes("--live");
const mode = LIVE ? "live" : "paper";

async function confirmTty(cfg) {
  if (!process.stdin.isTTY) throw new Error("live mode needs interactive confirmation: run `bb-cli start <name> --live`");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(`LIVE ${cfg.name}: real orders up to ${cfg.budgetUsdt} USDT. Type LIVE to start: `, r));
  rl.close();
  if (answer.trim() !== "LIVE") throw new Error("aborted");
}

async function main() {
  const bot = U.loadBots().find((b) => b.name === name);
  if (!bot) throw new Error(`no bot "${name}" in bots.json`);
  const cfg = resolveConfig(bot);
  const st = STRATS[cfg.type];
  const P = U.paths(name, mode);

  const other = U.readJson(P.pid);
  if (other && other.pid !== process.pid && U.isAlive(other.pid)) throw new Error(`${name} already running (pid ${other.pid}, ${other.mode})`);
  if (LIVE && process.env.BB_LIVE_CONFIRMED !== "1") await confirmTty(cfg);

  const log = (msg, level = "info") => {
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
    fs.appendFileSync(P.log, line + "\n");
    if (process.stdout.isTTY) console.log(line);
  };

  const api = createApi(cfg.env);
  const inst = await api.instrument(cfg.symbol);
  st.validate(cfg, inst);
  const tk0 = await api.ticker(cfg.symbol);

  const fresh = (prev) => ({
    name, type: cfg.type, symbol: cfg.symbol, mode, createdAt: Date.now(),
    realizedPnl: prev?.realizedPnl || 0, cycles: prev?.cycles || 0, paper: prev?.paper,
  });
  let s = U.readJson(P.state);
  if (s && s.type !== cfg.type) throw new Error(`state file is for a ${s.type} bot; run \`bb-cli reset ${name}\``);
  if (s && s.status === "halted") {
    const pos = st.position(s);
    if (pos.qty * tk0.last < inst.minAmt) {
      log(`previous run halted (${s.haltReason || "unknown"}), starting a new cycle`, "warn");
      s = fresh(s);
    }
  }
  if (!s) s = fresh(null);

  const broker = LIVE ? liveBroker(api, inst, cfg.feeRate, name) : paperBroker(s, cfg.feeRate, cfg.budgetUsdt);
  const ctx = {
    cfg, s, inst, api, broker, log, tk: tk0, now: Date.now(),
    candles: (interval, limit) => api.candles(cfg.symbol, interval, limit),
  };
  if (!s[cfg.type]) {
    st.init(ctx);
    log(`new ${cfg.type} bot on ${cfg.symbol}, budget ${cfg.budgetUsdt} USDT`);
  }

  const save = () => U.writeJson(P.state, s);
  U.writeJson(P.pid, { pid: process.pid, mode, startedAt: Date.now() });
  try { fs.unlinkSync(P.stop); } catch {}
  process.on("exit", () => {
    const cur = U.readJson(P.pid);
    if (cur && cur.pid === process.pid) try { fs.unlinkSync(P.pid); } catch {}
  });
  let signalStop = null;
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (signalStop = { sell: false, reason: sig }));

  Object.assign(s, { status: "running", haltReason: null, pid: process.pid, startedAt: Date.now(), budgetUsdt: cfg.budgetUsdt });
  save();
  log(`started in ${mode} mode`);

  const stopRequested = () => signalStop || U.readJson(P.stop);
  while (true) {
    const req = stopRequested();
    if (req) {
      try { fs.unlinkSync(P.stop); } catch {}
      try {
        ctx.tk = await api.ticker(cfg.symbol);
        await st.stop(ctx, !!req.sell, req.reason || "stop requested");
      } catch (e) {
        log(`error while stopping: ${e.message}`, "error");
      }
      s.status = "stopped";
      save();
      log("stopped");
      break;
    }
    try {
      ctx.tk = await api.ticker(cfg.symbol);
      ctx.now = Date.now();
      s.lastPrice = ctx.tk.last;
      const cont = await st.tick(ctx);
      s.lastTick = Date.now();
      s.lastError = null;
      if (cont === false) {
        s.status = "halted";
        s.haltReason ??= "strategy halted";
        save();
        log(`halted: ${s.haltReason}`, "warn");
        break;
      }
    } catch (e) {
      s.lastError = e.message;
      s.lastErrorAt = Date.now();
      log(e.message, "error");
    }
    save();
    for (let i = 0; i < cfg.pollSeconds && !stopRequested(); i++) await U.sleep(1000);
  }
}

main().catch((e) => {
  console.error(`[${name}] ${e.message}`);
  process.exitCode = 1;
});
