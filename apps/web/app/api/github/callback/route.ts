import { NextResponse, type NextRequest } from 'next/server';
import {
  GithubAuthError,
  GithubClient,
  GithubHttpError,
  createInstallationToken,
  getInstallation,
  userCanAccessInstallation,
  verifyState,
} from '@specfix/ingest';
import { requireUser } from '@/lib/session';
import { TENANT_COOKIE } from '@/lib/tenant';
import { GithubConnectionError, saveGithubInstallation } from '@/lib/repos';
import { GITHUB_STATE_COOKIE, githubConfig, githubStateKey } from '@/lib/github';

/**
 * Where GitHub sends the browser after the app is installed (the app's callback URL,
 * with "Request user authorization (OAuth) during installation" enabled).
 *
 * Three checks before anything is stored:
 *   1. the `state` equals the cookie set by /api/github/install, verifies, is unexpired
 *      and names the signed-in user — so an install started elsewhere cannot finish here;
 *   2. the one-time OAuth `code` proves which GitHub user finished the install, and that
 *      user must be able to see `installation_id` — the id is a plain query parameter,
 *      so without this anyone could attach another organisation's installation;
 *   3. saveGithubInstallation re-checks owner/admin and refuses an installation already
 *      attached to another workspace.
 */
export async function GET(request: NextRequest) {
  const user = await requireUser();
  const params = request.nextUrl.searchParams;
  const cookieState = request.cookies.get(GITHUB_STATE_COOKIE)?.value;

  const finish = (query: Record<string, string>, tenantId?: string) => {
    const response = NextResponse.redirect(
      new URL(`/settings/integrations?${new URLSearchParams(query).toString()}`, request.url)
    );
    response.cookies.delete({ name: GITHUB_STATE_COOKIE, path: '/api/github' });
    if (tenantId) {
      response.cookies.set(TENANT_COOKIE, tenantId, { httpOnly: true, sameSite: 'lax', path: '/' });
    }
    return response;
  };

  const stateParam = params.get('state');
  const state = stateParam ? verifyState(stateParam, githubStateKey()) : null;
  if (!state || stateParam !== cookieState || state.userId !== user.id) {
    return finish({ error: 'That GitHub link is invalid or expired. Please try again.' });
  }
  if (params.get('setup_action') === 'request') {
    return finish(
      { notice: 'Install requested. An owner of the GitHub organization has to approve it.' },
      state.tenantId
    );
  }

  const code = params.get('code');
  const rawId = params.get('installation_id') ?? '';
  const installationId = /^\d{1,15}$/.test(rawId) ? Number(rawId) : NaN;
  if (!code || !Number.isSafeInteger(installationId) || installationId <= 0) {
    return finish({ error: 'GitHub did not finish the installation.' }, state.tenantId);
  }

  const config = githubConfig();
  if (!config) return finish({ error: 'GitHub is not configured on this server yet.' });

  try {
    if (!(await userCanAccessInstallation(config, code, installationId))) {
      return finish(
        { error: 'Your GitHub account cannot see that installation of the app.' },
        state.tenantId
      );
    }
    const info = await getInstallation(config, installationId);
    const { token } = await createInstallationToken(config, installationId);
    const repos = await new GithubClient(token).listInstallationRepos();
    await saveGithubInstallation(state.tenantId, user.id, { ...info, repos });
    return finish(
      {
        notice: `Connected GitHub (${info.accountLogin}, ${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'}). Map repositories to projects below.`,
      },
      state.tenantId
    );
  } catch (error) {
    if (error instanceof GithubConnectionError || error instanceof GithubAuthError) {
      return finish({ error: error.message }, state.tenantId);
    }
    if (error instanceof GithubHttpError) {
      return finish(
        { error: 'GitHub could not be reached just now. Please try again.' },
        state.tenantId
      );
    }
    console.error('github callback failed', error);
    return finish(
      { error: 'Could not finish connecting GitHub. Please try again.' },
      state.tenantId
    );
  }
}
