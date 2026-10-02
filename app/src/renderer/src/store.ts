import { create } from 'zustand';
import { applyTheme, loadTheme, saveTheme, type Theme } from './theme';
import type { BranchDTO, ChangeDTO, CommitDTO, Profile, Progress, RepoSummary, SyncState } from '../../shared/api';

export type Dialog =
  | { t: 'newRepo' }
  | { t: 'clone'; link?: string }
  | { t: 'share' }
  | { t: 'storage' }
  | { t: 'publish' }
  | { t: 'newBranch' }
  | { t: 'settings' }
  | { t: 'ignore' }
  | { t: 'removeRepo' }
  | { t: 'conflict'; op: 'merge' | 'revert'; ref: string; paths: string[] }
  | { t: 'confirm'; title: string; body: string; confirmLabel: string; danger?: boolean; run: () => Promise<void> };

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'ok';
  text: string;
  action?: { label: string; run: () => void };
}

const ls = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

interface S {
  ready: boolean;
  googleConfigured: boolean;
  profile: Profile | null;
  repos: RepoSummary[];
  repoId: string | null;
  tab: 'changes' | 'history';
  changes: ChangeDTO[];
  unchecked: Set<string>;
  focusPath: string | null;
  commits: CommitDTO[];
  selectedCommit: string | null;
  commitFiles: ChangeDTO[];
  commitFile: string | null;
  branches: BranchDTO[];
  sync: SyncState;
  online: { id: string; name: string; branch?: string }[];
  progress: Progress | null;
  busy: string | null;
  summary: string;
  description: string;
  dialog: Dialog | null;
  toasts: Toast[];
  theme: Theme;

  boot(): Promise<void>;
  signIn(): Promise<void>;
  continueLocal(name: string, email: string): Promise<void>;
  signOut(): Promise<void>;
  selectRepo(id: string | null): Promise<void>;
  reloadRepos(): Promise<void>;
  refresh(): Promise<void>;
  setTab(t: 'changes' | 'history'): void;
  toggleChecked(path: string): void;
  setAllChecked(on: boolean): void;
  focus(path: string | null): void;
  selectCommit(id: string | null): Promise<void>;
  setCommitFile(path: string | null): void;
  setSummary(s: string): void;
  setDescription(s: string): void;
  commit(): Promise<void>;
  doSync(kind: 'fetch' | 'pull' | 'push'): Promise<void>;
  checkout(ref: string): Promise<void>;
  openDialog(d: Dialog | null): void;
  toast(t: Omit<Toast, 'id'>): void;
  dismissToast(id: number): void;
  setTheme(patch: Partial<Theme>): void;
  guard<T>(label: string | null, fn: () => Promise<T>): Promise<T | undefined>;
}

let toastId = 1;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

