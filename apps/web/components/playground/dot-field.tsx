'use client';

import { useEffect, useRef } from 'react';

/**
 * A fine field of ink dots behind a block, in the hero's style. The dots move aside under the
 * cursor and darken where they are pushed; every change of `pulse` sends a ripple out from the
 * centre (or from `origin`, in 0–1 coordinates). The canvas never takes pointer events: it listens
 * on its parent, so the content above it stays fully interactive. Pauses off screen; under reduced
 * motion it draws one still frame.
 */
export function DotField({
  className,
  pulse = 0,
  origin,
  gap = 12,
  alpha = 0.16,
}: {
  className?: string;
  pulse?: number;
  origin?: { x: number; y: number };
  gap?: number;
  alpha?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const kick = useRef<((o?: { x: number; y: number }) => void) | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

    let w = 0;
    let h = 0;
    let cols = 0;
    let rows = 0;
    let off = new Float32Array(0);
    let vel = new Float32Array(0);
    let ink = '17,17,17';
    let pointer: { x: number; y: number } | null = null;
    const waves: { x: number; y: number; t: number }[] = [];
    let frame = 0;
    let visible = true;
    let last = performance.now();
    let calm = 0;

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(w / gap) + 1;
      rows = Math.ceil(h / gap) + 1;
      off = new Float32Array(cols * rows * 2);
      vel = new Float32Array(cols * rows * 2);
      const m = getComputedStyle(canvas).color.match(/\d+(\.\d+)?/g);
      if (m) ink = m.slice(0, 3).join(',');
    };

    const draw = (now: number) => {
      const dt = Math.min(48, now - last) / 16.67;
      last = now;
      for (let i = waves.length - 1; i >= 0; i--) if (now - waves[i]!.t > 1500) waves.splice(i, 1);
      ctx.clearRect(0, 0, w, h);
      const moved: number[] = [];
      let energy = 0;
      ctx.fillStyle = `rgba(${ink},${alpha})`;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const j = (r * cols + c) * 2;
          const bx = c * gap + (r % 2 ? gap / 2 : 0);
          const by = r * gap;
          let vx = vel[j]!;
          let vy = vel[j + 1]!;
          let ox = off[j]!;
          let oy = off[j + 1]!;
          if (!reduce.matches) {
            if (pointer) {
              const dx = bx + ox - pointer.x;
              const dy = by + oy - pointer.y;
              const d2 = dx * dx + dy * dy;
              if (d2 < 120 * 120) {
                const d = Math.sqrt(d2) || 1;
                const f = (1 - d / 120) ** 2 * 1.4;
                vx += (dx / d) * f * dt;
                vy += (dy / d) * f * dt;
              }
            }
            for (const wv of waves) {
              const dx = bx - wv.x;
              const dy = by - wv.y;
              const d = Math.sqrt(dx * dx + dy * dy) || 1;
              const band = d - (now - wv.t) * 0.6;
              if (band > -28 && band < 28) {
                const f = Math.cos((band / 28) * (Math.PI / 2)) * 1.9 * (1 - (now - wv.t) / 1500);
                vx += (dx / d) * f * dt;
                vy += (dy / d) * f * dt;
              }
            }
            vx = (vx - ox * 0.06 * dt) * 0.84;
            vy = (vy - oy * 0.06 * dt) * 0.84;
            ox += vx * dt;
            oy += vy * dt;
            vel[j] = vx;
            vel[j + 1] = vy;
            off[j] = ox;
            off[j + 1] = oy;
            energy += Math.abs(vx) + Math.abs(vy);
          }
          const x = bx + ox;
          const y = by + oy;
          if (Math.abs(ox) + Math.abs(oy) > 1.2) moved.push(x, y);
          else ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
        }
      }
      ctx.fillStyle = `rgba(${ink},${Math.min(0.7, alpha * 3.4)})`;
      for (let i = 0; i < moved.length; i += 2)
        ctx.fillRect(moved[i]! - 1, moved[i + 1]! - 1, 2, 2);
      // Sleep once everything is still and nothing is moving it.
      calm = energy < 0.5 && !pointer && waves.length === 0 ? calm + 1 : 0;
    };

    const loop = (now: number) => {
      frame = 0;
      draw(now);
      if (visible && !reduce.matches && !document.hidden && calm < 30) {
        frame = requestAnimationFrame(loop);
      }
    };
    const start = () => {
      calm = 0;
      if (!frame) frame = requestAnimationFrame(loop);
    };

    kick.current = (o) => {
      if (reduce.matches) return;
      waves.push({ x: (o?.x ?? 0.5) * w, y: (o?.y ?? 0.5) * h, t: performance.now() });
      start();
    };

    resize();
    draw(performance.now());

    const ro = new ResizeObserver(() => {
      resize();
      draw(performance.now());
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => {
      visible = Boolean(e?.isIntersecting);
      if (visible) start();
    });
    io.observe(canvas);
    const onMove = (ev: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      pointer = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      start();
    };
    const onLeave = () => {
      pointer = null;
      start();
    };
    const onDown = (ev: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      kick.current?.({ x: (ev.clientX - r.left) / w, y: (ev.clientY - r.top) / h });
    };
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerleave', onLeave);
    host.addEventListener('pointerdown', onDown);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      io.disconnect();
      kick.current = null;
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerleave', onLeave);
      host.removeEventListener('pointerdown', onDown);
    };
  }, [gap, alpha]);

  // A new pulse value sends a ripple.
  useEffect(() => {
    if (pulse) kick.current?.(origin);
    // `origin` is read at the moment of the pulse only, so it is not a dependency.
  }, [pulse]);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
