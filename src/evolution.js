import express from 'express';
import { get as cfg, save, safeEqual, EVOLUTION_COMPAT, VERSION } from './config.js';
import { store } from './store.js';
import * as inst from './instance.js';
import { toJid, plain } from './instance.js';
import { EVENTS, hookOf } from './webhook.js';
import { checkSafeUrl } from './url-guard.js';

/*
 * Evolution API v2 uyumlu uçlar: Flux Chat'nin kullandıkları (includes/evolution.php, mirror.php).
 * Kimlik: "apikey" başlığı = genel anahtar ya da o instance'ın kendi token'ı.
 */

export const router = express.Router();
const largeJson = express.json({ limit: '80mb' });

const fail = (res, status, message) =>
  res.status(status).json({ status, error: status === 404 ? 'Not Found' : status === 401 ? 'Unauthorized' : 'Bad Request', response: { message: [message] } });

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    fail(res, e.status || 400, e.message || String(e));
  }
};

router.get('/', (req, res) => {
  res.json({
    status: 200,
    message: 'Welcome to the Evolution API compatible flx-wpapi',
    version: EVOLUTION_COMPAT,
    clientName: 'flx-wpapi',
    flxwpapi: VERSION,
  });
});

function auth(req, res, next) {
  const key = String(req.get('apikey') || '');
  const name = req.params.instance;
  if (key && safeEqual(key, cfg().apiKey)) {
    req.global = true;
    return next();
  }
  const t = name ? cfg().instances[name]?.token : '';
  if (key && t && safeEqual(key, t)) return next();
  return fail(res, 401, 'Unauthorized');
}

function instanceOf(req, { create = false } = {}) {
  const name = req.params.instance;
  if (!inst.exists(name)) {
    if (create && req.global) return inst.create(name);
    const e = new Error(`The "${name}" instance does not exist`);
    e.status = 404;
    throw e;
  }
  return inst.find(name) || inst.create(name);
}

/* ---------- Instance ---------- */

router.post('/instance/create', auth, wrap(async (req, res) => {
  if (!req.global) return fail(res, 401, 'Unauthorized');
  const b = req.body || {};
  const name = String(b.instanceName || '').trim();
  if (inst.exists(name)) return fail(res, 403, `This name "${name}" is already in use.`);
  if (b.webhook?.url) {
    try {
      await checkSafeUrl(b.webhook.url);
    } catch {
      return fail(res, 400, 'Invalid url');
    }
  }
  const i = inst.create(name, { token: b.token || '' });
  if (b.webhook?.url) setHook(i.name, b.webhook);
  if (b.qrcode) {
    await i.start({ number: b.number });
    await waitQr(i);
  }
  res.status(201).json({
    instance: { instanceName: i.name, instanceId: i.name, integration: 'WHATSAPP-BAILEYS', status: i.state },
    hash: cfg().instances[i.name].token || cfg().apiKey,
    webhook: hookJson(i.name),
    qrcode: b.qrcode ? { pairingCode: i.pairingCode || null, code: i.qrCode || '', base64: i.qr || '', count: 1 } : undefined,
  });
}));

// Evolution v2 fetchInstances biçimi; ?instanceName= ile tek kayıt.
router.get('/instance/fetchInstances', auth, wrap(async (req, res) => {
  const only = String(req.query.instanceName || req.query.instanceId || '');
  let list = inst.list();
  if (!req.global) list = list.filter((i) => i.name === only && cfg().instances[i.name]?.token && safeEqual(req.get('apikey') || '', cfg().instances[i.name].token));
  else if (only) list = list.filter((i) => i.name === only);
  res.json(
    list.map((i) => {
      const c = cfg().instances[i.name] || {};
      const own = i.me?.id ? String(i.me.id).replace(/:\d+@/, '@') : null;
      return {
        id: i.name,
        name: i.name,
        connectionStatus: i.state,
        ownerJid: own,
        number: own ? own.split('@')[0] : null,
        profileName: i.me?.name || null,
        profilePicUrl: i.profilePic || null,
        integration: 'WHATSAPP-BAILEYS',
        token: c.token || null,
        createdAt: c.createdAt ? new Date(c.createdAt).toISOString() : null,
        updatedAt: i.connectedAt ? new Date(i.connectedAt).toISOString() : null,
        disconnectionReasonCode: i.state === 'close' ? i.lastCode || null : null,
        disconnectionObject: i.state === 'close' && i.lastError ? i.lastError : null,
      };
    }),
  );
}));

async function waitQr(i) {
  for (let n = 0; n < 40 && !i.qr && !i.pairingCode && i.state !== 'open'; n++) await new Promise((ok) => setTimeout(ok, 250));
  if (i.pairNumber) for (let n = 0; n < 20 && !i.pairingCode && i.state !== 'open'; n++) await new Promise((ok) => setTimeout(ok, 250));
}

