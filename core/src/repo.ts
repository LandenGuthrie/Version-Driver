// The local repository: working-tree scanning, commits, history, branches, checkout,
// revert and merge. Everything stored is encrypted + compressed via ObjectStore.
import { mkdir, readFile, writeFile, readdir, lstat, open as fsOpen, rm, rmdir, chmod, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chunkFile } from './chunker.js';
import { looksIncompressible, type Level } from './compress.js';
import { generateRepoKey } from './crypto.js';
import { Ignore, DEFAULT_IGNORE } from './ignore.js';
import { FsStorage } from './storage.js';
import { Keyring, ObjectStore } from './objects.js';
import {
  diffSnapshots, flattenTree, sameContent, writeTree,
  type Change, type FileRec, type Snapshot,
} from './tree.js';

export interface Author {
  name: string;
  email: string;
  id?: string;
}

export interface CommitObject {
  v: 1;
  tree: string;
  parents: string[];
  author: Author;
  time: number;
  summary: string;
  description: string;
}

export interface CommitInfo extends CommitObject {
  id: string;
}

export type RemoteConfig =
  | { kind: 'fs'; path: string }
  | { kind: 'drive'; folderId: string; account?: string };

export interface RepoConfig {
  formatVersion: 1;
  repoId: string;
  name: string;
  level: Level;
  user: Author;
  remotes: Record<string, RemoteConfig>;
}

export class DirtyTreeError extends Error {
  constructor(readonly paths: string[]) {
    super(`Uncommitted changes would be overwritten: ${paths.slice(0, 5).join(', ')}${paths.length > 5 ? '…' : ''}`);
  }
}

export class ConflictError extends Error {
  constructor(readonly paths: string[]) {
    super(`Conflicts in: ${paths.join(', ')}`);
  }
}

interface IndexEntry {
  size: number;
  mtimeMs: number;
  /** When we hashed it. Files modified close to this moment are "racily clean" and get re-hashed. */
  seenAt: number;
  mode: number;
  chunks: string[];
}

const HEAD_BRANCH = 'main';

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

export class Repository {
  readonly vd: string;
  readonly store: ObjectStore;
  private index = new Map<string, IndexEntry>();
  private snapCache = new Map<string, Snapshot>();

  private constructor(
    readonly dir: string,
    public config: RepoConfig,
    readonly keyring: Keyring,
  ) {
    this.vd = join(dir, '.vdriver');
    this.store = new ObjectStore(new FsStorage(this.vd), keyring, config.level);
  }

  // ---- lifecycle -------------------------------------------------------------

  static async init(dir: string, opts: { name: string; user: Author; level?: Level }) {
    const vd = join(dir, '.vdriver');
    if (await exists(join(vd, 'config.json'))) throw new Error('Already a Version Driver repository');
    await mkdir(join(vd, 'refs', 'heads'), { recursive: true });
    const repoKey = generateRepoKey();
    const config: RepoConfig = {
      formatVersion: 1,
      repoId: randomUUID(),
      name: opts.name,
      level: opts.level ?? 'balanced',
      user: opts.user,
      remotes: {},
    };
    await writeFile(join(vd, 'config.json'), JSON.stringify(config, null, 2));
    await writeFile(join(vd, 'HEAD'), `ref: ${HEAD_BRANCH}`);
    if (!(await exists(join(dir, '.vdignore')))) await writeFile(join(dir, '.vdignore'), DEFAULT_IGNORE);
    const repo = new Repository(dir, config, new Keyring(new Map([[1, repoKey]])));
    return { repo, repoKey };
  }

  /** Create an empty local repo bound to an existing repo id/key (used by clone). */
  static async initFromRemote(dir: string, config: RepoConfig, repoKeys: Map<number, Uint8Array>) {
    const vd = join(dir, '.vdriver');
    await mkdir(join(vd, 'refs', 'heads'), { recursive: true });
    await writeFile(join(vd, 'config.json'), JSON.stringify(config, null, 2));
    await writeFile(join(vd, 'HEAD'), `ref: ${HEAD_BRANCH}`);
    return new Repository(dir, config, new Keyring(repoKeys));
  }

  static async open(dir: string, repoKeys: Map<number, Uint8Array>) {
    const config = JSON.parse(await readFile(join(dir, '.vdriver', 'config.json'), 'utf8')) as RepoConfig;
    const repo = new Repository(dir, config, new Keyring(repoKeys));
    try {
      const idx = JSON.parse(await readFile(join(repo.vd, 'index.json'), 'utf8')) as Record<string, IndexEntry>;
      repo.index = new Map(Object.entries(idx));
    } catch {
      /* no cache yet */
    }
    return repo;
  }

