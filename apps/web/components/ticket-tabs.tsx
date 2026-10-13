import Link from 'next/link';
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
      className={cn(
        'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        active === key
          ? 'bg-primary text-primary-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
      )}
    >
      {label}
    </Link>
  );

  return (
    <div className="mb-6 inline-flex gap-1 rounded-lg border bg-card p-1">
      {tab(`/tickets/${ticketId}`, 'review', 'Review')}
      {tab(`/tickets/${ticketId}/specs`, 'specs', 'Specs')}
    </div>
  );
}
