// Google Drive implementation of the core `Backend`. A repository is one Drive folder;
// every key ("objects/ab/cdef", "refs/…", "members/…") becomes a file in it. We keep an
// in-memory index of the folder tree and keep it fresh with the Drive change feed, so
// has()/list() never hit the network.
import type { Backend, BlobInfo } from '@vd/core';

// The two env overrides exist so the app can be tested against a local fake Drive (app/tools/fake-drive.cjs).
const API = process.env.VD_DRIVE_API ?? 'https://www.googleapis.com/drive/v3';
const UPLOAD = process.env.VD_DRIVE_UPLOAD ?? 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const FIELDS = 'id,name,size,createdTime,modifiedTime,parents,mimeType,trashed';
const RESUMABLE_OVER = 5 * 1024 * 1024;
const CHUNK = 8 * 1024 * 1024; // multiple of 256 KiB, as Drive requires

interface DriveFile {
  id: string;
  name: string;
  size?: string;
  createdTime: string;
  modifiedTime?: string;
  parents?: string[];
  mimeType: string;
  trashed?: boolean;
}

interface Entry {
  id: string;
  size: number;
  createdTime: number;
  seq: number;
}

export interface DriveOptions {
  getToken: () => Promise<string>;
  rootFolderId: string;
  fetch?: typeof fetch;
}

export class DriveError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class DriveBackend implements Backend {
  private readonly f: typeof fetch;
  private files = new Map<string, Entry>();
  private idToKey = new Map<string, string>();
  private folderIds = new Map<string, string>();
  private folderPaths = new Map<string, string>();
  private pendingFolders = new Map<string, Promise<string>>();
  private pageToken: string | null = null;
  private seq = 0;
  private lastFeed = 0;
  private gate = Promise.resolve();
  private active = 0;

  constructor(private o: DriveOptions) {
    this.f = o.fetch ?? fetch;
    this.folderIds.set('', o.rootFolderId);
    this.folderPaths.set(o.rootFolderId, '');
  }

  /** Walk the repo folder once to build the index, and grab a change-feed start token. */
  async init() {
    this.pageToken = (await this.json<{ startPageToken: string }>(`${API}/changes/startPageToken?supportsAllDrives=false`)).startPageToken;
    const queue = [this.o.rootFolderId];
    while (queue.length) {
      const folder = queue.shift()!;
      for (const child of await this.listChildren(folder)) {
        if (child.mimeType === FOLDER) {
          const path = this.joinPath(this.folderPaths.get(folder) ?? '', child.name);
          // Concurrent creators can leave duplicate folders: the oldest one wins.
          if (!this.folderIds.has(path)) {
            this.folderIds.set(path, child.id);
            this.folderPaths.set(child.id, path);
          }
          queue.push(child.id);
        } else this.record(this.folderPaths.get(folder) ?? '', child);
      }
    }
    return this;
  }

  // ---- Backend ---------------------------------------------------------------

