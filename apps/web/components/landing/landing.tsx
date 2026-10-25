'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { LogoMark } from '@/components/brand';
import { createPlanet, type PlanetState } from './planet';
import s from './landing.module.css';

const SECTIONS = [
  { id: 'start', label: 'Start' },
  { id: 'gaps', label: 'What goes wrong' },
  { id: 'get-started', label: 'Get started' },
  { id: 'inside', label: 'Inside a review' },
] as const;

/** Where the Earth sits for each full-screen section, as in the reference video. */
function frames(w: number, h: number): PlanetState[] {
  if (w < 900) {
    return [
      { x: w * 0.5, y: h * 0.42, r: w * 0.62, sx: 0, sy: 1, sz: 0.18 },
      { x: w * 1.05, y: h * 0.18, r: w * 0.55, sx: -0.6, sy: 0.4, sz: 0.7 },
      { x: w * -0.05, y: h * 0.2, r: w * 0.7, sx: -0.7, sy: 0.3, sz: 0.65 },
      { x: w * 0.5, y: -h * 1.05, r: w * 1.6, sx: 0, sy: 0.3, sz: 0.9 },
    ];
  }
  return [
    { x: w * 0.5, y: h * 0.74, r: Math.min(w * 0.29, h * 0.6), sx: 0, sy: 1, sz: 0.04 },
    { x: w * 1.02, y: h * 0.55, r: h * 0.5, sx: -0.6, sy: 0.4, sz: 0.7 },
    { x: w * 0.04, y: h * 0.58, r: h * 0.85, sx: -0.7, sy: 0.3, sz: 0.65 },
    { x: w * 0.5, y: -h * 1.2, r: w * 1.15, sx: 0, sy: 0.3, sz: 0.9 },
  ];
}

