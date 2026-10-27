'use client';

import { useEffect, useRef } from 'react';
import { MARK } from './logo-paths';
import s from './playground.module.css';

/**
 * What the dots build, in order: the SF mark (traced from the logo), a ticket with a flagged
 * span, a flag, the sign-off tick, then a sphere and a knot.
 */
const FORMS = ['mark', 'ticket', 'flag', 'check', 'sphere', 'knot'] as const;
type FormId = (typeof FORMS)[number];

const TAU = Math.PI * 2;

/** Seeded random, so every load draws the same figure. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Points inside a filled 2D drawing, as x/y in [-1, 1] keeping the aspect ratio. */
function rasterPoints(draw: (ctx: CanvasRenderingContext2D) => void, w: number, h: number) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return [] as [number, number][];
  draw(ctx);
  const data = ctx.getImageData(0, 0, w, h).data;
  const out: [number, number][] = [];
  const half = Math.max(w, h) / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3]! > 120) out.push([(x - w / 2) / half, (y - h / 2) / half]);
    }
  }
  return out;
}

function sample(form: FormId, n: number, rand: () => number): Float32Array {
  const out = new Float32Array(n * 3);
  const put = (i: number, x: number, y: number, z: number) => {
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  };

  if (form === 'mark') {
    const k = 4;
    const pts = rasterPoints(
      (ctx) => {
        ctx.scale(k, k);
        ctx.fill(new Path2D(MARK.d), 'evenodd');
      },
      MARK.width * k,
      MARK.height * k
    );
    for (let i = 0; i < n; i++) {
      const [x, y] = pts[Math.floor(rand() * pts.length)] ?? [0, 0];
      // Extruded: most dots on the two faces, the rest through the depth for the side walls.
      const z = rand() < 0.8 ? (rand() < 0.5 ? -0.09 : 0.09) : (rand() - 0.5) * 0.18;
      put(i, x * 1.05, y * 1.05, z);
    }
    return out;
  }

  if (form === 'flag' || form === 'check') {
    const size = 400;
    const pts = rasterPoints(
      (ctx) => {
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (form === 'flag') {
          // A flag on its pole, the cloth in a soft wave.
          ctx.fillRect(96, 40, 18, 330);
          ctx.beginPath();
          ctx.moveTo(114, 52);
          ctx.bezierCurveTo(180, 20, 240, 92, 318, 52);
          ctx.lineTo(318, 196);
          ctx.bezierCurveTo(240, 236, 180, 164, 114, 196);
          ctx.closePath();
          ctx.fill();
        } else {
          // The sign-off: a tick inside a ring.
          ctx.lineWidth = 30;
          ctx.beginPath();
          ctx.arc(200, 200, 150, 0, Math.PI * 2);
          ctx.stroke();
          ctx.lineWidth = 42;
          ctx.beginPath();
          ctx.moveTo(128, 206);
          ctx.lineTo(180, 258);
          ctx.lineTo(282, 148);
          ctx.stroke();
        }
      },
      size,
      size
    );
    for (let i = 0; i < n; i++) {
      const [x, y] = pts[Math.floor(rand() * pts.length)] ?? [0, 0];
      const z = rand() < 0.8 ? (rand() < 0.5 ? -0.08 : 0.08) : (rand() - 0.5) * 0.16;
      put(i, x * 1.08, y * 1.08, z);
    }
    return out;
  }

  if (form === 'ticket') {
    // A ticket page: its edge, lines of text, and one flagged span drawn densely.
    const W = 1.4;
    const H = 1.84;
    const top = -H / 2 + 0.3;
    const gap = 0.2;
    const rows = [0.62, 0.92, 0.78, 0.86, 0.5, 0.88, 0.7];
    for (let i = 0; i < n; i++) {
      const r = rand();
      let x: number;
      let y: number;
      if (r < 0.16) {
        const t = rand() * 2 * (W + H);
        if (t < W) [x, y] = [-W / 2 + t, -H / 2];
        else if (t < W + H) [x, y] = [W / 2, -H / 2 + (t - W)];
        else if (t < 2 * W + H) [x, y] = [W / 2 - (t - W - H), H / 2];
        else [x, y] = [-W / 2, H / 2 - (t - 2 * W - H)];
      } else if (r < 0.36) {
        // The flagged span on the third line, filled like a highlighter mark.
        x = -0.22 + rand() * 0.66;
        y = top + 2 * gap + (rand() - 0.5) * 0.14;
      } else {
        const row = Math.floor(rand() * rows.length);
        x = -W / 2 + 0.16 + rand() * (W - 0.32) * rows[row]!;
        y = top + row * gap + (rand() - 0.5) * 0.04;
      }
      put(i, x, y, (rand() - 0.5) * 0.05);
    }
    return out;
  }

  for (let i = 0; i < n; i++) {
    if (form === 'sphere') {
      const k = i + 0.5;
      const phi = Math.acos(1 - (2 * k) / n);
      const theta = Math.PI * (1 + Math.sqrt(5)) * k;
      const r = 1 + 0.08 * Math.sin(3 * phi) * Math.cos(4 * theta);
      put(
        i,
        r * Math.cos(theta) * Math.sin(phi),
        r * Math.sin(theta) * Math.sin(phi),
        r * Math.cos(phi)
      );
    } else {
      // A trefoil knot drawn as a tube.
      const t = rand() * TAU;
      const v = rand() * TAU;
      const c = (q: number) => [
        (Math.sin(q) + 2 * Math.sin(2 * q)) / 3.1,
        (Math.cos(q) - 2 * Math.cos(2 * q)) / 3.1,
        -Math.sin(3 * q) / 3.1,
      ];
      const p = c(t);
      const q = c(t + 0.001);
      const d = [q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!];
      const dl = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
      const tan = d.map((e) => e / dl);
      let n1 = [tan[1]!, -tan[0]!, 0];
      const n1l = Math.hypot(n1[0]!, n1[1]!) || 1;
      n1 = n1.map((e) => e / n1l);
      const n2 = [
        tan[1]! * n1[2]! - tan[2]! * n1[1]!,
        tan[2]! * n1[0]! - tan[0]! * n1[2]!,
        tan[0]! * n1[1]! - tan[1]! * n1[0]!,
      ];
      const r = 0.15;
      put(
        i,
        p[0]! + r * (Math.cos(v) * n1[0]! + Math.sin(v) * n2[0]!),
        p[1]! + r * (Math.cos(v) * n1[1]! + Math.sin(v) * n2[1]!),
        p[2]! + r * (Math.cos(v) * n1[2]! + Math.sin(v) * n2[2]!)
      );
    }
  }
  return out;
}

