import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Gerçek WhatsApp'a bağlanmadan: sahte soketle Evolution uçlarını ve webhook biçimini dener.
process.env.FLXW_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flxw-'));
process.env.FLXW_ALLOW_PRIVATE_URLS = '1';
delete process.env.FLXW_TRUST_PROXY;
delete process.env.FLXW_SETUP_TOKEN;
delete process.env.FLXW_ADMIN_PASSWORD;
delete process.env.FLXW_MSG_KEEP_DAYS;
const { load, get: cfg, update, parseTrustProxy, setupToken } = await import('../src/config.js');
const { open, store, stopRetention } = await import('../src/store.js');
const inst = await import('../src/instance.js');
const { router } = await import('../src/evolution.js');
const { router: serverApi } = await import('../src/server-api.js');
const { router: adminRouter, limited, failed, resetLimiter, limiterSize } = await import('../src/admin.js');
const { isPrivateIp, isAlwaysBlockedIp, checkSafeUrl, safeRequest, fetchMediaBuffer } = await import('../src/url-guard.js');
const express = (await import('express')).default;
const Long = (await import('long')).default;

let server, base, hookServer, hooks = [];
const KEY = () => cfg().apiKey;
const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', apikey: KEY() }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
};

let sent = [];
function fakeSock() {
  let n = 0;
  return {
    user: { id: '905300000000:1@s.whatsapp.net', name: 'Test' },
    async sendMessage(jid, content, opts) {
      sent.push({ jid, content, opts });
      return { key: { remoteJid: jid, fromMe: true, id: 'OUT' + ++n }, message: content.text ? { conversation: content.text } : { reactionMessage: { text: content.react?.text } }, messageTimestamp: Long.fromNumber(1790000000) };
    },
    async sendPresenceUpdate() {},
    async readMessages(keys) { sent.push({ read: keys }); },
    async onWhatsApp(...jids) { return jids.filter((j) => j.startsWith('90')).map((j) => ({ jid: j, exists: true })); },
    async profilePictureUrl() { return 'https://pps.whatsapp.net/x.jpg'; },
    async groupFetchAllParticipating() { return { 'g1@g.us': { id: 'g1@g.us', subject: 'Ekip', participants: [] } }; },
  };
}

before(async () => {
  load();
  await open({ driver: 'file' });
  hookServer = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { hooks.push({ url: req.url, body: JSON.parse(b) }); res.end('{}'); }); }).listen(0);
  const app = express();
  app.set('trust proxy', parseTrustProxy());
  const smallJson = express.json({ limit: '1mb' });
  app.use((req, res, next) => {
    if (/^\/message\/(sendMedia|sendWhatsAppAudio)\//.test(req.path)) return next();
    return smallJson(req, res, next);
  });
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/admin', adminRouter);
  app.use('/flxw', serverApi);
  app.use('/', router);
  server = app.listen(0);
  base = 'http://127.0.0.1:' + server.address().port;
  const i = inst.create('flx');
  i.sock = fakeSock();
  i.state = 'open';
});
after(() => { stopRetention(); server.close(); hookServer.close(); });

test('kök sürüm 2.3+', async () => {
  const r = await call('GET', '/');
  assert.equal(r.json.version, '2.3.0');
});

test('yanlış anahtar 401, olmayan instance 404', async () => {
  const r = await fetch(base + '/instance/connectionState/flx', { headers: { apikey: 'x' } });
  assert.equal(r.status, 401);
  assert.equal((await call('GET', '/instance/connectionState/yok')).status, 404);
  assert.equal((await call('GET', '/instance/connectionState/flx')).json.instance.state, 'open');
});

test('webhook set/find', async () => {
  const url = 'http://127.0.0.1:' + hookServer.address().port + '/wp-json/flx-chat/v1/webhook/c1?t=s';
  const r = await call('POST', '/webhook/set/flx', { webhook: { enabled: true, url, webhookByEvents: false, webhookBase64: true, events: ['MESSAGES_UPSERT', 'SEND_MESSAGE', 'MESSAGES_UPDATE'] } });
  assert.equal(r.status, 200);
  const f = await call('GET', '/webhook/find/flx');
  assert.equal(f.json.url, url);
  assert.equal(f.json.enabled, true);
});

