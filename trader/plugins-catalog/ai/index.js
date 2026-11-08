// Local AI bot builder. Talks to an OpenAI-compatible server on this machine (Ollama, LM Studio,
// llama.cpp), turns a description into a bot config, and asks bb-cli to add it. It can't start bots
// and has no access to API keys: it runs in bb-cli's plugin sandbox and only uses host calls.
const fs = require("fs");
const path = require("path");

// `ai setup <id>` presets. base = OpenAI-style API root; env = where an existing key is picked up from.
// Anthropic uses its own Messages API (kind: "anthropic"); the rest speak OpenAI-style chat completions.
const PROVIDERS = {
  ollama: { name: "Ollama", base: "http://localhost:11434/v1", local: true },
  lmstudio: { name: "LM Studio", base: "http://localhost:1234/v1", local: true },
  llamacpp: { name: "llama.cpp", base: "http://localhost:8080/v1", local: true },
  anthropic: { name: "Anthropic (Claude)", base: "https://api.anthropic.com/v1", env: "ANTHROPIC_API_KEY", kind: "anthropic", model: "claude-opus-5-5" },
  openai: { name: "OpenAI", base: "https://api.openai.com/v1", env: "OPENAI_API_KEY" },
  gemini: { name: "Google Gemini", base: "https://generativelanguage.googleapis.com/v1beta/openai", env: "GEMINI_API_KEY" },
  openrouter: { name: "OpenRouter", base: "https://openrouter.ai/api/v1", env: "OPENROUTER_API_KEY" },
  groq: { name: "Groq", base: "https://api.groq.com/openai/v1", env: "GROQ_API_KEY" },
  mistral: { name: "Mistral", base: "https://api.mistral.ai/v1", env: "MISTRAL_API_KEY" },
  deepseek: { name: "DeepSeek", base: "https://api.deepseek.com/v1", env: "DEEPSEEK_API_KEY" },
  xai: { name: "xAI (Grok)", base: "https://api.x.ai/v1", env: "XAI_API_KEY" },
  together: { name: "Together AI", base: "https://api.together.xyz/v1", env: "TOGETHER_API_KEY" },
};
const ANTHROPIC_VERSION = "2026-10-21";
const gray = (s) => `\x1b[90m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

const SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    type: { type: "string" },
    asset: { type: "string" },
    budgetUsdt: { type: "number" },
    settings: { type: "object" },
    explanation: { type: "string" },
  },
  required: ["name", "type", "asset", "budgetUsdt", "settings", "explanation"],
};

function configFile(host) {
  return path.join(host.dataDir, "config.json");
}

// Config in data/config.json: { provider, base, model, key? }. data/ lives under plugins/, which git ignores.
// A key is stored only when it was typed in; one found in the provider's env variable is read each time.
function readConfig(host) {
  try {
    return JSON.parse(fs.readFileSync(configFile(host), "utf8"));
  } catch {
    return null;
  }
}

function loadConfig(host) {
  if (process.env.BB_AI_URL) return { provider: "custom", base: process.env.BB_AI_URL.replace(/\/+$/, ""), model: process.env.BB_AI_MODEL, key: process.env.BB_AI_KEY };
  const c = readConfig(host);
  if (c && !c.base && c.url) return { provider: "custom", base: `${c.url.replace(/\/+$/, "")}/v1`, model: c.model }; // v1.0 config
  return c;
}

function saveConfig(host, cfg) {
  fs.writeFileSync(configFile(host), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

const keyOf = (cfg) => cfg.key || (PROVIDERS[cfg.provider]?.env && process.env[PROVIDERS[cfg.provider].env]) || "";
const isAnthropic = (cfg) => PROVIDERS[cfg.provider]?.kind === "anthropic";
const isLocal = (cfg) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(cfg.base);
const where = (cfg) => (isLocal(cfg) ? cfg.base : `${PROVIDERS[cfg.provider]?.name || cfg.base} (cloud)`);

function headers(cfg) {
  const key = keyOf(cfg);
  if (isAnthropic(cfg)) return { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION };
  return key ? { Authorization: `Bearer ${key}` } : {};
}

// Model ids from {base}/models; null when unreachable. Throws on a rejected key so setup can say so.
async function models(cfg, timeout = 1500) {
  let r;
  try {
    r = await fetch(`${cfg.base}/models`, { headers: headers(cfg), signal: AbortSignal.timeout(timeout) });
  } catch {
    return null;
  }
  if (r.status === 401 || r.status === 403) throw new Error(`${PROVIDERS[cfg.provider]?.name || cfg.base} rejected the API key (HTTP ${r.status})`);
  if (!r.ok) return null;
  return ((await r.json()).data || []).map((m) => m.id).filter(Boolean);
}

async function setup(args, host) {
  const [first, second] = args.filter((a) => !a.startsWith("--"));
  if (first && PROVIDERS[first]) return setupProvider(first, second, args.includes("--new-key"), host);
  if (first && /^https?:\/\//.test(first)) {
    const cfg = { provider: "custom", base: first.replace(/\/+$/, "").replace(/\/chat\/completions$/, "") };
    if (!/\/v\d/.test(cfg.base)) cfg.base += "/v1";
    if (!isLocal(cfg)) cfg.key = (await host.ask("API key, Enter for none (hidden): ", { secret: true })) || undefined;
    const list = await models(cfg, 8000);
    if (!list) throw new Error(`no OpenAI-compatible API answering at ${cfg.base}/models`);
    cfg.model = second || (await chooseModel(host, list, null));
    saveConfig(host, cfg);
    return (await host.print(`using ${bold(cfg.model)} at ${where(cfg)}`), cfg);
  }
  if (first) throw new Error(`unknown provider "${first}" (${Object.keys(PROVIDERS).join(", ")}) or give a URL`);

  await host.print(gray("looking for local model servers..."));
  const found = [];
  for (const [id, p] of Object.entries(PROVIDERS).filter(([, p]) => p.local)) {
    for (const m of (await models({ provider: id, base: p.base })) || []) found.push({ label: `${m} ${gray(`(${p.name})`)}`, provider: id, model: m });
  }
  if (!found.length) {
    await host.print(
      "No local model server found. Either start one (Ollama: ollama pull qwen2.5:7b, LM Studio, llama.cpp)\n" +
        `or use a cloud API: ai setup ${Object.keys(PROVIDERS).filter((k) => !PROVIDERS[k].local).join(" | ")}\n` +
        "or any OpenAI-compatible URL: ai setup https://host/v1 [model]"
    );
    return null;
  }
  const choice = found.length === 1 ? found[0] : await pick(host, found);
  const cfg = { provider: choice.provider, base: PROVIDERS[choice.provider].base, model: choice.model };
  saveConfig(host, cfg);
  await host.print(`using ${bold(cfg.model)} at ${where(cfg)}`);
  return cfg;
}

// Cloud providers: the key is asked once (hidden) and saved; later setups reuse it unless --new-key.
async function setupProvider(id, model, newKey, host) {
  const p = PROVIDERS[id];
  const old = readConfig(host);
  const cfg = { provider: id, base: p.base };
  if (!p.local) {
    if (p.env && process.env[p.env] && !newKey) await host.print(gray(`using the key from ${p.env}`));
    else if (old?.provider === id && old.key && !newKey) cfg.key = old.key;
    else {
      cfg.key = await host.ask(`${p.name} API key (hidden): `, { secret: true });
      if (!cfg.key) throw new Error("no key entered");
    }
  }
  await host.progress(`checking ${p.name}...`);
  const list = await models(cfg, 10000);
  await host.progress("");
  if (!list && !p.local) throw new Error(`couldn't reach ${p.name} at ${p.base}`);
  if (!list) throw new Error(`${p.name} isn't running at ${p.base}`);
  cfg.model = model || (await chooseModel(host, list, p.model));
  saveConfig(host, cfg);
  await host.print(`using ${bold(cfg.model)} at ${where(cfg)}${cfg.key ? gray(" | key saved in the plugin's data folder (git-ignored), not shown") : ""}`);
  if (!p.local) await host.print(gray(`note: requests go to ${p.name}; for ai review that includes your bots' settings and results. Usage is billed to your ${p.name} account.`));
  return cfg;
}

