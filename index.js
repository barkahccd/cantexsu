const fs = require('fs');
const crypto = require('crypto');
const { ethers } = require('ethers');
const { ProxyAgent } = require('undici');

// Prevent unhandled errors from killing the process
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err?.message || err);
});

let config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
let accountsData = [];
try { accountsData = JSON.parse(fs.readFileSync('./accounts.json', 'utf8')); } catch(e) {}
const globalLogs = [];

const INSTRUMENTS = {
  CC:    { id: 'Amulet', admin: 'DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc' },
  CBTC: { id: 'CBTC',  admin: 'cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262' },
  USDCx: { id: 'USDCx', admin: 'decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef' }
};

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rng(a, b) { return a + Math.random() * (b - a); }
const MIN_SWAP_DELAY_BETWEEN_SWAPS_MS = 10 * 60 * 1000;
const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function fmtAmt(v, d = 10) {
  const f = 10 ** d;
  return (Math.floor(Math.max(0, v) * f) / f).toFixed(d).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function fmtDur(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (h > 0) return h + 'h' + (m % 60) + 'm';
  if (m > 0) return m + 'm' + (s % 60) + 's';
  return s + 's';
}

function fmtCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function ts() { return new Date().toLocaleTimeString('id-ID', { hour12: false }); }

// WIB = UTC+7
function nowWIB() {
  return new Date(Date.now() + 7 * 3600000);
}

function fmtWIB(date) {
  return date.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });
}

function getSwapPair(settings = {}) {
  const pair = String(settings.swapPair || 'cbtc').toLowerCase().trim();
  if (pair === 'both' || pair === 'auto' || pair === 'mix' || pair === 'all') return 'both';
  if (pair === 'usdc' || pair === 'usdcx' || pair === 'cc-usdc') return 'usdc';
  return 'cbtc';
}

function getPairInfoFromPair(pair) {
  if (pair === 'usdc') {
    return { pair, buyToken: 'USDCx', modeLabel: 'CC>US', colLabel: 'USDCx', swapShort: 'us' };
  }
  if (pair === 'both') {
    return { pair, buyToken: null, modeLabel: 'CC>MIX', colLabel: 'USDCx|CBTC', swapShort: 'mix' };
  }
  return { pair: 'cbtc', buyToken: 'CBTC', modeLabel: 'CC>CB', colLabel: 'CBTC', swapShort: 'cb' };
}

function getPairInfo(settings = {}) {
  return getPairInfoFromPair(getSwapPair(settings));
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function randInt(min, max) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  if (hi <= lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function pickWeighted(list) {
  let total = 0;
  for (const item of list) {
    const w = Number(item.weight) || 0;
    if (w > 0) total += w;
  }
  if (total <= 0) return list[0]?.key;

  let r = Math.random() * total;
  for (const item of list) {
    const w = Number(item.weight) || 0;
    if (w <= 0) continue;
    r -= w;
    if (r <= 0) return item.key;
  }
  return list[list.length - 1]?.key;
}

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  if (!isObj(base)) {
    return isObj(override) ? deepMerge({}, override) : override;
  }
  const out = { ...base };
  if (!isObj(override)) return out;

  for (const key of Object.keys(override)) {
    const b = base[key];
    const o = override[key];
    out[key] = isObj(b) && isObj(o) ? deepMerge(b, o) : o;
  }
  return out;
}

function getCcAmountRange(settings = {}) {
  const ccAmount = isObj(settings.ccAmount) ? settings.ccAmount : {};
  let min = Number(ccAmount.min ?? settings.swapAmountMinCC);
  let max = Number(ccAmount.max ?? settings.swapAmountMaxCC);

  if (!Number.isFinite(min) || min <= 0) min = 0.11;
  if (!Number.isFinite(max) || max <= 0) max = 0.15;
  if (max < min) max = min;

  return { min, max };
}

function getCcReserve(settings = {}) {
  const ccAmount = isObj(settings.ccAmount) ? settings.ccAmount : {};
  let reserve = Number(ccAmount.reserve ?? settings.ccReserve);
  if (!Number.isFinite(reserve) || reserve < 0) reserve = 0.2;
  return reserve;
}

function getSwapDelayRange(settings = {}) {
  const timing = isObj(settings.timing) ? settings.timing : {};
  let min = Number(timing.swapDelayMinMs ?? settings.swapDelayMinMs);
  let max = Number(timing.swapDelayMaxMs ?? settings.swapDelayMaxMs);

  if (!Number.isFinite(min) || min < 1000) min = 60000;
  if (!Number.isFinite(max) || max < 1000) max = 180000;
  if (max < min) max = min;

  return { min, max };
}

function getFeeRecheckDelayRange(settings = {}) {
  const timing = isObj(settings.timing) ? settings.timing : {};
  let minMinutes = Number(timing.feeRecheckDelayMinMinutes ?? settings.feeRecheckDelayMinMinutes);
  let maxMinutes = Number(timing.feeRecheckDelayMaxMinutes ?? settings.feeRecheckDelayMaxMinutes);

  if (!Number.isFinite(minMinutes) || minMinutes <= 0) minMinutes = 1;
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) maxMinutes = 2;
  if (maxMinutes < minMinutes) maxMinutes = minMinutes;

  return {
    minMinutes,
    maxMinutes,
    minMs: minMinutes * 60000,
    maxMs: maxMinutes * 60000
  };
}

function getFeeLimits(settings = {}) {
  const feeLimits = isObj(settings.feeLimits) ? settings.feeLimits : {};

  const maxNetworkFee = Number.isFinite(Number(feeLimits.maxNetworkFee))
    ? Number(feeLimits.maxNetworkFee)
    : (Number.isFinite(Number(settings.maxNetworkFee)) ? Number(settings.maxNetworkFee) : 0.1);

  const maxSlippagePercent = Number.isFinite(Number(feeLimits.maxSlippagePercent))
    ? Number(feeLimits.maxSlippagePercent)
    : (Number.isFinite(Number(settings.maxSlippagePercent)) ? Number(settings.maxSlippagePercent) : 0.08);

  const maxPoolFeePercent = Number.isFinite(Number(feeLimits.maxPoolFeePercent))
    ? Number(feeLimits.maxPoolFeePercent)
    : (Number.isFinite(Number(settings.maxPoolFeePercent)) ? Number(settings.maxPoolFeePercent) : 0.06);

  return { maxNetworkFee, maxSlippagePercent, maxPoolFeePercent };
}

