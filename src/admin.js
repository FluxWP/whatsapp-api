import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { get as cfg, save, update, hashPassword, checkPassword, safeEqual, fromEnv, setupToken, VERSION } from './config.js';
import * as storeMod from './store.js';
import { serverInfo, dbFrom, switchDb, cleanUrl } from './server-api.js';
import * as inst from './instance.js';
import { lastDelivery, pending } from './webhook.js';
import { recent } from './log.js';
import { checkSafeUrl } from './url-guard.js';

/* Yönetim paneli: /admin. Tüm ayarlar buradan girilir; oturum imzalı çerezle. */

export const router = express.Router();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COOKIE = 'flxw_admin';
const TTL = 7 * 864e5;

function sign(exp) {
  return crypto.createHmac('sha256', cfg().cookieSecret).update(String(exp)).digest('hex');
}

function authed(req) {
  const m = String(req.headers.cookie || '').match(new RegExp(`${COOKIE}=(\\d+)\\.([a-f0-9]+)`));
  return !!(m && Number(m[1]) > Date.now() && safeEqual(m[2], sign(m[1])));
}

function setCookie(req, res) {
  const exp = Date.now() + TTL;
  const secure = req.secure || req.get('x-forwarded-proto') === 'https' ? '; Secure' : '';
  res.set('Set-Cookie', `${COOKIE}=${exp}.${sign(exp)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${TTL / 1000}${secure}`);
}

// Kaba kuvvet koruması: IP başına 10 dakikada 8, toplamda 10 dakikada 30 hatalı deneme; en fazla 1024 IP kaydı.
const FAIL_WINDOW = 600000;
const FAIL_IP_MAX = 8;
const FAIL_GLOBAL_MAX = 30;
const FAIL_MAP_CAP = 1024;
const fails = new Map();
let globalFails = { n: 0, at: 0 };

function pruneFails(now) {
  if (now - globalFails.at > FAIL_WINDOW) globalFails = { n: 0, at: now };
  for (const [k, v] of fails) {
    if (now - v.at > FAIL_WINDOW) fails.delete(k);
  }
}

function failKey(ip) {
  return String(ip || 'unknown');
}

export function limited(ip, now = Date.now()) {
  pruneFails(now);
  if (globalFails.n >= FAIL_GLOBAL_MAX && now - globalFails.at < FAIL_WINDOW) return true;
  const f = fails.get(failKey(ip));
  return !!(f && f.n >= FAIL_IP_MAX && now - f.at < FAIL_WINDOW);
}

export function failed(ip, now = Date.now()) {
  pruneFails(now);
  if (now - globalFails.at > FAIL_WINDOW || globalFails.n === 0) globalFails = { n: 1, at: now };
  else globalFails.n++;
  const key = failKey(ip);
  const f = fails.get(key) || { n: 0, at: now };
  if (now - f.at > FAIL_WINDOW) Object.assign(f, { n: 0, at: now });
  f.n++;
  fails.delete(key);
  fails.set(key, f);
  while (fails.size > FAIL_MAP_CAP) fails.delete(fails.keys().next().value);
}

export function resetLimiter() {
  fails.clear();
  globalFails = { n: 0, at: 0 };
}

export function limiterSize() {
  return fails.size;
}

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: e.message || String(e) });
  }
};

const need = (req, res, next) => (authed(req) ? next() : res.status(401).json({ ok: false, error: 'auth' }));

router.get('/', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(fs.readFileSync(path.join(ROOT, 'public/admin.html'), 'utf8'));
});

router.get('/api/state', wrap(async (req, res) => {
  const c = cfg();
  const base = { ok: true, setup: !c.adminHash && !fromEnv.adminPassword, authed: authed(req), lang: c.lang, version: VERSION };
  if (!base.authed) return res.json(base);
  const info = await serverInfo();
  res.json({
    ...info,
    ...base,
    apiKey: c.apiKey,
    instances: inst.list().map((i) => ({ ...i.info(), token: c.instances[i.name]?.token || '', delivery: lastDelivery(i.name), pending: pending(i.name) })),
  });
}));

router.post('/api/setup', wrap(async (req, res) => {
  if (fromEnv.adminPassword || cfg().adminHash) return res.status(400).json({ ok: false, error: 'already' });
  if (limited(req.ip)) return res.status(429).json({ ok: false, error: 'limit' });
  const given = String(req.body?.setupToken ?? req.get('x-setup-token') ?? '');
  const expected = setupToken();
  if (!expected || !safeEqual(given, expected)) {
    failed(req.ip);
    return res.status(401).json({ ok: false, error: 'token' });
  }
  const p = String(req.body?.password || '');
  if (p.length < 8) return res.status(400).json({ ok: false, error: 'short' });
  fails.delete(failKey(req.ip));
  update({ adminHash: hashPassword(p), lang: req.body?.lang === 'en' ? 'en' : 'tr' });
  setCookie(req, res);
  res.json({ ok: true });
}));

