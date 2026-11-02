import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Gerçek WhatsApp'a bağlanmadan: sahte soketle Evolution uçlarını ve webhook biçimini dener.
process.env.FLXW_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flxw-'));
const { load, get: cfg } = await import('../src/config.js');
const { open } = await import('../src/store.js');
const inst = await import('../src/instance.js');
const { router } = await import('../src/evolution.js');
const { router: serverApi } = await import('../src/server-api.js');
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
  app.use(express.json({ limit: '80mb' }));
  app.use('/flxw', serverApi);
  app.use('/', router);
  server = app.listen(0);
  base = 'http://127.0.0.1:' + server.address().port;
  const i = inst.create('flx');
  i.sock = fakeSock();
  i.state = 'open';
});
after(() => { server.close(); hookServer.close(); });

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
  const r = await call('POST', '/chat/findMessages/flx', { where: { key: { remoteJid: '905551112233@s.whatsapp.net' } }, page: 1, offset: 10 });
  assert.ok(r.json.messages.records.length >= 2);
  assert.ok(r.json.messages.records[0].key.id);
  const c = await call('POST', '/chat/findChats/flx', {});
  assert.ok(c.json.some((x) => x.remoteJid === '905551112233@s.whatsapp.net'));
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
