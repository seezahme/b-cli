// Indicators over candles {o,h,l,c}. Each returns an array aligned with the candles
// (null during warm-up) or an object of such arrays for multi-line indicators.

function sma(src, n) {
  const out = new Array(src.length).fill(null);
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i];
    if (i >= n) sum -= src[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

// Seeded with the SMA of the first n values, then the usual 2/(n+1) smoothing.
function ema(src, n) {
  const out = new Array(src.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < src.length; i++) {
    if (src[i] == null) continue;
    if (prev == null) {
      if (i < n - 1 || src.slice(i - n + 1, i + 1).some((x) => x == null)) continue;
      prev = src.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n;
    } else prev = src[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder smoothing (alpha 1/n), used by RSI, ATR and ADX.
function wilder(src, n, from = 0) {
  const out = new Array(src.length).fill(null);
  let prev = null;
  for (let i = from; i < src.length; i++) {
    if (prev == null) {
      if (i - from < n - 1) continue;
      prev = src.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n;
    } else prev = (prev * (n - 1) + src[i]) / n;
    out[i] = prev;
  }
  return out;
}

function rsi(close, n) {
  const up = close.map((c, i) => (i ? Math.max(0, c - close[i - 1]) : 0));
  const dn = close.map((c, i) => (i ? Math.max(0, close[i - 1] - c) : 0));
  const au = wilder(up, n, 1);
  const ad = wilder(dn, n, 1);
  return au.map((u, i) => (u == null ? null : ad[i] === 0 ? 100 : 100 - 100 / (1 + u / ad[i])));
}

const trueRange = (k) => k.map((x, i) => (i ? Math.max(x.h - x.l, Math.abs(x.h - k[i - 1].c), Math.abs(x.l - k[i - 1].c)) : x.h - x.l));

const atr = (k, n) => wilder(trueRange(k), n);

function bollinger(src, n, mult) {
  const mid = sma(src, n);
  const sd = mid.map((m, i) => (m == null ? null : Math.sqrt(src.slice(i - n + 1, i + 1).reduce((a, x) => a + (x - m) ** 2, 0) / n)));
  return {
    middle: mid,
    upper: mid.map((m, i) => (m == null ? null : m + mult * sd[i])),
    lower: mid.map((m, i) => (m == null ? null : m - mult * sd[i])),
  };
}

// ADX with +DI/-DI: trend strength (adx) and direction (plus vs minus).
function adx(k, n) {
  const pdm = k.map((x, i) => (i && x.h - k[i - 1].h > k[i - 1].l - x.l ? Math.max(0, x.h - k[i - 1].h) : 0));
  const mdm = k.map((x, i) => (i && k[i - 1].l - x.l > x.h - k[i - 1].h ? Math.max(0, k[i - 1].l - x.l) : 0));
  const tr = wilder(trueRange(k), n, 1);
  const p = wilder(pdm, n, 1).map((v, i) => (v == null || !tr[i] ? null : (100 * v) / tr[i]));
  const m = wilder(mdm, n, 1).map((v, i) => (v == null || !tr[i] ? null : (100 * v) / tr[i]));
  const dx = p.map((v, i) => (v == null ? null : v + m[i] === 0 ? 0 : (100 * Math.abs(v - m[i])) / (v + m[i])));
  const first = dx.findIndex((v) => v != null);
  const a = first < 0 ? dx.map(() => null) : wilder(dx.map((v) => v ?? 0), n, first);
  return { adx: a, plus: p, minus: m };
}

function macd(src, fast, slow, signal) {
  const f = ema(src, fast);
  const s = ema(src, slow);
  const line = f.map((v, i) => (v == null || s[i] == null ? null : v - s[i]));
  const sig = ema(line, signal);
  return { macd: line, signal: sig, hist: line.map((v, i) => (v == null || sig[i] == null ? null : v - sig[i])) };
}

// Highest high / lowest low of the n bars BEFORE each bar, so "close > dc.upper" means a breakout.
function donchian(k, n) {
  const upper = k.map((_, i) => (i < n ? null : Math.max(...k.slice(i - n, i).map((x) => x.h))));
  const lower = k.map((_, i) => (i < n ? null : Math.min(...k.slice(i - n, i).map((x) => x.l))));
  return { upper, lower, middle: upper.map((u, i) => (u == null ? null : (u + lower[i]) / 2)) };
}

// Market structure. A swing high is a high with `n` lower highs on each side (a swing low: mirrored).
// It's only known n bars later, so bar i sees the latest swing confirmed by bar i-1: "close > swings.high"
// is a break of structure, "low < swings.low" a sweep of the liquidity below the last swing low.
function swings(k, n) {
  const high = new Array(k.length).fill(null);
  const low = new Array(k.length).fill(null);
  let hi = null;
  let lo = null;
  for (let i = 1; i < k.length; i++) {
    const j = i - 1 - n; // pivot candidate confirmed by bar i-1
    if (j >= n) {
      const win = k.slice(j - n, j + n + 1);
      if (win.every((x) => x.h <= k[j].h)) hi = k[j].h;
      if (win.every((x) => x.l >= k[j].l)) lo = k[j].l;
    }
    high[i] = hi;
    low[i] = lo;
  }
  return { high, low };
}

// Bullish fair value gap: candle 3's low is above candle 1's high, leaving an untraded zone
// [bottom = high1, top = low3]. Bar i sees the newest gap formed before it, until a close below
// its bottom fills it or it's older than maxAge bars. minPct drops gaps smaller than that % of price.
function fvg(k, minPct = 0, maxAge = 50) {
  const top = new Array(k.length).fill(null);
  const bottom = new Array(k.length).fill(null);
  const age = new Array(k.length).fill(null);
  let gap = null;
  for (let i = 0; i < k.length; i++) {
    if (gap && i - gap.born > maxAge) gap = null;
    if (gap) [top[i], bottom[i], age[i]] = [gap.top, gap.bottom, i - gap.born];
    if (gap && k[i].c < gap.bottom) gap = null; // closed through: gap is filled
    if (i >= 2 && k[i].l > k[i - 2].h && (k[i].l - k[i - 2].h) / k[i].c >= minPct / 100) {
      gap = { top: k[i].l, bottom: k[i - 2].h, born: i };
    }
  }
  return { top, bottom, age };
}

// name -> { args: argument names, fields: output lines (null = single line), warm(args): bars needed, calc }
const SOURCES = { open: "o", high: "h", low: "l", close: "c" };
const src = (k, s = "close") => k.map((x) => x[SOURCES[s]]);
const TYPES = {
  sma: { args: ["period", "source"], fields: null, warm: (a) => a.period, calc: (k, a) => sma(src(k, a.source), a.period) },
  ema: { args: ["period", "source"], fields: null, warm: (a) => a.period * 3, calc: (k, a) => ema(src(k, a.source), a.period) },
  rsi: { args: ["period"], fields: null, warm: (a) => a.period * 4, calc: (k, a) => rsi(src(k), a.period) },
  atr: { args: ["period"], fields: null, warm: (a) => a.period * 3, calc: (k, a) => atr(k, a.period) },
  bollinger: { args: ["period", "mult", "source"], fields: ["upper", "middle", "lower"], warm: (a) => a.period, calc: (k, a) => bollinger(src(k, a.source), a.period, a.mult ?? 2) },
  adx: { args: ["period"], fields: ["adx", "plus", "minus"], warm: (a) => a.period * 5, calc: (k, a) => adx(k, a.period) },
  macd: { args: ["fast", "slow", "signal"], fields: ["macd", "signal", "hist"], warm: (a) => a.slow * 3 + a.signal, calc: (k, a) => macd(src(k), a.fast, a.slow, a.signal) },
  donchian: { args: ["period"], fields: ["upper", "middle", "lower"], warm: (a) => a.period + 1, calc: (k, a) => donchian(k, a.period) },
  swings: { args: ["period"], fields: ["high", "low"], warm: (a) => a.period * 10, calc: (k, a) => swings(k, a.period) },
  fvg: { args: ["minPct", "maxAge"], fields: ["top", "bottom", "age"], warm: (a) => (a.maxAge ?? 50) + 3, calc: (k, a) => fvg(k, a.minPct ?? 0, a.maxAge ?? 50) },
};

module.exports = { TYPES, SOURCES, sma, ema, rsi, atr, bollinger, adx, macd, donchian, swings, fvg };
