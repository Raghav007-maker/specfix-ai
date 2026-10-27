import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import type { User } from '@supabase/supabase-js';
import { getUser } from '@/lib/session';
import { currentTenant } from '@/lib/tenant';
import { listProjects, type MembershipRow } from '@/lib/repos';
import { loadWorkspaceDashboard, profileOf } from '@/lib/dashboard';
import { Playground } from '@/components/playground/playground';
import { SAMPLE, type DashboardData } from '@/components/playground/dashboard-data';

export const metadata: Metadata = {
  title: 'Design playground · SpecFix',
  robots: { index: false, follow: false },
};

// Reads the visitor's session on every request; never cached or prerendered.
export const dynamic = 'force-dynamic';

/**
 * The design playground (not linked from the app). It renders the landing, login and dashboard
 * previews under live Design Controls.
 *
 * The dashboard uses the signed-in user's own workspace when there is one, through the same
 * loader as the real dashboard; nothing here writes. Signed out, or when the reads fail, it falls
 * back to labelled sample data.
 */
export default async function DesignPlaygroundPage() {
  const user = await getUser();
  const { data, agent } = user
    ? await loadLive(user)
    : { data: { ...SAMPLE, sampleReason: 'signed-out' as const }, agent: null };
  return <Playground data={data} agent={agent} />;
}

async function loadLive(user: User): Promise<{ data: DashboardData; agent: ReactNode }> {
  let tenant: MembershipRow | null = null;
  try {
    tenant = await currentTenant(user.id);
    if (!tenant) {
      return {
        data: {
          ...SAMPLE,
          sampleReason: 'no-workspace',
          user: profileOf(user, null),
          agent: { state: 'no-ticket' },
        },
        agent: null,
      };
    }
    return await loadWorkspaceDashboard(user, tenant, await listProjects(tenant.tenant_id));
  } catch (err) {
    console.error(
      '[design-playground] workspace read failed:',
      err instanceof Error ? err.message : err
    );
    return {
      data: {
        ...SAMPLE,
        sampleReason: 'error',
        user: profileOf(user, tenant),
        agent: { state: 'error' },
      },
      agent: null,
    };
  }
}
