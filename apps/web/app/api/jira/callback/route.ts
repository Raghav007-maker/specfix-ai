import { NextResponse, type NextRequest } from 'next/server';
import {
  JiraAuthError,
  JiraHttpError,
  accessibleResources,
  exchangeCode,
  verifyState,
} from '@specfix/ingest';
import { requireUser } from '@/lib/session';
import { TENANT_COOKIE } from '@/lib/tenant';
import { JiraConnectionError, getJiraConnection, saveJiraGrant, setJiraSite } from '@/lib/repos';
import { JIRA_STATE_COOKIE, jiraConfig, stateKey } from '@/lib/jira';

/**
 * Where Atlassian sends the browser after consent.
 *
 * The `state` in the URL must equal the cookie set by /api/jira/connect, carry a valid
 * signature, be unexpired, and name the signed-in user — so a consent started in another
 * browser, or a code an attacker obtained for their own Jira, cannot be attached to this
 * workspace. saveJiraGrant then re-checks that the user is still an owner or admin.
 *
 * When the grant reaches exactly one Jira site it is chosen automatically; otherwise the
 * integrations page asks which one.
 */
export async function GET(request: NextRequest) {
  const user = await requireUser();
  const params = request.nextUrl.searchParams;
  const cookieState = request.cookies.get(JIRA_STATE_COOKIE)?.value;

  const finish = (query: Record<string, string>, tenantId?: string) => {
    const response = NextResponse.redirect(
      new URL(`/settings/integrations?${new URLSearchParams(query).toString()}`, request.url)
    );
    response.cookies.delete({ name: JIRA_STATE_COOKIE, path: '/api/jira' });
    if (tenantId) {
      response.cookies.set(TENANT_COOKIE, tenantId, { httpOnly: true, sameSite: 'lax', path: '/' });
    }
    return response;
  };

  if (params.get('error')) {
    return finish({ error: 'Jira connection was cancelled.' });
  }

  const code = params.get('code');
  const stateParam = params.get('state');
  const state = stateParam ? verifyState(stateParam, stateKey()) : null;
  if (!code || !state || stateParam !== cookieState || state.userId !== user.id) {
    return finish({ error: 'That Jira connection link is invalid or expired. Please try again.' });
  }

  const config = jiraConfig();
  if (!config) return finish({ error: 'Jira is not configured on this server yet.' });

  try {
    const tokens = await exchangeCode(config, code);

    if (state.grantKind === 'write') {
      // The write grant must reach the same site the workspace already syncs from.
      const read = await getJiraConnection(state.tenantId, 'read');
      const sites = await accessibleResources(tokens.accessToken);
      if (!read?.cloud_id || !sites.some((s) => s.cloudId === read.cloud_id)) {
        return finish(
          { error: 'Write access must be granted on the same Jira site SpecFix syncs from.' },
          state.tenantId
        );
      }
      if (!tokens.scopes.includes('write:jira-work')) {
        return finish({ error: 'Jira did not grant write access.' }, state.tenantId);
      }
      await saveJiraGrant(state.tenantId, user.id, 'write', tokens);
      return finish({ notice: 'Jira write-back enabled for PM sign-off.' }, state.tenantId);
    }

    await saveJiraGrant(state.tenantId, user.id, 'read', tokens);

    const sites = await accessibleResources(tokens.accessToken);
    if (sites.length === 0) {
      return finish(
        { error: 'Connected, but this Atlassian account cannot see any Jira site.' },
        state.tenantId
      );
    }
    if (sites.length === 1) {
      const [site] = sites;
      await setJiraSite(state.tenantId, user.id, {
        cloudId: site!.cloudId,
        siteUrl: site!.url,
        siteName: site!.name,
      });
      return finish({ notice: `Connected to ${site!.name}.` }, state.tenantId);
    }
    return finish({ notice: 'Connected. Choose which Jira site to use.' }, state.tenantId);
  } catch (error) {
    if (
      error instanceof JiraConnectionError ||
      error instanceof JiraAuthError ||
      error instanceof JiraHttpError
    ) {
      return finish({ error: error.message }, state.tenantId);
    }
    console.error('jira callback failed', error);
    return finish({ error: 'Could not finish connecting Jira. Please try again.' }, state.tenantId);
  }
}
