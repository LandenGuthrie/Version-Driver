// A small in-memory imitation of the parts of the Google Drive v3 REST API that Version Driver uses.
// It lets the real app be tested end to end with no Google account:
//   node tools/fake-drive.cjs            (listens on 127.0.0.1:9400)
//   VD_DRIVE_API=http://127.0.0.1:9400/drive/v3 VD_DRIVE_UPLOAD=http://127.0.0.1:9400/upload/drive/v3 VD_FAKE_TOKEN=x  <run the app>
const http = require('http');
const { randomUUID } = require('crypto');

const FOLDER = 'application/vnd.google-apps.folder';
const files = new Map();
const changes = []; // { fileId, removed, file }
const now = () => new Date().toISOString();
let lastTime = 0;
const stamp = () => { lastTime = Math.max(Date.now(), lastTime + 1); return new Date(lastTime).toISOString(); };

files.set('root', { id: 'root', name: 'My Drive', mimeType: FOLDER, parents: [], appProperties: {}, createdTime: now(), modifiedTime: now(), trashed: false, content: Buffer.alloc(0) });

const view = (f) => ({
  id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, appProperties: f.appProperties,
  createdTime: f.createdTime, modifiedTime: f.modifiedTime, trashed: f.trashed, size: String(f.content.length),
});
const record = (f, removed = false) => changes.push({ fileId: f.id, removed, file: view(f) });

function create(meta, content) {
  const f = {
    id: randomUUID().replace(/-/g, '').slice(0, 28), name: meta.name, mimeType: meta.mimeType ?? 'application/octet-stream',
    parents: meta.parents ?? ['root'], appProperties: meta.appProperties ?? {}, createdTime: stamp(), modifiedTime: stamp(),
    trashed: false, content: content ?? Buffer.alloc(0),
  };
  files.set(f.id, f);
  record(f);
  return f;
}

function matches(q) {
  let rest = q;
  const props = /appProperties has \{ key='([^']*)' and value='([^']*)' \}/.exec(rest);
  if (props) rest = rest.replace(props[0], 'true');
  const conds = rest.split(' and ').map((c) => c.trim()).filter((c) => c !== 'true');
  return (f) => conds.every((c) => {
    let m;
    if ((m = /^name='(.*)'$/.exec(c))) return f.name === m[1].replace(/\\'/g, "'");
    if ((m = /^mimeType='(.*)'$/.exec(c))) return f.mimeType === m[1];
    if ((m = /^'(.*)' in parents$/.exec(c))) return f.parents.includes(m[1]);
    if (c === 'trashed=false') return !f.trashed;
    if (c === 'trashed=true') return f.trashed;
    throw new Error(`fake-drive: unsupported query clause: ${c}`);
  }) && (!props || f.appProperties[props[1]] === props[2]);
}

function parseMultipart(body, contentType) {
  const bm = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const boundary = bm[1] ?? bm[2];
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let pos = body.indexOf(delim);
  while (pos >= 0) {
    const next = body.indexOf(delim, pos + delim.length);
    if (next < 0) break;
    const part = body.subarray(pos + delim.length + 2, next - 2); // strip leading \r\n and trailing \r\n
    const split = part.indexOf('\r\n\r\n');
    parts.push(part.subarray(split + 4));
    pos = next;
  }
  return { meta: JSON.parse(parts[0].toString('utf8')), content: parts[1] ?? Buffer.alloc(0) };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      const send = (obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const json = () => (body.length ? JSON.parse(body.toString('utf8')) : {});
      let m;

      if (req.method === 'GET' && p === '/drive/v3/files') {
        const test = matches(url.searchParams.get('q') ?? 'trashed=false');
        const list = [...files.values()].filter((f) => f.id !== 'root' && test(f)).sort((a, b) => (a.createdTime < b.createdTime ? -1 : 1));
        return send({ files: list.map(view) });
      }
      if (req.method === 'POST' && p === '/drive/v3/files') return send(view(create(json())));
      if ((m = /^\/drive\/v3\/files\/([^/]+)$/.exec(p))) {
        const f = files.get(m[1]);
        if (!f) return send({ error: { code: 404, message: 'File not found' } }, 404);
        if (req.method === 'GET') {
          if (url.searchParams.get('alt') === 'media') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(f.content); }
          return send(view(f));
        }
        if (req.method === 'PATCH') {
          const patch = json();
          Object.assign(f, { name: patch.name ?? f.name, trashed: patch.trashed ?? f.trashed });
          if (patch.appProperties) f.appProperties = { ...f.appProperties, ...patch.appProperties };
          f.modifiedTime = stamp();
          record(f);
          return send(view(f));
        }
        if (req.method === 'DELETE') { files.delete(f.id); record(f, true); res.writeHead(204); return res.end(); }
      }
      if (/^\/drive\/v3\/files\/[^/]+\/permissions/.test(p)) {
        if (req.method === 'GET') return send({ permissions: [] });
        return send({ id: 'perm' });
      }
      if (req.method === 'POST' && p === '/upload/drive/v3/files') {
        const { meta, content } = parseMultipart(body, req.headers['content-type']);
        return send(view(create(meta, content)));
      }
      if ((m = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(p)) && req.method === 'PATCH') {
        const f = files.get(m[1]);
        if (!f) return send({ error: { code: 404 } }, 404);
        f.content = url.searchParams.get('uploadType') === 'multipart' ? parseMultipart(body, req.headers['content-type']).content : body;
        f.modifiedTime = stamp();
        record(f);
        return send(view(f));
      }
      if (req.method === 'GET' && p === '/drive/v3/changes/startPageToken') return send({ startPageToken: String(changes.length) });
      if (req.method === 'GET' && p === '/drive/v3/changes') {
        const from = Number(url.searchParams.get('pageToken'));
        return send({ changes: changes.slice(from), newStartPageToken: String(changes.length) });
      }
      if (req.method === 'POST' && p === '/__reset') { files.clear(); changes.length = 0; return send({ ok: true }); }
      if (req.method === 'GET' && p === '/__dump') {
        return send([...files.values()].filter((f) => f.id !== 'root').map((f) => ({ ...view(f), path: pathOf(f) })));
      }
      send({ error: { code: 404, message: `fake-drive: no route for ${req.method} ${p}` } }, 404);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 500, message: String(e && e.message) } }));
    }
  });
});

function pathOf(f) {
  const parts = [f.name];
  let cur = f;
  while (cur.parents[0] && cur.parents[0] !== 'root') { cur = files.get(cur.parents[0]); if (!cur) break; parts.unshift(cur.name); }
  return parts.join('/');
}

if (require.main === module) server.listen(9400, '127.0.0.1', () => console.log('fake Drive on http://127.0.0.1:9400'));
module.exports = { server };
