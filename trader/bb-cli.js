#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");
const U = require("./lib/util");
const { c, pad, fmt, fmtPrice, fmtSigned, ago } = U;
const { createApi, credFile } = require("./lib/api");
const { STRATS, resolveConfig, positionOf, backtest } = require("./lib/engine");
const SETTINGS = require("./lib/settings");
const PLUGINS = require("./lib/plugins");

const RUNNER = path.join(__dirname, "runner.js");
const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const positional = argv.slice(1).filter((a) => !a.startsWith("--"));
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const api = createApi("mainnet");

// ---------- helpers ----------
function targets(bots, arg, allowAll = true) {
  if (!arg) throw new Error(allowAll ? "specify a bot name or 'all'" : "specify a bot name");
  if (arg === "all") {
    if (!allowAll) throw new Error("specify a bot name ('all' isn't allowed here)");
    return bots;
  }
  const b = bots.find((x) => x.name === arg);
  if (!b) throw new Error(`no bot "${arg}" (have: ${bots.map((x) => x.name).join(", ")})`);
  return [b];
}

// Inside the monitor (BB_EMBED=1) questions go to the monitor's prompt: the question is sent as one
// marked line on stdout and the answer comes back as a line on stdin.
const EMBED = process.env.BB_EMBED === "1";
const ASK_MARK = "\u0001ASK ";
let embedLines = null;
const canAsk = () => process.stdin.isTTY || EMBED;

async function ask(question) {
  if (EMBED) {
    if (!embedLines) {
      const rl = readline.createInterface({ input: process.stdin });
      const queue = [];
      const waiting = [];
      rl.on("line", (l) => (waiting.length ? waiting.shift()(l) : queue.push(l)));
      rl.on("close", () => waiting.splice(0).forEach((w) => w(null)));
      embedLines = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiting.push(r)));
    }
    process.stdout.write(ASK_MARK + JSON.stringify(question) + "\n");
    const a = await embedLines();
    if (a === null) throw new Error("aborted");
    return a.trim();
  }
  if (!process.stdin.isTTY) return null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((r) => rl.question(question, r));
  rl.close();
  return a.trim();
}

const modeTag = (m) => (m === "live" ? c.bold(c.red("LIVE ")) : m === "paper" ? c.cyan("paper") : c.gray("-    "));

function statusTag(row) {
  const { s, run, cfg } = row;
  if (run) {
    const stale = s?.lastTick && Date.now() - s.lastTick > (cfg.pollSeconds * 3 + 30) * 1000;
    if (stale) return c.red("● stale");
    if (s?.lastError) return c.yellow("● error");
    return c.green("● run");
  }
  if (!s) return c.gray("· new");
  if (s.status === "running") return c.red("✖ dead");
  if (s.status === "halted") return c.yellow("■ halt");
  return c.gray("○ stop");
}

function collect() {
  const rows = [];
  for (const b of U.loadBots()) {
    const cfg = resolveConfig(b);
    const run = U.runningInfo(b.name);
    let any = false;
    for (const mode of ["live", "paper"]) {
      const s = U.readJson(U.paths(b.name, mode).state);
      const isRun = run && run.mode === mode ? run : null;
      if (!s && !isRun) continue;
      any = true;
      rows.push({ b, cfg, mode, s, run: isRun });
    }
    if (!any) rows.push({ b, cfg, mode: null, s: null, run: null });
  }
  return rows;
}

async function quotes(rows) {
  try {
    return await api.tickers([...new Set(rows.map((r) => r.cfg.symbol))]);
  } catch {
    return {};
  }
}

// [width, right-aligned]; BOT and SYMBOL widths follow the longest value, DETAILS takes the rest of the line.
const COLS = {
  BOT: [null], TYPE: [5], MODE: [5], STATUS: [8], SYMBOL: [null], PRICE: [10, 1], "24H": [7, 1],
  POSITION: [16, 1], VALUE: [7, 1], AVG: [10, 1], uPnL: [8, 1], rPnL: [8, 1], "RET%": [7, 1],
  ORD: [3, 1], TICK: [5, 1], DETAILS: [0],
};
const botWidth = (names) => Math.min(20, Math.max(3, ...names.map((n) => n.length)));

function renderTable(rows, tks, view = SETTINGS.load()) {
  const out = [];
  const auto = {
    BOT: botWidth(rows.map((r) => r.b.name)),
    SYMBOL: Math.min(14, Math.max(6, ...rows.map((r) => r.cfg.symbol.length))),
  };
  const cols = view.columns.map((k) => [k, auto[k] ?? COLS[k][0], COLS[k][1]]);
  const line = (cells) => cols.map(([k, w, r]) => (w ? U.fit(cells[k], w, r) : cells[k])).join(" ");
  out.push(c.bold(line(Object.fromEntries(cols.map(([k]) => [k, k])))));
  const totals = {};
  for (const row of rows) {
    const { b, cfg, mode, s } = row;
    const tk = tks[cfg.symbol];
    const price = tk?.last ?? s?.lastPrice;
    const base = cfg.symbol.replace(/USDT$/, "");
    const p = s ? positionOf(s, price) : null;
    const rp = s?.realizedPnl ?? 0;
    const ret = s ? ((rp + (p?.upnl || 0)) / cfg.budgetUsdt) * 100 : null;
    const st = STRATS[cfg.type];
    let details = s ? st.info(s, cfg) : c.gray(`budget ${cfg.budgetUsdt} USDT`);
    if (row.run && s?.lastError) details = c.yellow(`⚠ ${s.lastError.slice(0, 60)}`);
    else if (s?.status === "halted") details = c.yellow(s.haltReason || "halted");
    const open = p && p.qty > 0 && p.cost > 0;
    const q = (n) => n.toFixed(n >= 1000 ? 1 : n >= 1 ? 4 : 6);
    const posCell = open ? `${q(p.qty)} ${base}` : p && p.qty > 0 ? c.gray(`dust ${q(p.qty)}`) : c.gray("flat");
    out.push(line({
      BOT: c.bold(b.name), TYPE: cfg.type, MODE: modeTag(mode), STATUS: statusTag(row), SYMBOL: cfg.symbol, PRICE: fmtPrice(price),
      "24H": tk ? fmtSigned(tk.change24h) + "%" : "-",
      POSITION: posCell,
      VALUE: open ? fmt(p.value) : c.gray("-"),
      AVG: open ? fmtPrice(p.cost / p.qty) : c.gray("-"),
      uPnL: open ? fmtSigned(p.upnl, 3) : c.gray("-"),
      rPnL: s ? fmtSigned(rp, 3) : c.gray("-"),
      "RET%": ret == null ? c.gray("-") : fmtSigned(ret),
      ORD: s ? String(st.openOrders(s)) : "-",
      TICK: row.run ? ago(s?.lastTick) : c.gray(s ? ago(s.lastTick) : "-"),
      DETAILS: details,
    }));
    if (s && mode) {
      const t = (totals[mode] ??= { budget: 0, value: 0, upnl: 0, rpnl: 0, n: 0, running: 0 });
      t.budget += cfg.budgetUsdt;
      t.value += p?.value || 0;
      t.upnl += p?.upnl || 0;
      t.rpnl += rp;
      t.n += 1;
      if (row.run) t.running += 1;
    }
  }
  if (view.sections.totals) for (const [mode, t] of Object.entries(totals)) {
    const total = t.upnl + t.rpnl;
    out.push(
      `${modeTag(mode)} ${c.dim("total")}  bots ${t.running}/${t.n} running · budget ${fmt(t.budget)} USDT · in positions ${fmt(t.value)} · ` +
        `uPnL ${fmtSigned(t.upnl, 3)} · rPnL ${fmtSigned(t.rpnl, 3)} · PnL ${fmtSigned(total, 3)} (${fmtSigned((total / t.budget) * 100)}%)`
    );
  }
  return out;
}

