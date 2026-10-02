// Multi-user layer: members, invites (join requests), key wrapping, key rotation,
// presence, advisory file locks and commit comments. All of it is plain files on the
// Backend, so it works the same on Google Drive or a test folder.
//
// Drive folder permissions are the real access control (viewer/editor). The files here
// carry the cryptographic side: who holds which key epoch.
import type { Backend } from './storage.js';
import {
  b64, fromB64, generateRepoKey, hex, randomBytes, safetyNumber, unwrapKey, wrapKeyFor, type Identity,
} from './crypto.js';
import type { ObjectStore } from './objects.js';
import type { RepoMeta } from './sync.js';

export type Role = 'owner' | 'admin' | 'editor' | 'viewer';
export type MemberStatus = 'pending' | 'active' | 'removed';

export interface Member {
  id: string;
  name: string;
  email: string;
  publicKey: string;
  role: Role;
  status: MemberStatus;
  requestedAt: number;
  approvedBy?: string;
}

const te = new TextEncoder();
const td = new TextDecoder();
const putJson = (b: Backend, key: string, v: unknown) => b.put(key, te.encode(JSON.stringify(v)));
async function getJson<T>(b: Backend, key: string): Promise<T | undefined> {
  const raw = await b.get(key);
  return raw ? (JSON.parse(td.decode(raw)) as T) : undefined;
}

export const memberSafetyNumber = (m: Pick<Member, 'publicKey'>) => safetyNumber(fromB64(m.publicKey));
export const canManage = (m?: Member) => !!m && m.status === 'active' && (m.role === 'owner' || m.role === 'admin');
export const canWrite = (m?: Member) => !!m && m.status === 'active' && m.role !== 'viewer';

// ---- creating & joining ----------------------------------------------------------

export async function publishRepo(opts: {
  backend: Backend;
  repoId: string;
  name: string;
  repoKeys: Map<number, Uint8Array>;
  identity: Identity;
  me: { id: string; name: string; email: string };
  defaultBranch?: string;
}) {
  const { backend, me } = opts;
  const meta: RepoMeta = {
    formatVersion: 1,
    repoId: opts.repoId,
    name: opts.name,
    defaultBranch: opts.defaultBranch ?? 'main',
    createdBy: me.id,
    createdAt: Date.now(),
  };
  await putJson(backend, 'repo.json', meta);
  const member: Member = {
    id: me.id, name: me.name, email: me.email, publicKey: b64(opts.identity.publicKey),
    role: 'owner', status: 'active', requestedAt: Date.now(), approvedBy: me.id,
  };
  await putJson(backend, `members/${me.id}.json`, member);
  for (const [epoch, key] of opts.repoKeys) await backend.put(`keys/${epoch}/${me.id}`, wrapKeyFor(opts.identity.publicKey, key));
  return meta;
}

/** A new person announces themselves. They get no key until an admin approves. */
export async function requestJoin(backend: Backend, identity: Identity, me: { id: string; name: string; email: string }) {
  const member: Member = {
    id: me.id, name: me.name, email: me.email, publicKey: b64(identity.publicKey),
    role: 'editor', status: 'pending', requestedAt: Date.now(),
  };
  await putJson(backend, `members/${me.id}.json`, member);
  return member;
}

export async function listMembers(backend: Backend): Promise<Member[]> {
  const out: Member[] = [];
  for (const f of await backend.list('members/')) {
    const m = await getJson<Member>(backend, f.key);
    if (m) out.push(m);
  }
  return out.sort((a, b) => a.requestedAt - b.requestedAt);
}

async function requireManager(backend: Backend, adminId: string) {
  const admin = await getJson<Member>(backend, `members/${adminId}.json`);
  if (!canManage(admin)) throw new Error('Only the owner or an admin can manage members');
  return admin!;
}

/** Admin approves a pending member: wraps every key epoch for them and activates the record. */
export async function approveMember(opts: {
  backend: Backend;
  adminId: string;
  repoKeys: Map<number, Uint8Array>;
  memberId: string;
  role?: Role;
}) {
  const { backend } = opts;
  await requireManager(backend, opts.adminId);
  const m = await getJson<Member>(backend, `members/${opts.memberId}.json`);
  if (!m) throw new Error('No such join request');
  for (const [epoch, key] of opts.repoKeys) await backend.put(`keys/${epoch}/${m.id}`, wrapKeyFor(fromB64(m.publicKey), key));
  const next: Member = { ...m, status: 'active', role: opts.role ?? m.role, approvedBy: opts.adminId };
  await putJson(backend, `members/${m.id}.json`, next);
  return next;
}

export async function setRole(backend: Backend, adminId: string, memberId: string, role: Role) {
  await requireManager(backend, adminId);
  const m = await getJson<Member>(backend, `members/${memberId}.json`);
  if (!m) throw new Error('No such member');
  if (m.role === 'owner' && role !== 'owner') throw new Error('The owner role cannot be changed');
  await putJson(backend, `members/${memberId}.json`, { ...m, role });
}

/**
 * Remove someone and rotate the repo key: new data is sealed under a fresh epoch that the
 * removed member never receives. (They keep whatever they already downloaded - unavoidable.)
 * The caller must also revoke their Drive folder permission. Returns the new epoch + key.
 */
