/**
 * Rules for files attached to tasks, shared by the upload action and its tests.
 *
 * A file is accepted by its extension and its first bytes together: the extension picks the
 * type, and for binary types the bytes must match it, so a renamed file cannot slip through.
 * Anything a browser could run (SVG, HTML) is refused outright, and downloads are always
 * served as attachments.
 */

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENTS_PER_TASK = 20;
/** The longest stored file name, extension included. */
export const ATTACHMENT_NAME_MAX = 120;

type Magic = 'png' | 'jpeg' | 'gif' | 'webp' | 'pdf' | 'zip' | 'text';

const TYPES: Record<string, { mime: string; magic: Magic }> = {
  png: { mime: 'image/png', magic: 'png' },
  jpg: { mime: 'image/jpeg', magic: 'jpeg' },
  jpeg: { mime: 'image/jpeg', magic: 'jpeg' },
  gif: { mime: 'image/gif', magic: 'gif' },
  webp: { mime: 'image/webp', magic: 'webp' },
  pdf: { mime: 'application/pdf', magic: 'pdf' },
  txt: { mime: 'text/plain', magic: 'text' },
  log: { mime: 'text/plain', magic: 'text' },
  md: { mime: 'text/markdown', magic: 'text' },
  csv: { mime: 'text/csv', magic: 'text' },
  json: { mime: 'application/json', magic: 'text' },
  zip: { mime: 'application/zip', magic: 'zip' },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    magic: 'zip',
  },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: 'zip' },
};

/** Every content type an attachment can be stored as (the storage bucket's allow-list). */
export const ATTACHMENT_MIME_TYPES = [...new Set(Object.values(TYPES).map((t) => t.mime))];

/** The extensions the file picker offers. */
export const ATTACHMENT_ACCEPT = Object.keys(TYPES)
  .map((ext) => `.${ext}`)
  .join(',');

/**
 * A name safe to store and to put in a download header: no path, no control or quote
 * characters, spaces collapsed, at most 120 characters with the extension kept.
 */
export function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  let name = [...base.normalize('NFC')]
    // Control characters (a header injection risk) and characters no file system allows.
    .filter((c) => c.charCodeAt(0) > 0x1f && c.charCodeAt(0) !== 0x7f && !'"<>:|?*;'.includes(c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (!name) name = 'file';
  if (name.length <= ATTACHMENT_NAME_MAX) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
  return name.slice(0, ATTACHMENT_NAME_MAX - ext.length) + ext;
}

const startsWith = (bytes: Uint8Array, sig: number[], at = 0) =>
  bytes.length >= at + sig.length && sig.every((b, i) => bytes[at + i] === b);

function matches(magic: Magic, head: Uint8Array): boolean {
  switch (magic) {
    case 'png':
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'jpeg':
      return startsWith(head, [0xff, 0xd8, 0xff]);
    case 'gif':
      return startsWith(head, [0x47, 0x49, 0x46, 0x38]);
    case 'webp':
      return (
        startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)
      );
    case 'pdf':
      return startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d]);
    case 'zip':
      return (
        startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])
      );
    case 'text':
      // Text may be empty; it must not carry NUL bytes (a binary file renamed .txt).
      return !head.includes(0);
  }
}

export type AttachmentCheck =
  { ok: true; name: string; contentType: string } | { ok: false; error: string };

/** Whether a file may be attached, and the name and type it is stored with. */
export function checkAttachment(file: {
  name: string;
  size: number;
  head: Uint8Array;
}): AttachmentCheck {
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, error: 'That file is empty.' };
  }
  if (file.size > ATTACHMENT_MAX_BYTES) {
    return { ok: false, error: 'A file can be at most 10 MB.' };
  }
  const name = safeFileName(file.name);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const type = TYPES[ext];
  if (!type) {
    return {
      ok: false,
      error:
        'That file type cannot be attached. Use an image, PDF, text, CSV, JSON, ZIP, DOCX or XLSX file.',
    };
  }
  if (!matches(type.magic, file.head)) {
    return { ok: false, error: `That file is not a real .${ext} file.` };
  }
  return { ok: true, name, contentType: type.mime };
}

/** "1.2 MB", "340 KB", "12 B". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