function colorLogLine(line) {
  const m = line.match(/^(\S+) (\S+)\s+(.*)$/);
  if (!m) return line;
  const [, ts, level, msg] = m;
  const time = c.gray(new Date(ts).toLocaleTimeString());
  let body = msg;
  if (level === "ERROR") body = c.red(msg);
  else if (level === "WARN") body = c.yellow(msg);
  else if (level === "TRADE") body = /^SELL/.test(msg) ? c.magenta(msg) : c.green(msg);
  else body = c.gray(msg);
  return `${time} ${body}`;
}

async function accountLine() {
  if (!api.hasKeys()) return c.yellow(`account: can't load API keys from ${credFile()}: ${api.keyError() || "not configured"} (live bots disabled)`);
  try {
    const w = await api.wallet();
    const coins = w.coins.length
      ? w.coins.map((x) => `${c.bold(x.coin)} ${x.balance < 1 ? x.balance.toFixed(6) : x.balance.toFixed(2)}${x.coin === "USDT" ? "" : c.gray(` ($${x.usd.toFixed(2)})`)}${x.locked ? c.gray(` locked ${x.locked}`) : ""}`).join(" · ")
      : c.yellow("empty (transfer USDT to the AI subaccount's Unified account)");
    let line = `${c.bold("Account")} ${c.gray("(Unified, live)")}: equity ${c.bold("$" + w.totalEquity.toFixed(2))} · ${coins}`;
    const fund = await api.funding().catch(() => []);
    if (fund.length) {
      line += `\n${c.bold("Funding")} ${c.gray("(not tradable until transferred to Unified)")}: ` +
        fund.map((x) => `${c.bold(x.coin)} ${x.balance < 1 ? x.balance.toFixed(6) : x.balance.toFixed(2)}`).join(" · ");
    }
    return line;
  } catch (e) {
    return c.red(`account: ${e.message}`);
  }
}

// ---------- commands ----------
async function cmdStatus() {
  const rows = collect();
  const tks = await quotes(rows);
  const view = SETTINGS.load();
  console.log(renderTable(rows, tks, view).join("\n"));
  if (view.sections.account) console.log("\n" + (await accountLine()));
}

function cmdSettings() {
  const [what, ...rest] = positional;
  const cur = SETTINGS.load();
  const next = { ...cur, sections: { ...cur.sections } };
  const cols = (list) => list.map((n) => SETTINGS.columnKey(n) || (() => { throw new Error(`unknown column "${n}" (${SETTINGS.COLUMNS.join(", ")})`); })());
  const onOff = (v) => {
    if (/^(on|true|yes|show|1)$/i.test(v || "")) return true;
    if (/^(off|false|no|hide|0)$/i.test(v || "")) return false;
    throw new Error("use on or off");
  };
  switch (what) {
    case undefined:
      break;
    case "hide":
    case "show": {
      if (!rest.length) throw new Error(`settings ${what} <column|section...>`);
      for (const n of rest) {
        if (n in SETTINGS.SECTIONS) next.sections[n] = what === "show";
        else {
          const [k] = cols([n]);
          next.columns = what === "show" ? SETTINGS.COLUMNS.filter((x) => x === k || next.columns.includes(x)) : next.columns.filter((x) => x !== k);
        }
      }
      break;
    }
    case "columns":
    case "only":
      if (!rest.length) throw new Error("settings columns <column...>");
      next.columns = SETTINGS.COLUMNS.filter((x) => cols(rest.join(",").split(/[,\s]+/).filter(Boolean)).includes(x));
      break;
    case "preset":
    case "full":
    case "compact":
    case "minimal": {
      const name = what === "preset" ? rest[0] : what;
      if (!SETTINGS.PRESETS[name]) throw new Error(`presets: ${Object.keys(SETTINGS.PRESETS).join(", ")}`);
      next.columns = SETTINGS.PRESETS[name];
      break;
    }
    case "refresh":
      if (!(Number(rest[0]) >= 0.5)) throw new Error("settings refresh <seconds, 0.5 or more>");
      next.refresh = Number(rest[0]);
      break;
    case "reset":
      SETTINGS.save(SETTINGS.DEFAULTS);
      return console.log("display settings reset to defaults");
    default:
      if (what in SETTINGS.SECTIONS) {
        next.sections[what] = onOff(rest[0]);
        break;
      }
      throw new Error(`unknown setting "${what}" — try: settings, settings hide AVG, settings compact`);
  }
  if (!next.columns.includes("BOT")) next.columns = ["BOT", ...next.columns];
  if (what !== undefined) SETTINGS.save(next);

  const mark = (on) => (on ? c.green("✔") : c.gray("·"));
  console.log(c.bold("Columns") + c.gray("  (settings hide|show <col>, settings columns <col...>, settings compact|minimal|full)"));
  console.log("  " + SETTINGS.COLUMNS.map((k) => `${mark(next.columns.includes(k))} ${next.columns.includes(k) ? k : c.gray(k)}`).join("  "));
  console.log(c.bold("Sections") + c.gray("  (settings <section> on|off)"));
  for (const [k, d] of Object.entries(SETTINGS.SECTIONS)) console.log(`  ${mark(next.sections[k])} ${pad(k, 8)} ${c.gray(d)}`);
  console.log(`${c.bold("Refresh")}  ${next.refresh}s ${c.gray("(settings refresh <seconds>)")}   ${c.gray("settings reset restores everything")}`);
}

