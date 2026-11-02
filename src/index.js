import express from 'express';
import { load, get as cfg, update } from './config.js';
import { open } from './store.js';
import { router as evolution } from './evolution.js';
import { router as admin } from './admin.js';
import { router as serverApi } from './server-api.js';
import * as inst from './instance.js';
import { log } from './log.js';
import { startKeepAlive } from './keepalive.js';

load();
await open(cfg().db).catch(async (e) => {
  // MySQL ayarı bozuksa panel yine açılsın: dosya deposuyla başla, panel hatayı gösterir.
  log.error({ err: e.message }, 'depo açılamadı, dosya deposuna geçildi');
  globalThis.flxwStoreError = e.message;
  await open({ driver: 'file' });
});

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '80mb' }));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store'); // LiteSpeed/CDN eski cevap vermesin
  next();
});

// Dış adres girilmediyse ilk dış istekten öğrenilir (uyanık tutma ve panel için).
app.use((req, res, next) => {
  const host = req.get('x-forwarded-host') || req.get('host') || '';
  if (!cfg().publicUrl && host && !/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(host) && req.query.ka !== '1') {
    update({ publicUrl: `${req.protocol}://${host}` }); // trust proxy: Hostinger'ın x-forwarded-proto'su
    log.info({ publicUrl: cfg().publicUrl }, 'dış adres öğrenildi');
  }
  next();
});
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), instances: inst.list().map((i) => ({ name: i.name, state: i.state })) });
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
