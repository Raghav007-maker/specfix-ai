/**
 * RFC 4180 CSV parsing, because a PM's first export is a CSV and pulling in a
 * dependency for one function that has to handle quoted commas is not worth it.
 *
 * Handles: quoted fields, embedded commas, embedded newlines, escaped quotes ("").
 * Does not handle: alternate delimiters, comment lines. Neither has come up.
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  // Strip a UTF-8 BOM, which Excel adds and which otherwise corrupts the first header.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    // Skip rows that are entirely empty, which trailing newlines produce.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const char = text[i] as string;

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"' && field === '') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ',') {
      endField();
      i += 1;
      continue;
    }
    if (char === '\r') {
      // Normalize CRLF and lone CR.
      if (text[i + 1] === '\n') i += 1;
      endRow();
      i += 1;
      continue;
    }
    if (char === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }

  if (inQuotes) {
    throw new Error('unterminated quoted field');
  }
  if (field !== '' || row.length > 0) endRow();

  return rows;
}

/** Parses a CSV with a header row into objects keyed by normalized header name. */
export function parseCsvRecords(input: string): Record<string, string>[] {
  const rows = parseCsv(input);
  const header = rows[0];
  if (!header) return [];

  const keys = header.map((h) =>
    h
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_')
  );

  return rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    keys.forEach((key, index) => {
      record[key] = (row[index] ?? '').trim();
    });
    return record;
  });
}