  keyringEpochs() {
    return this.keyring.epochs();
  }

  async saveConfig() {
    await writeFile(join(this.vd, 'config.json'), JSON.stringify(this.config, null, 2));
  }

  private async saveIndex() {
    await writeFile(join(this.vd, 'index.json'), JSON.stringify(Object.fromEntries(this.index)));
  }

  // ---- refs ------------------------------------------------------------------

  async currentBranch(): Promise<string | null> {
    const head = (await readFile(join(this.vd, 'HEAD'), 'utf8')).trim();
    return head.startsWith('ref: ') ? head.slice(5) : null;
  }

  async headId(): Promise<string | null> {
    const head = (await readFile(join(this.vd, 'HEAD'), 'utf8')).trim();
    if (head.startsWith('ref: ')) return this.branchTip(head.slice(5));
    return head.startsWith('commit: ') ? head.slice(8) : null;
  }

  async branchTip(name: string): Promise<string | null> {
    try {
      return (await readFile(join(this.vd, 'refs', 'heads', ...name.split('/')), 'utf8')).trim() || null;
    } catch {
      return null;
    }
  }

  async setBranchTip(name: string, id: string) {
    const p = join(this.vd, 'refs', 'heads', ...name.split('/'));
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, id);
  }

  async listBranches(): Promise<{ name: string; tip: string }[]> {
    const out: { name: string; tip: string }[] = [];
    const base = join(this.vd, 'refs', 'heads');
    const walk = async (dir: string, prefix: string) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.isDirectory()) await walk(join(dir, e.name), `${prefix}${e.name}/`);
        else out.push({ name: prefix + e.name, tip: (await readFile(join(dir, e.name), 'utf8')).trim() });
      }
    };
    await walk(base, '');
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async createBranch(name: string, from?: string) {
    if (await this.branchTip(name)) throw new Error(`Branch "${name}" already exists`);
    const tip = from ? await this.resolve(from) : await this.headId();
    if (!tip) throw new Error('Nothing to branch from yet - make a commit first');
    await this.setBranchTip(name, tip);
  }

  async deleteBranch(name: string) {
    if ((await this.currentBranch()) === name) throw new Error('Cannot delete the checked-out branch');
    await rm(join(this.vd, 'refs', 'heads', ...name.split('/')), { force: true });
  }

  // ---- remote tracking ---------------------------------------------------------

  async remoteTips(remote: string): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(join(this.vd, 'remotes', `${remote}.json`), 'utf8'));
    } catch {
      return {};
    }
  }

  async setRemoteTips(remote: string, tips: Record<string, string>) {
    await mkdir(join(this.vd, 'remotes'), { recursive: true });
    await writeFile(join(this.vd, 'remotes', `${remote}.json`), JSON.stringify(tips));
  }

  /** First checkout after a clone: write every file of `commitId` and point `branch` at it. */
  async materialize(commitId: string, branch: string) {
    const snap = await this.snapshotOf(commitId);
    for (const [path, rec] of snap) await this.writeRec(path, rec);
    await this.saveIndex();
    await this.setBranchTip(branch, commitId);
    await writeFile(join(this.vd, 'HEAD'), `ref: ${branch}`);
  }

  /** Branch name, commit id, or unique id prefix -> commit id. */
  async resolve(ref: string): Promise<string> {
    const tip = await this.branchTip(ref);
    if (tip) return tip;
    if (await this.store.has(ref)) return ref;
    throw new Error(`Unknown ref: ${ref}`);
  }

  // ---- objects ---------------------------------------------------------------

  async getCommit(id: string): Promise<CommitInfo> {
    return { ...(await this.store.getJson<CommitObject>(id)), id };
  }

  async snapshotOf(commitId: string | null): Promise<Snapshot> {
    if (!commitId) return new Map();
    const c = await this.getCommit(commitId);
    let s = this.snapCache.get(c.tree);
    if (!s) {
      s = await flattenTree(this.store, c.tree);
      if (this.snapCache.size > 64) this.snapCache.clear();
      this.snapCache.set(c.tree, s);
    }
    return s;
  }

  async readFileAt(commitId: string | null, path: string): Promise<Uint8Array | undefined> {
    const rec = (await this.snapshotOf(commitId)).get(path);
    return rec ? this.readRec(rec) : undefined;
  }

  async readRec(rec: FileRec): Promise<Uint8Array> {
    const out = new Uint8Array(rec.size);
    let off = 0;
    for (const id of rec.chunks) {
      const c = await this.store.get(id);
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  // ---- working tree ----------------------------------------------------------

  private async loadIgnore() {
    try {
      return new Ignore(await readFile(join(this.dir, '.vdignore'), 'utf8'));
    } catch {
      return new Ignore();
    }
  }

  /**
   * Ignore rules only apply to files we don't track yet (like git): adding a rule never makes
   * a committed file look deleted. So ignored folders are still entered if they hold tracked files.
   */
  private async walk(ignore: Ignore, tracked: Snapshot): Promise<{ rel: string; abs: string; size: number; mtimeMs: number; mode: number }[]> {
    const out: { rel: string; abs: string; size: number; mtimeMs: number; mode: number }[] = [];
    const trackedDirs = new Set<string>();
    for (const p of tracked.keys()) {
      for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) trackedDirs.add(p.slice(0, i));
    }
    const rec = async (abs: string, rel: string, parentIgnored: boolean) => {
      for (const e of await readdir(abs, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        const a = join(abs, e.name);
        if (e.isSymbolicLink()) continue; // symlinks are not tracked yet
        if (e.isDirectory()) {
          const ign = parentIgnored || ignore.ignores(r, true);
          if (!ign || trackedDirs.has(r)) await rec(a, r, ign);
        } else if (e.isFile() && (!(parentIgnored || ignore.ignores(r, false)) || tracked.has(r))) {
          const st = await lstat(a);
          out.push({ rel: r, abs: a, size: st.size, mtimeMs: st.mtimeMs, mode: st.mode & 0o111 ? 0o755 : 0o644 });
        }
      }
    };
    await rec(this.dir, '', false);
    return out;
  }

  private async hashFile(f: { rel: string; abs: string; size: number; mtimeMs: number; mode: number }, write: boolean): Promise<FileRec> {
    const cached = this.index.get(f.rel);
    if (cached && cached.size === f.size && cached.mtimeMs === f.mtimeMs && cached.mtimeMs + 2500 < cached.seenAt) {
      if (!write || (await Promise.all(cached.chunks.map((c) => this.store.has(c)))).every(Boolean)) {
        return { size: cached.size, mode: f.mode, chunks: cached.chunks };
      }
    }
    const skip = looksIncompressible(f.rel);
    const chunks: string[] = [];
    let size = 0;
    for await (const c of chunkFile(f.abs)) {
      const id = this.store.idOf('chunk', c);
      if (write && !(await this.store.has(id))) await this.store.putWithId(id, c, skip);
      chunks.push(id);
      size += c.length;
    }
    this.index.set(f.rel, { size, mtimeMs: f.mtimeMs, seenAt: Date.now(), mode: f.mode, chunks });
    return { size, mode: f.mode, chunks };
  }

  private async scan(write = false, only?: Set<string>): Promise<Snapshot> {
    const tracked = await this.snapshotOf(await this.headId());
    const files = (await this.walk(await this.loadIgnore(), tracked)).filter((f) => !only || only.has(f.rel));
    const recs = await pool(files, 4, (f) => this.hashFile(f, write));
    const snap: Snapshot = new Map();
    files.forEach((f, i) => snap.set(f.rel, recs[i]!));
    await this.saveIndex();
    return snap;
  }

  async status(): Promise<Change[]> {
    const head = await this.snapshotOf(await this.headId());
    return diffSnapshots(head, await this.scan(false));
  }

  // ---- committing ------------------------------------------------------------

  async commit(opts: { summary: string; description?: string; paths?: string[] }): Promise<CommitInfo> {
    const summary = opts.summary.trim();
    if (!summary) throw new Error('A commit needs a summary');
    const parent = await this.headId();
    const head = await this.snapshotOf(parent);
    const changes = diffSnapshots(head, await this.scan(false));
    const chosen = opts.paths ? changes.filter((c) => opts.paths!.includes(c.path)) : changes;
    if (chosen.length === 0) throw new Error('Nothing to commit');

    const next: Snapshot = new Map(head);
    const toWrite = new Set(chosen.filter((c) => c.status !== 'deleted').map((c) => c.path));
    const written = await this.scan(true, toWrite);
    for (const c of chosen) {
      if (c.status === 'deleted') next.delete(c.path);
      else next.set(c.path, written.get(c.path)!);
    }
    return this.commitSnapshot(next, parent ? [parent] : [], summary, opts.description ?? '');
  }

  private async commitSnapshot(snap: Snapshot, parents: string[], summary: string, description: string) {
    const tree = await writeTree(this.store, snap);
    const obj: CommitObject = {
      v: 1,
      tree,
      parents,
      author: this.config.user,
      time: Date.now(),
      summary,
      description,
    };
    const id = await this.store.putJson('commit', obj);
    await this.advanceHead(id);
    return { ...obj, id };
  }

  private async advanceHead(id: string) {
    const branch = await this.currentBranch();
    if (branch) await this.setBranchTip(branch, id);
    else await writeFile(join(this.vd, 'HEAD'), `commit: ${id}`);
  }

  // ---- history ---------------------------------------------------------------

  async log(opts: { from?: string; limit?: number } = {}): Promise<CommitInfo[]> {
    const start = opts.from ? await this.resolve(opts.from) : await this.headId();
    if (!start) return [];
    const seen = new Set<string>([start]);
    const queue: CommitInfo[] = [await this.getCommit(start)];
    const out: CommitInfo[] = [];
    while (queue.length && out.length < (opts.limit ?? Infinity)) {
      queue.sort((a, b) => b.time - a.time);
      const c = queue.shift()!;
      out.push(c);
      for (const p of c.parents) {
        if (!seen.has(p)) {
          seen.add(p);
          queue.push(await this.getCommit(p));
        }
      }
    }
    return out;
  }

  async ancestors(id: string): Promise<Set<string>> {
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(await this.getCommit(cur)).parents);
    }
    return seen;
  }

  async changesInCommit(id: string): Promise<Change[]> {
    const c = await this.getCommit(id);
    return diffSnapshots(await this.snapshotOf(c.parents[0] ?? null), await this.snapshotOf(id));
  }

  async diffBetween(a: string | null, b: string | null): Promise<Change[]> {
    return diffSnapshots(await this.snapshotOf(a), await this.snapshotOf(b));
  }

  // ---- moving around ---------------------------------------------------------

  private async writeRec(rel: string, rec: FileRec) {
    const abs = join(this.dir, ...rel.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    const fh = await fsOpen(abs, 'w');
    try {
      for (const id of rec.chunks) await fh.write(await this.store.get(id));
    } finally {
      await fh.close();
    }
    if (process.platform !== 'win32') await chmod(abs, rec.mode);
    const st = await stat(abs);
    this.index.set(rel, { size: rec.size, mtimeMs: st.mtimeMs, seenAt: Date.now(), mode: rec.mode, chunks: rec.chunks });
  }

  private async removeFile(rel: string) {
    const abs = join(this.dir, ...rel.split('/'));
    await rm(abs, { force: true });
    this.index.delete(rel);
    for (let d = dirname(abs); d !== this.dir && d.startsWith(this.dir); d = dirname(d)) {
      try {
        await rmdir(d);
      } catch {
        break;
      }
    }
  }

  /** Move the working tree from the current head snapshot to `target`. */
  private async applySnapshot(from: Snapshot, target: Snapshot, force: boolean) {
    const moves = diffSnapshots(from, target);
    if (!force) {
      const dirty = new Set((await this.status()).map((c) => c.path));
      const clash = moves.filter((m) => dirty.has(m.path)).map((m) => m.path);
      if (clash.length) throw new DirtyTreeError(clash);
    }
    for (const m of moves) {
      if (m.status === 'deleted') await this.removeFile(m.path);
      else await this.writeRec(m.path, target.get(m.path)!);
    }
    await this.saveIndex();
  }

  async checkout(ref: string, opts: { force?: boolean } = {}) {
    const isBranch = !!(await this.branchTip(ref));
    const target = await this.resolve(ref);
    const from = await this.snapshotOf(await this.headId());
    await this.applySnapshot(from, await this.snapshotOf(target), !!opts.force);
    await writeFile(join(this.vd, 'HEAD'), isBranch ? `ref: ${ref}` : `commit: ${target}`);
  }

  /** Move the current branch to `commitId`. hard=true also rewrites the working tree. */
  async reset(commitId: string, opts: { hard?: boolean } = {}) {
    const id = await this.resolve(commitId);
    if (opts.hard) {
      await this.applySnapshot(await this.snapshotOf(await this.headId()), await this.snapshotOf(id), true);
    }
    await this.advanceHead(id);
  }

  /** Bring one file back to how it was in `commitId` (shows up as a change). */
  async restoreFile(path: string, commitId: string) {
    const rec = (await this.snapshotOf(commitId)).get(path);
    if (rec) await this.writeRec(path, rec);
    else await this.removeFile(path);
    await this.saveIndex();
  }

  /** Throw away uncommitted changes to the given paths (or everything). */
  async discard(paths?: string[]) {
    const head = await this.snapshotOf(await this.headId());
    for (const c of await this.status()) {
      if (paths && !paths.includes(c.path)) continue;
      if (c.status === 'added') await this.removeFile(c.path);
      else await this.writeRec(c.path, head.get(c.path)!);
    }
    await this.saveIndex();
  }

  // ---- revert & merge --------------------------------------------------------

  /** Undo a commit by making a new commit that applies its inverse on top of HEAD. */
  async revert(commitId: string, opts: { resolutions?: Record<string, 'keep' | 'revert'> } = {}) {
    if ((await this.status()).length) throw new DirtyTreeError((await this.status()).map((c) => c.path));
    const c = await this.getCommit(commitId);
    const headId = await this.headId();
    if (!headId) throw new Error('Nothing to revert');
    const parentSnap = await this.snapshotOf(c.parents[0] ?? null);
    const commitSnap = await this.snapshotOf(commitId);
    const cur = await this.snapshotOf(headId);
    const next: Snapshot = new Map(cur);
    const conflicts: string[] = [];

    for (const ch of diffSnapshots(parentSnap, commitSnap)) {
      const have = cur.get(ch.path);
      const was = commitSnap.get(ch.path);
      const before = parentSnap.get(ch.path);
      const untouched = have && was ? sameContent(have, was) : !have && !was;
      if (!untouched) {
        const choice = opts.resolutions?.[ch.path];
        if (choice === 'keep') continue;
        if (choice !== 'revert') {
          conflicts.push(ch.path);
          continue;
        }
      }
      if (before) next.set(ch.path, before);
      else next.delete(ch.path);
    }
    if (conflicts.length) throw new ConflictError(conflicts);
    await this.applySnapshot(cur, next, true);
    return this.commitSnapshot(next, [headId], `Revert "${c.summary}"`, `This reverts commit ${c.id.slice(0, 10)}.`);
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    const ancA = await this.ancestors(a);
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (ancA.has(cur)) return cur;
      queue.push(...(await this.getCommit(cur)).parents);
    }
    return null;
  }

  /**
   * File-level three-way merge of `ref` into the current branch.
   * Files changed on both sides throw ConflictError unless a resolution is given.
   */
  async merge(ref: string, opts: { resolutions?: Record<string, 'ours' | 'theirs'>; summary?: string } = {}) {
    if ((await this.status()).length) throw new DirtyTreeError((await this.status()).map((c) => c.path));
    const theirs = await this.resolve(ref);
    const ours = await this.headId();
    if (!ours) throw new Error('Nothing to merge into');
    if ((await this.ancestors(ours)).has(theirs)) return { kind: 'up-to-date' as const };
    if ((await this.ancestors(theirs)).has(ours)) {
      await this.applySnapshot(await this.snapshotOf(ours), await this.snapshotOf(theirs), false);
      await this.advanceHead(theirs);
      return { kind: 'fast-forward' as const, id: theirs };
    }
    const base = await this.snapshotOf(await this.mergeBase(ours, theirs));
    const o = await this.snapshotOf(ours);
    const t = await this.snapshotOf(theirs);
    const next: Snapshot = new Map(o);
    const conflicts: string[] = [];
    const eq = (x?: FileRec, y?: FileRec) => (x && y ? sameContent(x, y) : !x && !y);
    for (const p of new Set([...base.keys(), ...o.keys(), ...t.keys()])) {
      const [b, mine, their] = [base.get(p), o.get(p), t.get(p)];
      if (eq(mine, their) || eq(their, b)) continue; // nothing to do
      if (eq(mine, b)) {
        their ? next.set(p, their) : next.delete(p);
      } else {
        const r = opts.resolutions?.[p];
        if (!r) conflicts.push(p);
        else if (r === 'theirs') their ? next.set(p, their) : next.delete(p);
      }
    }
    if (conflicts.length) throw new ConflictError(conflicts);
    await this.applySnapshot(o, next, true);
    const name = (await this.currentBranch()) ?? 'HEAD';
    const c = await this.commitSnapshot(next, [ours, theirs], opts.summary ?? `Merge ${ref} into ${name}`, '');
    return { kind: 'merge' as const, id: c.id };
  }
}

async function exists(p: string) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
