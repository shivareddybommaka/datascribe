import { describe, expect, it } from 'vitest';
import { partCountFor, partSizeFor } from '../services/documents';
import { cleanFileName, detectFileType, tiffPageCount } from './filetype';
import { contentDisposition } from './storage';

const b = (...bytes: number[]) => Uint8Array.from(bytes);

describe('detectFileType (magic bytes, §10)', () => {
  it('recognises the accepted types', () => {
    expect(detectFileType(new TextEncoder().encode('%PDF-1.7\n'))).toBe('application/pdf');
    expect(detectFileType(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png');
    expect(detectFileType(b(0xff, 0xd8, 0xff, 0xdb))).toBe('image/jpeg');
    expect(detectFileType(b(0x49, 0x49, 0x2a, 0x00))).toBe('image/tiff');
    expect(detectFileType(b(0x4d, 0x4d, 0x00, 0x2a))).toBe('image/tiff');
  });

  it('rejects everything else, including look-alikes', () => {
    expect(detectFileType(b(0x50, 0x4b, 0x03, 0x04))).toBeNull(); // zip / docx
    expect(detectFileType(b(0x4d, 0x5a, 0x90, 0x00))).toBeNull(); // Windows exe
    expect(detectFileType(new TextEncoder().encode('<html><body>%PDF-'))).toBeNull();
    expect(detectFileType(new TextEncoder().encode('%PD'))).toBeNull();
    expect(detectFileType(b())).toBeNull();
  });
});

describe('tiffPageCount', () => {
  it('walks the IFD chain (little and big endian) and refuses loops', () => {
    // LE: header → IFD at 8 (0 entries) → IFD at 14 (0 entries) → end
    const two = b(0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0, 14, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    expect(tiffPageCount(two)).toBe(2);
    const be = b(0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0);
    expect(tiffPageCount(be)).toBe(1);
    const loop = b(0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0, 8, 0, 0, 0);
    expect(tiffPageCount(loop)).toBeNull();
    expect(tiffPageCount(b(0x49, 0x49, 0x2a, 0, 200, 0, 0, 0))).toBeNull();
  });
});

describe('multipart sizing', () => {
  it('keeps the configured part size until S3’s 10,000-part limit forces larger parts', () => {
    const MiB = 1024 * 1024;
    expect(partSizeFor(500 * MiB, 8 * MiB)).toBe(8 * MiB);
    expect(partCountFor(500 * MiB, 8 * MiB)).toBe(63);
    expect(partCountFor(1, 8 * MiB)).toBe(1);
    const huge = 100_000 * MiB;
    expect(partCountFor(huge, partSizeFor(huge, 5 * MiB))).toBeLessThanOrEqual(10_000);
  });
});

describe('file names', () => {
  it('drops path parts and control characters', () => {
    expect(cleanFileName('../../etc/passwd')).toBe('passwd');
    expect(cleanFileName('C:\\Users\\x\\ER\u0000 visit.pdf')).toBe('ER visit.pdf');
    expect(cleanFileName('   ')).toBe('document');
    expect(cleanFileName('a'.repeat(300))).toHaveLength(200);
  });

  it('builds a download header that cannot be broken by quotes or non-ASCII names', () => {
    expect(contentDisposition('ER "visit".pdf')).toBe(
      `attachment; filename="ER _visit_.pdf"; filename*=UTF-8''ER%20%22visit%22.pdf`,
    );
    expect(contentDisposition('Ärztebrief.pdf')).toContain(`filename="_rztebrief.pdf"`);
  });
});
