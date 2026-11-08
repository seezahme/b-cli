// Plugins live in plugins/<name>/ (not committed) and are installed with `bb-cli plugin install`.
// Each plugin command runs in a separate Node process under the permission model: it can read only
// its own folder, write only its data/ folder, can't start processes, and never sees API keys.
// Everything else goes through the host calls below, gated by the permissions in plugin.json.
const fs = require("fs");
const path = require("path");
const { fork, execFileSync } = require("child_process");
const { ROOT, readJson } = require("./util");

const DIR = path.join(ROOT, "plugins");
const CATALOG = path.join(ROOT, "plugins-catalog");
const SANDBOX = path.join(__dirname, "plugin-sandbox.js");

const PERMISSIONS = {
  "bots:read": "see your bot list (names, types, pairs, budgets)",
  "bots:create": "add new bots to bots.json after you confirm (can't start them)",
  "market:read": "look up Bybit spot pairs and prices (public data, no API keys)",
  "bots:analyze": "read your bots' results, positions and trade logs, run backtests (no keys or balances)",
  "bots:update": "propose setting changes to a bot (you confirm each one)",
  "bots:stop": "propose stopping a running bot (you confirm; live sells need the bot's name typed)",
  "strategies:write": "propose new strategy files (you confirm; never overwrites)",
};

function readManifest(dir) {
  const m = readJson(path.join(dir, "plugin.json"));
  if (!m) throw new Error(`${dir} has no plugin.json`);
  if (!/^[a-z0-9-]{1,30}$/.test(m.name || "")) throw new Error("plugin.json: name must be lowercase letters, digits and -");
  if (!m.main || !fs.existsSync(path.join(dir, m.main))) throw new Error("plugin.json: main file missing");
  if (!m.commands || !Object.keys(m.commands).length) throw new Error("plugin.json: no commands");
  for (const p of m.permissions || []) if (!PERMISSIONS[p]) throw new Error(`plugin.json: unknown permission "${p}"`);
  return { ...m, permissions: m.permissions || [], dir };
}

function installed() {
  if (!fs.existsSync(DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(DIR)) {
    try {
      out.push(readManifest(path.join(DIR, name)));
    } catch {}
  }
  return out;
}

const available = () => (fs.existsSync(CATALOG) ? fs.readdirSync(CATALOG).map((n) => readManifest(path.join(CATALOG, n))) : []);
const findCommand = (cmd) => installed().find((p) => Object.hasOwn(p.commands, cmd));

// source: a catalog name, a local folder, or a git URL. Returns the manifest from a staging copy;
// call commit() to move it into place.
function stage(source, reserved) {
  const tmp = path.join(DIR, `.staging-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  if (/^(https?:\/\/|git@)/.test(source)) {
    execFileSync("git", ["clone", "--depth", "1", source, tmp], { stdio: "ignore" });
    fs.rmSync(path.join(tmp, ".git"), { recursive: true, force: true });
  } else {
    const src = fs.existsSync(path.join(CATALOG, source)) ? path.join(CATALOG, source) : path.resolve(source);
    if (!fs.existsSync(src)) throw new Error(`no plugin "${source}" in the catalog (${available().map((p) => p.name).join(", ") || "empty"}) and no such folder`);
    fs.cpSync(src, tmp, { recursive: true, filter: (p) => !/[\\/](data|node_modules|\.git)$/.test(p) });
  }
  let m;
  try {
    m = readManifest(tmp);
    const clash = Object.keys(m.commands).filter((c) => reserved.includes(c));
    if (clash.length) throw new Error(`plugin commands clash with built-in commands: ${clash.join(", ")}`);
    const other = installed().find((p) => p.name !== m.name && Object.keys(m.commands).some((c) => Object.hasOwn(p.commands, c)));
    if (other) throw new Error(`plugin commands clash with plugin "${other.name}"`);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return {
    manifest: m,
    commit() {
      const dest = path.join(DIR, m.name);
      const keep = path.join(dest, "data");
      if (fs.existsSync(keep)) fs.cpSync(keep, path.join(tmp, "data"), { recursive: true });
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(tmp, dest);
      return readManifest(dest);
    },
    discard: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

function remove(name) {
  const dest = path.join(DIR, name);
  if (!fs.existsSync(path.join(dest, "plugin.json"))) throw new Error(`plugin "${name}" is not installed`);
  fs.rmSync(dest, { recursive: true, force: true });
}

// Runs one plugin command in the sandbox. `host` maps call names to async functions.
function run(plugin, cmd, args, host) {
  const data = path.join(plugin.dir, "data");
  fs.mkdirSync(data, { recursive: true });
  const child = fork(SANDBOX, [plugin.dir, plugin.main, cmd, ...args], {
    execArgv: ["--permission", `--allow-fs-read=${plugin.dir}`, `--allow-fs-read=${SANDBOX}`, `--allow-fs-write=${data}`],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  // host call -> permission it needs (null = always allowed). Nothing here can start a bot.
  const gate = {
    print: null, ask: null, progress: null, types: null,
    bots: "bots:read", validateBot: "bots:read", strategies: "bots:read", checkStrategy: "bots:read",
    symbols: "market:read", ticker: "market:read",
    createBot: "bots:create", report: "bots:analyze", backtest: "bots:analyze",
    updateBot: "bots:update", stopBot: "bots:stop", saveStrategy: "strategies:write",
  };
  child.on("message", async (msg) => {
    if (!msg || typeof msg.id !== "number") return;
    let reply;
    try {
      const need = gate[msg.call];
      if (need === undefined || !Object.hasOwn(gate, msg.call)) throw new Error(`unknown host call "${msg.call}"`);
      if (need && !plugin.permissions.includes(need)) throw new Error(`plugin "${plugin.name}" lacks the ${need} permission`);
      reply = { id: msg.id, result: await host[msg.call](...(msg.args || [])) };
    } catch (e) {
      reply = { id: msg.id, error: e.message };
    }
    if (child.connected) child.send(reply);
  });
  return new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
}

module.exports = { DIR, CATALOG, PERMISSIONS, installed, available, findCommand, stage, remove, run };
