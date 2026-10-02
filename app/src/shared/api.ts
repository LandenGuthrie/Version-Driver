// Types shared by the main process, the preload bridge and the renderer.

export type FileKind = 'text' | 'image' | 'audio' | 'video' | 'binary';
export type ChangeStatus = 'added' | 'modified' | 'deleted';
export type Role = 'owner' | 'admin' | 'editor' | 'viewer';

export interface Profile {
  id: string;
  name: string;
  email: string;
  picture?: string;
  mode: 'google' | 'local';
}

export interface RemoteInfo {
  name: string;
  kind: 'fs' | 'drive';
  label: string;
  folderId?: string;
}

export interface RepoSummary {
  id: string;
  name: string;
  dir: string;
  branch: string | null;
  remote: RemoteInfo | null;
}

export interface ChangeDTO {
  path: string;
  status: ChangeStatus;
  size: number;
  oldSize?: number;
  kind: FileKind;
}

export interface CommitDTO {
  id: string;
  summary: string;
  description: string;
  author: { name: string; email: string; id?: string };
  time: number;
  parents: string[];
}

export interface DiffRow {
  t: 'ctx' | 'add' | 'del';
  /** old / new line numbers */
  o?: number;
  n?: number;
  s: string;
}

export interface FileDiff {
  path: string;
  kind: FileKind;
  mime: string;
  status: ChangeStatus;
  size: number;
  oldSize?: number;
  rows?: DiffRow[];
  /** text too large to diff inline */
  tooLarge?: boolean;
  oldUrl?: string;
  newUrl?: string;
}

export interface SyncState {
  hasRemote: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
}

export interface BranchDTO {
  name: string;
  tip: string;
  current: boolean;
  remoteTip?: string;
}

export interface MemberDTO {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: 'pending' | 'active' | 'removed';
  safety: string;
  online: boolean;
  me: boolean;
}

export interface IgnorePresetDTO {
  id: string;
  name: string;
  description: string;
}

export interface IgnoreInfo {
  text: string;
  /** ids of presets currently switched on */
  applied: string[];
}

export interface StorageStats {
  logicalBytes: number;
  storedBytes: number;
  objects: number;
  commits: number;
  level: 'fast' | 'balanced' | 'max';
}

export interface LockDTO {
  path: string;
  name: string;
  since: number;
  mine: boolean;
}

export interface PushEvent {
  repoId: string;
  who: string;
  branch: string;
  count: number;
}

export interface Progress {
  repoId: string;
  phase: string;
  done: number;
  total: number;
  bytes: number;
}

export interface Events {
  'repo:changed': { repoId: string };
  'remote:push': PushEvent;
  'members:changed': { repoId: string };
  'presence:changed': { repoId: string; online: { id: string; name: string; branch?: string }[] };
  'locks:changed': { repoId: string; locks: LockDTO[] };
  progress: Progress;
  focus: { focused: boolean };
  deeplink: { url: string };
  'update:ready': { version: string };
}

export interface VdApi {
  platform: 'win32' | 'darwin' | 'linux';
  googleConfigured(): Promise<boolean>;
  /** Match the native window-control strip (Windows/Linux) to the theme. */
  setTitleBar(color: string, symbolColor: string): Promise<void>;
  /** Restart into a downloaded update. */
  installUpdate(): Promise<void>;

  // account
  getProfile(): Promise<Profile | null>;
  signInGoogle(): Promise<Profile>;
  cancelSignIn(): Promise<void>;
  continueLocal(name: string, email: string): Promise<Profile>;
  signOut(): Promise<void>;

