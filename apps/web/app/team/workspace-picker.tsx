'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, LoaderCircle, Search } from 'lucide-react';
import { cn } from '@/lib/cn';
import { SubmitButton } from '@/components/submit-button';
import type { TeamHit } from '@/lib/repos';
import { requestJoinAction, searchWorkspacesAction } from './actions';

/**
 * A dropdown to pick a workspace and ask to join it. It opens on a search box; typing one letter
 * shows matching workspaces live (20 at most, names starting with the text first). It never
 * lists every workspace: with no text there is nothing to show.
 */
export function WorkspacePicker({ from }: { from: 'team' | 'join' }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [hits, setHits] = useState<TeamHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<TeamHit | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(0);
  const listId = useId();
  const optionId = (i: number) => `${listId}-o${i}`;

  // Search 200ms after the last key; only the newest answer is shown.
  useEffect(() => {
    const q = text.trim();
    const n = ++latest.current;
    if (!q) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      searchWorkspacesAction(q)
        .then((found) => {
          if (n !== latest.current) return;
          setHits(found);
          setActive(0);
        })
        .catch(() => {
          if (n === latest.current) setHits([]);
        })
        .finally(() => {
          if (n === latest.current) setLoading(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [text]);

  // Close on a click outside.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const choose = (hit: TeamHit | undefined) => {
    if (!hit || hit.requested) return;
    setPicked(hit);
    setOpen(false);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(hits.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(hits[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const q = text.trim();

  return (
    <div ref={root} className="relative space-y-3">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-[38px] w-full items-center gap-2 rounded-md border bg-sheet px-3 text-left text-sm transition-[border-color,box-shadow] duration-200 hover:border-text/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-1',
          open ? 'border-teal ring-2 ring-teal/20' : 'border-field'
        )}
      >
        <span className={cn('min-w-0 flex-1 truncate', !picked && 'text-muted-foreground')}>
          {picked ? picked.name : 'Choose a workspace'}
        </span>
        <ChevronDown
          aria-hidden
          size={16}
          className={cn(
            'flex-none text-muted-foreground transition-transform duration-200',
            open && 'rotate-180'
          )}
        />
      </button>

      {open ? (
        <div className="absolute inset-x-0 top-[42px] z-40 mt-0 animate-[menu-pop_180ms_cubic-bezier(0.2,0.7,0.2,1)_both] overflow-hidden rounded-lg border border-border bg-sheet shadow-[var(--float)]">
          <div className="relative border-b border-border">
            <Search
              aria-hidden
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              ref={input}
              type="search"
              role="combobox"
              aria-label="Search workspaces"
              aria-expanded={hits.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={hits[active] ? optionId(active) : undefined}
              value={text}
              maxLength={100}
              autoComplete="off"
              placeholder="Type a workspace name"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              className="h-10 w-full bg-transparent pl-9 pr-9 text-sm placeholder:text-muted-foreground focus-visible:outline-none"
            />
            {loading ? (
              <LoaderCircle
                aria-hidden
                size={15}
                className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground"
              />
            ) : null}
          </div>
          <ul
            id={listId}
            role="listbox"
            aria-label="Workspaces"
            className="max-h-64 overflow-y-auto p-1"
          >
            {!q ? (
              <li className="px-3 py-3 text-sm text-muted-foreground">
                Start typing to see workspaces.
              </li>
            ) : hits.length === 0 ? (
              <li className="px-3 py-3 text-sm text-muted-foreground">
                {loading ? 'Searching…' : `No workspace matches “${q}”.`}
              </li>
            ) : (
              hits.map((h, i) => (
                <li
                  key={h.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  aria-disabled={h.requested}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(h);
                  }}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors duration-150',
                    i === active && 'bg-raised',
                    h.requested && 'cursor-default text-muted-foreground'
                  )}
                >
                  <span
                    aria-hidden
                    className="flex h-7 w-7 flex-none items-center justify-center rounded-md bg-teal-tag text-[11px] font-semibold text-teal-ink"
                  >
                    {h.name.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{h.name}</span>
                  {h.requested ? (
                    <span className="text-xs">Request sent</span>
                  ) : picked?.id === h.id ? (
                    <Check aria-hidden size={15} className="text-teal" />
                  ) : null}
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}

      {picked ? (
        <form action={requestJoinAction} className="flex justify-end">
          <input type="hidden" name="tenantId" value={picked.id} />
          <input type="hidden" name="from" value={from} />
          <SubmitButton pendingLabel="Sending…">Ask to join {picked.name}</SubmitButton>
        </form>
      ) : null}
    </div>
  );
}
