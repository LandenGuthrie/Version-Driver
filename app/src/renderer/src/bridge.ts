import type { VdApi } from '../../shared/api';

type Result = { ok: true; value: unknown } | { ok: false; error: { message: string; code?: string; paths?: string[]; reason?: string } };

/**
 * Builds `window.vd` from the preload's raw bridge. Calls resolve with the value, or reject with an Error
 * that keeps its `code` / `paths` / `reason`, which the context bridge itself would have thrown away.
 */
export function installBridge() {
  const raw = window.vdRaw!;
  window.vd = new Proxy({} as VdApi, {
    get(_t, name: string) {
      if (name === 'platform') return raw.platform;
      if (name === 'on') return raw.on;
      return async (...args: unknown[]) => {
        const r = (await raw.invoke(name, ...args)) as Result;
        if (r.ok) return r.value;
        throw Object.assign(new Error(r.error.message), { code: r.error.code, paths: r.error.paths, reason: r.error.reason });
      };
    },
  });
}
