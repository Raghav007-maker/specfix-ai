/**
 * Row level security as Supabase's API sees it, run as a non-owner role (the app server
 * connects as the owner, which RLS does not apply to): a member reads their workspace, never
 * another; and a member who has turned on 2FA reads nothing until the session is aal2.
 *
 * Skipped without SPECFIX_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMembership, closePool, createProject, createTenant, query, tx } from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

describe.skipIf(!hasDatabase)('RLS and two-factor sign-in', () => {
  const label = `rlsmfa-${Date.now()}`;
  let A: string;
  let B: string;
  let plain: string;
  let guarded: string;

  /** Project names `userId` can read through RLS with the given JWT claims. */
  const visible = (userId: string, claims: Record<string, string>) =>
    tx(async (client) => {
      await client.query('set local role specfix_api_test');
      await client.query(`select set_config('specfix.test_user_id', $1, true)`, [userId]);
      await client.query(`select set_config('specfix.test_jwt', $1, true)`, [
        JSON.stringify(claims),
      ]);
      const { rows } = await client.query<{ name: string }>(
        `select name from projects where name like $1 order by name`,
        [`${label}%`]
      );
      return rows.map((r) => r.name);
    });

  beforeAll(async () => {
    await query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'specfix_api_test') then
        create role specfix_api_test nologin;
      end if;
    end $$`);
    await query(`grant usage on schema public, auth to specfix_api_test`);
    await query(`grant select on projects, memberships to specfix_api_test`);
    A = (await createTenant(`${label}-a`)).id;
    B = (await createTenant(`${label}-b`)).id;
    for (const name of ['plain', 'guarded']) {
      const [row] = await query<{ id: string }>(
        `insert into auth.users (email) values ($1) returning id`,
        [`${label}-${name}@example.test`]
      );
      if (name === 'plain') plain = row!.id;
      else guarded = row!.id;
    }
    await addMembership(A, plain, 'reviewer');
    await addMembership(A, guarded, 'owner');
    await query(`insert into auth.mfa_factors (user_id, status) values ($1, 'verified')`, [
      guarded,
    ]);
    const opts = { unlimited: true };
    await createProject(A, { name: `${label}-alpha`, sourceType: 'file' }, opts);
    await createProject(B, { name: `${label}-bravo`, sourceType: 'file' }, opts);
  });

  it('a member without 2FA reads their workspace, never another', async () => {
    expect(await visible(plain, { aal: 'aal1' })).toEqual([`${label}-alpha`]);
  });

  it('a member with 2FA reads nothing on an aal1 session, and their workspace on aal2', async () => {
    expect(await visible(guarded, { aal: 'aal1' })).toEqual([]);
    expect(await visible(guarded, {})).toEqual([]);
    expect(await visible(guarded, { aal: 'aal2' })).toEqual([`${label}-alpha`]);
  });

  it('an unverified factor does not lock anyone out', async () => {
    await query(`insert into auth.mfa_factors (user_id, status) values ($1, 'unverified')`, [
      plain,
    ]);
    expect(await visible(plain, { aal: 'aal1' })).toEqual([`${label}-alpha`]);
  });
});
