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
      aria-current={active === key ? 'page' : undefined}
      className={cn(
        '-mb-px inline-flex h-10 items-center border-b-2 px-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal',
        active === key
          ? 'border-text font-medium text-text'
          : 'border-transparent text-muted-foreground hover:text-text'
      )}
    >
      {label}
    </Link>
  );

  return (
    <nav aria-label="Ticket views" className="mb-6 flex gap-2 border-b border-border">
      {tab(`/tickets/${ticketId}`, 'review', 'Review')}
      {tab(`/tickets/${ticketId}/specs`, 'specs', 'Specs')}
    </nav>
  );
}
