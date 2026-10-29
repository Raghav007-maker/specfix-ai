import type { ReactNode } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { Lock } from 'lucide-react';
import type { AgentAccess } from '@/lib/plan';

type TicketTab = 'review' | 'conversation' | 'specs';

/**
 * The Review / Specs switcher on a ticket. Review is the Phase 1 flag flow; Specs is
 * the Phase 2 scenario + scaffold flow. Rendered on every ticket page so they read as tabs
 * of one ticket rather than unrelated routes. Conversation — the resolution agent, an
 * alternative way to decide the same flags — appears only when its feature flag is on, with a
 * lock on a Free workspace (the tab then explains that the agent is part of Pro).
 */
export function TicketTabs({
  ticketId,
  active,
  agent,
}: {
  ticketId: string;
  active: TicketTab;
  agent: AgentAccess;
}) {
  const tab = (href: string, key: TicketTab, label: ReactNode) => (
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
      {agent === 'off'
        ? null
        : tab(
            `/tickets/${ticketId}/conversation`,
            'conversation',
            agent === 'locked' ? (
              <>
                Conversation
                <Lock aria-label="Pro" size={13} className="ml-1.5" />
              </>
            ) : (
              'Conversation'
            )
          )}
      {tab(`/tickets/${ticketId}/specs`, 'specs', 'Specs')}
    </nav>
  );
}