test('sendText key.id döner, alıntı ve mention çevrilir', async () => {
  await inst.find('flx').saveMessage({ key: { remoteJid: '905551112233@s.whatsapp.net', fromMe: false, id: 'IN1' }, message: { conversation: 'merhaba' }, messageTimestamp: 1790000000, pushName: 'Ali' });
  const r = await call('POST', '/message/sendText/flx', { number: '905551112233', text: 'selam', quoted: { key: { id: 'IN1' }, message: { conversation: 'merhaba' } }, mentioned: ['905551112233'], linkPreview: false });
  assert.equal(r.status, 201);
  assert.match(r.json.key.id, /^OUT/);
  const s = sent.at(-1);
  assert.equal(s.jid, '905551112233@s.whatsapp.net');
  assert.deepEqual(s.content.mentions, ['905551112233@s.whatsapp.net']);
  assert.equal(s.opts.quoted.key.id, 'IN1');
  assert.ok('getUrlInfo' in s.opts && s.opts.getUrlInfo === undefined);
});

test('gelen mesaj Evolution biçiminde webhook olur', async () => {
  hooks = [];
  const i = inst.find('flx');
  await i.onMessage({ key: { remoteJid: '123@lid', remoteJidAlt: '905551112233@s.whatsapp.net', fromMe: false, id: 'IN2' }, message: { extendedTextMessage: { text: 'bağış', contextInfo: { stanzaId: 'OUT1' } } }, messageTimestamp: Long.fromNumber(1790000100), pushName: 'Ali' }, 'notify');
  await new Promise((ok) => setTimeout(ok, 300));
  const h = hooks.at(-1);
  assert.equal(h.body.event, 'messages.upsert');
  assert.equal(h.body.instance, 'flx');
  assert.equal(h.body.data.key.remoteJidAlt, '905551112233@s.whatsapp.net');
  assert.equal(h.body.data.message.extendedTextMessage.contextInfo.stanzaId, 'OUT1');
  assert.equal(h.body.data.messageTimestamp, 1790000100);
  assert.equal(h.body.data.pushName, 'Ali');
});

test('kendi gönderdiğimizin yankısı send.message', async () => {
  hooks = [];
  const i = inst.find('flx');
  const out = await i.send('905551112233', { text: 'yankı' });
  await i.onMessage({ key: out.key, message: { conversation: 'yankı' }, messageTimestamp: 1790000200 }, 'append');
  await new Promise((ok) => setTimeout(ok, 300));
  assert.equal(hooks.at(-1).body.event, 'send.message');
});

test('findMessages / findChats', async () => {
  const s = store();
  await s.kvSet('contacts:flx', '905551112233@s.whatsapp.net', JSON.stringify({ name: 'Ali', pushName: 'AliPush', profilePicUrl: 'https://pps.example/a.jpg' }));
  await inst.find('flx').saveMessage({ key: { remoteJid: '905559990000@s.whatsapp.net', fromMe: false, id: 'IN9' }, message: { conversation: 'yeni' }, messageTimestamp: 1790000300, pushName: 'Veli' });
  const r = await call('POST', '/chat/findMessages/flx', { where: { key: { remoteJid: '905551112233@s.whatsapp.net' } }, page: 1, offset: 10 });
  assert.ok(r.json.messages.records.length >= 2);
  assert.ok(r.json.messages.records[0].key.id);
  let gets = 0;
  const orig = s.kvGet.bind(s);
  s.kvGet = async (...args) => {
    gets++;
    return orig(...args);
  };
  try {
    const c = await call('POST', '/chat/findChats/flx', {});
    assert.equal(gets, 0);
    const keys = ['id', 'remoteJid', 'pushName', 'profilePicUrl', 'updatedAt', 'instanceId'];
    const ali = c.json.find((x) => x.remoteJid === '905551112233@s.whatsapp.net');
    const veli = c.json.find((x) => x.remoteJid === '905559990000@s.whatsapp.net');
    assert.deepEqual(Object.keys(ali), keys);
    assert.deepEqual(Object.keys(veli), keys);
    assert.equal(ali.id, ali.remoteJid);
    assert.equal(ali.pushName, 'Ali');
    assert.equal(ali.profilePicUrl, 'https://pps.example/a.jpg');
    assert.equal(ali.instanceId, 'flx');
    assert.equal(veli.pushName, 'Veli');
    assert.equal(veli.profilePicUrl, null);
    assert.ok(c.json.indexOf(veli) < c.json.indexOf(ali));
    const row = (await s.chats('flx')).find((x) => x.jid === ali.remoteJid);
    assert.equal(ali.updatedAt, new Date(row.ts).toISOString());
  } finally {
    s.kvGet = orig;
  }
});

