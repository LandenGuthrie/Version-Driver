// Content-defined chunking (FastCDC-style, normalized, 32-bit gear hash).
// Deterministic across machines: the gear table comes from a fixed-seed PRNG.
import { open } from 'node:fs/promises';

export const MIN_CHUNK = 32 * 1024;
export const AVG_CHUNK = 128 * 1024;
export const MAX_CHUNK = 512 * 1024;

const GEAR = (() => {
  const t = new Uint32Array(256);
  let s = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    // splitmix32
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    t[i] = (z ^ (z >>> 16)) >>> 0;
  }
  return t;
})();

const BITS = Math.log2(AVG_CHUNK); // 17
const highMask = (bits: number) => (((1 << bits) - 1) << (32 - bits)) >>> 0;
const MASK_S = highMask(BITS + 2); // stricter before the average size
const MASK_L = highMask(BITS - 2); // looser after it

/** Length of the next chunk starting at `start` within buf[start..end). */
export function cutPoint(buf: Uint8Array, start: number, end: number): number {
  const n = end - start;
  if (n <= MIN_CHUNK) return n;
  const limit = Math.min(n, MAX_CHUNK);
  const normal = Math.min(limit, AVG_CHUNK);
  let h = 0;
  let i = MIN_CHUNK;
  for (; i < normal; i++) {
    h = ((h << 1) + GEAR[buf[start + i]!]!) >>> 0;
    if ((h & MASK_S) === 0) return i + 1;
  }
  for (; i < limit; i++) {
    h = ((h << 1) + GEAR[buf[start + i]!]!) >>> 0;
    if ((h & MASK_L) === 0) return i + 1;
  }
  return limit;
}

export function* chunkBuffer(buf: Uint8Array): Generator<Uint8Array> {
  let pos = 0;
  while (pos < buf.length) {
    const len = cutPoint(buf, pos, buf.length);
    yield buf.subarray(pos, pos + len);
    pos += len;
  }
}

/** Streams a file in bounded memory, yielding content-defined chunks. */
export async function* chunkFile(path: string): AsyncGenerator<Uint8Array> {
  const fh = await open(path, 'r');
  try {
    const READ = 4 * 1024 * 1024;
    const buf = Buffer.alloc(READ + MAX_CHUNK);
    let have = 0;
    let eof = false;
    while (true) {
      while (!eof && have < buf.length - 1) {
        const { bytesRead } = await fh.read(buf, have, buf.length - have, null);
        if (bytesRead === 0) eof = true;
        else have += bytesRead;
      }
      let pos = 0;
      // Only cut when a full max-size window is buffered, or at EOF, so cut points
      // never depend on how the reads happened to be split.
      while (have - pos > 0 && (eof || have - pos >= MAX_CHUNK)) {
        const len = cutPoint(buf, pos, have);
        yield Uint8Array.prototype.slice.call(buf, pos, pos + len);
        pos += len;
      }
      buf.copy(buf, 0, pos, have);
      have -= pos;
      if (eof && have === 0) return;
    }
  } finally {
    await fh.close();
  }
}
