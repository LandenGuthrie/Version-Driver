import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initCrypto, Repository, FsStorage, generateIdentity, RemoteClient, PushRejectedError, cloneRepo,
  publishRepo, requestJoin, approveMember, removeMember, listMembers, listPresence, heartbeat,
  acquireLock, releaseLock, addComment, listComments, RemoteWatcher, foldRefs, readMyKeys,
  memberSafetyNumber, type LogItem,
} from '../src/index.js';

let root: string, aliceDir: string, bobDir: string, carolDir: string, remoteDir: string;
let backend: FsStorage;
const A = { id: 'alice', name: 'Alice', email: 'a@x.com' };
const B = { id: 'bob', name: 'Bob', email: 'b@x.com' };
const C = { id: 'carol', name: 'Carol', email: 'c@x.com' };

beforeAll(() => initCrypto());
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vdc-'));
  [aliceDir, bobDir, carolDir, remoteDir] = ['alice', 'bob', 'carol', 'remote'].map((n) => join(root, n)) as [string, string, string, string];
  backend = new FsStorage(remoteDir);
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function setup() {
  await mkdir(aliceDir, { recursive: true });
  const aliceId = generateIdentity();
  const { repo, repoKey } = await Repository.init(aliceDir, { name: 'proj', user: A });
  await writeFile(join(aliceDir, 'readme.txt'), 'secret plans for world domination\n');
  await repo.commit({ summary: 'init' });
  const keys = new Map([[1, repoKey]]);
  await publishRepo({ backend, repoId: repo.config.repoId, name: 'proj', repoKeys: keys, identity: aliceId, me: A });
  const aliceClient = new RemoteClient(backend, repo.store, A);
  await aliceClient.push(repo, 'main');
  return { repo, aliceId, keys, aliceClient };
}

async function joiner(dir: string, me: typeof B) {
  await mkdir(dir, { recursive: true });
  const identity = generateIdentity();
  await requestJoin(backend, identity, me);
  return { identity, clone: () => cloneRepo({ backend, dir, identity, me, remote: { kind: 'fs', path: remoteDir } }) };
}

