import { contextBridge, ipcRenderer } from 'electron';
import type { Events, VdApi } from '../shared/api';

const names: string[] = ipcRenderer.sendSync('vd:names');

type Result = { ok: true; value: unknown } | { ok: false; error: { message: string; code?: string; paths?: string[]; reason?: string } };

const api: Record<string, unknown> = { platform: process.platform };

for (const name of names) {
  api[name] = async (...args: unknown[]) => {
    const r = (await ipcRenderer.invoke(`vd:${name}`, ...args)) as Result;
    if (r.ok) return r.value;
    throw Object.assign(new Error(r.error.message), { code: r.error.code, paths: r.error.paths, reason: r.error.reason });
  };
}

api.on = <E extends keyof Events>(event: E, cb: (p: Events[E]) => void) => {
  const listener = (_e: unknown, msg: { event: string; payload: Events[E] }) => {
    if (msg.event === event) cb(msg.payload);
  };
  ipcRenderer.on('vd:event', listener);
  return () => ipcRenderer.removeListener('vd:event', listener);
};

contextBridge.exposeInMainWorld('vd', api as unknown as VdApi);
