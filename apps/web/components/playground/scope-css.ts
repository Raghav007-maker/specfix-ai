/**
 * Scope the playground's Advanced Custom CSS to the preview root so it cannot reach production
 * pages or the Design Controls. The browser's own parser does the validation: rules it cannot
 * parse never appear in `cssRules`, and each surviving style rule is re-emitted with every
 * selector prefixed. Only style rules (inside @media, @supports and @container too) and
 * @keyframes survive; @import, @font-face and the rest are dropped and counted. No script runs.
 */
export interface ScopedCss {
  css: string;
  applied: number;
  dropped: number;
}

export const SCOPE = '[data-pg-preview]';

/** Split a selector list on its top-level commas, leaving `:is(a, b)` and `[x="a,b"]` whole. */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]!;
    if (quote) {
      if (ch === quote && list[i - 1] !== '\\') quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out.filter(Boolean);
}

/** `:root`, `html` and `body` mean the preview root itself; anything else is a descendant. */
export function scopeSelector(selector: string): string {
  const root = /^(?::root|html|body)(?![\w-])/i;
  if (root.test(selector)) return selector.replace(root, SCOPE);
  return `${SCOPE} ${selector}`;
}

type Counts = { applied: number; dropped: number; blocks: number };

function emit(rules: CSSRuleList, counts: Counts): string {
  let out = '';
  for (const rule of Array.from(rules)) {
    counts.blocks++;
    if (rule instanceof CSSStyleRule) {
      const selectors = splitSelectors(rule.selectorText).map(scopeSelector).join(', ');
      out += `${selectors} { ${rule.style.cssText} }\n`;
      counts.applied++;
    } else if (rule instanceof CSSMediaRule) {
      out += `@media ${rule.conditionText} {\n${emit(rule.cssRules, counts)}}\n`;
    } else if (rule instanceof CSSSupportsRule) {
      out += `@supports ${rule.conditionText} {\n${emit(rule.cssRules, counts)}}\n`;
    } else if (typeof CSSContainerRule !== 'undefined' && rule instanceof CSSContainerRule) {
      out += `@container ${rule.conditionText} {\n${emit(rule.cssRules, counts)}}\n`;
    } else if (rule instanceof CSSKeyframesRule) {
      out += `${rule.cssText}\n`;
      counts.applied++;
    } else {
      counts.dropped++;
    }
  }
  return out;
}

/** Rough count of top-level and nested blocks the author wrote, to report what the parser threw away. */
function writtenBlocks(css: string): number {
  return (css.replace(/\/\*[\s\S]*?\*\//g, '').match(/\{/g) ?? []).length;
}

export function scopeCss(input: string): ScopedCss {
  if (input.trim() === '') return { css: '', applied: 0, dropped: 0 };
  const sheet = new CSSStyleSheet();
  // replaceSync throws only on @import; strip those first and count them as dropped.
  const imports = (input.match(/@import[^;]*;?/gi) ?? []).length;
  sheet.replaceSync(input.replace(/@import[^;]*;?/gi, ''));
  const counts: Counts = { applied: 0, dropped: imports, blocks: 0 };
  const css = emit(sheet.cssRules, counts);
  // Blocks the parser rejected outright never reach cssRules; count them too.
  const unparsed = Math.max(0, writtenBlocks(input) - counts.blocks);
  return { css, applied: counts.applied, dropped: counts.dropped + unparsed };
}
