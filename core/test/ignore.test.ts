import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initCrypto, Repository, Ignore, IGNORE_PRESETS, appliedPresets, setPreset, addPattern, detectPresets, DEFAULT_IGNORE,
} from '../src/index.js';

let dir: string;
beforeAll(() => initCrypto());
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vdi-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const w = async (p: string, c = 'x') => {
  await mkdir(join(dir, ...p.split('/').slice(0, -1)), { recursive: true });
  await writeFile(join(dir, ...p.split('/')), c);
};

describe('ignore matcher', () => {
  it('supports character classes like Unity uses', () => {
    const ig = new Ignore(setPreset('', 'unity', true));
    expect(ig.ignores('Library', true)).toBe(true);
    expect(ig.ignores('library', true)).toBe(true);
    expect(ig.ignores('Assets/Scenes/Main.unity', false)).toBe(false);
    expect(ig.ignores('Game.csproj', false)).toBe(true);
    expect(ig.ignores('Assets/AssetStoreTools', true)).toBe(true);
  });

  it('VS Code preset ignores editor state but keeps shared settings', () => {
    const ig = new Ignore(setPreset('', 'vscode', true));
    expect(ig.ignores('.vscode/workspace.json', false)).toBe(true);
    expect(ig.ignores('.vscode/settings.json', false)).toBe(false);
    expect(ig.ignores('.cursor', true)).toBe(true);
  });

  it('every preset parses and has patterns', () => {
    for (const p of IGNORE_PRESETS) {
      expect(p.patterns.length).toBeGreaterThan(0);
      expect(() => new Ignore(setPreset('', p.id, true))).not.toThrow();
    }
  });
});

describe('preset blocks', () => {
  it('toggles on and off without touching hand-written rules', () => {
    const base = DEFAULT_IGNORE + '\nmy-secret-folder/\n';
    const on = setPreset(base, 'unity', true);
    expect(appliedPresets(on)).toEqual(['unity']);
    expect(on).toContain('my-secret-folder/');
    expect(setPreset(on, 'unity', true).match(/vd-preset:unity/g)).toHaveLength(2); // start + end, no duplicate block
    const off = setPreset(on, 'unity', false);
    expect(appliedPresets(off)).toEqual([]);
    expect(off).toContain('my-secret-folder/');
    expect(off).not.toContain('[Ll]ibrary/');
  });

  it('stacks several presets and adds single rules once', () => {
    let t = setPreset(setPreset('', 'unity', true), 'rider', true);
    expect(appliedPresets(t).sort()).toEqual(['rider', 'unity']);
    t = addPattern(addPattern(t, '*.wav'), '*.wav');
    expect(t.match(/^\*\.wav$/gm)).toHaveLength(1);
  });

  it('detects project types from the folder', async () => {
    await w('Assets/a.cs');
    await w('ProjectSettings/ProjectVersion.txt');
    await w('.idea/x.xml');
    await w('.vscode/settings.json');
    await w('MyGame.sln');
    const found = await detectPresets(dir);
    expect(found).toEqual(expect.arrayContaining(['unity', 'rider', 'vscode', 'visualstudio', 'os']));
    expect(found).not.toContain('unreal');
    await w('Game.uproject');
    expect(await detectPresets(dir)).toContain('unreal');
  });
});

describe('ignore rules vs tracked files', () => {
  it('hides new matching files, but never makes committed files look deleted', async () => {
    const { repo } = await Repository.init(dir, { name: 't', user: { name: 'T', email: 't@x.com' } });
    await w('Assets/keep.txt');
    await w('Library/cache.bin', 'committed before the rule existed');
    await repo.commit({ summary: 'first' });

    await writeFile(join(dir, '.vdignore'), setPreset(await readFile(join(dir, '.vdignore'), 'utf8'), 'unity', true));
    await w('Library/new-cache.bin', 'created after the rule');
    await w('Temp/scratch.tmp');

    const changes = (await repo.status()).map((c) => `${c.status}:${c.path}`);
    expect(changes).toEqual(['modified:.vdignore']); // no 'deleted:Library/cache.bin', and nothing from Temp/ or the new cache file
    await w('Library/cache.bin', 'edited tracked file');
    expect((await repo.status()).map((c) => c.path)).toContain('Library/cache.bin');
  });
});
