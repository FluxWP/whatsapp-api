# WordPress'ten yönetim (Flux Mail)

Sunucu bir kez kurulur; hesaplar (numaralar), QR, webhook ve sunucu ayarları WordPress'ten yönetilir. Uçlar Evolution API v2 ile aynıdır, yani aynı PHP kodu iki sağlayıcıyı da yönetir. `/flxw/*` yalnız flx-wpapi'de vardır.

## Kimlik

Her istekte `apikey: <genel API key>` başlığı. Genel anahtar kurulumda `FLXW_API_KEY` ortam değişkeniyle verilir (ya da yedek panelde görünür). Instance'a özel token da olur ama yönetim uçları (create, delete, fetchInstances listesi, /flxw) genel anahtar ister.

## Sağlayıcıyı tanıma

`GET /` → `{ version: "2.3.0", clientName: "flx-wpapi", flxwpapi: "0.1.0" }`. Evolution'da `clientName` yoktur ya da farklıdır; `flxwpapi` alanı varsa sunucu ayarları bölümü gösterilir.

## Hesap akışı

1. **Ekle:** `POST /instance/create` `{ "instanceName": "ornek", "integration": "WHATSAPP-BAILEYS", "qrcode": true }`
   → `201 { instance: { instanceName, status }, hash, qrcode: { base64, code, pairingCode } }`. Ad kullanılıyorsa `403`.
   `qrcode.base64` doğrudan `<img src>` olur (data:image/png).
2. **QR yenile / bağlan:** `GET /instance/connect/{instance}` → `{ base64, code, pairingCode }` ya da bağlıysa `{ instance: { state: "open" } }`. QR ~20 sn'de bir değişir; ekran açıkken 5 sn'de bir sorun.
3. **Telefon numarasıyla kod:** `GET /instance/connect/{instance}?number=905301234567` → `pairingCode` (8 hane). Kullanıcı WhatsApp › Bağlı cihazlar › Telefon numarasıyla bağla'ya girer.
4. **Durum:** `GET /instance/connectionState/{instance}` → `{ instance: { state: open|connecting|close } }`.
5. **Liste:** `GET /instance/fetchInstances` (ya da `?instanceName=`) →
   `[{ name, connectionStatus, ownerJid, number, profileName, profilePicUrl, token, createdAt, disconnectionReasonCode, disconnectionObject }]`.
6. **Webhook:** `POST /webhook/set/{instance}` `{ webhook: { enabled, url, webhookByEvents: false, webhookBase64: true, events: [...] } }`; `GET /webhook/find/{instance}`.
7. **Oturumu kapat:** `DELETE /instance/logout/{instance}` (hesap kalır, yeniden QR).
8. **Sil:** `DELETE /instance/delete/{instance}` (oturum, mesaj geçmişi, kişiler silinir).
9. **Yeniden başlat:** `POST /instance/restart/{instance}`.

## Sunucu ayarları (yalnız flx-wpapi)

- `GET /flxw/server` →
  `{ ok, server: "flx-wpapi", version, compat, baileys, node, uptime, memory, ffmpeg, publicUrl, keepAlive, lastKeepAlive (ISO ya da null), keepAliveState: { at, ok, error }, store: file|mysql, storeError, db: { driver, host, port, database, user, prefix, passwordSet, ok, error }, locked: { apiKey, db }, instances }`. Parola hiç dönmez.
- `POST /flxw/server` `{ publicUrl?, keepAlive?, db?: { driver, host, port, user, password, database, prefix } }` → aynı gövde. `db` önce denenir, olmazsa `400 { ok: false, error }`. Boş parola = kayıtlı parola kalır. `locked.db` true ise (ortam değişkeniyle verilmiş) `409`. Depo değişince bağlantılar kapanır, hesaplar yeniden QR ister.
- `POST /flxw/server/db-test` `{ db }` → `{ ok, error? }`.
- `GET /flxw/logs?n=100` → son kayıtlar (pino JSON).

## Evolution'dan farklar

- Evolution'da `/flxw/*` yok; sunucu ayarları bölümü gizlenir.
- Evolution `instance/create` cevabında `hash` instance'ın kendi anahtarıdır; flx-wpapi'de token verilmediyse genel anahtar döner. İkisinde de genel anahtarla devam etmek yeterli.
- Mesaj/olay biçimleri aynı (Baileys `WAMessage`, `remoteJidAlt` ile @lid numarası).

## Önerilen WP davranışı

- Polling hafif olsun (Hostinger IP rate-limit): QR ekranı açıkken 5 sn, liste ekranında 30 sn ya da elle yenile.
- WP'den köprüye giden istekler sunucu tarafında (wp_remote_*); API key tarayıcıya verilmez.