const STRATEGY_PRESETS = {
  balanced_human: {
    description: 'Pola paling natural untuk harian: sesi pendek, volume campuran, jeda bervariasi.',
    amountBias: 'balanced',
    sessionSwapsMin: 2,
    sessionSwapsMax: 4,
    afterSwapDelayMinMs: 10 * 60 * 1000,
    afterSwapDelayMaxMs: 24 * 60 * 1000,
    delayFactorMin: 1.0,
    delayFactorMax: 1.6,
    thinkPauseChance: 0.22,
    thinkPauseFactorMin: 1.3,
    thinkPauseFactorMax: 2.8,
    sessionBreakChance: 0.55,
    sessionBreakFactorMin: 4,
    sessionBreakFactorMax: 10,
    amountSmoothing: 0.35
  },
  scalper_human: {
    description: 'Lebih aktif dan cepat: volume kecil-menengah, frekuensi tinggi, jeda singkat.',
    amountBias: 'small',
    sessionSwapsMin: 4,
    sessionSwapsMax: 8,
    afterSwapDelayMinMs: 10 * 60 * 1000,
    afterSwapDelayMaxMs: 16 * 60 * 1000,
    delayFactorMin: 0.55,
    delayFactorMax: 1.1,
    thinkPauseChance: 0.12,
    thinkPauseFactorMin: 1.1,
    thinkPauseFactorMax: 1.9,
    sessionBreakChance: 0.35,
    sessionBreakFactorMin: 2.2,
    sessionBreakFactorMax: 5.5,
    amountSmoothing: 0.2
  },
  patient_human: {
    description: 'Lebih santai: swap lebih jarang tapi nominal cenderung lebih besar.',
    amountBias: 'large',
    sessionSwapsMin: 1,
    sessionSwapsMax: 3,
    afterSwapDelayMinMs: 12 * 60 * 1000,
    afterSwapDelayMaxMs: 36 * 60 * 1000,
    delayFactorMin: 1.5,
    delayFactorMax: 2.7,
    thinkPauseChance: 0.3,
    thinkPauseFactorMin: 1.8,
    thinkPauseFactorMax: 3.5,
    sessionBreakChance: 0.7,
    sessionBreakFactorMin: 6,
    sessionBreakFactorMax: 14,
    amountSmoothing: 0.42
  },
  chaotic_human: {
    description: 'Pola acak manusia real: ada sesi cepat, ada jeda panjang, ukuran swap tidak monoton.',
    amountBias: 'chaotic',
    sessionSwapsMin: 1,
    sessionSwapsMax: 6,
    afterSwapDelayMinMs: 10 * 60 * 1000,
    afterSwapDelayMaxMs: 48 * 60 * 1000,
    delayFactorMin: 0.6,
    delayFactorMax: 2.3,
    thinkPauseChance: 0.28,
    thinkPauseFactorMin: 1.2,
    thinkPauseFactorMax: 4,
    sessionBreakChance: 0.6,
    sessionBreakFactorMin: 3,
    sessionBreakFactorMax: 16,
    amountSmoothing: 0.25
  }
};

function normalizeStrategyKey(v) {
  return String(v || '').toLowerCase().trim();
}

function normalizeAmountBias(v) {
  const bias = String(v || '').toLowerCase().trim();
  if (['small', 'balanced', 'large', 'chaotic'].includes(bias)) return bias;
  return 'balanced';
}

function sanitizeStrategyProfile(profile = {}) {
  const out = { ...profile };

  out.amountBias = normalizeAmountBias(out.amountBias);
  out.sessionSwapsMin = Math.max(1, Math.floor(Number(out.sessionSwapsMin) || 2));
  out.sessionSwapsMax = Math.max(out.sessionSwapsMin, Math.floor(Number(out.sessionSwapsMax) || out.sessionSwapsMin));

  out.delayFactorMin = Math.max(0.15, Number(out.delayFactorMin) || 1);
  out.delayFactorMax = Math.max(out.delayFactorMin, Number(out.delayFactorMax) || out.delayFactorMin);

  const cfgAfterSwapMin = Number(out.afterSwapDelayMinMs);
  const cfgAfterSwapMax = Number(out.afterSwapDelayMaxMs);
  out.afterSwapDelayMinMs = Number.isFinite(cfgAfterSwapMin)
    ? Math.max(MIN_SWAP_DELAY_BETWEEN_SWAPS_MS, cfgAfterSwapMin)
    : MIN_SWAP_DELAY_BETWEEN_SWAPS_MS;
  out.afterSwapDelayMaxMs = Number.isFinite(cfgAfterSwapMax)
    ? Math.max(out.afterSwapDelayMinMs, cfgAfterSwapMax)
    : Math.max(out.afterSwapDelayMinMs, out.afterSwapDelayMinMs + 8 * 60000);

  out.thinkPauseChance = clamp(Number(out.thinkPauseChance) || 0, 0, 1);
  out.thinkPauseFactorMin = Math.max(1, Number(out.thinkPauseFactorMin) || 1.2);
  out.thinkPauseFactorMax = Math.max(out.thinkPauseFactorMin, Number(out.thinkPauseFactorMax) || out.thinkPauseFactorMin);

  out.sessionBreakChance = clamp(Number(out.sessionBreakChance) || 0, 0, 1);
  out.sessionBreakFactorMin = Math.max(1.2, Number(out.sessionBreakFactorMin) || 3);
  out.sessionBreakFactorMax = Math.max(out.sessionBreakFactorMin, Number(out.sessionBreakFactorMax) || out.sessionBreakFactorMin);

  out.amountSmoothing = clamp(Number(out.amountSmoothing) || 0, 0, 0.85);
  return out;
}

function getStrategyRuntime(settings = {}) {
  const strategy = isObj(settings.strategy) ? settings.strategy : {};
  const selectedRaw = normalizeStrategyKey(strategy.selected || settings.swapStrategy || 'balanced_human');
  const selected = STRATEGY_PRESETS[selectedRaw] ? selectedRaw : 'balanced_human';
  const options = isObj(strategy.options) ? strategy.options : {};
  const custom = isObj(options[selected]) ? options[selected] : {};
  const profile = sanitizeStrategyProfile(deepMerge(STRATEGY_PRESETS[selected], custom));
  return { key: selected, profile, description: String(profile.description || '').trim() };
}

