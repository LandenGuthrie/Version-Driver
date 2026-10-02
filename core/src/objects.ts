// Sealed object store: every object is compressed, then encrypted, then addressed by a
// keyed hash of its plaintext. Same layout locally and on the remote.
//
//   header (5 bytes): 'V' 'D' | format=1 | key epoch | codec
//   body: nonce(24) || XChaCha20-Poly1305(compress(plaintext)), AD = header || id
import { compress, decompress, Codec, type Level } from './compress.js';
import { contentId, deriveKeys, open as aeadOpen, seal, type Keys } from './crypto.js';
import type { BlobStorage } from './storage.js';

export type ObjectKind = 'chunk' | 'tree' | 'commit' | 'meta';

export class Keyring {
  private keys = new Map<number, Keys>();
  private raw = new Map<number, Uint8Array>();
  current: number;

  constructor(repoKeys: Map<number, Uint8Array>) {
    if (repoKeys.size === 0) throw new Error('Keyring needs at least one key');
    for (const [epoch, k] of repoKeys) {
      this.keys.set(epoch, deriveKeys(k));
      this.raw.set(epoch, k);
    }
    this.current = Math.max(...repoKeys.keys());
  }

  get(epoch: number): Keys {
    const k = this.keys.get(epoch);
    if (!k) throw new Error(`No key for epoch ${epoch} (was access rotated?)`);
    return k;
  }

  /** Raw repo keys by epoch, for persisting to the OS credential store. */
  epochs(): Map<number, Uint8Array> {
    return new Map(this.raw);
  }

  get currentKeys() {
    return this.get(this.current);
  }

  /** Add a key epoch (after rotation or when a new key is unwrapped). */
  add(epoch: number, repoKey: Uint8Array) {
    this.keys.set(epoch, deriveKeys(repoKey));
    this.raw.set(epoch, repoKey);
    this.current = Math.max(this.current, epoch);
  }
}

export const objectKey = (id: string) => `objects/${id.slice(0, 2)}/${id.slice(2)}`;

const enc = new TextEncoder();
const dec = new TextDecoder();

export class ObjectStore {
  constructor(
    readonly storage: BlobStorage,
    readonly keyring: Keyring,
    public level: Level = 'balanced',
  ) {}

  /** Id of a plaintext without writing anything (used by status). */
  idOf(kind: ObjectKind, data: Uint8Array): string {
    // Ids are always derived with the *current* epoch's id key so rotation doesn't fork dedup.
    return contentId(this.keyring.currentKeys, kind, data);
  }

  has(id: string) {
    return this.storage.has(objectKey(id));
  }

  async put(kind: ObjectKind, data: Uint8Array, opts: { skipCompress?: boolean } = {}): Promise<string> {
    const id = this.idOf(kind, data);
    if (await this.has(id)) return id;
    await this.putWithId(id, data, opts.skipCompress);
    return id;
  }

  async putWithId(id: string, data: Uint8Array, skipCompress = false) {
    const { codec, bytes } = compress(data, this.level, skipCompress);
    const header = new Uint8Array([0x56, 0x44, 1, this.keyring.current, codec]);
    const sealed = seal(this.keyring.currentKeys, bytes, adFor(header, id));
    const out = new Uint8Array(header.length + sealed.length);
    out.set(header, 0);
    out.set(sealed, header.length);
    await this.storage.put(objectKey(id), out);
  }

  /** Raw sealed bytes, for copying objects to/from a remote without re-encrypting. */
  getSealed(id: string) {
    return this.storage.get(objectKey(id));
  }

  putSealed(id: string, bytes: Uint8Array) {
    return this.storage.put(objectKey(id), bytes);
  }

  async get(id: string): Promise<Uint8Array> {
    const raw = await this.storage.get(objectKey(id));
    if (!raw) throw new Error(`Missing object ${id}`);
    return this.decode(id, raw);
  }

  decode(id: string, raw: Uint8Array): Uint8Array {
    if (raw[0] !== 0x56 || raw[1] !== 0x44 || raw[2] !== 1) throw new Error(`Bad object header for ${id}`);
    const header = raw.subarray(0, 5);
    const plain = aeadOpen(this.keyring.get(raw[3]!), raw.subarray(5), adFor(header, id));
    return decompress(raw[4] as Codec, plain);
  }

  /** Seal small named metadata (ref log entries, comments, locks). `name` is bound as AD. */
  sealMeta(name: string, value: unknown): Uint8Array {
    const header = new Uint8Array([0x56, 0x44, 1, this.keyring.current, 0]);
    const sealed = seal(this.keyring.currentKeys, enc.encode(JSON.stringify(value)), adFor(header, name));
    const out = new Uint8Array(header.length + sealed.length);
    out.set(header, 0);
    out.set(sealed, header.length);
    return out;
  }

  openMeta<T>(name: string, raw: Uint8Array): T {
    const header = raw.subarray(0, 5);
    const plain = aeadOpen(this.keyring.get(raw[3]!), raw.subarray(5), adFor(header, name));
    return JSON.parse(dec.decode(plain)) as T;
  }

  async putJson(kind: ObjectKind, value: unknown) {
    return this.put(kind, enc.encode(JSON.stringify(value)));
  }

  async getJson<T>(id: string): Promise<T> {
    return JSON.parse(dec.decode(await this.get(id))) as T;
  }
}

function adFor(header: Uint8Array, id: string): Uint8Array {
  const idb = enc.encode(id);
  const ad = new Uint8Array(header.length + idb.length);
  ad.set(header, 0);
  ad.set(idb, header.length);
  return ad;
}
