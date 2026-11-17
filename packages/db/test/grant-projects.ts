import { query } from '../src/index.ts';

/**
 * Puts every non-owner member of the workspace into every one of its projects with their
 * workspace role — what migration 0026 did for existing data — so suites written before
 * project-level access keep testing what they were written for.
 */
export async function grantAllProjects(tenantId: string): Promise<void> {
  await query(
    `insert into project_members (tenant_id, project_id, user_id, role)
     select p.tenant_id, p.id, m.user_id, m.role
     from projects p join memberships m on m.tenant_id = p.tenant_id
     where p.tenant_id = $1 and m.role in ('admin', 'reviewer')
     on conflict do nothing`,
    [tenantId]
  );
}
