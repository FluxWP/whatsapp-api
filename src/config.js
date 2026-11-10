import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/*
 * Ayarlar data/config.json'da durur ve panelden değişir.
 * Ortam değişkenleri (FLXW_*) kilitli ayarlar ve ilk kurulum içindir; liste README'de.
 */
export const VERSION = '0.1.2';
// Çağrı Merkezi Evolution sürümüne bakar (2.3 altı @lid uyarısı); taklit ettiğimiz API düzeyi.
export const EVOLUTION_COMPAT = '2.3.0';

export const DATA_DIR = path.resolve(process.env.FLXW_DATA_DIR || path.join(process.cwd(), 'data'));
const FILE = path.join(DATA_DIR, 'config.json');

const defaults = () => ({
  adminHash: '',
  apiKey: '',
  cookieSecret: crypto.randomBytes(32).toString('hex'),
  publicUrl: '',
  keepAlive: true,
  lang: 'tr',
  db: { driver: 'file', host: 'localhost', port: 3306, user: '', password: '', database: '', prefix: 'flxw_' },
  msgKeepDays: 45,
  instances: {},
});

let cfg = null;

export function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    raw = {};
  }
  const d = defaults();
  cfg = { ...d, ...raw, db: { ...d.db, ...(raw.db || {}) }, instances: raw.instances || {} };
  if (!cfg.apiKey) cfg.apiKey = crypto.randomBytes(24).toString('hex');
  // Önceki load()'un kilit bayrakları bu yazmayı etkilemesin.
  fromEnv.apiKey = false;
  fromEnv.db = false;
  fromEnv.adminPassword = false;
  save();
  applyEnv();
  return cfg;
}

/*
 * Kurulumda Hostinger'ın ortam değişkenleri ile verilebilir; böylece ayrı panel açmadan WordPress'ten yönetilir.
 * Ortamdan gelen değerler config.json'a yazılmaz, her açılışta uygulanır.
 */
export const fromEnv = { apiKey: false, db: false, adminPassword: false };
function applyEnv() {
  const e = process.env;
  fromEnv.apiKey = false;
  fromEnv.db = false;
  fromEnv.adminPassword = false;
  if (e.FLXW_API_KEY) {
    cfg.apiKey = e.FLXW_API_KEY;
    fromEnv.apiKey = true;
  }
  if (e.FLXW_ADMIN_PASSWORD) {
    cfg.adminHash = hashPassword(e.FLXW_ADMIN_PASSWORD);
    fromEnv.adminPassword = true;
  }
  if (e.FLXW_DB_NAME) {
    cfg.db = {
      driver: 'mysql',
      host: e.FLXW_DB_HOST || 'localhost',
      port: Number(e.FLXW_DB_PORT) || 3306,
      user: e.FLXW_DB_USER || '',
      password: e.FLXW_DB_PASSWORD || '',
      database: e.FLXW_DB_NAME,
      prefix: e.FLXW_DB_PREFIX || 'flxw_',
    };
    fromEnv.db = true;
  }
  if (e.FLXW_PUBLIC_URL) cfg.publicUrl = e.FLXW_PUBLIC_URL.replace(/\/+$/, '');
  if (e.FLXW_MSG_KEEP_DAYS !== undefined && String(e.FLXW_MSG_KEEP_DAYS).trim() !== '') {
    const d = parseMsgKeepDays(e.FLXW_MSG_KEEP_DAYS);
    if (d) cfg.msgKeepDays = d;
  }
}

/** Saklanan mesaj ömrü (gün). Boş, geçersiz veya 1'den küçük değer yok sayılır; üst sınır 3650. */
export function parseMsgKeepDays(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  const d = Math.floor(n);
  if (d < 1) return null;
  return Math.min(3650, d);
}

export function msgKeepDays() {
  return parseMsgKeepDays(get().msgKeepDays) ?? 45;
}

export function get() {
  return cfg || load();
}

export function save() {
  const out = { ...cfg };
  // Ortamdan gelenler dosyaya yazılmaz.
  if (fromEnv.apiKey) delete out.apiKey;
  if (fromEnv.adminPassword) delete out.adminHash;
  if (fromEnv.db) delete out.db;
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

export function update(patch) {
  Object.assign(get(), patch);
  save();
  return cfg;
}

export function hashPassword(pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pass), salt, 64).toString('hex');
  return `${salt}:${h}`;
}

export function checkPassword(pass, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, h] = stored.split(':');
  const a = Buffer.from(h, 'hex');
  const b = crypto.scryptSync(String(pass), salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  const n = Math.max(x.length, y.length);
  if (n === 0) return false;
  const xb = Buffer.alloc(n);
  const yb = Buffer.alloc(n);
  x.copy(xb);
  y.copy(yb);
  return x.length === y.length && crypto.timingSafeEqual(xb, yb);
}

/*
 * trust proxy varsayılanı kapalıdır. FLXW_TRUST_PROXY: atlama sayısı (1, 2, …),
 * vekil IP/CIDR listesi veya loopback|linklocal|uniquelocal.
 * "true" koşulsuz güvendir; X-Forwarded-For ile giriş sınırı aşılabildiği için yok sayılır.
 */
export function parseTrustProxy(val = process.env.FLXW_TRUST_PROXY) {
  if (val === undefined || val === null) return false;
  const s = String(val).trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  if (lower === 'false' || lower === 'off' || lower === 'no' || lower === '0') return false;
  if (lower === 'true' || lower === 'on' || lower === 'yes') return false;
  if (/^[1-9]\d*$/.test(s)) return Number(s);
  if (lower === 'loopback' || lower === 'linklocal' || lower === 'uniquelocal') return lower;
  if (/^[0-9a-zA-Z.:/,\s]+$/.test(s) && /\d/.test(s)) return s;
  return false;
}

// İlk kurulum jetonu bellekte durur, config.json'a yazılmaz. Parola konunca setupToken() boş döner.
let generatedSetupToken = '';

export function setupToken() {
  if (!cfg || fromEnv.adminPassword || cfg.adminHash) return '';
  const env = String(process.env.FLXW_SETUP_TOKEN || '');
  if (env) return env;
  if (!generatedSetupToken) generatedSetupToken = crypto.randomBytes(24).toString('hex');
  return generatedSetupToken;
}

export function setupTokenFromEnv() {
  return !!(setupToken() && String(process.env.FLXW_SETUP_TOKEN || ''));
}

