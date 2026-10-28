'use client';

import { useEffect, useRef } from 'react';
import { MARK } from './logo-paths';
import s from './playground.module.css';

/**
 * What the dots build, in order: the SF mark (traced from the logo), a code-style ticket naming
 * the team, a flag, the sign-off tick, then a sphere and a knot.
 */
const FORMS = ['mark', 'ticket', 'flag', 'check', 'sphere', 'knot'] as const;
type FormId = (typeof FORMS)[number];

const TAU = Math.PI * 2;

// The ticket is drawn on a 340×440 canvas, which rasterPoints maps to [-1, 1] around its centre.
const TICKET = { w: 340, h: 440 };
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const NAME_FONT = `900 30px ${MONO}`;
const NAME_X = 134;
const NAME_Y = [180, 232, 284];
const ROLES = ['lead:', 'dev:', 'qa:'];
const TEAM = ['raghav', 'udit', 'shrikant'];
// The values drawn glyph by glyph, densely: the names, then the status that lands last.
const VALUES = [
  ...TEAM.map((name, r) => ({ text: `"${name}"`, x: NAME_X, y: NAME_Y[r]! })),
  { text: '"resolved"', x: 144, y: 388 },
];
const SCRAMBLE = '01{}<>/#$%&*@=+?';
/** A random code character, for text that is still decoding. */
const noise = () => SCRAMBLE[Math.floor(Math.random() * SCRAMBLE.length)]!;
/** The line under each form; the opening mark speaks for itself. */
const CAPTIONS: Record<FormId, string> = {
  mark: '',
  ticket: 'team names',
  flag: 'flag ticket',
  check: 'ticket resolved',
  sphere: 'connect all the team',
  knot: 'team integration',
};

type Cell = { ch: string; row: number; col: number; x: number; y: number };
let cellCache: Cell[] | null = null;

/** One cell per character of each quoted value, at its place on the ticket canvas. */
function teamLayout(n: number) {
  if (!cellCache) {
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx) ctx.font = NAME_FONT;
    const cw = ctx?.measureText('M').width ?? 18;
    cellCache = VALUES.flatMap(({ text, x, y }, row) =>
      [...text].map((ch, col) => ({ ch, row, col, x: x + col * cw, y }))
    );
  }
  // The values take the last dots, a fixed share per character, so every letter stays dense.
  const k = Math.max(50, Math.floor(n * 0.014));
  return { cells: cellCache, k, base: n - cellCache.length * k };
}

const glyphCache = new Map<string, [number, number][]>();

/** A character's filled pixels, as offsets from where fillText draws it. */
function glyph(ch: string) {
  let pts = glyphCache.get(ch);
  if (!pts) {
    pts = rasterPoints(
      (ctx) => {
        ctx.font = NAME_FONT;
        ctx.textBaseline = 'middle';
        ctx.fillText(ch, 2, 22);
      },
      44,
      44
    ).map(([x, y]): [number, number] => [x * 22 + 20, y * 22]);
    if (!pts.length) pts = [[0, 0]];
    glyphCache.set(ch, pts);
  }
  return pts;
}

/** Writes `ch` into k dots of a shape from index i0, keeping their depth. */
function placeGlyph(out: Float32Array, i0: number, k: number, cell: Cell, ch: string) {
  const pts = glyph(ch);
  const half = TICKET.h / 2;
  for (let j = 0; j < k; j++) {
    const [gx, gy] = pts[(j * 37 + cell.col * 11) % pts.length]!;
    // A sub-pixel nudge so dots that share a pixel don't stack.
    out[(i0 + j) * 3] = (cell.x + gx + ((j * 0.618) % 1) - 0.5 - TICKET.w / 2) / half;
    out[(i0 + j) * 3 + 1] = (cell.y + gy + ((j * 0.382) % 1) - 0.5 - half) / half;
  }
}

/** The ticket's page edge, drawn apart from the text so it can take only a small share of dots. */
function drawTicketEdge(ctx: CanvasRenderingContext2D) {
  ctx.lineWidth = 2;
  ctx.strokeRect(16, 16, 308, 408);
}

