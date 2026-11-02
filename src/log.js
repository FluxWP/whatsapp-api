import pino from 'pino';

// Son kayıtlar panelde görünsün diye bellekte de tutulur.
const ring = [];
const dest = {
  write(line) {
    process.stdout.write(line);
    try {
      ring.push(JSON.parse(line));
      if (ring.length > 300) ring.shift();
    } catch {}
  },
};

export const log = pino({ level: process.env.FLXW_LOG || 'info', base: undefined }, dest);
// Baileys çok konuşkan; yalnız uyarılar.
export const baileysLog = log.child({ mod: 'baileys' }, { level: process.env.FLXW_BAILEYS_LOG || 'warn' });

export function recent(n = 100) {
  return ring.slice(-n);
}
