import { requireUser } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import { getScaffold, getTicket } from '@/lib/repos';

/**
 * Download one scaffold as a `.spec.ts` file.
 *
 * A GET route handler rather than a server action, because a download needs a real
 * response with a Content-Disposition header. It is tenant-scoped through `getScaffold`
 * (whose first argument is the resolved tenant), so a scaffold id from another tenant
 * is simply not found — the same 404 as one that does not exist.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ ticketId: string; scaffoldId: string }> }
): Promise<Response> {
  const { scaffoldId } = await params;

  const user = await requireUser();
  const tenant = await requireTenant(user.id);

  const scaffold = await getScaffold(tenant.tenant_id, scaffoldId);
  if (!scaffold) return new Response('Not found', { status: 404 });

  const ticket = await getTicket(tenant.tenant_id, scaffold.ticket_id);
  const key = ticket?.external_key ?? 'scenario';
  const filename = `${slug(key)}-${scaffoldId.slice(0, 8)}.spec.ts`;

  return new Response(scaffold.code, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });
}

function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'scenario';
}