/** The ticket's text without the names: a small code block crediting the team. */
function drawTicketText(ctx: CanvasRenderingContext2D) {
  ctx.textBaseline = 'middle';
  // Monospace fonts top out at bold, so a stroke thickens the strokes enough to hold in dots.
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  const write = (text: string, x: number, y: number) => {
    ctx.fillText(text, x, y);
    ctx.strokeText(text, x, y);
  };
  ctx.font = `900 24px ${MONO}`;
  write('SF-042 · ticket', 40, 56);
  ctx.fillRect(40, 82, 260, 2);
  ctx.font = `900 26px ${MONO}`;
  write('team = {', 40, 124);
  write('}', 40, 336);
  ctx.font = `900 24px ${MONO}`;
  ROLES.forEach((role, r) => write(role, 50, NAME_Y[r]!));
  write('status:', 40, 388);
}

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
      // Extruded: most dots on the two faces, the rest through the depth for the side walls. Kept
      // shallow, since deeper faces split into two ghosted marks as it turns.
      const z = rand() < 0.85 ? (rand() < 0.5 ? -0.04 : 0.04) : (rand() - 0.5) * 0.08;
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
    // A ticket page written as code, crediting the team; the names are placed glyph by glyph.
    const { cells, k, base } = teamLayout(n);
    const edge = rasterPoints(drawTicketEdge, TICKET.w, TICKET.h);
    const text = rasterPoints(drawTicketText, TICKET.w, TICKET.h);
    for (let i = 0; i < n; i++) {
      // The edge gets a small share, so the labels keep most of the dots.
      const pts = i < base * 0.12 ? edge : text;
      const [x, y] = i < base ? (pts[Math.floor(rand() * pts.length)] ?? [0, 0]) : [0, 0];
      put(i, x, y, (rand() - 0.5) * 0.05);
    }
    cells.forEach((c, j) => placeGlyph(out, base + j * k, k, c, c.ch));
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
 * A dense field of ink dots that builds SpecFix's forms: the SF mark, a ticket that prints top
 * to bottom and decodes the team's names, a sphere and a knot. The dots assemble out of a dust
 * cloud on load and rebuild in a left-to-right wave on every change. It is interactive: drag to
 * turn it, move the cursor to push dots aside, click to scatter them and watch them spring back,
 * and it moves on to the next form by itself. It reads its ink from the CSS `color`, pauses off
 * screen, and under reduced motion draws one still frame.
 */
