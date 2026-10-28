import 'server-only';

/**
 * A request body as text, or null as soon as it exceeds `limit` bytes.
 *
 * For the machine-to-machine endpoints (Jira webhooks, CI results), whose callers are
 * untrusted: a chunked upload has no Content-Length to check, and `request.json()` /
 * `request.text()` would buffer the whole body before any size check could run.
 */
export async function readLimited(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}