  // repositories
  listRepos(): Promise<RepoSummary[]>;
  pickFolder(): Promise<string | null>;
  createRepo(a: { dir: string; name: string; level?: 'fast' | 'balanced' | 'max'; ignore?: string[] }): Promise<RepoSummary>;
  addExisting(dir: string): Promise<RepoSummary>;
  /** Forget a repository. Project files are never deleted; deleteHistory also removes the .vdriver folder. */
  removeRepo(id: string, opts?: { deleteHistory?: boolean }): Promise<void>;
  setRemoteFolder(id: string, path: string): Promise<RepoSummary>;
  publishToDrive(id: string): Promise<RepoSummary>;
  listDriveRepos(): Promise<{ folderId: string; name: string }[]>;
  cloneFromDrive(a: { folderId: string; dir: string }): Promise<RepoSummary>;
  cloneFromFolder(a: { path: string; dir: string }): Promise<RepoSummary>;

  /** Start live updates (watchers, presence) for the repo being viewed. */
  activate(id: string): Promise<void>;

  // working tree & history
  status(id: string): Promise<ChangeDTO[]>;
  commit(id: string, a: { summary: string; description: string; paths: string[] }): Promise<CommitDTO>;
  log(id: string, a?: { limit?: number; branch?: string }): Promise<CommitDTO[]>;
  commitChanges(id: string, commitId: string): Promise<ChangeDTO[]>;
  fileDiff(id: string, a: { path: string; from: string | null; to: string }): Promise<FileDiff>;
  readText(id: string, a: { rev: string; path: string }): Promise<{ text: string; truncated: boolean } | null>;
  discard(id: string, paths?: string[]): Promise<void>;
  restoreFile(id: string, a: { path: string; commitId: string }): Promise<void>;
  revealInFolder(id: string, path: string): Promise<void>;

  // ignore rules (.vdignore)
  ignorePresets(): Promise<IgnorePresetDTO[]>;
  /** Presets that suit what's in this folder (Unity, Unreal, Rider…). */
  ignoreDetect(dir: string): Promise<string[]>;
  ignoreRead(id: string): Promise<IgnoreInfo>;
  /** Pure helper: switch a preset on/off inside some .vdignore text. */
  ignoreEdit(text: string, presetId: string, on: boolean): Promise<IgnoreInfo>;
  ignoreWrite(id: string, text: string): Promise<void>;
  ignoreAdd(id: string, pattern: string): Promise<void>;

  // branches
  branches(id: string): Promise<BranchDTO[]>;
  createBranch(id: string, name: string, from?: string): Promise<void>;
  deleteBranch(id: string, name: string): Promise<void>;
  checkout(id: string, ref: string, force?: boolean): Promise<void>;
  merge(id: string, ref: string, resolutions?: Record<string, 'ours' | 'theirs'>): Promise<{ kind: string }>;
  revert(id: string, commitId: string, resolutions?: Record<string, 'keep' | 'revert'>): Promise<CommitDTO>;
  resetTo(id: string, commitId: string, hard: boolean): Promise<void>;

  // sync
  syncState(id: string): Promise<SyncState>;
  fetch(id: string): Promise<{ updated: number }>;
  pull(id: string): Promise<{ kind: string }>;
  push(id: string): Promise<{ pushed: number }>;

  // sharing & collaboration
  members(id: string): Promise<MemberDTO[]>;
  inviteByEmail(id: string, email: string, role: Role): Promise<void>;
  approveMember(id: string, memberId: string, role: Role): Promise<void>;
  setMemberRole(id: string, memberId: string, role: Role): Promise<void>;
  removeMember(id: string, memberId: string): Promise<void>;
  requestJoin(id: string): Promise<void>;
  locks(id: string): Promise<LockDTO[]>;
  lockFile(id: string, path: string): Promise<{ ok: boolean; heldBy?: string }>;
  unlockFile(id: string, path: string): Promise<void>;
  comments(id: string, commitId: string): Promise<{ author: string; text: string; time: number }[]>;
  addComment(id: string, commitId: string, text: string): Promise<void>;

  // storage
  storage(id: string): Promise<StorageStats>;
  setCompression(id: string, level: 'fast' | 'balanced' | 'max'): Promise<void>;

  on<E extends keyof Events>(event: E, cb: (payload: Events[E]) => void): () => void;
}

declare global {
  interface Window {
    vd: VdApi;
  }
}
