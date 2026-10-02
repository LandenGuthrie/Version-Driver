import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, mkdir, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  initCrypto, Repository, chunkBuffer, generateIdentity, wrapKeyFor, unwrapKey,
  generateRepoKey, wrapWithPassphrase, unwrapWithPassphrase, safetyNumber, identityFromPrivate,
  ConflictError, DirtyTreeError, Ignore,
} from '../src/index.js';

let dir: string;
const user = { name: 'Tester', email: 't@example.com' };

beforeAll(() => initCrypto());
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vd-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const w = (p: string, c: string | Uint8Array) =>
  mkdir(join(dir, ...p.split('/').slice(0, -1)), { recursive: true }).then(() => writeFile(join(dir, ...p.split('/')), c));
const r = (p: string) => readFile(join(dir, ...p.split('/')), 'utf8');

async function dirSize(d: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    n += e.isDirectory() ? await dirSize(p) : (await stat(p)).size;
  }
  return n;
}

describe('chunker', () => {
  it('reassembles and resyncs after an insertion (dedup)', () => {
    const data = randomBytes(3_000_000);
    const chunks = [...chunkBuffer(data)];
    expect(Buffer.concat(chunks).equals(data)).toBe(true);
    const edited = Buffer.concat([data.subarray(0, 1_000_000), Buffer.from('INSERTED'), data.subarray(1_000_000)]);
    const a = new Set([...chunkBuffer(data)].map((c) => Buffer.from(c).toString('base64')));
    const b = [...chunkBuffer(edited)].map((c) => Buffer.from(c).toString('base64'));
    const reused = b.filter((c) => a.has(c)).length;
    expect(reused / b.length).toBeGreaterThan(0.6);
  });
});

describe('crypto', () => {
  it('wraps keys for members and by passphrase', () => {
    const key = generateRepoKey();
    const alice = generateIdentity();
    const bob = generateIdentity();
    const wrapped = wrapKeyFor(alice.publicKey, key);
    expect(unwrapKey(alice, wrapped)).toEqual(key);
    expect(() => unwrapKey(bob, wrapped)).toThrow();
    const blob = wrapWithPassphrase(key, 'correct horse');
    expect(unwrapWithPassphrase(blob, 'correct horse')).toEqual(key);
    expect(() => unwrapWithPassphrase(blob, 'wrong')).toThrow();
    expect(safetyNumber(alice.publicKey)).toMatch(/^([0-9A-F]{4}-){4}[0-9A-F]{4}$/);
  });

  it('restores a device identity from a password-wrapped private key (moving to a new computer)', () => {
    const old = generateIdentity();
    const repoKey = generateRepoKey();
    const wrappedForOldDevice = wrapKeyFor(old.publicKey, repoKey);
    const vault = wrapWithPassphrase(old.privateKey, 'a long password');
    const restored = identityFromPrivate(unwrapWithPassphrase(vault, 'a long password'));
    expect(restored.publicKey).toEqual(old.publicKey);
    expect(unwrapKey(restored, wrappedForOldDevice)).toEqual(repoKey);
    expect(() => unwrapWithPassphrase(vault, 'wrong password')).toThrow();
  });
});

describe('ignore', () => {
  it('matches gitignore-style rules', () => {
    const ig = new Ignore('node_modules/\n*.log\n!keep.log\n/build\n');
    expect(ig.ignores('a/node_modules', true)).toBe(true);
    expect(ig.ignores('x.log', false)).toBe(true);
    expect(ig.ignores('keep.log', false)).toBe(false);
    expect(ig.ignores('build', true)).toBe(true);
    expect(ig.ignores('src/build', true)).toBe(false);
    expect(ig.ignores('.vdriver/config.json', false)).toBe(true);
  });
});

