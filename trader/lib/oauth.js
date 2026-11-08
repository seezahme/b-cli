// Bybit OAuth (PKCE, no client secret) for the AI-agent client, following
// github.com/bybit-exchange/skills oauth.js. Ends with an API key pair for an
// AI subaccount, saved to .bybit/oauth_token.json (git-ignored, owner-only).
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const CLIENT_ID = "ai-agent";
const HOSTS = {
  mainnet: { authorize: "https://www.bybit.com/oauth", api: "https://api2.bybit.com", callback: "https://www.bybit.com/oauth/callback" },
  testnet: { authorize: "https://testnet.bybit.com/oauth", api: "https://api2-testnet.bybit.com", callback: "https://testnet.bybit.com/oauth/callback" },
};
// BYBIT_CRED_DIR overrides the folder, same as lib/api.js reads it
const CRED = path.join(process.env.BYBIT_CRED_DIR || path.join(__dirname, "..", ".bybit"), "oauth_token.json");

const now = () => Math.floor(Date.now() / 1000);
const mask = (k) => (k && k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : "***");
// Bybit answers { retCode, retMsg, result } or the bare object; normalize both.
const unwrap = (j) => {
  const code = j?.retCode ?? j?.ret_code;
  if (code !== undefined && code !== 0) throw Object.assign(new Error(`Bybit: ${j.retMsg ?? j.ret_msg} (${code})`), { code });
  return j?.result ?? j;
};

async function post(url, form) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(30000),
  });
  return unwrap(await r.json());
}

async function get(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
  return unwrap(await r.json());
}

function readCred() {
  try {
    return JSON.parse(fs.readFileSync(CRED, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

// Owner-only file. On Windows mode bits are ignored, so drop inherited ACLs and grant only this user + SYSTEM.
function writeCred(cred) {
  fs.mkdirSync(path.dirname(CRED), { recursive: true, mode: 0o700 });
  const tmp = `${CRED}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cred, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CRED);
  if (process.platform === "win32") {
    try {
      execFileSync("icacls", [CRED, "/inheritance:r", "/grant:r", `${os.userInfo().username}:F`, "*S-1-5-18:F"], { stdio: "ignore" });
    } catch {}
  }
}

function openBrowser(url) {
  // rundll32 avoids cmd.exe, which would split the URL at its '&' characters
  const [cmd, args] =
    process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  } catch {}
}

// Local page that receives Bybit's redirect. Tries ports 9876-9886 on 127.0.0.1 only.
async function callbackServer(state) {
  for (let port = 9876; port <= 9886; port++) {
    const server = http.createServer();
    const ok = await new Promise((res) => {
      server.once("error", () => res(false));
      server.listen(port, "127.0.0.1", () => res(true));
    });
    if (!ok) continue;
    const code = new Promise((resolve, reject) => {
      server.on("request", (req, res) => {
        const u = new URL(req.url, "http://127.0.0.1");
        if (u.pathname !== "/callback") return res.writeHead(404).end();
        const page = (status, msg) => res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" })
          .end(`<!doctype html><title>bb-cli</title><body style="font:16px system-ui;margin:3em">${msg}</body>`);
        if (u.searchParams.get("state") !== state) return page(403, "Authorization failed: state mismatch. Run <b>bb-cli login</b> again.");
        const c = u.searchParams.get("code");
        if (!c) {
          page(400, "Authorization was not granted.");
          return reject(new Error(`authorization failed: ${u.searchParams.get("error") || "no code"}`));
        }
        page(200, "Authorized. You can close this tab and return to bb-cli.");
        resolve(c);
      });
    });
    return { port, code, close: () => server.close() };
  }
  return null;
}

// Access token from the saved file, refreshed if expired. null when a browser login is needed.
async function savedToken(env) {
  const cred = readCred();
  if (!cred?.access_token || cred.env !== env) return null;
  if (now() - cred.created_at < cred.expires_in - 60) return cred;
  if (!cred.refresh_token || now() - cred.created_at > (cred.refresh_token_expires_in || 2592000)) return null;
  try {
    const t = await post(`${HOSTS[env].api}/oauth/v1/public/refresh_token`, { client_id: CLIENT_ID, refresh_token: cred.refresh_token });
    Object.assign(cred, {
      access_token: t.access_token, refresh_token: t.refresh_token, created_at: now(),
      expires_in: t.expires_in || 86400, refresh_token_expires_in: t.refresh_token_expires_in || cred.refresh_token_expires_in,
    });
    writeCred(cred);
    return cred;
  } catch {
    return null;
  }
}

async function browserLogin(env, io) {
  const H = HOSTS[env];
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(8).toString("hex");
  const srv = await callbackServer(state);
  // Without a free local port Bybit shows the code on its own page for pasting.
  const redirect = srv ? `http://127.0.0.1:${srv.port}/callback` : H.callback;
  const url = `${H.authorize}?${new URLSearchParams({
    client_id: CLIENT_ID, response_type: "code", scope: "ai-account", state, redirect_uri: redirect,
    code_challenge: challenge, code_challenge_method: "S256",
  })}`;
  io.print(`Opening Bybit in your browser. If nothing opens, use this link:\n${url}\n`);
  openBrowser(url);

  let timer;
  const waits = [new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("no authorization within 5 minutes")), 300000)))];
  if (srv) waits.push(srv.code);
  if (io.canAsk) {
    const pasted = io.ask("waiting for Bybit... or paste the code Bybit shows you: ").then((c) => {
      if (!c) throw new Error("no code entered");
      return c.trim();
    });
    if (srv) pasted.catch(() => {}); // the redirect may win; then this question is dropped
    waits.push(pasted);
  }
  try {
    const code = await Promise.race(waits);
    io.print("authorized, getting the access token...");
    const t = await post(`${H.api}/oauth/v1/public/access_token`, { client_id: CLIENT_ID, code, code_verifier: verifier });
    const cred = {
      ...(readCred() || {}),
      access_token: t.access_token, refresh_token: t.refresh_token, token_type: t.token_type || "bearer",
      expires_in: t.expires_in || 86400, refresh_token_expires_in: t.refresh_token_expires_in || 2592000,
      env, created_at: now(),
    };
    delete cred["ai-account"]; // keys of the previous login belong to the old token
    return cred;
  } finally {
    clearTimeout(timer);
    srv?.close();
  }
}

