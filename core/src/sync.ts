// Push / fetch / pull / clone against any Backend (Google Drive, or a folder for tests).
//
// Branch heads live in an append-only ref log, so concurrent pushers never overwrite
// each other (Drive has no compare-and-swap). Each push appends one sealed entry:
//     refs/<time>-<rand>.json = { branch, commit, parent, user, time }
// Every client folds the log in server-timestamp order. An entry only advances a branch
// if its `parent` equals the branch's current tip; otherwise it lost the race and is
// ignored. All clients compute the same result from the same files.
import type { Backend } from './storage.js';
import { objectKey, type ObjectStore } from './objects.js';
import { Repository, type Author, type CommitObject, type RemoteConfig } from './repo.js';
import { newTreeObjects, readTree } from './tree.js';
import { unwrapKey, randomBytes, hex, type Identity } from './crypto.js';

export interface RefEntry {
  branch: string;
  /** null = branch deleted */
  commit: string | null;
  parent: string | null;
  user: string;
  time: number;
  force?: boolean;
}

export interface LogItem extends RefEntry {
  key: string;
  createdTime: number;
}

export class PushRejectedError extends Error {
  constructor(readonly reason: 'fetch-first' | 'lost-race', message?: string) {
    super(message ?? (reason === 'fetch-first' ? 'Remote has new commits - fetch and merge first' : 'Someone pushed at the same moment - fetch and merge'));
  }
}

export interface Progress {
  phase: 'scanning' | 'uploading' | 'downloading';
  done: number;
  total: number;
  bytes: number;
}

type OnProgress = (p: Progress) => void;

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

export function foldRefs(items: LogItem[]): { tips: Map<string, string>; rejected: Set<string> } {
  const tips = new Map<string, string>();
  const rejected = new Set<string>();
  const sorted = [...items].sort((a, b) => a.createdTime - b.createdTime || (a.key < b.key ? -1 : 1));
  for (const e of sorted) {
    const cur = tips.get(e.branch) ?? null;
    if (e.force || e.parent === cur) {
      if (e.commit) tips.set(e.branch, e.commit);
      else tips.delete(e.branch);
    } else rejected.add(e.key);
  }
  return { tips, rejected };
}

export class RemoteClient {
  private log = new Map<string, LogItem>();
  private cursor: string | null = null;

  constructor(
    readonly backend: Backend,
    readonly store: ObjectStore,
    readonly me: { id: string },
  ) {}

  /** Pull any new ref-log entries. Returns the ones that were new to us. */
  async refresh(): Promise<LogItem[]> {
    const { files, cursor } = await this.backend.changes(this.cursor, 'refs/');
    const fresh: LogItem[] = [];
    for (const f of files) {
      if (this.log.has(f.key) || !f.key.startsWith('refs/')) continue;
      const raw = await this.backend.get(f.key);
      if (!raw) continue;
      try {
        const entry = this.store.openMeta<RefEntry>(f.key, raw);
        const item = { ...entry, key: f.key, createdTime: f.createdTime };
        this.log.set(f.key, item);
        fresh.push(item);
      } catch {
        /* encrypted with a key epoch we don't have, or tampered - ignore */
      }
    }
    this.cursor = cursor;
    return fresh;
  }

  heads() {
    return foldRefs([...this.log.values()]);
  }

  // ---- push ------------------------------------------------------------------

