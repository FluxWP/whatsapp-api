import { BufferJSON, initAuthCreds, proto } from 'baileys';
import { store } from './store.js';

/** Baileys oturum anahtarlarını depoda (MySQL ya da dosya) tutar. useMultiFileAuthState'in depo karşılığı. */
export async function useStoreAuthState(inst) {
  const ns = `auth:${inst}`;
  const read = async (k) => {
    const v = await store().kvGet(ns, k);
    return v ? JSON.parse(v, BufferJSON.reviver) : null;
  };
  const write = (k, v) => store().kvSet(ns, k, v === null || v === undefined ? null : JSON.stringify(v, BufferJSON.replacer));

  const creds = (await read('creds')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          await Promise.all(
            ids.map(async (id) => {
              let v = await read(`${type}-${id}`);
              if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
              out[id] = v;
            }),
          );
          return out;
        },
        set: async (data) => {
          const jobs = [];
          for (const type of Object.keys(data)) {
            for (const id of Object.keys(data[type])) jobs.push(write(`${type}-${id}`, data[type][id]));
          }
          await Promise.all(jobs);
        },
      },
    },
    saveCreds: () => write('creds', creds),
    hasCreds: async () => !!(await store().kvGet(ns, 'creds')),
    clear: () => store().kvClear(ns),
  };
}
