# Changelog

## 0.1.1 - 2026-11-10

### Security

- First-run admin setup requires a one-time token. The server prints a generated token in the log, or the operator sets `FLXW_SETUP_TOKEN`. The API key alone cannot claim the panel.
- `trust proxy` is off unless `FLXW_TRUST_PROXY` is an explicit hop count or proxy list. The value `true` is ignored so `X-Forwarded-For` cannot bypass the login limit.
- The public base URL comes only from `FLXW_PUBLIC_URL` or the settings API. Request `Host` and `X-Forwarded-*` headers are not stored.
- JSON bodies are limited to 1 MB before authentication. `sendMedia` and `sendWhatsAppAudio` accept up to 80 MB only after a valid API key.
- Caller-supplied media and webhook URLs are rejected when they point at private, loopback, link-local, or cloud-metadata addresses, including after DNS resolution and on redirects. The configured public base URL is not part of that check.
- `GET /health` returns only `{ "ok": true }` to unauthenticated callers.

## 0.1.0

- İlk sürüm: Evolution API v2 uyumlu uçlar (Flux Chat'nin kullandıkları), Baileys 7.0.0-rc14.
- Depolama MySQL ya da dosya; oturum anahtarları, mesajlar (45 gün), kişiler.
- Webhook Evolution biçiminde, sıralı, 3 deneme; medya base64 ile.
- Yönetim paneli /admin (TR/EN, koyu mod): parola, instance ekle/sil, QR ya da telefon koduyla eşleştir, webhook, token, API key, veritabanı, kayıtlar.
- Hostinger için uyanık tutma (dakikada bir /health), 440 (oturum başka yerde açıldı) için uzun bekleme.
- Sesli mesaj: ffmpeg-static varsa ogg/opus'a çevirir.
- WordPress'ten yönetim: Evolution v2 biçiminde instance/create (QR'lı), fetchInstances, connect?number (eşleştirme kodu), logout, delete, restart; yalnız flx-wpapi'de /flxw/server (dış adres, uyanık tutma, MySQL) ve /flxw/logs. docs/WORDPRESS.md.
- Kurulum ortam değişkenleri: FLXW_API_KEY, FLXW_DB_*, FLXW_DATA_DIR, FLXW_PUBLIC_URL, FLXW_PANEL=off. Dış adres ilk istekten öğrenilir.
