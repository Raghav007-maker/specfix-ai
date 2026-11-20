import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MIME_TYPES,
  checkAttachment,
  formatBytes,
  safeFileName,
} from '../src/index.ts';

const bytes = (...b: number[]) => new Uint8Array(b);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);
const PDF = new TextEncoder().encode('%PDF-1.7\n');
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0);
const TEXT = new TextEncoder().encode('steps to reproduce');

describe('checkAttachment', () => {
  it('accepts real images, PDFs, text and Office files with their type', () => {
    expect(checkAttachment({ name: 'shot.PNG', size: 100, head: PNG })).toEqual({
      ok: true,
      name: 'shot.PNG',
      contentType: 'image/png',
    });
    expect(checkAttachment({ name: 'spec.pdf', size: 100, head: PDF })).toMatchObject({ ok: true });
    expect(checkAttachment({ name: 'notes.txt', size: 18, head: TEXT })).toMatchObject({
      ok: true,
      contentType: 'text/plain',
    });
    expect(checkAttachment({ name: 'plan.xlsx', size: 6, head: ZIP })).toMatchObject({ ok: true });
  });

  it('refuses empty, oversized, unknown and scriptable files', () => {
    expect(checkAttachment({ name: 'a.png', size: 0, head: PNG })).toMatchObject({ ok: false });
    expect(
      checkAttachment({ name: 'a.png', size: ATTACHMENT_MAX_BYTES + 1, head: PNG })
    ).toMatchObject({ ok: false, error: /10 MB/ });
    for (const name of ['logo.svg', 'page.html', 'run.exe', 'noextension', 'x.js']) {
      expect(checkAttachment({ name, size: 10, head: TEXT })).toMatchObject({ ok: false });
    }
  });

  it('refuses a file whose bytes do not match its extension', () => {
    expect(checkAttachment({ name: 'fake.png', size: 9, head: PDF })).toMatchObject({
      ok: false,
      error: /not a real \.png/,
    });
    expect(checkAttachment({ name: 'bin.txt', size: 4, head: bytes(0x41, 0, 0x42) })).toMatchObject(
      {
        ok: false,
      }
    );
    expect(checkAttachment({ name: 'x.pdf', size: 4, head: bytes() })).toMatchObject({ ok: false });
  });

  it('never stores SVG or HTML as an allowed type', () => {
    expect(ATTACHMENT_MIME_TYPES.some((t) => /svg|html|javascript/.test(t))).toBe(false);
  });
});

describe('safeFileName', () => {
  it('drops paths, control and header characters, and keeps the extension when cutting', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\Users\\me\\bug report.png')).toBe('bug report.png');
    expect(safeFileName('a"b\r\nc;d.txt')).toBe('abcd.txt');
    expect(safeFileName('...hidden')).toBe('hidden');
    expect(safeFileName('   ')).toBe('file');
    const long = safeFileName(`${'x'.repeat(300)}.pdf`);
    expect(long).toHaveLength(120);
    expect(long.endsWith('.pdf')).toBe(true);
  });
});

describe('formatBytes', () => {
  it('reads like a file manager', () => {
    expect(formatBytes(12)).toBe('12 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1_258_291)).toBe('1.2 MB');
  });
});
