'use client';

import { useEffect, useRef } from 'react';

declare global {
  interface Window {
    turnstile?: { render: (el: HTMLElement, options: { sitekey: string }) => string };
  }
}

const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/**
 * Cloudflare's "verify you are human" box. Rendered inside the sign-in form, it adds the hidden
 * field `cf-turnstile-response`, which the auth actions pass to Supabase as the captcha token.
 */
export function Turnstile({ siteKey }: { siteKey: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const draw = () => {
      if (box.current && !box.current.hasChildNodes()) {
        window.turnstile?.render(box.current, { sitekey: siteKey });
      }
    };
    if (window.turnstile) return draw();
    let script = document.querySelector<HTMLScriptElement>(`script[src="${SRC}"]`);
    if (!script) {
      script = document.createElement('script');
      script.src = SRC;
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener('load', draw);
    return () => script.removeEventListener('load', draw);
  }, [siteKey]);
  return <div ref={box} style={{ minHeight: 65 }} />;
}
