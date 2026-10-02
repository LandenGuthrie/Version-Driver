import { contextBridge, ipcRenderer } from 'electron';
import type { Events } from '../shared/api';

// Electron's context bridge strips custom properties (code, paths…) from thrown errors, leaving only the
// message. So the bridge never throws: it hands back plain { ok, value | error } objects, and the renderer
// (src/renderer/src/bridge.ts) turns them back into errors that still carry their code.
contextBridge.exposeInMainWorld('vdRaw', {
  platform: process.platform,
  invoke: (name: string, ...args: unknown[]) => ipcRenderer.invoke(`vd:${name}`, ...args),
  on: <E extends keyof Events>(event: E, cb: (p: Events[E]) => void) => {
    const listener = (_e: unknown, msg: { event: string; payload: Events[E] }) => {
      if (msg.event === event) cb(msg.payload);
    };
    ipcRenderer.on('vd:event', listener);
    return () => ipcRenderer.removeListener('vd:event', listener);
  },
});