// Reads every bot log incrementally (only the bytes appended since the last call) and keeps
// one merged, time-ordered list for the monitor's scrollable pane.
function logStore(max = 5000) {
  const files = {};
  const lines = [];
  return {
    lines,
    poll(bots) {
      let added = [];
      for (const b of bots) {
        for (const mode of ["live", "paper"]) {
          const file = U.paths(b.name, mode).log;
          let size;
          try {
            size = fs.statSync(file).size;
          } catch {
            continue;
          }
          const f = (files[file] ??= { off: Math.max(0, size - 256 * 1024), rest: "", first: true });
          if (size < f.off) Object.assign(f, { off: 0, rest: "" });
          if (size === f.off) continue;
          const buf = Buffer.alloc(size - f.off);
          const fd = fs.openSync(file, "r");
          fs.readSync(fd, buf, 0, buf.length, f.off);
          fs.closeSync(fd);
          const midLine = f.first && f.off > 0; // first read of a big file may start mid-line
          f.off = size;
          const parts = (f.rest + buf.toString("utf8")).split(/\r?\n/);
          f.rest = parts.pop();
          if (midLine) parts.shift();
          f.first = false;
          for (const raw of parts.filter(Boolean)) added.push({ ts: Date.parse(raw.slice(0, 24)) || 0, bot: b.name, mode, raw });
        }
      }
      if (!added.length) return [];
      added.sort((a, b) => a.ts - b.ts);
      const ordered = !lines.length || lines[lines.length - 1].ts <= added[0].ts;
      lines.push(...added);
      if (!ordered) lines.sort((a, b) => a.ts - b.ts);
      if (lines.length > max) lines.splice(0, lines.length - max);
      return added;
    },
    push(entry) {
      lines.push(entry);
      if (lines.length > max) lines.splice(0, lines.length - max);
    },
  };
}

const KEY_RE = /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}|\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b|[\s\S]/g;

const tokenize = (line) => [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);

