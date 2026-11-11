import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flxw-store-'));
process.env.FLXW_DATA_DIR = dir;
delete process.env.FLXW_MSG_KEEP_DAYS;
delete process.env.FLXW_ADMIN_PASSWORD;
delete process.env.FLXW_SETUP_TOKEN;

const { load, update, msgKeepDays, parseMsgKeepDays } = await import('../src/config.js');
const { open, store, stopRetention, startRetention, MysqlStore } = await import('../src/store.js');

before(async () => {
  load();
  update({ msgKeepDays: 45 });
  await open({ driver: 'file' });
});
after(() => stopRetention());

test('FLXW_MSG_KEEP_DAYS ve config.json msgKeepDays', () => {
  assert.equal(parseMsgKeepDays(''), null);
  assert.equal(parseMsgKeepDays('0'), null);
  assert.equal(parseMsgKeepDays('nope'), null);
  assert.equal(parseMsgKeepDays('15.9'), 15);
  assert.equal(parseMsgKeepDays('99999'), 3650);
  try {
    process.env.FLXW_MSG_KEEP_DAYS = '15';
    load();
    assert.equal(msgKeepDays(), 15);
    process.env.FLXW_MSG_KEEP_DAYS = '0';
    load();
    assert.equal(msgKeepDays(), 45);
    process.env.FLXW_MSG_KEEP_DAYS = 'nope';
    load();
    assert.equal(msgKeepDays(), 45);
    delete process.env.FLXW_MSG_KEEP_DAYS;
    update({ msgKeepDays: 12 });
    assert.equal(msgKeepDays(), 12);
  } finally {
    delete process.env.FLXW_MSG_KEEP_DAYS;
    load();
    update({ msgKeepDays: 45 });
  }
});

test('dosya deposu eski mesajı siler, oturumu ve kişiyi bırakır', async () => {
  update({ msgKeepDays: 10 });
  const now = Date.now();
  await store().kvSet('auth:flx', 'creds', '{"ok":1}');
  await store().kvSet('auth:flx', 'session-1', '{"sk":1}');
  await store().kvSet('contacts:flx', 'a@s.whatsapp.net', JSON.stringify({ name: 'A', profilePicUrl: 'https://example/a.jpg' }));
  await store().msgPut('flx', { id: 'keep', jid: 'a@s.whatsapp.net', fromMe: false, ts: now - 2 * 864e5, push: 'A', data: { key: { id: 'keep' } } });
  await store().msgPut('flx', { id: 'drop', jid: 'b@s.whatsapp.net', fromMe: false, ts: now - 40 * 864e5, push: 'B', data: { key: { id: 'drop' } } });
  const file = path.join(dir, 'store', 'msg', 'flx.jsonl');
  fs.appendFileSync(file, JSON.stringify({ id: 'keep', jid: 'a@s.whatsapp.net', fromMe: false, ts: now - 2 * 864e5, push: 'A2', data: { key: { id: 'keep' } } }) + '\n');

  await open({ driver: 'file' });
  assert.equal(await store().msgGet('flx', 'drop'), null);
  assert.equal((await store().msgGet('flx', 'keep')).id, 'keep');
  assert.equal(await store().kvGet('auth:flx', 'creds'), '{"ok":1}');
  assert.equal(await store().kvGet('auth:flx', 'session-1'), '{"sk":1}');
  assert.equal(JSON.parse(await store().kvGet('contacts:flx', 'a@s.whatsapp.net')).name, 'A');

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).id, 'keep');

  const fixed = 1_700_000_000_000;
  const min = fixed - 10 * 864e5;
  await store().msgPut('edge', { id: 'on', jid: 'a@s.whatsapp.net', fromMe: false, ts: min, push: '', data: {} });
  await store().msgPut('edge', { id: 'off', jid: 'b@s.whatsapp.net', fromMe: true, ts: min - 1, push: '', data: {} });
  await store().purge(fixed);
  assert.ok(await store().msgGet('edge', 'on'));
  assert.equal(await store().msgGet('edge', 'off'), null);
  update({ msgKeepDays: 45 });
});

