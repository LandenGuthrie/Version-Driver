// A fake in-memory backend so the UI can be developed and screenshotted in a normal browser.
import { diffLines } from 'diff';
import type { ChangeDTO, CommitDTO, DiffRow, FileDiff, FileKind, MemberDTO, Profile, RepoSummary, VdApi } from '../../shared/api';

type Content = { kind: 'text'; text: string } | { kind: 'image'; url: string; size: number } | { kind: 'audio'; url: string; size: number };

function png(bg: string, fg: string, w: number, h: number, extra = false) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = fg;
  g.beginPath();
  g.arc(w / 2, h / 2, h / 3, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = bg;
  g.fillRect(w / 2 - 6, h / 5, 12, h * 0.6);
  if (extra) {
    g.fillStyle = '#4493f8';
    g.fillRect(20, h - 50, w - 40, 14);
  }
  return c.toDataURL('image/png');
}

function wav(seconds: number, freqs: number[]) {
  const rate = 22050;
  const n = Math.floor(seconds * rate);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.min(1, t * 8) * Math.min(1, (seconds - t) * 4) * (0.55 + 0.45 * Math.sin(t * 3.2));
    let s = 0;
    freqs.forEach((f, k) => (s += Math.sin(2 * Math.PI * f * t) / (k + 1)));
    v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, (s / freqs.length) * env * 1.3)) * 0x7fff, true);
  }
  return { url: URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })), size: buf.byteLength };
}

const APP1 = `import { createServer } from 'node:http';

const PORT = 3000;

export function start() {
  const server = createServer((req, res) => {
    res.end('hello');
  });
  server.listen(PORT);
  return server;
}
`;
const APP2 = APP1.replace("res.end('hello');", "res.writeHead(200, { 'content-type': 'text/plain' });\n    res.end('hello, world');").replace('const PORT = 3000;', 'const PORT = Number(process.env.PORT ?? 3000);');
const APP3 = APP2 + `
export function stop(server: ReturnType<typeof start>) {
  server.close();
}

// TODO: graceful shutdown with a timeout
`;
const README1 = '# Demo Project\n\nA small demo repository.\n\n## Usage\n\nRun `npm start`.\n';
const README2 = '# Demo Project\n\nA small demo repository for Version Driver.\n\n## Usage\n\nRun `npm start` and open http://localhost:3000.\n\n## License\n\nMIT\n';

