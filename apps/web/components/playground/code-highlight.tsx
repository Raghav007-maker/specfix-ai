import type { ReactNode } from 'react';
import s from './playground.module.css';

type Kind = 'kw' | 'str' | 'num' | 'ph' | 'cm' | 'plain';
type Token = { text: string; kind: Kind };

const GHERKIN_KW = /^(\s*)(Scenario:|Given|When|Then|And)\b/;

/** Split one line into coloured tokens: keywords, strings, numbers, comments, placeholders. */
function tokenize(line: string, lang: 'gherkin' | 'ts'): Token[] {
  if (lang === 'ts' && line.trim().startsWith('//')) return [{ text: line, kind: 'cm' }];
  const out: Token[] = [];
  let rest = line;
  if (lang === 'gherkin') {
    const m = GHERKIN_KW.exec(rest);
    if (m) {
      out.push({ text: m[1]!, kind: 'plain' }, { text: m[2]!, kind: 'kw' });
      rest = rest.slice(m[0].length);
    }
  }
  const re =
    lang === 'ts'
      ? /('[^']*'|"[^"]*"|\b\d+\b|\b(?:test|async|await|const|expect)\b)/g
      : /("[^"]*"|\b\d+\b)/g;
  let i = 0;
  for (const m of rest.matchAll(re)) {
    if (m.index! > i) out.push({ text: rest.slice(i, m.index), kind: 'plain' });
    const t = m[0];
    const kind: Kind = /^['"]/.test(t)
      ? t.includes('TODO')
        ? 'ph'
        : 'str'
      : /^\d/.test(t)
        ? 'num'
        : 'kw';
    out.push({ text: t, kind });
    i = m.index! + t.length;
  }
  if (i < rest.length) out.push({ text: rest.slice(i), kind: 'plain' });
  return out;
}

/**
 * Highlighted code, cut off after `shown` characters so it can type out, with a caret where the
 * typing has reached. Each line is its own element (with `data-line`) so other parts of the page
 * can point at specific lines.
 */
export function HighlightedCode({
  code,
  lang,
  shown,
  lineAttrs,
}: {
  code: string;
  lang: 'gherkin' | 'ts';
  shown: number;
  lineAttrs?: (index: number) => Record<string, string | undefined>;
}) {
  const lines = code.split('\n');
  const typing = shown < code.length;
  // Which line the typing has reached: each line is its length plus one newline.
  let caretLine = lines.length - 1;
  for (let i = 0, start = 0; i < lines.length; start += lines[i]!.length + 1, i++) {
    if (shown <= start + lines[i]!.length) {
      caretLine = i;
      break;
    }
  }
  let left = shown;
  return (
    <>
      {lines.map((line, li) => {
        const parts: ReactNode[] = [];
        for (const [ti, tok] of tokenize(line, lang).entries()) {
          if (left <= 0) break;
          const text = tok.text.slice(0, left);
          left -= text.length;
          parts.push(
            <span
              key={ti}
              className={tok.kind === 'plain' ? undefined : s[`tok_${tok.kind}`]}
              title={
                tok.kind === 'ph'
                  ? 'Placeholder selector: a person fills in the real one'
                  : undefined
              }
            >
              {text}
            </span>
          );
        }
        left -= 1; // the newline
        return (
          <span key={li} className={s.codeLine} data-line={li} {...lineAttrs?.(li)}>
            {parts}
            {typing && li === caretLine ? (
              <span className={s.codeCaret} aria-hidden="true" />
            ) : null}
          </span>
        );
      })}
    </>
  );
}
