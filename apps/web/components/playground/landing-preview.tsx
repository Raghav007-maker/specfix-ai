'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Copy,
  ListChecks,
  Lock,
  SquareDashed,
  Unlock,
  UserCheck,
} from 'lucide-react';
import type { Settings } from './settings';
import { Logo } from './logo';
import { ParticleFigure } from './particles';
import { DotField } from './dot-field';
import { HighlightedCode } from './code-highlight';
import { useInView, useTyped } from './motion';
import { WORDMARK } from './logo-paths';
import s from './playground.module.css';

type Go = (preview: 'login', mode?: 'sign-in' | 'sign-up') => void;

/** The blocks that rise into view as the page scrolls; headlines inside them go line by line. */
const REVEAL = [
  s.sectionHead,
  s.flowHead,
  s.flowBody,
  s.specsCopy,
  s.codeCard,
  s.closing,
  s.dotWord,
  s.footRow,
]
  .map((c) => `.${c}`)
  .join(', ');

/**
 * Scroll motion for the landing page: blocks rise in as they reach the viewport, the six flag
 * cards follow one after another, and the hero figure drifts a little against the scroll. Works
 * whether the page or the playground frame is the scroller. Nothing is hidden until scripts have
 * armed it, and reduced motion leaves everything in place.
 */
function useScrollMotion(deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const targets = [
      ...root.querySelectorAll<HTMLElement>(REVEAL),
      ...root.querySelectorAll<HTMLElement>(`.${s.figGrid} > li`),
    ];
    targets.forEach((el, i) => {
      el.dataset.reveal = '';
      if (el.matches(`.${s.figGrid} > li`)) el.style.setProperty('--rd', `${(i % 3) * 110}ms`);
    });
    root.dataset.armed = 'true';
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          (e.target as HTMLElement).dataset.shown = 'true';
          io.unobserve(e.target);
        }
      },
      { threshold: 0.18 }
    );
    targets.forEach((el) => io.observe(el));

    const scroller =
      root.closest<HTMLElement>('[data-pg-scroll]') ?? (document.scrollingElement as HTMLElement);
    const art = root.querySelector<HTMLElement>(`.${s.heroArt}`);
    const onScroll = () => {
      const y = scroller === document.scrollingElement ? window.scrollY : scroller.scrollTop;
      art?.style.setProperty('--pg-par', `${Math.min(160, y * 0.18).toFixed(1)}px`);
    };
    const source: HTMLElement | Window = scroller === document.scrollingElement ? window : scroller;
    source.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      io.disconnect();
      source.removeEventListener('scroll', onScroll);
      delete root.dataset.armed;
      targets.forEach((el) => {
        delete el.dataset.reveal;
        delete el.dataset.shown;
      });
    };
    // Re-run when sections are toggled, so new blocks get the motion too.
  }, deps);
  return ref;
}

/**
 * Scroll the preview frame to a section, below the sticky bar. Only the frame scrolls: the page
 * itself and its URL stay put, which scrollIntoView would not guarantee.
 */
function jump(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  // In the playground the frame scrolls; on the real landing page the document does.
  const frame =
    el.closest<HTMLElement>('[data-pg-scroll]') ?? (document.scrollingElement as HTMLElement);
  const bar =
    el.closest('[data-pg-preview]')?.querySelector('header')?.getBoundingClientRect().height ?? 0;
  const frameTop = frame === document.scrollingElement ? 0 : frame.getBoundingClientRect().top;
  const top =
    el.getBoundingClientRect().top - frameTop + frame.scrollTop - (id === 'pg-top' ? 0 : bar);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  frame.scrollTo({ top: Math.max(0, top), behavior: reduce ? 'auto' : 'smooth' });
}

function Label({ children }: { children: ReactNode }) {
  return (
    <p className={s.sectionLabel} aria-hidden="true">
      [ {children} ]
    </p>
  );
}

/**
 * The landing page, redesigned after the reference video. Section order: hero, the six ways a
 * ticket goes wrong, the reviewed path from ticket to ready, approved criteria as specs, and a
 * closing call to action. The reference's customer-logo strip is deliberately absent, as are its
 * performance figures: SpecFix has neither to show.
 */
