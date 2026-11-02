# flx-wpapi

Evolution API uyumlu, hafif WhatsApp köprüsü. Altında [Baileys](https://github.com/WhiskeySockets/Baileys) 7 var (değiştirilmeden npm paketi olarak). Ayrı Docker sunucusu gerekmez: Hostinger'ın **Node.js web app** özelliğinde çalışır, veriyi Hostinger'ın MySQL'inde tutar.

Flux Chat'nin kullandığı Evolution uçlarını aynı adla ve aynı biçimde verir. Çağrı Merkezi'nde bağlantıyı Evolution gibi eklersiniz (adres + API key + instance adı); Evolution bağlantısı yerinde kalır.

## Ne var, ne yok

| | |
|---|---|
| Mesaj gönderme | metin (alıntı, mention, link önizleme, "yazıyor…" gecikmesi), görsel, video, belge, sesli mesaj, tepki, düzenleme |
| Gelen | mesaj (medya base64 ile), tik/okundu, silme, düzenleme, tepki, "yazıyor…", kişi adı/fotoğrafı, bağlantı durumu |
| Diğer | QR ya da telefon numarasıyla eşleştirme, numara WhatsApp'ta var mı, profil fotoğrafı, grup listesi, okundu işaretleme, geçmiş (findChats/findMessages, son 45 gün) |
| Yok | Evolution'ın Typebot/Chatwoot/RabbitMQ/S3 entegrasyonları, kampanya, Cloud API |

Uçların tam listesi: `src/evolution.js`.

## Hostinger kurulumu

Sunucu bir kez kurulur; sonrası (hesap ekleme, QR, webhook, dış adres, veritabanı) WordPress'ten, Flux Mail'deki WhatsApp sağlayıcıları bölümünden yönetilir. Ayrıntı: [docs/WORDPRESS.md](docs/WORDPRESS.md).

1. **Veritabanı:** hPanel › Veritabanları › MySQL'de yeni bir veritabanı ve kullanıcı açın.
2. **Uygulama:** hPanel › Web siteleri › Ekle › Node.js uygulaması. Alan adı olarak bir alt alan adı seçin (ör. `example.org`).
   - Kaynak: GitHub (`FluxWP/whatsapp-api`, dal `main`) ya da zip yükleme.
   - Node sürümü: 22 (20 ve üstü çalışır). Kurulum: `npm install` · Başlatma: `npm start` · Giriş dosyası: `src/index.js`.
   - Ortam değişkenleri:

     | Değişken | Ne için |
     |---|---|
     | `FLXW_API_KEY` | Genel API key (uzun rastgele bir metin). WordPress'e bu girilir. |
     | `FLXW_DB_HOST`, `FLXW_DB_NAME`, `FLXW_DB_USER`, `FLXW_DB_PASSWORD` | MySQL. Verilirse WordPress'ten değiştirilemez. Vermezseniz WordPress'ten girilir. |
     | `FLXW_DATA_DIR` | Ayar klasörü; uygulama klasörünün **dışında** olsun (ör. `/home/<kullanıcı>/flxw-data`), yeniden kurulumda silinmesin. |
     | `FLXW_PANEL` | `off` ise yedek panel (/admin) kapanır. |
     | `FLXW_PUBLIC_URL` | Dış adres. Vermezseniz ilk gelen istekten öğrenilir. |
3. **WordPress:** Flux Mail › WhatsApp sağlayıcıları › yeni sağlayıcı: tür Flux WPAPI, adres `https://example.org`, API key. Sonra hesap ekle › QR okut (WhatsApp › Bağlı cihazlar › Cihaz bağla) ya da telefon numarasıyla kod.

Yedek panel: `https://example.org/admin` (ilk açılışta parola belirlenir). WordPress'e ulaşılamadığında hesapları buradan da görebilirsiniz.

> Aynı numara hem Evolution'da hem burada bağlıysa iki bağlantı da aynı mesajı iletir. Deneme için ayrı bir numara kullanın ya da denerken Evolution bağlantısını kapatın.

## Uyanık tutma

Hostinger Node uygulamalarını trafik olmayınca durdurur; WhatsApp bağlantısı da onunla kopar (mesajlar kaybolmaz, uygulama uyanınca toplu gelir). Bunu önlemek için uygulama dakikada bir kendi dış adresine (`/health`) istek atar. Panelde "Son uyanık tutma" bunu gösterir.

Yine de uyuyorsa ücretsiz bir izleme servisi (UptimeRobot vb.) `https://example.org/health` adresine 5 dakikada bir baksın.

## Güncelleme

- Baileys sürümü `package.json`'da sabit (`7.0.0-rc14`). Dependabot her hafta yeni sürüme bakar ve PR açar; PR'da testler çalışır. Birleştirdikten sonra Hostinger'da uygulamayı yeniden dağıtın (Git'ten çekip `npm install`).
- Baileys'e dokunan kod iki dosyada: `src/instance.js` (bağlantı, olaylar, gönderme) ve `src/auth-state.js` (oturum anahtarları). Kırıcı bir değişiklikte yalnız bunlara bakılır.
- WhatsApp Web sürümü her açılışta güncel haliyle çekilir.
- Panelde Baileys ve sunucu sürümü görünür.

## Kimlik doğrulama

- Evolution'daki gibi `apikey` başlığı: paneldeki genel API key ya da instance'a özel token.
- Panel: parola + imzalı çerez; 10 dakikada 8 hatalı denemede kilitlenir.

## Sesli mesaj

WhatsApp sesli mesajı (mikrofon simgeli) yalnız ogg/opus çalar. `ffmpeg-static` (isteğe bağlı bağımlılık) kurulabildiyse başka biçimler çevrilir; kurulamadıysa ses dosyası olarak gider. Panelde "Sesli mesaj çevirici: Var/Yok".

## Ban riski

Baileys, Evolution gibi WhatsApp Web protokolünü kullanır; resmi değildir. Toplu ya da istenmeyen mesaj atan numaralar kapatılabilir. Çağrı Merkezi'nin kullanım biçimi (gelen mesaja cevap) düşük risklidir, ama sıfır değildir.

## Yerelde

```bash
bun install
FLXW_DATA_DIR=./data PORT=3000 bun run start  # http://localhost:3000/admin
bun run test                              # sahte soketle uç testleri
```

## Lisans

MIT.
