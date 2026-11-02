import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get as cfg, update, safeEqual, fromEnv, VERSION, EVOLUTION_COMPAT } from './config.js';
import * as storeMod from './store.js';
import * as inst from './instance.js';
import { keepAliveState } from './keepalive.js';
import { hasFfmpeg } from './audio.js';
import { recent } from './log.js';

/*
 * Yalnız flx-wpapi'de olan uçlar (Evolution'da yok): WordPress (Flux Mail) sunucuyu buradan yönetir.
 * Kimlik: genel API key ("apikey" başlığı).
 *   GET  /flxw/server        sürümler, depo, uyanık tutma, bellek
 *   POST /flxw/server        { publicUrl?, keepAlive?, db? }  db önce denenir
 *   POST /flxw/server/db-test { db }   (db/test de olur)
 *   GET  /flxw/logs           son kayıtlar
 */

export const router = express.Router();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const baileysVersion = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/baileys/package.json'), 'utf8')).version;
  } catch {
    return '';
  }
})();

router.use((req, res, next) => {
  const key = String(req.get('apikey') || '');
  if (key && safeEqual(key, cfg().apiKey)) return next();
  res.status(401).json({ status: 401, error: 'Unauthorized', response: { message: ['Unauthorized'] } });
});

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: e.message || String(e) });
  }
};

export async function serverInfo() {
  const c = cfg();
  return {
    ok: true,
    server: 'flx-wpapi',
    version: VERSION,
    compat: EVOLUTION_COMPAT,
    baileys: baileysVersion,
    node: process.version,
    uptime: Math.round(process.uptime()),
    memory: Math.round(process.memoryUsage().rss / 1048576),
    ffmpeg: await hasFfmpeg(),
    publicUrl: c.publicUrl,
    keepAlive: c.keepAlive,
    keepAliveState: keepAliveState(),
    store: storeMod.store().driver,
    storeError: globalThis.flxwStoreError || '',
    lastKeepAlive: keepAliveState().at ? new Date(keepAliveState().at).toISOString() : null,
    // Parola hiç dönmez; passwordSet yalnız girilip girilmediğini söyler.
    db: {
      driver: c.db.driver,
      host: c.db.host,
      port: c.db.port,
      database: c.db.database,
      user: c.db.user,
      prefix: c.db.prefix,
      passwordSet: !!c.db.password,
      ok: storeMod.store().driver === c.db.driver && !globalThis.flxwStoreError,
      error: globalThis.flxwStoreError || '',
    },
    locked: { ...fromEnv },
    instances: inst.list().length,
  };
}

export function dbFrom(b) {
  const cur = cfg().db;
  return {
    driver: b.driver === 'mysql' ? 'mysql' : 'file',
    host: String(b.host || 'localhost').trim(),
    port: Number(b.port) || 3306,
    user: String(b.user || '').trim(),
    // Boş ya da gönderilmemiş parola: kayıtlı olan kalır.
    password: b.password === undefined || b.password === '' || b.password === '••••••' ? cur.password : String(b.password),
    database: String(b.database || '').trim(),
    prefix: String(b.prefix || 'flxw_').replace(/[^a-z0-9_]/gi, '') || 'flxw_',
  };
}

/** Depoyu değiştirir. Oturumlar eski depoda kalır: bağlantılar kapanır, yeniden QR gerekir. */
export async function switchDb(db) {
  if (fromEnv.db) {
    const e = new Error('Veritabanı ortam değişkeniyle verildi; buradan değiştirilemez');
    e.status = 409;
    throw e;
  }
  if (db.driver === 'mysql') {
    const t = await storeMod.test(db);
    if (!t.ok) {
      const e = new Error(t.error);
      e.status = 400;
      throw e;
    }
  }
  await inst.shutdown();
  update({ db });
  await storeMod.open(db);
  globalThis.flxwStoreError = '';
  await inst.boot();
}

export function cleanUrl(u) {
  const v = String(u || '').trim().replace(/\/+$/, '');
  if (v && !/^https?:\/\/[^\s]+$/i.test(v)) {
    const e = new Error('Adres geçersiz');
    e.status = 400;
    throw e;
  }
  return v;
}

router.get('/server', wrap(async (req, res) => res.json(await serverInfo())));

router.post('/server', wrap(async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if ('publicUrl' in b) patch.publicUrl = cleanUrl(b.publicUrl);
  if ('keepAlive' in b) patch.keepAlive = !!b.keepAlive;
  if (Object.keys(patch).length) update(patch);
  if (b.db) await switchDb(dbFrom(b.db));
  res.json(await serverInfo());
}));

router.post(['/server/db/test', '/server/db-test'], wrap(async (req, res) => {
  const db = dbFrom(req.body?.db || req.body || {});
  res.json(db.driver === 'mysql' ? await storeMod.test(db) : { ok: true });
}));

router.get('/logs', (req, res) => res.json({ ok: true, logs: recent(Math.min(300, Number(req.query.n) || 100)) }));