function getBiasWeights(amountBias) {
  if (amountBias === 'small') {
    return { low: 0.62, mid: 0.3, high: 0.08 };
  }
  if (amountBias === 'large') {
    return { low: 0.16, mid: 0.44, high: 0.4 };
  }
  if (amountBias === 'chaotic') {
    return { low: 0.33, mid: 0.34, high: 0.33 };
  }
  return { low: 0.3, mid: 0.5, high: 0.2 };
}

function pickHumanAmountRatio(profile, state) {
  const weights = getBiasWeights(profile.amountBias);
  const bucket = pickWeighted([
    { key: 'low', weight: weights.low },
    { key: 'mid', weight: weights.mid },
    { key: 'high', weight: weights.high }
  ]);

  let ratio = 0.5;
  if (bucket === 'low') ratio = rng(0.1, 0.45);
  else if (bucket === 'high') ratio = rng(0.68, 1);
  else ratio = rng(0.35, 0.78);

  if (Number.isFinite(state.lastAmountRatio)) {
    ratio = clamp(state.lastAmountRatio * profile.amountSmoothing + ratio * (1 - profile.amountSmoothing), 0.05, 1);
  }
  state.lastAmountRatio = ratio;
  return ratio;
}

function pickHumanSwapAmountCC(availableCC, ccRange, profile, state) {
  const high = Math.min(ccRange.max, availableCC);
  const low = Math.min(ccRange.min, high);

  if (high <= 0) return 0;
  if (high <= low + 1e-12) return high;

  const ratio = pickHumanAmountRatio(profile, state);
  return low + (high - low) * ratio;
}

function pickHumanDelayMs(baseDelay, profile) {
  const hasExplicitRange = Number.isFinite(Number(profile.afterSwapDelayMinMs)) && Number.isFinite(Number(profile.afterSwapDelayMaxMs));
  const minMs = hasExplicitRange
    ? Math.max(MIN_SWAP_DELAY_BETWEEN_SWAPS_MS, Number(profile.afterSwapDelayMinMs))
    : Math.max(MIN_SWAP_DELAY_BETWEEN_SWAPS_MS, baseDelay.min * profile.delayFactorMin);
  const maxMs = hasExplicitRange
    ? Math.max(minMs, Number(profile.afterSwapDelayMaxMs))
    : Math.max(minMs, baseDelay.max * profile.delayFactorMax);
  return rng(minMs, maxMs);
}

function pickHumanThinkPauseMs(baseDelay, profile) {
  if (Math.random() > profile.thinkPauseChance) return 0;
  const minMs = Math.max(2000, baseDelay.min * profile.thinkPauseFactorMin);
  const maxMs = Math.max(minMs, baseDelay.max * profile.thinkPauseFactorMax);
  return rng(minMs, maxMs);
}

function pickHumanSessionBreakMs(baseDelay, profile) {
  const regularMax = Number.isFinite(Number(profile.afterSwapDelayMaxMs))
    ? Number(profile.afterSwapDelayMaxMs)
    : MIN_SWAP_DELAY_BETWEEN_SWAPS_MS;
  const minMs = Math.max(
    MIN_SWAP_DELAY_BETWEEN_SWAPS_MS,
    regularMax,
    baseDelay.max * profile.sessionBreakFactorMin
  );
  const maxMs = Math.max(
    minMs,
    regularMax * 2,
    baseDelay.max * profile.sessionBreakFactorMax
  );
  return rng(minMs, maxMs);
}

function chooseBySwapCounts(acc) {
  const us = Number(acc.swapUsdc) || 0;
  const cb = Number(acc.swapCbtc) || 0;
  if (us === cb) return Math.random() < 0.5 ? 'USDCx' : 'CBTC';
  return us < cb ? 'USDCx' : 'CBTC';
}

async function estimateTokenBalanceInCC(acc, token, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  try {
    const quote = await acc.getQuote(token, 'CC', fmtAmt(amount, 10));
    const ret = parseFloat(quote?.returned?.amount || 0);
    return Number.isFinite(ret) && ret > 0 ? ret : null;
  } catch {
    return null;
  }
}

async function chooseSmartBuyToken(acc, settings = {}) {
  const pair = getSwapPair(settings);
  if (pair === 'usdc') return 'USDCx';
  if (pair === 'cbtc') return 'CBTC';

  const usdcDust = 0.001;
  const cbtcDust = 0.000001;
  const hasUsdc = (acc.usdcx || 0) > usdcDust;
  const hasCbtc = (acc.cbtc || 0) > cbtcDust;

  let usdcValueCC = null;
  let cbtcValueCC = null;

  if (hasUsdc) usdcValueCC = await estimateTokenBalanceInCC(acc, 'USDCx', acc.usdcx || 0);
  if (hasCbtc) cbtcValueCC = await estimateTokenBalanceInCC(acc, 'CBTC', acc.cbtc || 0);

  if (Number.isFinite(usdcValueCC) && Number.isFinite(cbtcValueCC)) {
    const gap = 1.12;
    if (usdcValueCC > cbtcValueCC * gap) return 'CBTC';
    if (cbtcValueCC > usdcValueCC * gap) return 'USDCx';
    return chooseBySwapCounts(acc);
  }

  if (Number.isFinite(usdcValueCC)) return 'CBTC';
  if (Number.isFinite(cbtcValueCC)) return 'USDCx';
  if (hasUsdc && !hasCbtc) return 'CBTC';
  if (hasCbtc && !hasUsdc) return 'USDCx';

  return chooseBySwapCounts(acc);
}

async function chooseSmartBulkBackToken(acc, settings = {}) {
  const pair = getSwapPair(settings);
  if (pair === 'usdc') return 'USDCx';
  if (pair === 'cbtc') return 'CBTC';

  const usdcDust = 0.001;
  const cbtcDust = 0.000001;
  const canUsdc = (acc.usdcx || 0) > usdcDust;
  const canCbtc = (acc.cbtc || 0) > cbtcDust;

  if (!canUsdc && !canCbtc) return null;
  if (canUsdc && !canCbtc) return 'USDCx';
  if (canCbtc && !canUsdc) return 'CBTC';

  const usdcValueCC = await estimateTokenBalanceInCC(acc, 'USDCx', acc.usdcx || 0);
  const cbtcValueCC = await estimateTokenBalanceInCC(acc, 'CBTC', acc.cbtc || 0);

  if (Number.isFinite(usdcValueCC) && Number.isFinite(cbtcValueCC)) {
    return usdcValueCC >= cbtcValueCC ? 'USDCx' : 'CBTC';
  }
  if (Number.isFinite(usdcValueCC)) return 'USDCx';
  if (Number.isFinite(cbtcValueCC)) return 'CBTC';

  return (acc.usdcx || 0) >= (acc.cbtc || 0) ? 'USDCx' : 'CBTC';
}

