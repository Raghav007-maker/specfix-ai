import Link from 'next/link';
import { cn } from '@/lib/cn';
import { resolutionAgentEnabled } from '@/lib/agent';

type TicketTab = 'review' | 'conversation' | 'specs';

/**
 * The Review / Specs switcher on a ticket. Review is the Phase 1 flag flow; Specs is
 * the Phase 2 scenario + scaffold flow. Rendered on every ticket page so they read as tabs
 * of one ticket rather than unrelated routes. Conversation — the resolution agent, an
 * alternative way to decide the same flags — appears only when its feature flag is on.
 */
export function TicketTabs({ ticketId, active }: { ticketId: string; active: TicketTab }) {
  const tab = (href: string, key: TicketTab, label: string) => (
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
      {resolutionAgentEnabled()
        ? tab(`/tickets/${ticketId}/conversation`, 'conversation', 'Conversation')
        : null}
      {tab(`/tickets/${ticketId}/specs`, 'specs', 'Specs')}
    </nav>
  );
}