// Picks a model: Enter takes the default, a number picks from the list, or type an exact id.
async function chooseModel(host, list, def) {
  const ids = [...new Set(list)].sort();
  if (ids.length === 1 && !def) return ids[0];
  const shown = ids.slice(0, 25);
  await host.print(shown.map((m, i) => `  ${i + 1}. ${m}`).join("\n") + (ids.length > shown.length ? gray(`\n  ...and ${ids.length - shown.length} more (type the exact id)`) : ""));
  const a = (await host.ask(`model [${def || "number or id"}]: `)) || def || "";
  const m = shown[Number(a) - 1] || (ids.includes(a) || (a && !/^\d+$/.test(a)) ? a : null);
  if (!m) throw new Error("no model chosen");
  return m;
}

async function pick(host, options) {
  await host.print(options.map((o, i) => `  ${i + 1}. ${o.label}`).join("\n"));
  const a = await host.ask(`choose [1-${options.length}]: `);
  const o = options[Number(a) - 1];
  if (!o) throw new Error("nothing chosen");
  return o;
}

function systemPrompt(t) {
  const lines = [
    "You turn a request into ONE trading bot config for bb-cli, which runs spot bots on Bybit (pairs quoted in USDT).",
    `Fees are ${t.feeRate * 100}% per fill, about ${t.feeRate * 200}% per buy+sell round trip.`,
    "Strategies (type: what it does; settings with default and meaning):",
  ];
  for (const [type, s] of Object.entries(t.strategies)) {
    lines.push(`- ${type}: ${s.info}`);
    for (const [k, d] of Object.entries(s.describe || {})) lines.push(`    ${k} (default ${JSON.stringify(s.defaults[k])}): ${d}`);
  }
  if (t.strategyFiles?.length) {
    lines.push("Strategy files for type auto (set settings.strategy; their params can go in settings too):");
    for (const f of t.strategyFiles) {
      lines.push(`- ${f.name} (${f.interval}m candles): ${f.description}`);
      for (const [k, p] of Object.entries(f.params)) lines.push(`    ${k} (default ${p.default}): ${p.describe}`);
    }
    lines.push("Named setups like fair value gap, break of structure, liquidity sweep, breakout or regime-adaptive mean type auto with that strategy file.");
  }
  lines.push(
    "Rules:",
    "- type is one of: " + Object.keys(t.strategies).join(", ") + ". Words like active, fast, scalp, quick, seconds mean scalp; range or sideways mean grid; accumulate or buy dips mean dca; trend or momentum mean trend.",
    "- asset is only the coin or stock ticker the user named, e.g. BTC, ETH, SOL, TSLA. Default BTC.",
    "- budgetUsdt: the amount the user gave, otherwise 10.",
    "- settings: only values that differ from the defaults; use the exact setting names above. For scalp, takeProfitPct must stay above the round-trip fee. 'More active' means a smaller entryPct and windowSec and a shorter cooldownSec; 'safer' means a tighter stopLossPct and a lower maxLossUsdt.",
    "- name: lowercase letters, digits and dashes, at most 20 characters, like scalp-tsla.",
    "- explanation: one or two sentences on what the bot will do.",
    "Reply with a single JSON object: {name, type, asset, budgetUsdt, settings, explanation}. No other text."
  );
  return lines.join("\n");
}