export function ParticleFigure({
  speed,
  intensity,
  density = 0.9,
  className,
  label,
  captions = false,
}: {
  /** Motion multiplier: 1 is the default pace. */
  speed: number;
  /** 0–1: how strongly the dots react to the cursor and clicks. */
  intensity: number;
  /** 0.3–1: share of the full dot count. */
  density?: number;
  className?: string;
  label: string;
  /** Show the decoding line naming each form, under the figure. */
  captions?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ speed, intensity });
  live.current = { speed, intensity };
  const formRef = useRef(0);
  const captionRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const n = Math.round(11000 * Math.min(1, Math.max(0.3, density)));
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

    // The ticket's names decode: each character cycles through code glyphs, then locks in.
    const ticket = shapes[FORMS.indexOf('ticket')]!;
    const team = teamLayout(n);
    const lockAt = new Float64Array(team.cells.length);
    const locked = new Uint8Array(team.cells.length);
    // -1 idle, 0 decoding, otherwise when the last name locked.
    let decoded = -1;
    // 0–1: how much heavier the dots draw, eased in while the SF mark is up so its broad
    // shapes read solid rather than speckled.
    let heavy = 0;
    const finishDecode = () => {
      team.cells.forEach((c, j) => placeGlyph(ticket, team.base + j * team.k, team.k, c, c.ch));
      decoded = -1;
    };
    const startDecode = (now: number) => {
      const sp = live.current.speed;
      team.cells.forEach((c, j) => {
        // The code runs for a beat once the page has printed, then the names land row by row.
        lockAt[j] = now + morphMs() + (1300 + c.row * 380 + c.col * 70) / sp;
        locked[j] = 0;
      });
      decoded = 0;
    };
    const stepDecode = (now: number) => {
      let done = true;
      team.cells.forEach((c, j) => {
        const i0 = team.base + j * team.k;
        if (now < lockAt[j]!) {
          done = false;
          if (Math.random() < 0.25) placeGlyph(ticket, i0, team.k, c, noise());
        } else if (!locked[j]) {
          locked[j] = 1;
          placeGlyph(ticket, i0, team.k, c, c.ch);
          // A small hop as each letter lands.
          for (let d = i0; d < i0 + team.k; d++)
            vel[d * 2 + 1] = vel[d * 2 + 1]! - 2 - Math.random() * 2;
        }
      });
      if (done) decoded = now;
    };

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
    // A wave: dots on the left set off first; each also carries a little random lag. The ticket
    // prints instead, top to bottom.
    const progressOf = (i: number, now: number) => {
      const printing = to === ticket;
      const xs = (to[i * 3 + (printing ? 1 : 0)]! + 1.2) / 2.4;
      const t = (now - morphStart) / morphMs();
      const delay = 0.45 * (printing ? 0.85 * xs + 0.15 * lag[i]! : 0.65 * xs + 0.35 * lag[i]!);
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

    // The caption decodes like the names: random code characters settling left to right.
    let captionTimer = 0;
    const showCaption = () => {
      const el = captionRef.current;
      if (!el) return;
      clearInterval(captionTimer);
      const text = CAPTIONS[FORMS[formRef.current]!];
      if (reduce.matches || !text) {
        el.textContent = text;
        return;
      }
      const t0 = performance.now();
      const settle = (i: number) => 250 + i * 45;
      captionTimer = window.setInterval(() => {
        const t = performance.now() - t0;
        el.textContent = [...text]
          .map((ch, i) => (ch === ' ' || t > settle(i) ? ch : noise()))
          .join('');
        if (t > settle(text.length)) clearInterval(captionTimer);
      }, 40);
    };

    const goto = (i: number) => {
      const next = ((i % FORMS.length) + FORMS.length) % FORMS.length;
      const now = performance.now();
      // Start from wherever the dots are now, mid-morph included.
      from = reduce.matches ? shapes[next]! : current(now);
      if (decoded === 0) finishDecode();
      decoded = -1;
      to = shapes[next]!;
      formRef.current = next;
      morphStart = reduce.matches ? -1 : now;
      lastChange = now;
      if (to === ticket && !reduce.matches) startDecode(now);
      showCaption();
      if (reduce.matches) draw(now);
      start();
    };

    function draw(now: number) {
      const dt = Math.min(48, now - last) / 16.67;
      last = now;
      const { speed: sp, intensity: k } = live.current;
      const still = reduce.matches;

      if (decoded === 0) {
        if (still) finishDecode();
        else stepDecode(now);
      }
      // The ticket moves on soon after its names land; every other form holds a while.
      const held =
        decoded > 0 ? now - decoded > 1400 / sp : decoded < 0 && now - lastChange > 7200 / sp;
      if (!still && morphStart < 0 && held && now - lastTouch > 9000) {
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
      // Text and the logo read best face on, so they sway less.
      const flat = to === ticket ? 0.25 : to === shapes[0] ? 0.4 : 1;
      const idleYaw = still ? 0 : Math.sin(now * 0.00045 * sp) * 0.42 * flat;
      const idlePitch = still ? 0 : Math.sin(now * 0.00031 * sp) * 0.12 * flat;
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
      heavy += ((to === shapes[0] ? 1 : 0) - heavy) * Math.min(1, 0.06 * dt);
      // Every figure keeps all its dots and shrinks them with its size, so a small one (the login
      // panel, a phone) is the landing hero scaled down: same tone, same detail, names still legible.
      const zoom = Math.min(1, Math.max(0.6, scale / 248));
      // One fillStyle per shade keeps thousands of dots cheap.
      for (let b = 0; b < SHADES; b++) {
        const depth = (b + 0.5) / SHADES;
        const size = (1.1 + 0.9 * depth) * (1 + 0.5 * heavy) * zoom;
        ctx!.fillStyle = `rgba(${ink},${(0.65 + 0.3 * depth + 0.05 * heavy).toFixed(3)})`;
        for (let i = 0; i < n; i++) {
          if (shade[i] !== b) continue;
          ctx!.fillRect(pos[i * 2]! - size / 2, pos[i * 2 + 1]! - size / 2, size, size);
        }
      }

      // The print head: a line running down the ticket just where its dots are landing. It solves
      // the ticket delay in progressOf for the row at half progress; change the two together.
      if (morphing && to === ticket) {
        const ys = ((now - morphStart) / morphMs() - 0.275) / 0.45 / 0.85 - 0.075 / 0.85;
        if (ys > 0 && ys < 1) {
          const y = ys * 2.4 - 1.2;
          ctx!.fillStyle = `rgba(${ink},0.9)`;
          for (let x = -0.78; x <= 0.78; x += 0.012) {
            const rz2 = y * spch + x * sa * cp;
            const persp = 2.8 / (2.8 + rz2);
            const bx = cx + x * ca * scale * persp * breathe;
            const by = cy + (y * cp - x * sa * spch) * scale * persp * breathe;
            ctx!.fillRect(bx - 0.8, by - 0.8, 1.6, 1.6);
          }
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
    if (to === ticket && !reduce.matches) startDecode(performance.now());
    showCaption();
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
      clearInterval(captionTimer);
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
    <div className={className}>
      <canvas ref={ref} className={s.figureCanvas} role="img" aria-label={label} />
      {captions ? <span ref={captionRef} className={s.figureCaption} aria-hidden="true" /> : null}
    </div>
  );
}
