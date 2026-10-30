// Display settings for the status table and the monitor, kept in settings.json (not committed).
const path = require("path");
const { ROOT, readJson, writeJson } = require("./util");

const FILE = path.join(ROOT, "settings.json");
const COLUMNS = ["BOT", "TYPE", "MODE", "STATUS", "SYMBOL", "PRICE", "24H", "POSITION", "VALUE", "AVG", "uPnL", "rPnL", "RET%", "ORD", "TICK", "DETAILS"];
const SECTIONS = { account: "account balance line", totals: "per-mode totals under the table", clock: "date and time in the title bar", keys: "key hints above the prompt" };
const PRESETS = {
  full: COLUMNS,
  compact: ["BOT", "STATUS", "PRICE", "POSITION", "uPnL", "rPnL", "RET%", "DETAILS"],
  minimal: ["BOT", "STATUS", "RET%", "DETAILS"],
};
const DEFAULTS = { columns: COLUMNS, sections: { account: true, totals: true, clock: true, keys: true }, refresh: 1 };

function load() {
  const s = readJson(FILE) || {};
  return {
    columns: Array.isArray(s.columns) ? COLUMNS.filter((x) => s.columns.includes(x)) : DEFAULTS.columns,
    sections: { ...DEFAULTS.sections, ...(s.sections || {}) },
    refresh: Number(s.refresh) > 0 ? Number(s.refresh) : DEFAULTS.refresh,
  };
}

const save = (s) => writeJson(FILE, s);
const columnKey = (name) => COLUMNS.find((x) => x.toLowerCase() === String(name).toLowerCase());

module.exports = { FILE, COLUMNS, SECTIONS, PRESETS, DEFAULTS, load, save, columnKey };
