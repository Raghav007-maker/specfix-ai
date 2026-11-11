import 'server-only';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { CalendarClock, ListChecks, Loader } from 'lucide-react';
import {
  WORK_STATUSES,
  WORK_STATUS_LABELS,
  activeSprintSummaries,
  listProjectDetails,
  listWorkEvents,
  summarizeCounts,
  taskKeyOf,
  workCountRows,
  workTablesAvailable,
} from '@/lib/repos';
import { describeEvent } from '@/app/projects/work-ui';
import s from '@/components/playground/playground.module.css';

const pct = (done: number, total: number) => (total ? Math.round((done / total) * 100) : 0);

/**
 * Project work on Home, under the review queue: task totals, the split by status, active
 * sprint completion and recent activity, all counted from the workspace's own rows (or one
 * project's, when the queue is narrowed to it). Renders nothing until migration 0019 is
 * applied, and nothing if a read fails, so it can never take the review queue down with it.
 */
export async function WorkSummary({
  tenantId,
  projectId,
}: {
  tenantId: string;
  projectId?: string;
}) {
  try {
    if (!(await workTablesAvailable())) return null;
    const [rows, sprints, events, projects] = await Promise.all([
      workCountRows(tenantId, projectId),
      activeSprintSummaries(tenantId, projectId),
      listWorkEvents(tenantId, { projectId }, 6),
      listProjectDetails(tenantId),
    ]);
    const counts = summarizeCounts(rows);
    const keyOf = new Map(projects.map((p) => [p.id, p.task_key]));
    const href = projectId ? `/projects/${projectId}` : '/projects';
    const inProgress = counts.byStatus.in_progress + counts.byStatus.in_review;

    return (
      <section className={s.flat} aria-labelledby="pg-work-h">
        <div className={s.flatHead}>
          <h2 id="pg-work-h" className={s.h2}>
            Project work
          </h2>
          <span className={s.donePct}>Done {counts.percentDone}%</span>
          <Link href={href} className={s.muted}>
            {projectId ? 'Open project' : 'All projects'} →
          </Link>
        </div>

        {counts.total === 0 ? (
          <p className={s.empty}>
            No tasks yet. Track work for {projectId ? 'this project' : 'a project'} from{' '}
            <Link href={href}>{projectId ? 'its overview' : 'Projects'}</Link>.
          </p>
        ) : (
          <>
            <dl className={s.stats}>
              <Figure
                icon={<ListChecks aria-hidden />}
                label="Tasks"
                value={counts.total}
                note={`${counts.byStatus.done} completed`}
                tone="up"
              />
              <Figure
                icon={<Loader aria-hidden />}
                label="In progress"
                value={inProgress}
                note={`${counts.byStatus.in_review} in review`}
                tone="flat"
              />
              <Figure
                icon={<CalendarClock aria-hidden />}
                label="Overdue"
                value={counts.overdue}
                note={counts.overdue ? 'past due, not done' : undefined}
                tone="down"
              />
            </dl>

            <div
              style={{
                display: 'grid',
                gap: 24,
                gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))',
              }}
            >
              <div style={{ display: 'grid', gap: 20, alignContent: 'start' }}>
                <Block title="By status">
                  {WORK_STATUSES.map((status) => (
                    <Bar
                      key={status}
                      label={WORK_STATUS_LABELS[status]}
                      value={counts.byStatus[status]}
                      percent={pct(counts.byStatus[status], counts.total)}
                    />
                  ))}
                </Block>
                <Block title="Active sprints">
                  {sprints.length === 0 ? (
                    <p className={s.muted} style={{ margin: 0, fontSize: 13.5 }}>
                      No active sprint.
                    </p>
                  ) : (
                    sprints.map((sp) => (
                      <Bar
                        key={sp.id}
                        label={projectId ? sp.name : `${sp.name} · ${sp.project_name}`}
                        href={`/projects/${sp.project_id}/backlog`}
                        value={sp.done}
                        suffix={` of ${sp.total} done · ${pct(sp.done, sp.total)}%`}
                        percent={pct(sp.done, sp.total)}
                        accent
                      />
                    ))
                  )}
                </Block>
              </div>

              <Block title="Recent activity">
                {events.length === 0 ? (
                  <p className={s.muted} style={{ margin: 0, fontSize: 13.5 }}>
                    Nothing yet.
                  </p>
                ) : (
                  <ol
                    style={{ display: 'grid', gap: 10, margin: 0, padding: 0, listStyle: 'none' }}
                  >
                    {events.map((e) => {
                      const key =
                        e.item_number === null
                          ? null
                          : taskKeyOf(keyOf.get(e.project_id) ?? null, e.item_number);
                      return (
                        <li key={e.id} style={{ fontSize: 13.5, lineHeight: 1.4 }}>
                          <b style={{ fontWeight: 600 }}>{e.actor_email ?? 'Someone'}</b>{' '}
                          {describeEvent(e)}
                          {key ? (
                            <>
                              {' '}
                              {e.work_item_id ? (
                                <Link href={`/projects/${e.project_id}/tasks/${e.item_number}`}>
                                  <code>{key}</code>
                                </Link>
                              ) : (
                                <code>{key}</code>
                              )}
                            </>
                          ) : null}
                          <span className={s.muted} style={{ display: 'block', fontSize: 12 }}>
                            {e.created_at.toLocaleString('en-GB', {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            })}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </Block>
            </div>
          </>
        )}
      </section>
    );
  } catch (error) {
    console.error('[home] project work summary unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function Figure({
  icon,
  label,
  value,
  note,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  note?: string;
  tone: 'up' | 'down' | 'flat';
}) {
  return (
    <div className={s.stat}>
      <span className={s.statIcon}>{icon}</span>
      <div>
        <dt>{label}</dt>
        <dd>
          <b>{value}</b>{' '}
          {note ? (
            <span className={s.delta} data-tone={tone}>
              {note}
            </span>
          ) : null}
        </dd>
      </div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{title}</h3>
      {children}
    </div>
  );
}

/** A labelled bar; the numbers are written out, the bar only echoes them. */
function Bar({
  label,
  value,
  percent,
  suffix,
  href,
  accent,
}: {
  label: string;
  value: number;
  percent: number;
  suffix?: string;
  href?: string;
  accent?: boolean;
}) {
  return (
    <div style={{ display: 'grid', gap: 4, fontSize: 13.5 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        {href ? (
          <Link href={href} style={{ minWidth: 0 }}>
            {label}
          </Link>
        ) : (
          <span className={s.muted}>{label}</span>
        )}
        <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          {value}
          {suffix}
        </span>
      </div>
      <span
        aria-hidden
        style={{
          height: 6,
          borderRadius: 999,
          overflow: 'hidden',
          background: 'var(--pg-surface)',
          boxShadow: 'inset 0 0 0 var(--pg-line) var(--pg-border)',
        }}
      >
        <span
          style={{
            display: 'block',
            height: '100%',
            width: `${percent}%`,
            borderRadius: 999,
            background: accent ? 'var(--pg-accent)' : 'var(--pg-text)',
            opacity: accent ? 1 : 0.55,
          }}
        />
      </span>
    </div>
  );
}
