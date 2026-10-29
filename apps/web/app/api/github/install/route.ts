import { NextResponse, type NextRequest } from 'next/server';
import { createState } from '@specfix/ingest';
import { requireUser } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import { GITHUB_STATE_COOKIE, githubConfig, githubReady, githubStateKey } from '@/lib/github';

/**
 * Starts "Connect GitHub": sends an owner or admin to the app's install page. As with
 * /api/jira/connect, the signed state is also set as an httpOnly cookie scoped to
 * /api/github, so only the browser that started the install can complete it.
 */
export async function GET(request: NextRequest) {
  const user = await requireUser();
  const tenant = await requireTenant(user.id);

  const back = (error: string) =>
    NextResponse.redirect(
      new URL(`/settings/integrations?error=${encodeURIComponent(error)}`, request.url)
    );

  if (tenant.role !== 'owner' && tenant.role !== 'admin') {
    return back('Only an owner or admin can connect GitHub.');
  }
  const config = githubConfig();
  if (!config || !githubReady()) {
    return back('GitHub is not configured on this server yet.');
  }

  const state = createState({ tenantId: tenant.tenant_id, userId: user.id }, githubStateKey());
  const response = NextResponse.redirect(
    `https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new?state=${encodeURIComponent(state)}`
  );
  response.cookies.set(GITHUB_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/github',
    maxAge: 600,
  });
  return response;
}
