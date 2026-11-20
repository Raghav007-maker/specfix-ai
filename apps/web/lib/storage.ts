import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * The private `task-attachments` bucket, reached with the service role. Nothing in the
 * browser can read or write it: the server checks the person's project role (packages/db)
 * before every call here, and downloads go out as short-lived signed links.
 */
export const ATTACHMENT_BUCKET = 'task-attachments';
const SIGNED_URL_SECONDS = 60;

let admin: SupabaseClient | null = null;

/** Whether file attachments can work on this server (the service role key is set). */
export function attachmentsReady(): boolean {
  return Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}

function storage() {
  if (!attachmentsReady()) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  admin ??= createClient(
    process.env.SUPABASE_URL!.trim(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
    {
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );
  return admin.storage.from(ATTACHMENT_BUCKET);
}

export async function putAttachment(path: string, body: Blob, contentType: string): Promise<void> {
  const { error } = await storage().upload(path, body, {
    contentType,
    upsert: false,
    cacheControl: '0',
  });
  if (error) throw new Error(`storage upload failed: ${error.message}`);
}

/** A link that downloads the file (never shows it inline) and stops working after a minute. */
export async function attachmentDownloadUrl(path: string, fileName: string): Promise<string> {
  const { data, error } = await storage().createSignedUrl(path, SIGNED_URL_SECONDS, {
    download: fileName,
  });
  if (error || !data) throw new Error(`signing failed: ${error?.message ?? 'no url'}`);
  return data.signedUrl;
}

/** Best effort: a file left behind is only wasted space, never visible to anyone. */
export async function removeAttachments(paths: string[]): Promise<void> {
  if (paths.length === 0 || !attachmentsReady()) return;
  const { error } = await storage().remove(paths);
  if (error) console.error('[attachments] removing stored files failed:', error.message);
}