export async function removeMember(opts: {
  backend: Backend;
  adminId: string;
  memberId: string;
  currentEpoch: number;
}) {
  const { backend } = opts;
  await requireManager(backend, opts.adminId);
  const target = await getJson<Member>(backend, `members/${opts.memberId}.json`);
  if (!target) throw new Error('No such member');
  if (target.role === 'owner') throw new Error('The owner cannot be removed');
  await putJson(backend, `members/${target.id}.json`, { ...target, status: 'removed' } satisfies Member);

  const epoch = opts.currentEpoch + 1;
  const key = generateRepoKey();
  for (const m of await listMembers(backend)) {
    if (m.status === 'active') await backend.put(`keys/${epoch}/${m.id}`, wrapKeyFor(fromB64(m.publicKey), key));
  }
  for (const f of await backend.list('keys/')) if (f.key.endsWith(`/${target.id}`)) await backend.delete(f.key);
  return { epoch, key };
}

/** Admin-side: give an existing active member the newest key epoch (e.g. after another rotation). */
export async function wrapEpochFor(backend: Backend, member: Member, epoch: number, key: Uint8Array) {
  await backend.put(`keys/${epoch}/${member.id}`, wrapKeyFor(fromB64(member.publicKey), key));
}

export function unwrapEpochs(identity: Identity, wrapped: Uint8Array) {
  return unwrapKey(identity, wrapped);
}

// ---- presence --------------------------------------------------------------------

export interface Presence {
  id: string;
  name: string;
  branch?: string;
  activity?: string;
  time: number;
}

export async function heartbeat(backend: Backend, p: Omit<Presence, 'time'>) {
  await putJson(backend, `presence/${p.id}.json`, { ...p, time: Date.now() } satisfies Presence);
}

export async function listPresence(backend: Backend, maxAgeMs = 45_000): Promise<Presence[]> {
  const out: Presence[] = [];
  for (const f of await backend.list('presence/')) {
    const p = await getJson<Presence>(backend, f.key);
    if (p && Date.now() - p.time <= maxAgeMs) out.push(p);
  }
  return out;
}

export async function clearPresence(backend: Backend, id: string) {
  await backend.delete(`presence/${id}.json`);
}

// ---- advisory file locks -----------------------------------------------------------

export interface Lock {
  path: string;
  memberId: string;
  name: string;
  since: number;
  ttlMs: number;
}

const LOCK_TTL = 8 * 60 * 60 * 1000;

function lockDir(store: ObjectStore, path: string) {
  return `locks/${store.idOf('meta', te.encode(`lock:${path}`)).slice(0, 24)}/`;
}

export async function listLocks(backend: Backend, store: ObjectStore): Promise<Lock[]> {
  const byDir = new Map<string, Lock[]>();
  for (const f of await backend.list('locks/')) {
    const raw = await backend.get(f.key);
    if (!raw) continue;
    try {
      const l = store.openMeta<Lock>(f.key, raw);
      if (Date.now() - l.since > l.ttlMs) continue;
      const dir = f.key.slice(0, f.key.lastIndexOf('/') + 1);
      (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push({ ...l, since: l.since });
    } catch {
      /* not ours to read */
    }
  }
  // earliest claim wins per path
  return [...byDir.values()].map((ls) => ls.sort((a, b) => a.since - b.since)[0]!);
}

/** Claim a file. Earliest server-ordered claim wins; losers withdraw their claim. */
export async function acquireLock(backend: Backend, store: ObjectStore, me: { id: string; name: string }, path: string) {
  const dir = lockDir(store, path);
  const key = `${dir}${String(Date.now()).padStart(14, '0')}-${me.id}.json`;
  const lock: Lock = { path, memberId: me.id, name: me.name, since: Date.now(), ttlMs: LOCK_TTL };
  await backend.put(key, store.sealMeta(key, lock));
  const claims: { key: string; lock: Lock; t: number }[] = [];
  for (const f of await backend.list(dir)) {
    const raw = await backend.get(f.key);
    if (!raw) continue;
    const l = store.openMeta<Lock>(f.key, raw);
    if (Date.now() - l.since <= l.ttlMs) claims.push({ key: f.key, lock: l, t: f.createdTime });
  }
  claims.sort((a, b) => a.t - b.t || (a.key < b.key ? -1 : 1));
  const winner = claims[0]!;
  if (winner.key === key) return { ok: true as const };
  await backend.delete(key);
  return { ok: false as const, heldBy: winner.lock };
}

export async function releaseLock(backend: Backend, store: ObjectStore, me: { id: string }, path: string) {
  for (const f of await backend.list(lockDir(store, path))) if (f.key.endsWith(`-${me.id}.json`)) await backend.delete(f.key);
}

// ---- comments ----------------------------------------------------------------------

export interface Comment {
  commit: string;
  author: { id: string; name: string };
  text: string;
  time: number;
}

export async function addComment(backend: Backend, store: ObjectStore, commit: string, author: Comment['author'], text: string) {
  const key = `comments/${commit}/${String(Date.now()).padStart(14, '0')}-${hex(randomBytes(3))}.json`;
  await backend.put(key, store.sealMeta(key, { commit, author, text, time: Date.now() } satisfies Comment));
}

export async function listComments(backend: Backend, store: ObjectStore, commit: string): Promise<Comment[]> {
  const out: Comment[] = [];
  for (const f of await backend.list(`comments/${commit}/`)) {
    const raw = await backend.get(f.key);
    if (raw) out.push(store.openMeta<Comment>(f.key, raw));
  }
  return out.sort((a, b) => a.time - b.time);
}
