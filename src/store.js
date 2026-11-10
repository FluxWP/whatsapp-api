import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, msgKeepDays } from './config.js';
import { log } from './log.js';

/*
 * Depolama: oturum anahtarları (kv) ve mesajlar. İki sürücü aynı arayüzü verir:
 *  - mysql: Hostinger'da önerilen; uygulama yeniden kurulsa da oturum kaybolmaz.
 *  - file:  data/ klasörü; yerel deneme ve MySQL yokken.
 * Mesajlar msgKeepDays() gününden eskiyse açılışta ve periyodik temizlikte silinir.
 * auth:* (oturum) ve contacts:* dokunulmaz; medya dosyası ayrıca tutulmaz.
 */

const PURGE_MS = 6 * 60 * 60 * 1000;

class FileStore {
  constructor() {
    this.dir = path.join(DATA_DIR, 'store');
    fs.mkdirSync(path.join(this.dir, 'kv'), { recursive: true });
    fs.mkdirSync(path.join(this.dir, 'msg'), { recursive: true });
    this.msgs = new Map(); // inst -> Map(id -> row)
    this.appends = new Map(); // inst -> satır sayısı (sıkıştırma için)
    this.fileLines = new Map(); // inst -> dosyadaki satır sayısı
  }
  get driver() {
    return 'file';
  }
  async init() {
    const r = await this.purge();
    if (r.deleted) log.info({ deleted: r.deleted, driver: this.driver }, 'eski mesajlar silindi');
  }
  kvFile(ns, key) {
    const safe = (s) => encodeURIComponent(s).replace(/%/g, '_').replace(/\./g, '_2E');
    return path.join(this.dir, 'kv', safe(ns), safe(key) + '.json');
  }
  async kvGet(ns, key) {
    try {
      return fs.readFileSync(this.kvFile(ns, key), 'utf8');
    } catch {
      return null;
    }
  }
  async kvSet(ns, key, val) {
    const f = this.kvFile(ns, key);
    if (val === null || val === undefined) {
      fs.rmSync(f, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, val);
  }
  async kvClear(ns) {
    fs.rmSync(path.dirname(this.kvFile(ns, 'x')), { recursive: true, force: true });
  }
  async kvList(ns) {
    const d = path.dirname(this.kvFile(ns, 'x'));
    try {
      return fs.readdirSync(d).map((f) => fs.readFileSync(path.join(d, f), 'utf8'));
    } catch {
      return [];
    }
  }
  msgFile(inst) {
    return path.join(this.dir, 'msg', encodeURIComponent(inst) + '.jsonl');
  }
  load(inst) {
    if (this.msgs.has(inst)) return this.msgs.get(inst);
    const m = new Map();
    let lines = 0;
    try {
      for (const line of fs.readFileSync(this.msgFile(inst), 'utf8').split('\n')) {
        if (!line) continue;
        lines++;
        try {
          const r = JSON.parse(line);
          m.set(r.id, r);
        } catch {}
      }
    } catch {}
    this.msgs.set(inst, m);
    this.fileLines.set(inst, lines);
    return m;
  }
  async msgPut(inst, row) {
    const m = this.load(inst);
    m.set(row.id, row);
    fs.appendFileSync(this.msgFile(inst), JSON.stringify(row) + '\n');
    this.fileLines.set(inst, (this.fileLines.get(inst) || 0) + 1);
    const n = (this.appends.get(inst) || 0) + 1;
    this.appends.set(inst, n);
    if (n > 2000 && m.size * 2 < n) await this.compact(inst);
  }
  async compact(inst) {
    await this.purgeInst(inst, Date.now() - msgKeepDays() * 864e5);
  }
  // Bellekte yüklü olmayan instance'ı temizledikten sonra bırakır.
  async purgeInst(inst, min) {
    const wasLoaded = this.msgs.has(inst);
    const m = this.load(inst);
    let removed = 0;
    for (const [id, r] of [...m]) {
      if (r.ts < min) {
        m.delete(id);
        removed++;
      }
    }
    const lines = this.fileLines.get(inst) || 0;
    if (removed > 0 || lines !== m.size) {
      const file = this.msgFile(inst);
      const tmp = file + '.tmp';
      const body = [...m.values()].map((r) => JSON.stringify(r)).join('\n');
      fs.writeFileSync(tmp, body ? body + '\n' : '');
      fs.renameSync(tmp, file);
      this.fileLines.set(inst, m.size);
      this.appends.set(inst, m.size);
    }
    if (!wasLoaded) {
      this.msgs.delete(inst);
      this.fileLines.delete(inst);
    }
    return removed;
  }
  async purge(now = Date.now()) {
    const min = now - msgKeepDays() * 864e5;
    let names = [];
    try {
      names = fs.readdirSync(path.join(this.dir, 'msg'));
    } catch {
      return { deleted: 0 };
    }
    let deleted = 0;
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      let inst;
      try {
        inst = decodeURIComponent(name.slice(0, -'.jsonl'.length));
      } catch {
        continue;
      }
      deleted += await this.purgeInst(inst, min);
    }
    return { deleted };
  }
  // İstenen anahtarlar için tek dizin geçişi. Sohbet başına ayrı okuma yok.
  contactMap(ns, keys) {
    const out = new Map();
    if (!keys.length) return out;
    const dir = path.dirname(this.kvFile(ns, 'x'));
    const want = new Map();
    for (const key of keys) want.set(path.basename(this.kvFile(ns, key)), key);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return out;
    }
    for (const name of names) {
      const key = want.get(name);
      if (!key) continue;
      try {
        out.set(key, fs.readFileSync(path.join(dir, name), 'utf8'));
      } catch {}
    }
    return out;
  }
  async msgGet(inst, id) {
    return this.load(inst).get(id) || null;
  }
  async msgFind(inst, jids, limit, page) {
    let rows = [...this.load(inst).values()];
    if (jids && jids.length) rows = rows.filter((r) => jids.includes(r.jid));
    rows.sort((a, b) => b.ts - a.ts);
    return { total: rows.length, records: rows.slice((page - 1) * limit, page * limit) };
  }
  async chats(inst) {
    const by = new Map();
    for (const r of this.load(inst).values()) {
      const c = by.get(r.jid);
      if (!c || c.ts < r.ts) by.set(r.jid, { jid: r.jid, ts: r.ts, push: r.push || (c && c.push) || '' });
    }
    const list = [...by.values()].sort((a, b) => b.ts - a.ts);
    const contacts = this.contactMap(`contacts:${inst}`, list.map((c) => c.jid));
    for (const c of list) c.contact = contacts.get(c.jid) || null;
    return list;
  }
  async dropInstance(inst) {
    this.msgs.delete(inst);
    fs.rmSync(this.msgFile(inst), { force: true });
  }
  async close() {}
}

