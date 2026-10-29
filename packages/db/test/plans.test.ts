/**
 * Workspace plans: Free allows five projects (file or Jira), Pro removes the limit, the app's
 * own team is exempt, and parallel requests cannot squeeze in a sixth project.
 *
 * The pure rules run everywhere; the database suites are skipped without
 * SPECFIX_TEST_DATABASE_URL, like the other fixture-writing suites.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  FREE_PROJECT_LIMIT,
  ProjectLimitError,
  addJiraProject,
  agentAccessFor,
  addMembership,
  closePool,
  createProject,
  createTenant,
  createWorkspace,
  isAppOwnerEmail,
  isPro,
  listProjects,
  planNotice,
  proCta,
  query,
  saveJiraGrant,
  setJiraSite,
  setProUntil,
  tenantPlan,
  type TenantPlan,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);
const DAY = 86_400_000;
const now = new Date('2026-11-01T12:00:00Z');

afterAll(async () => {
  if (hasDatabase) await closePool();
});

const plan = (p: Partial<TenantPlan>): TenantPlan => ({
  pro: false,
  proUntil: null,
  projectCount: 0,
  ...p,
});

describe('plan rules', () => {
  it('is Pro only while pro_until is in the future', () => {
    expect(isPro(null, now)).toBe(false);
    expect(isPro(new Date(now.getTime() + 1000), now)).toBe(true);
    expect(isPro(new Date(now.getTime() - 1000), now)).toBe(false);
    expect(isPro(now, now)).toBe(false);
  });

  it('recognises the app owners by confirmed email only', () => {
    const list = ' Owner@SpecFix.test , second@specfix.test,';
    expect(isAppOwnerEmail(list, 'owner@specfix.test', true)).toBe(true);
    expect(isAppOwnerEmail(list, ' SECOND@specfix.test ', true)).toBe(true);
    expect(isAppOwnerEmail(list, 'owner@specfix.test', false)).toBe(false);
    expect(isAppOwnerEmail(list, 'someone@specfix.test', true)).toBe(false);
    expect(isAppOwnerEmail(list, '', true)).toBe(false);
    expect(isAppOwnerEmail(undefined, 'owner@specfix.test', true)).toBe(false);
    expect(isAppOwnerEmail('', 'owner@specfix.test', true)).toBe(false);
    // A trailing comma must not make an empty address an owner.
    expect(isAppOwnerEmail('a@x.test,', '', true)).toBe(false);
  });

  it('warns three days before Pro ends and for a week after', () => {
    const at = (ms: number) => new Date(now.getTime() + ms);
    expect(planNotice(plan({ pro: true, proUntil: at(4 * DAY) }), now)).toBeNull();
    expect(planNotice(plan({ pro: true, proUntil: at(2 * DAY) }), now)).toEqual({
      kind: 'renew',
      on: at(2 * DAY),
    });
    expect(planNotice(plan({ proUntil: at(-2 * DAY) }), now)).toEqual({
      kind: 'lapsed',
      on: at(-2 * DAY),
    });
    expect(planNotice(plan({ proUntil: at(-8 * DAY) }), now)).toBeNull();
  });

  it('warns a Free workspace at four and five projects, never a Pro one', () => {
    expect(planNotice(plan({ projectCount: 3 }), now)).toBeNull();
    expect(planNotice(plan({ projectCount: 4 }), now)).toMatchObject({ kind: 'near-limit' });
    expect(planNotice(plan({ projectCount: 5 }), now)).toMatchObject({ kind: 'at-limit' });
    expect(planNotice(plan({ projectCount: 9 }), now)).toMatchObject({ kind: 'at-limit' });
    expect(
      planNotice(
        plan({ pro: true, proUntil: new Date(now.getTime() + 30 * DAY), projectCount: 9 }),
        now
      )
    ).toBeNull();
  });

  it('offers the upgrade only to owners and admins of a Free workspace', () => {
    const cta = (pro: boolean, appOwner: boolean, role: 'owner' | 'admin' | 'reviewer') =>
      proCta({ pro, appOwner, role });
    expect(cta(false, false, 'owner')).toBe('upgrade');
    expect(cta(false, false, 'admin')).toBe('upgrade');
    expect(cta(false, false, 'reviewer')).toBe('ask-admin');
    expect(cta(true, false, 'reviewer')).toBe('current');
    expect(cta(true, false, 'owner')).toBe('extend');
    expect(cta(true, false, 'admin')).toBe('extend');
    expect(cta(false, true, 'reviewer')).toBe('team');
    expect(cta(true, true, 'owner')).toBe('team');
  });

  it('runs the agent only with its flag on, for Pro workspaces and the app owners', () => {
    const access = (enabled: boolean, appOwner: boolean, pro: boolean) =>
      agentAccessFor({ enabled, appOwner, pro });
    expect(access(false, true, true)).toBe('off');
    expect(access(true, false, false)).toBe('locked');
    expect(access(true, false, true)).toBe('on');
    expect(access(true, true, false)).toBe('on');
  });

  it('puts Pro ending ahead of the project count', () => {
    const lapsed = plan({ proUntil: new Date(now.getTime() - DAY), projectCount: 9 });
    expect(planNotice(lapsed, now)).toMatchObject({ kind: 'lapsed' });
  });
});

describe.skipIf(!hasDatabase)('project limit', () => {
  const label = `plans-${Date.now()}`;
  const file = (name: string) => ({ name, sourceType: 'file' as const });

  async function freshTenant(suffix: string, projects: number): Promise<string> {
    const id = (await createTenant(`${label}-${suffix}`)).id;
    for (let i = 0; i < projects; i++) await createProject(id, file(`P${i}`));
    return id;
  }

  it('starts every workspace on Free', async () => {
    const id = await freshTenant('new', 0);
    expect(await tenantPlan(id)).toEqual({ pro: false, proUntil: null, projectCount: 0 });
  });

  it('allows five projects on Free and refuses the sixth', async () => {
    const id = await freshTenant('free', FREE_PROJECT_LIMIT);
    await expect(createProject(id, file('Sixth'))).rejects.toBeInstanceOf(ProjectLimitError);
    expect(await listProjects(id)).toHaveLength(FREE_PROJECT_LIMIT);
  });

  it('lifts the limit while Pro lasts, and keeps existing projects when it ends', async () => {
    const id = await freshTenant('pro', FREE_PROJECT_LIMIT);
    await setProUntil(id, new Date(Date.now() + 30 * DAY));
    await createProject(id, file('Sixth'));
    await createProject(id, file('Seventh'));
    expect((await tenantPlan(id)).pro).toBe(true);

    await setProUntil(id, new Date(Date.now() - 1000));
    expect(await tenantPlan(id)).toMatchObject({ pro: false, projectCount: 7 });
    await expect(createProject(id, file('Eighth'))).rejects.toBeInstanceOf(ProjectLimitError);
  });

  it('lets the app owners past the limit', async () => {
    const id = await freshTenant('owner', FREE_PROJECT_LIMIT);
    await createProject(id, file('Owner extra'), { unlimited: true });
    expect(await listProjects(id)).toHaveLength(FREE_PROJECT_LIMIT + 1);
  });

  it('counts only this workspace', async () => {
    const full = await freshTenant('full', FREE_PROJECT_LIMIT);
    const other = await freshTenant('other', 0);
    await setProUntil(full, new Date(Date.now() + DAY));
    await createProject(other, file('Mine'));
    expect((await tenantPlan(other)).pro).toBe(false);
    expect((await tenantPlan(other)).projectCount).toBe(1);
  });

  it('still creates the first project of a new workspace', async () => {
    const [user] = await query<{ id: string }>(
      `insert into auth.users (email) values ($1) returning id`,
      [`${label}-ws@example.test`]
    );
    const tenant = await createWorkspace(user!.id, {
      tenantName: `${label}-ws`,
      projectName: 'First',
    });
    expect((await tenantPlan(tenant.id)).projectCount).toBe(1);
  });

  it('applies to Jira projects too', async () => {
    process.env.TOKEN_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');
    const id = await freshTenant('jira', FREE_PROJECT_LIMIT);
    const [admin] = await query<{ id: string }>(
      `insert into auth.users (email) values ($1) returning id`,
      [`${label}-jira-admin@example.test`]
    );
    await addMembership(id, admin!.id, 'admin');
    await saveJiraGrant(id, admin!.id, 'read', {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: ['read:jira-work'],
    });
    await setJiraSite(id, admin!.id, {
      cloudId: `cloud-${label}`,
      siteUrl: 'https://x.atlassian.net',
      siteName: 'x',
    });

    await expect(
      addJiraProject(id, admin!.id, { projectKey: 'SIX', name: 'Six' })
    ).rejects.toBeInstanceOf(ProjectLimitError);
    await addJiraProject(id, admin!.id, { projectKey: 'OWN', name: 'Own' }, { unlimited: true });
    expect(await listProjects(id)).toHaveLength(FREE_PROJECT_LIMIT + 1);
  });

  it('never lets parallel requests squeeze past the limit', async () => {
    const id = await freshTenant('race', FREE_PROJECT_LIMIT - 1);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => createProject(id, file(`Race ${i}`)))
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(ProjectLimitError);
    }
    expect(await listProjects(id)).toHaveLength(FREE_PROJECT_LIMIT);
  });
});
