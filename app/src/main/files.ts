import { diffLines } from 'diff';
import type { DiffRow, FileKind } from '../shared/api';

const IMAGE: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon',
};
const AUDIO: Record<string, string> = {
  wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/ogg', aiff: 'audio/aiff',
};
const VIDEO: Record<string, string> = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4' };

const ext = (p: string) => p.slice(p.lastIndexOf('.') + 1).toLowerCase();

export function kindOf(path: string): FileKind {
  const e = ext(path);
  if (IMAGE[e]) return e === 'svg' ? 'image' : 'image';
  if (AUDIO[e]) return 'audio';
  if (VIDEO[e]) return 'video';
  return 'text'; // refined by looksBinary() once we have bytes
}

export function mimeOf(path: string): string {
  const e = ext(path);
  return IMAGE[e] ?? AUDIO[e] ?? VIDEO[e] ?? 'text/plain; charset=utf-8';
}

/** NUL byte in the first 8KB => binary. */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

export const MAX_DIFF_BYTES = 2 * 1024 * 1024;

export function textRows(oldText: string, newText: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let o = 1;
  let n = 1;
  for (const part of diffLines(oldText, newText)) {
    const lines = part.value.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (const s of lines) {
      if (part.added) rows.push({ t: 'add', n: n++, s });
      else if (part.removed) rows.push({ t: 'del', o: o++, s });
      else rows.push({ t: 'ctx', o: o++, n: n++, s });
    }
  }
  return rows;
}
