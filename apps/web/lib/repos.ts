import 'server-only';

/**
 * The single door between the web app and tenant data.
 *
 * Importing 'server-only' here means any client component that tries to pull a
 * repository in gets a build error, not a runtime leak of the pg connection into
 * the browser bundle. Every server component and server action reaches the database
 * through this module, and every function it re-exports takes a tenant_id as its
 * first argument — that is where tenant isolation actually lives.
 */
export * from '@specfix/db';

import { cache } from 'react';
import { getTicket as getTicketOfTenant, listProjectsForUser } from '@specfix/db';

/** Per page render: the projects the user can see in every workspace they are in, fetched once. */
export const projectsOfUser = cache(listProjectsForUser);

/**
 * The projects of a workspace this user can see (all of them for an owner, else the ones they
 * were added to), each with the user's role in it. Shadows the tenant-wide re-export above, so
 * no page can list a project its viewer is not in: the user id is required.
 */
export const listProjects = cache(async (tenantId: string, userId: string) =>
  (await projectsOfUser(userId)).filter((p) => p.tenant_id === tenantId)
);

/** What a tenant-wide view may count: null (everything) for an owner, else their projects' ids. */
export function projectScope(
  tenant: { role: string },
  projects: readonly { id: string }[]
): string[] | null {
  return tenant.role === 'owner' ? null : projects.map((p) => p.id);
}

/** Keeps the rows of projects the viewer can see. */
export function inProjects<T extends { project_id: string }>(
  rows: readonly T[],
  projects: readonly { id: string }[]
): T[] {
  const ids = new Set(projects.map((p) => p.id));
  return rows.filter((r) => ids.has(r.project_id));
}

/**
 * One ticket, or null when it is not in this workspace or sits in a project the user cannot
 * see (the same answer, so ids cannot be probed). Shadows the tenant-wide re-export above.
 */
export async function getTicket(tenantId: string, ticketId: string, userId: string) {
  const [ticket, visible] = await Promise.all([
    getTicketOfTenant(tenantId, ticketId),
    projectsOfUser(userId),
  ]);
  return ticket && visible.some((p) => p.id === ticket.project_id && p.tenant_id === tenantId)
    ? ticket
    : null;
}
