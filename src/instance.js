import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  makeCacheableSignalKeyStore,
  proto,
} from 'baileys';
import QRCode from 'qrcode';
import { get as cfg, save } from './config.js';
import { store } from './store.js';
import { useStoreAuthState } from './auth-state.js';
import { emit, wantsBase64 } from './webhook.js';
import { log, baileysLog } from './log.js';
import { toOgg } from './audio.js';
import { fetchMediaBuffer } from './url-guard.js';

/*
 * Bir instance = bir WhatsApp numarası. Evolution'daki adıyla çağrılır (/message/sendText/{instance}).
 * Bağlantı süreç açık kaldıkça yaşar; kopunca artan beklemeyle yeniden bağlanır.
 */

const MAX_WEBHOOK_MEDIA = 16 * 1024 * 1024;
const instances = new Map();
let waVersion = null;

async function version() {
  if (waVersion) return waVersion;
  try {
    const v = await fetchLatestBaileysVersion();
    waVersion = v.version;
  } catch {
    waVersion = undefined; // Baileys kendi varsayılanını kullanır
  }
  return waVersion;
}

/** Long, Buffer ve protobuf nesnelerini Evolution'ın gönderdiği düz JSON'a çevirir (bytes → base64). */
export function plain(v) {
  return JSON.parse(
    JSON.stringify(v, (k, val) => {
      if (val && val.type === 'Buffer' && Array.isArray(val.data)) return Buffer.from(val.data).toString('base64');
      if (val instanceof Uint8Array) return Buffer.from(val).toString('base64');
      if (val && typeof val === 'object' && typeof val.toNumber === 'function' && 'low' in val && 'high' in val) {
        return val.toNumber();
      }
      return val;
    }),
  );
}

export function revive(obj) {
  return proto.WebMessageInfo.fromObject(obj);
}

function tsMs(t) {
  const n = Number(typeof t === 'object' && t ? t.low ?? t : t) || 0;
  return n > 1e12 ? n : n * 1000;
}

/** "905301234567", "+90 530…", "…@s.whatsapp.net", "…@lid", "…@g.us" → jid */
export function toJid(number) {
  const s = String(number || '').trim();
  if (s.includes('@')) return s;
  const d = s.replace(/\D/g, '');
  return d ? `${d}@s.whatsapp.net` : '';
}

function unwrap(m) {
  let x = m || {};
  for (let i = 0; i < 4; i++) {
    const w = x.ephemeralMessage || x.viewOnceMessage || x.viewOnceMessageV2 || x.viewOnceMessageV2Extension || x.documentWithCaptionMessage;
    if (w && w.message) x = w.message;
    else break;
  }
  return x;
}

const MEDIA = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];

export class Instance {
  constructor(name) {
    this.name = name;
    this.sock = null;
    this.state = 'close';
    this.qr = '';
    this.qrCode = '';
    this.pairingCode = '';
    this.pairNumber = '';
    this.retry = 0;
    this.timer = null;
    this.stopped = false;
    this.sentIds = new Map(); // API'den gönderilenler: yankı SEND_MESSAGE olarak gider
    this.lastError = '';
    this.lastCode = 0;
    this.connectedAt = 0;
    this.profilePic = '';
  }

  get conf() {
    return cfg().instances[this.name] || {};
  }

  get me() {
    return this.sock?.user || null;
  }

  info() {
    return {
      name: this.name,
      state: this.state,
      me: this.me ? { id: this.me.id, name: this.me.name || '', lid: this.me.lid || '' } : null,
      qr: this.state !== 'open' ? this.qr : '',
      pairingCode: this.state !== 'open' ? this.pairingCode : '',
      lastError: this.lastError,
      connectedAt: this.connectedAt,
      webhook: this.conf.webhook || null,
    };
  }