// ─── Ed25519 Key ────────────────────────────────────────────────────────────
function createEd25519Key(hex) {
  const raw = Buffer.from(hex, 'hex');
  if (raw.length !== 32) throw new Error('operatorKey must be 32 bytes');
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const pk = crypto.createPrivateKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(pk);
  const spki = pub.export({ type: 'spki', format: 'der' });
  const pubRaw = spki.subarray(spki.length - 32);
  return { privateKey: pk, pubHex: pubRaw.toString('hex'), pubB64: b64url(pubRaw) };
}

// ─── secp256k1 DER Signing (matches SDK sigencode_der) ─────────────────────
function signDER(wallet, digestHex) {
  const sig = wallet.signingKey.sign('0x' + digestHex);
  function toBytes(val) {
    let h = BigInt(val).toString(16);
    if (h.length % 2) h = '0' + h;
    if (parseInt(h.slice(0, 2), 16) >= 0x80) h = '00' + h;
    return Buffer.from(h, 'hex');
  }
  const r = toBytes(sig.r), s = toBytes(sig.s);
  const rT = Buffer.concat([Buffer.from([0x02, r.length]), r]);
  const sT = Buffer.concat([Buffer.from([0x02, s.length]), s]);
  const body = Buffer.concat([rT, sT]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]).toString('hex');
}

// ─── Account ────────────────────────────────────────────────────────────────
class Account {
  constructor(name, creds, settings, proxy) {
    this.name = name;
    this.baseUrl = (settings.baseUrl || 'https://api.cantex.io').replace(/\/$/, '');
    this.opKey = createEd25519Key(creds.operatorKey);
    this.intentWallet = new ethers.Wallet(creds.intentTradingKey);
    this.apiKey = null;
    this.proxy = proxy;
    this.settings = settings;
    this.cycle = 0;
    this.totalSwaps = 0;
    this.dailySwaps = 0;
    this.dailyCycle = 1;
    this.dailyTargetReachedAt = 0;
    this.nextDailyCycleAt = 0;
    this.okSwaps = 0;
    this.failSwaps = 0;
    this.swapCC = 0;
    this.swapCbtc = 0;
    this.swapUsdc = 0;
    this.cc = 0;
    this.cbtc = 0;
    this.usdcx = 0;
    this.ccL = 0;
    this.cbtcL = 0;
    this.usdcxL = 0;
    this.logs = [];
    this.t0 = Date.now();
    this.status = 'idle';
    this.lastErr = '';
    this.rewardScore = 0;
    this.rewardRank = '-';
    this.rewardDay = '';
    this.rewardPaused = false;
    this.strategyState = {
      sessionTarget: 0,
      sessionDone: 0,
      lastAmountRatio: null,
      justStarted: true
    };
  }

  log(msg) {
    const timeStr = ts();
    this.logs.push(timeStr + ' ' + msg);
    if (this.logs.length > 6) this.logs.shift();

    globalLogs.push(`[${timeStr}] [${this.name}] ${msg}`);
    if (globalLogs.length > 15) globalLogs.shift();
  }

  async _fetch(url, opts = {}) {
    if (this.proxy) {
      opts.dispatcher = new ProxyAgent(this.proxy);
    }
    return fetch(url, opts);
  }

  async api(path, opts = {}) {
    for (let att = 0; att <= 3; att++) {
      const hdr = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
      if (this.apiKey) hdr['Authorization'] = 'Bearer ' + this.apiKey;
      const resp = await this._fetch(this.baseUrl + path, {
        method: opts.method || 'GET', headers: hdr, body: opts.body, redirect: 'manual'
      });
      const text = await resp.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      if (resp.status === 401 && this.apiKey && att < 3) {
        try { await this.auth(); } catch {} continue;
      }
      if ([429, 502, 503, 504].includes(resp.status) && att < 3) {
        await sleep(Math.min(1000 * Math.pow(2, att), 10000) + Math.random() * 1000);
        continue;
      }
      return { status: resp.status, data };
    }
    return { status: 0, data: null };
  }

