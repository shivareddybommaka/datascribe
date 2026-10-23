/**
 * File types accepted for medical records (§5.3: PDFs, images, TIFF), identified by their
 * leading "magic" bytes (§10), never by the file name or the browser's declared type.
 */
export const UPLOAD_TYPES = {
  'application/pdf': { label: 'PDF', ext: ['pdf'] },
  'image/png': { label: 'PNG', ext: ['png'] },
  'image/jpeg': { label: 'JPEG', ext: ['jpg', 'jpeg'] },
  'image/tiff': { label: 'TIFF', ext: ['tif', 'tiff'] },
} as const;
export type UploadMime = keyof typeof UPLOAD_TYPES;
export const UPLOAD_MIMES = Object.keys(UPLOAD_TYPES) as [UploadMime, ...UploadMime[]];

/** §5.3: max 500 MB per file. */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

/** Bytes needed to identify every accepted type. */
export const SNIFF_BYTES = 16;

const startsWith = (b: Uint8Array, sig: number[], offset = 0) =>
  b.length >= offset + sig.length && sig.every((v, i) => b[offset + i] === v);

export function detectFileType(bytes: Uint8Array): UploadMime | null {
  // "%PDF-" at offset 0 (readers tolerate leading junk; we don't)
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  // little-endian "II*\0" or big-endian "MM\0*"
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return 'image/tiff';
  }
  return null;
}

/** Count TIFF pages by walking the IFD chain. Returns null for malformed files. */
export function tiffPageCount(b: Uint8Array): number | null {
  if (b.length < 8) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const le = b[0] === 0x49;
  let offset = view.getUint32(4, le);
  let pages = 0;
  const seen = new Set<number>();
  while (offset !== 0) {
    if (offset + 2 > b.length || seen.has(offset) || pages > 100_000) return null;
    seen.add(offset);
    const entries = view.getUint16(offset, le);
    const next = offset + 2 + entries * 12;
    if (next + 4 > b.length) return null;
    pages += 1;
    offset = view.getUint32(next, le);
  }
  return pages;
}

/**
 * A display name safe to store and show: no path parts, no control characters, bounded length.
 * File names may contain PHI (e.g. a patient name), so they are never logged or audited.
 */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (cleaned || 'document').slice(0, 200);
}
