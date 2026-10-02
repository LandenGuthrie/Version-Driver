// End-to-end test of the Google Drive flows, using the REAL app and a local fake Drive.
//   node tools/e2e-drive.cjs        (from the app folder, after `npm run build`)
// Two app profiles act as two computers signed in to the same Google account.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { server } = require('./fake-drive.cjs');

const APP = path.resolve(__dirname, '..');
const ELECTRON = path.resolve(APP, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const WORK = path.join(process.env.E2E_DIR || os.tmpdir(), 'vd-e2e');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };

async function launch(label, port) {
  const ud = path.join(WORK, label, 'profile');
  fs.mkdirSync(ud, { recursive: true });
  fs.writeFileSync(path.join(ud, 'profile.json'), JSON.stringify({ id: 'google-sub-123', name: 'Landen', email: 'l@example.com', mode: 'google' }));
  const proc = spawn(ELECTRON, [APP, `--user-data-dir=${ud}`, `--remote-debugging-port=${port}`], {
    stdio: 'ignore',
    env: { ...process.env, VD_DRIVE_API: 'http://127.0.0.1:9400/drive/v3', VD_DRIVE_UPLOAD: 'http://127.0.0.1:9400/upload/drive/v3', VD_FAKE_TOKEN: 'fake' },
  });
  let targets;
  for (let i = 0; i < 60; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.some((t) => t.type === 'page')) break; } catch {}
    await wait(500);
  }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const evaluate = (expression) => new Promise((res) => {
    const n = ++id; pend.set(n, res);
    ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  }).then((d) => (d.result.exceptionDetails ? { __err: true, message: JSON.stringify(d.result.exceptionDetails.exception?.description ?? d.result.exceptionDetails) } : d.result.result.value));
  await wait(2500);
  const call = (method, ...args) => evaluate(`window.vd.${method}(...${JSON.stringify(args)}).then(v => ({ v }), e => ({ __err: true, code: e.code, message: e.message }))`)
    .then((r) => (r && r.__err ? r : r && r.v));
  return { call, evaluate, close: () => { ws.close(); proc.kill(); } };
}