async function cmdMonitor() {
  let every = Math.max(0.5, Number(opt("--interval", SETTINGS.load().refresh)));
  const mouse = !flags.has("--no-mouse");
  const out = process.stdout;
  const logs = logStore();
  let account = c.gray("account: loading...");
  let tks = {};
  let scroll = 0; // lines above the bottom; 0 = follow new lines
  let filter = "all";
  let tradesOnly = false;
  let pageSize = 10;
  let fetching = false;
  let accountAt = 0;
  let input = "";
  let cursor = 0;
  const history = [];
  let histIdx = 0;
  let running = null; // { line, child } of the command being run
  let question = null; // question the running command is waiting on
  let view = SETTINGS.load();

  const cliLine = (text) => logs.push({ ts: Date.now(), cli: true, text });

  // Network calls run in the background so the screen and keys never wait on Bybit.
  async function refresh(rows) {
    if (fetching) return;
    fetching = true;
    try {
      const q = await quotes(rows);
      if (Object.keys(q).length) tks = q;
      if (Date.now() - accountAt > 15000) {
        accountAt = Date.now();
        account = await accountLine();
      }
    } finally {
      fetching = false;
    }
  }

  const visible = (l) => l.cli || ((filter === "all" || l.bot === filter) && (!tradesOnly || / (TRADE|ERROR|WARN) /.test(l.raw.slice(24, 32))));
  let nameW = 12;
  const showLine = (l) => (l.cli ? l.text : `${U.fit(c.bold(l.bot), nameW)} ${modeTag(l.mode)} ${colorLogLine(l.raw)}`);

  function render() {
    let rows;
    try {
      rows = collect();
      view = SETTINGS.load();
    } catch (e) {
      out.write(`\x1b[H${c.red(e.message)}\x1b[K\x1b[J`);
      return;
    }
    refresh(rows);
    const bots = U.loadBots();
    nameW = botWidth(bots.map((b) => b.name));
    const added = logs.poll(bots);
    if (scroll > 0) scroll += added.filter(visible).length; // keep the view still while scrolled up

    const width = out.columns || 160;
    const height = out.rows || 40;
    const S = view.sections;
    const head = [
      `${c.inverse(c.bold(" bb-cli "))} ${S.clock ? c.gray(new Date().toLocaleString()) + "  " : ""}${c.gray(`refresh ${every}s · type a command below, "help" for the list`)}`,
      "",
      ...(S.account ? [...account.split("\n"), ""] : []),
      ...renderTable(rows, tks, view),
    ];
    const shown = logs.lines.filter(visible);
    const paneH = Math.max(3, height - head.length - (S.keys ? 3 : 2));
    pageSize = Math.max(1, paneH - 1);
    scroll = Math.max(0, Math.min(scroll, shown.length - paneH));
    const end = shown.length - scroll;
    const start = Math.max(0, end - paneH);
    const where = scroll ? c.yellow(`▲ scrolled · ${scroll} newer line(s) below · [End] follow`) : c.green("● following");
    const label = ` LOG ${c.gray("·")} ${filter === "all" ? "all bots" : c.bold(filter)}${tradesOnly ? c.gray(" · trades/errors") : ""} ${c.gray(`· ${start + 1}-${end} of ${shown.length}`)} `;
    const rule = label + c.gray("─".repeat(Math.max(0, width - U.stripAnsi(label).length - U.stripAnsi(where).length - 2))) + " " + where;
    const body = shown.slice(start, end).map(showLine);
    while (body.length < paneH) body.push("");
    const keys = c.gray("[PgUp/PgDn/wheel] scroll  [Home/End] top/bottom  [↑↓] history  [Tab] complete / filter bot  [Ctrl+T] trades only  [Ctrl+C] cancel/quit");
    const field = `${input.slice(0, cursor)}${c.inverse(input[cursor] || " ")}${input.slice(cursor + 1)}`;
    const promptLine = question
      ? `${c.yellow(c.bold("?"))} ${question} ${field}`
      : running
        ? `${c.yellow("…")} ${c.gray(`running: ${running.line} · Ctrl+C to cancel`)}`
        : `${c.cyan(c.bold("bb-cli›"))} ${field}`;
    const frame = [...head, rule, ...body, ...(S.keys ? [keys] : []), promptLine].slice(0, height);
    out.write("\x1b[H" + frame.map((l) => U.clip(l, width) + "\x1b[K").join("\n") + "\x1b[J");
  }

  const enterScreen = () => out.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[?1007h" + (mouse ? "\x1b[?1000h\x1b[?1006h" : ""));
  const leaveScreen = () => out.write((mouse ? "\x1b[?1006l\x1b[?1000l" : "") + "\x1b[?1007l\x1b[?25h\x1b[?1049l");
  const quit = () => {
    if (running) running.child.kill();
    leaveScreen();
    process.exit(0);
  };
  enterScreen();
  process.on("SIGINT", quit);
  out.on("resize", render);

  // Commands run as a child bb-cli whose output lands in the log pane. Its questions (wizard,
  // LIVE confirmation...) show up in the prompt and the typed answer is sent back on its stdin.
  function runCaptured(args) {
    const child = spawn(process.execPath, [__filename, ...args], {
      cwd: U.ROOT, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, BB_COLOR: "1", BB_EMBED: "1" },
    });
    running = { line: args.join(" "), child };
    let rest = "";
    const onData = (d) => {
      const parts = (rest + d.toString()).split(/\r?\n/);
      rest = parts.pop();
      for (const p of parts) {
        if (p.startsWith(ASK_MARK)) {
          question = JSON.parse(p.slice(ASK_MARK.length));
          input = "";
          cursor = 0;
        } else cliLine("  " + p.split("\r").pop());
      }
      render();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      if (rest) cliLine("  " + rest.split("\r").pop());
      if (code) cliLine(c.red(`  (exit code ${code})`));
      running = null;
      question = null;
      accountAt = 0;
      render();
    });
  }

  function answer(text) {
    cliLine(`  ${c.yellow("?")} ${question} ${c.bold(text)}`);
    question = null;
    running.child.stdin.write(text + "\n");
  }

  const TUI_HELP = [
    "In the monitor you can type any bb-cli command, e.g. new · start scalp-btc · stop all --sell · set scalp-eth entryPct=0.5 · rm old-bot",
    "Extra monitor commands: filter <bot|all> · trades (toggle trades/errors only) · clear (drop command output) · quit",
    "Ctrl+C cancels a running command or question; on an empty prompt it quits.",
  ];

  function execute(line) {
    let args = tokenize(line.trim());
    if (args[0] === "node" && /bb(-cli)?(\.js)?$/.test(args[1] || "")) args = args.slice(2);
    else if (/^bb(-cli)?$/.test(args[0] || "")) args = args.slice(1);
    if (!args.length) return;
    cliLine(`${c.cyan(c.bold("bb-cli›"))} ${c.bold(args.join(" "))}`);
    scroll = 0;
    const [cmd, arg] = args;
    if (["quit", "exit", "q"].includes(cmd)) return quit();
    if (cmd === "filter") {
      if (arg && arg !== "all" && !U.loadBots().some((b) => b.name === arg)) return cliLine(c.red(`  no bot "${arg}"`));
      filter = arg || "all";
      return cliLine(c.gray(`  showing ${filter === "all" ? "all bots" : filter}`));
    }
    if (cmd === "trades") {
      tradesOnly = !tradesOnly;
      return cliLine(c.gray(`  ${tradesOnly ? "only trades, warnings and errors" : "all log lines"}`));
    }
    if (cmd === "clear") {
      logs.lines.splice(0, logs.lines.length, ...logs.lines.filter((l) => !l.cli));
      return;
    }
    if (["monitor", "mon", "watch"].includes(cmd)) return cliLine(c.gray("  you're already in the monitor"));
    if (cmd === "help" || cmd === "?") TUI_HELP.forEach((l) => cliLine(c.gray("  " + l)));
    if (running) return cliLine(c.yellow(`  wait for "${running.line}" to finish, or Ctrl+C to cancel it`));
    if (cmd === "settings" && args[1] === "refresh" && Number(args[2]) >= 0.5) every = Number(args[2]);
    runCaptured(args);
  }

  function complete() {
    const before = input.slice(0, cursor);
    const parts = before.split(/\s+/);
    const word = parts[parts.length - 1];
    const pool = parts.length === 1
      ? [...reservedNames(), ...PLUGINS.installed().flatMap((p) => Object.keys(p.commands))]
      : [...U.loadBots().map((b) => b.name), "all", "--live", "--sell", "--paper", "--days", "--trades", "--force", ...Object.keys(STRATS).map((t) => `type=${t}`)];
    const hits = [...new Set(pool)].filter((x) => x.startsWith(word));
    if (!hits.length) return;
    let common = hits[0];
    for (const h of hits) while (!h.startsWith(common)) common = common.slice(0, -1);
    const add = (hits.length === 1 ? hits[0] + " " : common).slice(word.length);
    if (!add && hits.length > 1) return cliLine(c.gray("  " + hits.join("  ")));
    input = before + add + input.slice(cursor);
    cursor += add.length;
  }

  const names = () => ["all", ...U.loadBots().map((b) => b.name)];
  const cycleFilter = (dir) => {
    const n = names();
    filter = n[(n.indexOf(filter) + dir + n.length) % n.length];
    scroll = 0;
  };

  function onKey(k) {
    switch (k) {
      case "\u0003":
        if (input) { input = ""; cursor = 0; break; }
        if (running) { running.child.kill(); cliLine(c.yellow("  cancelled")); question = null; break; }
        return quit();
      case "\x1b": case "\u0015": input = ""; cursor = 0; break;
      case "\r": case "\n": {
        const line = input;
        input = "";
        cursor = 0;
        if (question) { answer(line); break; }
        if (running && line.trim() && !/^(help|\?|filter|trades|clear|quit|exit|q)\b/.test(line.trim())) {
          cliLine(c.yellow(`  wait for "${running.line}" to finish, or Ctrl+C to cancel it`));
          break;
        }
        if (line.trim() && history[history.length - 1] !== line) history.push(line);
        histIdx = history.length;
        execute(line);
        break;
      }
      case "\x7f": case "\b":
        if (cursor > 0) { input = input.slice(0, cursor - 1) + input.slice(cursor); cursor--; }
        break;
      case "\x1b[3~": input = input.slice(0, cursor) + input.slice(cursor + 1); break;
      case "\x1b[D": cursor = Math.max(0, cursor - 1); break;
      case "\x1b[C": cursor = Math.min(input.length, cursor + 1); break;
      case "\u0001": cursor = 0; break;
      case "\u0005": cursor = input.length; break;
      case "\x1b[A": if (histIdx > 0) { input = history[--histIdx]; cursor = input.length; } break;
      case "\x1b[B": histIdx = Math.min(history.length, histIdx + 1); input = history[histIdx] || ""; cursor = input.length; break;
      case "\x1b[1;2A": scroll += 1; break;
      case "\x1b[1;2B": scroll -= 1; break;
      case "\x1b[5~": scroll += pageSize; break;
      case "\x1b[6~": scroll -= pageSize; break;
      case "\x1b[H": case "\x1b[1~": case "\x1bOH": scroll = Infinity; break;
      case "\x1b[F": case "\x1b[4~": case "\x1bOF": scroll = 0; break;
      case "\t": if (input) complete(); else cycleFilter(1); break;
      case "\x1b[Z": cycleFilter(-1); break;
      case "\u0014": tradesOnly = !tradesOnly; scroll = 0; break;
      default:
        if (k.length !== 1 || k < " ") return;
        input = input.slice(0, cursor) + k + input.slice(cursor);
        cursor++;
    }
    if (scroll === Infinity) scroll = logs.lines.length;
    scroll = Math.max(0, scroll);
    render();
  }
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (d) => {
      for (const k of d.toString().match(KEY_RE) || []) {
        const w = k.match(/^\x1b\[<(\d+);\d+;\d+M$/);
        if (w && (w[1] === "64" || w[1] === "65")) {
          scroll = Math.max(0, scroll + (w[1] === "64" ? 3 : -3));
          render();
        } else onKey(k);
      }
    });
  }
  const loop = () => {
    render();
    setTimeout(loop, every * 1000);
  };
  loop();
}