  async push(repo: Repository, branch: string, opts: { force?: boolean; onProgress?: OnProgress; remote?: string } = {}) {
    const localTip = await repo.branchTip(branch);
    if (!localTip) throw new Error(`No local branch "${branch}"`);
    await this.refresh();
    const remoteTip = this.heads().tips.get(branch) ?? null;
    if (remoteTip === localTip) return { pushed: 0, upToDate: true };
    if (remoteTip && !opts.force && !(await repo.ancestors(localTip)).has(remoteTip)) {
      throw new PushRejectedError('fetch-first');
    }

    // Commits not yet on the remote: everything between localTip and remoteTip's history.
    const known = remoteTip && (await repo.store.has(remoteTip)) ? await repo.ancestors(remoteTip) : new Set<string>();
    const commits: string[] = [];
    const seen = new Set<string>();
    const stack = [localTip];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id) || known.has(id)) continue;
      seen.add(id);
      commits.push(id);
      stack.push(...(await repo.getCommit(id)).parents);
    }

    const objects = new Set<string>();
    opts.onProgress?.({ phase: 'scanning', done: 0, total: commits.length, bytes: 0 });
    for (const id of commits) {
      objects.add(id);
      const c = await repo.getCommit(id);
      const parentTree = c.parents[0] ? (await repo.getCommit(c.parents[0])).tree : null;
      await newTreeObjects(repo.store, c.tree, parentTree, objects);
    }

    // Skip what the remote already has (cheap with a mock; a Drive index replaces this later).
    const missing: string[] = [];
    for (const id of objects) if (!(await this.backend.has(objectKey(id)))) missing.push(id);

    let done = 0;
    let bytes = 0;
    await pool(missing, 6, async (id) => {
      const sealed = await repo.store.getSealed(id);
      if (!sealed) throw new Error(`Local object ${id} is missing - repository is damaged`);
      await this.backend.put(objectKey(id), sealed);
      bytes += sealed.length;
      opts.onProgress?.({ phase: 'uploading', done: ++done, total: missing.length, bytes });
    });

    // Objects first, ref last: a crash never leaves a ref pointing at missing data.
    const entry: RefEntry = { branch, commit: localTip, parent: remoteTip, user: this.me.id, time: Date.now(), force: opts.force };
    const key = `refs/${String(entry.time).padStart(14, '0')}-${hex(randomBytes(4))}.json`;
    await this.backend.put(key, this.store.sealMeta(key, entry));
    await this.refresh();
    if (!opts.force && this.heads().tips.get(branch) !== localTip) {
      throw new PushRejectedError('lost-race');
    }
    await repo.setRemoteTips(opts.remote ?? 'origin', Object.fromEntries(this.heads().tips));
    return { pushed: commits.length, upToDate: false, bytes };
  }

  async deleteRemoteBranch(branch: string) {
    await this.refresh();
    const parent = this.heads().tips.get(branch) ?? null;
    const entry: RefEntry = { branch, commit: null, parent, user: this.me.id, time: Date.now() };
    const key = `refs/${String(entry.time).padStart(14, '0')}-${hex(randomBytes(4))}.json`;
    await this.backend.put(key, this.store.sealMeta(key, entry));
    await this.refresh();
  }

  // ---- fetch -----------------------------------------------------------------

  private async download(repo: Repository, id: string) {
    if (await repo.store.has(id)) return;
    const raw = await this.backend.get(objectKey(id));
    if (!raw) throw new Error(`Remote is missing object ${id}`);
    repo.store.decode(id, raw); // authenticates + decrypts; throws if tampered
    await repo.store.putSealed(id, raw);
  }

  private async downloadTree(repo: Repository, treeId: string, withBlobs: boolean, tally: { n: number }) {
    if (await repo.store.has(treeId)) return;
    // The tree object is needed to list children, so fetch it to a temp read, then children, then persist.
    const raw = await this.backend.get(objectKey(treeId));
    if (!raw) throw new Error(`Remote is missing tree ${treeId}`);
    const plain = JSON.parse(new TextDecoder().decode(repo.store.decode(treeId, raw))) as Awaited<ReturnType<typeof readTree>>;
    const chunks: string[] = [];
    for (const e of plain.entries) {
      if (e.t === 'd') await this.downloadTree(repo, e.id, withBlobs, tally);
      else if (withBlobs) chunks.push(...e.c);
    }
    await pool(chunks, 6, async (c) => {
      await this.download(repo, c);
      tally.n++;
    });
    await repo.store.putSealed(treeId, raw);
  }

  async fetch(repo: Repository, opts: { remote?: string; withBlobs?: boolean; onProgress?: OnProgress } = {}) {
    const remote = opts.remote ?? 'origin';
    await this.refresh();
    const { tips } = this.heads();
    const before = await repo.remoteTips(remote);
    const tally = { n: 0 };
    const updated: { branch: string; from: string | null; to: string }[] = [];

    for (const [branch, tip] of tips) {
      if (!(await repo.store.has(tip))) {
        const order: string[] = [];
        const queue = [tip];
        const seen = new Set<string>();
        while (queue.length) {
          const id = queue.pop()!;
          if (seen.has(id) || (await repo.store.has(id))) continue;
          seen.add(id);
          const raw = await this.backend.get(objectKey(id));
          if (!raw) throw new Error(`Remote is missing commit ${id}`);
          const c = JSON.parse(new TextDecoder().decode(repo.store.decode(id, raw))) as CommitObject;
          await this.downloadTree(repo, c.tree, opts.withBlobs ?? true, tally);
          order.push(id);
          queue.push(...c.parents);
        }
        // Persist oldest commits first so a commit is only present if its history is.
        for (const id of order.reverse()) await this.download(repo, id);
        opts.onProgress?.({ phase: 'downloading', done: order.length, total: order.length, bytes: 0 });
      }
      if (before[branch] !== tip) updated.push({ branch, from: before[branch] ?? null, to: tip });
    }
    await repo.setRemoteTips(remote, Object.fromEntries(tips));
    return { updated, objects: tally.n };
  }

  async aheadBehind(repo: Repository, branch: string, remote = 'origin') {
    const local = await repo.branchTip(branch);
    const remoteTip = (await repo.remoteTips(remote))[branch] ?? null;
    if (!local && !remoteTip) return { ahead: 0, behind: 0 };
    if (!remoteTip) return { ahead: (await repo.ancestors(local!)).size, behind: 0 };
    if (!local) return { ahead: 0, behind: (await repo.ancestors(remoteTip)).size };
    const a = await repo.ancestors(local);
    const b = await repo.ancestors(remoteTip);
    return { ahead: [...a].filter((x) => !b.has(x)).length, behind: [...b].filter((x) => !a.has(x)).length };
  }

  /** Fetch, then merge the remote branch into the checked-out branch. */
  async pull(repo: Repository, opts: { remote?: string } = {}) {
    const remote = opts.remote ?? 'origin';
    const branch = await repo.currentBranch();
    if (!branch) throw new Error('Not on a branch');
    await this.fetch(repo, { remote });
    const tip = (await repo.remoteTips(remote))[branch];
    if (!tip) return { kind: 'up-to-date' as const };
    if (!(await repo.branchTip(branch))) {
      await repo.materialize(tip, branch);
      return { kind: 'fast-forward' as const, id: tip };
    }
    return repo.merge(tip, { summary: `Merge ${remote}/${branch} into ${branch}` });
  }
}