export function LandingPreview({ settings, go }: { settings: Settings; go: Go }) {
  const q = settings.tweaks;
  const b = settings.brand;
  const heroCta = q.ctaPlacement !== 'closing';
  const closingCta = q.ctaPlacement !== 'hero';

  const links = [
    { id: 'pg-figures', label: 'What it catches', show: q.showFigures },
    { id: 'pg-flow', label: 'How a review runs', show: q.showFlow },
    { id: 'pg-specs', label: 'Specs', show: q.showSpecs },
  ].filter((l) => l.show);
  const rootRef = useScrollMotion([q.showFigures, q.showFlow, q.showSpecs, q.showClosing]);

  return (
    <div className={s.landing} ref={rootRef}>
      <header className={s.lNav}>
        <div className={s.lNavInner}>
          <a
            href="#pg-top"
            className={s.logoLink}
            onClick={(e) => {
              e.preventDefault();
              jump('pg-top');
            }}
          >
            <Logo
              variant={b.logoVariant}
              size={b.logoSize}
              animation={b.logoAnimation}
              loop={b.logoLoop}
            />
          </a>
          <nav aria-label="Sections" className={s.lLinks}>
            {links.map((l) => (
              <a
                key={l.id}
                href={`#${l.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  jump(l.id);
                }}
              >
                {l.label}
              </a>
            ))}
          </nav>
          <div className={s.lNavEnd}>
            <button type="button" className={s.textBtn} onClick={() => go('login', 'sign-in')}>
              Sign in
            </button>
            <button
              type="button"
              className={`${s.btn} ${s.btnSolid} ${s.btnPill}`}
              onClick={() => go('login', 'sign-up')}
            >
              Get started
            </button>
          </div>
        </div>
      </header>

      <main>
        <section id="pg-top" className={s.hero} aria-labelledby="pg-hero-h">
          <div className={s.heroCopy}>
            <Label>Requirements review / for product teams</Label>
            <h1 id="pg-hero-h" className={s.display}>
              <span>Catch what a ticket leaves unsaid.</span>{' '}
              <span className={s.voice}>Before anyone builds it.</span>
            </h1>
            <p className={s.lead}>
              SpecFix reads each ticket for vague language, missing information and criteria no test
              could fail, then hands every flag to a person to decide.
            </p>
            {heroCta ? (
              <div className={s.ctaRow}>
                <button
                  type="button"
                  className={`${s.btn} ${s.btnSolid}`}
                  onClick={() => go('login', 'sign-in')}
                >
                  Sign in <ArrowUpRight aria-hidden size={16} strokeWidth={1.75} />
                </button>
                {q.showFlow ? (
                  <a
                    className={`${s.btn} ${s.btnLine}`}
                    href="#pg-flow"
                    onClick={(e) => {
                      e.preventDefault();
                      jump('pg-flow');
                    }}
                  >
                    See a review <ArrowRight aria-hidden size={16} strokeWidth={1.75} />
                  </a>
                ) : null}
              </div>
            ) : null}
            <dl className={s.facts}>
              <div>
                <dt>Input</dt>
                <dd>Ticket text and criteria</dd>
              </div>
              <div>
                <dt>Output</dt>
                <dd>Flags, quoted from the ticket</dd>
              </div>
              <div>
                <dt>Decision</dt>
                <dd>Always a person’s</dd>
              </div>
            </dl>
          </div>

          <div className={s.heroArt}>
            {q.particles ? (
              <ParticleFigure
                className={s.figure}
                speed={b.motionSpeed}
                intensity={b.intensity / 100}
                density={b.dotDensity / 100}
                captions
                label="Animated dot figure: drag to turn it, click to scatter the dots."
              />
            ) : (
              <div className={s.figureOff} aria-hidden="true" />
            )}
            {q.terminal ? <ReviewLog /> : null}
          </div>
        </section>

        {q.showFigures ? <Figures /> : null}
        {q.showFlow ? <Flow speed={b.motionSpeed} /> : null}
        {q.showSpecs ? <Specs /> : null}

        {q.showClosing ? (
          <section className={s.closing} aria-labelledby="pg-close-h">
            <Label>Get started</Label>
            <h2 id="pg-close-h" className={s.display}>
              <span>Send tickets to development</span>{' '}
              <span className={s.voice}>with nothing left to guess.</span>
            </h2>
            <p className={s.lead}>
              Decide each flag, accept or rewrite its question for the PM, and mark the ticket
              ready. Every decision stays in the audit trail.
            </p>
            {closingCta ? (
              <div className={s.ctaRow}>
                <button
                  type="button"
                  className={`${s.btn} ${s.btnSolid}`}
                  onClick={() => go('login', 'sign-in')}
                >
                  Sign in <ArrowUpRight aria-hidden size={16} strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  className={`${s.btn} ${s.btnLine}`}
                  onClick={() => go('login', 'sign-up')}
                >
                  Create an account
                </button>
              </div>
            ) : null}
          </section>
        ) : null}
      </main>

      <footer className={s.lFoot}>
        {q.dotWordmark ? <DotWordmark /> : null}
        <div className={s.footRow}>
          <span>SpecFix · ambiguity and gap detection for product requirements</span>
          <span>© 2026</span>
          <a
            href="#pg-top"
            onClick={(e) => {
              e.preventDefault();
              jump('pg-top');
            }}
          >
            Back to top ↑
          </a>
        </div>
      </footer>
    </div>
  );
}

/** The illustrative review log over the figure: the landing's existing rate-limiting demo. */
function ReviewLog() {
  return (
    <figure className={s.term}>
      <figcaption className={s.termBar}>
        <span className={s.termDots} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        RATE-142 · review log
        <span className={s.termTag}>Illustrative</span>
      </figcaption>
      <ol className={s.termBody}>
        <li>
          <time>13:51</time> Started a blind review
        </li>
        <li>
          <time>14:02</time> Locked 4 gaps of your own
        </li>
        <li>
          <time>14:02</time> 6 flags shown · 2 removed by the Critic
        </li>
        <li>
          <time>14:11</time> <b>Accepted</b> F1 · limit and window
        </li>
        <li>
          <time>14:19</time> <b>Edited</b> F3 · 429 + Retry-After
        </li>
        <li className={s.termWait}>
          <time>—</time> 4 flags still open · waiting on you
          <span className={s.caret} aria-hidden="true" />
        </li>
      </ol>
    </figure>
  );
}

type Part = string | { mark: string };

const FLAG_CARDS: {
  key: string;
  tag: string;
  severity: 'High' | 'Medium';
  title: string;
  body: string;
  ticket: Part[];
  question: string;
}[] = [
  {
    key: 'missing',
    tag: 'Missing info',
    severity: 'High',
    title: 'Missing information',
    body: 'No limit, no window, no owner. A developer fills the hole with a guess.',
    ticket: ['Partners are ', { mark: 'rate limited' }, ' when they go over the limit.'],
    question: 'What is the limit, and over what time window?',
  },
  {
    key: 'vague',
    tag: 'Vague language',
    severity: 'High',
    title: 'Vague language',
    body: 'Words every reader fills in differently.',
    ticket: ['Partners get a ', { mark: 'generous limit for normal usage' }, '.'],
    question: 'Which number counts as generous, and what is normal usage?',
  },
  {
    key: 'contradiction',
    tag: 'Contradiction',
    severity: 'High',
    title: 'Contradictions',
    body: 'Two criteria that cannot both be true, found before someone picks one at random.',
    ticket: [
      'Rate limiting ',
      { mark: 'never blocks partner traffic' },
      '. Requests over the limit ',
      { mark: 'are rejected' },
      '.',
    ],
    question: 'Over the limit, is a partner’s request blocked or allowed?',
  },
  {
    key: 'edge',
    tag: 'Edge case',
    severity: 'Medium',
    title: 'Unhandled edge cases',
    body: 'The shared key, the burst at the window boundary, the request that retries.',
    ticket: ['The limit applies ', { mark: 'per partner' }, '.'],
    question: 'Per API key or per IP, and what happens to a burst at the boundary?',
  },
  {
    key: 'security',
    tag: 'Security / compliance',
    severity: 'High',
    title: 'Security and compliance',
    body: 'Who is exempt, what is logged, and what the ticket quietly assumes is allowed.',
    ticket: [{ mark: 'Internal services are exempt' }, ' from the limit.'],
    question: 'How is an internal service identified, and is the exemption logged?',
  },
  {
    key: 'untestable',
    tag: 'Untestable',
    severity: 'High',
    title: 'Untestable criteria',
    body: 'A criterion no test can ever fail.',
    ticket: ['Rate limiting ', { mark: 'does not slow down normal requests' }, '.'],
    question: 'What latency budget must normal requests stay within?',
  },
];

/**
 * The six flag categories, each shown as SpecFix shows a flag: the ticket's own words with the
 * flagged span highlighted, and the one question it puts to the PM. As each card scrolls into
 * view the highlight sweeps across the span and the question follows. The resting state, before
 * scripts run and under reduced motion, is the finished card.
 */
function Figures() {
  const ref = useRef<HTMLUListElement>(null);
  const [armed, setArmed] = useState(false);
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const list = ref.current;
    if (!list || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setArmed(true);
    const io = new IntersectionObserver(
      (entries) => {
        const shown = entries
          .filter((e) => e.isIntersecting)
          .map((e) => (e.target as HTMLElement).dataset.key!);
        if (shown.length) setSeen((prev) => new Set([...prev, ...shown]));
      },
      { threshold: 0.45 }
    );
    list.querySelectorAll('li').forEach((li) => io.observe(li));
    return () => io.disconnect();
  }, []);

  return (
    <section id="pg-figures" className={s.section} aria-labelledby="pg-fig-h">
      <div className={s.sectionHead}>
        <Label>What it catches</Label>
        <h2 id="pg-fig-h" className={s.display}>
          <span>Six ways a ticket goes wrong.</span>{' '}
          <span className={s.voice}>Each one quoted back to you.</span>
        </h2>
        <p className={s.lead}>
          Every flag carries its category, a severity, the exact words it is about, and one question
          for the PM. A person accepts, edits or dismisses it.
        </p>
      </div>
      <ul
        className={s.figGrid}
        ref={ref}
        data-armed={armed ? 'true' : undefined}
        onPointerMove={(e) => {
          // A soft spotlight follows the cursor inside the card it is over.
          const li = (e.target as HTMLElement).closest('li');
          if (!li) return;
          const r = li.getBoundingClientRect();
          li.style.setProperty('--mx', `${e.clientX - r.left}px`);
          li.style.setProperty('--my', `${e.clientY - r.top}px`);
        }}
      >
        {FLAG_CARDS.map((f, i) => (
          <li
            key={f.key}
            data-key={f.key}
            className={s.figCell}
            data-in={seen.has(f.key) ? 'true' : undefined}
            style={{ '--i': i % 3, '--row': Math.floor(i / 3) } as CSSProperties}
          >
            <div className={s.figMeta}>
              <span>F/{String(i + 1).padStart(2, '0')}</span>
              <span>{f.tag}</span>
              <span className={s.sev} data-sev={f.severity}>
                {f.severity}
              </span>
            </div>
            <figure className={s.excerpt}>
              <figcaption>The ticket says</figcaption>
              <blockquote>
                {f.ticket.map((part, j) =>
                  typeof part === 'string' ? (
                    <span key={j}>{part}</span>
                  ) : (
                    <mark key={j} className={s.flagMark}>
                      {part.mark}
                    </mark>
                  )
                )}
              </blockquote>
            </figure>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
            <p className={s.askPm}>
              <span>Question for the PM</span>
              {f.question}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

type Decision = 'open' | 'accepted' | 'edited' | 'dismissed';

const STAGES = [
  { id: 'ingest', name: 'Bring in the ticket', status: 'Captured' },
  { id: 'gaps', name: 'Write your gaps first', status: 'Blind' },
  { id: 'decide', name: 'Decide every flag', status: 'In review' },
  { id: 'signoff', name: 'Sign off', status: 'Waiting on you' },
  { id: 'specs', name: 'Generate specs', status: 'Draft' },
] as const;

const GAPS = [
  'No number for the limit',
  'Which status code?',
  'Per key or per IP?',
  'Internal services exempt?',
];

const FLAGS: {
  id: string;
  sev: string;
  cat: string;
  what: string;
  quote: string;
  gap: number | null;
}[] = [
  {
    id: 'F1',
    sev: 'High',
    cat: 'Missing info',
    what: 'The limit has no number or window',
    quote: 'a generous limit',
    gap: 0,
  },
  {
    id: 'F2',
    sev: 'High',
    cat: 'Untestable',
    what: '“Does not slow down” has no latency budget',
    quote: 'does not slow down normal requests',
    gap: null,
  },
  {
    id: 'F3',
    sev: 'Medium',
    cat: 'Missing info',
    what: 'No status code for rejected requests',
    quote: 'are rejected',
    gap: 1,
  },
];

/**
 * The reviewed path, after the reference's staged "connected flow" panel, built on SpecFix's own
 * rules: the model's flags stay hidden until the reviewer locks their own gap list, and only a
 * person decides a flag. While it is on screen it plays through the stages by itself; any click
 * or key hands control to the visitor. Autoplay never decides a flag, so sign-off waits on a
 * person, which is the point.
 *
 * The board sits on a dot field that ripples on every stage change, tilts a little toward the
 * cursor, and slides each stage in; a marker slides down the stage list and finished stages tick.
 */
function Flow({ speed }: { speed: number }) {
  const [stage, setStage] = useState(0);
  const [locked, setLocked] = useState(false);
  const [decisions, setDecisions] = useState<Decision[]>(['accepted', 'open', 'open']);
  const [auto, setAuto] = useState(false);
  const [inView, setInView] = useState(false);
  const [paused, setPaused] = useState(false);
  const [marker, setMarker] = useState<{ top: number; height: number } | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const base = useId();
  const interval = 6200 / speed;
  const playing = auto && inView && !paused;

  useEffect(() => {
    const el = sectionRef.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setAuto(true);
    const io = new IntersectionObserver(([e]) => setInView(Boolean(e?.isIntersecting)), {
      threshold: 0.4,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Autoplay: lock the gap list partway through stage 2, then move on.
  useEffect(() => {
    if (!playing) return;
    const timers = [setTimeout(() => setStage((n) => (n + 1) % STAGES.length), interval)];
    if (stage === 1 && !locked) timers.push(setTimeout(() => setLocked(true), interval * 0.45));
    return () => timers.forEach(clearTimeout);
  }, [playing, stage, locked, interval]);

  // The marker follows the active stage, measured so it fits any label length or layout.
  useEffect(() => {
    const place = () => {
      const tab = tabs.current[stage];
      if (tab) setMarker({ top: tab.offsetTop, height: tab.offsetHeight });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [stage]);

  const take = () => setAuto(false);
  const go = (i: number) => {
    take();
    setStage(i);
  };

  const onKey = (e: KeyboardEvent) => {
    const delta =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? 1
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? -1
          : 0;
    const to =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? STAGES.length - 1
          : delta
            ? (stage + delta + STAGES.length) % STAGES.length
            : -1;
    if (to < 0) return;
    e.preventDefault();
    go(to);
    tabs.current[to]?.focus();
  };

  // A gentle tilt toward the cursor.
  const onTilt = (e: PointerEvent<HTMLDivElement>) => {
    const el = boardRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--tx', `${(((e.clientY - r.top) / r.height - 0.5) * -3).toFixed(2)}deg`);
    el.style.setProperty('--ty', `${(((e.clientX - r.left) / r.width - 0.5) * 4).toFixed(2)}deg`);
  };
  const resetTilt = () => {
    boardRef.current?.style.setProperty('--tx', '0deg');
    boardRef.current?.style.setProperty('--ty', '0deg');
  };

  const current = STAGES[stage]!;
  const status = current.id === 'gaps' && locked ? 'Locked' : current.status;
  return (
    <section
      id="pg-flow"
      ref={sectionRef}
      className={`${s.section} ${s.flow}`}
      aria-labelledby="pg-flow-h"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className={s.flowHead}>
        <div>
          <Label>How a review runs</Label>
          <h2 id="pg-flow-h" className={s.display}>
            <span>From ticket to ready.</span> <span className={s.voice}>One reviewed path.</span>
          </h2>
        </div>
        <p className={s.lead}>
          You write your own gaps before the model’s flags are shown, so its output never anchors
          you. The model proposes, the Critic filters, and a person decides every flag.
        </p>
      </div>
      <div className={s.flowBody}>
        <div
          role="tablist"
          aria-label="Review stages"
          aria-orientation="vertical"
          className={s.stages}
          onKeyDown={onKey}
        >
          {marker ? (
            <span
              className={s.stageMarker}
              style={{ transform: `translateY(${marker.top}px)`, height: marker.height }}
              aria-hidden="true"
            />
          ) : null}
          {STAGES.map((st, i) => (
            <button
              key={st.id}
              ref={(el) => {
                tabs.current[i] = el;
              }}
              role="tab"
              id={`${base}-tab-${i}`}
              aria-selected={i === stage}
              aria-controls={`${base}-panel`}
              tabIndex={i === stage ? 0 : -1}
              className={s.stage}
              data-done={i < stage ? 'true' : undefined}
              onClick={() => go(i)}
            >
              <span className={s.stageNo}>
                {i < stage ? (
                  <svg viewBox="0 0 16 16" aria-hidden="true" className={s.tickDraw}>
                    <path d="M3.5 8.5l3 3 6-7" />
                  </svg>
                ) : (
                  String(i + 1).padStart(2, '0')
                )}
              </span>
              {st.name}
              {i === stage && auto ? (
                <span
                  key={`${stage}-${playing}`}
                  className={s.stageTimer}
                  data-run={playing ? 'true' : undefined}
                  style={{ animationDuration: `${interval}ms` }}
                  aria-hidden="true"
                />
              ) : null}
            </button>
          ))}
          <p className={s.stageHint}>
            {auto
              ? 'Playing · click or use arrow keys to take over'
              : 'Arrow keys move between stages'}
          </p>
        </div>

        <div
          ref={boardRef}
          role="tabpanel"
          id={`${base}-panel`}
          aria-labelledby={`${base}-tab-${stage}`}
          className={s.board}
          onClickCapture={take}
          onPointerMove={onTilt}
          onPointerLeave={resetTilt}
        >
          <div className={s.boardBar}>
            <span>
              Stage {String(stage + 1).padStart(2, '0')} / {current.name}
            </span>
            <span>RATE-142 · v3</span>
            <span>
              Status{' '}
              <b key={status} className={s.statusPop}>
                {status}
              </b>
            </span>
          </div>
          <div className={s.boardStage}>
            <DotField className={s.boardField} pulse={stage + 1} origin={{ x: 0, y: 0.1 }} />
            <div className={s.boardBody} key={current.id}>
              {current.id === 'ingest' ? <StageTicket /> : null}
              {current.id === 'gaps' ? (
                <StageGaps locked={locked} onLock={() => setLocked(true)} />
              ) : null}
              {current.id === 'decide' ? (
                locked ? (
                  <StageDecide decisions={decisions} setDecisions={setDecisions} />
                ) : (
                  <StageBlocked onBack={() => go(1)} />
                )
              ) : null}
              {current.id === 'signoff' ? (
                <StageSignoff decisions={decisions} locked={locked} />
              ) : null}
              {current.id === 'specs' ? <StageSpecs /> : null}
            </div>
          </div>
          <p className={s.boardNote}>
            Illustrative ticket, showing 3 of its 6 flags. Nothing here is saved.
          </p>
        </div>
      </div>
    </section>
  );
}

const TICKET_TEXT =
  'Partners are rate limited with a generous limit for normal usage. Rate limiting does not slow down normal requests. Internal services are exempt.';

function StageTicket() {
  const shown = useTyped(TICKET_TEXT, true, 95);
  const typing = shown < TICKET_TEXT.length;
  return (
    <div className={s.paper}>
      <p className={s.paperKey}>RATE-142 · version 3 captured 14:00</p>
      <h3>Rate-limit the partner API</h3>
      <p aria-label={TICKET_TEXT}>
        <span aria-hidden="true">
          {TICKET_TEXT.slice(0, shown)}
          {typing ? <span className={s.codeCaret} /> : null}
        </span>
      </p>
      <p className={s.paperAc} data-show={typing ? undefined : 'true'}>
        <b>Acceptance criteria</b>
        <br />– Requests over the limit are rejected
        <br />– Partners can see their remaining quota
      </p>
      <p className={s.lockLine}>Nothing from the model is shown to you yet.</p>
    </div>
  );
}

function StageGaps({ locked, onLock }: { locked: boolean; onLock: () => void }) {
  return (
    <div className={s.blind} data-locked={locked ? 'true' : undefined}>
      <div className={`${s.paper} ${s.typeIn}`}>
        <h3>Your gap list</h3>
        <p className={s.muted}>Written by you, before any model flag is shown.</p>
        <ol className={s.gapList}>
          {GAPS.map((g, i) => (
            <li
              key={g}
              style={{ '--i': i } as CSSProperties}
              data-linked={locked && FLAGS.some((f) => f.gap === i) ? 'true' : undefined}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" className={s.tickDraw}>
                <path d="M3.5 8.5l3 3 6-7" />
              </svg>
              {g}
            </li>
          ))}
        </ol>
        {locked ? (
          <p className={s.lockLine} role="status">
            <Lock aria-hidden size={14} strokeWidth={2} className={s.lockPop} /> Locked at 14:02 · 2
            of your gaps match a flag
          </p>
        ) : (
          <button type="button" className={`${s.btn} ${s.btnSolid} ${s.lockBtn}`} onClick={onLock}>
            <Lock aria-hidden size={15} strokeWidth={1.75} /> Lock my gap list
          </button>
        )}
      </div>
      <div className={s.vault}>
        <p className={s.vaultHead}>
          {locked ? (
            <Unlock aria-hidden size={14} className={s.lockPop} />
          ) : (
            <Lock aria-hidden size={14} />
          )}
          {locked
            ? 'Model flags · revealed after your lock'
            : 'Model flags · hidden until you lock'}
        </p>
        <ul aria-hidden={!locked}>
          {FLAGS.map((f, i) => (
            <li key={f.id} style={{ '--i': i } as CSSProperties}>
              <b>{f.id}</b> {f.what}
              <span>{f.gap === null ? 'New · not on your list' : `Matches gap ${f.gap + 1}`}</span>
            </li>
          ))}
        </ul>
        <p className={s.vaultFoot}>2 more removed by the Critic as false alarms</p>
      </div>
    </div>
  );
}

function StageBlocked({ onBack }: { onBack: () => void }) {
  return (
    <div className={s.paper}>
      <h3>
        <Lock aria-hidden size={18} className={s.lockPop} /> Your gap list comes first
      </h3>
      <p className={s.muted}>
        The model’s flags stay hidden until you lock your own list of gaps. That order keeps the
        comparison honest.
      </p>
      <button type="button" className={`${s.btn} ${s.btnLine}`} onClick={onBack}>
        Go to your gap list
      </button>
    </div>
  );
}

const STAMP: Record<Exclude<Decision, 'open'>, string> = {
  accepted: 'Accepted',
  edited: 'Edited',
  dismissed: 'Dismissed',
};

function StageDecide({
  decisions,
  setDecisions,
}: {
  decisions: Decision[];
  setDecisions: (d: Decision[]) => void;
}) {
  const set = (i: number, d: Decision) => setDecisions(decisions.map((x, j) => (j === i ? d : x)));
  return (
    <ul className={s.flagList}>
      {FLAGS.map((f, i) => {
        const d = decisions[i]!;
        return (
          <li
            key={f.id}
            className={s.flagItem}
            data-state={d}
            style={{ '--i': i } as CSSProperties}
          >
            <p className={s.flagMeta}>
              <span>{f.id}</span>
              <span>
                {f.sev} · {f.cat}
              </span>
              <span className={s.flagState}>{d === 'open' ? 'Open' : ''}</span>
            </p>
            {d !== 'open' ? (
              <span key={d} className={s.stamp} data-state={d}>
                {STAMP[d]}
              </span>
            ) : null}
            <p className={s.flagWhat}>{f.what}</p>
            <q className={s.figQuote}>{f.quote}</q>
            <div className={s.flagActions}>
              {d === 'open' ? (
                <>
                  <button
                    type="button"
                    className={`${s.btn} ${s.btnSolid} ${s.btnSm}`}
                    onClick={() => set(i, 'accepted')}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className={`${s.btn} ${s.btnLine} ${s.btnSm}`}
                    onClick={() => set(i, 'edited')}
                  >
                    Edit question
                  </button>
                  <button
                    type="button"
                    className={`${s.btn} ${s.btnGhost} ${s.btnSm}`}
                    onClick={() => set(i, 'dismissed')}
                  >
                    Dismiss
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className={`${s.btn} ${s.btnGhost} ${s.btnSm}`}
                  onClick={() => set(i, 'open')}
                >
                  Reopen
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function StageSignoff({ decisions, locked }: { decisions: Decision[]; locked: boolean }) {
  const open = decisions.filter((d) => d === 'open').length;
  const done = decisions.length - open;
  const [ready, setReady] = useState(false);
  return (
    <div className={s.paper}>
      <h3>
        {open === 0 ? 'Every flag is decided' : `${open} of ${decisions.length} flags still open`}
      </h3>
      <div
        className={s.meter}
        role="img"
        aria-label={`${done} of ${decisions.length} flags decided`}
      >
        {decisions.map((d, i) => (
          <span
            key={FLAGS[i]!.id}
            data-done={d !== 'open' ? 'true' : undefined}
            style={{ '--i': i } as CSSProperties}
          />
        ))}
      </div>
      <p className={s.muted}>
        {open === 0
          ? 'The PM marks the ticket ready for development. Every decision stays in the audit trail.'
          : 'Nothing is resolved for you. The ticket can be marked ready once a person has decided every flag.'}
      </p>
      <ul className={s.checks}>
        {decisions.map((d, i) => (
          <li key={FLAGS[i]!.id} data-done={d !== 'open'}>
            {FLAGS[i]!.id} · {d === 'open' ? 'waiting on a decision' : d}
          </li>
        ))}
      </ul>
      {ready && open === 0 ? (
        <p className={`${s.lockLine} ${s.readyLine}`} role="status">
          <svg viewBox="0 0 16 16" aria-hidden="true" className={s.tickDraw}>
            <path d="M3.5 8.5l3 3 6-7" />
          </svg>
          Marked ready for development · signed off by you
        </p>
      ) : (
        <button
          type="button"
          className={`${s.btn} ${s.btnSolid}`}
          data-pulse={open === 0 && locked ? 'true' : undefined}
          disabled={open > 0 || !locked}
          onClick={() => setReady(true)}
        >
          Mark ready for development
        </button>
      )}
    </div>
  );
}

const GHERKIN = `Scenario: Over the limit
  Given key "partner-a" has used 600 requests this minute
  When it sends one more request
  Then the response status is 429
  And "Retry-After" is set`;

const SCAFFOLD = `test('over the limit', async ({ page }) => {
  // Placeholder selectors: a person fills in the real ones.
  await page.goto('/');
  await page.locator('[data-testid="TODO-request"]').click();
  await expect(page.locator('[data-testid="TODO-status"]')).toHaveText('429');
});`;

function StageSpecs() {
  const shown = useTyped(GHERKIN, true, 110);
  return (
    <pre className={s.code} aria-label="Gherkin scenario">
      <HighlightedCode code={GHERKIN} lang="gherkin" shown={shown} />
    </pre>
  );
}

type SpecLink = 'approved' | 'reviewed' | 'placeholder';

const SPEC_POINTS: { key: SpecLink; title: string; body: string; icon: ReactNode }[] = [
  {
    key: 'approved',
    title: 'Only from approved criteria',
    body: 'Scenarios are written from what the PM signed off, not from the raw ticket.',
    icon: <ListChecks aria-hidden />,
  },
  {
    key: 'reviewed',
    title: 'Reviewed one by one',
    body: 'QA approves, edits or dismisses every generated scenario.',
    icon: <UserCheck aria-hidden />,
  },
  {
    key: 'placeholder',
    title: 'Placeholders stay placeholders',
    body: 'Playwright scaffolds use placeholder selectors. A person fills in the real ones.',
    icon: <SquareDashed aria-hidden />,
  },
];

/**
 * Approved criteria as specs. The code types out when it scrolls into view, with Gherkin keywords
 * and the scaffold's placeholder selectors marked. Each point on the left is tied to the code:
 * pointing at it (hover, focus or click) lights up the part of the code it is about.
 */
function Specs() {
  const [tab, setTab] = useState<'gherkin' | 'scaffold'>('gherkin');
  const [link, setLink] = useState<SpecLink | null>(null);
  const [pinned, setPinned] = useState<SpecLink | null>(null);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const cardRef = useRef<HTMLDivElement>(null);
  // A low threshold resets the code before the card's own reveal makes it visible.
  const seen = useInView(cardRef, 0.02);
  const text = tab === 'gherkin' ? GHERKIN : SCAFFOLD;
  const shown = useTyped(text, seen, 90);
  const active = link ?? pinned;

  useEffect(() => {
    if (copied === 'idle') return;
    const t = setTimeout(() => setCopied('idle'), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  const point = (k: SpecLink) => {
    setLink(k);
    if (k === 'placeholder') setTab('scaffold');
    if (k === 'approved') setTab('gherkin');
  };

  // Which lines each point lights up.
  const lineAttrs = (i: number) => ({
    'data-hl':
      (active === 'approved' && tab === 'gherkin' && i >= 3) ||
      (active === 'placeholder' && tab === 'scaffold' && (i === 3 || i === 4))
        ? 'true'
        : undefined,
  });

  return (
    <section id="pg-specs" className={`${s.section} ${s.specs}`} aria-labelledby="pg-specs-h">
      <div className={s.specsCopy}>
        <Label>Specs</Label>
        <h2 id="pg-specs-h" className={s.display}>
          <span>Approved criteria become specs.</span>{' '}
          <span className={s.voice}>A person signs each one.</span>
        </h2>
        <p className={s.lead}>
          Once the PM signs a ticket off, its disambiguated criteria feed test scenarios. Point at a
          rule to see where it shows in the code.
        </p>
        <ol className={s.points}>
          {SPEC_POINTS.map((p, i) => (
            <li key={p.key} style={{ '--i': i } as CSSProperties}>
              <button
                type="button"
                className={s.pointBtn}
                aria-pressed={pinned === p.key}
                data-active={active === p.key ? 'true' : undefined}
                onPointerEnter={() => point(p.key)}
                onPointerLeave={() => setLink(null)}
                onFocus={() => point(p.key)}
                onBlur={() => setLink(null)}
                onClick={() => setPinned((v) => (v === p.key ? null : p.key))}
              >
                <span className={s.pointIcon}>{p.icon}</span>
                <span>
                  <b>{p.title}</b>
                  <span>{p.body}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
      <div className={s.specsArt}>
        <DotField className={s.specsField} pulse={tab === 'gherkin' ? 1 : 2} gap={13} />
        <div className={s.codeCard} ref={cardRef} data-link={active ?? undefined}>
          <div className={s.codeBar}>
            <div role="tablist" aria-label="Spec format" className={s.codeTabs}>
              <button
                role="tab"
                aria-selected={tab === 'gherkin'}
                onClick={() => setTab('gherkin')}
              >
                Gherkin
              </button>
              <button
                role="tab"
                aria-selected={tab === 'scaffold'}
                onClick={() => setTab('scaffold')}
              >
                Playwright scaffold
              </button>
            </div>
            <button
              type="button"
              className={s.copyBtn}
              onClick={() =>
                navigator.clipboard.writeText(text).then(
                  () => setCopied('ok'),
                  () => setCopied('fail')
                )
              }
            >
              {copied === 'ok' ? <Check aria-hidden size={14} /> : <Copy aria-hidden size={14} />}
              {copied === 'ok' ? 'Copied' : copied === 'fail' ? 'Copy blocked' : 'Copy'}
            </button>
          </div>
          {active === 'reviewed' ? (
            <span className={s.qaBadge}>
              <UserCheck aria-hidden size={13} /> Approved by QA
            </span>
          ) : null}
          <pre
            className={s.code}
            role="tabpanel"
            tabIndex={0}
            aria-label={tab === 'gherkin' ? 'Gherkin scenario' : 'Playwright scaffold'}
          >
            <HighlightedCode
              code={text}
              lang={tab === 'gherkin' ? 'gherkin' : 'ts'}
              shown={shown}
              lineAttrs={lineAttrs}
            />
          </pre>
          <p className={s.codeFoot}>Illustrative output for the RATE-142 example</p>
          <span className={s.srOnly} role="status">
            {copied === 'ok'
              ? 'Copied to the clipboard'
              : copied === 'fail'
                ? 'The browser blocked the copy'
                : ''}
          </span>
        </div>
      </div>
    </section>
  );
}

/**
 * The closing wordmark as a dot matrix, after the reference's footer. The dots are sampled from
 * the traced SpecFix wordmark itself, so the letterforms are the supplied ones.
 */
function DotWordmark() {
  const [dots, setDots] = useState<{ x: number; y: number }[]>([]);
  const step = 3;
  useEffect(() => {
    const canvas = document.createElement('canvas');
    canvas.width = WORDMARK.width;
    canvas.height = WORDMARK.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fill(new Path2D(WORDMARK.d), 'evenodd');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const out: { x: number; y: number }[] = [];
    for (let y = step / 2; y < canvas.height; y += step) {
      for (let x = step / 2; x < canvas.width; x += step) {
        if (data[(Math.floor(y) * canvas.width + Math.floor(x)) * 4 + 3]! > 128) out.push({ x, y });
      }
    }
    setDots(out);
  }, []);
  return (
    <svg
      className={s.dotWord}
      viewBox={`0 0 ${WORDMARK.width} ${WORDMARK.height}`}
      role="img"
      aria-label="SpecFix"
    >
      {dots.map((d) => (
        <circle
          key={`${d.x}-${d.y}`}
          cx={d.x}
          cy={d.y}
          r={1.05}
          style={{ '--x': (d.x / WORDMARK.width).toFixed(3) } as CSSProperties}
        />
      ))}
    </svg>
  );
}
