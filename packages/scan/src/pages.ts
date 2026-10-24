import { PDFDocument } from 'pdf-lib';

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

export async function countPages(mime: string, bytes: Uint8Array): Promise<number | null> {
  try {
    if (mime === 'application/pdf') {
      const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      return pdf.getPageCount();
    }
    if (mime === 'image/tiff') return tiffPageCount(bytes);
    return 1;
  } catch {
    // unreadable structure: text extraction decides; never fail the scan on page counting
    return null;
  }
}
