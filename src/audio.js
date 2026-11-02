import { spawn } from 'node:child_process';

/*
 * Sesli mesaj (ptt) WhatsApp'ta yalnız ogg/opus olarak çalar. ffmpeg-static kuruluysa
 * (isteğe bağlı bağımlılık) çeviririz; yoksa null döner ve ses dosyası olarak gönderilir.
 */
let bin;
async function ffmpeg() {
  if (bin !== undefined) return bin;
  try {
    bin = (await import('ffmpeg-static')).default || null;
  } catch {
    bin = null;
  }
  return bin;
}

export async function hasFfmpeg() {
  return !!(await ffmpeg());
}

export async function toOgg(buf) {
  const exe = await ffmpeg();
  if (!exe) return null;
  return new Promise((resolve) => {
    const p = spawn(exe, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1']);
    const out = [];
    const timer = setTimeout(() => p.kill('SIGKILL'), 30000);
    p.stdout.on('data', (d) => out.push(d));
    p.on('error', () => resolve(null));
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && out.length ? Buffer.concat(out) : null);
    });
    p.stdin.on('error', () => {});
    p.stdin.end(buf);
  });
}