  async auth() {
    this.log('🔑 Auth...');
    this.status = 'auth';
    const r1 = await this._fetch(this.baseUrl + '/v1/auth/api-key/begin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: this.opKey.pubB64 })
    });
    if (r1.status !== 200) throw new Error('Auth begin ' + r1.status);
    const d1 = await r1.json();
    const sig = crypto.sign(null, Buffer.from(d1.message, 'utf8'), this.opKey.privateKey);
    const r2 = await this._fetch(this.baseUrl + '/v1/auth/api-key/finish', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: d1.challengeId, signature: b64url(sig) })
    });
    if (r2.status !== 200) throw new Error('Auth finish ' + r2.status);
    const d2 = await r2.json();
    this.apiKey = d2.api_key;
    this.log('✅ Auth OK (' + this.apiKey.substring(0, 8) + '...)');
  }

  // Auth with retry
  async authRetry(maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.auth();
        return true;
      } catch (e) {
        this.log('❌ Auth gagal (' + (i + 1) + '/' + maxRetries + '): ' + e.message);
        if (i < maxRetries - 1) {
          const d = Math.min(5000 * Math.pow(2, i), 60000);
          await sleep(d);
        }
      }
    }
    this.status = 'error';
    return false;
  }

  async ensureAuth() {
    if (this.apiKey) {
      try {
        const c = await this.api('/v1/account/info');
        if (c.status === 200) return true;
      } catch {}
    }
    return await this.authRetry();
  }

  async getBal() {
    const resp = await this.api('/v1/account/info');
    if (resp.status === 429) throw new Error('Rate limited');
    if (resp.status !== 200) throw new Error('Balance ' + resp.status);
    const bals = {};
    for (const t of resp.data.tokens || []) {
      bals[t.instrument_symbol] = {
        unlocked: parseFloat(t.balances.unlocked_amount),
        locked: parseFloat(t.balances.locked_amount)
      };
    }
    this.cc = bals.CC?.unlocked || 0;
    this.cbtc = bals.CBTC?.unlocked || 0;
    this.usdcx = bals.USDCx?.unlocked || 0;
    this.ccL = bals.CC?.locked || 0;
    this.cbtcL = bals.CBTC?.locked || 0;
    this.usdcxL = bals.USDCx?.locked || 0;
    return bals;
  }

  async getQuote(sell, buy, amt) {
    const s = INSTRUMENTS[sell], b = INSTRUMENTS[buy];
    const resp = await this.api('/v2/pools/quote', {
      method: 'POST',
      body: JSON.stringify({
        sellInstrumentId: s.id, sellInstrumentAdmin: s.admin,
        sellAmount: amt.toString(),
        buyInstrumentId: b.id, buyInstrumentAdmin: b.admin
      })
    });
    return resp.status === 200 ? resp.data : null;
  }

  checkFees(quote) {
    if (!quote || !quote.fees) return null;
    const netFee = parseFloat(quote.fees.network_fee?.amount || 0);
    const slip = parseFloat(quote.slippage || 0) * 100;
    const pool = parseFloat(quote.fees.fee_percentage || 0) * 100;
    const ret = parseFloat(quote.returned?.amount || 0);
    const limits = getFeeLimits(this.settings);
    const mN = limits.maxNetworkFee;
    const mS = limits.maxSlippagePercent;
    const mP = limits.maxPoolFeePercent;
    const nOK = netFee <= mN, sOK = slip <= mS, pOK = pool <= mP;
    return { netFee, slip, pool, ret, nOK, sOK, pOK, ok: nOK && sOK && pOK };
  }

  async doSwap(sell, buy, amt) {
    this.status = 'swap';
    this.log('📊 ' + amt + ' ' + sell + '→' + buy);

    const quote = await this.getQuote(sell, buy, amt);
    if (!quote) { this.log('❌ Quote fail'); this.failSwaps++; return false; }

    const fees = this.checkFees(quote);
    if (!fees) { this.log('❌ No fee data'); this.failSwaps++; return false; }
    this.log('Fee: net=' + fees.netFee.toFixed(4) + ' slip=' + fees.slip.toFixed(4) + '% pool=' + fees.pool.toFixed(4) + '%');

    if (!fees.ok) {
      this.log('⚠️ N' + (fees.nOK ? '✅' : '❌') + ' S' + (fees.sOK ? '✅' : '❌') + ' P' + (fees.pOK ? '✅' : '❌'));
      return 'fee';
    }
    this.log('✅ Fees OK → ' + fees.ret.toFixed(6) + ' ' + buy);

    const balBefore = await this.getBal();

    const br = await this.api('/v1/intent/build/pool/swap', {
      method: 'POST',
      body: JSON.stringify({
        sellInstrumentId: INSTRUMENTS[sell].id, sellInstrumentAdmin: INSTRUMENTS[sell].admin,
        sellAmount: amt, buyInstrumentId: INSTRUMENTS[buy].id, buyInstrumentAdmin: INSTRUMENTS[buy].admin
      })
    });
    if (br.status !== 200 || !br.data?.intent?.digest) {
      this.log('❌ Build ' + br.status);
      this.failSwaps++;
      return false;
    }

    const der = signDER(this.intentWallet, br.data.intent.digest);
    const sr = await this.api('/v1/intent/submit', {
      method: 'POST',
      body: JSON.stringify({ id: br.data.id, intentTradingKeySignature: der })
    });
    if (!sr || sr.status !== 200 || sr.data?.verify !== true) {
      this.log('❌ Submit ' + (sr?.status || '?') + ' ' + (sr?.data?.error || ''));
      this.failSwaps++;
      return false;
    }

    const ok = await this.waitExec(sell, buy, balBefore, 90000);
    if (!ok) { this.log('⚠️ Unconfirmed (90s)'); this.failSwaps++; return false; }

    this.totalSwaps++;
    this.dailySwaps++;
    this.okSwaps++;
    if (sell === 'CC') this.swapCC++;
    else if (sell === 'CBTC') this.swapCbtc++;
    else if (sell === 'USDCx') this.swapUsdc++;
    this.log('✅ OK: ' + amt + ' ' + sell + '→' + buy);
    return true;
  }

  async waitExec(sell, buy, before, timeout) {
    const sB = before[sell]?.unlocked || 0;
    const bB = before[buy]?.unlocked || 0;
    const checks = Math.max(3, Math.ceil(timeout / 10000));
    for (let i = 0; i < checks; i++) {
      await sleep(10000);
      try {
        const bal = await this.getBal();
        const sN = bal[sell]?.unlocked || 0;
        const bN = bal[buy]?.unlocked || 0;
        if (sN + 1e-8 < sB || bN > bB + 1e-8) return true;
      } catch {}
    }
    return false;
  }

  // Bulk swap semua token non-CC → CC (1x/hari)
  async bulkBackToken(token, dustThreshold) {
    const field = token === 'USDCx' ? 'usdcx' : token.toLowerCase();
    const decimals = token === 'CBTC' ? 6 : 4;

    if (!await this.ensureAuth()) {
      await sleep(10000);
      return await this.bulkBackToken(token, dustThreshold);
    }
    await this.getBal();

    if ((this[field] || 0) < dustThreshold) {
      this.log('⏸ ' + token + ' = ' + (this[field] || 0).toFixed(decimals) + ' → skip bulk back');
      return true;
    }

    this.log('🔄 Bulk back: ' + (this[field] || 0).toFixed(decimals) + ' ' + token + ' → CC');
    const feeDelay = getFeeRecheckDelayRange(this.settings);
    const fMin = feeDelay.minMs;
    const fMax = feeDelay.maxMs;
    const PERCENTS = [1.0, 0.5, 0.25, 0.10, 0.05];

    while (true) {
      await this.getBal();
      if ((this[field] || 0) < dustThreshold) {
        this.log('✅ Bulk back selesai! ' + token + ' habis. CC=' + this.cc.toFixed(2));
        return true;
      }

      this.log('🔄 ' + token + ' sisa: ' + (this[field] || 0).toFixed(6) + ' — cari persen yang jalan...');
      let swapped = false;
      let restartFromTop = false;

      for (const pct of PERCENTS) {
        const rawAmt = (this[field] || 0) * pct;
        const amtStr = fmtAmt(rawAmt, 10);
        if (parseFloat(amtStr) < dustThreshold) continue;

        const pctLabel = (pct * 100).toFixed(0) + '%';
        this.log('🔄 Coba ' + pctLabel + ': ' + amtStr + ' ' + token);

        let att = 0;
        const maxAtt = 1;

        while (att < maxAtt) {
          att++;
          try {
            if (att > 1) await this.ensureAuth();

            const res = await this.doSwap(token, 'CC', amtStr);
            if (res === true) {
              await sleep(2000);
              await this.getBal();
              this.log('✅ ' + pctLabel + ' swap OK! CC=' + this.cc.toFixed(2) + ' ' + token + '=' + (this[field] || 0).toFixed(6));
              swapped = true;
              break;
            }
            if (res === 'fee') {
              const d = rng(fMin, fMax);
              this.log('⚠️ Fee too high — tunggu ' + (d / 60000).toFixed(1) + ' min lalu coba lagi');
              this.status = 'fee';
              await sleep(d);
              restartFromTop = true;
              break;
            }

            this.log('⚠️ ' + pctLabel + ' att #' + att + ' gagal, coba lagi...');
            await sleep(5000);
          } catch (e) {
            this.log('❌ ' + pctLabel + ' error: ' + e.message);
            await sleep(5000);
          }
        }

        if (swapped || restartFromTop) break;
        this.log('⚠️ ' + pctLabel + ' gagal ' + maxAtt + 'x, turun persen...');
      }

      if (!swapped && !restartFromTop) {
        await this.ensureAuth();
        await sleep(10000);
      }
    }
  }

  async bulkBackCBTC() {
    return await this.bulkBackToken('CBTC', 0.000001);
  }

  async bulkBackUSDCx() {
    return await this.bulkBackToken('USDCx', 0.001);
  }

}