class MysqlStore {
  constructor(db) {
    this.db = db;
    this.p = (db.prefix || 'flxw_').replace(/[^a-z0-9_]/gi, '');
  }
  get driver() {
    return 'mysql';
  }
  async init() {
    const mysql = (await import('mysql2/promise')).default;
    this.pool = mysql.createPool({
      host: this.db.host,
      port: Number(this.db.port) || 3306,
      user: this.db.user,
      password: this.db.password,
      database: this.db.database,
      charset: 'utf8mb4',
      connectionLimit: 4,
      enableKeepAlive: true,
    });
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.p}kv (
      ns VARCHAR(120) NOT NULL, k VARCHAR(190) NOT NULL, v LONGTEXT NOT NULL,
      PRIMARY KEY (ns, k)) DEFAULT CHARSET=utf8mb4`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.p}msg (
      inst VARCHAR(64) NOT NULL, id VARCHAR(128) NOT NULL, jid VARCHAR(128) NOT NULL,
      from_me TINYINT NOT NULL DEFAULT 0, ts BIGINT NOT NULL, push VARCHAR(190) NOT NULL DEFAULT '',
      data LONGTEXT NOT NULL,
      PRIMARY KEY (inst, id), KEY jt (inst, jid, ts), KEY t (inst, ts)) DEFAULT CHARSET=utf8mb4`);
    const r = await this.purge();
    if (r.deleted) log.info({ deleted: r.deleted, driver: this.driver }, 'eski mesajlar silindi');
  }
  async purge(now = Date.now()) {
    const min = now - msgKeepDays() * 864e5;
    const [r] = await this.pool.query(`DELETE FROM ${this.p}msg WHERE ts < ?`, [min]);
    return { deleted: Number(r?.affectedRows || 0) };
  }
  async kvGet(ns, key) {
    const [r] = await this.pool.query(`SELECT v FROM ${this.p}kv WHERE ns=? AND k=?`, [ns, key]);
    return r.length ? r[0].v : null;
  }
  async kvSet(ns, key, val) {
    if (val === null || val === undefined) {
      await this.pool.query(`DELETE FROM ${this.p}kv WHERE ns=? AND k=?`, [ns, key]);
      return;
    }
    await this.pool.query(`REPLACE INTO ${this.p}kv (ns,k,v) VALUES (?,?,?)`, [ns, key, val]);
  }
  async kvClear(ns) {
    await this.pool.query(`DELETE FROM ${this.p}kv WHERE ns=?`, [ns]);
  }
  async kvList(ns) {
    const [r] = await this.pool.query(`SELECT v FROM ${this.p}kv WHERE ns=?`, [ns]);
    return r.map((x) => x.v);
  }
  async msgPut(inst, row) {
    await this.pool.query(`REPLACE INTO ${this.p}msg (inst,id,jid,from_me,ts,push,data) VALUES (?,?,?,?,?,?,?)`, [
      inst, row.id, row.jid, row.fromMe ? 1 : 0, row.ts, (row.push || '').slice(0, 190), JSON.stringify(row),
    ]);
  }
  async msgGet(inst, id) {
    const [r] = await this.pool.query(`SELECT data FROM ${this.p}msg WHERE inst=? AND id=?`, [inst, id]);
    return r.length ? JSON.parse(r[0].data) : null;
  }
  async msgFind(inst, jids, limit, page) {
    const where = jids && jids.length ? `inst=? AND jid IN (${jids.map(() => '?').join(',')})` : 'inst=?';
    const args = jids && jids.length ? [inst, ...jids] : [inst];
    const [[c]] = await this.pool.query(`SELECT COUNT(*) n FROM ${this.p}msg WHERE ${where}`, args);
    const [r] = await this.pool.query(`SELECT data FROM ${this.p}msg WHERE ${where} ORDER BY ts DESC LIMIT ? OFFSET ?`, [
      ...args, limit, (page - 1) * limit,
    ]);
    return { total: Number(c.n), records: r.map((x) => JSON.parse(x.data)) };
  }
  async chats(inst) {
    const [r] = await this.pool.query(
      `SELECT c.jid, c.ts, c.push, k.v AS contact
       FROM (
         SELECT jid, MAX(ts) ts, MAX(push) push
         FROM ${this.p}msg WHERE inst=? GROUP BY jid ORDER BY ts DESC LIMIT 500
       ) c
       LEFT JOIN ${this.p}kv k ON k.ns=? AND k.k=c.jid
       ORDER BY c.ts DESC`,
      [inst, `contacts:${inst}`],
    );
    return r.map((x) => ({ jid: x.jid, ts: Number(x.ts), push: x.push || '', contact: x.contact || null }));
  }
  async dropInstance(inst) {
    await this.pool.query(`DELETE FROM ${this.p}msg WHERE inst=?`, [inst]);
  }
  async close() {
    if (this.pool) await this.pool.end();
  }
}