router.get('/instance/connect/:instance', auth, wrap(async (req, res) => {
  const i = instanceOf(req, { create: true });
  if (i.state === 'open') return res.json({ instance: { instanceName: i.name, state: 'open' } });
  if (req.query.number && i.pairNumber !== String(req.query.number).replace(/\D/g, '')) {
    await i.stop(); // numarayla kod: yeni soket
    i.pairingCode = '';
  }
  await i.start({ number: req.query.number });
  await waitQr(i); // ilk QR birkaç saniyede gelir
  if (i.state === 'open') return res.json({ instance: { instanceName: i.name, state: 'open' } });
  res.json({ pairingCode: i.pairingCode || null, code: i.qrCode || '', base64: i.qr || '', count: 1 });
}));

router.get('/instance/connectionState/:instance', auth, wrap(async (req, res) => {
  const i = instanceOf(req);
  res.json({ instance: { instanceName: i.name, state: i.state } });
}));

router.put('/instance/restart/:instance', auth, wrap(async (req, res) => {
  const i = instanceOf(req);
  await i.stop();
  await i.start();
  res.json({ instance: { instanceName: i.name, state: i.state } });
}));
router.post('/instance/restart/:instance', auth, wrap(async (req, res) => {
  const i = instanceOf(req);
  await i.stop();
  await i.start();
  res.json({ instance: { instanceName: i.name, state: i.state } });
}));

router.delete('/instance/logout/:instance', auth, wrap(async (req, res) => {
  await instanceOf(req).logout();
  res.json({ status: 'SUCCESS', error: false, response: { message: 'Instance logged out' } });
}));

router.delete('/instance/delete/:instance', auth, wrap(async (req, res) => {
  if (!req.global) return fail(res, 401, 'Unauthorized');
  instanceOf(req);
  await inst.remove(req.params.instance);
  res.json({ status: 'SUCCESS', error: false, response: { message: 'Instance deleted' } });
}));

/* ---------- Webhook ---------- */

function setHook(name, w) {
  cfg().instances[name].webhook = {
    enabled: w.enabled !== false,
    url: String(w.url || ''),
    events: Array.isArray(w.events) ? w.events.filter((e) => EVENTS.includes(e)) : [],
    base64: w.webhookBase64 !== false && w.base64 !== false,
    byEvents: !!(w.webhookByEvents || w.byEvents),
  };
  save();
}

router.post('/webhook/set/:instance', auth, wrap(async (req, res) => {
  const i = instanceOf(req);
  const w = req.body?.webhook || req.body || {};
  if (w.url) {
    try {
      await checkSafeUrl(w.url);
    } catch {
      return fail(res, 400, 'Invalid url');
    }
  }
  setHook(i.name, w);
  res.json(hookJson(i.name));
}));

function hookJson(name) {
  const h = hookOf(name);
  return { enabled: !!h.enabled, url: h.url, events: h.events || [], webhookBase64: h.base64 !== false, webhookByEvents: !!h.byEvents };
}

router.get('/webhook/find/:instance', auth, wrap(async (req, res) => {
  res.json(hookJson(instanceOf(req).name));
}));

/* ---------- Mesaj gönderme ---------- */

router.post('/message/sendText/:instance', auth, wrap(async (req, res) => {
  const b = req.body || {};
  const i = instanceOf(req);
  const content = { text: String(b.text ?? '') };
  if (Array.isArray(b.mentioned) && b.mentioned.length) content.mentions = b.mentioned.map(toJid).filter(Boolean);
  const out = await i.send(b.number, content, { quoted: b.quoted, delay: Number(b.delay) || 0, preview: b.linkPreview !== false });
  res.status(201).json(out);
}));

router.post('/message/sendMedia/:instance', auth, largeJson, wrap(async (req, res) => {
  const b = req.body || {};
  const i = instanceOf(req);
  const out = await i.send(b.number, await i.mediaContent(b), { quoted: b.quoted, delay: Number(b.delay) || 0 });
  res.status(201).json(out);
}));

router.post('/message/sendWhatsAppAudio/:instance', auth, largeJson, wrap(async (req, res) => {
  const b = req.body || {};
  const i = instanceOf(req);
  const out = await i.send(b.number, await i.audioContent(b.audio), { quoted: b.quoted, delay: Number(b.delay) || 0 });
  res.status(201).json(out);
}));

router.post('/message/sendReaction/:instance', auth, wrap(async (req, res) => {
  const b = req.body || {};
  const i = instanceOf(req);
  if (!b.key?.id || !b.key?.remoteJid) return fail(res, 400, 'key.remoteJid and key.id required');
  const out = await i.send(b.key.remoteJid, { react: { text: String(b.reaction ?? ''), key: b.key } });
  res.status(201).json(out);
}));

/* ---------- Sohbet ---------- */

router.post('/chat/markMessageAsRead/:instance', auth, wrap(async (req, res) => {
  const i = instanceOf(req);
  const keys = (req.body?.readMessages || []).filter((k) => k?.id && k?.remoteJid);
  if (keys.length) await i.need().readMessages(keys);
  res.status(201).json({ message: 'Read messages', read: 'success' });
}));