function parseJson(text) {
  const t = String(text).replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(json)?/g, "");
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error(`model did not return JSON: ${t.slice(0, 120)}`);
  return JSON.parse(t.slice(a, b + 1));
}

// Live speed while a model streams: progress line every 250 ms, a summary line at the end.
function meter(cfg, host, t0) {
  // t0: when the request was sent, so "first token after" includes the wait for the server
  let first = null;
  let pieces = 0; // streamed chunks, ~1 token each; the server's own count replaces it when sent
  let thinking = 0;
  let shown = 0;
  const rate = () => (first && Date.now() > first ? (pieces / ((Date.now() - first) / 1000)).toFixed(1) : "-");
  return {
    async tick(isThinking) {
      first ??= Date.now();
      pieces += 1;
      if (isThinking) thinking += 1;
      if (Date.now() - shown > 250) {
        shown = Date.now();
        await host.progress(`${cfg.model} ${isThinking ? "thinking" : "writing"} | ${pieces} tokens | ${rate()} t/s`);
      }
    },
    async done(outTokens, inTokens) {
      const tokens = outTokens || pieces;
      const secs = (Date.now() - (first || t0)) / 1000 || 0.001;
      await host.progress("");
      await host.print(gray(
        `${cfg.model}: ${tokens} tokens in ${secs.toFixed(1)}s | ${(tokens / secs).toFixed(1)} t/s | first token after ${(((first || Date.now()) - t0) / 1000).toFixed(1)}s` +
          (inTokens ? ` | prompt ${inTokens} tokens` : "") + (thinking ? ` | ${thinking} thinking chunks` : "")
      ));
    },
  };
}

