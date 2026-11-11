import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/*
 * SSRF koruması: çağıranın verdiği medya ve webhook adresleri yalnız http/https.
 * Döngü (loopback), özel ağ, link-local, CGNAT ve bulut metadata adresleri reddedilir;
 * DNS çözümlemesinden sonra ve her yönlendirmede yeniden bakılır. Bağlantı, çözümlenen IP'ye kilitlenir.
 * Link-local ve metadata (169.254.0.0/16, 100.100.100.200, metadata.google.internal) hiçbir bayrakla açılmaz.
 * Panelden/ortamdan girilen publicUrl (Docker'daki Evolution taban adresi dahil) bu korumadan geçmez.
 * Aynı makine veya Docker ağına webhook gerekiyorsa FLXW_ALLOW_PRIVATE_URLS=1 (yalnız RFC1918, loopback, ULA).
 */

export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export function allowPrivateUrls() {
  const v = String(process.env.FLXW_ALLOW_PRIVATE_URLS || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function badUrl(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

function ipv4Int(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v < 0 || v > 255) return null;
    n = ((n << 8) | v) >>> 0;
  }
  return n;
}

// 'block' = link-local / metadata / ayrılmamış: FLXW_ALLOW_PRIVATE_URLS ile de açılmaz.
// 'private' = RFC1918, loopback, CGNAT, ULA: yalnız o bayrakla açılır.
function ipv4Class(n) {
  if (n === null) return 'bad';
  if ((n & 0xff000000) >>> 0 === 0x00000000) return 'block'; // 0.0.0.0/8
  if ((n & 0xffff0000) >>> 0 === 0xa9fe0000) return 'block'; // 169.254.0.0/16 link-local / metadata
  if (n === 0x646464c8) return 'block'; // 100.100.100.200 Alibaba metadata
  if (
    (n & 0xff000000) >>> 0 === 0x0a000000 || // 10.0.0.0/8
    (n & 0xffc00000) >>> 0 === 0x64400000 || // 100.64.0.0/10 CGNAT
    (n & 0xff000000) >>> 0 === 0x7f000000 || // 127.0.0.0/8
    (n & 0xfff00000) >>> 0 === 0xac100000 || // 172.16.0.0/12
    (n & 0xffffff00) >>> 0 === 0xc0000000 || // 192.0.0.0/24
    (n & 0xffffff00) >>> 0 === 0xc0000200 || // 192.0.2.0/24 TEST-NET-1
    (n & 0xffff0000) >>> 0 === 0xc0a80000 || // 192.168.0.0/16
    (n & 0xfffe0000) >>> 0 === 0xc6120000 || // 198.18.0.0/15
    (n & 0xffffff00) >>> 0 === 0xc6336400 || // 198.51.100.0/24 TEST-NET-2
    (n & 0xffffff00) >>> 0 === 0xcb007100 || // 203.0.113.0/24 TEST-NET-3
    (n & 0xe0000000) >>> 0 >= 0xe0000000 // 224.0.0.0/3 multicast + reserved
  ) return 'private';
  return 'public';
}

function expandIpv6(ip) {
  const clean = ip.toLowerCase().split('%')[0];
  let [head, tail] = clean.split('::');
  if (clean.split('::').length > 2) return null;
  const parsePart = (s) => (s ? s.split(':') : []);
  let h = parsePart(head);
  let t = tail !== undefined ? parsePart(tail) : [];
  if (t.length && t[t.length - 1].includes('.')) {
    const v4 = ipv4Int(t.pop());
    if (v4 === null) return null;
    t.push(((v4 >>> 16) & 0xffff).toString(16), (v4 & 0xffff).toString(16));
  } else if (tail === undefined && h.length && h[h.length - 1].includes('.')) {
    const v4 = ipv4Int(h.pop());
    if (v4 === null) return null;
    h.push(((v4 >>> 16) & 0xffff).toString(16), (v4 & 0xffff).toString(16));
  }
  const missing = 8 - (h.length + t.length);
  if (tail !== undefined ? missing < 1 : missing !== 0) return null;
  const words = [...h, ...(tail !== undefined ? Array(missing).fill('0') : []), ...t];
  if (words.length !== 8) return null;
  const out = [];
  for (const w of words) {
    if (!/^[0-9a-f]{1,4}$/.test(w)) return null;
    out.push(parseInt(w, 16));
  }
  return out;
}

function ipv6Class(ip) {
  if (ip.includes('%')) return 'block';
  const w = expandIpv6(ip);
  if (!w) return 'bad';
  const allZero = w.slice(0, 7).every((x) => x === 0);
  if (allZero && w[7] === 0) return 'block'; // ::/128 unspecified
  if (allZero && w[7] === 1) return 'private'; // ::1/128 loopback
  if (w[0] === 0xfd00 && w[1] === 0x0ec2 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0 && w[6] === 0 && w[7] === 0x254) {
    return 'block'; // AWS IMDSv6 fd00:ec2::254
  }
  const embedded = (hi, lo) => ipv4Class(((hi << 16) | lo) >>> 0);
  if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && (w[5] === 0xffff || w[5] === 0)) {
    return embedded(w[6], w[7]); // IPv4-mapped / IPv4-compatible
  }
  if (w[0] === 0x0064 && w[1] === 0xff9b && (w[2] === 0 || w[2] === 1)) return embedded(w[6], w[7]); // NAT64
  if (w[0] === 0x2002) {
    const inner = embedded(w[1], w[2]); // 6to4
    if (inner !== 'public') return inner;
  }
  if ((w[0] & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 unique local
  if ((w[0] & 0xffc0) === 0xfe80) return 'block'; // fe80::/10 link-local
  if ((w[0] & 0xffc0) === 0xfec0) return 'block'; // fec0::/10 site-local
  if ((w[0] & 0xff00) === 0xff00) return 'block'; // ff00::/8 multicast
  if (w[0] === 0x2001 && w[1] === 0x0db8) return 'block'; // 2001:db8::/32
  if (w[0] === 0x2001 && w[1] === 0) return 'block'; // 2001::/32 Teredo
  if (w[0] === 0x0100 && w[1] === 0 && w[2] === 0 && w[3] === 0) return 'block'; // 100::/64 discard
  return 'public';
}

function ipClass(ip) {
  const v = net.isIP(ip);
  if (v === 4) return ipv4Class(ipv4Int(ip));
  if (v === 6) return ipv6Class(ip);
  return 'bad';
}

export function isPrivateIp(ip) {
  return ipClass(ip) !== 'public';
}

export function isAlwaysBlockedIp(ip) {
  const c = ipClass(ip);
  return c === 'block' || c === 'bad';
}

export function parseHttpUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw badUrl('Invalid url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw badUrl('Invalid url');
  if (!u.hostname) throw badUrl('Invalid url');
  return u;
}

async function resolveHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const fam = net.isIP(host);
  if (fam) return [{ address: host, family: fam }];
  const lower = host.toLowerCase().replace(/\.$/, '');
  if (lower === 'localhost' || lower.endsWith('.localhost')) {
    return [{ address: '127.0.0.1', family: 4 }];
  }
  try {
    const list = await dns.lookup(host, { all: true, verbatim: true });
    if (!list || !list.length) throw badUrl('Host could not be resolved');
    return list;
  } catch (e) {
    if (e.status) throw e;
    throw badUrl('Host could not be resolved');
  }
}

/**
 * URL'yi doğrular, DNS çözümlemesi yapar ve özel/yerel adresleri reddeder.
 * @returns {Promise<{ url: URL, address: string, family: number }>}
 */
function blockedHostname(host, allowPrivate) {
  const lower = host.toLowerCase().replace(/\.$/, '');
  if (lower === 'metadata.google.internal' || lower === 'metadata.goog' || lower.endsWith('.google.internal')) return true;
  if (!allowPrivate && (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local'))) return true;
  return false;
}

export async function checkSafeUrl(raw, { allowPrivate = allowPrivateUrls(), lookup = resolveHost } = {}) {
  const u = parseHttpUrl(raw);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (blockedHostname(host, allowPrivate)) throw badUrl('Private or local URL is not allowed');
  const addrs = await lookup(host);
  for (const a of addrs) {
    if (isAlwaysBlockedIp(a.address) || (!allowPrivate && isPrivateIp(a.address))) {
      throw badUrl('Private or local URL is not allowed');
    }
  }
  return { url: u, address: addrs[0].address, family: addrs[0].family };
}

function requestOnce(target, { method = 'GET', headers = {}, body, timeoutMs = 30000, maxBytes = MAX_MEDIA_BYTES }) {
  const { url, address, family } = target;
  const mod = url.protocol === 'https:' ? https : http;
  // Gövde uzunluğu belli olsun: parçalı (chunked) istek gövdesini bazı PHP/FastCGI kurulumları boş okur.
  const sendHeaders = { ...headers };
  if (body && !Object.keys(sendHeaders).some((k) => k.toLowerCase() === 'content-length')) {
    sendHeaders['Content-Length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method,
        headers: sendHeaders,
        timeout: timeoutMs,
        lookup: (_host, opts, cb) => {
          if (opts && opts.all) return cb(null, [{ address, family }]);
          return cb(null, address, family);
        },
      },
      (res) => {
        const chunks = [];
        let total = 0;
        let aborted = false;
        res.on('data', (chunk) => {
          if (aborted) return;
          total += chunk.length;
          if (maxBytes && total > maxBytes) {
            aborted = true;
            res.destroy();
            req.destroy();
            reject(badUrl('Response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (aborted) return;
          resolve({
            status: res.statusCode || 0,
            ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on('error', (err) => {
          if (!aborted) reject(err);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    req.on('error', (err) => reject(err));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Her yönlendirme adımını yeniden doğrulayarak güvenli HTTP isteği yapar.
 */
export async function safeRequest(rawUrl, opts = {}) {
  let currentUrl = String(rawUrl || '');
  let method = (opts.method || 'GET').toUpperCase();
  let body = opts.body;
  let headers = { ...(opts.headers || {}) };

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = await checkSafeUrl(currentUrl, { allowPrivate: opts.allowPrivate, lookup: opts.lookup });
    const res = await requestOnce(target, {
      method,
      headers,
      body,
      timeoutMs: opts.timeoutMs ?? 30000,
      maxBytes: opts.maxBytes ?? MAX_MEDIA_BYTES,
    });
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
      if (hop === MAX_REDIRECTS) throw badUrl('Too many redirects');
      currentUrl = new URL(res.headers.location, target.url).toString();
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        delete headers['Content-Type'];
        delete headers['content-type'];
        delete headers['Content-Length'];
        delete headers['content-length'];
      }
      continue;
    }
    return res;
  }
  throw badUrl('Too many redirects');
}

export async function fetchMediaBuffer(rawUrl, { maxBytes = MAX_MEDIA_BYTES, timeoutMs = 30000 } = {}) {
  const res = await safeRequest(rawUrl, { method: 'GET', maxBytes, timeoutMs, headers: { 'User-Agent': 'flx-wpapi' } });
  if (!res.ok) throw badUrl(`Media fetch failed: HTTP ${res.status}`);
  return res.body;
}