router.post('/chat/sendPresence/:instance', auth, wrap(async (req, res) => {
  const b = req.body || {};
  const sock = instanceOf(req).need();
  const jid = toJid(b.number);
  const presence = ['composing', 'recording', 'paused', 'available', 'unavailable'].includes(b.presence) ? b.presence : 'composing';
  await sock.sendPresenceUpdate(presence, jid);
  const delay = Math.min(Number(b.delay) || 0, 60000);
  if (delay > 0 && presence !== 'paused') {
    await new Promise((ok) => setTimeout(ok, delay));
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
  }
  res.status(201).json({ presence });
}));

router.post('/chat/fetchProfilePictureUrl/:instance', auth, wrap(async (req, res) => {
  const sock = instanceOf(req).need();
  const jid = toJid(req.body?.number);
  let url = null;
  try {
    url = await sock.profilePictureUrl(jid, 'image');
  } catch {}
  res.json({ wuid: jid, profilePictureUrl: url || null });
}));

router.post('/chat/whatsappNumbers/:instance', auth, wrap(async (req, res) => {
  const sock = instanceOf(req).need();
  const nums = (req.body?.numbers || []).map(String);
  const found = nums.length ? (await sock.onWhatsApp(...nums.map((n) => toJid(n)))) || [] : [];
  const digits = (s) => String(s).split('@')[0].replace(/\D/g, '');
  res.json(
    nums.map((n) => {
      const f = found.find((x) => digits(x.jid) === digits(n) || (x.lid && digits(x.lid) === digits(n)));
      return { exists: !!f?.exists, jid: f?.jid || toJid(n), number: n, lid: f?.lid || undefined };
    }),
  );
}));

router.post('/chat/getBase64FromMediaMessage/:instance', auth, wrap(async (req, res) => {
  const i = instanceOf(req);
  const id = req.body?.message?.key?.id;
  const row = id ? await store().msgGet(i.name, id) : null;
  if (!row) return fail(res, 400, 'Message not found');
  const buf = await i.download(row);
  const m = row.data.message || {};
  const inner = m.documentWithCaptionMessage?.message || m.viewOnceMessageV2?.message || m.viewOnceMessage?.message || m.ephemeralMessage?.message || m;
  const media = inner.imageMessage || inner.videoMessage || inner.audioMessage || inner.documentMessage || inner.stickerMessage || {};
  res.status(201).json({
    mediaType: row.data.messageType,
    fileName: media.fileName || '',
    size: { fileLength: buf.length },
    mimetype: media.mimetype || 'application/octet-stream',
    base64: buf.toString('base64'),
  });
}));

router.post('/chat/findChats/:instance', auth, wrap(async (req, res) => {
  const i = instanceOf(req);
  // chats() kişileri MySQL'de tek sorguda, dosyada tek dizin geçişinde getirir.
  const chats = await store().chats(i.name);
  const out = [];
  for (const c of chats) {
    const ct = JSON.parse(c.contact || '{}');
    out.push({
      id: c.jid,
      remoteJid: c.jid,
      pushName: ct.name || ct.pushName || c.push || null,
      profilePicUrl: ct.profilePicUrl || null,
      updatedAt: new Date(c.ts).toISOString(),
      instanceId: i.name,
    });
  }
  res.json(out);
}));

router.post('/chat/findMessages/:instance', auth, wrap(async (req, res) => {
  const i = instanceOf(req);
  const b = req.body || {};
  const jid = b.where?.key?.remoteJid;
  const limit = Math.max(1, Math.min(500, Number(b.offset) || 50));
  const page = Math.max(1, Number(b.page) || 1);
  const r = await store().msgFind(i.name, jid ? [jid] : null, limit, page);
  res.json({
    messages: { total: r.total, pages: Math.ceil(r.total / limit), currentPage: page, records: r.records.map((x) => x.data) },
  });
}));

router.post('/chat/updateMessage/:instance', auth, wrap(async (req, res) => {
  const b = req.body || {};
  const i = instanceOf(req);
  if (!b.key?.id) return fail(res, 400, 'key.id required');
  const jid = b.key.remoteJid || toJid(b.number);
  const key = { remoteJid: jid, fromMe: b.key.fromMe !== false, id: b.key.id };
  const out = await i.send(jid, { text: String(b.text ?? ''), edit: key });
  res.status(201).json(out);
}));

/* ---------- Grup ---------- */

router.get('/group/fetchAllGroups/:instance', auth, wrap(async (req, res) => {
  const sock = instanceOf(req).need();
  const all = await sock.groupFetchAllParticipating();
  const withP = String(req.query.getParticipants) === 'true';
  res.json(
    Object.values(all).map((g) => ({
      id: g.id,
      subject: g.subject,
      subjectOwner: g.subjectOwner || null,
      size: g.size || g.participants?.length || 0,
      creation: g.creation || null,
      desc: g.desc || null,
      announce: !!g.announce,
      restrict: !!g.restrict,
      ...(withP ? { participants: plain(g.participants || []) } : {}),
    })),
  );
}));
