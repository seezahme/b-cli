// Child side of a plugin run (started with --permission by lib/plugins.js). Gives the plugin a `host`
// whose methods are calls back to bb-cli over IPC.
const path = require("path");

const [dir, main, cmd, ...args] = process.argv.slice(2);
let seq = 0;
const pending = new Map();
process.on("message", (m) => {
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
});
const call = (name) => (...a) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    process.send({ id, call: name, args: a });
  });

const host = {
  dataDir: path.join(dir, "data"),
  print: call("print"),
  ask: call("ask"),
  bots: call("bots"),
  types: call("types"),
  symbols: call("symbols"),
  ticker: call("ticker"),
  validateBot: call("validateBot"),
  createBot: call("createBot"),
  progress: call("progress"),
  strategies: call("strategies"),
  checkStrategy: call("checkStrategy"),
  report: call("report"),
  backtest: call("backtest"),
  updateBot: call("updateBot"),
  stopBot: call("stopBot"),
  saveStrategy: call("saveStrategy"),
};

(async () => {
  const plugin = require(path.join(dir, main));
  const command = plugin.commands?.[cmd];
  if (!command) throw new Error(`plugin has no command "${cmd}"`);
  await command.run(args, host);
})()
  .catch(async (e) => {
    await host.print(`\x1b[31merror: ${e.message}\x1b[0m`).catch(() => {});
    process.exitCode = 1;
  })
  .finally(() => process.disconnect());
