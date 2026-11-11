'use client';

import { useEffect, useState, useTransition, type DragEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/cn';
import { Button, Input, Notice, Pill, type PillTone } from '@/components/ui';
import { createTaskAction, moveTaskAction } from '../../actions';

/** One card as the board shows it; labels and tones are resolved on the server. */
export interface BoardCard {
  id: string;
  number: number;
  key: string;
  title: string;
  status: string;
  typeLabel: string;
  priorityLabel: string;
  priorityTone: PillTone;
  assignee: string | null;
  labels: string[];
  dueOn: string | null;
  overdue: boolean;
}

type Drop = { status: string; beforeId: string | null };

/**
 * The Kanban board. Cards drag between columns with native drag-and-drop (no library); each
 * card also has a "Move to" menu, which is the keyboard and touch path. A move shows at once,
 * is saved by moveTaskAction, and the server's order replaces it when the page refreshes; a
 * refused move puts the card back and says why.
 */
export function Board({
  projectId,
  columns,
  cards: serverCards,
  reorderable,
}: {
  projectId: string;
  columns: { status: string; label: string }[];
  cards: BoardCard[];
  /** False when the board is sorted by something other than its own order. */
  reorderable: boolean;
}) {
  const router = useRouter();
  const [cards, setCards] = useState(serverCards);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => setCards(serverCards), [serverCards]);

  const labelOf = (status: string) => columns.find((c) => c.status === status)?.label ?? status;

  function move(cardId: string, status: string, beforeId: string | null) {
    const card = cards.find((c) => c.id === cardId);
    if (!card || beforeId === cardId) return;
    const rest = cards.filter((c) => c.id !== cardId);
    const at = beforeId ? rest.findIndex((c) => c.id === beforeId) : -1;
    const next = { ...card, status };
    const placed = at < 0 ? [...rest, next] : [...rest.slice(0, at), next, ...rest.slice(at)];
    if (card.status === status && !reorderable) return;
    setCards(placed);
    setError(null);
    setAnnouncement(`Moved ${card.key} to ${labelOf(status)}.`);

    const form = new FormData();
    form.set('taskId', cardId);
    form.set('status', status);
    if (beforeId && reorderable) form.set('beforeId', beforeId);
    startTransition(async () => {
      const result = await moveTaskAction(form).catch(() => ({ error: 'The move was not saved.' }));
      if (result.error) {
        setCards(serverCards);
        setError(`${card.key}: ${result.error}`);
        setAnnouncement(`${card.key} was not moved. ${result.error}`);
      }
      router.refresh();
    });
  }

  function dragOver(event: DragEvent<HTMLElement>, status: string) {
    if (!dragId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    let beforeId: string | null = null;
    if (reorderable) {
      for (const el of event.currentTarget.querySelectorAll<HTMLElement>('[data-card-id]')) {
        const box = el.getBoundingClientRect();
        if (el.dataset.cardId !== dragId && event.clientY < box.top + box.height / 2) {
          beforeId = el.dataset.cardId ?? null;
          break;
        }
      }
    }
    if (drop?.status !== status || drop.beforeId !== beforeId) setDrop({ status, beforeId });
  }

  function dropOn(event: DragEvent<HTMLElement>, status: string) {
    event.preventDefault();
    const id = event.dataTransfer.getData('text/plain') || dragId;
    if (id) move(id, status, drop?.status === status ? drop.beforeId : null);
    setDragId(null);
    setDrop(null);
  }

  return (
    <div aria-busy={pending}>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {error ? (
        <Notice tone="error" className="mb-4">
          {error}
        </Notice>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {columns.map((column) => {
          const inColumn = cards.filter((c) => c.status === column.status);
          const target = drop?.status === column.status;
          return (
            <section
              key={column.status}
              aria-labelledby={`col-${column.status}`}
              onDragOver={(e) => dragOver(e, column.status)}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
              }}
              onDrop={(e) => dropOn(e, column.status)}
              className={cn(
                'flex min-h-48 flex-col rounded-lg border bg-raised/60 p-2 transition-colors',
                target ? 'border-teal' : 'border-border'
              )}
            >
              <h2
                id={`col-${column.status}`}
                className="flex items-center justify-between px-1.5 pb-2 pt-1 text-sm font-semibold"
              >
                {column.label}
                <span className="font-normal tabular-nums text-muted-foreground">
                  {inColumn.length}
                </span>
              </h2>
              <ol className="flex flex-1 flex-col gap-2">
                {inColumn.map((card) => (
                  <li key={card.id}>
                    {target && drop?.beforeId === card.id ? <DropLine /> : null}
                    <CardView
                      card={card}
                      projectId={projectId}
                      columns={columns}
                      dragging={dragId === card.id}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', card.id);
                        e.dataTransfer.effectAllowed = 'move';
                        setDragId(card.id);
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setDrop(null);
                      }}
                      onMove={(status) => move(card.id, status, null)}
                    />
                  </li>
                ))}
                {target && drop?.beforeId === null ? <DropLine /> : null}
                {inColumn.length === 0 && !target ? (
                  <li className="rounded-md border border-dashed border-control px-3 py-4 text-center text-xs text-muted-foreground">
                    No tasks
                  </li>
                ) : null}
              </ol>
              <QuickAdd projectId={projectId} status={column.status} label={column.label} />
            </section>
          );
        })}
      </div>
    </div>
  );
}