async function cmdStart() {
  const bots = U.loadBots();
  const live = flags.has("--live");
  const list = targets(bots, positional[0]).filter((b) => {
    const run = U.runningInfo(b.name);
    if (run) console.log(c.yellow(`${b.name} already running (${run.mode}, pid ${run.pid})`));
    return !run;
  });
  if (!list.length) return;

  if (live) {
    if (!api.hasKeys()) throw new Error("no API keys found; complete Bybit OAuth or set BYBIT_API_KEY/BYBIT_API_SECRET");
    const w = await api.wallet();
    const usdt = w.coins.find((x) => x.coin === "USDT")?.balance || 0;
    const runningLive = bots.filter((b) => U.runningInfo(b.name)?.mode === "live");
    const total = [...runningLive, ...list].reduce((a, b) => a + b.budgetUsdt, 0);
    console.log(c.bold(c.red("\nLIVE TRADING — real money on Bybit mainnet")));
    for (const b of list) console.log(`  ${pad(c.bold(b.name), 14)} ${pad(b.type, 6)} ${pad(b.symbol, 10)} budget ${b.budgetUsdt} USDT`);
    console.log(`  live budgets after start: ${total} USDT · USDT in account: ${usdt.toFixed(2)}`);
    if (total > usdt + 1e-6) console.log(c.yellow(`  ⚠ budgets exceed the account's USDT balance; some orders will be rejected`));
    const a = await ask(`Type ${c.bold("LIVE")} to start ${list.length} bot(s) with real money: `);
    if (a !== "LIVE") throw new Error(a === null ? "live start needs an interactive terminal" : "aborted");
  }

  for (const b of list) {
    const P = U.paths(b.name, live ? "live" : "paper");
    const outFd = fs.openSync(P.stdout, "a");
    const child = spawn(process.execPath, [RUNNER, b.name, ...(live ? ["--live"] : [])], {
      detached: true,
      stdio: ["ignore", outFd, outFd],
      windowsHide: true,
      env: { ...process.env, BB_LIVE_CONFIRMED: live ? "1" : "" },
    });
    child.unref();
    let up = false;
    for (let i = 0; i < 40 && !up && U.isAlive(child.pid); i++) {
      await U.sleep(500);
      up = U.readJson(P.pid)?.pid === child.pid;
    }
    if (up) {
      console.log(`${c.green("●")} ${c.bold(b.name)} started ${modeTag(live ? "live" : "paper")} (pid ${child.pid})`);
    } else if (U.isAlive(child.pid)) {
      console.log(`${c.yellow("…")} ${c.bold(b.name)} still connecting to Bybit (pid ${child.pid}); check \`bb-cli status\` in a minute`);
    } else {
      console.log(`${c.red("✖")} ${c.bold(b.name)} failed to start:`);
      for (const l of U.tail(P.stdout, 3)) console.log("   " + c.red(l));
    }
  }
}

async function cmdStop() {
  const sell = flags.has("--sell");
  const force = flags.has("--force");
  const list = targets(U.loadBots(), positional[0]);
  const waiting = [];
  for (const b of list) {
    const run = U.runningInfo(b.name);
    if (!run) {
      console.log(c.gray(`${b.name} is not running`));
      continue;
    }
    if (force) {
      process.kill(run.pid);
      console.log(c.yellow(`${b.name} killed (open orders left on the exchange)`));
      continue;
    }
    U.writeJson(U.paths(b.name, run.mode).stop, { sell, reason: sell ? "stop + sell requested" : "stop requested", at: Date.now() });
    waiting.push({ b, run });
  }
  for (const { b, run } of waiting) {
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) {
      await U.sleep(500);
      ok = !U.isAlive(run.pid);
    }
    console.log(ok ? `${c.gray("○")} ${c.bold(b.name)} stopped${sell ? " and position sold" : " (orders cancelled, position kept)"}` : c.red(`${b.name} did not stop in 30s; try --force`));
  }
}

async function cmdLogs() {
  const [b] = targets(U.loadBots(), positional[0], false);
  const run = U.runningInfo(b.name);
  const mode = flags.has("--live") ? "live" : flags.has("--paper") ? "paper" : run?.mode || "paper";
  const file = U.paths(b.name, mode).log;
  for (const l of U.tail(file, Number(opt("-n", opt("--lines", 30))))) console.log(colorLogLine(l));
  if (!flags.has("--follow") && !argv.includes("-f")) return;
  let size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  setInterval(() => {
    if (!fs.existsSync(file)) return;
    const now = fs.statSync(file).size;
    if (now <= size) return;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(now - size);
    fs.readSync(fd, buf, 0, buf.length, size);
    fs.closeSync(fd);
    size = now;
    for (const l of buf.toString("utf8").split(/\r?\n/).filter(Boolean)) console.log(colorLogLine(l));
  }, 1000);
}

async function cmdReset() {
  const [b] = targets(U.loadBots(), positional[0], false);
  const mode = flags.has("--live") ? "live" : "paper";
  if (U.runningInfo(b.name)) throw new Error(`${b.name} is running; stop it first`);
  const P = U.paths(b.name, mode);
  const s = U.readJson(P.state);
  if (!s) return console.log(c.gray(`${b.name} has no ${mode} state`));
  const pos = positionOf(s, s.lastPrice);
  if (mode === "live" && pos.qty > 0 && !flags.has("--force")) {
    throw new Error(`${b.name} still tracks a live position of ${pos.qty} ${b.symbol.replace(/USDT$/, "")}; sell it first (start + stop --sell) or pass --force`);
  }
  fs.renameSync(P.state, `${P.state}.${Date.now()}.bak`);
  console.log(`${b.name}: ${mode} state reset (backup kept next to it)`);
}

async function cmdBalance() {
  console.log(await accountLine());
}

async function cmdBacktest() {
  const list = targets(U.loadBots(), positional[0]);
  const days = Number(opt("--days", 7));
  for (const b of list) {
    process.stdout.write(c.gray(`backtesting ${b.name} over ${days}d...\r`));
    const r = await backtest(b, { days, interval: opt("--interval") });
    const d = (t) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
    console.log(`${c.bold(b.name)} ${c.gray(`${r.cfg.type} ${r.cfg.symbol} · ${d(r.from)} → ${d(r.to)} · ${r.bars} bars of ${r.step}m · fee ${r.cfg.feeRate * 100}%`)}`);
    console.log(
      `  return ${fmtSigned(r.returnPct)}% (${fmtSigned(r.finalEquity - r.cfg.budgetUsdt, 3)} USDT)  ·  buy & hold ${fmtSigned(r.buyHoldPct)}%  ·  ` +
        `max drawdown ${c.red(fmt(r.maxDDPct) + "%")}  ·  closed trades ${r.cycles}  ·  realized ${fmtSigned(r.realizedPnl, 3)}`
    );
    if (r.openPosition.qty > 0) console.log(c.gray(`  still holding ${r.openPosition.qty.toFixed(6)} (uPnL ${r.openPosition.upnl.toFixed(3)})`));
    if (r.halted) console.log(c.yellow(`  halted: ${r.halted}`));
    if (flags.has("--trades")) for (const t of r.trades) console.log(`  ${c.gray(d(t.t))} ${/^SELL/.test(t.msg) ? c.magenta(t.msg) : c.green(t.msg)}`);
  }
  console.log(c.gray("Past results don't predict future returns; the backtest ignores slippage and partial fills."));
}