// ─── Dashboard ──────────────────────────────────────────────────────────────
function render(accounts) {
  const now = new Date();
  const nowMs = Date.now();
  const wibStr = now.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });

  const tS = accounts.reduce((a, x) => a + x.totalSwaps, 0);
  const tO = accounts.reduce((a, x) => a + x.okSwaps, 0);
  const tF = accounts.reduce((a, x) => a + x.failSwaps, 0);
  const cooldownC = accounts.filter(a => a.status === 'cooldown').length;
  const gs = config.settings || {};
  const pairInfo = getPairInfo(gs);
  const strategyInfo = getStrategyRuntime(gs);
  const maxSwaps = gs.maxSwaps || 0;
  const targetStr = maxSwaps > 0 ? maxSwaps + '/day' : 'Infinity';

  const modeStr = pairInfo.modeLabel;
  const stMap = { idle: 'IDLE', run: 'RUNNING', swap: 'SWAPPING', auth: 'AUTH', fee: 'FEE-WAIT', done: 'DONE', error: 'ERROR', 'reward-done': 'SCORE-OK', 'bulk-back': 'BULK-BACK', cooldown: 'COOLDOWN' };

  const rows = accounts.map(function(a) {
    let st = stMap[a.status] || a.status;
    if (a.status === 'cooldown' && a.nextDailyCycleAt > nowMs) {
      st = 'CD ' + fmtCountdown(a.nextDailyCycleAt - nowMs);
    }

    const isBoth = pairInfo.pair === 'both';
    const buyBal = isBoth
      ? ('U:' + a.usdcx.toFixed(2) + ' C:' + a.cbtc.toFixed(4))
      : (pairInfo.buyToken === 'CBTC' ? a.cbtc.toFixed(4) : a.usdcx.toFixed(4));
    const swapStr = isBoth
      ? (a.totalSwaps + '(cc' + a.swapCC + '|us' + a.swapUsdc + '|cb' + a.swapCbtc + ')')
      : (a.totalSwaps + '(cc' + a.swapCC + '|' + pairInfo.swapShort + (pairInfo.buyToken === 'CBTC' ? a.swapCbtc : a.swapUsdc) + ')');

    return {
      akun: String(a.name),
      status: String(st),
      cc: a.cc.toFixed(2),
      pairBal: String(buyBal),
      swaps: String(swapStr)
    };
  });

  const wAkun = Math.max('Akun'.length, ...rows.map(r => r.akun.length));
  const wStatus = Math.max('Status'.length, ...rows.map(r => r.status.length));
  const wCC = Math.max('CC'.length, ...rows.map(r => r.cc.length));
  const wPair = Math.max(pairInfo.colLabel.length, ...rows.map(r => r.pairBal.length));
  const wSwaps = Math.max('Swaps'.length, ...rows.map(r => r.swaps.length));

  const headerRow = ' '
    + col('Akun', wAkun)
    + '  ' + col('Status', wStatus)
    + '  ' + col('CC', wCC, 'right')
    + '  ' + col(pairInfo.colLabel, wPair)
    + '  ' + col('Swaps', wSwaps);

  const dividerRow = ' '
    + '-'.repeat(wAkun)
    + '  ' + '-'.repeat(wStatus)
    + '  ' + '-'.repeat(wCC)
    + '  ' + '-'.repeat(wPair)
    + '  ' + '-'.repeat(wSwaps);

  const dataRows = rows.map(function(r) {
    return ' '
      + col(r.akun, wAkun)
      + '  ' + col(r.status, wStatus)
      + '  ' + col(r.cc, wCC, 'right')
      + '  ' + col(r.pairBal, wPair)
      + '  ' + col(r.swaps, wSwaps);
  });

  const titleLine = 'CANTEX AUTO-SWAP BOT v2.1  |  ' + wibStr + ' WIB  |  ' + accounts.length + ' akun  |  Mode: ' + modeStr + '  |  Strat: ' + strategyInfo.key;
  const summaryLine = ' Swaps: ' + tS + ' total  ' + tO + ' ok  ' + tF + ' fail  |  Target: ' + targetStr + '  |  Cooldown: ' + cooldownC + '/' + accounts.length;

  const boxLines = [titleLine, summaryLine, headerRow, dividerRow, ...dataRows];
  const W = Math.max(80, ...boxLines.map(function(x) { return x.length; }));
  const hl = '\u2500'.repeat(W);
  const dl = '\u2550'.repeat(W);

  const out = [];
  out.push('\u2554' + dl + '\u2557');
  out.push('\u2551' + ctr(titleLine, W) + '\u2551');
  out.push('\u2560' + dl + '\u2563');
  out.push('\u2551' + rpad(summaryLine, W) + '\u2551');
  out.push('\u2560' + hl + '\u2563');
  out.push('\u2551' + rpad(headerRow, W) + '\u2551');
  out.push('\u2551' + rpad(dividerRow, W) + '\u2551');
  for (const rowLine of dataRows) {
    out.push('\u2551' + rpad(rowLine, W) + '\u2551');
  }
  out.push('\u255A' + dl + '\u255D');
  out.push('');
  out.push(' --- Execution Logs ---');
  for (const lg of globalLogs) {
    out.push(' ' + lg);
  }
  out.push('');
  const cooldownAccounts = accounts.filter(a => Number(a.nextDailyCycleAt) > nowMs);
  if (maxSwaps <= 0) {
    out.push('  Ctrl+C to stop');
  } else if (!cooldownAccounts.length) {
    out.push('  Ctrl+C to stop  |  Daily cooldown: menunggu akun capai target harian');
  } else {
    const nearestResetAt = Math.min(...cooldownAccounts.map(a => Number(a.nextDailyCycleAt) || 0));
    const remainMs = Math.max(0, nearestResetAt - nowMs);
    out.push('  Ctrl+C to stop  |  Next cycle in: ' + fmtCountdown(remainMs) + '  (' + cooldownAccounts.length + ' akun cooldown)');
  }

  console.clear();
  process.stdout.write(out.join('\n') + '\n');
}

