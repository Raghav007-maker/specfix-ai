'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from 'react';
import { Building2, Check, Lock, Sparkles } from 'lucide-react';
import { FREE_PROJECT_LIMIT, PRO_PRICES } from '@specfix/shared/pricing';
import { UpiDialog, type PayActions, type UpiPay } from './upi-dialog';
import { useRazorpayCheckout } from './razorpay-checkout';
import s from './playground.module.css';
import x from './pricing.module.css';

type Audience = 'personal' | 'enterprise';
type Billing = 'monthly' | 'annual';

// Rupees, from the one price list the payments use.
const PRO_MONTHLY = PRO_PRICES.monthly.paise / 100;
const PRO_ANNUAL = PRO_PRICES.annual.paise / 100;
const PRO_YEAR_AT_MONTHLY = PRO_MONTHLY * 12;
const PRO_SAVING = PRO_YEAR_AT_MONTHLY - PRO_ANNUAL;
const PRO_ANNUAL_PER_MONTH = (PRO_ANNUAL / 12).toFixed(2);

/** The signed-in workspace, for the real pricing page. The playground passes none. */
export interface PricingAccount {
  /** 'team' is SpecFix's own team, which needs no plan. */
  plan: 'free' | 'pro' | 'team';
  /** When Pro ends, already formatted. */
  proUntil: string | null;
  projectCount: number;
  projectLimit: number;
  /** What the Pro card's button offers (packages/db `proCta`). */
  cta: 'current' | 'extend' | 'upgrade' | 'ask-admin' | 'team';
  /** Where payments go; null until UPI is set up. */
  upi: UpiPay | null;
  /** Razorpay Checkout, when its keys are set. */
  razorpay: { keyId: string; test: boolean } | null;
  /** The workspace's latest payment, if any. */
  payment: { status: 'pending' | 'paid' | 'rejected'; utr: string; rupees: number } | null;
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The shown number rolls from the last value to `target`; it jumps under reduced motion. */
function useRolling(target: number, ms = 450): number {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  useLayoutEffect(() => {
    const start = from.current;
    from.current = target;
    if (start === target || reducedMotion()) {
      setShown(target);
      return;
    }
    let frame = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      const eased = 1 - (1 - k) ** 3;
      setShown(Math.round(start + (target - start) * eased));
      if (k < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return shown;
}

/**
 * Pricing: Personal plans (Free, Pro, Pro Max) with a monthly or annual price, and Enterprise
 * beside it. With an `account` it marks the workspace's current plan; without one it is the
 * design playground's prototype. Upgrading opens the UPI payment dialog; Pro starts once the
 * SpecFix team confirms the payment.
 */
const NO_ACTIONS: PayActions = {
  submitUtr: async () => ({ status: 'error', error: 'Prototype only.' }),
  startRazorpay: async () => ({ status: 'error', error: 'Prototype only.' }),
  confirmRazorpay: async () => ({ status: 'error', error: 'Prototype only.' }),
};

export function PricingView({ account, pay }: { account?: PricingAccount; pay?: PayActions }) {
  const limit = account?.projectLimit ?? FREE_PROJECT_LIMIT;
  const waiting = account?.payment?.status === 'pending';
  const cta = account?.cta ?? 'upgrade';
  const [paying, setPaying] = useState(false);
  const actions = pay ?? NO_ACTIONS;
  const checkout = useRazorpayCheckout(actions.startRazorpay, actions.confirmRazorpay);
  const [audience, setAudience] = useState<Audience>('personal');
  const [billing, setBilling] = useState<Billing>('monthly');
  const [note, setNote] = useState(false);
  const annual = billing === 'annual';
  const price = useRolling(annual ? PRO_ANNUAL : PRO_MONTHLY);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(false), 4000);
    return () => clearTimeout(t);
  }, [note]);

  return (
    <>
      {/* Title with the plan type in the far corner; the billing period sits centred below. */}
      <header className={x.top}>
        <div className={x.titleBlock}>
          <h1 className={s.workTitle}>Plans and pricing</h1>
          <p className={s.muted}>Simple plans that grow with your team.</p>
        </div>

        <div
          className={`${x.seg} ${x.audience}`}
          role="tablist"
          aria-label="Plan type"
          data-on={audience}
        >
          <button
            type="button"
            role="tab"
            id="pg-tab-personal"
            aria-selected={audience === 'personal'}
            aria-controls="pg-plans"
            onClick={() => setAudience('personal')}
          >
            Personal
          </button>
          <button
            type="button"
            role="tab"
            id="pg-tab-enterprise"
            aria-selected={audience === 'enterprise'}
            aria-controls="pg-plans"
            onClick={() => setAudience('enterprise')}
          >
            Enterprise
          </button>
        </div>

        {audience === 'personal' ? (
          <div className={x.billing}>
            <div
              className={`${x.seg} ${x.pill}`}
              role="radiogroup"
              aria-label="Billing period"
              data-on={billing}
            >
              <button
                type="button"
                role="radio"
                aria-checked={!annual}
                onClick={() => setBilling('monthly')}
              >
                Monthly
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={annual}
                className={x.annualBtn}
                onClick={() => setBilling('annual')}
              >
                <span className={x.annualLabel}>
                  <Sparkles aria-hidden size={12} />
                  Annually
                </span>
                <span className={x.saveHint} data-on={annual ? 'true' : 'false'}>
                  Save ₹{PRO_SAVING}
                </span>
              </button>
            </div>
          </div>
        ) : null}
      </header>

      {account?.plan === 'team' ? (
        <p className={x.teamNote} role="note">
          Your SpecFix team account has every feature in every workspace. No plan needed.
        </p>
      ) : null}
      {account?.plan === 'pro' ? (
        <p className={x.teamNote} role="note">
          This workspace is on Pro{account.proUntil ? ` until ${account.proUntil}` : ''}: unlimited
          projects and the Conversational agent.
        </p>
      ) : null}
      {account?.payment && account.plan !== 'team' && account.payment.status !== 'paid' ? (
        <p className={x.payNote} data-status={account.payment.status} role="status">
          {account.payment.status === 'pending'
            ? `Your payment of ₹${account.payment.rupees} (UTR ${account.payment.utr}) is waiting for the SpecFix team to confirm it.`
            : `Your payment with UTR ${account.payment.utr} could not be confirmed. Your money is not lost: submit the correct UTR from your UPI receipt, or send the receipt to the SpecFix team. Do not pay again.`}
        </p>
      ) : null}

      <div
        id="pg-plans"
        role="tabpanel"
        aria-labelledby={audience === 'personal' ? 'pg-tab-personal' : 'pg-tab-enterprise'}
      >
        {audience === 'personal' ? (
          <div className={x.grid} onPointerMove={spotlight}>
            <article className={x.card} style={{ '--i': 0 } as CSSProperties}>
              <h2 className={x.name}>Free</h2>
              <p className={x.tag}>For trying SpecFix on a few projects</p>
              <p className={x.price}>
                <span className={x.amount}>₹0</span>
                <span className={x.per}>forever</span>
              </p>
              <p className={x.sub}>
                {account?.plan === 'free'
                  ? `${account.projectCount} of ${limit} projects used.`
                  : 'No card, no UPI needed.'}
              </p>
              <Features
                items={[
                  { text: `Up to ${limit} projects` },
                  { text: 'Flags on every ticket' },
                  { text: 'Gherkin specs from approved flags' },
                  { text: 'Conversational agent', locked: true },
                ]}
              />
              <button
                type="button"
                className={`${s.btn} ${s.btnLine} ${s.btnBlock} ${x.cta}`}
                disabled
              >
                {!account || account.plan === 'free' ? 'Current plan' : 'Free plan'}
              </button>
            </article>

            <article
              className={`${x.card} ${x.pro}`}
              style={{ '--i': 1 } as CSSProperties}
              aria-label="Pro plan, most popular"
            >
              <h2 className={x.name}>
                Pro{' '}
                {account?.plan === 'pro' ? (
                  <span className={x.currentTag}>Current plan</span>
                ) : (
                  <span className={x.badge}>
                    <Sparkles aria-hidden size={12} /> Popular
                  </span>
                )}
              </h2>
              <p className={x.tag}>For teams with more than five projects</p>
              {/* Keyed by period so the price block bumps on every switch. */}
              <p key={billing} className={`${x.price} ${x.bump}`}>
                {annual ? (
                  <del key="was" className={x.was} aria-label={`Was ₹${PRO_YEAR_AT_MONTHLY}`}>
                    ₹{PRO_YEAR_AT_MONTHLY}
                  </del>
                ) : null}
                <span className={x.amount} aria-hidden>
                  ₹{price}
                </span>
                <span className={x.per} aria-hidden>
                  /{annual ? 'year' : 'month'}
                </span>
                <span className={s.srOnly} aria-live="polite">
                  {annual ? `₹${PRO_ANNUAL} a year` : `₹${PRO_MONTHLY} a month`}
                </span>
              </p>
              <p className={x.sub}>
                {annual ? (
                  <span key="save" className={x.saved}>
                    You save ₹{PRO_SAVING} · just ₹{PRO_ANNUAL_PER_MONTH} a month
                  </span>
                ) : (
                  <>Billed monthly. Switch to annual and save ₹{PRO_SAVING}.</>
                )}
              </p>
              <Features
                items={[
                  { text: 'Unlimited projects' },
                  { text: 'Everything in Free' },
                  { text: 'Conversational agent' },
                ]}
              />
              {(cta === 'upgrade' || cta === 'extend') && !waiting ? (
                <button
                  type="button"
                  className={`${s.btn} ${s.btnSolid} ${s.btnBlock} ${x.cta} ${x.shine}`}
                  onClick={() => (account && pay ? setPaying(true) : setNote(true))}
                >
                  {cta === 'extend'
                    ? `Extend Pro${account?.proUntil ? ` · now until ${account.proUntil}` : ''}`
                    : 'Upgrade to Pro'}
                </button>
              ) : (
                <button
                  type="button"
                  className={`${s.btn} ${s.btnLine} ${s.btnBlock} ${x.cta}`}
                  disabled
                >
                  {waiting
                    ? 'Payment waiting for confirmation'
                    : cta === 'current'
                      ? `Current plan${account?.proUntil ? ` · until ${account.proUntil}` : ''}`
                      : cta === 'team'
                        ? 'Included for your team'
                        : 'Ask an owner or admin to upgrade'}
                </button>
              )}
            </article>

            <article className={`${x.card} ${x.soon}`} style={{ '--i': 2 } as CSSProperties}>
              <h2 className={x.name}>
                Pro Max <span className={x.soonTag}>Coming soon</span>
              </h2>
              <p className={x.tag}>For teams that need more than Pro</p>
              <p className={x.price}>
                <span className={x.amount}>—</span>
              </p>
              <p className={x.sub}>We are still working out what goes in it.</p>
              <Features items={[{ text: 'Everything in Pro' }, { text: 'More to come' }]} />
              <button
                type="button"
                className={`${s.btn} ${s.btnLine} ${s.btnBlock} ${x.cta}`}
                disabled
              >
                Coming soon
              </button>
            </article>
          </div>
        ) : (
          <section className={x.enterprise} aria-labelledby="pg-ent-title">
            <span className={x.entIcon} aria-hidden>
              <Building2 size={22} />
            </span>
            <h2 id="pg-ent-title" className={x.name}>
              Enterprise is coming soon
            </h2>
            <p className={s.muted}>Plans for larger organisations are on the way.</p>
            <button type="button" className={`${s.btn} ${s.btnLine}`} disabled>
              Coming soon
            </button>
          </section>
        )}
      </div>

      {note ? (
        <p className={x.note} role="status">
          Prototype: payment by UPI or Razorpay comes in a later step. Nothing was charged.
        </p>
      ) : null}

      {checkout.status.state !== 'idle' ? (
        <p className={x.payNote} data-status={checkout.status.state} role="status">
          {checkout.status.state === 'busy'
            ? 'Opening Razorpay…'
            : checkout.status.state === 'paid'
              ? 'Payment received. This workspace is on Pro now.'
              : checkout.status.message}
        </p>
      ) : null}

      {account && pay ? (
        <UpiDialog
          open={paying}
          onClose={() => setPaying(false)}
          period={billing}
          upi={account.upi}
          razorpay={account.razorpay}
          onRazorpay={() => {
            setPaying(false);
            void checkout.pay(billing);
          }}
          submit={actions.submitUtr}
        />
      ) : null}
    </>
  );
}

/** Moves the hovered card's soft spotlight to the pointer. */
function spotlight(e: PointerEvent<HTMLDivElement>) {
  const card = (e.target as HTMLElement).closest('article');
  if (!card) return;
  const r = card.getBoundingClientRect();
  card.style.setProperty('--mx', `${e.clientX - r.left}px`);
  card.style.setProperty('--my', `${e.clientY - r.top}px`);
}

function Features({ items }: { items: { text: string; locked?: boolean }[] }) {
  return (
    <ul className={x.features}>
      {items.map((f, j) => (
        <li
          key={f.text}
          data-locked={f.locked ? 'true' : undefined}
          style={{ '--j': j } as CSSProperties}
        >
          {f.locked ? <Lock aria-hidden size={15} /> : <Check aria-hidden size={15} />}
          <span>
            {f.text}
            {f.locked ? <span className={s.srOnly}> (not included)</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
