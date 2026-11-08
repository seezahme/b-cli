// Strategy files: shareable JSON that describe indicators and trading rules.
// They hold data only. Expressions are parsed by the small grammar below (no eval),
// so a strategy file from someone else can't run code on this machine.
const fs = require("fs");
const path = require("path");
const { TYPES, SOURCES } = require("./indicators");

const DIR = path.join(__dirname, "..", "strategy-files");
const FORMAT = "bb-strategy/1";
const INTERVALS = ["1", "3", "5", "15", "30", "60", "120", "240", "360", "720", "D"];
const TOP_KEYS = ["format", "name", "description", "author", "version", "interval", "params", "indicators", "rules", "exit", "show"];
const RULE_KEYS = ["name", "when", "stopLoss", "takeProfit", "trailing", "exit"];
const CMP = [">=", "<=", "==", ">", "<", "crossesAbove", "crossesBelow"];

// ---------- expressions ----------
// expr := term (('+'|'-') term)* ; term := unary (('*'|'/') unary)* ;
// unary := '-' unary | number | $param | name[.field]['[' n ']'] | '(' expr ')'
// name[n] reads n candles back (close[1] = previous close).
// Candle time (UTC) is readable as hour (0-23), minute and weekday (0 = Sunday .. 6 = Saturday).
const TIME = {
  hour: (t) => new Date(t).getUTCHours(),
  minute: (t) => new Date(t).getUTCMinutes(),
  weekday: (t) => new Date(t).getUTCDay(),
};
function tokenize(s) {
  const re = /\s*(crossesAbove|crossesBelow|>=|<=|==|\[\d{1,3}\]|[-+*/()<>]|\d+(?:\.\d+)?|\$[A-Za-z_]\w*|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)/y;
  const out = [];
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < s.length && (m = re.exec(s))) out.push(m[1]);
  if (s.slice(re.lastIndex).trim()) throw new Error(`can't read "${s.slice(re.lastIndex).trim()}"`);
  return out;
}

// Returns (ctx, i) => number|null. `refs` collects every name used, for validation.
function parseExpr(tokens, pos, refs) {
  const peek = () => tokens[pos.i];
  const next = () => tokens[pos.i++];
  const bin = (a, b, op) => (ctx, i) => {
    const x = a(ctx, i), y = b(ctx, i);
    if (x == null || y == null) return null;
    return op === "+" ? x + y : op === "-" ? x - y : op === "*" ? x * y : y === 0 ? null : x / y;
  };
  function unary() {
    const t = next();
    if (t === undefined) throw new Error("expression ends too early");
    if (t === "-") { const u = unary(); return (ctx, i) => { const v = u(ctx, i); return v == null ? null : -v; }; }
    if (t === "(") {
      const e = sum();
      if (next() !== ")") throw new Error("missing )");
      return e;
    }
    if (/^\d/.test(t)) { const v = Number(t); return () => v; }
    if (t[0] === "$") { const p = t.slice(1); refs.params.add(p); return (ctx) => ctx.params[p] ?? null; }
    if (/^[A-Za-z_]/.test(t)) {
      refs.names.add(t);
      if (t === "entry") return (ctx) => ctx.entry ?? null;
      const back = /^\[\d+\]$/.test(peek() || "") ? Number(next().slice(1, -1)) : 0;
      if (SOURCES[t]) { const f = SOURCES[t]; return (ctx, i) => ctx.k[i - back]?.[f] ?? null; }
      if (TIME[t]) { const f = TIME[t]; return (ctx, i) => (ctx.k[i - back] ? f(ctx.k[i - back].t) : null); }
      const [name, field] = t.split(".");
      return (ctx, i) => { const s = ctx.series[name]; return i - back < 0 ? null : (field ? s?.[field] : s)?.[i - back] ?? null; };
    }
    throw new Error(`unexpected "${t}"`);
  }
  function term() {
    let a = unary();
    while (peek() === "*" || peek() === "/") { const op = next(); a = bin(a, unary(), op); }
    return a;
  }
  function sum() {
    let a = term();
    while (peek() === "+" || peek() === "-") { const op = next(); a = bin(a, term(), op); }
    return a;
  }
  return sum();
}