// Picks or creates the AI subaccount and returns { sub_member_id, api_key, api_secret }.
async function aiAccount(env, token, io) {
  const base = `${HOSTS[env].api}/oauth/v1/resource/restrict/ai_accounts`;
  const list = (r) => (Array.isArray(r) ? r : Array.isArray(r?.accounts) ? r.accounts : null);
  let r = await get(base, token);
  let accounts = list(r);
  if (accounts) {
    const withKeys = accounts.find((a) => a.api_key);
    if (withKeys) return withKeys;
    let choice = "new";
    if (accounts.length) {
      io.print("AI subaccounts on this Bybit account:");
      accounts.forEach((a, i) => io.print(`  ${i + 1}. ${a.nickname || "AI subaccount"} (${a.sub_member_id})`));
      if (accounts.length < 5) io.print(`  ${accounts.length + 1}. create a new AI subaccount`);
      const a = io.canAsk ? await io.ask(`choose [1-${accounts.length + (accounts.length < 5 ? 1 : 0)}]: `) : "1";
      const n = Number(a);
      if (n >= 1 && n <= accounts.length) choice = accounts[n - 1].sub_member_id;
      else if (!(n === accounts.length + 1 && accounts.length < 5)) throw new Error("no subaccount chosen");
    }
    const q = choice === "new" ? "is_create=true" : `sub_member_id=${encodeURIComponent(choice)}`;
    io.print(choice === "new" ? "creating an AI subaccount..." : "getting API keys...");
    r = await get(`${base}?${q}`, token);
    // Bybit may answer with a one-item list here too
    accounts = list(r);
    if (accounts) r = accounts.find((a) => String(a.sub_member_id) === String(choice) && a.api_key) || accounts.find((a) => a.api_key);
  }
  if (!r?.api_key || !r?.api_secret) throw new Error("Bybit returned no API key for the AI subaccount");
  return { sub_member_id: r.sub_member_id, api_key: r.api_key, api_secret: r.api_secret };
}

// io: { print(text), ask(question) -> Promise<string>, canAsk }
async function login({ env = "mainnet", fresh = false, io }) {
  if (!HOSTS[env]) throw new Error(`env must be ${Object.keys(HOSTS).join(" or ")}`);
  let cred = fresh ? null : await savedToken(env);
  if (cred) io.print("using the saved Bybit authorization (no browser needed; --new forces a new login)");
  else cred = await browserLogin(env, io);
  writeCred(cred); // keep the token even if the subaccount step fails, so a retry skips the browser
  cred["ai-account"] = await aiAccount(env, cred.access_token, io);
  writeCred(cred);
  return { file: CRED, sub_member_id: cred["ai-account"].sub_member_id, api_key: mask(cred["ai-account"].api_key) };
}

// Summary for `bb-cli login status`; never includes secrets.
function status() {
  const cred = readCred();
  if (!cred) return null;
  const left = (s) => (s > 0 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : "expired");
  return {
    file: CRED,
    env: cred.env,
    api_key: cred["ai-account"] ? mask(cred["ai-account"].api_key) : null,
    sub_member_id: cred["ai-account"]?.sub_member_id ?? null,
    access: cred.access_token ? left(cred.created_at + cred.expires_in - now()) : null,
    refresh: cred.refresh_token ? left(cred.created_at + (cred.refresh_token_expires_in || 2592000) - now()) : null,
  };
}

module.exports = { login, status, CRED };