function cmdList() {
  for (const b of U.loadBots()) {
    const cfg = resolveConfig(b);
    const run = U.runningInfo(b.name);
    const params = Object.keys(STRATS[b.type].defaults).map((k) => `${k}=${cfg[k]}`).join(" ");
    console.log(`${pad(c.bold(b.name), 14)} ${pad(b.type, 6)} ${pad(b.symbol, 10)} ${pad(b.budgetUsdt + " USDT", 9)} ${run ? c.green(`● ${run.mode}`) : c.gray("○ stopped")}  ${c.gray(params)}`);
  }
}

// ---------- bot configuration ----------
const TYPE_INFO = {
  grid: "buy on levels below the price, sell one level higher; best in sideways markets",
  dca: "buy small amounts on dips, sell everything on a bounce",
  trend: "EMA crossover on candles; buy on cross up, sell on cross down / TP / SL",
  scalp: "second-by-second scalper: buys quick dips (or breakouts) with maker orders, sells a few tenths of % higher",
};
const COMMON = {
  budgetUsdt: "USDT this bot may use",
  feeRate: "fee per fill as a fraction (0.001 = 0.1%)",
  pollSeconds: "seconds between checks",
};
const BOTS_FILE = path.join(U.ROOT, "bots.json");
const saveBots = (bots) => U.writeJson(BOTS_FILE, bots);

function parseValue(raw, like) {
  const v = String(raw).trim();
  if (v === "null" || v === "") return null;
  if (typeof like === "string") return v;
  if (v === "true" || v === "false") return v === "true";
  return v !== "" && !Number.isNaN(Number(v)) ? Number(v) : v;
}

function allowedKeys(type) {
  return { ...COMMON, ...(STRATS[type]?.describe || {}) };
}

// key=value pairs from the command line; "budget" is accepted for budgetUsdt.
function kvArgs(list) {
  const out = {};
  for (const a of list) {
    const m = a.match(/^([A-Za-z]+)=(.*)$/);
    if (!m) throw new Error(`expected key=value, got "${a}"`);
    out[m[1] === "budget" ? "budgetUsdt" : m[1]] = m[2];
  }
  return out;
}

function applyKv(bot, kv) {
  const keys = allowedKeys(bot.type);
  for (const [k, raw] of Object.entries(kv)) {
    if (["name", "type", "symbol"].includes(k)) {
      bot[k] = k === "symbol" ? String(raw).toUpperCase() : String(raw);
      continue;
    }
    if (!keys[k]) throw new Error(`unknown setting "${k}" for ${bot.type} (have: ${Object.keys(keys).join(", ")})`);
    const like = STRATS[bot.type].defaults[k] ?? (k in COMMON ? 0 : undefined);
    const v = parseValue(raw, like);
    if (raw === "default" || (v === null && STRATS[bot.type].defaults[k] === null)) delete bot[k];
    else bot[k] = v;
  }
  return bot;
}

async function checkBot(bot, others) {
  if (!/^[a-zA-Z0-9_-]{1,20}$/.test(bot.name || "")) throw new Error("name: letters, digits, - and _, max 20");
  if (others.some((b) => b.name === bot.name)) throw new Error(`a bot named "${bot.name}" already exists`);
  if (!STRATS[bot.type]) throw new Error(`type must be one of ${Object.keys(STRATS).join(", ")}`);
  if (!/^[A-Z0-9]+USDT$/.test(bot.symbol || "")) throw new Error("symbol must be a USDT spot pair like BTCUSDT");
  if (!(Number(bot.budgetUsdt) > 0)) throw new Error("budgetUsdt must be > 0");
  const inst = await api.instrument(bot.symbol);
  STRATS[bot.type].validate(resolveConfig(bot), inst);
  return inst;
}

function showConfig(bot) {
  const cfg = resolveConfig(bot);
  const keys = allowedKeys(bot.type);
  console.log(`${c.bold(bot.name)}  ${c.cyan(bot.type)} ${bot.symbol}  ${c.gray(TYPE_INFO[bot.type])}`);
  for (const [k, d] of Object.entries(keys)) {
    const set = k in bot;
    const val = cfg[k] === null || cfg[k] === undefined ? "null" : String(cfg[k]);
    console.log(`  ${pad(k, 16)} ${pad(set ? c.bold(val) : c.gray(val), 10)} ${c.gray((set ? "" : "(default) ") + d)}`);
  }
}

function cmdTypes() {
  for (const [t, st] of Object.entries(STRATS)) {
    console.log(`${c.bold(c.cyan(t))}  ${TYPE_INFO[t]}`);
    for (const [k, d] of Object.entries(st.describe || {})) {
      const v = st.defaults[k];
      console.log(`  ${pad(k, 16)} ${pad(c.bold(v === null ? "null" : String(v)), 10)} ${c.gray(d)}`);
    }
    console.log("");
  }
  console.log(c.gray(`All types also take: ${Object.keys(COMMON).join(", ")}`));
}