test('dosya sohbet listesi tek dizin geçişi, sıra ve kişi alanı', async () => {
  const now = Date.now();
  await store().msgPut('list', { id: 'm1', jid: 'old@s.whatsapp.net', fromMe: false, ts: now - 3000, push: 'EskiPush', data: {} });
  await store().msgPut('list', { id: 'm2', jid: 'new@s.whatsapp.net', fromMe: false, ts: now - 1000, push: 'YeniPush', data: {} });
  await store().msgPut('list', { id: 'm3', jid: 'old@s.whatsapp.net', fromMe: false, ts: now - 2000, push: '', data: {} });
  await store().kvSet('contacts:list', 'old@s.whatsapp.net', JSON.stringify({ name: 'Eski', profilePicUrl: 'https://example/o.jpg' }));
  const s = store();
  let gets = 0;
  let kvDirs = 0;
  const origGet = s.kvGet.bind(s);
  const origRead = fs.readdirSync;
  s.kvGet = async (...args) => {
    gets++;
    return origGet(...args);
  };
  fs.readdirSync = function (p, ...rest) {
    if (String(p).includes(`${path.sep}kv${path.sep}`)) kvDirs++;
    return origRead.call(this, p, ...rest);
  };
  try {
    const chats = await s.chats('list');
    assert.equal(gets, 0);
    assert.equal(kvDirs, 1);
    assert.deepEqual(chats.map((c) => c.jid), ['new@s.whatsapp.net', 'old@s.whatsapp.net']);
    assert.equal(chats[0].contact, null);
    assert.equal(chats[0].push, 'YeniPush');
    assert.equal(JSON.parse(chats[1].contact).name, 'Eski');
    assert.equal(chats[1].push, 'EskiPush');
  } finally {
    s.kvGet = origGet;
    fs.readdirSync = origRead;
  }
});

test('mysql sohbet listesi tek sorgu, temizlik yalnız mesaj tablosu', async () => {
  const queries = [];
  const db = new MysqlStore({ prefix: 'flxw_' });
  db.pool = {
    async query(sql, args) {
      queries.push({ sql: String(sql), args });
      if (String(sql).startsWith('DELETE')) return [{ affectedRows: 2 }];
      return [[
        { jid: 'new@s.whatsapp.net', ts: '200', push: 'N', contact: null },
        { jid: 'old@s.whatsapp.net', ts: '100', push: '', contact: '{"name":"Eski"}' },
      ]];
    },
  };
  const rows = await db.chats('flx');
  assert.equal(queries.length, 1);
  assert.equal(queries[0].sql.includes(';'), false);
  assert.match(queries[0].sql, /LEFT JOIN flxw_kv/);
  assert.match(queries[0].sql, /FROM flxw_msg/);
  assert.deepEqual(queries[0].args, ['flx', 'contacts:flx']);
  assert.deepEqual(rows.map((r) => r.jid), ['new@s.whatsapp.net', 'old@s.whatsapp.net']);
  assert.equal(rows[0].ts, 200);
  assert.equal(rows[0].push, 'N');
  assert.equal(rows[1].contact, '{"name":"Eski"}');

  const now = 1_700_000_000_000;
  const purged = await db.purge(now);
  assert.equal(queries.length, 2);
  assert.match(queries[1].sql, /^DELETE FROM flxw_msg WHERE ts < \?$/);
  assert.doesNotMatch(queries[1].sql, /kv/);
  assert.deepEqual(queries[1].args, [now - msgKeepDays() * 864e5]);
  assert.equal(purged.deleted, 2);
});

test('temizlik zamanlayıcısı süreci ayakta tutmaz', () => {
  const t = startRetention();
  assert.equal(t.hasRef(), false);
  stopRetention();
});
