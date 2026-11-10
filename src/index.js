import express from 'express';
import { load, get as cfg, parseTrustProxy, setupToken, fromEnv } from './config.js';
import { open } from './store.js';
import { router as evolution } from './evolution.js';
import { router as admin } from './admin.js';
import { router as serverApi } from './server-api.js';
import * as inst from './instance.js';
import { log } from './log.js';
import { startKeepAlive } from './keepalive.js';

load();
if (!cfg().adminHash && !fromEnv.adminPassword) {
  if (String(process.env.FLXW_SETUP_TOKEN || '')) log.warn('ilk kurulum: FLXW_SETUP_TOKEN bekleniyor');
  else log.warn({ setupToken: setupToken() }, 'ilk kurulum jetonu; /admin ekranında bir kez kullanın');
}
await open(cfg().db).catch(async (e) => {
  // MySQL ayarı bozuksa panel yine açılsın: dosya deposuyla başla, panel hatayı gösterir.
  log.error({ err: e.message }, 'depo açılamadı, dosya deposuna geçildi');
  globalThis.flxwStoreError = e.message;
  await open({ driver: 'file' });
});

const app = express();
app.disable('x-powered-by');
const trustRaw = String(process.env.FLXW_TRUST_PROXY || '').trim().toLowerCase();
if (trustRaw === 'true' || trustRaw === 'on' || trustRaw === 'yes') {
  log.warn('FLXW_TRUST_PROXY koşulsuz güven yok sayıldı; atlama sayısı veya vekil listesi kullanın');
}
app.set('trust proxy', parseTrustProxy());
const smallJson = express.json({ limit: '1mb' });
app.use((req, res, next) => {
  if (/^\/message\/(sendMedia|sendWhatsAppAudio)\//.test(req.path)) return next();
  return smallJson(req, res, next);
});
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store'); // LiteSpeed/CDN eski cevap vermesin
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});
// Yedek panel: her şey WordPress'ten yönetildiği için FLXW_PANEL=off ile kapatılabilir.
if (process.env.FLXW_PANEL !== 'off') app.use('/admin', admin);
app.use('/flxw', serverApi);
app.use('/', evolution);
app.use((req, res) => res.status(404).json({ status: 404, error: 'Not Found', response: { message: ['Cannot ' + req.method + ' ' + req.path] } }));

const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, () => log.info({ port }, 'flx-wpapi açıldı'));

await inst.boot();
startKeepAlive();

const bye = async () => {
  await inst.shutdown();
  server.close();
  process.exit(0);
};
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
process.on('unhandledRejection', (e) => log.error({ err: e?.message || String(e) }, 'unhandledRejection'));
