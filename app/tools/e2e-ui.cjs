// Drives the real app's SCREENS (clicks and typing) against the fake Drive, the way a person would.
//   node tools/e2e-ui.cjs
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { server } = require('./fake-drive.cjs');

const APP = path.resolve(__dirname, '..');
const ELECTRON = path.resolve(APP, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const WORK = path.join(process.env.E2E_DIR || os.tmpdir(), 'vd-e2e-ui');
const SHOTS = process.env.SHOT_DIR;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const fwd = (p) => p.replace(/\\/g, '/');

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
  const send = (method, params) => new Promise((res) => { const n = ++id; pend.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((d) => d.result.result?.value);
  const api = (method, ...args) => evaluate(`window.vd.${method}(...${JSON.stringify(args)}).then(v => ({ v }), e => ({ __err: true, code: e.code, message: e.message }))`).then((r) => (r && r.__err ? r : r && r.v));
  const text = () => evaluate('document.body.innerText');
  const click = (txt, sel = 'button') => evaluate(`(()=>{const b=[...document.querySelectorAll('${sel}')].find(x=>x.textContent.trim().includes(${JSON.stringify(txt)}));if(b){b.click();return true}return false})()`);
  const clickTop = (txt) => evaluate(`(()=>{const m=[...document.querySelectorAll('.scrim')].pop();const b=m&&[...m.querySelectorAll('button')].find(x=>x.textContent.trim().includes(${JSON.stringify(txt)}));if(b){b.click();return true}return false})()`);
  const type = (sel, v) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return false;const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(el,${JSON.stringify(v)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(250); } return false; };
  const shot = async (name) => { if (!SHOTS) return; const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64')); };
  await wait(2500);
  return { api, text, click, clickTop, type, until, shot, evaluate, close: () => { ws.close(); proc.kill(); } };
}

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  await new Promise((r) => server.listen(9400, '127.0.0.1', r));

  // ----- computer A: set up an account with a published project (through the API) -----
  const projA = path.join(WORK, 'A', 'Moles-Must-Pay');
  fs.mkdirSync(projA, { recursive: true });
  fs.writeFileSync(path.join(projA, 'readme.txt'), 'hello from A');
  const A = await launch('A', 9351);
  await A.api('vaultCreate', 'correct horse battery');
  const repoA = await A.api('createRepo', { dir: fwd(projA), name: 'Moles-Must-Pay' });
  const pub = await A.api('publishToDrive', repoA.id);
  check('setup: repository published from computer A', pub && pub.remote);
  A.close();
  await wait(800);

  // ----- computer C: a fresh install, same Google account. Everything below is clicks and typing. -----
  console.log('\n== Computer C: new install, driven through the screens');
  const projC = path.join(WORK, 'C', 'Moles-Must-Pay');
  fs.mkdirSync(projC, { recursive: true });                       // the user's existing project folder
  fs.writeFileSync(path.join(projC, 'readme.txt'), 'my local copy');
  const C = await launch('C', 9352);

  check('C: unlock dialog appears on start (the account was set up elsewhere)', await C.until(async () => (await C.text()).includes('Unlock your projects')));
  await C.shot('c1-unlock');
  await C.click('Not now');
  check('C: dismissing it leaves the main menu with the Drive library', await C.until(async () => (await C.text()).includes('Moles-Must-Pay')));
  check('C: library lists the Drive project', (await C.text()).includes('IN YOUR GOOGLE DRIVE') || (await C.text()).includes('In your Google Drive'));

  await C.click('Clone here');
  check('C: clone dialog opens', await C.until(async () => (await C.text()).includes('Clone or join a repository')));
  await C.type('input[placeholder="Choose a folder…"]', fwd(projC));
  await wait(400);
  await C.shot('c2-clone-dialog');
  await C.click('Clone', '.modal-foot .btn.primary');

  // the account is still locked, so cloning must ask for the password again, on top of the clone dialog
  check('C: cloning a locked account asks for the recovery password', await C.until(async () => (await C.text()).includes('Unlock your projects')));
  const stillClone = (await C.text()).includes('Clone or join a repository');
  check('C: the clone dialog is still there underneath', stillClone);
  await C.shot('c3-unlock-over-clone');

  // the exact thing that went wrong before: cancelling the password dialog must not lose the clone dialog
  await C.clickTop('Cancel');
  await wait(500);
  check('C: cancelling the password keeps the clone dialog open', (await C.text()).includes('Clone or join a repository'));
  check('C: ...and explains what happened', (await C.text()).includes('Cloning needs your recovery password'));
  await C.shot('c3b-after-cancel');
  await C.click('Clone', '.modal-foot .btn.primary');                                  // try again
  check('C: pressing Clone again asks for the password again', await C.until(async () => (await C.text()).includes('Unlock your projects')));

  // Escape must only close the top dialog (the password one), not the clone dialog under it
  await C.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
  await wait(500);
  check('C: Escape closed only the top dialog', (await C.text()).includes('Clone or join a repository') && !(await C.text()).includes('Unlock your projects'));
  await C.click('Clone', '.modal-foot .btn.primary');
  await C.until(async () => (await C.text()).includes('Unlock your projects'));

  await C.type('input[type="password"]', 'wrong password!');
  await C.clickTop('Unlock');
  check('C: a wrong password shows an error and keeps asking', await C.until(async () => (await C.text()).includes("That password isn't right")));
  await C.type('input[type="password"]', 'correct horse battery');
  await C.clickTop('Unlock');

  check('C: after unlocking, the clone completes and the project opens', await C.until(async () => {
    const t = await C.text();
    return t.includes('Changes') && t.includes('History') && !t.includes('Clone or join a repository');
  }, 30000));
  await C.shot('c4-after-clone');
  const repos = await C.api('listRepos');
  check('C: project is in the list', Array.isArray(repos) && repos.length === 1 && repos[0].name === 'Moles-Must-Pay', JSON.stringify(repos?.map?.((r) => r.name)));
  check('C: the user\'s own file was kept, not overwritten', fs.readFileSync(path.join(projC, 'readme.txt'), 'utf8') === 'my local copy');

  C.close();
  server.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('harness error', e); process.exit(2); });