describe('sharing + sync', () => {
  it('invite flow: pending until approved, then clone works', async () => {
    const { keys } = await setup();
    const bob = await joiner(bobDir, B);
    await expect(bob.clone()).rejects.toThrow(/pending/);
    const pending = (await listMembers(backend)).find((m) => m.id === 'bob')!;
    expect(pending.status).toBe('pending');
    expect(memberSafetyNumber(pending)).toMatch(/^([0-9A-F]{4}-){4}[0-9A-F]{4}$/);
    await approveMember({ backend, adminId: 'alice', repoKeys: keys, memberId: 'bob', role: 'editor' });
    const { repo } = await bob.clone();
    expect(await readFile(join(bobDir, 'readme.txt'), 'utf8')).toContain('world domination');
    expect((await repo.log()).map((c) => c.summary)).toEqual(['init']);
  });

  it('non-admins cannot approve', async () => {
    const { keys } = await setup();
    await joiner(bobDir, B);
    await joiner(carolDir, C);
    await approveMember({ backend, adminId: 'alice', repoKeys: keys, memberId: 'bob', role: 'editor' });
    await expect(approveMember({ backend, adminId: 'bob', repoKeys: keys, memberId: 'carol' })).rejects.toThrow(/owner or an admin/);
  });

  it('two people collaborate: push, fetch-first rejection, pull-merge, push', async () => {
    const { repo: aRepo, keys, aliceClient } = await setup();
    const bob = await joiner(bobDir, B);
    await approveMember({ backend, adminId: 'alice', repoKeys: keys, memberId: 'bob' });
    const { repo: bRepo, client: bobClient } = await bob.clone();

    await writeFile(join(aliceDir, 'a.txt'), 'from alice');
    await aRepo.commit({ summary: 'alice work' });
    await writeFile(join(bobDir, 'b.txt'), 'from bob');
    await bRepo.commit({ summary: 'bob work' });

    await aliceClient.push(aRepo, 'main');
    await expect(bobClient.push(bRepo, 'main')).rejects.toBeInstanceOf(PushRejectedError);

    const merged = await bobClient.pull(bRepo);
    expect(merged.kind).toBe('merge');
    expect(await readFile(join(bobDir, 'a.txt'), 'utf8')).toBe('from alice');
    await bobClient.push(bRepo, 'main');

    await aliceClient.fetch(aRepo);
    expect(await aliceClient.aheadBehind(aRepo, 'main')).toEqual({ ahead: 0, behind: 2 });
    const pull = await aliceClient.pull(aRepo);
    expect(pull.kind).toBe('fast-forward');
    expect(await readFile(join(aliceDir, 'b.txt'), 'utf8')).toBe('from bob');
  });

  it('log folding: the later claimant of the same parent loses', () => {
    const mk = (key: string, t: number, parent: string | null, commit: string): LogItem => ({
      key, createdTime: t, branch: 'main', commit, parent, user: 'x', time: t,
    });
    const { tips, rejected } = foldRefs([mk('b', 2, null, 'C2'), mk('a', 1, null, 'C1'), mk('c', 3, 'C1', 'C3')]);
    expect(tips.get('main')).toBe('C3');
    expect([...rejected]).toEqual(['b']);
  });

  it('the remote holds only ciphertext', async () => {
    await setup();
    const walk = async (d: string): Promise<string[]> =>
      (await Promise.all((await readdir(d, { withFileTypes: true })).map((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])))).flat();
    for (const f of await walk(remoteDir)) {
      if (/members|repo\.json|presence/.test(f)) continue;
      const txt = (await readFile(f)).toString('latin1');
      expect(txt.includes('world domination')).toBe(false);
      expect(txt.includes('readme.txt')).toBe(false);
      expect(txt.includes('init')).toBe(false);
    }
  });

  it('removing a member rotates the key; they cannot read new data', async () => {
    const { repo: aRepo, keys, aliceClient } = await setup();
    const carol = await joiner(carolDir, C);
    await approveMember({ backend, adminId: 'alice', repoKeys: keys, memberId: 'carol' });
    const { repo: cRepo } = await carol.clone();

    const { epoch, key } = await removeMember({ backend, adminId: 'alice', memberId: 'carol', currentEpoch: 1 });
    expect(epoch).toBe(2);
    aRepo.keyring.add(epoch, key);
    await writeFile(join(aliceDir, 'new.txt'), 'after rotation');
    const c = await aRepo.commit({ summary: 'post-removal' });
    await aliceClient.push(aRepo, 'main');

    expect((await readMyKeys(backend, carol.identity, 'carol')).size).toBe(0);
    const carolClient = new RemoteClient(backend, cRepo.store, C);
    await carolClient.fetch(cRepo).catch(() => undefined);
    expect(await cRepo.store.has(c.id)).toBe(false);
  });

  it('presence, locks and comments', async () => {
    const { repo } = await setup();
    await heartbeat(backend, { id: 'alice', name: 'Alice', branch: 'main' });
    expect((await listPresence(backend)).map((p) => p.name)).toEqual(['Alice']);

    expect((await acquireLock(backend, repo.store, A, 'mix.wav')).ok).toBe(true);
    const second = await acquireLock(backend, repo.store, B, 'mix.wav');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.heldBy.name).toBe('Alice');
    await releaseLock(backend, repo.store, A, 'mix.wav');
    expect((await acquireLock(backend, repo.store, B, 'mix.wav')).ok).toBe(true);

    const head = (await repo.headId())!;
    await addComment(backend, repo.store, head, A, 'looks good');
    expect((await listComments(backend, repo.store, head)).map((c) => c.text)).toEqual(['looks good']);
  });

  it('watcher announces a teammate push in near real time', async () => {
    const { repo: aRepo, keys, aliceClient } = await setup();
    const bob = await joiner(bobDir, B);
    await approveMember({ backend, adminId: 'alice', repoKeys: keys, memberId: 'bob' });
    const { repo: bRepo, client: bobClient } = await bob.clone();

    const watcher = new RemoteWatcher(backend, aliceClient, aRepo.store, { focusedMs: 50 });
    const seen: string[] = [];
    watcher.on('refs', (items) => items.forEach((i) => seen.push(i.user)));
    watcher.start();
    await new Promise((r) => setTimeout(r, 150));
    await writeFile(join(bobDir, 'live.txt'), 'hi');
    await bRepo.commit({ summary: 'live' });
    await bobClient.push(bRepo, 'main');
    await new Promise((r) => setTimeout(r, 500));
    watcher.stop();
    expect(seen).toEqual(['bob']);
  });
});