describe('repository', () => {
  it('commits, shows status, reads history and file contents', async () => {
    const { repo } = await Repository.init(dir, { name: 'demo', user });
    await w('hello.txt', 'hello world\n');
    await w('src/a.ts', 'export const a = 1;\n');
    expect((await repo.status()).map((c) => `${c.status}:${c.path}`)).toEqual(['added:.vdignore', 'added:hello.txt', 'added:src/a.ts']);

    const c1 = await repo.commit({ summary: 'First', description: 'the first one' });
    expect(await repo.status()).toEqual([]);

    await w('hello.txt', 'hello there\n');
    await rm(join(dir, 'src', 'a.ts'));
    await w('new.md', '# new');
    const st = await repo.status();
    expect(st.map((c) => `${c.status}:${c.path}`)).toEqual(['modified:hello.txt', 'added:new.md', 'deleted:src/a.ts']);

    // partial commit: only hello.txt
    const c2 = await repo.commit({ summary: 'Tweak hello', paths: ['hello.txt'] });
    expect(c2.parents).toEqual([c1.id]);
    expect((await repo.status()).map((c) => c.path)).toEqual(['new.md', 'src/a.ts']);

    const log = await repo.log();
    expect(log.map((c) => c.summary)).toEqual(['Tweak hello', 'First']);
    expect(Buffer.from((await repo.readFileAt(c1.id, 'hello.txt'))!).toString()).toBe('hello world\n');
    expect(Buffer.from((await repo.readFileAt(c2.id, 'hello.txt'))!).toString()).toBe('hello there\n');
    expect((await repo.changesInCommit(c2.id)).map((c) => c.path)).toEqual(['hello.txt']);
  });

  it('stores only ciphertext and compresses well', async () => {
    const { repo } = await Repository.init(dir, { name: 'demo', user, level: 'max' });
    const text = 'the quick brown fox jumps over the lazy dog\n'.repeat(20000);
    await w('big.txt', text);
    await repo.commit({ summary: 'big' });
    const stored = await dirSize(join(dir, '.vdriver', 'objects'));
    expect(stored).toBeLessThan(text.length / 50);
    // no object file contains the plaintext
    const walk = async (d: string): Promise<string[]> =>
      (await Promise.all((await readdir(d, { withFileTypes: true })).map((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])))).flat();
    for (const f of await walk(join(dir, '.vdriver', 'objects'))) {
      expect((await readFile(f)).includes('quick brown fox')).toBe(false);
    }
  });

  it('dedups unchanged data across versions', async () => {
    const { repo } = await Repository.init(dir, { name: 'demo', user });
    const blob = randomBytes(2_000_000);
    await w('audio.wav', blob);
    await repo.commit({ summary: 'v1' });
    const before = await dirSize(join(dir, '.vdriver', 'objects'));
    await w('audio.wav', Buffer.concat([blob.subarray(0, 900_000), Buffer.from('EDIT'), blob.subarray(900_000)]));
    await repo.commit({ summary: 'v2' });
    const after = await dirSize(join(dir, '.vdriver', 'objects'));
    expect(after - before).toBeLessThan(before * 0.6);
  });

  it('branches, checks out, merges and fast-forwards', async () => {
    const { repo } = await Repository.init(dir, { name: 'demo', user });
    await w('a.txt', 'one');
    await repo.commit({ summary: 'base' });
    await repo.createBranch('feature');
    await repo.checkout('feature');
    await w('b.txt', 'feature file');
    await repo.commit({ summary: 'feature work' });
    expect(await r('b.txt')).toBe('feature file');

    await repo.checkout('main');
    await expect(readFile(join(dir, 'b.txt'))).rejects.toThrow();
    const ff = await repo.merge('feature');
    expect(ff.kind).toBe('fast-forward');
    expect(await r('b.txt')).toBe('feature file');
  });

  it('three-way merges and reports file conflicts', async () => {
    const { repo } = await Repository.init(dir, { name: 'demo', user });
    await w('shared.txt', 'base');
    await w('mine.txt', 'x');
    await repo.commit({ summary: 'base' });
    await repo.createBranch('other');
    await repo.checkout('other');
    await w('shared.txt', 'theirs');
    await w('theirs.txt', 'new');
    await repo.commit({ summary: 'other' });
    await repo.checkout('main');
    await w('shared.txt', 'ours');
    await w('mine.txt', 'y');
    await repo.commit({ summary: 'main' });

    await expect(repo.merge('other')).rejects.toBeInstanceOf(ConflictError);
    const res = await repo.merge('other', { resolutions: { 'shared.txt': 'theirs' } });
    expect(res.kind).toBe('merge');
    expect(await r('shared.txt')).toBe('theirs');
    expect(await r('mine.txt')).toBe('y');
    expect(await r('theirs.txt')).toBe('new');
    expect((await repo.log())[0]!.parents).toHaveLength(2);
  });

  it('reverts a commit, and flags conflicting reverts', async () => {
    const { repo } = await Repository.init(dir, { name: 'demo', user });
    await w('f.txt', 'v1');
    await repo.commit({ summary: 'v1' });
    await w('f.txt', 'v2');
    const c2 = await repo.commit({ summary: 'v2' });
    await w('g.txt', 'added later');
    await repo.commit({ summary: 'g' });

    const rv = await repo.revert(c2.id);
    expect(rv.summary).toBe('Revert "v2"');
    expect(await r('f.txt')).toBe('v1');
    expect(await r('g.txt')).toBe('added later');

    await w('f.txt', 'v3');
    const c4 = await repo.commit({ summary: 'v3' });
    await w('f.txt', 'v4');
    await repo.commit({ summary: 'v4' });
    await expect(repo.revert(c4.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it('guards dirty trees, discards and restores files', async () => {
    const { repo } = await Repository.init(dir, { name: 'demo', user });
    await w('f.txt', 'v1');
    const c1 = await repo.commit({ summary: 'v1' });
    await w('f.txt', 'v2');
    const c2 = await repo.commit({ summary: 'v2' });
    await w('f.txt', 'dirty');
    await expect(repo.checkout(c1.id)).rejects.toBeInstanceOf(DirtyTreeError);
    await repo.discard();
    expect(await r('f.txt')).toBe('v2');
    await repo.restoreFile('f.txt', c1.id);
    expect(await r('f.txt')).toBe('v1');
    expect((await repo.status())[0]!.status).toBe('modified');
    await repo.discard();
    await repo.reset(c1.id, { hard: true });
    expect(await r('f.txt')).toBe('v1');
    expect((await repo.log()).map((c) => c.id)).toEqual([c1.id]);
    void c2;
  });

  it('refuses to open with the wrong key', async () => {
    const { repo } = await Repository.init(dir, { name: 'demo', user });
    await w('a.txt', 'secret');
    await repo.commit({ summary: 'x' });
    const bad = await Repository.open(dir, new Map([[1, generateRepoKey()]]));
    await expect(bad.log()).rejects.toThrow();
  });
});
