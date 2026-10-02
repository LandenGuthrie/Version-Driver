// Owns every open repository: keys, remotes, watchers. The IPC layer is a thin wrapper
// around this class.
import { app, BrowserWindow, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { join, basename } from 'node:path';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import {
  Repository, RemoteClient, RemoteWatcher, FsStorage, cloneRepo, publishRepo, requestJoin, listMembers,
  approveMember as coreApprove, removeMember as coreRemove, setRole as coreSetRole, memberSafetyNumber,
  heartbeat, clearPresence, listPresence, listLocks, acquireLock, releaseLock, addComment, listComments,
  generateIdentity, b64, fromB64, hex, fromHex, readRepoMeta, type Backend, type Identity, type Author,
  IGNORE_PRESETS, appliedPresets, setPreset, addPattern, detectPresets, DEFAULT_IGNORE,
} from '@vd/core';
import type {
  BranchDTO, ChangeDTO, CommitDTO, Events, FileDiff, IgnoreInfo, IgnorePresetDTO, LockDTO, MemberDTO, Profile, RepoSummary,
  Role, StorageStats, SyncState,
} from '../shared/api';
import { getSecret, setSecret, deleteSecret } from './keystore';
import { getAccessToken, signIn, cancelSignIn, signOutGoogle, googleConfigured } from './auth';
import { DriveBackend, createRepoFolder, listRepoFolders, tagRepoFolder } from './drive';
import { kindOf, looksBinary, mimeOf, textRows, MAX_DIFF_BYTES } from './files';

interface Ctx {
  repo: Repository;
  backend?: Backend;
  drive?: DriveBackend;
  client?: RemoteClient;
  watcher?: RemoteWatcher;
  fsWatcher?: FSWatcher;
  heartbeat?: ReturnType<typeof setInterval>;
}

type Emit = <E extends keyof Events>(event: E, payload: Events[E]) => void;

export class Manager {
  private registry: { id: string; dir: string }[] = [];
  private ctxs = new Map<string, Ctx>();
  private active: string | null = null;
  profile: Profile | null = null;
  private identity!: Identity;
  private fileCache: { key: string; bytes: Uint8Array } | null = null;

  constructor(private getWindow: () => BrowserWindow | null, private emit: Emit) {}

  // ---- startup ---------------------------------------------------------------

  private p(name: string) {
    return join(app.getPath('userData'), name);
  }

  async init() {
    try {
      this.registry = JSON.parse(await readFile(this.p('repos.json'), 'utf8'));
    } catch {
      this.registry = [];
    }
    try {
      this.profile = JSON.parse(await readFile(this.p('profile.json'), 'utf8'));
    } catch {
      this.profile = null;
    }
    const raw = getSecret('identity');
    if (raw) {
      const j = JSON.parse(raw) as { pub: string; priv: string };
      this.identity = { publicKey: fromB64(j.pub), privateKey: fromB64(j.priv) };
    } else {
      this.identity = generateIdentity();
      setSecret('identity', JSON.stringify({ pub: b64(this.identity.publicKey), priv: b64(this.identity.privateKey) }));
    }
  }

  private async saveRegistry() {
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(this.p('repos.json'), JSON.stringify(this.registry));
  }

  // ---- account ---------------------------------------------------------------

  private async setProfile(p: Profile | null) {
    this.profile = p;
    if (p) await writeFile(this.p('profile.json'), JSON.stringify(p));
    else await writeFile(this.p('profile.json'), 'null');
  }

  async signInGoogle() {
    const profile = await signIn(this.getWindow);
    await this.setProfile(profile);
    return profile;
  }

  cancelSignIn() {
    cancelSignIn();
  }

  async continueLocal(name: string, email: string) {
    const profile: Profile = { id: this.profile?.id ?? randomUUID(), name: name.trim() || 'Me', email: email.trim(), mode: 'local' };
    await this.setProfile(profile);
    return profile;
  }

  async signOut() {
    for (const id of [...this.ctxs.keys()]) await this.deactivate(id);
    signOutGoogle();
    await this.setProfile(null);
  }

  googleConfigured() {
    return googleConfigured();
  }

  private me(): Author & { id: string } {
    if (!this.profile) throw new Error('Not signed in');
    return { id: this.profile.id, name: this.profile.name, email: this.profile.email };
  }

  // ---- repositories ----------------------------------------------------------

  private saveKeys(repoId: string, keys: Map<number, Uint8Array>) {
    setSecret(`repokey:${repoId}`, JSON.stringify(Object.fromEntries([...keys].map(([e, k]) => [e, hex(k)]))));
  }

  private loadKeys(repoId: string): Map<number, Uint8Array> {
    const raw = getSecret(`repokey:${repoId}`);
    if (!raw) throw new Error('The encryption key for this repository is not on this device.');
    return new Map(Object.entries(JSON.parse(raw) as Record<string, string>).map(([e, k]) => [Number(e), fromHex(k)]));
  }

  private async register(repo: Repository): Promise<RepoSummary> {
    const id = repo.config.repoId;
    if (!this.registry.some((r) => r.id === id)) {
      this.registry.push({ id, dir: repo.dir });
      await this.saveRegistry();
    }
    this.ctxs.set(id, { repo });
    return this.summary(id);
  }

  private async ctx(id: string): Promise<Ctx> {
    let c = this.ctxs.get(id);
    if (!c) {
      const entry = this.registry.find((r) => r.id === id);
      if (!entry) throw new Error('Unknown repository');
      c = { repo: await Repository.open(entry.dir, this.loadKeys(id)) };
      this.ctxs.set(id, c);
    }
    return c;
  }

  async repo(id: string) {
    return (await this.ctx(id)).repo;
  }

  private async summary(id: string): Promise<RepoSummary> {
    const { repo } = await this.ctx(id);
    const origin = repo.config.remotes.origin;
    return {
      id,
      name: repo.config.name,
      dir: repo.dir,
      branch: await repo.currentBranch(),
      remote: origin
        ? origin.kind === 'fs'
          ? { name: 'origin', kind: 'fs', label: origin.path }
          : { name: 'origin', kind: 'drive', label: 'Google Drive', folderId: origin.folderId }
        : null,
    };
  }

  async listRepos(): Promise<RepoSummary[]> {
    const out: RepoSummary[] = [];
    for (const r of this.registry) {
      try {
        out.push(await this.summary(r.id));
      } catch {
        out.push({ id: r.id, name: basename(r.dir), dir: r.dir, branch: null, remote: null });
      }
    }
    return out;
  }

  async createRepo(a: { dir: string; name: string; level?: 'fast' | 'balanced' | 'max'; ignore?: string[] }) {
    await mkdir(a.dir, { recursive: true });
    const { repo, repoKey } = await Repository.init(a.dir, { name: a.name, user: this.me(), level: a.level });
    this.saveKeys(repo.config.repoId, new Map([[1, repoKey]]));
    if (a.ignore?.length) {
      let text = await this.readIgnoreText(repo.dir);
      for (const id of a.ignore) text = setPreset(text, id, true);
      await writeFile(join(repo.dir, '.vdignore'), text);
    }
    // A first commit gives the repo a starting point to publish. Only the ignore rules go in; the
    // project's own files stay as ordinary changes for the user to review.
    await repo.commit({ summary: 'Initial commit', description: 'Added .vdignore', paths: ['.vdignore'] });
    return this.register(repo);
  }

  async addExisting(dir: string) {
    const config = JSON.parse(await readFile(join(dir, '.vdriver', 'config.json'), 'utf8')) as { repoId: string };
    const repo = await Repository.open(dir, this.loadKeys(config.repoId));
    return this.register(repo);
  }

  async removeRepo(id: string) {
    await this.deactivate(id);
    this.ctxs.delete(id);
    this.registry = this.registry.filter((r) => r.id !== id);
    await this.saveRegistry();
    deleteSecret(`repokey:${id}`);
  }

  // ---- remotes ---------------------------------------------------------------

  private async backendFor(c: Ctx): Promise<Backend | null> {
    if (c.backend) return c.backend;
    const origin = c.repo.config.remotes.origin;
    if (!origin) return null;
    if (origin.kind === 'fs') c.backend = new FsStorage(origin.path);
    else {
      c.drive = await new DriveBackend({ getToken: getAccessToken, rootFolderId: origin.folderId }).init();
      c.backend = c.drive;
    }
    return c.backend;
  }

  private async remote(id: string): Promise<{ c: Ctx; client: RemoteClient; backend: Backend }> {
    const c = await this.ctx(id);
    const backend = await this.backendFor(c);
    if (!backend) throw new Error('This repository has no remote yet. Publish it to Google Drive or set a folder remote first.');
    c.client ??= new RemoteClient(backend, c.repo.store, this.me());
    return { c, client: c.client, backend };
  }

  async setRemoteFolder(id: string, path: string) {
    const { repo } = await this.ctx(id);
    await mkdir(path, { recursive: true });
    const backend = new FsStorage(path);
    const keys = this.loadKeys(id);
    if (!(await backend.has('repo.json'))) {
      await publishRepo({ backend, repoId: repo.config.repoId, name: repo.config.name, repoKeys: keys, identity: this.identity, me: this.me() });
    }
    repo.config.remotes.origin = { kind: 'fs', path };
    await repo.saveConfig();
    const c = await this.ctx(id);
    c.backend = undefined;
    c.client = undefined;
    return this.summary(id);
  }

  async publishToDrive(id: string) {
    if (this.profile?.mode !== 'google') throw new Error('Sign in with Google to publish to Drive.');
    const c = await this.ctx(id);
    const folderId = await createRepoFolder(getAccessToken, c.repo.config.name);
    await tagRepoFolder(getAccessToken, folderId);
    c.drive = await new DriveBackend({ getToken: getAccessToken, rootFolderId: folderId }).init();
    c.backend = c.drive;
    await publishRepo({
      backend: c.backend, repoId: c.repo.config.repoId, name: c.repo.config.name,
      repoKeys: this.loadKeys(id), identity: this.identity, me: this.me(),
    });
    c.repo.config.remotes.origin = { kind: 'drive', folderId };
    await c.repo.saveConfig();
    c.client = undefined;
    return this.summary(id);
  }

  async listDriveRepos() {
    return listRepoFolders(getAccessToken);
  }

  private async cloneWith(backend: Backend, dir: string, remote: Parameters<typeof cloneRepo>[0]['remote']) {
    const me = this.me();
    const members = await listMembers(backend);
    const mine = members.find((m) => m.id === me.id);
    if (!mine) await requestJoin(backend, this.identity, me);
    if (!mine || mine.status !== 'active') {
      throw Object.assign(new Error('Access requested. Waiting for an admin to approve you.'), { code: 'pending' });
    }
    await mkdir(dir, { recursive: true });
    const { repo } = await cloneRepo({
      backend, dir, identity: this.identity, me, remote,
      onProgress: (p) => this.emit('progress', { repoId: '', phase: p.phase, done: p.done, total: p.total, bytes: p.bytes }),
    });
    this.saveKeys(repo.config.repoId, repo.keyringEpochs());
    return this.register(repo);
  }

  async cloneFromDrive(a: { folderId: string; dir: string }) {
    const drive = await new DriveBackend({ getToken: getAccessToken, rootFolderId: a.folderId }).init();
    const summary = await this.cloneWith(drive, a.dir, { kind: 'drive', folderId: a.folderId });
    const c = await this.ctx(summary.id);
    c.drive = drive;
    c.backend = drive;
    return summary;
  }

  async cloneFromFolder(a: { path: string; dir: string }) {
    return this.cloneWith(new FsStorage(a.path), a.dir, { kind: 'fs', path: a.path });
  }

  async requestJoin(id: string) {
    const { backend } = await this.remote(id);
    await requestJoin(backend, this.identity, this.me());
  }

  // ---- activation: watchers, heartbeat ---------------------------------------

  async activate(id: string) {
    if (this.active && this.active !== id) await this.deactivate(this.active);
    this.active = id;
    const c = await this.ctx(id);
    if (!c.fsWatcher) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        c.fsWatcher = fsWatch(c.repo.dir, { recursive: true }, (_e, name) => {
          if (name && /(^|[\\/])\.vdriver([\\/]|$)/.test(name)) return;
          clearTimeout(timer);
          timer = setTimeout(() => this.emit('repo:changed', { repoId: id }), 250);
        });
        c.fsWatcher.on('error', () => undefined);
      } catch {
        /* recursive watch unsupported here - the UI still refreshes on focus */
      }
    }
    if (!c.repo.config.remotes.origin) return;
    let remote;
    try {
      remote = await this.remote(id);
    } catch {
      return; // offline or signed out: local features keep working
    }
    if (c.watcher) return;
    const w = new RemoteWatcher(remote.backend, remote.client, c.repo.store);
    w.on('refs', async (pushes) => {
      const byBranch = new Map<string, { who: string; n: number }>();
      for (const p of pushes) byBranch.set(p.branch, { who: p.user, n: (byBranch.get(p.branch)?.n ?? 0) + 1 });
      try {
        await remote.client.fetch(c.repo);
      } catch {
        /* surfaced on next explicit fetch */
      }
      const members = await listMembers(remote.backend).catch(() => []);
      for (const [branch, v] of byBranch) {
        this.emit('remote:push', { repoId: id, who: members.find((m) => m.id === v.who)?.name ?? 'A teammate', branch, count: v.n });
      }
      this.emit('repo:changed', { repoId: id });
    });
    w.on('members', () => this.emit('members:changed', { repoId: id }));
    w.on('presence', (online) => this.emit('presence:changed', { repoId: id, online: online.map((p) => ({ id: p.id, name: p.name, branch: p.branch })) }));
    w.on('locks', (locks) => this.emit('locks:changed', { repoId: id, locks: locks.map((l) => this.lockDto(l)) }));
    w.on('error', () => undefined);
    c.watcher = w;
    w.start();
    const beat = async () => heartbeat(remote.backend, { id: this.me().id, name: this.me().name, branch: (await c.repo.currentBranch()) ?? undefined }).catch(() => undefined);
    void beat();
    c.heartbeat = setInterval(beat, 20_000);
  }

  setFocused(focused: boolean) {
    const c = this.active ? this.ctxs.get(this.active) : undefined;
    c?.watcher?.setFocused(focused);
  }

  async deactivate(id: string) {
    const c = this.ctxs.get(id);
    if (!c) return;
    c.watcher?.stop();
    c.watcher = undefined;
    c.fsWatcher?.close();
    c.fsWatcher = undefined;
    if (c.heartbeat) clearInterval(c.heartbeat);
    c.heartbeat = undefined;
    if (c.backend && this.profile) await clearPresence(c.backend, this.me().id).catch(() => undefined);
    if (this.active === id) this.active = null;
  }

  async shutdown() {
    for (const id of [...this.ctxs.keys()]) await this.deactivate(id);
  }

  // ---- working tree & history ------------------------------------------------

  private dto(c: { path: string; status: ChangeDTO['status']; size: number; oldSize?: number }): ChangeDTO {
    return { ...c, kind: kindOf(c.path) };
  }

  async status(id: string) {
    return (await (await this.repo(id)).status()).map((c) => this.dto(c));
  }

  async commit(id: string, a: { summary: string; description: string; paths: string[] }): Promise<CommitDTO> {
    const repo = await this.repo(id);
    const c = await repo.commit({ summary: a.summary, description: a.description, paths: a.paths });
    this.emit('repo:changed', { repoId: id });
    return toCommit(c);
  }

  async log(id: string, a: { limit?: number; branch?: string } = {}) {
    return (await (await this.repo(id)).log({ limit: a.limit ?? 300, from: a.branch })).map(toCommit);
  }

  async commitChanges(id: string, commitId: string) {
    return (await (await this.repo(id)).changesInCommit(commitId)).map((c) => this.dto(c));
  }

  private urlFor(id: string, rev: string, path: string) {
    return `vdfile://repo/${id}/${rev}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  async fileDiff(id: string, a: { path: string; from: string | null; to: string }): Promise<FileDiff> {
    const repo = await this.repo(id);
    const oldRec = a.from ? (await repo.snapshotOf(a.from)).get(a.path) : undefined;
    let newSize: number | undefined;
    let newHead: Uint8Array | undefined;
    if (a.to === 'working') {
      try {
        const abs = join(repo.dir, ...a.path.split('/'));
        newSize = (await stat(abs)).size;
        newHead = new Uint8Array((await readFile(abs)).subarray(0, 8192));
      } catch {
        /* deleted in working tree */
      }
    } else {
      const rec = (await repo.snapshotOf(a.to)).get(a.path);
      if (rec) {
        newSize = rec.size;
        newHead = rec.chunks[0] ? (await repo.store.get(rec.chunks[0])).subarray(0, 8192) : new Uint8Array();
      }
    }
    const oldHead = oldRec?.chunks[0] ? (await repo.store.get(oldRec.chunks[0])).subarray(0, 8192) : undefined;
    const status = !oldRec ? 'added' : newSize === undefined ? 'deleted' : 'modified';
    let kind = kindOf(a.path);
    if (kind === 'text' && ((newHead && looksBinary(newHead)) || (oldHead && looksBinary(oldHead)))) kind = 'binary';

    const out: FileDiff = {
      path: a.path, kind, mime: mimeOf(a.path), status, size: newSize ?? 0, oldSize: oldRec?.size,
      oldUrl: oldRec ? this.urlFor(id, a.from!, a.path) : undefined,
      newUrl: newSize !== undefined ? this.urlFor(id, a.to, a.path) : undefined,
    };
    if (kind === 'text') {
      if ((newSize ?? 0) > MAX_DIFF_BYTES || (oldRec?.size ?? 0) > MAX_DIFF_BYTES) out.tooLarge = true;
      else {
        const [o, n] = await Promise.all([this.bytes(id, a.from, a.path), newSize === undefined ? undefined : this.bytes(id, a.to, a.path)]);
        out.rows = textRows(o ? dec(o) : '', n ? dec(n) : '');
      }
    }
    return out;
  }

  /** File bytes at a commit id, or from disk when rev === 'working'. */
  async bytes(id: string, rev: string | null, path: string): Promise<Uint8Array | undefined> {
    if (!rev) return undefined;
    const repo = await this.repo(id);
    const key = `${id}:${rev}:${path}`;
    if (this.fileCache?.key === key) return this.fileCache.bytes;
    let bytes: Uint8Array | undefined;
    if (rev === 'working') {
      try {
        bytes = new Uint8Array(await readFile(join(repo.dir, ...path.split('/'))));
      } catch {
        bytes = undefined;
      }
    } else bytes = await repo.readFileAt(rev, path);
    if (bytes && bytes.length < 200 * 1024 * 1024) this.fileCache = { key, bytes };
    return bytes;
  }

  async readText(id: string, a: { rev: string; path: string }) {
    const bytes = await this.bytes(id, a.rev, a.path);
    if (!bytes) return null;
    const limit = 2 * 1024 * 1024;
    return { text: dec(bytes.subarray(0, limit)), truncated: bytes.length > limit };
  }

  async discard(id: string, paths?: string[]) {
    await (await this.repo(id)).discard(paths);
    this.fileCache = null;
    this.emit('repo:changed', { repoId: id });
  }

  async restoreFile(id: string, a: { path: string; commitId: string }) {
    await (await this.repo(id)).restoreFile(a.path, a.commitId);
    this.fileCache = null;
    this.emit('repo:changed', { repoId: id });
  }

  async revealInFolder(id: string, path: string) {
    shell.showItemInFolder(join((await this.repo(id)).dir, ...path.split('/')));
  }

  // ---- ignore rules ----------------------------------------------------------

  private async readIgnoreText(dir: string) {
    try {
      return await readFile(join(dir, '.vdignore'), 'utf8');
    } catch {
      return DEFAULT_IGNORE;
    }
  }

  ignorePresets(): IgnorePresetDTO[] {
    return IGNORE_PRESETS.map((p) => ({ id: p.id, name: p.name, description: p.description }));
  }

  ignoreDetect(dir: string) {
    return detectPresets(dir);
  }

  async ignoreRead(id: string): Promise<IgnoreInfo> {
    const text = await this.readIgnoreText((await this.repo(id)).dir);
    return { text, applied: appliedPresets(text) };
  }

  ignoreEdit(text: string, presetId: string, on: boolean): IgnoreInfo {
    const next = setPreset(text, presetId, on);
    return { text: next, applied: appliedPresets(next) };
  }

  async ignoreWrite(id: string, text: string) {
    await writeFile(join((await this.repo(id)).dir, '.vdignore'), text);
    this.emit('repo:changed', { repoId: id });
  }

  async ignoreAdd(id: string, pattern: string) {
    const dir = (await this.repo(id)).dir;
    await writeFile(join(dir, '.vdignore'), addPattern(await this.readIgnoreText(dir), pattern));
    this.emit('repo:changed', { repoId: id });
  }

  // ---- branches --------------------------------------------------------------

  async branches(id: string): Promise<BranchDTO[]> {
    const repo = await this.repo(id);
    const current = await repo.currentBranch();
    const remote = await repo.remoteTips('origin');
    const local = await repo.listBranches();
    const out: BranchDTO[] = local.map((b) => ({ name: b.name, tip: b.tip, current: b.name === current, remoteTip: remote[b.name] }));
    for (const [name, tip] of Object.entries(remote)) if (!local.some((b) => b.name === name)) out.push({ name, tip, current: false, remoteTip: tip });
    return out;
  }

  async createBranch(id: string, name: string, from?: string) {
    const repo = await this.repo(id);
    const remoteTip = (await repo.remoteTips('origin'))[from ?? ''];
    await repo.createBranch(name, remoteTip ?? from);
  }

  async deleteBranch(id: string, name: string) {
    await (await this.repo(id)).deleteBranch(name);
  }

  private async afterMove(id: string) {
    this.fileCache = null;
    this.emit('repo:changed', { repoId: id });
  }

  async checkout(id: string, ref: string, force?: boolean) {
    const repo = await this.repo(id);
    // Checking out a branch that only exists on the remote creates a local branch tracking it.
    if (!(await repo.branchTip(ref))) {
      const tip = (await repo.remoteTips('origin'))[ref];
      if (tip) await repo.setBranchTip(ref, tip);
    }
    await repo.checkout(ref, { force });
    await this.afterMove(id);
  }

  async merge(id: string, ref: string, resolutions?: Record<string, 'ours' | 'theirs'>) {
    const repo = await this.repo(id);
    // "origin/<branch>" means the last fetched remote tip of that branch
    if (ref.startsWith('origin/')) ref = (await repo.remoteTips('origin'))[ref.slice(7)] ?? ref;
    const r = await repo.merge(ref, { resolutions });
    await this.afterMove(id);
    return { kind: r.kind };
  }

  async revert(id: string, commitId: string, resolutions?: Record<string, 'keep' | 'revert'>) {
    const c = await (await this.repo(id)).revert(commitId, { resolutions });
    await this.afterMove(id);
    return toCommit(c);
  }

  async resetTo(id: string, commitId: string, hard: boolean) {
    await (await this.repo(id)).reset(commitId, { hard });
    await this.afterMove(id);
  }

  // ---- sync ------------------------------------------------------------------

  async syncState(id: string): Promise<SyncState> {
    const c = await this.ctx(id);
    const branch = await c.repo.currentBranch();
    if (!c.repo.config.remotes.origin || !branch) return { hasRemote: !!c.repo.config.remotes.origin, branch, ahead: 0, behind: 0 };
    const tips = await c.repo.remoteTips('origin');
    const local = await c.repo.branchTip(branch);
    const remoteTip = tips[branch];
    let ahead = 0;
    let behind = 0;
    if (local && !remoteTip) ahead = (await c.repo.ancestors(local)).size;
    else if (local && remoteTip && (await c.repo.store.has(remoteTip))) {
      const a = await c.repo.ancestors(local);
      const b = await c.repo.ancestors(remoteTip);
      ahead = [...a].filter((x) => !b.has(x)).length;
      behind = [...b].filter((x) => !a.has(x)).length;
    }
    return { hasRemote: true, branch, ahead, behind };
  }

  async fetch(id: string) {
    const { c, client } = await this.remote(id);
    const r = await client.fetch(c.repo);
    this.emit('repo:changed', { repoId: id });
    return { updated: r.updated.length };
  }

  async pull(id: string) {
    const { c, client } = await this.remote(id);
    const r = await client.pull(c.repo);
    await this.afterMove(id);
    return { kind: r.kind };
  }

  async push(id: string) {
    const { c, client } = await this.remote(id);
    const branch = await c.repo.currentBranch();
    if (!branch) throw new Error('Check out a branch before pushing');
    const r = await client.push(c.repo, branch, {
      onProgress: (p) => this.emit('progress', { repoId: id, phase: p.phase, done: p.done, total: p.total, bytes: p.bytes }),
    });
    this.emit('repo:changed', { repoId: id });
    return { pushed: r.pushed };
  }

  // ---- sharing ---------------------------------------------------------------

  async members(id: string): Promise<MemberDTO[]> {
    const { backend } = await this.remote(id);
    const [members, online] = await Promise.all([listMembers(backend), listPresence(backend)]);
    const me = this.me().id;
    return members.filter((m) => m.status !== 'removed').map((m) => ({
      id: m.id, name: m.name, email: m.email, role: m.role, status: m.status,
      safety: memberSafetyNumber(m), online: online.some((p) => p.id === m.id), me: m.id === me,
    }));
  }

  async inviteByEmail(id: string, email: string, role: Role) {
    const { c } = await this.remote(id);
    if (!c.drive) return; // folder remotes are shared by sharing the folder itself
    await c.drive.share(email, role === 'viewer' ? 'reader' : 'writer');
  }

  async approveMember(id: string, memberId: string, role: Role) {
    const { backend } = await this.remote(id);
    await coreApprove({ backend, adminId: this.me().id, repoKeys: this.loadKeys(id), memberId, role });
    this.emit('members:changed', { repoId: id });
  }

  async setMemberRole(id: string, memberId: string, role: Role) {
    const { backend } = await this.remote(id);
    await coreSetRole(backend, this.me().id, memberId, role);
    this.emit('members:changed', { repoId: id });
  }

  async removeMember(id: string, memberId: string) {
    const { c, backend } = await this.remote(id);
    const keys = this.loadKeys(id);
    const target = (await listMembers(backend)).find((m) => m.id === memberId);
    const { epoch, key } = await coreRemove({ backend, adminId: this.me().id, memberId, currentEpoch: Math.max(...keys.keys()) });
    keys.set(epoch, key);
    this.saveKeys(id, keys);
    c.repo.keyring.add(epoch, key);
    if (c.drive && target) await c.drive.revoke(target.email).catch(() => undefined);
    this.emit('members:changed', { repoId: id });
  }

  private lockDto(l: { path: string; name: string; since: number; memberId: string }): LockDTO {
    return { path: l.path, name: l.name, since: l.since, mine: l.memberId === this.profile?.id };
  }

  async locks(id: string) {
    const { c, backend } = await this.remote(id);
    return (await listLocks(backend, c.repo.store)).map((l) => this.lockDto(l));
  }

  async lockFile(id: string, path: string) {
    const { c, backend } = await this.remote(id);
    const r = await acquireLock(backend, c.repo.store, this.me(), path);
    return r.ok ? { ok: true } : { ok: false, heldBy: r.heldBy.name };
  }

  async unlockFile(id: string, path: string) {
    const { c, backend } = await this.remote(id);
    await releaseLock(backend, c.repo.store, this.me(), path);
  }

  async comments(id: string, commitId: string) {
    const { c, backend } = await this.remote(id);
    return (await listComments(backend, c.repo.store, commitId)).map((x) => ({ author: x.author.name, text: x.text, time: x.time }));
  }

  async addComment(id: string, commitId: string, text: string) {
    const { c, backend } = await this.remote(id);
    await addComment(backend, c.repo.store, commitId, { id: this.me().id, name: this.me().name }, text);
  }

  // ---- storage ---------------------------------------------------------------

  async storage(id: string): Promise<StorageStats> {
    const { repo } = await this.ctx(id);
    let stored = 0;
    let objects = 0;
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else {
          stored += (await stat(p)).size;
          objects++;
        }
      }
    };
    await walk(join(repo.vd, 'objects'));
    const head = await repo.headId();
    let logical = 0;
    for (const rec of (await repo.snapshotOf(head)).values()) logical += rec.size;
    return { logicalBytes: logical, storedBytes: stored, objects, commits: (await repo.log()).length, level: repo.config.level };
  }

  async setCompression(id: string, level: 'fast' | 'balanced' | 'max') {
    const { repo } = await this.ctx(id);
    repo.config.level = level;
    repo.store.level = level;
    await repo.saveConfig();
  }

  /** Remote metadata, used to show repo names before cloning. */
  async remoteName(backend: Backend) {
    return (await readRepoMeta(backend)).name;
  }
}

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function toCommit(c: { id: string; summary: string; description: string; author: Author; time: number; parents: string[] }): CommitDTO {
  return { id: c.id, summary: c.summary, description: c.description, author: c.author, time: c.time, parents: c.parents };
}
