'use client';

import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

/**
 * Hides the desktop sidebar (the button beside the logo in the sidebar) or shows it again (the
 * button at the start of the top bar, visible only while the sidebar is hidden). The choice is
 * kept in a cookie so the server renders the next page the same way, with no flash. Stateless:
 * the page's #app-shell attribute is the one source of truth, so the two buttons never disagree.
 */
export function SidebarToggle({ action }: { action: 'hide' | 'show' }) {
  const hide = action === 'hide';
  const onClick = () => {
    const value = hide ? 'hidden' : 'shown';
    document.getElementById('app-shell')?.setAttribute('data-sidebar', value);
    document.cookie = `sf_sidebar=${value}; path=/; max-age=31536000; samesite=lax`;
  };
  const Icon = hide ? PanelLeftClose : PanelLeftOpen;
  const label = hide ? 'Hide sidebar' : 'Show sidebar';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-controls="app-sidebar"
      aria-label={label}
      title={label}
      className={
        hide
          ? 'flex h-8 w-8 flex-none items-center justify-center rounded-md text-muted-foreground hover:bg-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal'
          : 'hidden h-9 w-9 flex-none items-center justify-center rounded-md text-muted-foreground hover:bg-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal lg:group-data-[sidebar=hidden]/shell:flex'
      }
    >
      <Icon aria-hidden size={18} strokeWidth={1.6} />
    </button>
  );
}
