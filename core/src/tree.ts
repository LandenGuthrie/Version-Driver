// Snapshots are stored as nested tree objects, but we work with them as flat
// path -> FileRec maps. Unchanged directories reuse the same tree id between commits.
import type { ObjectStore } from './objects.js';

export interface FileRec {
  size: number;
  /** 0o644 or 0o755 */
  mode: number;
  /** Ordered chunk ids; concatenating them yields the file. */
  chunks: string[];
}

export type Snapshot = Map<string, FileRec>;

interface FileEntry {
  name: string;
  t: 'f';
  size: number;
  mode: number;
  c: string[];
}
interface DirEntry {
  name: string;
  t: 'd';
  id: string;
}
export interface TreeObject {
  entries: (FileEntry | DirEntry)[];
}

export async function flattenTree(store: ObjectStore, treeId: string | null, prefix = ''): Promise<Snapshot> {
  const out: Snapshot = new Map();
  if (!treeId) return out;
  const tree = await store.getJson<TreeObject>(treeId);
  for (const e of tree.entries) {
    const path = prefix + e.name;
    if (e.t === 'f') out.set(path, { size: e.size, mode: e.mode, chunks: e.c });
    else for (const [p, rec] of await flattenTree(store, e.id, path + '/')) out.set(p, rec);
  }
  return out;
}

interface Node {
  files: Map<string, FileRec>;
  dirs: Map<string, Node>;
}

export async function writeTree(store: ObjectStore, snap: Snapshot): Promise<string> {
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, rec] of snap) {
    const parts = path.split('/');
    let n = root;
    for (const d of parts.slice(0, -1)) {
      let next = n.dirs.get(d);
      if (!next) n.dirs.set(d, (next = { files: new Map(), dirs: new Map() }));
      n = next;
    }
    n.files.set(parts[parts.length - 1]!, rec);
  }
  const emit = async (n: Node): Promise<string> => {
    const entries: (FileEntry | DirEntry)[] = [];
    for (const [name, rec] of n.files) entries.push({ name, t: 'f', size: rec.size, mode: rec.mode, c: rec.chunks });
    for (const [name, child] of n.dirs) entries.push({ name, t: 'd', id: await emit(child) });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return store.putJson('tree', { entries } satisfies TreeObject);
  };
  return emit(root);
}

export async function readTree(store: ObjectStore, treeId: string): Promise<TreeObject> {
  return store.getJson<TreeObject>(treeId);
}

/** Tree + chunk ids introduced by `treeId` relative to `parentTreeId` (skips unchanged subtrees). */
export async function newTreeObjects(
  store: ObjectStore,
  treeId: string,
  parentTreeId: string | null,
  into = new Set<string>(),
): Promise<Set<string>> {
  if (treeId === parentTreeId) return into;
  into.add(treeId);
  const tree = await readTree(store, treeId);
  const parent = parentTreeId ? await readTree(store, parentTreeId) : { entries: [] };
  const old = new Map(parent.entries.map((e) => [e.name, e]));
  for (const e of tree.entries) {
    const o = old.get(e.name);
    if (e.t === 'f') {
      const same = o?.t === 'f' && o.c.length === e.c.length && o.c.every((c, i) => c === e.c[i]);
      if (!same) for (const c of e.c) into.add(c);
    } else await newTreeObjects(store, e.id, o?.t === 'd' ? o.id : null, into);
  }
  return into;
}

/** Collect every object id (trees + chunks) reachable from a tree. */
export async function treeObjects(store: ObjectStore, treeId: string, into = new Set<string>()): Promise<Set<string>> {
  if (into.has(treeId)) return into;
  into.add(treeId);
  const tree = await store.getJson<TreeObject>(treeId);
  for (const e of tree.entries) {
    if (e.t === 'f') for (const c of e.c) into.add(c);
    else await treeObjects(store, e.id, into);
  }
  return into;
}

export type ChangeStatus = 'added' | 'modified' | 'deleted';

export interface Change {
  path: string;
  status: ChangeStatus;
  size: number;
  oldSize?: number;
}

export const sameContent = (a: FileRec, b: FileRec) =>
  a.size === b.size && a.chunks.length === b.chunks.length && a.chunks.every((c, i) => c === b.chunks[i]);

export function diffSnapshots(from: Snapshot, to: Snapshot): Change[] {
  const out: Change[] = [];
  for (const [path, rec] of to) {
    const old = from.get(path);
    if (!old) out.push({ path, status: 'added', size: rec.size });
    else if (!sameContent(old, rec) || old.mode !== rec.mode) out.push({ path, status: 'modified', size: rec.size, oldSize: old.size });
  }
  for (const [path, rec] of from) if (!to.has(path)) out.push({ path, status: 'deleted', size: 0, oldSize: rec.size });
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}