// ---- clone -------------------------------------------------------------------

export interface RepoMeta {
  formatVersion: 1;
  repoId: string;
  name: string;
  defaultBranch: string;
  createdBy: string;
  createdAt: number;
}

export async function readRepoMeta(backend: Backend): Promise<RepoMeta> {
  const raw = await backend.get('repo.json');
  if (!raw) throw new Error('This folder is not a Version Driver repository');
  return JSON.parse(new TextDecoder().decode(raw)) as RepoMeta;
}

/** Keys the member can unwrap, by epoch. Empty until an admin approves them. */
export async function readMyKeys(backend: Backend, identity: Identity, memberId: string): Promise<Map<number, Uint8Array>> {
  const out = new Map<number, Uint8Array>();
  for (const f of await backend.list('keys/')) {
    const [, epoch, id] = f.key.split('/');
    if (id !== memberId) continue;
    const raw = await backend.get(f.key);
    if (raw) out.set(Number(epoch), unwrapKey(identity, raw));
  }
  return out;
}

export async function cloneRepo(opts: {
  backend: Backend;
  dir: string;
  identity: Identity;
  me: Author & { id: string };
  remote: RemoteConfig;
  remoteName?: string;
  withBlobs?: boolean;
  onProgress?: OnProgress;
}) {
  const meta = await readRepoMeta(opts.backend);
  const keys = await readMyKeys(opts.backend, opts.identity, opts.me.id);
  if (keys.size === 0) throw new Error('Access pending: an admin still needs to approve you for this repository');
  const name = opts.remoteName ?? 'origin';
  const repo = await Repository.initFromRemote(
    opts.dir,
    { formatVersion: 1, repoId: meta.repoId, name: meta.name, level: 'balanced', user: opts.me, remotes: { [name]: opts.remote } },
    keys,
  );
  const client = new RemoteClient(opts.backend, repo.store, opts.me);
  await client.fetch(repo, { remote: name, withBlobs: opts.withBlobs, onProgress: opts.onProgress });
  const tips = await repo.remoteTips(name);
  const branch = tips[meta.defaultBranch] ? meta.defaultBranch : Object.keys(tips)[0];
  if (branch) await repo.materialize(tips[branch]!, branch);
  return { repo, client };
}