  async start({ number } = {}) {
    this.stopped = false;
    if (number) this.pairNumber = String(number).replace(/\D/g, '');
    if (this.sock && this.state !== 'close') return;
    clearTimeout(this.timer);
    this.state = 'connecting';
    const auth = await useStoreAuthState(this.name);
    this.auth = auth;
    const sock = makeWASocket({
      version: await version(),
      auth: { creds: auth.state.creds, keys: makeCacheableSignalKeyStore(auth.state.keys, baileysLog) },
      logger: baileysLog,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false, // telefona bildirim gelmeye devam etsin
      syncFullHistory: false,
      generateHighQualityLinkPreview: true,
      getMessage: async (key) => {
        const row = await store().msgGet(this.name, key.id);
        return row ? revive(row.data).message : undefined;
      },
    });
    this.sock = sock;
    const ev = sock.ev;

    ev.on('creds.update', auth.saveCreds);

    ev.on('connection.update', async (u) => {
      if (sock !== this.sock) return;
      if (u.qr) {
        this.qrCode = u.qr;
        this.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
        if (this.pairNumber && !this.pairingCode && !sock.authState.creds.registered) {
          try {
            this.pairingCode = await sock.requestPairingCode(this.pairNumber);
          } catch (e) {
            this.lastError = e.message;
          }
        }
        emit(this.name, 'qrcode.updated', { qrcode: { instance: this.name, code: u.qr, base64: this.qr, pairingCode: this.pairingCode } });
      }
      if (u.connection === 'open') {
        this.state = 'open';
        this.qr = '';
        this.pairingCode = '';
        this.pairNumber = '';
        this.retry = 0;
        this.lastError = '';
        this.connectedAt = Date.now();
        log.info({ inst: this.name, me: sock.user?.id }, 'bağlandı');
        sock.profilePictureUrl(sock.user.id, 'image').then((u) => (this.profilePic = u || '')).catch(() => {});
        emit(this.name, 'connection.update', { instance: this.name, state: 'open', statusReason: 200, wuid: sock.user?.id || '' }, sock.user?.id);
      }
      if (u.connection === 'connecting') this.state = 'connecting';
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode || 0;
        this.lastError = u.lastDisconnect?.error?.message || '';
        this.lastCode = code;
        this.sock = null;
        const loggedOut = code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden;
        this.state = 'close';
        emit(this.name, 'connection.update', { instance: this.name, state: 'close', statusReason: code });
        if (loggedOut) {
          log.warn({ inst: this.name, code }, 'oturum kapandı, yeniden QR gerekli');
          await auth.clear();
          this.qr = '';
          return;
        }
        if (this.stopped) return;
        // 440: aynı oturum başka yerde açıldı (ör. Hostinger iki süreç başlattı); hemen saldırırsak birbirini düşürürler.
        const wait = code === DisconnectReason.restartRequired ? 500
          : code === DisconnectReason.connectionReplaced ? 60000 + Math.random() * 30000
          : Math.min(60000, 2000 * 2 ** this.retry++);
        log.info({ inst: this.name, code, wait }, 'bağlantı koptu, yeniden deneniyor');
        this.timer = setTimeout(() => this.start().catch((e) => log.error({ err: e.message }, 'yeniden bağlanamadı')), wait);
      }
    });

    ev.on('messages.upsert', async ({ messages, type }) => {
      for (const m of messages) {
        try {
          await this.onMessage(m, type);
        } catch (e) {
          log.warn({ inst: this.name, err: e.message }, 'mesaj işlenemedi');
        }
      }
    });

    ev.on('messaging-history.set', async ({ messages }) => {
      for (const m of messages || []) await this.saveMessage(m).catch(() => {});
    });

    ev.on('messages.update', (list) => {
      for (const { key, update } of list) {
        if (update.status === undefined || update.status === null) continue;
        const status = typeof update.status === 'number' ? proto.WebMessageInfo.Status[update.status] : String(update.status);
        emit(this.name, 'messages.update', {
          keyId: key.id,
          remoteJid: key.remoteJid,
          fromMe: !!key.fromMe,
          participant: key.participant || undefined,
          status,
          instanceId: this.name,
        });
      }
    });

    ev.on('message-receipt.update', (list) => {
      for (const { key, receipt } of list) {
        if (!receipt?.readTimestamp && !receipt?.receiptTimestamp) continue;
        emit(this.name, 'messages.update', {
          keyId: key.id,
          remoteJid: key.remoteJid,
          fromMe: !!key.fromMe,
          status: receipt.readTimestamp ? 'READ' : 'DELIVERY_ACK',
        });
      }
    });

    ev.on('messages.delete', (d) => {
      if (!('keys' in d)) return;
      for (const k of d.keys) emit(this.name, 'messages.delete', { id: k.id, remoteJid: k.remoteJid, fromMe: !!k.fromMe });
    });

    ev.on('presence.update', (d) => emit(this.name, 'presence.update', plain(d)));

