import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

// Display-only code blocks. Both render the source text verbatim — highlighting wraps
// spans around parts of it and never rewrites it — so what a reviewer reads is exactly
// what was stored and what the download contains.

const GHERKIN_KEYWORD =
  /^(\s*)(Feature:|Rule:|Background:|Scenario Outline:|Scenario Template:|Scenario:|Example:|Examples:|Given|When|Then|And|But|\*)(\s|$)(.*)$/;

/** Gherkin with its step keywords set in a column, as in the report's Specs tab. */
export function GherkinBlock({ source, className }: { source: string; className?: string }) {
  return (
    <div
      className={cn(
        'overflow-x-auto rounded-md bg-muted/60 px-3 py-2.5 font-mono text-xs leading-6',
        className
      )}
    >
      {source.split('\n').map((line, index) => (
        <GherkinLine key={index} line={line} />
      ))}
    </div>
  );
}

function GherkinLine({ line }: { line: string }) {
  const trimmed = line.trim();
  if (trimmed === '') return <div className="h-3" />;
  if (trimmed.startsWith('#')) return <div className="text-muted-foreground">{line}</div>;
  if (trimmed.startsWith('@')) return <div className="text-teal-ink">{line}</div>;
  if (trimmed.startsWith('|')) return <div className="whitespace-pre pl-[4.5rem]">{trimmed}</div>;

  const match = GHERKIN_KEYWORD.exec(line);
  if (!match) return <div className="whitespace-pre-wrap pl-[4.5rem]">{trimmed}</div>;

  const keyword = match[2] ?? '';
  const rest = match[4] ?? '';
  if (keyword.endsWith(':')) {
    return (
      <div className="whitespace-pre-wrap">
        <span className="font-semibold text-text">{keyword}</span> {rest}
      </div>
    );
  }
  return (
    <div className="flex gap-3">
      <span className="w-[3.75rem] shrink-0 text-right font-semibold text-teal">{keyword}</span>
      <span className="whitespace-pre-wrap">{rest}</span>
    </div>
  );
}

/** A code block on the dark frame; matches of `highlight` (e.g. placeholders to fill) stand out. */
export function CodeBlock({
  code,
  highlight,
  className,
}: {
  code: string;
  highlight?: RegExp | undefined;
  className?: string;
}) {
  return (
    <pre
      className={cn(
        'overflow-x-auto rounded-md border border-border bg-frame p-4 font-mono text-xs leading-relaxed text-text/90',
        className
      )}
    >
      {highlight ? mark(code, highlight) : code}
    </pre>
  );
}

function mark(code: string, pattern: RegExp): ReactNode[] {
  const parts: ReactNode[] = [];
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  );
  let last = 0;
  for (const match of code.matchAll(global)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(code.slice(last, at));
    parts.push(
      <mark key={at} className="rounded bg-warning-bg px-0.5 text-warning-ink">
        {match[0]}
      </mark>
    );
    last = at + match[0].length;
  }
  if (last < code.length) parts.push(code.slice(last));
  return parts;
}
