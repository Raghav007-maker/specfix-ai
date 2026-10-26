'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { HistoryEvent } from './dashboard-data';
import s from './playground.module.css';

const ACTION: Record<HistoryEvent['kind'], string> = {
  ingested: 'Ticket brought in',
  analysed: 'Analysis finished',
  resolved: 'Every flag decided',
  ready: 'Marked ready for development',
  accepted: 'Accepted a flag',
  edited: 'Edited a flag’s question',
  dismissed: 'Dismissed a flag',
  reopened: 'Reopened a flag',
};

/** Local calendar day, YYYY-MM-DD. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

/**
 * The header date, with a calendar behind its button. Days that have changes carry a dot; choosing
 * one lists what happened to tickets that day, newest first. `linkTickets` is off for sample data,
 * whose tickets have no pages.
 */
export function DateCalendar({
  history,
  linkTickets,
}: {
  history: HistoryEvent[];
  linkTickets: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [today] = useState(() => new Date());
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [selected, setSelected] = useState(() => dayKey(today));
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  const byDay = useMemo(() => {
    const m = new Map<string, HistoryEvent[]>();
    for (const e of history) {
      const k = dayKey(new Date(e.at));
      m.set(k, [...(m.get(k) ?? []), e]);
    }
    return m;
  }, [history]);

  // Close on Escape or a click outside, handing focus back to the button.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  const label = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(today);
  const monthLabel = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(
    month
  );
  // Monday-first grid with leading blanks.
  const lead = (month.getDay() + 6) % 7;
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from(
      { length: days },
      (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1)
    ),
  ];
  const events = byDay.get(selected) ?? [];
  const selectedLabel = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${selected}T12:00:00`));
  const time = (iso: string) =>
    new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

  return (
    <div className={s.calWrap} ref={box}>
      <p className={s.datePill}>
        {/* The server's and the browser's clocks may sit in different time zones. */}
        <span suppressHydrationWarning>{label}</span>
        <button
          ref={button}
          type="button"
          className={s.calBtn}
          aria-label="Open the calendar of ticket changes"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
        >
          <CalendarDays aria-hidden />
        </button>
      </p>

      {open ? (
        <div className={s.calPop} id={id} role="dialog" aria-label="Ticket changes by date">
          <div className={s.calTop}>
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
            >
              <ChevronLeft aria-hidden />
            </button>
            <b>{monthLabel}</b>
            <button
              type="button"
              aria-label="Next month"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
            >
              <ChevronRight aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Close the calendar"
              className={s.calClose}
              onClick={() => {
                setOpen(false);
                button.current?.focus();
              }}
            >
              <X aria-hidden />
            </button>
          </div>

          <div className={s.calGrid}>
            {WEEKDAYS.map((w) => (
              <span key={w} className={s.calDow} aria-hidden="true">
                {w}
              </span>
            ))}
            {cells.map((d, i) => {
              if (!d) return <span key={`b${i}`} />;
              const k = dayKey(d);
              const n = byDay.get(k)?.length ?? 0;
              return (
                <button
                  key={k}
                  type="button"
                  className={s.calDay}
                  aria-pressed={k === selected}
                  data-today={k === dayKey(today) ? 'true' : undefined}
                  data-has={n > 0 ? 'true' : undefined}
                  aria-label={`${d.getDate()} ${monthLabel}${n ? `, ${n} ${n === 1 ? 'change' : 'changes'}` : ', no changes'}`}
                  onClick={() => setSelected(k)}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>

          <div className={s.calList} aria-live="polite">
            <p className={s.calListHead}>
              {selectedLabel}
              <span>
                {events.length} {events.length === 1 ? 'change' : 'changes'}
              </span>
            </p>
            {events.length === 0 ? (
              <p className={s.muted}>No ticket changes on this day.</p>
            ) : (
              <ul>
                {events.map((e, i) => (
                  <li key={`${e.at}-${i}`}>
                    <time dateTime={e.at}>{time(e.at)}</time>
                    <span>
                      <b>{ACTION[e.kind]}</b>
                      {linkTickets ? (
                        <a href={`/tickets/${e.ticketId}`}>
                          <code>{e.key}</code> {e.title}
                        </a>
                      ) : (
                        <span>
                          <code>{e.key}</code> {e.title}
                        </span>
                      )}
                      {e.by ? <small>by {e.by}</small> : <small>automatic</small>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