function compileValue(text, refs) {
  const tokens = tokenize(String(text));
  const pos = { i: 0 };
  const fn = parseExpr(tokens, pos, refs);
  if (pos.i !== tokens.length) throw new Error(`unexpected "${tokens[pos.i]}"`);
  return fn;
}

// "a > b", "a crossesAbove b". Missing data (warm-up) makes a condition false.
function compileCondition(text, refs) {
  const tokens = tokenize(String(text));
  const pos = { i: 0 };
  const a = parseExpr(tokens, pos, refs);
  const op = tokens[pos.i++];
  if (!CMP.includes(op)) throw new Error(`"${text}" needs a comparison (${CMP.join(" ")})`);
  const b = parseExpr(tokens, pos, refs);
  if (pos.i !== tokens.length) throw new Error(`unexpected "${tokens[pos.i]}" in "${text}"`);
  return (ctx, i) => {
    const x = a(ctx, i), y = b(ctx, i);
    if (x == null || y == null) return false;
    if (op === "crossesAbove" || op === "crossesBelow") {
      const px = a(ctx, i - 1), py = b(ctx, i - 1);
      if (px == null || py == null) return false;
      return op === "crossesAbove" ? px <= py && x > y : px >= py && x < y;
    }
    return op === ">" ? x > y : op === "<" ? x < y : op === ">=" ? x >= y : op === "<=" ? x <= y : x === y;
  };
}

// ---------- files ----------
// Checks a parsed strategy object and returns a compiled one. Throws with a readable message.
function compile(spec) {
  if (!spec || typeof spec !== "object") throw new Error("strategy must be a JSON object");
  const bad = Object.keys(spec).filter((k) => !TOP_KEYS.includes(k));
  if (bad.length) throw new Error(`unknown keys: ${bad.join(", ")}`);
  if (spec.format !== FORMAT) throw new Error(`format must be "${FORMAT}"`);
  if (!/^[a-z0-9-]{1,30}$/.test(spec.name || "")) throw new Error("name: lowercase letters, digits and -, max 30");
  if (!INTERVALS.includes(String(spec.interval))) throw new Error(`interval must be one of ${INTERVALS.join(", ")}`);

  const params = {};
  for (const [k, p] of Object.entries(spec.params || {})) {
    if (!/^[A-Za-z]\w{0,30}$/.test(k)) throw new Error(`param name "${k}" is not allowed`);
    if (typeof p?.default !== "number") throw new Error(`param ${k} needs a numeric "default"`);
    params[k] = { default: p.default, describe: String(p.describe || ""), min: p.min, max: p.max };
  }
  const arg = (v, where) => {
    if (typeof v === "number" || (typeof v === "string" && SOURCES[v])) return v;
    if (typeof v === "string" && v[0] === "$" && params[v.slice(1)]) return v;
    throw new Error(`${where}: "${v}" must be a number, a source (${Object.keys(SOURCES).join("/")}) or a declared $param`);
  };
  const indicators = {};
  for (const [name, d] of Object.entries(spec.indicators || {})) {
    if (!/^[A-Za-z]\w{0,30}$/.test(name) || SOURCES[name] || TIME[name] || name === "entry") throw new Error(`indicator name "${name}" is not allowed`);
    const T = TYPES[d?.type];
    if (!T) throw new Error(`indicator ${name}: type must be one of ${Object.keys(TYPES).join(", ")}`);
    const extra = Object.keys(d).filter((k) => k !== "type" && !T.args.includes(k));
    if (extra.length) throw new Error(`indicator ${name}: unknown ${extra.join(", ")} (takes ${T.args.join(", ")})`);
    const args = {};
    for (const a of T.args) if (d[a] !== undefined) args[a] = arg(d[a], `indicator ${name}.${a}`);
    indicators[name] = { type: d.type, args, fields: T.fields };
  }

  const refs = { names: new Set(), params: new Set() };
  const list = (v, where) => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error(`${where} must be a list of conditions`);
    return v.map((c) => { try { return compileCondition(c, refs); } catch (e) { throw new Error(`${where}: ${e.message}`); } });
  };
  const value = (v, where) => {
    if (v === undefined || v === null) return null;
    try { return compileValue(v, refs); } catch (e) { throw new Error(`${where}: ${e.message}`); }
  };
  if (!Array.isArray(spec.rules) || !spec.rules.length) throw new Error("rules: need at least one entry rule");
  const rules = spec.rules.map((r, n) => {
    const where = `rule ${r?.name || n + 1}`;
    const extra = Object.keys(r || {}).filter((k) => !RULE_KEYS.includes(k));
    if (extra.length) throw new Error(`${where}: unknown ${extra.join(", ")}`);
    if (!Array.isArray(r.when) || !r.when.length) throw new Error(`${where}: "when" needs at least one condition`);
    if (!r.stopLoss) throw new Error(`${where}: stopLoss is required (e.g. "entry - atr * 2")`);
    return {
      name: String(r.name || `rule ${n + 1}`).slice(0, 40),
      when: list(r.when, `${where} when`),
      stopLoss: value(r.stopLoss, `${where} stopLoss`),
      takeProfit: value(r.takeProfit, `${where} takeProfit`),
      trailing: value(r.trailing, `${where} trailing`),
      exit: list(r.exit, `${where} exit`),
    };
  });
  const exit = list(spec.exit, "exit");
  // show: values for the DETAILS column, "expr" or { "label": "...", "value": "expr" }
  const show = (spec.show || []).slice(0, 4).map((s) => {
    const v = typeof s === "string" ? s : s?.value;
    return { label: String(typeof s === "string" ? s : s?.label ?? v).slice(0, 20), fn: value(v, `show ${v}`) };
  });

  // every name used in a rule must exist, with a field exactly when the indicator has several lines
  for (const n of refs.names) {
    if (n === "entry" || SOURCES[n] || TIME[n]) continue;
    const [name, field] = n.split(".");
    const ind = indicators[name];
    if (!ind) throw new Error(`"${n}" is not a declared indicator`);
    if (ind.fields && !ind.fields.includes(field)) throw new Error(`"${n}": use ${ind.fields.map((f) => `${name}.${f}`).join(", ")}`);
    if (!ind.fields && field) throw new Error(`"${n}": ${name} has a single value, use "${name}"`);
  }
  for (const p of refs.params) if (!params[p]) throw new Error(`$${p} is not a declared param`);

  return { spec, name: spec.name, description: String(spec.description || ""), interval: String(spec.interval), params, indicators, rules, exit, show };
}