// Yields each parsed "data:" JSON object of a server-sent-events response.
async function* sse(r) {
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:") || line === "data: [DONE]") continue;
      try {
        yield JSON.parse(line.slice(5));
      } catch {}
    }
  }
}

const post = (url, cfg, body, extra = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers(cfg), ...extra },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600000),
  });

// Streams one answer and returns its text. schema: optional JSON schema (OpenAI-style servers only).
async function chat(cfg, messages, host, schema) {
  if (isAnthropic(cfg)) return chatAnthropic(cfg, messages, host);
  const body = { model: cfg.model, messages, stream: true, stream_options: { include_usage: true } };
  if (isLocal(cfg)) body.temperature = 0.2;
  if (schema) body.response_format = { type: "json_schema", json_schema: { name: "answer", schema } };
  const t0 = Date.now();
  let r = await post(`${cfg.base}/chat/completions`, cfg, body);
  if (!r.ok && r.status !== 401 && r.status !== 403) {
    // some servers reject structured output or stream_options, some local runners crash on them; the prompt alone asks for JSON
    delete body.response_format;
    delete body.stream_options;
    r = await post(`${cfg.base}/chat/completions`, cfg, body);
  }
  if (!r.ok) throw new Error(`model API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const m = meter(cfg, host, t0);
  let text = "";
  let usage = null;
  for await (const j of sse(r)) {
    if (j.usage) usage = j.usage;
    const d = j.choices?.[0]?.delta || {};
    const think = d.reasoning_content || d.reasoning || "";
    if (d.content || think) {
      text += d.content || "";
      await m.tick(!!think && !d.content);
    }
  }
  await m.done(usage?.completion_tokens, usage?.prompt_tokens);
  return text;
}

// Claude through Anthropic's Messages API. System prompts go in `system`; server-side refusal
// fallbacks are on (a declined request is retried on a fallback model inside the same call).
async function chatAnthropic(cfg, messages, host) {
  const system = messages.filter((x) => x.role === "system").map((x) => x.content).join("\n\n");
  const body = {
    model: cfg.model, max_tokens: 16000, stream: true, fallbacks: "default",
    ...(system ? { system } : {}),
    messages: messages.filter((x) => x.role !== "system"),
  };
  const beta = { "anthropic-beta": "server-side-fallback-2026-07-01" };
  const t0 = Date.now();
  let r = await post(`${cfg.base}/messages`, cfg, body, beta);
  if (r.status === 400 && /fallback/i.test(await r.clone().text())) {
    delete body.fallbacks; // not available for this account or model
    r = await post(`${cfg.base}/messages`, cfg, body);
  }
  if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const m = meter(cfg, host, t0);
  let text = "";
  let inTokens = 0;
  let outTokens = 0;
  let stop = null;
  for await (const j of sse(r)) {
    if (j.type === "error") throw new Error(`Anthropic API: ${j.error?.message || "stream error"}`);
    if (j.type === "message_start") inTokens = j.message?.usage?.input_tokens || 0;
    if (j.type === "content_block_delta") {
      if (j.delta?.type === "text_delta") {
        text += j.delta.text;
        await m.tick(false);
      } else if (j.delta?.type === "thinking_delta") await m.tick(true);
    }
    if (j.type === "message_delta") {
      outTokens = j.usage?.output_tokens || outTokens;
      stop = j.delta?.stop_reason || stop;
    }
  }
  await m.done(outTokens, inTokens);
  if (stop === "refusal") throw new Error("Claude declined this request");
  return text;
}


async function resolveSymbol(host, asset) {
  const a = String(asset || "BTC").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/USDT$/, "");
  const cands = await host.symbols(a);
  if (!cands.length) throw new Error(`Bybit has no USDT spot pair for "${a}"`);
  if (cands[0].base === a || cands.length === 1) {
    if (cands[0].base !== a) await host.print(gray(`${a} trades on Bybit as ${cands[0].symbol}`));
    return cands[0].symbol;
  }
  await host.print(`Several Bybit pairs match ${a}:`);
  return (await pick(host, cands.slice(0, 6).map((x) => ({ label: x.symbol, symbol: x.symbol })))).symbol;
}

const cleanName = (n, type, symbol) =>
  (String(n || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) ||
    `${type}-${symbol.replace(/USDT$/, "").toLowerCase()}`.slice(0, 20));

async function create(desc, host) {
  const cfg = loadConfig(host) || (await setup([], host));
  if (!cfg) return;
  const types = await host.types();
  const existing = (await host.bots()).map((b) => b.name);
  const messages = [
    { role: "system", content: systemPrompt(types) },
    { role: "user", content: `${desc}\n\n(Existing bot names: ${existing.join(", ") || "none"})` },
  ];
  let bot;
  let plan;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await host.print(gray(`asking ${cfg.model}${attempt > 1 ? ` (attempt ${attempt})` : ""}...`));
    const text = await chat(cfg, messages, host, SCHEMA);
    try {
      plan = parseJson(text);
      const symbol = await resolveSymbol(host, plan.asset || plan.symbol);
      const type = String(plan.type || "").toLowerCase();
      bot = { name: cleanName(plan.name, type, symbol), type, symbol, budgetUsdt: Number(plan.budgetUsdt) || 10, ...(plan.settings || {}) };
      const v = await host.validateBot(bot);
      if (v.ok) break;
      throw new Error(v.error);
    } catch (e) {
      if (/no USDT spot pair|nothing chosen/.test(e.message) || attempt === 3) throw e;
      bot = null;
      messages.push({ role: "assistant", content: text }, { role: "user", content: `bb-cli rejected that: ${e.message}. Reply with the corrected JSON only.` });
    }
  }
  if (plan.explanation) await host.print(`\n${plan.explanation}`);
  await host.createBot(bot);
}

// ---------- review ----------
const VERDICTS = ["keep", "adjust", "stop", "stop-sell"];
const REVIEW_SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string", enum: VERDICTS }, changes: { type: "object" }, reason: { type: "string" }, notes: { type: "string" } },
  required: ["verdict", "changes", "reason"],
};

const REVIEW_PROMPT = [
  "You review ONE spot trading bot on Bybit for its owner and pick one verdict:",
  "- keep: it works, or there is too little data to judge (fewer than about 5 closed trades and no clear problem).",
  "- adjust: a clear problem a setting change would fix. 'changes' uses only keys listed in settingHelp, small steps, numbers for numeric settings.",
  "- stop: the bot is running and clearly losing or broken (halted, repeated errors, most of the budget lost, strategy unfit for the market). Keeps any open position.",
  "- stop-sell: like stop, but also sells the open position at market. Only when holding the position is itself the risk.",
  "Weigh: fees of 0.1% per fill, sample size, paper/live results against the backtest, the 24h market move, drawdown, errors in the log.",
  "Only use numbers that appear in the data. Don't propose stop or stop-sell for a bot that isn't running.",
  'Reply with JSON only: {"verdict": "keep|adjust|stop|stop-sell", "changes": {}, "reason": "one or two plain sentences", "notes": "optional"}',
].join("\n");

// Shrinks a host report to what fits a small local model's context.
function compact(rep, bt) {
  const { name, type, symbol, ...settings } = rep.settings;
  const sf = rep.strategyFile;
  return {
    name, type, symbol, budgetUsdt: rep.budgetUsdt, settings,
    settingHelp: Object.fromEntries(Object.entries(rep.settingHelp).map(([k, v]) => [k, String(v).slice(0, 90)])),
    strategyFile: sf && {
      name: sf.name, interval: sf.interval, description: sf.description,
      rules: sf.rules.map((r) => ({ name: r.name, when: r.when, stopLoss: r.stopLoss, takeProfit: r.takeProfit, trailing: r.trailing, exit: r.exit })),
    },
    market: rep.market,
    runs: rep.runs.map(({ recentLog, ...r }) => ({ ...r, recentLog: recentLog.slice(-8).map((l) => l.replace(/^(\S{16})\S*/, "$1")) })),
    backtest: bt,
  };
}

async function review(args, host) {
  const cfg = loadConfig(host) || (await setup([], host));
  if (!cfg) return;
  const days = Number(args[args.indexOf("--days") + 1]) || 14;
  const target = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--days") || "all";
  const all = (await host.bots()).map((b) => b.name);
  const names = target === "all" ? all : [target];
  if (!names.length) return host.print("no bots to review");
  if (!all.includes(names[0])) throw new Error(`no bot "${target}"`);
  await host.print(gray(`bot data goes to ${where(cfg)} (${cfg.model})`));

  for (const name of names) {
    await host.print(`\n${bold(name)}`);
    await host.progress(`${name}: reading results`);
    const rep = await host.report(name);
    let bt = null;
    if (!args.includes("--no-backtest")) {
      await host.progress(`${name}: backtesting ${days} days`);
      bt = await host.backtest(name, days).catch((e) => ({ error: e.message }));
    }
    const data = compact(rep, bt);
    const running = rep.runs.some((r) => r.running);
    const messages = [{ role: "system", content: REVIEW_PROMPT }, { role: "user", content: JSON.stringify(data) }];

    let plan = null;
    for (let attempt = 1; attempt <= 2 && !plan; attempt++) {
      const text = await chat(cfg, messages, host, REVIEW_SCHEMA);
      try {
        const p = parseJson(text);
        if (!VERDICTS.includes(p.verdict)) throw new Error(`verdict must be one of ${VERDICTS.join(", ")}`);
        if (p.verdict.startsWith("stop") && !running) p.verdict = "keep";
        if (p.verdict === "adjust") {
          if (!p.changes || !Object.keys(p.changes).length) throw new Error("adjust needs changes");
          const v = await host.validateBot({ ...rep.settings, ...p.changes });
          if (!v.ok) throw new Error(v.error);
        }
        plan = p;
      } catch (e) {
        if (attempt === 2) await host.print(gray(`  no usable answer (${e.message}); keeping ${name} as is`));
        messages.push({ role: "assistant", content: text }, { role: "user", content: `That can't be used: ${e.message}. Reply with corrected JSON only.` });
      }
    }
    if (!plan) continue;
    const tag = { keep: "keep", adjust: "adjust", stop: "stop", "stop-sell": "stop + sell" }[plan.verdict];
    await host.print(`  ${bold(tag)}: ${plan.reason}${plan.notes ? gray(`\n  ${plan.notes}`) : ""}`);
    if (plan.verdict === "adjust") await host.updateBot(name, plan.changes, plan.reason);
    if (plan.verdict === "stop") await host.stopBot(name, false, plan.reason);
    if (plan.verdict === "stop-sell") await host.stopBot(name, true, plan.reason);
  }
}

