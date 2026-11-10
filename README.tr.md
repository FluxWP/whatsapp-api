<div align="center">

[English](README.md) · **Türkçe**

# FluxWP WhatsApp API (flx-wpapi)

Evolution API uyumlu, hafif WhatsApp köprüsü. Ayrı Docker sunucusu istemez: Hostinger'ın **Node.js web app** özelliğinde çalışır, veriyi MySQL'de tutar.

![Node 20+](https://img.shields.io/badge/Node-20%2B-339933?logo=node.js&logoColor=white) ![Baileys 7](https://img.shields.io/badge/Baileys-7.0.0--rc14-25D366?logo=whatsapp&logoColor=white) ![Evolution API v2](https://img.shields.io/badge/Evolution%20API-v2%20uyumlu-7d64ff) [![MIT](https://img.shields.io/badge/lisans-MIT-blue)](LICENSE)

</div>

Altında [Baileys](https://github.com/WhiskeySockets/Baileys) 7 var (değiştirilmeden, npm paketi olarak). Flux Chat'in kullandığı Evolution uçlarını aynı adla ve aynı biçimde verir; Flux Chat'te bağlantıyı Evolution gibi eklersiniz (adres + API key + instance adı) ve Evolution bağlantısı yerinde kalır.

## Ne var, ne yok

| | |
|---|---|
| Mesaj gönderme | metin (alıntı, mention, link önizleme, "yazıyor…" gecikmesi), görsel, video, belge, sesli mesaj, tepki, düzenleme |
| Gelen | mesaj (medya base64 ile), tik/okundu, silme, düzenleme, tepki, "yazıyor…", kişi adı/fotoğrafı, bağlantı durumu |
| Diğer | QR ya da telefon numarasıyla eşleştirme, numara WhatsApp'ta var mı, profil fotoğrafı, grup listesi, okundu işaretleme, geçmiş (findChats/findMessages, varsayılan son 45 gün) |
| Yok | Evolution'ın Typebot/Chatwoot/RabbitMQ/S3 entegrasyonları, kampanya, Cloud API |

Uçların tam listesi: `src/evolution.js`.

## Hostinger kurulumu

Sunucu bir kez kurulur; sonrası (hesap ekleme, QR, webhook, dış adres, veritabanı) WordPress'ten, Flux Mail › Bağlantılar'daki WhatsApp bölümünden yönetilir. Ayrıntı: [docs/WORDPRESS.md](docs/WORDPRESS.md).

1. **Veritabanı:** hPanel › Veritabanları › MySQL'de yeni bir veritabanı ve kullanıcı açın.
2. **Uygulama:** hPanel › Web siteleri › Ekle › Node.js uygulaması. Alan adı olarak bir alt alan adı seçin (ör. `wa.example.org`).
   - Kaynak: GitHub (`FluxWP/whatsapp-api`, dal `main`) ya da zip yükleme.
   - Node sürümü: 22 (20 ve üstü çalışır). Kurulum: `npm install` · Başlatma: `npm start` · Giriş dosyası: `src/index.js`.
   - Ortam değişkenleri:

     | Değişken | Ne için |
     |---|---|
     | `FLXW_API_KEY` | Genel API key (uzun rastgele bir metin). WordPress'e bu girilir. |
     | `FLXW_DB_HOST`, `FLXW_DB_NAME`, `FLXW_DB_USER`, `FLXW_DB_PASSWORD` | MySQL. Verilirse WordPress'ten değiştirilemez. Vermezseniz WordPress'ten girilir. |
     | `FLXW_DATA_DIR` | Ayar klasörü; uygulama klasörünün **dışında** olsun (ör. `/home/<kullanıcı>/flxw-data`), yeniden kurulumda silinmesin. |
     | `FLXW_MSG_KEEP_DAYS` | Mesajların kaç gün saklanacağı. Varsayılan 45, aralık 1–3650; boş veya geçersiz değer varsayılanı (ya da config.json içindeki `msgKeepDays`) bırakır. Süresi dolan mesajlar açılışta ve 6 saatte bir silinir. Oturum anahtarları ve kişiler silinmez. |
     | `FLXW_PANEL` | `off` ise yedek panel (/admin) kapanır. |
     | `FLXW_PUBLIC_URL` | Bu uygulamanın dış adresi (uyanık tutma ve bağlantı bilgisi). İstekteki `Host` başlığından alınmaz. Özel ağ veya Docker adresi verilebilir. |
     | `FLXW_SETUP_TOKEN` | İlk yönetici parolası için isteğe bağlı tek seferlik jeton. Boşsa sunucu bir jeton üretir ve günlüğe bir kez yazar. |
     | `FLXW_ADMIN_PASSWORD` | İsteğe bağlı yönetici parolası. Verilirse ilk kurulum ekranı kapalıdır; parola panelden değiştirilemez. |
     | `FLXW_TRUST_PROXY` | Varsayılan kapalı. Uygulama ters vekil arkasındaysa ve giriş sınırı istemci IP'sine baksın isteniyorsa atlama sayısı (`1`) veya vekil IP/CIDR listesi. `true` yok sayılır. |
     | `FLXW_ALLOW_PRIVATE_URLS` | `1` ise webhook ve medya indirmeleri RFC1918, loopback ve IPv6 unique-local adreslere gidebilir (aynı makine veya Docker). Link-local ve bulut metadata yine kapalıdır. Varsayılan kapalı. |
3. **WordPress:** Flux Mail › Bağlantılar › yeni WhatsApp bağlantısı: tür **WhatsApp · Flux WPAPI**, adres `https://wa.example.org`, API key. Sonra hesap ekle › QR okut (WhatsApp › Bağlı cihazlar › Cihaz bağla) ya da telefon numarasıyla kod.

Yedek panel: `https://wa.example.org/admin`. İlk açılışta sunucu günlüğündeki tek seferlik kurulum jetonu (veya `FLXW_SETUP_TOKEN`) ve bir parola istenir. API anahtarı ancak bundan sonra görünür. WordPress'e ulaşılamadığında hesapları buradan da görebilirsiniz.

> Aynı numara hem Evolution'da hem burada bağlıysa iki bağlantı da aynı mesajı iletir. Deneme için ayrı bir numara kullanın ya da denerken Evolution bağlantısını kapatın.

## Uyanık tutma

Hostinger Node uygulamalarını trafik olmayınca durdurur; WhatsApp bağlantısı da onunla kopar (mesajlar kaybolmaz, uygulama uyanınca toplu gelir). Bunu önlemek için uygulama dakikada bir kendi dış adresine (`/health`) istek atar. Panelde "Son uyanık tutma" bunu gösterir.

Yine de uyuyorsa ücretsiz bir izleme servisi (UptimeRobot vb.) `https://wa.example.org/health` adresine 5 dakikada bir baksın.

## Güncelleme

- Baileys sürümü `package.json`'da sabit (`7.0.0-rc14`). Dependabot her hafta yeni sürüme bakar ve PR açar; PR'da testler çalışır. Birleştirdikten sonra Hostinger'da uygulamayı yeniden dağıtın (Git'ten çekip `npm install`).
- Baileys'e dokunan kod iki dosyada: `src/instance.js` (bağlantı, olaylar, gönderme) ve `src/auth-state.js` (oturum anahtarları). Kırıcı bir değişiklikte yalnız bunlara bakılır.
- WhatsApp Web sürümü her açılışta güncel haliyle çekilir.
- Panelde Baileys ve sunucu sürümü görünür.

## Kimlik doğrulama

- Evolution'daki gibi `apikey` başlığı: paneldeki genel API key ya da instance'a özel token.
- Panel: parola + imzalı çerez. Parola yokken kurulum, tek seferlik jetonu sabit süreli karşılaştırır. Giriş sınırı 10 dakikada IP başına 8, toplam 30 hatadır. İstemci IP'si soketten okunur; `FLXW_TRUST_PROXY` verilmedikçe `X-Forwarded-For` kullanılmaz.
- Çağıranın verdiği medya ve webhook adresleri SSRF kontrolünden geçer. Uygulamanın kendi dış adresi yapılandırmadır, çağıran adresi değildir.

## Sesli mesaj

WhatsApp sesli mesajı (mikrofon simgeli) yalnız ogg/opus çalar. `ffmpeg-static` (isteğe bağlı bağımlılık) kurulabildiyse başka biçimler çevrilir; kurulamadıysa ses dosyası olarak gider. Panelde "Sesli mesaj çevirici: Var/Yok".

## Ban riski

Baileys, Evolution gibi WhatsApp Web protokolünü kullanır; resmi değildir. Toplu ya da istenmeyen mesaj atan numaralar kapatılabilir. Flux Chat'in kullanım biçimi (gelen mesaja cevap) düşük risklidir, ama sıfır değildir.

## Yerelde

```bash
bun install
FLXW_DATA_DIR=./data PORT=3000 bun run start  # http://localhost:3000/admin
bun run test                              # sahte soketle uç testleri
```

## Geliştirici

FluxWP WhatsApp API, **Ahmet Yılmaz** ([@sharkpaw](https://github.com/sharkpaw)) tarafından yürütülmekte ve geliştirilmektedir.

<table><tr><td align="center"><a href="https://github.com/sharkpaw"><img src="https://github.com/sharkpaw.png?size=120" width="64" alt="Ahmet Yılmaz"><br><b>Ahmet Yılmaz</b></a><br><sub>Proje lideri · Maintainer</sub></td></tr></table>

### Katkıda bulunanlar

Issue ve pull request'ler açıktır. Katkıda bulunanlar burada listelenecek.

## Lisans

MIT.
