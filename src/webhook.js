import { get as cfg, EVOLUTION_COMPAT } from './config.js';
import { log } from './log.js';
import { safeRequest } from './url-guard.js';

/*
 * Evolution biçiminde webhook: { event: 'messages.upsert', instance, data, date_time, sender, server_url, apikey }.
 * Olay adları Evolution'daki gibi; "byEvents" açıksa adres sonuna /messages-upsert eklenir.
 * Sıra korunur (tek kuyruk), başarısız istek 3 kez denenir.
 */

const queues = new Map(); // inst -> { busy, list }

export const EVENTS = [
  'MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'MESSAGES_DELETE', 'SEND_MESSAGE', 'CONNECTION_UPDATE',
  'PRESENCE_UPDATE', 'CONTACTS_UPSERT', 'CONTACTS_UPDATE', 'QRCODE_UPDATED',
];

export function hookOf(inst) {
  const i = cfg().instances[inst] || {};
  return i.webhook || { enabled: false, url: '', events: [], base64: true, byEvents: false };
}

export function wantsBase64(inst) {
  const h = hookOf(inst);
  return h.enabled && h.url && h.base64 !== false;
}

/** @param {string} event "messages.upsert" biçiminde */
export function emit(inst, event, data, ownerJid = '') {
  const h = hookOf(inst);
  if (!h.enabled || !h.url) return;
  const upper = event.toUpperCase().replace(/\./g, '_');
  if (h.events && h.events.length && !h.events.includes(upper)) return;
  const body = {
    event,
    instance: inst,
    data,
    destination: h.url,
    date_time: new Date().toISOString(),
    sender: ownerJid,
    server_url: cfg().publicUrl || '',
    apikey: cfg().instances[inst]?.token || '',
    server: 'flx-wpapi',
    version: EVOLUTION_COMPAT,
  };
  const url = h.byEvents ? h.url.replace(/\/$/, '') + '/' + event.replace(/\./g, '-') : h.url;
  let q = queues.get(inst);
  if (!q) queues.set(inst, (q = { busy: false, list: [] }));
  if (q.list.length > 500) q.list.shift(); // site uzun süre kapalıysa bellek şişmesin
  q.list.push({ url, body });
  pump(inst, q);
}

async function pump(inst, q) {
  if (q.busy) return;
  q.busy = true;
  while (q.list.length) {
    const job = q.list[0];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await safeRequest(job.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'flx-wpapi' },
          body: JSON.stringify(job.body),
          timeoutMs: 30000,
          maxBytes: 1024 * 1024,
        });
        if (r.ok || (r.status >= 400 && r.status < 500 && r.status !== 429)) {
          if (!r.ok) log.warn({ inst, status: r.status, event: job.body.event }, 'webhook reddedildi');
          stat(inst, r.ok ? '' : `HTTP ${r.status}`);
          break;
        }
        throw new Error(`HTTP ${r.status}`);
      } catch (e) {
        stat(inst, e.message);
        if (attempt === 3 || e.status === 400) {
          log.warn({ inst, err: e.message, event: job.body.event }, 'webhook gönderilemedi');
          break;
        }
        await new Promise((ok) => setTimeout(ok, attempt * 2000));
      }
    }
    q.list.shift();
  }
  q.busy = false;
}

const stats = new Map();
function stat(inst, err) {
  stats.set(inst, { at: Date.now(), error: err });
}
export function lastDelivery(inst) {
  return stats.get(inst) || null;
}
export function pending(inst) {
  return queues.get(inst)?.list.length || 0;
}