export function installMock() {
  const logoA = png('#16161a', '#ff7a1a', 480, 320);
  const logoB = png('#16161a', '#3fb950', 560, 320, true);
  const banner = png('#202026', '#4493f8', 640, 220);
  const themeA = wav(3, [220, 330]);
  const themeB = wav(4.2, [220, 330, 440]);

  const mkTxt = (text: string): Content => ({ kind: 'text', text });
  const img = (url: string, size: number): Content => ({ kind: 'image', url, size });
  const revs: Record<string, Record<string, Content>> = {
    c1: { 'README.md': mkTxt(README1), 'src/app.ts': mkTxt(APP1), 'assets/logo.png': img(logoA, 18400), 'audio/theme.wav': { kind: 'audio', ...themeA } },
    c2: { 'README.md': mkTxt(README1), 'src/app.ts': mkTxt(APP2), 'assets/logo.png': img(logoA, 18400), 'audio/theme.wav': { kind: 'audio', ...themeA } },
    c3: { 'README.md': mkTxt(README1), 'src/app.ts': mkTxt(APP2), 'assets/logo.png': img(logoB, 24100), 'audio/theme.wav': { kind: 'audio', ...themeB }, 'notes.txt': mkTxt('remember to ship it\n') },
    working: { 'README.md': mkTxt(README2), 'src/app.ts': mkTxt(APP3), 'assets/logo.png': img(logoB, 24100), 'audio/theme.wav': { kind: 'audio', ...themeB }, 'assets/banner.png': img(banner, 9100) },
  };
  const now = Date.now();
  const commits: CommitDTO[] = [
    { id: 'c3', summary: 'New logo and extended theme', description: 'Swapped the orange mark for the green one and added the third harmonic to the theme jingle.', author: { name: 'Sam Rivera', email: 's@x.com' }, time: now - 3 * 3600e3, parents: ['c2'] },
    { id: 'c2', summary: 'Read PORT from the environment', description: '', author: { name: 'Landen Guthrie', email: 'l@x.com' }, time: now - 26 * 3600e3, parents: ['c1'] },
    { id: 'c1', summary: 'Initial commit', description: 'Project skeleton, logo and theme audio.', author: { name: 'Landen Guthrie', email: 'l@x.com' }, time: now - 5 * 86400e3, parents: [] },
  ];

  const kindOf = (p: string): FileKind => (/\.(png|jpe?g|gif|webp)$/i.test(p) ? 'image' : /\.(wav|mp3|flac|ogg)$/i.test(p) ? 'audio' : 'text');
  const dto = (path: string, status: ChangeDTO['status'], size: number, oldSize?: number): ChangeDTO => ({ path, status, size, oldSize, kind: kindOf(path) });
  const sizeOf = (c?: Content) => (c ? (c.kind === 'text' ? c.text.length : c.size) : 0);
  const changesBetween = (a: string | null, b: string): ChangeDTO[] => {
    const A = a ? revs[a]! : {};
    const B = revs[b]!;
    const out: ChangeDTO[] = [];
    for (const p of Object.keys(B)) {
      if (!A[p]) out.push(dto(p, 'added', sizeOf(B[p])));
      else if (JSON.stringify(A[p]) !== JSON.stringify(B[p])) out.push(dto(p, 'modified', sizeOf(B[p]), sizeOf(A[p])));
    }
    for (const p of Object.keys(A)) if (!B[p]) out.push(dto(p, 'deleted', 0, sizeOf(A[p])));
    return out.sort((x, y) => (x.path < y.path ? -1 : 1));
  };

  const rows = (a: string, b: string): DiffRow[] => {
    const out: DiffRow[] = [];
    let o = 1, n = 1;
    for (const part of diffLines(a, b)) {
      const lines = part.value.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      for (const s of lines) out.push(part.added ? { t: 'add', n: n++, s } : part.removed ? { t: 'del', o: o++, s } : { t: 'ctx', o: o++, n: n++, s });
    }
    return out;
  };

  const repo: RepoSummary = { id: 'demo', name: 'Demo Project', dir: 'C:\\Projects\\Demo Project', branch: 'main', remote: { name: 'origin', kind: 'drive', label: 'Google Drive', folderId: '1AbCdEfGhIjKlMnOpQrStUvWxYz' } };
  const members: MemberDTO[] = [
    { id: 'me', name: 'Landen Guthrie', email: 'landen@gmail.com', role: 'owner', status: 'active', safety: 'A1B2-C3D4-E5F6-0718-293A', online: true, me: true },
    { id: 's', name: 'Sam Rivera', email: 'sam@gmail.com', role: 'editor', status: 'active', safety: '1111-2222-3333-4444-5555', online: true, me: false },
    { id: 'j', name: 'Jordan Lee', email: 'jordan@gmail.com', role: 'viewer', status: 'active', safety: '9999-8888-7777-6666-5555', online: false, me: false },
    { id: 'p', name: 'Priya Natarajan', email: 'priya@gmail.com', role: 'editor', status: 'pending', safety: '4F2A-91C7-0B3D-88E1-6A52', online: false, me: false },
  ];

  const listeners = new Map<string, Set<(p: any) => void>>();
  const emit = (e: string, p: unknown) => listeners.get(e)?.forEach((f) => f(p));
  let profile: Profile | null = new URLSearchParams(location.search).has('welcome') ? null : { id: 'me', name: 'Landen Guthrie', email: 'landen@gmail.com', mode: 'google' };
  const wait = <T,>(v: T, ms = 40) => new Promise<T>((r) => setTimeout(() => r(v), ms));

  const api: VdApi = {
    platform: 'win32',
    googleConfigured: () => wait(true),
    setTitleBar: async () => undefined,
    installUpdate: async () => undefined,
    getProfile: () => wait(profile),
    signInGoogle: async () => { await wait(0, 1800); profile = { id: 'me', name: 'Landen Guthrie', email: 'landen@gmail.com', mode: 'google' }; return profile; },
    cancelSignIn: async () => undefined,
    continueLocal: async (name, email) => (profile = { id: 'me', name, email, mode: 'local' }),
    signOut: async () => { profile = null; },
    listRepos: () => wait([repo]),
    pickFolder: async () => 'C:\\Projects',
    createRepo: async () => repo,
    addExisting: async () => repo,
    removeRepo: async () => undefined,
    setRemoteFolder: async () => repo,
    publishToDrive: async () => repo,
    listDriveRepos: () => wait([{ folderId: 'a', name: 'Album Masters' }, { folderId: 'b', name: 'Game Assets' }]),
    cloneFromDrive: async () => repo,
    cloneFromFolder: async () => repo,
    activate: async () => { setTimeout(() => emit('presence:changed', { repoId: 'demo', online: [{ id: 's', name: 'Sam Rivera', branch: 'main' }] }), 300); },
    status: () => wait(changesBetween('c3', 'working')),
    commit: async () => commits[0]!,
    log: () => wait(commits),
    commitChanges: (_id, c) => wait(changesBetween(commits.find((x) => x.id === c)?.parents[0] ?? null, c)),
    fileDiff: async (_id, { path, from, to }): Promise<FileDiff> => {
      const a = from ? revs[from]?.[path] : undefined;
      const b = revs[to]?.[path];
      const status = !a ? 'added' : !b ? 'deleted' : 'modified';
      const kind = kindOf(path);
      const d: FileDiff = { path, kind, mime: '', status, size: sizeOf(b), oldSize: a ? sizeOf(a) : undefined };
      if (kind === 'text') d.rows = rows(a?.kind === 'text' ? a.text : '', b?.kind === 'text' ? b.text : '');
      else {
        d.oldUrl = a && a.kind !== 'text' ? a.url : undefined;
        d.newUrl = b && b.kind !== 'text' ? b.url : undefined;
      }
      return wait(d);
    },
    readText: async (_id, { rev, path }) => {
      const c = revs[rev]?.[path];
      return c?.kind === 'text' ? { text: c.text, truncated: false } : null;
    },
    discard: async () => undefined,
    restoreFile: async () => undefined,
    revealInFolder: async () => undefined,
    branches: () => wait([{ name: 'main', tip: 'c3', current: true, remoteTip: 'c2' }, { name: 'feature/sound-pack', tip: 'c2', current: false, remoteTip: 'c2' }, { name: 'experiment', tip: 'c1', current: false }]),
    createBranch: async () => undefined,
    deleteBranch: async () => undefined,
    checkout: async () => undefined,
    merge: async () => ({ kind: 'merge' }),
    revert: async () => commits[0]!,
    resetTo: async () => undefined,
    syncState: () => wait({ hasRemote: true, branch: 'main', ahead: 1, behind: 0 }),
    fetch: async () => ({ updated: 0 }),
    pull: async () => ({ kind: 'up-to-date' }),
    push: async () => { for (let i = 1; i <= 5; i++) { emit('progress', { repoId: 'demo', phase: 'uploading', done: i, total: 5, bytes: i * 1000 }); await wait(0, 250); } return { pushed: 1 }; },
    members: () => wait(members),
    inviteByEmail: async () => undefined,
    approveMember: async () => undefined,
    setMemberRole: async () => undefined,
    removeMember: async () => undefined,
    requestJoin: async () => undefined,
    locks: async () => [],
    lockFile: async () => ({ ok: true }),
    unlockFile: async () => undefined,
    comments: async () => [{ author: 'Sam Rivera', text: 'The green is much better.', time: now - 3600e3 }],
    addComment: async () => undefined,
    storage: () => wait({ logicalBytes: 52_400_000, storedBytes: 21_300_000, objects: 412, commits: 3, level: 'balanced' }),
    setCompression: async () => undefined,
    on(event, cb) {
      const set = listeners.get(event) ?? new Set();
      set.add(cb as (p: any) => void);
      listeners.set(event, set);
      return () => set.delete(cb as (p: any) => void);
    },
  };
  window.vd = api;
}