const fwd = (p) => p.replace(/\\/g, '/');

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  await new Promise((r) => server.listen(9400, '127.0.0.1', r));
  const dump = async () => (await fetch('http://127.0.0.1:9400/__dump')).json();

  // ---------------- computer A ----------------
  console.log('\n== Computer A: first computer');
  const projA = path.join(WORK, 'A', 'Moles-Must-Pay');
  fs.mkdirSync(path.join(projA, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projA, 'readme.txt'), 'hello from A');
  fs.writeFileSync(path.join(projA, 'src', 'game.txt'), 'game v1');
  const A = await launch('A', 9341);

  check('A: no recovery password yet', (await A.call('vaultStatus')) === 'none');
  let r = await A.call('publishToDrive', 'nope');
  check('A: publish refuses to run without a recovery password', r?.__err, JSON.stringify(r));
  r = await A.call('vaultCreate', 'correct horse battery');
  check('A: set recovery password', !r?.__err, JSON.stringify(r));
  check('A: vault is ready on this computer', (await A.call('vaultStatus')) === 'ready');

  const repoA = await A.call('createRepo', { dir: fwd(projA), name: 'Moles-Must-Pay' });
  check('A: create repository (local)', repoA && repoA.id, JSON.stringify(repoA));
  r = await A.call('commit', repoA.id, { summary: 'x', description: '', paths: ['readme.txt'] });
  check('A: commit is blocked before publishing', r?.__err && r.code === 'unpublished', JSON.stringify(r));

  r = await A.call('publishToDrive', repoA.id);
  check('A: publish to Drive', r && r.remote && r.remote.kind === 'drive', JSON.stringify(r));
  const tree1 = await dump();
  check('A: folder "Version Driver/Moles-Must-Pay" exists in Drive', tree1.some((f) => f.path === 'Version Driver/Moles-Must-Pay'), tree1.map((f) => f.path).slice(0, 6).join(', '));
  check('A: account vault file stored in the Version Driver folder', tree1.some((f) => f.path === 'Version Driver/.vd-account.json'));
  check('A: nothing readable in Drive (no plaintext file names)', !tree1.some((f) => /readme|game/.test(f.path)));
  const log1 = await A.call('log', repoA.id);
  check('A: first version was saved and uploaded', Array.isArray(log1) && log1.length === 1 && log1[0].summary === 'Initial commit', JSON.stringify(log1?.map?.((c) => c.summary)));
  const sync1 = await A.call('syncState', repoA.id);
  check('A: nothing left to push', sync1 && sync1.ahead === 0 && sync1.unpushed.length === 0, JSON.stringify(sync1));

  fs.writeFileSync(path.join(projA, 'src', 'game.txt'), 'game v2');
  r = await A.call('commit', repoA.id, { summary: 'Update game', description: '', paths: ['src/game.txt'] });
  check('A: commit after publishing', r && r.summary === 'Update game', JSON.stringify(r));
  r = await A.call('push', repoA.id);
  check('A: push', r && r.pushed === 1, JSON.stringify(r));

  const listed = await A.call('listDriveRepos');
  check('A: Drive library lists the repository', Array.isArray(listed) && listed.some((l) => l.name === 'Moles-Must-Pay'), JSON.stringify(listed));
  const folderId = listed[0].folderId;

  // ---------------- computer B ----------------
  console.log('\n== Computer B: a different computer, same Google account');
  const projB = path.join(WORK, 'B', 'Moles-Must-Pay');
  const B = await launch('B', 9342);
  check('B: account is locked (key lives on computer A)', (await B.call('vaultStatus')) === 'locked');
  check('B: Drive library shows the repository', (await B.call('listDriveRepos'))?.some?.((l) => l.folderId === folderId));
  r = await B.call('cloneFromDrive', { folderId, dir: fwd(projB) });
  check('B: clone fails while locked (with a real error, not silence)', r?.__err, JSON.stringify(r));
  r = await B.call('vaultUnlock', 'wrong password');
  check('B: wrong recovery password is rejected', r?.__err && r.code === 'bad_password', JSON.stringify(r));
  r = await B.call('vaultUnlock', 'correct horse battery');
  check('B: unlock with the right password', !r?.__err, JSON.stringify(r));
  check('B: vault ready after unlock', (await B.call('vaultStatus')) === 'ready');
  const repoB = await B.call('cloneFromDrive', { folderId, dir: fwd(projB) });
  check('B: clone', repoB && repoB.id && !repoB.__err, JSON.stringify(repoB));
  check('B: files arrived', fs.existsSync(path.join(projB, 'readme.txt')) && fs.readFileSync(path.join(projB, 'src', 'game.txt'), 'utf8') === 'game v2');
  const logB = await B.call('log', repoB.id);
  check('B: full history arrived', Array.isArray(logB) && logB.map((c) => c.summary).join('|') === 'Update game|Initial commit', JSON.stringify(logB?.map?.((c) => c.summary)));
  const stB = await B.call('status', repoB.id);
  check('B: working tree is clean after clone', Array.isArray(stB) && stB.length === 0, JSON.stringify(stB));

  // ---------------- computer A: remove locally, then reconnect the same folder ----------------
  console.log('\n== Computer A: remove locally (keep Drive), then reconnect the same folder');
  r = await A.call('removeRepo', repoA.id, { deleteHistory: true, deleteRemote: false });
  check('A: remove from this computer', !r?.__err, JSON.stringify(r));
  check('A: project files are still there', fs.readFileSync(path.join(projA, 'src', 'game.txt'), 'utf8') === 'game v2');
  check('A: Drive copy still exists', (await A.call('listDriveRepos'))?.some?.((l) => l.folderId === folderId));
  r = await A.call('addExisting', fwd(projA));
  check('A: "On this computer" explains there is no history here', r?.__err && r.code === 'not_tracked', JSON.stringify(r));
  fs.writeFileSync(path.join(projA, 'local-only.txt'), 'created while disconnected');
  const re = await A.call('cloneFromDrive', { folderId, dir: fwd(projA), keepFiles: true });
  check('A: reconnect folder to the Drive copy', re && re.id && !re.__err, JSON.stringify(re));
  check('A: files untouched by the reconnect', fs.readFileSync(path.join(projA, 'src', 'game.txt'), 'utf8') === 'game v2');
  const stA = await A.call('status', re.id);
  check('A: only the new local file shows as a change', Array.isArray(stA) && stA.map((c) => c.path).join(',') === 'local-only.txt', JSON.stringify(stA));
  const reps = await A.call('listRepos');
  check('A: repository is back in the project list', Array.isArray(reps) && reps.some((x) => x.id === re.id), JSON.stringify(reps?.map?.((x) => x.name)));

  // ---------------- rename + delete from Drive ----------------
  console.log('\n== Rename and delete from Drive');
  r = await A.call('renameRepo', re.id, 'Moles Must Pay');
  check('A: rename', r && r.name === 'Moles Must Pay', JSON.stringify(r));
  check('A: Drive folder was renamed too', (await dump()).some((f) => f.path === 'Version Driver/Moles Must Pay'));
  r = await A.call('deleteRemote', re.id);
  check('A: delete from Drive', !r?.__err && r.remote === null, JSON.stringify(r));
  check('A: Drive folder is in the trash', (await dump()).find((f) => f.path === 'Version Driver/Moles Must Pay')?.trashed === true);
  check('A: Drive library no longer lists it', !(await A.call('listDriveRepos')).some((l) => l.folderId === folderId));

  A.close(); B.close();
  server.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('harness error', e); process.exit(2); });