function col(s, w, align = 'left') {
  const v = String(s);
  if (align === 'right') return v.padStart(w);
  return v.padEnd(w);
}
function rpad(s, w) {
  const v = String(s);
  return v.length >= w ? v : v + ' '.repeat(w - v.length);
}
function ctr(s, w) {
  const v = String(s);
  if (v.length >= w) return v;
  const l = Math.floor((w - v.length) / 2);
  return ' '.repeat(l) + v + ' '.repeat(w - v.length - l);
}

// ─── Runner (Dynamic Pair: CC->CBTC or CC->USDCx) ─────────────────────────
async function runAcc(acc, gs) {
  const swapDelay = getSwapDelayRange(gs);
  const feeDelay = getFeeRecheckDelayRange(gs);

  const pairMode = getSwapPair(gs);
  const ccRange = getCcAmountRange(gs);
  const ccReserve = getCcReserve(gs);
  const strategy = getStrategyRuntime(gs);

  const maxSwaps = gs.maxSwaps || 0;
  const st = acc.strategyState || (acc.strategyState = {
    sessionTarget: 0,
    sessionDone: 0,
    lastAmountRatio: null,
    justStarted: true
  });

  if (st.justStarted) {
    acc.log('🧠 Strategy aktif: ' + strategy.key + ' (' + (strategy.description || 'custom') + ')');
    if (pairMode === 'both') {
      acc.log('🧭 AutoPair BOTH aktif: target swap dipilih otomatis berdasarkan saldo.');
    }
    st.justStarted = false;
  }

  while (true) {
    if (maxSwaps > 0 && acc.dailySwaps >= maxSwaps) {
      const nowMs = Date.now();
      if (!acc.nextDailyCycleAt || acc.nextDailyCycleAt <= nowMs) {
        acc.dailyTargetReachedAt = nowMs;
        acc.nextDailyCycleAt = nowMs + DAILY_COOLDOWN_MS;
        acc.log('🎯 Target harian ' + maxSwaps + ' swap tercapai. Cooldown 24 jam dimulai.');
      }

      const waitMs = acc.nextDailyCycleAt - nowMs;
      if (waitMs > 0) {
        acc.status = 'cooldown';
        await sleep(Math.min(waitMs, 15000));
        continue;
      }

      acc.dailySwaps = 0;
      acc.dailyCycle += 1;
      acc.dailyTargetReachedAt = 0;
      acc.nextDailyCycleAt = 0;
      acc.status = 'idle';
      acc.log('🔁 Cooldown selesai. Mulai cycle harian #' + acc.dailyCycle + '.');
    }

    let res;
    let nextDelayMs = 0;
    let delayReason = '';
    try {
      if (!await acc.ensureAuth()) {
        await sleep(10000);
        continue;
      }
      
      await acc.getBal();
      const availableCC = acc.cc - ccReserve;

      if (availableCC < ccRange.min) {
        const bulkToken = await chooseSmartBulkBackToken(acc, gs);
        if (!bulkToken) {
          acc.log('⏸ CC kurang, tapi saldo USDCx/CBTC tidak cukup untuk bulk-back. Tunggu 10s.');
          await sleep(10000);
          continue;
        }

        acc.log('🔄 Sisa ' + acc.cc.toFixed(2) + ' CC tak cukup (butuh ' + ccRange.min.toFixed(2) + '). Bulkback ' + bulkToken + '!');
        acc.status = 'bulk-back';
        const bulkRes = bulkToken === 'CBTC' ? await acc.bulkBackCBTC() : await acc.bulkBackUSDCx();
        acc.status = 'idle';
        if (bulkRes) await sleep(5000);
        continue;
      }

      const buyToken = await chooseSmartBuyToken(acc, gs);
      const livePairInfo = getPairInfoFromPair(buyToken === 'USDCx' ? 'usdc' : 'cbtc');
      if (pairMode === 'both') {
        acc.log('🧭 AutoPair pilih ' + buyToken + ' | USDCx=' + acc.usdcx.toFixed(4) + ' CBTC=' + acc.cbtc.toFixed(6));
      }

      if (!Number.isFinite(st.sessionTarget) || st.sessionTarget < 1 || st.sessionDone >= st.sessionTarget) {
        st.sessionTarget = randInt(strategy.profile.sessionSwapsMin, strategy.profile.sessionSwapsMax);
        st.sessionDone = 0;
        acc.log('🧩 Sesi baru (' + strategy.key + ') target ' + st.sessionTarget + ' swap');
      }

      const thinkPauseMs = pickHumanThinkPauseMs(swapDelay, strategy.profile);
      if (thinkPauseMs > 0) {
        acc.log('🧠 Jeda natural ' + fmtDur(thinkPauseMs) + ' sebelum entry');
        acc.status = 'idle';
        await sleep(thinkPauseMs);
      }

      let swapAmtCC = pickHumanSwapAmountCC(availableCC, ccRange, strategy.profile, st);

      if (swapAmtCC > availableCC) swapAmtCC = availableCC;
      if (swapAmtCC <= 0) {
        acc.log('❌ Amount invalid. Coba ulangi 15s.');
        await sleep(15000);
        continue;
      }
      
      const amtStr = fmtAmt(swapAmtCC, 10);
        acc.log('  ▸ CC→' + livePairInfo.buyToken + ' amt=' + amtStr);
      acc.status = 'swap';
        const ok = await acc.doSwap('CC', livePairInfo.buyToken, amtStr);
      
      if (ok === 'fee') {
         res = 'fee';
      } else if (ok === true) {
        res = 'ok';
        st.sessionDone += 1;

        if (st.sessionDone >= st.sessionTarget) {
          st.sessionDone = 0;
          st.sessionTarget = 0;

          if (Math.random() <= strategy.profile.sessionBreakChance) {
            nextDelayMs = pickHumanSessionBreakMs(swapDelay, strategy.profile);
            delayReason = 'sesi selesai, break panjang';
          } else {
            nextDelayMs = pickHumanDelayMs(swapDelay, strategy.profile);
            delayReason = 'sesi selesai, lanjut normal';
          }
        } else {
          nextDelayMs = pickHumanDelayMs(swapDelay, strategy.profile);
        }
      } else {
        res = 'error';
      }
      
      acc.lastErr = '';
    } catch (e) {
      acc.lastErr = e.message;
      acc.log('❌ ' + e.message);
      acc.status = 'error';
      await sleep(e.message.includes('Rate') ? 30000 : 10000);
      continue;
    }

    if (res === 'ok') {
      if (nextDelayMs <= 0) nextDelayMs = pickHumanDelayMs(swapDelay, strategy.profile);
      acc.log('  ⏳ ' + fmtDur(nextDelayMs) + (delayReason ? ' (' + delayReason + ')' : ''));
      acc.status = 'idle';
      await sleep(nextDelayMs);
      continue;
    }
    if (res === 'fee') {
      const d = rng(feeDelay.minMs, feeDelay.maxMs);
      acc.log('⚠️ Fee too high! Retry in ' + (d / 60000).toFixed(1) + 'm');
      acc.status = 'fee';
      await sleep(d);
      continue;
    }
    if (res === 'error') {
      acc.log('⚠️ Swap error, retry in 15s');
      acc.status = 'error';
      await sleep(15000);
      continue;
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.clear();
  console.log('\n🤖 Cantex Auto-Swap Bot v2.1\n');
  console.log('Multi-account · Dynamic Pinned UI · Loop (CC->Token->BulkBack)\n');

  const gs = deepMerge({}, config.settings || {});
  const pairInfo = getPairInfo(gs);
  const ccRange = getCcAmountRange(gs);
  const ccReserve = getCcReserve(gs);
  const swapDelay = getSwapDelayRange(gs);
  const feeDelay = getFeeRecheckDelayRange(gs);
  const feeLimits = getFeeLimits(gs);
  const strategyInfo = getStrategyRuntime(gs);
  const gProxy = gs.proxy || null;
  const maxSwaps = gs.maxSwaps || 0;
  
  console.log('Swap Configuration:');
  console.log('  swapPair: ' + pairInfo.pair + ' (' + pairInfo.modeLabel + ')');
  console.log('  strategy: ' + strategyInfo.key);
  console.log('  maxSwaps/day: ' + (maxSwaps > 0 ? maxSwaps : 'Infinity'));
  console.log('  amount(CC): ' + ccRange.min + ' - ' + ccRange.max);
  console.log('  ccReserve: ' + ccReserve);
  console.log('  delayAntarSwap: ' + fmtDur(strategyInfo.profile.afterSwapDelayMinMs) + '-' + fmtDur(strategyInfo.profile.afterSwapDelayMaxMs));
  console.log('  baseTiming: ' + swapDelay.min + '-' + swapDelay.max + ' ms (micro-pause internal)');
  console.log('  feeRetry: ' + feeDelay.minMinutes + '-' + feeDelay.maxMinutes + ' min');
  console.log('  feeRules: net<=' + feeLimits.maxNetworkFee + ' slip<=' + feeLimits.maxSlippagePercent + '% pool<=' + feeLimits.maxPoolFeePercent + '%');
  console.log('');

  let acList = accountsData || [];
  if (acList.length === 0) { console.log('❌ No accounts in accounts.json'); process.exit(1); }

  const accounts = [];
  for (let i = 0; i < acList.length; i++) {
    const ac = acList[i];
    const nm = ac.name || 'Acc' + (i + 1);
    const px = ac.proxy || gProxy;
    if (!ac.operatorKey || ac.operatorKey.startsWith('PASTE')) { console.log('❌ [' + nm + '] no operatorKey'); continue; }
    if (!ac.intentTradingKey || ac.intentTradingKey.startsWith('PASTE')) { console.log('❌ [' + nm + '] no intentTradingKey'); continue; }
    try {
      const mergedSettings = deepMerge(gs, ac.settings || {});
      const a = new Account(nm, { operatorKey: ac.operatorKey, intentTradingKey: ac.intentTradingKey },
        mergedSettings, px);
      console.log('✅ [' + nm + '] loaded' + (px ? ' [proxy]' : ''));
      accounts.push(a);
    } catch (e) { console.log('❌ [' + nm + '] ' + e.message); }
  }
  if (!accounts.length) { console.log('\n❌ No valid accounts\n'); process.exit(1); }

  await Promise.all(accounts.map(async function(a) {
    const ok = await a.authRetry(5);
    if (ok) {
      try { await a.getBal(); } catch (e) { a.log('⚠️ getBal: ' + e.message); }
    }
  }));

  // Pinned Dashboard
  const di = setInterval(function() { render(accounts); }, 5000);

  try {
    const runners = accounts.map(function(a, i) {
      return (async function() {
        if (i > 0) await sleep(i * rng(3000, 8000));
        await runAcc(a, a.settings || gs);
      })();
    });
    
    await Promise.all(runners);
  } finally {
  }
}

main().catch(function(e) { console.error('\n❌ Fatal:', e.message); process.exit(1); });
