import { get as cfg } from './config.js';
import { log } from './log.js';

/*
 * Hostinger Node uygulamaları trafik olmayınca durdurulur; WhatsApp bağlantısı da onunla kopar.
 * Uygulama dakikada bir kendi dış adresine istek atar: istek Hostinger'ın önündeki sunucudan geçtiği için
 * "trafik var" sayılır. Dış izleme (UptimeRobot vb.) de /health'e bakabilir.
 */

const state = { at: 0, ok: null, error: '' };
let timer = null;

export function startKeepAlive() {
  clearInterval(timer);
  timer = setInterval(tick, 60000);
  setTimeout(tick, 5000);
}

async function tick() {
  const c = cfg();
  if (!c.keepAlive || !c.publicUrl) return;
  try {
    const r = await fetch(c.publicUrl.replace(/\/$/, '') + '/health?ka=1', { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'flx-wpapi-keepalive' } });
    state.ok = r.ok;
    state.error = r.ok ? '' : `HTTP ${r.status}`;
  } catch (e) {
    state.ok = false;
    state.error = e.message;
    log.warn({ err: e.message }, 'keep-alive isteği başarısız');
  }
  state.at = Date.now();
}

export function keepAliveState() {
  return { ...state };
}