async function cmdNew() {
  const bots = U.loadBots();
  const named = positional[0] && !positional[0].includes("=");
  const kv = kvArgs(positional.slice(named ? 1 : 0));
  const bot = { name: named ? positional[0] : undefined };
  // The wizard asks for whatever is missing; a complete one-liner (type, symbol, budget) asks nothing.
  const interactive = canAsk() && !flags.has("--yes") && !(kv.type && kv.symbol && kv.budgetUsdt);

  if (!kv.type && interactive) {
    const types = Object.keys(STRATS);
    console.log(c.bold("Strategy:"));
    types.forEach((t, i) => console.log(`  ${c.cyan(i + 1)}. ${pad(c.bold(t), 6)} ${c.gray(TYPE_INFO[t])}`));
    const a = await ask(`type [1-${types.length}]: `);
    kv.type = types[Number(a) - 1] || a;
  }
  if (!STRATS[kv.type]) throw new Error(`type must be one of ${Object.keys(STRATS).join(", ")} (type=<name>)`);
  bot.type = kv.type;
  delete kv.type;

  if (!kv.symbol && interactive) {
    for (;;) {
      const sym = ((await ask("symbol [BTCUSDT]: ")) || "BTCUSDT").toUpperCase();
      try {
        await api.instrument(sym);
        const tk = await api.ticker(sym);
        console.log(c.gray(`  ${sym} ${fmtPrice(tk.last)} (${tk.change24h.toFixed(2)}% 24h)`));
        kv.symbol = sym;
        break;
      } catch (e) {
        console.log(c.red(`  ${e.message}`));
      }
    }
  }
  if (!kv.symbol) throw new Error("symbol=<PAIR> is required");
  bot.symbol = kv.symbol.toUpperCase();
  delete kv.symbol;

  if (!bot.name) {
    let def = `${bot.type}-${bot.symbol.replace(/USDT$/, "").toLowerCase()}`;
    for (let i = 2; bots.some((b) => b.name === def); i++) def = `${bot.type}-${bot.symbol.replace(/USDT$/, "").toLowerCase()}${i}`;
    bot.name = interactive ? (await ask(`name [${def}]: `)) || def : def;
  }

  if (!kv.budgetUsdt && interactive) {
    const used = bots.reduce((a, b) => a + b.budgetUsdt, 0);
    let note = `other bots use ${used} USDT`;
    if (api.hasKeys()) {
      const usdt = (await api.wallet().catch(() => ({ coins: [] }))).coins.find((x) => x.coin === "USDT")?.balance;
      if (usdt != null) note += ` of ${usdt.toFixed(2)} in the account`;
    }
    console.log(c.gray(`  ${note}; budgets only matter for live runs`));
    kv.budgetUsdt = (await ask("budget USDT [10]: ")) || "10";
  }
  if (!kv.budgetUsdt) throw new Error("budget=<USDT> is required");

  if (interactive) {
    console.log(c.bold("Settings") + c.gray(" (Enter keeps the default)"));
    for (const [k, d] of Object.entries(STRATS[bot.type].describe)) {
      if (k in kv) continue;
      const def = STRATS[bot.type].defaults[k];
      const a = await ask(`  ${pad(k, 15)} ${c.gray(d)} [${def === null ? "null" : def}]: `);
      if (a) kv[k] = a;
    }
  }
  applyKv(bot, kv);
  await checkBot(bot, bots);

  console.log("");
  showConfig(bot);
  if (interactive) {
    const a = (await ask("\nsave? [Y/n]: ")).toLowerCase();
    if (a && a !== "y" && a !== "yes") return console.log(c.gray("not saved"));
  }
  bots.push(bot);
  saveBots(bots);
  console.log(`${c.green("✔")} added ${c.bold(bot.name)} to bots.json`);
  console.log(c.gray(`  try it: bb-cli backtest ${bot.name}   then: bb-cli start ${bot.name}`));
}

async function cmdSet() {
  const bots = U.loadBots();
  const [b] = targets(bots, positional[0], false);
  const kv = kvArgs(positional.slice(1));
  if (!Object.keys(kv).length) return showConfig(b);
  if ("name" in kv || "type" in kv) throw new Error("name and type can't be changed; create a new bot instead");
  const next = applyKv(structuredClone(b), kv);
  await checkBot(next, bots.filter((x) => x !== b));
  bots[bots.indexOf(b)] = next;
  saveBots(bots);
  showConfig(next);
  const run = U.runningInfo(b.name);
  if (run) console.log(c.yellow(`\n${b.name} is running; restart it to apply: bb-cli stop ${b.name} && bb-cli start ${b.name}${run.mode === "live" ? " --live" : ""}`));
  const structural = { grid: ["levels", "rangePct", "lower", "upper", "budgetUsdt"] }[b.type] || [];
  if ("symbol" in kv || Object.keys(kv).some((k) => structural.includes(k))) {
    console.log(c.yellow(`these changes apply to a fresh start only: bb-cli reset ${b.name}${run?.mode === "live" ? " --live" : ""}`));
  }
}

function cmdRemove() {
  const bots = U.loadBots();
  const [b] = targets(bots, positional[0], false);
  if (U.runningInfo(b.name)) throw new Error(`${b.name} is running; stop it first`);
  const live = U.readJson(U.paths(b.name, "live").state);
  if (live && positionOf(live, live.lastPrice).qty > 0 && !flags.has("--force")) {
    throw new Error(`${b.name} still tracks a live position; sell it first (start --live, then stop --sell) or pass --force`);
  }
  saveBots(bots.filter((x) => x !== b));
  console.log(`${b.name} removed from bots.json ${c.gray(`(its logs and state stay in data/${b.name})`)}`);
}

// ---------- plugins ----------
const MONITOR_WORDS = ["help", "filter", "trades", "clear", "quit", "exit", "q"];
const reservedNames = () => [...Object.keys(COMMANDS), ...MONITOR_WORDS];

function showPlugin(p, installedNow) {
  console.log(`${c.bold(p.name)} ${c.gray(p.version || "")}  ${p.description || ""}${installedNow ? "" : c.gray("  (not installed)")}`);
  for (const [k, d] of Object.entries(p.commands)) console.log(`  ${c.cyan(pad(k, 10))} ${c.gray(d)}`);
  console.log(`  ${c.gray("permissions:")} ${p.permissions.length ? p.permissions.map((x) => `${x} ${c.gray(`(${PLUGINS.PERMISSIONS[x]})`)}`).join(", ") : "none"}`);
}

async function cmdPlugin() {
  const [sub, target] = positional;
  if (!sub || sub === "list" || sub === "ls") {
    const inst = PLUGINS.installed();
    if (!inst.length) console.log(c.gray("no plugins installed"));
    inst.forEach((p) => showPlugin(p, true));
    const avail = PLUGINS.available().filter((p) => !inst.some((x) => x.name === p.name));
    if (avail.length) {
      console.log(c.bold("\nAvailable") + c.gray(" (bb-cli plugin install <name>)"));
      avail.forEach((p) => showPlugin(p, false));
    }
    return;
  }
  if (sub === "install" || sub === "add" || sub === "update") {
    if (!target) throw new Error("plugin install <catalog name | folder | git URL>");
    const staged = PLUGINS.stage(target, reservedNames());
    showPlugin(staged.manifest, true);
    console.log(c.gray("  runs sandboxed: reads only its own folder, writes only its data/ folder, can't start processes or see API keys"));
    if (canAsk() && !flags.has("--yes")) {
      const a = ((await ask("install this plugin? [y/N]: ")) || "").toLowerCase();
      if (a !== "y" && a !== "yes") {
        staged.discard();
        return console.log(c.gray("not installed"));
      }
    }
    const m = staged.commit();
    return console.log(`${c.green("✔")} installed ${c.bold(m.name)} · try: ${Object.keys(m.commands).map((x) => c.cyan(`bb-cli ${x}`)).join(", ")}`);
  }
  if (sub === "remove" || sub === "rm" || sub === "uninstall") {
    if (!target) throw new Error("plugin remove <name>");
    PLUGINS.remove(target);
    return console.log(`${target} removed`);
  }
  if (sub === "info") {
    const p = PLUGINS.installed().find((x) => x.name === target) || PLUGINS.available().find((x) => x.name === target);
    if (!p) throw new Error(`no plugin "${target}"`);
    return showPlugin(p, PLUGINS.installed().some((x) => x.name === target));
  }
  throw new Error("plugin list | install <name|folder|git URL> | remove <name> | info <name>");
}

