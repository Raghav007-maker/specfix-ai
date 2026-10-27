'use client';

import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

function reducedMotion(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** True once the element has been on screen. */
export function useInView(ref: RefObject<Element | null>, threshold = 0.3): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, threshold, seen]);
  return seen;
}

/**
 * How many characters of `text` to show while it types out, once `active`. It restarts when the
 * text changes. The full text shows at once under reduced motion, and before scripts run the
 * caller renders the whole text, so nothing depends on the animation finishing.
 */
export function useTyped(text: string, active: boolean, charsPerSecond = 70): number {
  // Full on the server and on the first client render, so they match; the layout effect empties
  // it before the browser paints, so the full text never flashes before it types.
  const [count, setCount] = useState(text.length);
  useLayoutEffect(() => {
    if (!active || reducedMotion()) {
      setCount(text.length);
      return;
    }
    setCount(0);
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const n = Math.min(text.length, Math.floor(((now - start) / 1000) * charsPerSecond));
      setCount(n);
      if (n < text.length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, active, charsPerSecond]);
  return count;
}