    const contacts = (event) => async (list) => {
      const out = [];
      for (const c of list) {
        const prev = JSON.parse((await store().kvGet(`contacts:${this.name}`, c.id)) || '{}');
        const next = { ...prev, id: c.id };
        if (c.notify) next.pushName = c.notify;
        if (c.name) next.name = c.name;
        if (typeof c.imgUrl === 'string' && /^https?:/.test(c.imgUrl)) next.profilePicUrl = c.imgUrl;
        await store().kvSet(`contacts:${this.name}`, c.id, JSON.stringify(next));
        out.push({ remoteJid: c.id, pushName: next.pushName || next.name || '', profilePicUrl: next.profilePicUrl || null });
      }
      if (out.length) emit(this.name, event, out);
    };
    ev.on('contacts.upsert', contacts('contacts.upsert'));
    ev.on('contacts.update', contacts('contacts.update'));
  }

  /** Mesajı depoya Evolution kaydı biçiminde yazar ve kaydı döner. */
  async saveMessage(m) {
    if (!m?.key?.id || !m.key.remoteJid || m.key.remoteJid === 'status@broadcast') return null;
    const msg = plain(m);
    const inner = unwrap(msg.message);
    const data = {
      key: msg.key,
      pushName: msg.pushName || '',
      status: msg.status ?? (msg.key.fromMe ? 'SERVER_ACK' : 'DELIVERY_ACK'),
      message: msg.message || {},
      messageType: getContentType(inner) || 'unknown',
      messageTimestamp: Math.floor(tsMs(msg.messageTimestamp) / 1000) || Math.floor(Date.now() / 1000),
      instanceId: this.name,
      source: 'flx-wpapi',
    };
    for (const k of ['remoteJidAlt', 'participantAlt']) if (msg.key[k]) data[k] = msg.key[k];
    const row = {
      id: msg.key.id,
      jid: msg.key.remoteJid,
      fromMe: !!msg.key.fromMe,
      ts: data.messageTimestamp * 1000,
      push: data.pushName,
      data,
    };
    await store().msgPut(this.name, row);
    return row;
  }

  async onMessage(m, type) {
    const row = await this.saveMessage(m);
    if (!row) return;
    const data = { ...row.data, message: { ...row.data.message } };
    const inner = unwrap(m.message);
    const mediaKey = MEDIA.find((k) => inner && inner[k]);
    if (mediaKey && wantsBase64(this.name)) {
      const len = Number(inner[mediaKey].fileLength || 0);
      if (!len || len <= MAX_WEBHOOK_MEDIA) {
        try {
          const buf = await downloadMediaMessage(m, 'buffer', {}, { logger: baileysLog, reuploadRequest: this.sock?.updateMediaMessage });
          data.message.base64 = buf.toString('base64');
        } catch (e) {
          log.warn({ inst: this.name, err: e.message }, 'medya indirilemedi');
        }
      }
    }
    const ours = this.sentIds.has(row.id);
    if (ours) this.sentIds.delete(row.id);
    // Geçmiş senkronundan gelen eski mesajlar (append) webhook'a gitmez; findMessages ile alınır.
    if (type === 'append' && !ours && Date.now() - row.ts > 10 * 60 * 1000) return;
    emit(this.name, ours ? 'send.message' : 'messages.upsert', data, this.me?.id);
  }

  /** Depodaki mesajın medyasını indirir (süresi geçtiyse telefondan yeniden yükletir). */
  async download(row) {
    return downloadMediaMessage(revive(row.data), 'buffer', {}, { logger: baileysLog, reuploadRequest: this.sock?.updateMediaMessage });
  }

  need() {
    if (!this.sock || this.state !== 'open') {
      const e = new Error('Instance bağlı değil');
      e.status = 400;
      throw e;
    }
    return this.sock;
  }

  async resolveQuoted(q) {
    if (!q || !q.key?.id) return undefined;
    const row = await store().msgGet(this.name, q.key.id);
    if (row) return revive(row.data);
    return revive({ key: { remoteJid: q.key.remoteJid || '', fromMe: !!q.key.fromMe, id: q.key.id }, message: q.message || { conversation: '' } });
  }

  async send(number, content, { quoted, delay = 0, preview = true } = {}) {
    const sock = this.need();
    const jid = toJid(number);
    if (!jid) {
      const e = new Error('Numara geçersiz');
      e.status = 400;
      throw e;
    }
    if (delay > 0) {
      await sock.sendPresenceUpdate('composing', jid).catch(() => {});
      await new Promise((ok) => setTimeout(ok, Math.min(delay, 20000)));
    }
    const opts = { quoted: await this.resolveQuoted(quoted) };
    if (!preview) opts.getUrlInfo = undefined;
    const sent = await sock.sendMessage(jid, content, opts);
    if (sent?.key?.id) {
      this.sentIds.set(sent.key.id, Date.now());
      if (this.sentIds.size > 500) this.sentIds.delete(this.sentIds.keys().next().value);
      await this.saveMessage(sent).catch(() => {});
    }
    const out = plain(sent);
    out.status = 'PENDING';
    out.messageTimestamp = Math.floor(tsMs(out.messageTimestamp) / 1000);
    out.messageType = getContentType(sent?.message || {}) || '';
    return out;
  }

  async mediaContent({ mediatype, mimetype, media, fileName, caption }) {
    const src = /^https?:\/\//i.test(media || '')
      ? await fetchMediaBuffer(media)
      : Buffer.from(String(media || '').replace(/^data:[^,]*,/, ''), 'base64');
    switch (mediatype) {
      case 'image':
        return { image: src, caption: caption || undefined, mimetype: mimetype || undefined };
      case 'video':
        return { video: src, caption: caption || undefined, mimetype: mimetype || undefined };
      case 'audio':
        return { audio: src, mimetype: mimetype || 'audio/mpeg' };
      default:
        return { document: src, mimetype: mimetype || 'application/octet-stream', fileName: fileName || 'dosya', caption: caption || undefined };
    }
  }

  /** Sesli mesaj: ogg/opus ise doğrudan, değilse (ffmpeg varsa) çevrilir; yoksa ses dosyası olarak gider. */
  async audioContent(audio) {
    let buf = /^https?:\/\//i.test(audio || '')
      ? await fetchMediaBuffer(audio)
      : Buffer.from(String(audio || '').replace(/^data:[^,]*,/, ''), 'base64');
    const isOgg = buf.subarray(0, 4).toString() === 'OggS';
    if (!isOgg) {
      const conv = await toOgg(buf);
      if (conv) buf = conv;
      else return { audio: buf, mimetype: sniffAudio(buf), ptt: false };
    }
    return { audio: buf, mimetype: 'audio/ogg; codecs=opus', ptt: true };
  }

  async logout() {
    this.stopped = true;
    clearTimeout(this.timer);
    try {
      await this.sock?.logout();
    } catch {}
    this.sock?.end?.(undefined);
    this.sock = null;
    this.state = 'close';
    this.qr = '';
    await (this.auth || (await useStoreAuthState(this.name))).clear();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.sock?.end?.(undefined);
    this.sock = null;
    this.state = 'close';
  }
}