/**
 * A dense field of ink dots that builds SpecFix's forms: the SF mark, a ticket with a flagged
 * span, a sphere and a knot. The dots assemble out of a dust cloud on load and rebuild in a
 * left-to-right wave on every change. It is interactive: drag to turn it, move the cursor to push
 * dots aside, click to scatter them and watch them spring back, and it moves on to the next form by itself. It reads its ink
 * from the CSS `color`, pauses off screen, and under reduced motion draws one still frame.
 */
export function ParticleFigure({
  speed,
  intensity,
  density = 0.9,
  className,
  label,
}: {
  /** Motion multiplier: 1 is the default pace. */
  speed: number;
  /** 0–1: how strongly the dots react to the cursor and clicks. */
  intensity: number;
  /** 0.3–1: share of the full dot count. */
  density?: number;
  className?: string;
  label: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ speed, intensity });
  live.current = { speed, intensity };
  const formRef = useRef(0);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const small = canvas.clientWidth < 420;
    const n = Math.round((small ? 7000 : 14000) * Math.min(1, Math.max(0.3, density)));
    const rand = rng(11);
    const shapes = FORMS.map((f) => sample(f, n, rand));
    // The dust cloud every dot starts from on load.
    const dust = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) dust[i] = (rand() - 0.5) * 5;
    const lag = new Float32Array(n);
    for (let i = 0; i < n; i++) lag[i] = rand();

    // Per-dot spring offset and velocity, in screen pixels.
    const off = new Float32Array(n * 2);
    const vel = new Float32Array(n * 2);
    const pos = new Float32Array(n * 2);
    const SHADES = 9;
    const shade = new Uint8Array(n);

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    let to: Float32Array = shapes[formRef.current]!;
    let from: Float32Array = reduce.matches ? to : dust;
    let morphStart = reduce.matches ? -1 : performance.now();
    let lastChange = performance.now();
    let lastTouch = -Infinity;
    let yaw = 0;
    let pitch = 0;
    let spinYaw = 0;
    let spinPitch = 0;
    let last = performance.now();
    let frame = 0;
    let visible = true;
    let pointer: { x: number; y: number } | null = null;
    let drag: { x: number; y: number; moved: number } | null = null;
    let ink = '17,17,17';
    // The background field: a fine grid of dots across the whole canvas, each on its own spring.
    const GAP = 11;
    let cols = 0;
    let rows = 0;
    let fieldOff = new Float32Array(0);
    let fieldVel = new Float32Array(0);
    const waves: { x: number; y: number; t: number }[] = [];

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const m = getComputedStyle(canvas).color.match(/\d+(\.\d+)?/g);
      if (m) ink = m.slice(0, 3).join(',');
      cols = Math.ceil(canvas.clientWidth / GAP) + 1;
      rows = Math.ceil(canvas.clientHeight / GAP) + 1;
      fieldOff = new Float32Array(cols * rows * 2);
      fieldVel = new Float32Array(cols * rows * 2);
    };

    const morphMs = () => 1900 / live.current.speed;
    // A wave: dots on the left set off first; each also carries a little random lag.
    const progressOf = (i: number, now: number) => {
      const xs = (to[i * 3]! + 1.2) / 2.4;
      const t = (now - morphStart) / morphMs();
      const delay = 0.45 * (0.65 * xs + 0.35 * lag[i]!);
      const p = Math.min(1, Math.max(0, (t - delay) / 0.55));
      return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
    };
    const current = (now: number) => {
      const out = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const e = morphStart >= 0 ? progressOf(i, now) : 1;
        for (let a = 0; a < 3; a++) {
          out[i * 3 + a] = from[i * 3 + a]! + (to[i * 3 + a]! - from[i * 3 + a]!) * e;
        }
      }
      return out;
    };

    const goto = (i: number) => {
      const next = ((i % FORMS.length) + FORMS.length) % FORMS.length;
      const now = performance.now();
      // Start from wherever the dots are now, mid-morph included.
      from = reduce.matches ? shapes[next]! : current(now);
      to = shapes[next]!;
      formRef.current = next;
      morphStart = reduce.matches ? -1 : now;
      lastChange = now;
      if (reduce.matches) draw(now);
      start();
    };

    function draw(now: number) {
      const dt = Math.min(48, now - last) / 16.67;
      last = now;
      const { speed: sp, intensity: k } = live.current;
      const still = reduce.matches;

      if (!still && morphStart < 0 && now - lastChange > 7200 / sp && now - lastTouch > 9000) {
        goto(formRef.current + 1);
      }
      let morphing = morphStart >= 0;
      if (morphing && now - morphStart > morphMs()) {
        morphStart = -1;
        from = to;
        morphing = false;
      }

      // Turning: a slow sway that keeps the mark and ticket readable, plus drag inertia.
      if (!drag) {
        spinYaw *= 0.94;
        spinPitch *= 0.94;
      }
      yaw += spinYaw * dt;
      pitch = Math.max(-0.9, Math.min(0.9, pitch + spinPitch * dt));
      const w = canvas!.clientWidth;
      const h = canvas!.clientHeight;
      const idleYaw = still ? 0 : Math.sin(now * 0.00045 * sp) * 0.42;
      const idlePitch = still ? 0 : Math.sin(now * 0.00031 * sp) * 0.12;
      const tiltX = pointer && !drag ? (pointer.x / w - 0.5) * 0.35 : 0;
      const tiltY = pointer && !drag ? (pointer.y / h - 0.5) * 0.25 : 0;
      const ay = yaw + idleYaw + tiltX;
      const ax = 0.12 + pitch + idlePitch + tiltY;
      const ca = Math.cos(ay);
      const sa = Math.sin(ay);
      const cp = Math.cos(ax);
      const spch = Math.sin(ax);

      const scale = Math.min(w, h) * 0.4;
      const cx = w / 2;
      const cy = h / 2;
      const breathe = still ? 1 : 1 + Math.sin(now * 0.0011 * sp) * 0.012;
      const reach = 70 + 110 * k;

      ctx!.clearRect(0, 0, w, h);
      drawField(now, dt, k, still);
      for (let i = 0; i < n; i++) {
        let x = to[i * 3]!;
        let y = to[i * 3 + 1]!;
        let z = to[i * 3 + 2]!;
        if (morphing) {
          const e = progressOf(i, now);
          const fx = from[i * 3]!;
          const fy = from[i * 3 + 1]!;
          const fz = from[i * 3 + 2]!;
          // Travel on a slight arc so the rebuild reads as a sweep, not a slide.
          const arc = Math.sin(Math.PI * e) * 0.18;
          x = fx + (x - fx) * e;
          y = fy + (y - fy) * e - arc;
          z = fz + (z - fz) * e + arc;
        }
        const rx = x * ca - z * sa;
        const rz = x * sa + z * ca;
        const ry = y * cp - rz * spch;
        const rz2 = y * spch + rz * cp;
        const persp = 2.8 / (2.8 + rz2);
        const bx = cx + rx * scale * persp * breathe;
        const by = cy + ry * scale * persp * breathe;

        // Springs: the cursor pushes, each dot's spring pulls it home.
        let ox = off[i * 2]!;
        let oy = off[i * 2 + 1]!;
        let vx = vel[i * 2]!;
        let vy = vel[i * 2 + 1]!;
        if (pointer && k > 0 && !still) {
          const dx = bx + ox - pointer.x;
          const dy = by + oy - pointer.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < reach * reach) {
            const d = Math.sqrt(d2) || 1;
            const f = (1 - d / reach) ** 2 * 3.2 * k;
            vx += (dx / d) * f * dt;
            vy += (dy / d) * f * dt;
          }
        }
        vx += -ox * 0.045 * dt;
        vy += -oy * 0.045 * dt;
        vx *= 0.86;
        vy *= 0.86;
        ox += vx * dt;
        oy += vy * dt;
        off[i * 2] = ox;
        off[i * 2 + 1] = oy;
        vel[i * 2] = vx;
        vel[i * 2 + 1] = vy;

        pos[i * 2] = bx + ox;
        pos[i * 2 + 1] = by + oy;
        const depth = Math.max(0, Math.min(1, (1 - rz2) / 2));
        shade[i] = Math.min(SHADES - 1, Math.floor(depth * SHADES));
      }
      // One fillStyle per shade keeps thousands of dots cheap.
      for (let b = 0; b < SHADES; b++) {
        const depth = (b + 0.5) / SHADES;
        const size = 1.4 + 1.4 * depth;
        ctx!.fillStyle = `rgba(${ink},${(0.8 + 0.2 * depth).toFixed(3)})`;
        for (let i = 0; i < n; i++) {
          if (shade[i] !== b) continue;
          ctx!.fillRect(pos[i * 2]! - size / 2, pos[i * 2 + 1]! - size / 2, size, size);
        }
      }
    }

    function drawField(now: number, dt: number, k: number, still: boolean) {
      const reach = 110 + 80 * k;
      for (let i = waves.length - 1; i >= 0; i--) if (now - waves[i]!.t > 1600) waves.splice(i, 1);
      const near: number[] = [];
      ctx!.fillStyle = `rgba(${ink},0.2)`;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const j = (r * cols + c) * 2;
          const bx = c * GAP + (r % 2 ? GAP / 2 : 0);
          const by = r * GAP;
          let vx = fieldVel[j]!;
          let vy = fieldVel[j + 1]!;
          let ox = fieldOff[j]!;
          let oy = fieldOff[j + 1]!;
          if (!still) {
            if (pointer && k > 0) {
              const dx = bx + ox - pointer.x;
              const dy = by + oy - pointer.y;
              const d2 = dx * dx + dy * dy;
              if (d2 < reach * reach) {
                const d = Math.sqrt(d2) || 1;
                const f = (1 - d / reach) ** 2 * 1.6 * k;
                vx += (dx / d) * f * dt;
                vy += (dy / d) * f * dt;
              }
            }
            for (const wv of waves) {
              const dx = bx - wv.x;
              const dy = by - wv.y;
              const d = Math.sqrt(dx * dx + dy * dy) || 1;
              const front = (now - wv.t) * 0.55;
              const band = d - front;
              if (band > -30 && band < 30) {
                const f = Math.cos((band / 30) * (Math.PI / 2)) * 2.2 * (1 - (now - wv.t) / 1600);
                vx += (dx / d) * f * dt;
                vy += (dy / d) * f * dt;
              }
            }
            vx += -ox * 0.06 * dt;
            vy += -oy * 0.06 * dt;
            vx *= 0.84;
            vy *= 0.84;
            ox += vx * dt;
            oy += vy * dt;
            fieldVel[j] = vx;
            fieldVel[j + 1] = vy;
            fieldOff[j] = ox;
            fieldOff[j + 1] = oy;
          }
          const x = bx + ox;
          const y = by + oy;
          // Dots the cursor has moved are drawn darker, so the push reads as ink, not a hole.
          if (Math.abs(ox) + Math.abs(oy) > 1.2) near.push(x, y);
          else ctx!.fillRect(x - 0.8, y - 0.8, 1.6, 1.6);
        }
      }
      ctx!.fillStyle = `rgba(${ink},0.55)`;
      for (let i = 0; i < near.length; i += 2) ctx!.fillRect(near[i]! - 1, near[i + 1]! - 1, 2, 2);
    }

    const loop = (now: number) => {
      frame = 0;
      draw(now);
      if (visible && !reduce.matches && !document.hidden) frame = requestAnimationFrame(loop);
    };
    function start() {
      if (!frame) frame = requestAnimationFrame(loop);
    }

    resize();
    draw(performance.now());
    start();

    const ro = new ResizeObserver(() => {
      resize();
      draw(performance.now());
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      if (visible) start();
    });
    io.observe(canvas);

    const local = (ev: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    };
    const onDown = (ev: PointerEvent) => {
      drag = { ...local(ev), moved: 0 };
      lastTouch = performance.now();
      canvas.setPointerCapture(ev.pointerId);
    };
    const onMove = (ev: PointerEvent) => {
      const p = local(ev);
      if (drag) {
        const dx = p.x - drag.x;
        const dy = p.y - drag.y;
        drag.moved += Math.abs(dx) + Math.abs(dy);
        spinYaw = dx * 0.006;
        spinPitch = dy * 0.004;
        drag.x = p.x;
        drag.y = p.y;
        lastTouch = performance.now();
      }
      pointer = p;
      start();
    };
    const onUp = (ev: PointerEvent) => {
      const p = local(ev);
      if (drag && drag.moved < 6 && !reduce.matches) {
        // A click: a ripple runs out through the field, and the figure bursts from the click
        // point; the springs bring every dot back.
        waves.push({ x: p.x, y: p.y, t: performance.now() });
        const power = 14 + 30 * live.current.intensity;
        for (let i = 0; i < n; i++) {
          const dx = pos[i * 2]! - p.x;
          const dy = pos[i * 2 + 1]! - p.y;
          const d = Math.hypot(dx, dy) || 1;
          const f = power * Math.exp(-d / 160) * (0.6 + 0.4 * lag[i]!);
          vel[i * 2] = vel[i * 2]! + (dx / d) * f;
          vel[i * 2 + 1] = vel[i * 2 + 1]! + (dy / d) * f;
        }
      }
      drag = null;
      lastTouch = performance.now();
      start();
    };
    const onLeave = () => {
      pointer = null;
    };
    const onVisibility = () => start();
    const onMotion = () => {
      draw(performance.now());
      start();
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    document.addEventListener('visibilitychange', onVisibility);
    reduce.addEventListener('change', onMotion);

    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      io.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      reduce.removeEventListener('change', onMotion);
    };
  }, [density]);

  return (
    <div className={`${s.figureWrap} ${className ?? ''}`}>
      <canvas ref={ref} className={s.figureCanvas} role="img" aria-label={label} />
    </div>
  );
}
