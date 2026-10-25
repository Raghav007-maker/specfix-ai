import Link from 'next/link';
import type { TicketQueueRow } from '@/lib/repos';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/cn';

/** Status filters for the review queue; `match` decides which rows each tab shows. */
export const FILTERS = {
  all: { label: 'All', match: () => true },
  open: {
    label: 'Open flags',
    match: (r: TicketQueueRow) => r.analyzed && !r.ready && r.open_flags > 0,
  },
  resolved: {
    label: 'Resolved',
    match: (r: TicketQueueRow) => r.analyzed && !r.ready && r.open_flags === 0,
  },
  ready: { label: 'Ready for dev', match: (r: TicketQueueRow) => r.ready },
  pending: { label: 'Not analyzed', match: (r: TicketQueueRow) => !r.analyzed },
} as const;

export type Filter = keyof typeof FILTERS;

export function QueueItem({ row }: { row: TicketQueueRow }) {
  return (
    <li>
      <Link
        href={`/tickets/${row.ticket_id}`}
        className="group flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-accent/60"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', statusDot(row))} />
          <div className="min-w-0">
            <span className="font-mono text-xs text-muted-foreground">{row.external_key}</span>
            <p className="truncate font-semibold">{row.title}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <QueueStatus row={row} />
          <span
            aria-hidden
            className="text-muted-foreground transition-transform group-hover:translate-x-0.5"
          >
            →
          </span>
        </div>
      </Link>
    </li>
  );
}

function statusDot(row: TicketQueueRow): string {
  if (!row.analyzed) return 'bg-slate-300';
  if (row.ready) return 'bg-emerald-500';
  if (row.open_flags > 0) return 'bg-amber-400';
  return 'bg-sky-500';
}

function QueueStatus({ row }: { row: TicketQueueRow }) {
  if (!row.analyzed) return <Badge tone="neutral">Not analyzed</Badge>;
  if (row.ready) return <Badge tone="success">Ready for dev</Badge>;
  if (row.open_flags > 0)
    return (
      <Badge tone="warning">
        {row.open_flags} open {row.open_flags === 1 ? 'flag' : 'flags'}
      </Badge>
    );
  if (row.total_flags > 0) return <Badge tone="info">Flags resolved</Badge>;
  return <Badge tone="muted">No flags</Badge>;
}