function sniffAudio(buf) {
  const h = buf.subarray(0, 12);
  if (h.subarray(0, 3).toString() === 'ID3' || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (h.subarray(4, 8).toString() === 'ftyp') return 'audio/mp4';
  if (h[0] === 0x1a && h[1] === 0x45) return 'audio/webm';
  if (h.subarray(0, 4).toString() === 'RIFF') return 'audio/wav';
  return 'audio/mpeg';
}

/* ---------- Yönetim ---------- */

export function list() {
  return [...instances.values()];
}

export function find(name) {
  return instances.get(name) || null;
}

export function exists(name) {
  return !!cfg().instances[name];
}

export function create(name, extra = {}) {
  const c = cfg();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    const e = new Error('Instance adı yalnız harf, rakam, - ve _ olabilir (en fazla 64)');
    e.status = 400;
    throw e;
  }
  if (!c.instances[name]) {
    c.instances[name] = { createdAt: Date.now(), token: extra.token || '', webhook: null };
    save();
  }
  if (!instances.has(name)) instances.set(name, new Instance(name));
  return instances.get(name);
}

export async function remove(name) {
  const i = instances.get(name);
  if (i) await i.logout().catch(() => {});
  instances.delete(name);
  delete cfg().instances[name];
  save();
  await store().dropInstance(name);
  await store().kvClear(`contacts:${name}`);
}

/** Açılışta kayıtlı oturumu olan instance'ları bağlar. */
export async function boot() {
  for (const name of Object.keys(cfg().instances)) {
    const i = create(name);
    const auth = await useStoreAuthState(name);
    if (await auth.hasCreds()) i.start().catch((e) => log.error({ inst: name, err: e.message }, 'açılışta bağlanamadı'));
  }
}

export async function shutdown() {
  for (const i of instances.values()) await i.stop();
}
