'use client';

import { useEffect, useRef } from 'react';

const PREFIX = 'sf-draft:';

/**
 * Keeps what someone typed when a server action refuses the form. The actions answer a refusal
 * by redirecting back with `?error=`, which re-renders the form empty; this saves the form's
 * visible fields when it is submitted, and puts them back only when the page returns with an
 * error. Any other load drops the draft. Kept in sessionStorage, so it never leaves this tab;
 * hidden fields (ids, action keys) are never saved or restored.
 */
export function FormDraft({ name }: { name: string }) {
  const marker = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const form = marker.current?.closest('form');
    if (!form) return;
    const key = PREFIX + name;
    const editable = () =>
      [...form.elements].filter(
        (e): e is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement =>
          (e instanceof HTMLInputElement &&
            !['hidden', 'file', 'submit', 'button', 'password'].includes(e.type)) ||
          e instanceof HTMLTextAreaElement ||
          e instanceof HTMLSelectElement
      );

    try {
      const saved = sessionStorage.getItem(key);
      sessionStorage.removeItem(key);
      if (saved && new URLSearchParams(window.location.search).has('error')) {
        const values = JSON.parse(saved) as Record<string, string>;
        for (const el of editable()) {
          if (el.name && typeof values[el.name] === 'string') el.value = values[el.name]!;
        }
      }
    } catch {
      // Storage blocked or a malformed draft: the form simply starts as rendered.
    }

    const save = () => {
      const values: Record<string, string> = {};
      for (const el of editable()) if (el.name) values[el.name] = el.value;
      try {
        sessionStorage.setItem(key, JSON.stringify(values));
      } catch {
        // Nothing to keep if storage is unavailable.
      }
    };
    form.addEventListener('submit', save);
    return () => form.removeEventListener('submit', save);
  }, [name]);

  return <span ref={marker} hidden />;
}
