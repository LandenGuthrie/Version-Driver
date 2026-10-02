import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron';
import { join } from 'node:path';
import { autoUpdater } from 'electron-updater';
import { initCrypto } from '@vd/core';
import { Manager } from './manager';
import { mimeOf } from './files';
import type { Events } from '../shared/api';

const DEEP_LINK = 'versiondriver';

protocol.registerSchemesAsPrivileged([
  { scheme: 'vdfile', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false } },
]);

let win: BrowserWindow | null = null;
let manager: Manager;
let pendingLink: string | null = null;

const emit = <E extends keyof Events>(event: E, payload: Events[E]) => {
  win?.webContents.send('vd:event', { event, payload });
};

function handleLink(url: string) {
  if (!url.startsWith(`${DEEP_LINK}://`)) return;
  if (win) {
    emit('deeplink', { url });
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else pendingLink = url;
}

function createWindow() {
  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f0f10',
    title: 'Version Driver',
    icon: join(__dirname, '../../build/icon.png'),
    titleBarStyle: 'hidden',
    ...(mac ? { trafficLightPosition: { x: 16, y: 14 } } : { titleBarOverlay: { color: '#0f0f10', symbolColor: '#8b8b93', height: 44 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('focus', () => {
    manager.setFocused(true);
    emit('focus', { focused: true });
  });
  win.on('blur', () => {
    manager.setFocused(false);
    emit('focus', { focused: false });
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('file://')) e.preventDefault();
  });
  win.webContents.on('did-finish-load', () => {
    if (pendingLink) {
      emit('deeplink', { url: pendingLink });
      pendingLink = null;
    }
  });
  if (process.env['ELECTRON_RENDERER_URL']) void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
  win.on('closed', () => (win = null));
}

/** Checks GitHub Releases for a newer version. Only active in released builds (they carry app-update.yml). */
function setupUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => emit('update:ready', { version: info.version }));
  autoUpdater.on('error', () => undefined);
  const check = () => void autoUpdater.checkForUpdates().catch(() => undefined);
  check();
  setInterval(check, 6 * 60 * 60 * 1000);
}

// ---- IPC ---------------------------------------------------------------------

function registerIpc() {
  const m = manager;
  const handlers: Record<string, (...a: any[]) => unknown> = {
    googleConfigured: () => m.googleConfigured(),
    installUpdate: () => autoUpdater.quitAndInstall(),
    setTitleBar: (color: string, symbolColor: string) => {
      if (process.platform !== 'darwin') {
        try {
          win?.setTitleBarOverlay({ color, symbolColor, height: 44 });
        } catch {
          /* overlay not supported on this window */
        }
      }
    },
    getProfile: () => m.profile,
    signInGoogle: () => m.signInGoogle(),
    cancelSignIn: () => m.cancelSignIn(),
    continueLocal: (n: string, e: string) => m.continueLocal(n, e),
    signOut: () => m.signOut(),

    listRepos: () => m.listRepos(),
    pickFolder: async () => {
      const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
      return r.canceled ? null : r.filePaths[0] ?? null;
    },
    createRepo: (a) => m.createRepo(a),
    addExisting: (d: string) => m.addExisting(d),
    removeRepo: (id: string) => m.removeRepo(id),
    setRemoteFolder: (id: string, p: string) => m.setRemoteFolder(id, p),
    publishToDrive: (id: string) => m.publishToDrive(id),
    listDriveRepos: () => m.listDriveRepos(),
    cloneFromDrive: (a) => m.cloneFromDrive(a),
    cloneFromFolder: (a) => m.cloneFromFolder(a),
    activate: (id: string) => m.activate(id),

    status: (id: string) => m.status(id),
    commit: (id: string, a) => m.commit(id, a),
    log: (id: string, a) => m.log(id, a),
    commitChanges: (id: string, c: string) => m.commitChanges(id, c),
    fileDiff: (id: string, a) => m.fileDiff(id, a),
    readText: (id: string, a) => m.readText(id, a),
    discard: (id: string, p?: string[]) => m.discard(id, p),
    restoreFile: (id: string, a) => m.restoreFile(id, a),
    revealInFolder: (id: string, p: string) => m.revealInFolder(id, p),

    branches: (id: string) => m.branches(id),
    createBranch: (id: string, n: string, f?: string) => m.createBranch(id, n, f),
    deleteBranch: (id: string, n: string) => m.deleteBranch(id, n),
    checkout: (id: string, r: string, f?: boolean) => m.checkout(id, r, f),
    merge: (id: string, r: string, res) => m.merge(id, r, res),
    revert: (id: string, c: string, res) => m.revert(id, c, res),
    resetTo: (id: string, c: string, h: boolean) => m.resetTo(id, c, h),

    syncState: (id: string) => m.syncState(id),
    fetch: (id: string) => m.fetch(id),
    pull: (id: string) => m.pull(id),
    push: (id: string) => m.push(id),

    members: (id: string) => m.members(id),
    inviteByEmail: (id: string, e: string, r) => m.inviteByEmail(id, e, r),
    approveMember: (id: string, mid: string, r) => m.approveMember(id, mid, r),
    setMemberRole: (id: string, mid: string, r) => m.setMemberRole(id, mid, r),
    removeMember: (id: string, mid: string) => m.removeMember(id, mid),
    requestJoin: (id: string) => m.requestJoin(id),
    locks: (id: string) => m.locks(id),
    lockFile: (id: string, p: string) => m.lockFile(id, p),
    unlockFile: (id: string, p: string) => m.unlockFile(id, p),
    comments: (id: string, c: string) => m.comments(id, c),
    addComment: (id: string, c: string, t: string) => m.addComment(id, c, t),

    ignorePresets: () => m.ignorePresets(),
    ignoreDetect: (d: string) => m.ignoreDetect(d),
    ignoreRead: (id: string) => m.ignoreRead(id),
    ignoreEdit: (t: string, p: string, on: boolean) => m.ignoreEdit(t, p, on),
    ignoreWrite: (id: string, t: string) => m.ignoreWrite(id, t),
    ignoreAdd: (id: string, p: string) => m.ignoreAdd(id, p),

    storage: (id: string) => m.storage(id),
    setCompression: (id: string, l) => m.setCompression(id, l),
  };

  ipcMain.on('vd:names', (e) => {
    e.returnValue = Object.keys(handlers);
  });
  for (const [name, fn] of Object.entries(handlers)) {
    ipcMain.handle(`vd:${name}`, async (_e, ...args) => {
      try {
        return { ok: true, value: await fn(...args) };
      } catch (err: any) {
        // Errors lose their class over IPC, so carry the useful bits explicitly.
        return {
          ok: false,
          error: {
            message: String(err?.message ?? err),
            code: err?.code ?? (err?.constructor?.name === 'ConflictError' ? 'conflict' : err?.constructor?.name === 'DirtyTreeError' ? 'dirty' : err?.constructor?.name === 'PushRejectedError' ? 'rejected' : undefined),
            paths: err?.paths,
            reason: err?.reason,
          },
        };
      }
    });
  }
}

/** vdfile://repo/<repoId>/<rev>/<path> - serves repo files (images, audio…) with Range support. */
function registerFileProtocol() {
  protocol.handle('vdfile', async (req) => {
    try {
      const url = new URL(req.url);
      const [, id, rev, ...rest] = url.pathname.split('/').map(decodeURIComponent);
      const path = rest.join('/');
      const bytes = await manager.bytes(id!, rev!, path);
      if (!bytes) return new Response('Not found', { status: 404 });
      const headers: Record<string, string> = {
        'content-type': mimeOf(path),
        'accept-ranges': 'bytes',
        'cache-control': rev === 'working' ? 'no-store' : 'private, max-age=31536000, immutable',
      };
      const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') ?? '');
      if (range) {
        const start = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
        if (start > end || start >= bytes.length) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${bytes.length}` } });
        return new Response(bytes.subarray(start, end + 1) as unknown as BodyInit, {
          status: 206,
          headers: { ...headers, 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': String(end - start + 1) },
        });
      }
      return new Response(bytes as unknown as BodyInit, { status: 200, headers: { ...headers, 'content-length': String(bytes.length) } });
    } catch (e) {
      return new Response(String(e), { status: 500 });
    }
  });
}

// ---- lifecycle -----------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const link = argv.find((a) => a.startsWith(`${DEEP_LINK}://`));
    if (link) handleLink(link);
    else if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on('open-url', (e, url) => {
    e.preventDefault();
    handleLink(url);
  });

  if (process.defaultApp && process.argv[1]) app.setAsDefaultProtocolClient(DEEP_LINK, process.execPath, [process.argv[1]]);
  else app.setAsDefaultProtocolClient(DEEP_LINK);

  void app.whenReady().then(async () => {
    await initCrypto();
    manager = new Manager(() => win, emit);
    await manager.init();
    registerIpc();
    registerFileProtocol();
    createWindow();
    setupUpdates();
    const launchLink = process.argv.find((a) => a.startsWith(`${DEEP_LINK}://`));
    if (launchLink) pendingLink = launchLink;
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => void manager?.shutdown());
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