  async has(key: string) {
    return this.files.has(key);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const e = this.files.get(key) ?? (await this.lookup(key));
    if (!e) return undefined;
    const res = await this.request(`${API}/files/${e.id}?alt=media`);
    if (res.status === 404) {
      this.forget(key);
      return undefined;
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async put(key: string, bytes: Uint8Array) {
    const { dir, name } = locate(key);
    const parent = await this.ensureFolder(dir);
    const existing = this.files.get(key);
    const file = existing
      ? await this.upload(`${UPLOAD}/files/${existing.id}`, 'PATCH', {}, bytes)
      : await this.upload(`${UPLOAD}/files`, 'POST', { name, parents: [parent] }, bytes);
    this.record(dir, file);
  }

  async delete(key: string) {
    const e = this.files.get(key);
    if (!e) return;
    const res = await this.request(`${API}/files/${e.id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new DriveError(res.status, `Drive delete failed (${res.status})`);
    this.forget(key);
  }

  async list(prefix: string): Promise<BlobInfo[]> {
    const out: BlobInfo[] = [];
    for (const [key, e] of this.files) if (key.startsWith(prefix)) out.push({ key, size: e.size, createdTime: e.createdTime });
    return out.sort((a, b) => a.createdTime - b.createdTime || (a.key < b.key ? -1 : 1));
  }

  async changes(cursor: string | null, prefix = '') {
    await this.applyFeed();
    const since = cursor ? Number(cursor) : 0;
    const files: BlobInfo[] = [];
    for (const [key, e] of this.files) {
      if (e.seq >= since && key.startsWith(prefix)) files.push({ key, size: e.size, createdTime: e.createdTime });
    }
    files.sort((a, b) => a.createdTime - b.createdTime || (a.key < b.key ? -1 : 1));
    return { files, cursor: String(this.seq) };
  }

  /** Rename the repository's Drive folder. */
  async renameRoot(name: string) {
    await this.json(`${API}/files/${this.o.rootFolderId}?fields=id`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  }

  /** Move the whole repository folder to the Drive trash (recoverable there for 30 days). */
  async trashRoot() {
    await this.json(`${API}/files/${this.o.rootFolderId}?fields=id`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
  }

  // ---- sharing ---------------------------------------------------------------

  async share(email: string, role: 'writer' | 'reader') {
    await this.json(`${API}/files/${this.o.rootFolderId}/permissions?sendNotificationEmail=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'user', role, emailAddress: email }),
    });
  }

  async revoke(email: string) {
    const { permissions } = await this.json<{ permissions: { id: string; emailAddress?: string }[] }>(
      `${API}/files/${this.o.rootFolderId}/permissions?fields=permissions(id,emailAddress)`,
    );
    for (const p of permissions) {
      if (p.emailAddress?.toLowerCase() === email.toLowerCase()) {
        await this.request(`${API}/files/${this.o.rootFolderId}/permissions/${p.id}`, { method: 'DELETE' });
      }
    }
  }

  // ---- internals -------------------------------------------------------------

  private joinPath(dir: string, name: string) {
    return dir ? `${dir}/${name}` : name;
  }

  private keyFor(dir: string, name: string) {
    return dir === 'objects' ? `objects/${name.slice(0, 2)}/${name.slice(2)}` : this.joinPath(dir, name);
  }

  private record(dir: string, f: DriveFile) {
    const key = this.keyFor(dir, f.name);
    const prev = this.files.get(key);
    // Duplicate names (two clients uploaded the same object): keep the oldest.
    if (prev && prev.id !== f.id && prev.createdTime <= Date.parse(f.createdTime)) return;
    this.files.set(key, { id: f.id, size: Number(f.size ?? 0), createdTime: Date.parse(f.createdTime), seq: ++this.seq });
    this.idToKey.set(f.id, key);
  }

  private forget(key: string) {
    const e = this.files.get(key);
    if (e) this.idToKey.delete(e.id);
    this.files.delete(key);
    this.seq++;
  }

  private async listChildren(folderId: string): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let token: string | undefined;
    do {
      const q = new URLSearchParams({
        q: `'${folderId}' in parents and trashed=false`,
        fields: `nextPageToken,files(${FIELDS})`,
        pageSize: '1000',
        orderBy: 'createdTime',
        spaces: 'drive',
      });
      if (token) q.set('pageToken', token);
      const page = await this.json<{ files: DriveFile[]; nextPageToken?: string }>(`${API}/files?${q}`);
      out.push(...page.files);
      token = page.nextPageToken;
    } while (token);
    return out;
  }

  private async lookup(key: string): Promise<Entry | undefined> {
    const { dir, name } = locate(key);
    const folder = this.folderIds.get(dir);
    if (!folder) return undefined;
    const q = new URLSearchParams({
      q: `name='${name.replace(/'/g, "\\'")}' and '${folder}' in parents and trashed=false`,
      fields: `files(${FIELDS})`,
      orderBy: 'createdTime',
      pageSize: '1',
    });
    const { files } = await this.json<{ files: DriveFile[] }>(`${API}/files?${q}`);
    if (!files[0]) return undefined;
    this.record(dir, files[0]);
    return this.files.get(key);
  }

  private async ensureFolder(path: string): Promise<string> {
    const known = this.folderIds.get(path);
    if (known) return known;
    const inflight = this.pendingFolders.get(path);
    if (inflight) return inflight;
    const p = (async () => {
      const cut = path.lastIndexOf('/');
      const parentPath = cut < 0 ? '' : path.slice(0, cut);
      const parent = await this.ensureFolder(parentPath);
      const created = await this.json<DriveFile>(`${API}/files?fields=${FIELDS}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: path.slice(cut + 1), mimeType: FOLDER, parents: [parent] }),
      });
      this.folderIds.set(path, created.id);
      this.folderPaths.set(created.id, path);
      return created.id;
    })().finally(() => this.pendingFolders.delete(path));
    this.pendingFolders.set(path, p);
    return p;
  }

  /** Apply the Drive change feed to the index (throttled so a burst of pollers shares one call). */
  private async applyFeed() {
    if (Date.now() - this.lastFeed < 800) return;
    this.lastFeed = Date.now();
    let token: string | null | undefined = this.pageToken;
    if (!token) return;
    while (token) {
      const q: URLSearchParams = new URLSearchParams({
        pageToken: token,
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FIELDS}))`,
        pageSize: '500',
        includeRemoved: 'true',
        spaces: 'drive',
      });
      const page: {
        nextPageToken?: string;
        newStartPageToken?: string;
        changes: { fileId: string; removed?: boolean; file?: DriveFile }[];
      } = await this.json(`${API}/changes?${q}`);
      for (const c of page.changes) await this.applyChange(c);
      if (page.nextPageToken) token = page.nextPageToken;
      else {
        this.pageToken = page.newStartPageToken ?? token;
        break;
      }
    }
  }

  private async applyChange(c: { fileId: string; removed?: boolean; file?: DriveFile }) {
    const known = this.idToKey.get(c.fileId);
    if (c.removed || c.file?.trashed) {
      if (known) this.forget(known);
      return;
    }
    const f = c.file;
    if (!f) return;
    if (f.mimeType === FOLDER) {
      const parentPath = f.parents?.[0] ? await this.pathOfFolder(f.parents[0]) : undefined;
      if (parentPath !== undefined && !this.folderPaths.has(f.id)) {
        const path = this.joinPath(parentPath, f.name);
        if (!this.folderIds.has(path)) {
          this.folderIds.set(path, f.id);
          this.folderPaths.set(f.id, path);
        }
      }
      return;
    }
    const dir = f.parents?.[0] ? await this.pathOfFolder(f.parents[0]) : undefined;
    if (dir === undefined) return; // not inside this repo's folder tree
    this.record(dir, f);
  }

  /** Path of a folder inside this repo, resolving unknown folders up the parent chain. */
  private async pathOfFolder(id: string, depth = 0): Promise<string | undefined> {
    const known = this.folderPaths.get(id);
    if (known !== undefined) return known;
    if (depth > 4) return undefined;
    let meta: DriveFile;
    try {
      meta = await this.json<DriveFile>(`${API}/files/${id}?fields=${FIELDS}`);
    } catch {
      return undefined;
    }
    if (meta.mimeType !== FOLDER || !meta.parents?.[0]) return undefined;
    const parent = await this.pathOfFolder(meta.parents[0], depth + 1);
    if (parent === undefined) return undefined;
    const path = this.joinPath(parent, meta.name);
    if (!this.folderIds.has(path)) {
      this.folderIds.set(path, id);
      this.folderPaths.set(id, path);
    }
    return path;
  }

  // ---- HTTP ------------------------------------------------------------------

  private async upload(url: string, method: 'POST' | 'PATCH', meta: Record<string, unknown>, bytes: Uint8Array): Promise<DriveFile> {
    const q = `fields=${encodeURIComponent(FIELDS)}`;
    if (bytes.length <= RESUMABLE_OVER) {
      const boundary = `vd${Math.random().toString(36).slice(2)}`;
      const head = Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`);
      const tail = Buffer.from(`\r\n--${boundary}--`);
      const body = Buffer.concat([head, Buffer.from(bytes), tail]);
      return this.json<DriveFile>(`${url}?uploadType=multipart&${q}`, {
        method,
        headers: { 'content-type': `multipart/related; boundary=${boundary}` },
        body,
      });
    }
    const start = await this.request(`${url}?uploadType=resumable&${q}`, {
      method,
      headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'application/octet-stream' },
      body: JSON.stringify(meta),
    });
    if (!start.ok) throw new DriveError(start.status, `Could not start upload (${start.status})`);
    const session = start.headers.get('location');
    if (!session) throw new Error('Drive did not return an upload session');
    for (let off = 0; off < bytes.length; off += CHUNK) {
      const end = Math.min(off + CHUNK, bytes.length);
      const res = await this.request(session, {
        method: 'PUT',
        headers: { 'content-range': `bytes ${off}-${end - 1}/${bytes.length}` },
        body: Buffer.from(bytes.subarray(off, end)),
        noAuth: true,
      });
      if (res.status === 200 || res.status === 201) return (await res.json()) as DriveFile;
      if (res.status !== 308) throw new DriveError(res.status, `Upload failed (${res.status})`);
    }
    throw new Error('Upload ended without a final response');
  }

  private async json<T = unknown>(url: string, init?: RequestInit & { noAuth?: boolean }): Promise<T> {
    const res = await this.request(url, init);
    if (!res.ok) throw new DriveError(res.status, `Drive request failed (${res.status}): ${await res.text().catch(() => '')}`);
    return (await res.json()) as T;
  }

  /** Authenticated fetch with a concurrency cap, token refresh on 401 and backoff on throttling. */
  private async request(url: string, init: RequestInit & { noAuth?: boolean } = {}): Promise<Response> {
    while (this.active >= 6) await (this.gate = this.gate.then(() => sleep(15)));
    this.active++;
    try {
      for (let attempt = 0; ; attempt++) {
        const headers = new Headers(init.headers);
        if (!init.noAuth) headers.set('authorization', `Bearer ${await this.o.getToken()}`);
        let res: Response;
        try {
          res = await this.f(url, { ...init, headers });
        } catch (e) {
          if (attempt >= 4) throw e;
          await sleep(500 * 2 ** attempt);
          continue;
        }
        const throttled = res.status === 429 || res.status >= 500 || (res.status === 403 && /rate|quota/i.test(await res.clone().text()));
        if (throttled && attempt < 5) {
          await sleep(500 * 2 ** attempt + Math.random() * 250);
          continue;
        }
        return res;
      }
    } finally {
      this.active--;
    }
  }
}

function locate(key: string): { dir: string; name: string } {
  const parts = key.split('/');
  // Objects are flattened ("objects/ab/cdef…" -> folder "objects", file "abcdef…") to keep Drive's folder count low.
  if (parts[0] === 'objects' && parts.length === 3) return { dir: 'objects', name: parts[1]! + parts[2]! };
  return { dir: parts.slice(0, -1).join('/'), name: parts[parts.length - 1]! };
}

// ---- folder helpers used before a backend exists ----------------------------------

async function driveJson<T>(token: string, url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init?.headers as object) } });
  if (!res.ok) throw new DriveError(res.status, `Drive request failed (${res.status}): ${await res.text().catch(() => '')}`);
  return (await res.json()) as T;
}

async function findAppFolder(token: string): Promise<string | undefined> {
  const q = new URLSearchParams({
    q: `name='Version Driver' and mimeType='${FOLDER}' and 'root' in parents and trashed=false`,
    fields: 'files(id)',
    orderBy: 'createdTime',
    pageSize: '1',
  });
  return (await driveJson<{ files: { id: string }[] }>(token, `${API}/files?${q}`)).files[0]?.id;
}

/** The top-level "Version Driver" folder in My Drive, created on first use. Every repository lives inside it. */
export async function ensureAppFolder(getToken: () => Promise<string>): Promise<string> {
  const token = await getToken();
  const existing = await findAppFolder(token);
  if (existing) return existing;
  return (await driveJson<{ id: string }>(token, `${API}/files?fields=id`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Version Driver', mimeType: FOLDER }),
  })).id;
}

/** Create "Version Driver/<name>" in My Drive and return the repo folder id. */
export async function createRepoFolder(getToken: () => Promise<string>, name: string): Promise<string> {
  const parent = await ensureAppFolder(getToken);
  const repo = await driveJson<{ id: string }>(await getToken(), `${API}/files?fields=id`, {
    method: 'POST',
    body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
  });
  return repo.id;
}

// ---- account vault ------------------------------------------------------------------------------
// One small file in the "Version Driver" folder holding this account's device key, locked with a
// recovery password. It's what lets a new computer unlock the same repositories.

const VAULT_NAME = '.vd-account.json';

export interface VaultFile {
  v: 1;
  publicKey: string;
  wrapped: string;
  createdAt: number;
}

export async function readVault(getToken: () => Promise<string>): Promise<{ id: string; data: VaultFile } | null> {
  const token = await getToken();
  const parent = await findAppFolder(token);
  if (!parent) return null;
  const q = new URLSearchParams({
    q: `name='${VAULT_NAME}' and '${parent}' in parents and trashed=false`,
    fields: 'files(id)',
    orderBy: 'createdTime',
    pageSize: '1',
  });
  const { files } = await driveJson<{ files: { id: string }[] }>(token, `${API}/files?${q}`);
  if (!files[0]) return null;
  const res = await fetch(`${API}/files/${files[0].id}?alt=media`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new DriveError(res.status, `Could not read the account file (${res.status})`);
  return { id: files[0].id, data: (await res.json()) as VaultFile };
}

export async function writeVault(getToken: () => Promise<string>, data: VaultFile): Promise<void> {
  const token = await getToken();
  const parent = await ensureAppFolder(getToken);
  const boundary = `vd${Math.random().toString(36).slice(2)}`;
  const body = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: VAULT_NAME, parents: [parent] })}\r\n--${boundary}\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(data)}\r\n--${boundary}--`;
  const res = await fetch(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new DriveError(res.status, `Could not save the account file (${res.status})`);
}

/** Repo folders this account can see (created by it, or opened through it). */
export async function listRepoFolders(getToken: () => Promise<string>): Promise<{ folderId: string; name: string }[]> {
  const token = await getToken();
  const q = new URLSearchParams({
    q: `mimeType='${FOLDER}' and trashed=false and appProperties has { key='vd' and value='repo' }`,
    fields: 'files(id,name)',
    pageSize: '100',
  });
  const { files } = await driveJson<{ files: { id: string; name: string }[] }>(token, `${API}/files?${q}`);
  return files.map((f) => ({ folderId: f.id, name: f.name }));
}

/** Tag a folder so it can be found again as a Version Driver repo. */
export async function tagRepoFolder(getToken: () => Promise<string>, folderId: string) {
  await driveJson(await getToken(), `${API}/files/${folderId}?fields=id`, {
    method: 'PATCH',
    body: JSON.stringify({ appProperties: { vd: 'repo' } }),
  });
}