test('whatsappNumbers, profil, grup, okundu, tepki, düzenleme', async () => {
  const w = await call('POST', '/chat/whatsappNumbers/flx', { numbers: ['905551112233', '15550001'] });
  assert.deepEqual(w.json.map((x) => x.exists), [true, false]);
  assert.equal((await call('POST', '/chat/fetchProfilePictureUrl/flx', { number: '905551112233' })).json.profilePictureUrl, 'https://pps.whatsapp.net/x.jpg');
  const g = await call('GET', '/group/fetchAllGroups/flx?getParticipants=false');
  assert.equal(g.json[0].subject, 'Ekip');
  assert.equal((await call('POST', '/chat/markMessageAsRead/flx', { readMessages: [{ remoteJid: 'a@s.whatsapp.net', fromMe: false, id: 'IN1' }] })).status, 201);
  assert.equal((await call('POST', '/message/sendReaction/flx', { key: { remoteJid: 'a@s.whatsapp.net', fromMe: false, id: 'IN1' }, reaction: '👍' })).status, 201);
  const e = await call('POST', '/chat/updateMessage/flx', { number: 'g1@g.us', key: { remoteJid: 'g1@g.us', fromMe: true, id: 'OUT1' }, text: 'yeni' });
  assert.equal(e.status, 201);
  assert.equal(sent.at(-1).content.edit.id, 'OUT1');
});

test('durum güncellemesi Evolution adıyla', async () => {
  const { proto } = await import('baileys');
  assert.equal(proto.WebMessageInfo.Status[3], 'DELIVERY_ACK');
});

test('WordPress hesap yönetimi: create, fetchInstances, delete', async () => {
  const c = await call('POST', '/instance/create', { instanceName: 'ikinci', integration: 'WHATSAPP-BAILEYS', qrcode: false });
  assert.equal(c.status, 201);
  assert.equal(c.json.instance.instanceName, 'ikinci');
  assert.equal((await call('POST', '/instance/create', { instanceName: 'ikinci' })).status, 403);
  const f = await call('GET', '/instance/fetchInstances');
  const flx = f.json.find((x) => x.name === 'flx');
  assert.equal(flx.connectionStatus, 'open');
  assert.equal(flx.ownerJid, '905300000000@s.whatsapp.net');
  assert.equal(flx.number, '905300000000');
  assert.equal((await call('GET', '/instance/fetchInstances?instanceName=ikinci')).json.length, 1);
  assert.equal((await call('DELETE', '/instance/delete/ikinci')).status, 200);
  assert.equal((await call('GET', '/instance/connectionState/ikinci')).status, 404);
});

test('/flxw/server sunucu bilgisi ve ayar', async () => {
  const r = await call('GET', '/flxw/server');
  assert.equal(r.json.server, 'flx-wpapi');
  assert.equal(r.json.store, 'file');
  assert.equal(r.json.db.ok, true);
  assert.ok(!('password' in r.json.db));
  assert.equal((await call('POST', '/flxw/server/db-test', { db: { driver: 'file' } })).json.ok, true);
  const u = await call('POST', '/flxw/server', { publicUrl: 'https://wa.example.org/', keepAlive: false });
  assert.equal(u.json.publicUrl, 'https://wa.example.org');
  assert.equal(u.json.keepAlive, false);
  assert.equal((await call('POST', '/flxw/server', { publicUrl: 'ftp:/x' })).status, 400);
  const bad = await fetch(base + '/flxw/server', { headers: { apikey: 'x' } });
  assert.equal(bad.status, 401);
});