// What plugins can ask bb-cli to do; lib/plugins.js checks each call against the plugin's permissions.
function pluginHost() {
  const normalize = (raw) => {
    if (!raw || typeof raw !== "object") throw new Error("bot must be an object");
    const { name, type, symbol, ...rest } = raw;
    const bot = { name: String(name || ""), type: String(type || ""), symbol: String(symbol || "").toUpperCase() };
    if (!STRATS[bot.type]) throw new Error(`type must be one of ${Object.keys(STRATS).join(", ")}`);
    return applyKv(bot, Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, v === null ? "null" : String(v)])));
  };
  return {
    print: async (text) => console.log(String(text)),
    ask: async (q) => ask(String(q)),
    bots: async () => U.loadBots().map(({ name, type, symbol, budgetUsdt }) => ({ name, type, symbol, budgetUsdt })),
    types: async () => ({
      feeRate: 0.001,
      common: COMMON,
      strategies: Object.fromEntries(Object.entries(STRATS).map(([t, st]) => [t, { info: TYPE_INFO[t], defaults: st.defaults, describe: st.describe }])),
    }),
    symbols: async (query) => {
      const q = String(query || "").toUpperCase().replace(/USDT$/, "");
      const all = await api.spotSymbols();
      const rank = (x) => (x.base === q ? 0 : x.base.startsWith(q) && x.base.length <= q.length + 2 ? 1 : x.base.startsWith(q) ? 2 : 3);
      return all.filter((x) => q && x.base.includes(q)).sort((a, b) => rank(a) - rank(b)).slice(0, 10);
    },
    ticker: async (symbol) => api.ticker(String(symbol).toUpperCase()),
    validateBot: async (raw) => {
      try {
        const bot = normalize(raw);
        await checkBot(bot, U.loadBots().filter((b) => b.name !== bot.name));
        return { ok: true, bot };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    // The user always confirms here, in bb-cli, so a plugin can't add bots on its own.
    createBot: async (raw) => {
      const bots = U.loadBots();
      const bot = normalize(raw);
      const base = bot.name.slice(0, 17);
      for (let i = 2; bots.some((b) => b.name === bot.name); i++) bot.name = `${base}-${i}`;
      await checkBot(bot, bots);
      console.log("");
      showConfig(bot);
      if (!canAsk()) {
        console.log(c.yellow("not added: run this in a terminal or the monitor to confirm"));
        return { created: false };
      }
      const a = ((await ask(`add ${bot.name} to bots.json? [Y/n]: `)) || "y").toLowerCase();
      if (a !== "y" && a !== "yes") {
        console.log(c.gray("not added"));
        return { created: false };
      }
      bots.push(bot);
      saveBots(bots);
      console.log(`${c.green("✔")} added ${c.bold(bot.name)} ${c.gray(`(not started) · bb-cli backtest ${bot.name} · bb-cli start ${bot.name}`)}`);
      return { created: true, name: bot.name };
    },
  };
}

async function runPlugin(plugin) {
  const code = await PLUGINS.run(plugin, cmd, argv.slice(1), pluginHost());
  process.exitCode = code;
}

function help() {
  console.log(`${c.bold("bb-cli")} — Bybit spot bots (paper by default). Run ${c.cyan("bb-cli")} alone to open the monitor.

  ${c.cyan("list")}                              bots from bots.json
  ${c.cyan("types")}                             strategies and their settings
  ${c.cyan("new")}                               create a bot step by step
  ${c.cyan("new <name> type=scalp symbol=BTCUSDT budget=10 [key=value...]")}
  ${c.cyan("config <bot>")}                      show a bot's settings
  ${c.cyan("set <bot> key=value [...]")}         change settings (key=default to reset one)
  ${c.cyan("rm <bot>")}                          remove a bot from bots.json
  ${c.cyan("start <bot|all> [--live]")}          start in background (paper unless --live)
  ${c.cyan("stop <bot|all> [--sell]")}           cancel orders and stop; --sell also sells the position
  ${c.cyan("status")}                            one-shot table
  ${c.cyan("monitor [--interval 1] [--no-mouse]")} dashboard, scrollable logs and a command line
  ${c.cyan("logs <bot> [-n 50] [-f]")}           bot log, -f to follow
  ${c.cyan("backtest <bot|all> [--days 7] [--interval 5] [--trades]")}
  ${c.cyan("balance")}                           AI subaccount balance
  ${c.cyan("reset <bot> [--live]")}              start the bot from scratch next time
  ${c.cyan("settings")}                          choose table columns and panel sections (settings compact, settings hide AVG)
  ${c.cyan("plugin [list|install|remove|info]")} manage plugins (bb-cli plugin install ai)
${PLUGINS.installed().map((p) => Object.entries(p.commands).map(([k, d]) => `  ${c.cyan(pad(k, 33))} ${c.gray(`[${p.name}] ${d}`)}`).join("\n")).join("\n")}

Bots are configured in bots.json. Live mode needs typing LIVE in an interactive terminal.`);
}

const COMMANDS = {
  list: cmdList, ls: cmdList, start: cmdStart, stop: cmdStop, status: cmdStatus, st: cmdStatus,
  monitor: cmdMonitor, mon: cmdMonitor, watch: cmdMonitor, logs: cmdLogs, log: cmdLogs,
  reset: cmdReset, balance: cmdBalance, bal: cmdBalance, backtest: cmdBacktest, bt: cmdBacktest,
  types: cmdTypes, new: cmdNew, create: cmdNew, add: cmdNew, set: cmdSet, config: cmdSet, show: cmdSet,
  rm: cmdRemove, remove: cmdRemove, delete: cmdRemove, settings: cmdSettings, view: cmdSettings,
  plugin: cmdPlugin, plugins: cmdPlugin,
};

(async () => {
  const plugin = cmd && !COMMANDS[cmd] ? PLUGINS.findCommand(cmd) : null;
  if (plugin) return runPlugin(plugin);
  const fn = cmd ? COMMANDS[cmd] : process.stdout.isTTY && process.stdin.isTTY ? cmdMonitor : null;
  if (!fn) {
    if (cmd && cmd !== "help" && cmd !== "--help") console.log(c.red(`unknown command "${cmd}"\n`));
    return help();
  }
  await fn();
})().catch((e) => {
  console.error(c.red(`error: ${e.message}`));
  process.exitCode = 1;
});
