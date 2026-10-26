'use client';

import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { PRESETS, cssVars, dataAttrs, sanitize } from '@/components/playground/settings';
import { DashboardPreview } from '@/components/playground/dashboard-preview';
import type { DashboardData } from '@/components/playground/dashboard-data';
import p from '@/components/playground/playground.module.css';

/**
 * The signed-in review queue in the light workspace design approved from the playground: the
 * "Soft workspace" preset, after the supplied dashboard screenshots. Same component as the
 * playground's Dashboard preview, given the user's real workspace and the page's own controls.
 */
export function WorkspaceDashboard({
  data,
  agent,
  projects,
  activeProjectId,
  top,
}: {
  data: DashboardData;
  agent: ReactNode;
  projects: { id: string; name: string }[];
  activeProjectId?: string;
  top?: ReactNode;
}) {
  const router = useRouter();
  // The soft workspace preset on a white page, as in the supplied dashboard screenshot.
  const settings = useMemo(
    () =>
      sanitize({
        ...PRESETS.workspace.patch,
        appearance: {
          ...PRESETS.workspace.patch.appearance,
          page: '#ffffff',
          sidebar: '#ffffff',
          surface: '#f4f4f5',
          border: '#ececef',
        },
      }).settings,
    []
  );
  const style = { ...cssVars(settings), minHeight: '100vh' } as CSSProperties;
  return (
    <div
      className={p.root}
      data-pg-preview=""
      data-view="dashboard"
      style={style}
      {...dataAttrs(settings)}
    >
      <div className={p.view}>
        <DashboardPreview
          settings={settings}
          data={data}
          agent={agent}
          goLogin={() => router.push('/login')}
          projects={projects}
          activeProjectId={activeProjectId}
          top={top}
        />
      </div>
    </div>
  );
}
