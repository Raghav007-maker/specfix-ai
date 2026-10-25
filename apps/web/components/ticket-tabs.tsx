import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * The Review / Specs switcher on a ticket. Review is the Phase 1 flag flow; Specs is
 * the Phase 2 scenario + scaffold flow. Rendered on both pages so they read as two tabs
 * of one ticket rather than two unrelated routes.
 */
export function TicketTabs({ ticketId, active }: { ticketId: string; active: 'review' | 'specs' }) {
  const tab = (href: string, key: 'review' | 'specs', label: string) => (
    <Link
      href={href}
      aria-current={active === key ? 'page' : undefined}
      className={cn(
        '-mb-px border-b-2 px-1 pb-2 text-sm font-medium transition-colors',
        active === key
          ? 'border-primary text-primary'
          : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'
      )}
    >
      {label}
    </Link>
  );

  return (
    <div className="flex gap-6">
      {tab(`/tickets/${ticketId}`, 'review', 'Review')}
      {tab(`/tickets/${ticketId}/specs`, 'specs', 'Specs')}
    </div>
  );
}

/**
 * Breadcrumb, "KEY Title", a one-line meta row and the tabs — the top of both ticket
 * pages, laid out as in the report's Figures 4.4 and 4.5.
 */
export function TicketHeader({
  ticketId,
  projectId,
  projectName,
  externalKey,
  title,
  meta,
  badges,
  active,
}: {
  ticketId: string;
  projectId: string;
  projectName: string;
  externalKey: string;
  title: string;
  meta: ReactNode;
  badges?: ReactNode;
  active: 'review' | 'specs';
}) {
  return (
    <div className="mb-6">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href={`/?project=${projectId}`} className="hover:text-foreground">
          {projectName}
        </Link>
        <span className="mx-2">/</span>
        <span className="font-mono text-xs">{externalKey}</span>
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          {active === 'specs' ? (
            <>
              <h1 className="text-2xl font-semibold tracking-tight">
                <span className="text-primary">{externalKey}</span> · Specs
              </h1>
              <p className="mt-0.5 text-sm font-medium">{title}</p>
            </>
          ) : (
            <h1 className="text-2xl font-semibold tracking-tight">
              <span className="text-primary">{externalKey}</span> {title}
            </h1>
          )}
          <p className="mt-1 text-xs text-muted-foreground">{meta}</p>
        </div>
        {badges ? <div className="flex items-center gap-2">{badges}</div> : null}
      </div>
      <div className="mt-4 border-b">
        <TicketTabs ticketId={ticketId} active={active} />
      </div>
    </div>
  );
}