function DropLine() {
  return <div aria-hidden className="mb-2 h-0.5 rounded-full bg-teal" />;
}

function CardView({
  card,
  projectId,
  columns,
  dragging,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  card: BoardCard;
  projectId: string;
  columns: { status: string; label: string }[];
  dragging: boolean;
  onDragStart: (e: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onMove: (status: string) => void;
}) {
  const href = `/projects/${projectId}/tasks/${card.number}`;
  return (
    <article
      data-card-id={card.id}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        'cursor-grab space-y-2 rounded-md border border-border bg-sheet p-3 text-sm shadow-[0_1px_0_rgb(var(--border))] active:cursor-grabbing',
        dragging && 'opacity-50'
      )}
    >
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <Link
          href={href}
          className="rounded-sm font-mono underline-offset-[3px] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
          draggable={false}
        >
          {card.key}
        </Link>
        <span>{card.typeLabel}</span>
      </div>
      <p className="font-medium leading-5">
        <Link
          href={href}
          className="rounded-sm underline-offset-[3px] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
          draggable={false}
        >
          {card.title}
        </Link>
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill tone={card.priorityTone}>{card.priorityLabel}</Pill>
        {card.labels.slice(0, 3).map((label) => (
          <Pill key={label} tone="neutral">
            {label}
          </Pill>
        ))}
        {card.labels.length > 3 ? (
          <span className="text-xs text-muted-foreground">+{card.labels.length - 3}</span>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="min-w-0 truncate text-muted-foreground" title={card.assignee ?? undefined}>
          {card.assignee ?? 'Unassigned'}
        </span>
        {card.dueOn ? (
          <span
            className={cn(
              'flex-none tabular-nums',
              card.overdue ? 'text-negative' : 'text-muted-foreground'
            )}
          >
            {card.overdue ? 'Overdue · ' : 'Due '}
            {card.dueOn}
          </span>
        ) : null}
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        Move to
        <select
          aria-label={`Move ${card.key} to`}
          value={card.status}
          onChange={(e) => onMove(e.target.value)}
          className="h-8 flex-1 rounded-md border border-field bg-sheet px-1.5 text-xs text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal max-sm:h-11"
        >
          {columns.map((c) => (
            <option key={c.status} value={c.status}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
    </article>
  );
}

/** "+ Add task" at the foot of a column: a title only, created straight into that column. */
function QuickAdd({
  projectId,
  status,
  label,
}: {
  projectId: string;
  status: string;
  label: string;
}) {
  return (
    <details className="mt-2">
      <summary className="flex h-9 cursor-pointer list-none items-center rounded-md px-1.5 text-sm text-muted-foreground hover:bg-sheet hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal max-sm:h-11">
        + Add task
      </summary>
      <form action={createTaskAction} className="mt-2 space-y-2">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="status" value={status} />
        <input type="hidden" name="from" value="board" />
        <Input
          name="title"
          required
          maxLength={200}
          autoComplete="off"
          aria-label={`New task title in ${label}`}
          placeholder="What needs doing?"
        />
        <Button type="submit" size="sm">
          Add
        </Button>
      </form>
    </details>
  );
}