test('güvenlik: /health yalnız ok döner, istek başlığı publicUrl yazmaz', async () => {
  update({ publicUrl: '' });
  const h = await fetch(base + '/health', { headers: { 'X-Forwarded-Host': 'evil.example.com', Host: 'evil.example.com' } });
  const hj = await h.json();
  assert.deepEqual(hj, { ok: true });
  assert.equal(Object.keys(hj).join(','), 'ok');
  assert.equal(cfg().publicUrl, '');
  await fetch(base + '/instance/connectionState/flx', { headers: { apikey: 'wrong', 'X-Forwarded-Host': 'evil.example.com' } });
  assert.equal(cfg().publicUrl, '');
  await fetch(base + '/instance/connectionState/flx', { headers: { apikey: KEY(), 'X-Forwarded-Host': 'wa.example.org', 'X-Forwarded-Proto': 'https' } });
  assert.equal(cfg().publicUrl, '');
  await fetch(base + '/admin/api/state', { headers: { 'X-Forwarded-Host': 'evil.example.com' } });
  assert.equal(cfg().publicUrl, '');
  // Yapılandırılan özel/docker taban adresi SSRF listesine takılmaz.
  const u = await call('POST', '/flxw/server', { publicUrl: 'http://172.17.0.2:8080' });
  assert.equal(u.status, 200);
  assert.equal(u.json.publicUrl, 'http://172.17.0.2:8080');
  update({ publicUrl: '' });
});

test('güvenlik: ilk kurulum tek seferlik jeton ister, API key yetmez', async () => {
  resetLimiter();
  update({ adminHash: '' });
  const token = setupToken();
  assert.equal(token.length, 48);
  const st0 = await (await fetch(base + '/admin/api/state')).json();
  assert.deepEqual(Object.keys(st0).sort(), ['authed', 'lang', 'ok', 'setup', 'version']);
  assert.equal(st0.setup, true);
  assert.equal(st0.apiKey, undefined);

  const noToken = await fetch(base + '/admin/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'strongpassword' }),
  });
  assert.equal(noToken.status, 401);
  assert.equal(cfg().adminHash, '');

  const withKey = await fetch(base + '/admin/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: KEY() },
    body: JSON.stringify({ apiKey: KEY(), password: 'strongpassword' }),
  });
  assert.equal(withKey.status, 401);
  assert.equal(cfg().adminHash, '');

  const short = await fetch(base + '/admin/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setupToken: token, password: 'short' }),
  });
  assert.equal(short.status, 400);
  assert.equal(cfg().adminHash, '');

  const ok = await fetch(base + '/admin/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setupToken: token, password: 'strongpassword', lang: 'en' }),
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  assert.ok(cfg().adminHash);
  const again = await fetch(base + '/admin/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setupToken: token, password: 'anotherpassword' }),
  });
  assert.equal(again.status, 400);

  process.env.FLXW_SETUP_TOKEN = 'env-setup-token-value';
  update({ adminHash: '' });
  const envOk = await fetch(base + '/admin/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-setup-token': 'env-setup-token-value' },
    body: JSON.stringify({ password: 'envtokenpass' }),
  });
  assert.equal(envOk.status, 200);
  delete process.env.FLXW_SETUP_TOKEN;

  process.env.FLXW_ADMIN_PASSWORD = 'envpassword123';
  load();
  const stEnv = await (await fetch(base + '/admin/api/state')).json();
  assert.equal(stEnv.setup, false);
  assert.equal(setupToken(), '');
  const setupEnv = await fetch(base + '/admin/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setupToken: token, password: 'anotherpassword' }),
  });
  assert.equal(setupEnv.status, 400);
  delete process.env.FLXW_ADMIN_PASSWORD;
  load();
});