// ---------- new strategy files ----------
const STRATEGY_FORMAT = [
  "Write ONE bb-cli strategy file as JSON. Spot only, long only: rules decide when to BUY; the stop, target, trailing stop and exits close the trade.",
  'Top-level keys (no others): format ("bb-strategy/1"), name (lowercase a-z 0-9 -), description, author, version, interval (one of 1,3,5,15,30,60,120,240,360,720,D, as a string),',
  "params ({name: {default: number, min, max, describe}}), indicators ({name: {type, ...args}}), rules (list), exit (optional list of conditions), show (optional list of {label, value}).",
  "Indicator types and args -> lines:",
  "  ema/sma {period, source} -> value; rsi {period} -> value; atr {period} -> value;",
  "  bollinger {period, mult} -> .upper .middle .lower; adx {period} -> .adx .plus .minus; macd {fast, slow, signal} -> .macd .signal .hist;",
  "  donchian {period} -> .upper .middle .lower (range of the previous N candles); swings {period} -> .high .low (last confirmed swing high/low);",
  "  fvg {minPct, maxAge} -> .top .bottom .age (newest open bullish fair value gap).",
  "  Arg values are numbers or \"$param\".",
  "Rule keys: name, when (list of conditions, all must hold), stopLoss (price, required), takeProfit (price, optional), trailing (distance, optional), exit (list, optional).",
  "Expressions: numbers, $param, indicator names (name.line for multi-line ones), open high low close, entry (buy price; in stopLoss/takeProfit/exit),",
  "  name[n] for n candles back (close[1]), hour minute weekday (UTC, weekday 0 = Sunday), + - * / and parentheses.",
  "Conditions: expr > < >= <= == expr, or expr crossesAbove/crossesBelow expr. No functions, no code.",
  "stopLoss must end below the entry and takeProfit above it, e.g. \"entry - atr * $slAtr\", \"entry + (entry - swings.low) * $rr\".",
  "Reply with the JSON object only.",
].join("\n");