function parseFile(text) {
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error("strategy file is larger than 64 KB");
  let spec;
  try {
    spec = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    throw new Error(`not valid JSON: ${e.message}`);
  }
  return compile(spec);
}

const fileOf = (name) => path.join(DIR, `${name}.json`);
const load = (name) => {
  if (!/^[a-z0-9-]{1,30}$/.test(name || "")) throw new Error(`bad strategy name "${name}"`);
  if (!fs.existsSync(fileOf(name))) throw new Error(`no strategy "${name}" (have: ${list().map((s) => s.name).join(", ") || "none"})`);
  return parseFile(fs.readFileSync(fileOf(name), "utf8"));
};
const list = () =>
  fs.existsSync(DIR)
    ? fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).flatMap((f) => {
        try {
          return [parseFile(fs.readFileSync(path.join(DIR, f), "utf8"))];
        } catch {
          return [];
        }
      })
    : [];

// Param values for a bot: file defaults overridden by bot settings, clamped to min/max.
function paramValues(strat, cfg) {
  const out = {};
  for (const [k, p] of Object.entries(strat.params)) {
    let v = cfg[k] ?? p.default;
    if (typeof v !== "number" || Number.isNaN(v)) throw new Error(`${k} must be a number`);
    if (p.min != null && v < p.min) throw new Error(`${k} must be >= ${p.min}`);
    if (p.max != null && v > p.max) throw new Error(`${k} must be <= ${p.max}`);
    out[k] = v;
  }
  return out;
}

// Computes all indicator series for the candles; $param arguments use the bot's values.
function series(strat, k, params) {
  const out = {};
  let warm = 0;
  for (const [name, ind] of Object.entries(strat.indicators)) {
    const a = Object.fromEntries(Object.entries(ind.args).map(([key, v]) => [key, typeof v === "string" && v[0] === "$" ? params[v.slice(1)] : v]));
    if (k) out[name] = TYPES[ind.type].calc(k, a);
    warm = Math.max(warm, TYPES[ind.type].warm(a));
  }
  return { series: out, warm: Math.min(990, warm + 2) };
}

module.exports = { DIR, FORMAT, compile, parseFile, load, list, fileOf, paramValues, series };
