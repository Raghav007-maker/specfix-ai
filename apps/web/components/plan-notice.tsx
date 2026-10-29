'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { Bell } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { PlanNoticeText } from '@/lib/plan';

/**
 * A small bell with a dot in the top bar; pressing it opens a short note below about the
 * workspace's plan (Pro ending, or Free running out of projects). Esc or a click elsewhere
 * closes it.
 */
export function PlanNotice({ notice, className }: { notice: PlanNoticeText; className?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onClick = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  return (
    <div ref={root} className={cn('relative', className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={`Plan notice: ${notice.title}`}
        onClick={() => setOpen((v) => !v)}
        className="relative flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal max-lg:h-11 max-lg:w-11"
      >
        <Bell aria-hidden size={18} strokeWidth={1.6} />
        <span
          aria-hidden
          className="absolute right-2 top-2 h-2 w-2 rounded-full bg-negative ring-2 ring-frame motion-safe:animate-pulse"
        />
      </button>
      {open ? (
        <div
          id={id}
          role="status"
          className="absolute right-0 top-full z-40 mt-2 w-72 rounded-lg border border-border bg-sheet p-4 text-sm leading-5 shadow-float"
        >
          <p className="font-semibold text-text">{notice.title}</p>
          <p className="mt-1 text-muted-foreground">{notice.body}</p>
          <Link
            href="/pricing"
            className="mt-3 inline-block rounded-sm font-medium text-text underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
          >
            View plans
          </Link>
        </div>
      ) : null}
    </div>
  );
}