let current = null;
let purgeTimer = null;

export async function open(db) {
  const s = db && db.driver === 'mysql' ? new MysqlStore(db) : new FileStore();
  await s.init();
  if (current) await current.close();
  current = s;
  startRetention();
  return s;
}

/** Süresi dolan mesajları siler. Zamanlayıcı unref'lidir; süreç yalnız onun için ayakta kalmaz. */
export function startRetention() {
  if (purgeTimer) clearInterval(purgeTimer);
  const tick = () => {
    const s = current;
    if (!s) return;
    s.purge()
      .then((r) => {
        if (r && r.deleted) log.info({ deleted: r.deleted, driver: s.driver }, 'eski mesajlar silindi');
      })
      .catch((e) => log.warn({ err: e.message }, 'mesaj temizliği başarısız'));
  };
  purgeTimer = setInterval(tick, PURGE_MS);
  purgeTimer.unref?.();
  return purgeTimer;
}

export function stopRetention() {
  if (purgeTimer) clearInterval(purgeTimer);
  purgeTimer = null;
}

/** Bağlantı denemesi: panelde "Test et". */
export async function test(db) {
  const s = new MysqlStore(db);
  try {
    await s.init();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    await s.close().catch(() => {});
  }
}

export function store() {
  return current;
}

export { FileStore, MysqlStore };
