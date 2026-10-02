// Storage abstractions. A BlobStorage is a flat key -> bytes store (the local object
// directory, or a mock remote). A Backend is a remote one: it also reports server-side
// creation times and a change feed, which is what Google Drive provides.
import { mkdir, readFile, writeFile, rename, rm, readdir, stat, utimes } from 'node:fs/promises';
import { join, dirname, sep } from 'node:path';

export interface BlobInfo {
  key: string;
  size: number;
  /** Server-assigned, used to order the append-only ref log. */
  createdTime: number;
}

export interface BlobStorage {
  has(key: string): Promise<boolean>;
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<BlobInfo[]>;
}

export interface Backend extends BlobStorage {
  /** Everything created at/after `cursor` (null = from the beginning). Idempotent to re-read. */
  changes(cursor: string | null, prefix?: string): Promise<{ files: BlobInfo[]; cursor: string }>;
}

function safeKey(key: string): string {
  if (key.includes('..') || key.startsWith('/') || key.includes('\\') || key.includes('\0')) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
  return key;
}

let lastStamp = 0;
const nextStamp = () => (lastStamp = Math.max(Date.now(), lastStamp + 1));

/** Directory-backed storage. Also serves as the mock "Drive" for tests and local-only remotes. */
export class FsStorage implements Backend {
  constructor(readonly root: string) {}

  private path(key: string) {
    return join(this.root, ...safeKey(key).split('/'));
  }

  async has(key: string) {
    try {
      await stat(this.path(key));
      return true;
    } catch {
      return false;
    }
  }

  async get(key: string) {
    try {
      return new Uint8Array(await readFile(this.path(key)));
    } catch (e: any) {
      if (e.code === 'ENOENT') return undefined;
      throw e;
    }
  }

  async put(key: string, bytes: Uint8Array) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, p);
    const t = nextStamp() / 1000;
    await utimes(p, t, t);
  }

  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }

  async list(prefix: string): Promise<BlobInfo[]> {
    const out: BlobInfo[] = [];
    const base = join(this.root, ...safeKey(prefix).split('/').filter(Boolean));
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (e: any) {
        if (e.code === 'ENOENT') return;
        throw e;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (!e.name.endsWith('.tmp')) {
          const s = await stat(full);
          out.push({
            key: full.slice(this.root.length + 1).split(sep).join('/'),
            size: s.size,
            createdTime: s.mtimeMs,
          });
        }
      }
    };
    await walk(base);
    return out.sort((a, b) => a.createdTime - b.createdTime || (a.key < b.key ? -1 : 1));
  }

  async changes(cursor: string | null, prefix = '') {
    const since = cursor ? Number(cursor) : 0;
    const all = await this.list(prefix);
    const files = all.filter((f) => f.createdTime >= since);
    const max = all.reduce((m, f) => Math.max(m, f.createdTime), since);
    return { files, cursor: String(max) };
  }
}

export class MemoryStorage implements BlobStorage {
  readonly map = new Map<string, Uint8Array>();
  async has(key: string) {
    return this.map.has(key);
  }
  async get(key: string) {
    return this.map.get(key);
  }
  async put(key: string, bytes: Uint8Array) {
    this.map.set(key, bytes);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
  async list(prefix: string) {
    return [...this.map]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, v], i) => ({ key, size: v.length, createdTime: i }));
  }
}
