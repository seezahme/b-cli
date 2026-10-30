// Local AI bot builder. Talks to an OpenAI-compatible server on this machine (Ollama, LM Studio,
// llama.cpp), turns a description into a bot config, and asks bb-cli to add it. It can't start bots
// and has no access to API keys: it runs in bb-cli's plugin sandbox and only uses host calls.
const fs = require("fs");
const path = require("path");

const SERVERS = [
  { name: "Ollama", url: "http://localhost:11434" },
  { name: "LM Studio", url: "http://localhost:1234" },
  { name: "llama.cpp", url: "http://localhost:8080" },
];
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

function loadConfig(host) {
  const env = process.env.BB_AI_URL && { url: process.env.BB_AI_URL, model: process.env.BB_AI_MODEL };
  if (env) return env;
  try {
    return JSON.parse(fs.readFileSync(configFile(host), "utf8"));
  } catch {
    return null;
  }
}

async function models(url) {
  try {
    const r = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    return ((await r.json()).data || []).map((m) => m.id);
  } catch {
    return null;
  }
}

async function setup(args, host) {
  let [url, model] = args;
  if (url) {
    url = url.replace(/\/+$/, "").replace(/\/v1$/, "");
    const list = await models(url);
    if (!list) throw new Error(`no OpenAI-compatible server answering at ${url}/v1/models`);
    if (!model) model = list.length === 1 ? list[0] : await pick(host, list.map((m) => ({ label: m, url, model: m }))).then((x) => x.model);
  } else {
    await host.print(gray("looking for local model servers..."));
    const found = [];
    for (const s of SERVERS) for (const m of (await models(s.url)) || []) found.push({ label: `${m} ${gray(`(${s.name}, ${s.url})`)}`, url: s.url, model: m });
    if (!found.length) {
      await host.print(
        "No local model server found. Start one of:\n" +
          "  Ollama:    ollama pull qwen2.5:7b   (serves on http://localhost:11434)\n" +
          "  LM Studio: load a model and start the local server (http://localhost:1234)\n" +
          "  llama.cpp: llama-server -m model.gguf --port 8080\n" +
          "or point to another one: ai setup http://host:port [model]"
      );
      return null;
    }
    ({ url, model } = found.length === 1 ? found[0] : await pick(host, found));
  }
  fs.writeFileSync(configFile(host), JSON.stringify({ url, model }, null, 2));
  await host.print(`using ${bold(model)} at ${url}`);
  return { url, model };
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

async function chat(cfg, messages) {
  const body = {
    model: cfg.model, messages, temperature: 0.2, stream: false,
    response_format: { type: "json_schema", json_schema: { name: "bot", schema: SCHEMA } },
  };
  const post = () =>
    fetch(`${cfg.url}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(300000),
    });
  let r = await post();
  if (!r.ok) {
    // Some servers reject structured output and some local runners crash on it; the prompt alone asks for JSON.
    delete body.response_format;
    r = await post();
  }
  if (!r.ok) throw new Error(`model server ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).choices?.[0]?.message?.content || "";
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
    const text = await chat(cfg, messages);
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

module.exports = {
  commands: {
    ai: {
      async run(args, host) {
        const [first] = args;
        if (!first || first === "help") {
          return host.print(
            "ai <description>   create a bot, e.g. ai active scalp bot on TSLA with 20 USDT\n" +
              "ai setup [url] [model]   choose the local model server and model\n" +
              "ai status          show the current model"
          );
        }
        if (first === "setup") return setup(args.slice(1), host);
        if (first === "status") {
          const cfg = loadConfig(host);
          if (!cfg) return host.print("not set up yet: ai setup");
          const list = await models(cfg.url);
          return host.print(`${bold(cfg.model)} at ${cfg.url} · ${list ? (list.includes(cfg.model) ? "online" : "server online, model not loaded") : "server offline"}`);
        }
        return create(args.join(" "), host);
      },
    },
  },
};