async function newStrategy(desc, host) {
  const cfg = loadConfig(host) || (await setup([], host));
  if (!cfg) return;
  const files = await host.strategies();
  const example = files.find((f) => f.name === "sweep") || files[0];
  const messages = [
    { role: "system", content: STRATEGY_FORMAT + (example ? `\nExample:\n${JSON.stringify(example)}` : "") },
    { role: "user", content: `${desc}\n\n(Names already taken: ${files.map((f) => f.name).join(", ") || "none"})` },
  ];
  for (let attempt = 1; attempt <= 3; attempt++) {
    await host.print(gray(`asking ${cfg.model}${attempt > 1 ? ` (attempt ${attempt})` : ""}...`));
    const text = await chat(cfg, messages, host, null);
    let spec;
    let error;
    try {
      spec = parseJson(text);
      spec.format = "bb-strategy/1";
      spec.author = "ai";
      const v = await host.checkStrategy(spec);
      error = v.ok ? null : v.error;
    } catch (e) {
      error = e.message;
    }
    if (!error) {
      const r = await host.saveStrategy(spec, desc);
      if (r.saved) await host.print(gray(`next: bb-cli new my-bot type=auto strategy=${r.name} symbol=BTCUSDT budget=10, then bb-cli backtest my-bot`));
      return;
    }
    if (attempt === 3) throw new Error(`the model's strategy file isn't valid: ${error}`);
    messages.push({ role: "assistant", content: text }, { role: "user", content: `bb-cli rejected it: ${error}. Reply with the corrected JSON only.` });
  }
}