test('güvenlik: trust proxy varsayılanı kapalı, true yok sayılır', () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy(''), false);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('true'), false);
  assert.equal(parseTrustProxy('0'), false);
  assert.equal(parseTrustProxy('1'), 1);
  assert.equal(parseTrustProxy('2'), 2);
  assert.equal(parseTrustProxy('loopback'), 'loopback');
  assert.equal(parseTrustProxy('10.0.0.1, 172.16.0.0/12'), '10.0.0.1, 172.16.0.0/12');
  assert.equal(parseTrustProxy('please'), false);
});

test('güvenlik: giriş sınırlayıcı IP sınırı, süre sonu, harita sınırı ve genel sınır', () => {
  resetLimiter();
  const t0 = 1000000;
  for (let i = 0; i < 8; i++) {
    assert.equal(limited('1.2.3.4', t0), false);
    failed('1.2.3.4', t0);
  }
  assert.equal(limited('1.2.3.4', t0 + 1000), true);
  // 10 dakika sonra sıfırlanır
  assert.equal(limited('1.2.3.4', t0 + 600001), false);

  // Harita boyutu 1024 ile sınırlıdır
  resetLimiter();
  for (let i = 0; i < 1200; i++) failed('10.0.' + Math.floor(i / 256) + '.' + (i % 256), t0);
  assert.ok(limiterSize() <= 1024);
  // Genel sınır (30 hata) farklı IP'lerden gelse bile devreye girer
  assert.equal(limited('9.9.9.9', t0 + 100), true);
  resetLimiter();
});

test('güvenlik: trust proxy kapalıyken sahte X-Forwarded-For sınırı aşamaz', async () => {
  resetLimiter();
  update({ adminHash: (await import('../src/config.js')).hashPassword('correctpass123') });
  for (let i = 0; i < 8; i++) {
    const r = await fetch(base + '/admin/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `203.0.113.${i}, 198.51.100.7` },
      body: JSON.stringify({ password: 'wrong' }),
    });
    assert.equal(r.status, 401);
  }
  const blocked = await fetch(base + '/admin/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.99, 198.51.100.7' },
    body: JSON.stringify({ password: 'wrong' }),
  });
  assert.equal(blocked.status, 429);
  resetLimiter();
});

test('güvenlik: kimlik doğrulamasız büyük gövde reddedilir, doğrulanmış medya kabul edilir', async () => {
  const big = 'A'.repeat(2 * 1024 * 1024);
  // Normal uç 1 MB üstünü reddeder
  const r1 = await fetch(base + '/message/sendText/flx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: KEY() },
    body: JSON.stringify({ number: '905551112233', text: big }),
  });
  assert.equal(r1.status, 413);

  // Medya ucunda kimlik doğrulaması büyük gövde ayrıştırılmadan önce çalışır
  const r2 = await fetch(base + '/message/sendMedia/flx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: 'wrong' },
    body: JSON.stringify({ number: '905551112233', mediatype: 'document', media: big }),
  });
  assert.equal(r2.status, 401);

  // Doğrulanmış medya ucu 1 MB üstü base64 kabul eder
  const r3 = await fetch(base + '/message/sendMedia/flx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: KEY() },
    body: JSON.stringify({ number: '905551112233', mediatype: 'document', media: Buffer.alloc(1500000, 1).toString('base64'), fileName: 'a.bin' }),
  });
  assert.equal(r3.status, 201);
});