export function Landing() {
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [current, setCurrent] = useState(0);
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set(['start']));

  // The Earth follows the scroll position between section frames.
  useEffect(() => {
    const page = pageRef.current;
    const canvas = canvasRef.current;
    if (!page || !canvas) return;
    const planet = createPlanet(canvas);
    const place = () => {
      const w = page.clientWidth;
      const h = page.clientHeight;
      const f = frames(w, h);
      const y = page.scrollTop / h;
      const i = Math.max(0, Math.min(f.length - 1, Math.floor(y)));
      const t = Math.min(1, Math.max(0, y - i));
      const a = f[i]!;
      const b = f[Math.min(f.length - 1, i + 1)]!;
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const mix = (k: keyof PlanetState) => a[k] + (b[k] - a[k]) * e;
      planet.set({ x: mix('x'), y: mix('y'), r: mix('r'), sx: mix('sx'), sy: mix('sy'), sz: mix('sz') });
      setCurrent(Math.round(y));
    };
    place();
    page.addEventListener('scroll', place, { passive: true });
    window.addEventListener('resize', place);
    return () => {
      page.removeEventListener('scroll', place);
      window.removeEventListener('resize', place);
      planet.dispose();
    };
  }, []);

  // Each section's text reveals in sequence the first time it arrives.
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const io = new IntersectionObserver(
      (entries) => {
        const arrived = entries.filter((e) => e.isIntersecting).map((e) => e.target.id);
        if (arrived.length) setRevealed((prev) => new Set([...prev, ...arrived]));
      },
      { root: page, threshold: 0.35 }
    );
    page.querySelectorAll('section').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  const inView = (id: string) => (revealed.has(id) ? 'true' : undefined);

  return (
    <div ref={pageRef} className={s.page}>
      <canvas ref={canvasRef} className={s.planet} aria-hidden="true" />

      <header className={s.bar}>
        <Link className={s.word} href="/" aria-label="SpecFix home">
          <LogoMark size={26} />
          <span>
            SPEC<b>F</b>IX
          </span>
        </Link>
        <div className={s.barEnd}>
          <nav className={s.dots} aria-label="Sections">
            {SECTIONS.map((sec, i) => (
              <a key={sec.id} href={`#${sec.id}`} aria-label={sec.label} aria-current={i === current ? 'true' : undefined} />
            ))}
          </nav>
          <Link className={s.signin} href="/login">
            Sign in
          </Link>
        </div>
      </header>

      <main id="main">
        <section className={`${s.section} ${s.hero}`} id="start" aria-labelledby="hero-h" data-in={inView('start')}>
          <p className={s.over}>Requirements review for product teams</p>
          <h1 id="hero-h">Catch what a ticket leaves unsaid, before anyone builds it</h1>
          <nav className={s.heroNav} aria-label="Page">
            <a href="#gaps">How it works</a>
            <a href="#gaps">Blind-first review</a>
            <a href="#inside">Flags</a>
            <a href="#inside">Gherkin specs</a>
            <a href="#inside">Audit trail</a>
            <Link href="/login">Sign in</Link>
          </nav>
          <a className={s.cue} href="#gaps">
            3 ways a ticket goes wrong
            <svg width="14" height="16" viewBox="0 0 14 16" fill="none" stroke="#fff" strokeWidth="1.4" aria-hidden="true">
              <path d="M7 1v13M1 9l6 6 6-6" />
            </svg>
          </a>
        </section>

        <section className={`${s.section} ${s.problems}`} id="gaps" aria-labelledby="gaps-h" data-in={inView('gaps')}>
          <h2 id="gaps-h" className={`${s.h2} ${s.rv}`}>
            SpecFix finds the gaps a ticket hides
          </h2>
          <div className={s.cols}>
            <Problem
              title="Vague language"
              problem="“Fast”, “generous”, “normal usage”. Words every reader fills in differently."
              fix="Flags"
              verb="fix this"
              answer="Each unclear phrase is quoted from the ticket, explained, and turned into one question for the PM."
              delays={[s.d1, s.d2]}
            />
            <Problem
              title="Missing information"
              problem="No limit, no status code, no owner. A developer fills the hole with a guess."
              fix="Blind-first review"
              verb="fixes this"
              answer="You write your own gaps before the model’s are shown, so its output never anchors you."
              delays={[s.d3, s.d4]}
            />
            <Problem
              title="Untestable criteria"
              problem="“Does not slow down requests” is a criterion no test can ever fail."
              fix="Gherkin specs"
              verb="fix this"
              answer="Approved criteria become scenarios and Playwright scaffolds that a person signs off."
              delays={[s.d5, s.d6]}
            />
          </div>
        </section>

        <section className={`${s.section} ${s.cta}`} id="get-started" aria-labelledby="cta-h" data-in={inView('get-started')}>
          <div className={s.ctaBox}>
            <h2 id="cta-h" className={`${s.h2} ${s.rv}`}>
              Send tickets to development with nothing left to guess
            </h2>
            <p className={`${s.rv} ${s.d1}`}>
              Decide each flag, accept or rewrite its question for the PM, and mark the ticket ready.
              Every decision stays in the audit trail.
            </p>
            <div className={`${s.btns} ${s.rv} ${s.d2}`}>
              <Link className={`${s.btn} ${s.solid}`} href="/login">
                Sign in
              </Link>
              <a className={`${s.btn} ${s.line}`} href="#inside">
                See a review
              </a>
            </div>
          </div>
        </section>

        <section className={`${s.section} ${s.inside}`} id="inside" aria-labelledby="inside-h" data-in={inView('inside')}>
          <h2 id="inside-h" className={`${s.h2} ${s.rv}`}>
            Inside a SpecFix review
          </h2>
          <div className={s.track}>
            <figure className={`${s.card} ${s.rv} ${s.d1}`}>
              <div className={s.shot} aria-hidden="true">
                <span className={s.flagRow}>
                  <span className={s.sevDot} />
                  High · Untestable<span className={s.tag}>Open</span>
                </span>
                <b className={s.flagTitle}>“Does not slow down normal requests” has no latency budget</b>
                <q className={s.flagQuote}>Rate limiting does not slow down normal requests</q>
              </div>
              <h3>A flag, quoted from the ticket</h3>
              <p>Severity, category and the exact words</p>
            </figure>
            <figure className={`${s.card} ${s.rv} ${s.d2}`}>
              <div className={`${s.shot} ${s.rec}`} aria-hidden="true">
                <span>No number for the limit</span><i /><span>F1 Missing info</span>
                <span>Which status code?</span><i /><span>F3 Missing info</span>
                <span>Per key or per IP?</span><i /><span>F5 Edge case</span>
                <span className={s.solo}>Internal services exempt?</span><i className={s.none} /><span className={s.solo}>F2 Untestable</span>
              </div>
              <h3>Your gaps against the model’s</h3>
              <p>Written blind, linked after lock</p>
            </figure>
            <figure className={`${s.card} ${s.rv} ${s.d3}`}>
              <div className={`${s.shot} ${s.gherkin}`} aria-hidden="true">
                <b>Scenario:</b> Over the limit{'\n  '}
                <b>Given</b> key &quot;partner-a&quot; has used 600{'\n        '}requests this minute{'\n  '}
                <b>When</b> it sends one more request{'\n  '}
                <b>Then</b> the response status is 429{'\n  '}
                <b>And</b> &quot;Retry-After&quot; is set
              </div>
              <h3>Gherkin from approved criteria</h3>
              <p>Scaffolds use placeholder selectors</p>
            </figure>
            <figure className={`${s.card} ${s.rv} ${s.d4}`}>
              <div className={`${s.shot} ${s.log}`} aria-hidden="true">
                <div><span>14:19</span>Edited F3 · 429 + Retry-After</div>
                <div><span>14:11</span>Accepted F1 · limit and window</div>
                <div><span>14:02</span>Locked 4 gaps · 6 flags shown</div>
                <div><span>13:51</span>Started blind review</div>
              </div>
              <h3>The audit trail</h3>
              <p>Every decision, in UTC</p>
            </figure>
          </div>
          <div className={s.join}>
            <h3>New to SpecFix?</h3>
            <p>For product and QA teams who review tickets before sprint planning. Create an account with your work email.</p>
            <Link className={`${s.btn} ${s.line}`} href="/login">
              Create an account
            </Link>
          </div>
          <footer className={s.foot}>
            <span>SpecFix · ambiguity and gap detection for product requirements</span>
            <span>© 2026</span>
          </footer>
        </section>
      </main>
    </div>
  );
}

function Problem({
  title,
  problem,
  fix,
  verb,
  answer,
  delays,
}: {
  title: string;
  problem: string;
  fix: string;
  verb: string;
  answer: string;
  delays: [string | undefined, string | undefined];
}) {
  const [first, second] = delays;
  return (
    <div>
      <h3 className={`${s.rv} ${first}`}>{title}</h3>
      <p className={`${s.rv} ${first}`}>{problem}</p>
      <svg className={`${s.arrow} ${s.rv} ${second}`} width="12" height="14" viewBox="0 0 12 14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
        <path d="M6 1v11M1 8l5 5 5-5" />
      </svg>
      <h4 className={`${s.rv} ${second}`}>
        {fix} <span>{verb}</span>
      </h4>
      <p className={`${s.rv} ${second}`}>{answer}</p>
    </div>
  );
}
