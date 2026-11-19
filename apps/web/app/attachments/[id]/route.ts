import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import { getAttachment } from '@/lib/repos';
import { redirectTo } from '@/lib/redirect';
import { attachmentDownloadUrl, attachmentsReady } from '@/lib/storage';

/**
 * Downloads a task's file. The person's project role is checked in packages/db first; a file
 * they cannot see answers exactly like one that does not exist. The answer is a redirect to a
 * signed Storage link that lives one minute and always downloads (never renders) the file.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return redirectTo('/login');
  if (session.pending) return redirectTo('/login/verify');
  const notFound = () =>
    new NextResponse('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

  const { id } = await params;
  const tenant = await requireTenant(session.user.id);
  const file = await getAttachment(tenant.tenant_id, session.user.id, id);
  if (!file || !attachmentsReady()) return notFound();
  try {
    const url = await attachmentDownloadUrl(file.storage_path, file.file_name);
    return new NextResponse(null, {
      status: 302,
      headers: { Location: url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
    });
  } catch (error) {
    console.error('[attachments] signing failed:', error instanceof Error ? error.message : error);
    return new NextResponse('Could not open the file. Please try again.', {
      status: 502,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