router.post('/api/login', wrap(async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ ok: false, error: 'limit' });
  if (!checkPassword(req.body?.password || '', cfg().adminHash)) {
    failed(req.ip);
    return res.status(401).json({ ok: false, error: 'wrong' });
  }
  fails.delete(failKey(req.ip));
  setCookie(req, res);
  res.json({ ok: true });
}));

router.post('/api/logout', (req, res) => {
  res.set('Set-Cookie', `${COOKIE}=; Path=/admin; Max-Age=0`);
  res.json({ ok: true });
});

router.post('/api/password', need, wrap(async (req, res) => {
  if (fromEnv.adminPassword) return res.status(409).json({ ok: false, error: 'env' });
  if (!checkPassword(req.body?.current || '', cfg().adminHash)) return res.status(400).json({ ok: false, error: 'wrong' });
  const p = String(req.body?.password || '');
  if (p.length < 8) return res.status(400).json({ ok: false, error: 'short' });
  // Gizli anahtar da yenilenir: eski oturumlar düşer.
  update({ adminHash: hashPassword(p), cookieSecret: crypto.randomBytes(32).toString('hex') });
  setCookie(req, res);
  res.json({ ok: true });
}));

router.post('/api/settings', need, wrap(async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if ('publicUrl' in b) patch.publicUrl = cleanUrl(b.publicUrl);
  if ('keepAlive' in b) patch.keepAlive = !!b.keepAlive;
  if ('lang' in b) patch.lang = b.lang === 'en' ? 'en' : 'tr';
  update(patch);
  res.json({ ok: true });
}));

router.post('/api/apikey', need, wrap(async (req, res) => {
  if (fromEnv.apiKey) return res.status(409).json({ ok: false, error: 'env' });
  update({ apiKey: crypto.randomBytes(24).toString('hex') });
  res.json({ ok: true, apiKey: cfg().apiKey });
}));

router.post('/api/db/test', need, wrap(async (req, res) => {
  const db = dbFrom(req.body || {});
  if (db.driver !== 'mysql') return res.json({ ok: true });
  res.json(await storeMod.test(db));
}));

router.post('/api/db', need, wrap(async (req, res) => {
  await switchDb(dbFrom(req.body || {}));
  res.json({ ok: true });
}));

router.post('/api/instances', need, wrap(async (req, res) => {
  const i = inst.create(String(req.body?.name || '').trim());
  res.json({ ok: true, name: i.name });
}));

router.post('/api/instances/:name/connect', need, wrap(async (req, res) => {
  const i = inst.find(req.params.name);
  if (!i) return res.status(404).json({ ok: false, error: 'notfound' });
  if (req.body?.number) {
    await i.stop();
    i.pairingCode = '';
  }
  await i.start({ number: req.body?.number || '' });
  res.json({ ok: true });
}));

router.post('/api/instances/:name/logout', need, wrap(async (req, res) => {
  const i = inst.find(req.params.name);
  if (!i) return res.status(404).json({ ok: false, error: 'notfound' });
  await i.logout();
  res.json({ ok: true });
}));

router.post('/api/instances/:name/token', need, wrap(async (req, res) => {
  const c = cfg().instances[req.params.name];
  if (!c) return res.status(404).json({ ok: false, error: 'notfound' });
  c.token = req.body?.clear ? '' : crypto.randomBytes(20).toString('hex');
  save();
  res.json({ ok: true, token: c.token });
}));

router.post('/api/instances/:name/webhook', need, wrap(async (req, res) => {
  const c = cfg().instances[req.params.name];
  if (!c) return res.status(404).json({ ok: false, error: 'notfound' });
  const url = String(req.body?.url || '').trim();
  if (url) {
    try {
      await checkSafeUrl(url);
    } catch {
      return res.status(400).json({ ok: false, error: 'url' });
    }
  }
  c.webhook = { ...(c.webhook || { events: [], base64: true, byEvents: false }), url, enabled: !!url && req.body?.enabled !== false };
  save();
  res.json({ ok: true });
}));

router.delete('/api/instances/:name', need, wrap(async (req, res) => {
  if (!inst.exists(req.params.name)) return res.status(404).json({ ok: false, error: 'notfound' });
  await inst.remove(req.params.name);
  res.json({ ok: true });
}));

router.get('/api/logs', need, (req, res) => res.json({ ok: true, logs: recent(150) }));
