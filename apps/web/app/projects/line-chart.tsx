'use client';

import { useState, type PointerEvent } from 'react';

export interface ChartSeries {
  name: string;
  /** A validated series color; text never wears it. */
  color: string;
  values: number[];
}

const W = 640;
const H = 220;
const PAD = { l: 34, r: 86, t: 14, b: 28 };

function niceMax(value: number): number {
  if (value <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / step) * step;
}

/**
 * A small line chart: 2px lines on recessive gridlines, a crosshair and tooltip on hover, the
 * series named by a legend and at their line ends, and the same numbers as a table. `reference`
 * draws a dashed guide (e.g. a burndown's ideal line) that is not a data series.
 */
export function LineChart({
  labels,
  series,
  reference,
  ariaLabel,
  formatLabel = (l) => l,
}: {
  labels: string[];
  series: ChartSeries[];
  reference?: { name: string; values: (number | null)[] };
  ariaLabel: string;
  formatLabel?: (label: string) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const n = labels.length;
  const max = niceMax(
    Math.max(0, ...series.flatMap((s) => s.values), ...(reference?.values ?? []).map((v) => v ?? 0))
  );
  const x = (i: number) => PAD.l + (n > 1 ? (i * (W - PAD.l - PAD.r)) / (n - 1) : 0);
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const path = (values: (number | null)[]) =>
    values
      .map((v, i) => (v === null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`))
      .filter(Boolean)
      .join(' ');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const every = Math.max(1, Math.ceil(n / 6));

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, i)));
  };

  return (
    <figure className="space-y-2">
      {series.length > 1 ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-hidden>
          {series.map((s) => (
            <li key={s.name} className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded-full" style={{ background: s.color }} />
              {s.name}
            </li>
          ))}
          {reference ? (
            <li className="flex items-center gap-1.5">
              <span className="w-4 border-t border-dashed border-muted-foreground" />
              {reference.name}
            </li>
          ) : null}
        </ul>
      ) : null}
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full overflow-visible"
          role="img"
          aria-label={ariaLabel}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.l}
                x2={W - PAD.r}
                y1={y(t)}
                y2={y(t)}
                stroke="rgb(var(--border))"
                strokeDasharray={t === 0 ? undefined : '2 4'}
              />
              <text
                x={PAD.l - 8}
                y={y(t) + 4}
                textAnchor="end"
                className="fill-muted-foreground text-[10px]"
              >
                {Math.round(t)}
              </text>
            </g>
          ))}
          {labels.map((l, i) =>
            i % every === 0 || i === n - 1 ? (
              <text
                key={l}
                x={x(i)}
                y={H - 8}
                textAnchor="middle"
                className="fill-muted-foreground text-[10px]"
              >
                {formatLabel(l)}
              </text>
            ) : null
          )}
          {reference ? (
            <polyline
              points={path(reference.values)}
              fill="none"
              stroke="rgb(var(--muted))"
              strokeWidth={1.5}
              strokeDasharray="4 4"
            />
          ) : null}
          {series.map((s) => (
            <g key={s.name}>
              <polyline
                points={path(s.values)}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {n > 0 ? (
                <text
                  x={x(n - 1) + 8}
                  y={y(s.values[n - 1] ?? 0) + 4}
                  className="fill-text text-[11px] font-medium"
                >
                  {s.name} {s.values[n - 1] ?? 0}
                </text>
              ) : null}
            </g>
          ))}
          {hover !== null ? (
            <g>
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={PAD.t}
                y2={H - PAD.b}
                stroke="rgb(var(--muted))"
              />
              {series.map((s) => (
                <circle
                  key={s.name}
                  cx={x(hover)}
                  cy={y(s.values[hover] ?? 0)}
                  r={4}
                  fill={s.color}
                  stroke="rgb(var(--sheet))"
                  strokeWidth={2}
                />
              ))}
            </g>
          ) : null}
          <rect
            x={PAD.l}
            y={0}
            width={W - PAD.l - PAD.r}
            height={H}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
        {hover !== null ? (
          <div
            className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-md border border-border bg-sheet px-2.5 py-1.5 text-xs shadow-float"
            style={{ left: `${(x(hover) / W) * 100}%` }}
          >
            <p className="font-medium">{formatLabel(labels[hover] ?? '')}</p>
            {series.map((s) => (
              <p
                key={s.name}
                className="flex items-center gap-1.5 tabular-nums text-muted-foreground"
              >
                <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                {s.name}: <span className="text-text">{s.values[hover] ?? 0}</span>
              </p>
            ))}
            {typeof reference?.values[hover] === 'number' ? (
              <p className="tabular-nums text-muted-foreground">
                {reference.name}: {Math.round(reference.values[hover])}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground hover:text-text">
          Show as table
        </summary>
        <table className="mt-2 w-full text-left tabular-nums">
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="py-1 font-medium">
                Date
              </th>
              {series.map((s) => (
                <th key={s.name} scope="col" className="py-1 font-medium">
                  {s.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {labels.map((l, i) => (
              <tr key={l} className="border-t border-rule">
                <td className="py-1">{formatLabel(l)}</td>
                {series.map((s) => (
                  <td key={s.name} className="py-1">
                    {s.values[i] ?? 0}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
