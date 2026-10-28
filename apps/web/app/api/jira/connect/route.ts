import { NextResponse, type NextRequest } from 'next/server';
import { JIRA_WRITE_SCOPES, authorizeUrl, createState } from '@specfix/ingest';
import { requireUser } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import { JIRA_STATE_COOKIE, jiraConfig, jiraReady, stateKey } from '@/lib/jira';

/**
 * Starts "Connect Jira": sends an owner or admin to Atlassian's consent screen. The
 * signed state is also set as an httpOnly cookie scoped to /api/jira, so only the
 * browser that started the consent can complete it (see the callback).
 */
export async function GET(request: NextRequest) {
  const user = await requireUser();
  const tenant = await requireTenant(user.id);

  const back = (error: string) =>
    NextResponse.redirect(
      new URL(`/settings/integrations?error=${encodeURIComponent(error)}`, request.url)
    );

  if (tenant.role !== 'owner' && tenant.role !== 'admin') {
    return back('Only an owner or admin can connect Jira.');
  }
  const config = jiraConfig();
  if (!config || !jiraReady()) {
    return back('Jira is not configured on this server yet.');
  }

  // `?grant=write` asks for the separate write consent used only at PM sign-off.
  const grantKind = request.nextUrl.searchParams.get('grant') === 'write' ? 'write' : 'read';
  const state = createState({ tenantId: tenant.tenant_id, userId: user.id, grantKind }, stateKey());
  const response = NextResponse.redirect(
    authorizeUrl(config, grantKind === 'write' ? { state, scopes: JIRA_WRITE_SCOPES } : { state })
  );
  response.cookies.set(JIRA_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/jira',
    maxAge: 600,
  });
  return response;
}