export const useStore = create<S>((set, get) => ({
  ready: false,
  googleConfigured: false,
  profile: null,
  repos: [],
  repoId: null,
  tab: 'changes',
  changes: [],
  unchecked: new Set(),
  focusPath: null,
  commits: [],
  selectedCommit: null,
  commitFiles: [],
  commitFile: null,
  branches: [],
  sync: { hasRemote: false, branch: null, ahead: 0, behind: 0 },
  online: [],
  progress: null,
  busy: null,
  summary: '',
  description: '',
  dialog: null,
  toasts: [],
  theme: loadTheme(),

  async boot() {
    const vd = window.vd;
    document.documentElement.classList.add(vd.platform === 'darwin' ? 'mac' : vd.platform === 'win32' ? 'win' : 'linux');
    applyTheme(get().theme);
    const [profile, googleConfigured, repos] = await Promise.all([vd.getProfile(), vd.googleConfigured(), vd.listRepos()]);
    set({ profile, googleConfigured, repos, ready: true });

    vd.on('repo:changed', ({ repoId }) => {
      if (repoId !== get().repoId) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void get().refresh(), 120);
    });
    vd.on('remote:push', (p) => {
      if (p.repoId !== get().repoId) return;
      get().toast({
        kind: 'info',
        text: `${p.who} pushed ${p.count === 1 ? 'a commit' : `${p.count} commits`} to ${p.branch}`,
        action: p.branch === get().sync.branch ? { label: 'Pull', run: () => void get().doSync('pull') } : undefined,
      });
    });
    vd.on('presence:changed', (p) => p.repoId === get().repoId && set({ online: p.online.filter((o) => o.id !== get().profile?.id) }));
    vd.on('progress', (p) => {
      if (p.repoId && p.repoId !== get().repoId) return;
      set({ progress: p.done >= p.total ? null : p });
    });
    vd.on('update:ready', ({ version }) =>
      get().toast({ kind: 'info', text: `Version Driver ${version} is ready to install`, action: { label: 'Restart', run: () => void window.vd.installUpdate() } }),
    );
    vd.on('deeplink', ({ url }) => get().openDialog({ t: 'clone', link: url }));
    vd.on('focus', ({ focused }) => focused && get().repoId && void get().refresh());

    if (profile) {
      const last = ls.get('vd.repo');
      const pick = repos.find((r) => r.id === last) ?? repos[0];
      if (pick) await get().selectRepo(pick.id);
    }
  },

  async signIn() {
    const profile = await window.vd.signInGoogle();
    set({ profile });
  },

  async continueLocal(name, email) {
    set({ profile: await window.vd.continueLocal(name, email) });
  },

  async signOut() {
    await window.vd.signOut();
    set({ profile: null, repoId: null, changes: [], commits: [], branches: [] });
  },

  async reloadRepos() {
    set({ repos: await window.vd.listRepos() });
  },

  async selectRepo(id) {
    ls.set('vd.repo', id ?? '');
    set({
      repoId: id, changes: [], commits: [], branches: [], unchecked: new Set(), focusPath: null, selectedCommit: null,
      commitFiles: [], commitFile: null, online: [], summary: '', description: '', tab: 'changes',
      sync: { hasRemote: false, branch: null, ahead: 0, behind: 0 },
    });
    if (!id) return;
    await get().guard('Opening repository', async () => {
      await window.vd.activate(id);
      await get().refresh();
    });
  },

  async refresh() {
    const id = get().repoId;
    if (!id) return;
    const vd = window.vd;
    try {
      const [changes, commits, branches, sync, repos] = await Promise.all([
        vd.status(id), vd.log(id, { limit: 300 }), vd.branches(id), vd.syncState(id), vd.listRepos(),
      ]);
      if (get().repoId !== id) return;
      const paths = new Set(changes.map((c) => c.path));
      const focus = get().focusPath;
      set({
        changes, commits, branches, sync, repos,
        unchecked: new Set([...get().unchecked].filter((p) => paths.has(p))),
        focusPath: focus && paths.has(focus) ? focus : (changes[0]?.path ?? null),
      });
    } catch (e: any) {
      get().toast({ kind: 'error', text: e.message });
    }
  },

  setTab(tab) {
    set({ tab });
    const first = get().commits[0];
    if (tab === 'history' && !get().selectedCommit && first) void get().selectCommit(first.id);
  },

  toggleChecked(path) {
    const u = new Set(get().unchecked);
    u.has(path) ? u.delete(path) : u.add(path);
    set({ unchecked: u });
  },

  setAllChecked(on) {
    set({ unchecked: on ? new Set() : new Set(get().changes.map((c) => c.path)) });
  },

  focus(path) {
    set({ focusPath: path });
  },

  async selectCommit(id) {
    const repoId = get().repoId;
    if (!repoId || !id) return set({ selectedCommit: null, commitFiles: [], commitFile: null });
    set({ selectedCommit: id, commitFiles: [], commitFile: null });
    const files = await window.vd.commitChanges(repoId, id);
    if (get().selectedCommit === id) set({ commitFiles: files, commitFile: files[0]?.path ?? null });
  },

  setCommitFile(path) {
    set({ commitFile: path });
  },

  setSummary: (summary) => set({ summary }),
  setDescription: (description) => set({ description }),

  async commit() {
    const { repoId, changes, unchecked, summary, description } = get();
    if (!repoId) return;
    const paths = changes.filter((c) => !unchecked.has(c.path)).map((c) => c.path);
    const r = await get().guard('Committing', () => window.vd.commit(repoId, { summary, description, paths }));
    if (r) {
      set({ summary: '', description: '' });
      get().toast({ kind: 'ok', text: `Committed “${r.summary}”` });
      await get().refresh();
    }
  },

  async doSync(kind) {
    const id = get().repoId;
    if (!id) return;
    const label = { fetch: 'Fetching', pull: 'Pulling', push: 'Pushing' }[kind];
    try {
      set({ busy: label });
      const r = await window.vd[kind](id);
      if (kind === 'push' && (r as { pushed: number }).pushed === 0) get().toast({ kind: 'ok', text: 'Everything is already up to date' });
      if (kind === 'push' && (r as { pushed: number }).pushed > 0) get().toast({ kind: 'ok', text: 'Pushed to the remote' });
      if (kind === 'pull') get().toast({ kind: 'ok', text: (r as { kind: string }).kind === 'up-to-date' ? 'Already up to date' : 'Pulled the latest changes' });
      await get().refresh();
    } catch (e: any) {
      if (e.code === 'rejected' || e.code === 'conflict') {
        if (e.code === 'conflict') get().openDialog({ t: 'conflict', op: 'merge', ref: 'origin', paths: e.paths ?? [] });
        else get().toast({ kind: 'error', text: 'The remote has newer commits. Pull first, then push again.', action: { label: 'Pull', run: () => void get().doSync('pull') } });
      } else get().toast({ kind: 'error', text: e.message });
    } finally {
      set({ busy: null, progress: null });
    }
  },

  async checkout(ref) {
    const id = get().repoId;
    if (!id) return;
    try {
      set({ busy: 'Switching branch' });
      await window.vd.checkout(id, ref);
      await get().refresh();
    } catch (e: any) {
      if (e.code === 'dirty') {
        get().openDialog({
          t: 'confirm', title: 'You have uncommitted changes',
          body: `Switching to “${ref}” would overwrite changes to: ${(e.paths ?? []).slice(0, 4).join(', ')}. Commit them first, or discard them to switch now.`,
          confirmLabel: 'Discard and switch', danger: true,
          run: async () => {
            await window.vd.checkout(id, ref, true);
            await get().refresh();
          },
        });
      } else get().toast({ kind: 'error', text: e.message });
    } finally {
      set({ busy: null });
    }
  },

  openDialog: (dialog) => set({ dialog }),

  toast(t) {
    const id = toastId++;
    set({ toasts: [...get().toasts, { ...t, id }] });
    setTimeout(() => get().dismissToast(id), t.action ? 9000 : t.kind === 'error' ? 7000 : 3800);
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  setTheme(patch) {
    const theme = { ...get().theme, ...patch };
    applyTheme(theme);
    saveTheme(theme);
    set({ theme });
  },

  async guard(label, fn) {
    try {
      if (label) set({ busy: label });
      return await fn();
    } catch (e: any) {
      get().toast({ kind: 'error', text: e.message ?? String(e) });
      return undefined;
    } finally {
      if (label) set({ busy: null });
    }
  },
}));