module.exports = {
  commands: {
    ai: {
      async run(args, host) {
        const [first] = args;
        if (!first || first === "help") {
          return host.print(
            "ai <description>            create a bot, e.g. ai active scalp bot on TSLA with 20 USDT\n" +
              "ai strategy <description>   write a new strategy file, e.g. ai strategy buy RSI dips above the 200 EMA\n" +
              "ai review [bot|all] [--days 14] [--no-backtest]   analyze bots; propose keep, adjust or stop\n" +
              "ai setup                    find a local model (Ollama, LM Studio, llama.cpp)\n" +
              `ai setup <provider> [model] [--new-key]   ${Object.keys(PROVIDERS).join(", ")}\n` +
              "ai setup <url> [model]      any OpenAI-compatible API\n" +
              "ai status                   show the current model"
          );
        }
        if (first === "setup") return setup(args.slice(1), host);
        if (first === "review") return review(args.slice(1), host);
        if (first === "strategy") {
          if (!args[1]) throw new Error("ai strategy <description>");
          return newStrategy(args.slice(1).join(" "), host);
        }
        if (first === "status") {
          const cfg = loadConfig(host);
          if (!cfg) return host.print("not set up yet: ai setup");
          let state;
          try {
            const list = await models(cfg, isLocal(cfg) ? 1500 : 10000);
            state = !list ? "offline" : list.includes(cfg.model) ? "online" : "online, model not in its list";
          } catch (e) {
            state = e.message;
          }
          const p = PROVIDERS[cfg.provider];
          const key = isLocal(cfg) ? "" : cfg.key ? " | key: saved" : p?.env && process.env[p.env] ? ` | key: from ${p.env}` : " | key: none";
          return host.print(`${bold(cfg.model)} at ${where(cfg)} | ${state}${key}`);
        }
        return create(args.join(" "), host);
      },
    },
  },
};
