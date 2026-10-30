const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const STRATEGIES = ["grid", "dca", "trend", "scalp"];

// BB_COLOR=1 is set by the monitor for commands whose output it captures.
const useColor = (process.stdout.isTTY || process.env.BB_COLOR === "1") && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  red: wrap(31), green: wrap(32), yellow: wrap(33), blue: wrap(34), magenta: wrap(35), cyan: wrap(36),
  gray: wrap(90), bold: wrap(1), dim: wrap(2), inverse: wrap(7),
};
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const pad = (s, w, right = false) => {
  const sp = " ".repeat(Math.max(0, w - stripAnsi(s).length));
  return right ? sp + s : s + sp;
};

const decimals = (step) => (String(step).includes(".") ? String(step).split(".")[1].replace(/0+$/, "").length : 0);
const floorTo = (x, step) => (Math.floor(Number(x) / Number(step) + 1e-9) * Number(step)).toFixed(decimals(step));
const roundTo = (x, step) => (Math.round(Number(x) / Number(step)) * Number(step)).toFixed(decimals(step));

const isNum = (n) => n !== null && n !== undefined && !Number.isNaN(Number(n));
const fmt = (n, d = 2) => (isNum(n) ? Number(n).toFixed(d) : "-");
const fmtPrice = (p) => (!isNum(p) ? "-" : p >= 1000 ? Number(p).toFixed(1) : p >= 1 ? Number(p).toFixed(3) : Number(p).toFixed(6));
const fmtSigned = (n, d = 2) => {
  if (!isNum(n)) return c.gray("-");
  if (Math.abs(n) < 0.5 * 10 ** -d) return fmt(0, d);
  return n > 0 ? c.green("+" + fmt(n, d)) : c.red(fmt(n, d));
};
const ago = (ts) => {
  if (!ts) return "-";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
};

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(p, data) {
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

function loadBots() {
  const bots = readJson(path.join(ROOT, "bots.json"));
  if (!Array.isArray(bots)) throw new Error("bots.json must be an array of bot configs");
  const names = new Set();
  for (const b of bots) {
    if (!/^[a-zA-Z0-9_-]{1,20}$/.test(b.name || "")) throw new Error(`bad bot name "${b.name}" (letters, digits, - and _, max 20)`);
    if (names.has(b.name)) throw new Error(`duplicate bot name "${b.name}"`);
    names.add(b.name);
    if (!STRATEGIES.includes(b.type)) throw new Error(`bot ${b.name}: unknown type "${b.type}" (${STRATEGIES.join(", ")})`);
    if (!/^[A-Z0-9]+USDT$/.test(b.symbol || "")) throw new Error(`bot ${b.name}: symbol must be a USDT spot pair like BTCUSDT`);
    if (!(Number(b.budgetUsdt) > 0)) throw new Error(`bot ${b.name}: budgetUsdt must be > 0`);
  }
  return bots;
}

function paths(name, mode) {
  const dir = path.join(DATA, name);
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    state: path.join(dir, `state.${mode}.json`),
    log: path.join(dir, `bot.${mode}.log`),
    pid: path.join(dir, "pid.json"),
    stop: path.join(dir, "stop.json"),
    stdout: path.join(dir, "stdout.log"),
  };
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function runningInfo(name) {
  const pid = readJson(paths(name, "paper").pid);
  return pid && isAlive(pid.pid) ? pid : null;
}

function tail(file, lines, maxBytes = 64 * 1024) {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, "r");
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString("utf8").split(/\r?\n/).filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Order sizes are floored to the exchange step; the remainder is carried in s.dust and added to the next sell.
function takeSellable(s, qty, inst) {
  const want = Number(qty) + (s.dust || 0);
  const q = floorTo(want, inst.qtyStep);
  s.dust = Math.max(0, want - Number(q));
  return q;
}

// Truncate to `width` visible characters without breaking ANSI sequences.
function clip(line, width) {
  let visible = 0;
  let out = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\x1b") {
      const m = line.slice(i).match(/^\x1b\[[0-9;?]*[A-Za-z]/);
      if (m) {
        out += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (visible >= width) continue;
    out += line[i];
    visible++;
  }
  return out + "\x1b[0m";
}

// Pad to exactly `w` visible characters, cutting with "…" when the text is longer.
const fit = (s, w, right = false) => pad(stripAnsi(s).length > w ? clip(s, Math.max(0, w - 1)) + "…" : s, w, right);

module.exports = {
  ROOT, DATA, STRATEGIES, c, stripAnsi, pad, fit, decimals, floorTo, roundTo, fmt, fmtPrice, fmtSigned, ago,
  readJson, writeJson, loadBots, paths, isAlive, runningInfo, tail, sleep, takeSellable, clip,
};
