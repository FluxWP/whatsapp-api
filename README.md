<div align="center">

**English** · [Türkçe](README.tr.md)

# FluxWP WhatsApp API (flx-wpapi)

A lightweight WhatsApp bridge compatible with Evolution API. It needs no separate Docker server: it runs as a Hostinger **Node.js web app** and keeps its data in MySQL.

![Node 20+](https://img.shields.io/badge/Node-20%2B-339933?logo=node.js&logoColor=white) ![Baileys 7](https://img.shields.io/badge/Baileys-7.0.0--rc14-25D366?logo=whatsapp&logoColor=white) ![Evolution API v2](https://img.shields.io/badge/Evolution%20API-v2%20compatible-7d64ff) [![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

It runs on [Baileys](https://github.com/WhiskeySockets/Baileys) 7, used unmodified as an npm package. It exposes the Evolution endpoints that Flux Call Center uses, with the same names and payloads, so you add it in Flux Call Center like an Evolution connection (URL + API key + instance name) and your Evolution connection can stay where it is.

## What it covers

| | |
|---|---|
| Sending | text (quote, mention, link preview, "typing…" delay), image, video, document, voice note, reaction, edit |
| Incoming | messages (media as base64), delivered/read ticks, deletes, edits, reactions, "typing…", contact name/photo, connection state |
| Other | pairing by QR or phone number, "is this number on WhatsApp", profile photo, group list, mark as read, history (findChats/findMessages, last 45 days) |
| Not included | Evolution's Typebot/Chatwoot/RabbitMQ/S3 integrations, campaigns, Cloud API |

The full endpoint list is in `src/evolution.js`.

## Install on Hostinger

You set up the server once. After that, accounts, QR pairing, webhooks, the public URL and the database are managed from WordPress, in the WhatsApp part of Flux Contact › Connections. Details: [docs/WORDPRESS.md](docs/WORDPRESS.md) (Turkish).

1. **Database:** hPanel › Databases › MySQL, create a database and a user.
2. **App:** hPanel › Websites › Add › Node.js app, on a subdomain (e.g. `wa.example.org`).
   - Source: GitHub (`FluxWP/whatsapp-api`, branch `main`) or a zip upload.
   - Node 22 (20+ works). Build: `npm install` · Start: `npm start` · Entry file: `src/index.js`.
   - Environment variables:

     | Variable | Purpose |
     |---|---|
     | `FLXW_API_KEY` | Global API key (a long random string). This is what you enter in WordPress. |
     | `FLXW_DB_HOST`, `FLXW_DB_NAME`, `FLXW_DB_USER`, `FLXW_DB_PASSWORD` | MySQL. If set here, WordPress cannot change them; if not, enter them from WordPress. |
     | `FLXW_DATA_DIR` | Settings folder. Keep it **outside** the app folder (e.g. `/home/<user>/flxw-data`) so a redeploy does not delete it. |
     | `FLXW_PANEL` | `off` turns off the fallback panel (/admin). |
     | `FLXW_PUBLIC_URL` | Public URL. If empty, it is learned from the first request. |
3. **WordPress:** Flux Contact › Connections › new WhatsApp connection, type **WhatsApp · Flux WPAPI**, URL `https://wa.example.org`, API key. Then add an account and scan the QR (WhatsApp › Linked devices › Link a device) or pair with a code sent to the phone number.

Fallback panel: `https://wa.example.org/admin` (you set the password on first visit). Use it to see accounts when WordPress is unreachable.

> If the same number is linked both in Evolution and here, both connections deliver every message. Test with a separate number, or turn the Evolution connection off while testing.

## Keeping it awake

Hostinger stops Node apps when there is no traffic, and the WhatsApp connection drops with them (messages are not lost; they arrive in a batch when the app wakes up). To prevent this, the app requests its own public `/health` URL every minute. The panel shows this as "Last keep-alive".

If it still falls asleep, point a free uptime monitor (UptimeRobot or similar) at `https://wa.example.org/health` every 5 minutes.

## Updates

- The Baileys version is pinned in `package.json` (`7.0.0-rc14`). Dependabot checks weekly and opens a PR; tests run on it. After merging, redeploy the app on Hostinger (pull from Git, `npm install`).
- Only two files touch Baileys: `src/instance.js` (connection, events, sending) and `src/auth-state.js` (session keys). A breaking Baileys change only needs these two.
- The WhatsApp Web version is fetched fresh on every start.
- The panel shows the Baileys and server versions.

## Authentication

- An `apikey` header, as in Evolution: the global API key or a per-instance token.
- Panel: password + signed cookie; locks after 8 failed attempts in 10 minutes.

## Voice notes

WhatsApp voice notes (the ones with the microphone icon) play only ogg/opus. If the optional `ffmpeg-static` dependency installed, other formats are converted; if not, the audio goes out as a file. The panel shows "Voice note converter: Yes/No".

## Ban risk

Baileys, like Evolution, uses the unofficial WhatsApp Web protocol. Numbers that send bulk or unwanted messages can be banned. Flux Call Center's pattern (replying to incoming messages) is low risk, not zero.

## Local development

```bash
bun install
FLXW_DATA_DIR=./data PORT=3000 bun run start  # http://localhost:3000/admin
bun run test                                  # endpoint tests against a fake socket
```

## Maintainers

FluxWP WhatsApp API is led and maintained by **Ahmet Yılmaz** ([@sharkpaw](https://github.com/sharkpaw)).

<table><tr><td align="center"><a href="https://github.com/sharkpaw"><img src="https://github.com/sharkpaw.png?size=120" width="64" alt="Ahmet Yılmaz"><br><b>Ahmet Yılmaz</b></a><br><sub>Project lead · Maintainer</sub></td></tr></table>

### Contributors

Issues and pull requests are welcome. Contributors will be listed here.

## License

[MIT](LICENSE).
