# Değişiklikler

## 0.1.0

- İlk sürüm: Evolution API v2 uyumlu uçlar (Flux Chat'nin kullandıkları), Baileys 7.0.0-rc14.
- Depolama MySQL ya da dosya; oturum anahtarları, mesajlar (45 gün), kişiler.
- Webhook Evolution biçiminde, sıralı, 3 deneme; medya base64 ile.
- Yönetim paneli /admin (TR/EN, koyu mod): parola, instance ekle/sil, QR ya da telefon koduyla eşleştir, webhook, token, API key, veritabanı, kayıtlar.
- Hostinger için uyanık tutma (dakikada bir /health), 440 (oturum başka yerde açıldı) için uzun bekleme.
- Sesli mesaj: ffmpeg-static varsa ogg/opus'a çevirir.
- WordPress'ten yönetim: Evolution v2 biçiminde instance/create (QR'lı), fetchInstances, connect?number (eşleştirme kodu), logout, delete, restart; yalnız flx-wpapi'de /flxw/server (dış adres, uyanık tutma, MySQL) ve /flxw/logs. docs/WORDPRESS.md.
- Kurulum ortam değişkenleri: FLXW_API_KEY, FLXW_DB_*, FLXW_DATA_DIR, FLXW_PUBLIC_URL, FLXW_PANEL=off. Dış adres ilk istekten öğrenilir.