test('güvenlik: SSRF koruması özel IP, DNS, yönlendirme ve boyut sınırını denetler', async () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('10.0.0.1'), true);
  assert.equal(isPrivateIp('172.16.5.4'), true);
  assert.equal(isPrivateIp('192.168.1.1'), true);
  assert.equal(isPrivateIp('169.254.169.254'), true);
  assert.equal(isPrivateIp('100.64.0.1'), true);
  assert.equal(isPrivateIp('100.100.100.200'), true);
  assert.equal(isPrivateIp('::1'), true);
  assert.equal(isPrivateIp('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateIp('::ffff:7f00:1'), true);
  assert.equal(isPrivateIp('fe80::1'), true);
  assert.equal(isPrivateIp('fc00::1'), true);
  assert.equal(isPrivateIp('fd00:ec2::254'), true);
  assert.equal(isPrivateIp('93.184.216.34'), false);
  assert.equal(isPrivateIp('2606:2800:220:1:248:1893:25c8:1946'), false);
  assert.equal(isAlwaysBlockedIp('169.254.169.254'), true);
  assert.equal(isAlwaysBlockedIp('fe80::1'), true);
  assert.equal(isAlwaysBlockedIp('10.0.0.1'), false);
  assert.equal(isAlwaysBlockedIp('127.0.0.1'), false);

  delete process.env.FLXW_ALLOW_PRIVATE_URLS;
  await assert.rejects(() => checkSafeUrl('http://127.0.0.1:8080/x'), /Private or local URL/);
  await assert.rejects(() => checkSafeUrl('http://2130706433/x'), /Private or local URL/);
  await assert.rejects(() => checkSafeUrl('http://localhost/x'), /Private or local URL/);
  await assert.rejects(() => checkSafeUrl('http://169.254.169.254/latest/meta-data/'), /Private or local URL/);
  await assert.rejects(() => checkSafeUrl('http://100.64.1.1/x'), /Private or local URL/);
  await assert.rejects(() => checkSafeUrl('http://[::ffff:127.0.0.1]/x'), /Private or local URL/);
  await assert.rejects(() => checkSafeUrl('http://172.17.0.2:8080/'), /Private or local URL/);
  await assert.rejects(() => checkSafeUrl('ftp://93.184.216.34/x'), /Invalid url/);
  await assert.rejects(
    () => checkSafeUrl('http://public.example/x', { lookup: async () => [{ address: '10.1.2.3', family: 4 }, { address: '93.184.216.34', family: 4 }] }),
    /Private or local URL/,
  );
  // Özel ağ bayrağı metadata ve link-local'i açmaz; RFC1918'i açar.
  process.env.FLXW_ALLOW_PRIVATE_URLS = '1';
  await assert.rejects(() => checkSafeUrl('http://169.254.169.254/latest/meta-data/'), /Private or local URL/);
  await assert.rejects(() => checkSafeUrl('http://metadata.google.internal/'), /Private or local URL/);
  await assert.rejects(() => checkSafeUrl('http://100.100.100.200/'), /Private or local URL/);
  const docker = await checkSafeUrl('http://172.17.0.2:8080/');
  assert.equal(docker.address, '172.17.0.2');
  delete process.env.FLXW_ALLOW_PRIVATE_URLS;

  const wBad = await call('POST', '/webhook/set/flx', { webhook: { enabled: true, url: 'http://127.0.0.1:9999/hook' } });
  assert.equal(wBad.status, 400);
  const mBad = await call('POST', '/message/sendMedia/flx', { number: '905551112233', mediatype: 'image', media: 'http://127.0.0.1:9999/a.png' });
  assert.equal(mBad.status, 400);

  const srv = http.createServer((req, res) => {
    if (req.url === '/redir') {
      res.writeHead(302, { Location: 'http://169.254.169.254/secret' });
      res.end();
      return;
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.alloc(2048, 0x41));
      return;
    }
    res.end('ok');
  }).listen(0);
  const port = srv.address().port;
  try {
    await assert.rejects(
      () => safeRequest(`http://127.0.0.1:${port}/redir`, { allowPrivate: true }),
      /Private or local URL/,
    );
    await assert.rejects(
      () => safeRequest(`http://127.0.0.1:${port}/big`, { allowPrivate: true, maxBytes: 512 }),
      /Response too large/,
    );
    process.env.FLXW_ALLOW_PRIVATE_URLS = '1';
    const buf = await fetchMediaBuffer(`http://127.0.0.1:${port}/ok`);
    assert.equal(buf.toString(), 'ok');
  } finally {
    srv.close();
    process.env.FLXW_ALLOW_PRIVATE_URLS = '1';
  }
});

