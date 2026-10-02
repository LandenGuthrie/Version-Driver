// Compression: zstd via node:zlib (built into Node 22.15+/24 and Electron's Node).
import zlib from 'node:zlib';

export type Level = 'fast' | 'balanced' | 'max';
export const LEVELS: Record<Level, number> = { fast: 3, balanced: 9, max: 19 };

export enum Codec {
  Raw = 0,
  Zstd = 1,
}

// Types that are already entropy-coded; compressing them again just burns CPU.
const INCOMPRESSIBLE = new Set([
  'mp3', 'aac', 'm4a', 'ogg', 'opus', 'flac', 'mp4', 'mkv', 'mov', 'webm', 'avi',
  'jpg', 'jpeg', 'webp', 'avif', 'heic', 'gif', 'zip', 'gz', 'xz', 'bz2', '7z', 'rar', 'zst', 'br',
  'docx', 'xlsx', 'pptx', 'jar', 'apk', 'woff2',
]);

export function looksIncompressible(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return INCOMPRESSIBLE.has(path.slice(dot + 1).toLowerCase());
}

export function compress(data: Uint8Array, level: Level, skip = false): { codec: Codec; bytes: Uint8Array } {
  if (skip || data.length < 64) return { codec: Codec.Raw, bytes: data };
  const out = zlib.zstdCompressSync(data, {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: LEVELS[level] },
  });
  // Keep raw if compression didn't pay for itself.
  return out.length < data.length - 8 ? { codec: Codec.Zstd, bytes: out } : { codec: Codec.Raw, bytes: data };
}

export function decompress(codec: Codec, data: Uint8Array): Uint8Array {
  if (codec === Codec.Raw) return data;
  if (codec === Codec.Zstd) return zlib.zstdDecompressSync(data);
  throw new Error(`Unknown codec ${codec}`);
}
