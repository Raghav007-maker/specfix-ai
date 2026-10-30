'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { CheckCircle2, X as Close } from 'lucide-react';
import { PRO_PRICES, type BillingPeriod } from '@specfix/shared/pricing';
import type { ConfirmRazorpay, StartRazorpay } from './razorpay-checkout';
import s from './playground.module.css';
import x from './pricing.module.css';

export interface UpiPay {
  payee: string;
  payeeName: string;
  pay: Record<BillingPeriod, { link: string; qr: string }>;
}

export interface UtrState {
  status: 'idle' | 'sent' | 'error';
  error?: string;
}

export type SubmitUtr = (previous: UtrState, formData: FormData) => Promise<UtrState>;

/** The server actions the real pricing page passes in; the playground passes none. */
export interface PayActions {
  submitUtr: SubmitUtr;
  startRazorpay: StartRazorpay;
  confirmRazorpay: ConfirmRazorpay;
}

/**
 * Pay for Pro: Razorpay first when it is set up (Pro starts at once), then UPI by QR, whose
 * 12-digit UTR the SpecFix team checks before Pro starts. A native <dialog> gives focus
 * containment, Escape to close and focus return. Razorpay opens its own window, which cannot sit
 * above a modal dialog, so choosing it closes this one first.
 */
export function UpiDialog({
  open,
  onClose,
  period,
  upi,
  razorpay,
  onRazorpay,
  submit,
}: {
  open: boolean;
  onClose: () => void;
  period: BillingPeriod;
  upi: UpiPay | null;
  razorpay: { test: boolean } | null;
  onRazorpay: () => void;
  submit: SubmitUtr;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const utrId = useId();
  // Kept in state so a failed submit never clears what the person typed.
  const [utr, setUtr] = useState('');
  // A dropped connection or a server error must not take the page down with the UTR in it.
  const [state, action, pending] = useActionState<UtrState, FormData>(
    async (previous, formData) => {
      try {
        return await submit(previous, formData);
      } catch {
        return {
          status: 'error',
          error:
            'We could not reach SpecFix, so the UTR was not saved. Your payment is safe in the bank; try again in a minute.',
        };
      }
    },
    { status: 'idle' }
  );
  const rupees = PRO_PRICES[period].paise / 100;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={ref} className={x.dialog} aria-labelledby={titleId} onClose={onClose}>
      <button type="button" className={x.dialogClose} onClick={onClose} aria-label="Close">
        <Close aria-hidden size={16} />
      </button>
      <h2 id={titleId} className={x.name}>
        Pay ₹{rupees} for Pro ({period === 'annual' ? 'annual' : 'monthly'})
      </h2>

      {state.status === 'sent' ? (
        <div className={x.dialogDone} role="status">
          <CheckCircle2 aria-hidden size={28} />
          <p>
            <b>Payment submitted.</b> The SpecFix team will check it in their bank app and switch
            this workspace to Pro, usually within a day.
          </p>
          <button type="button" className={`${s.btn} ${s.btnLine}`} onClick={onClose}>
            Done
          </button>
        </div>
      ) : (
        <>
          {razorpay ? (
            <div className={x.rzpBox}>
              <button
                type="button"
                className={`${s.btn} ${s.btnSolid} ${s.btnBlock} ${x.shine}`}
                onClick={onRazorpay}
              >
                Pay ₹{rupees} with Razorpay
              </button>
              <p className={s.muted}>
                Card, UPI or netbanking. Pro starts as soon as the payment goes through.
              </p>
              {razorpay.test ? (
                <span className={x.testTag}>Test mode · no real money moves</span>
              ) : null}
            </div>
          ) : null}

          {!upi ? (
            razorpay ? null : (
              <p className={s.muted}>Payments are not set up yet. Ask the SpecFix team.</p>
            )
          ) : (
            <>
              {razorpay ? <p className={x.or}>or pay by UPI QR</p> : null}
              <ol className={x.steps}>
                <li>Scan the QR with any UPI app (GPay, PhonePe, Paytm) and pay ₹{rupees}.</li>
                <li>Keep the payment note as it is; the team checks it before switching on Pro.</li>
                <li>Copy the 12-digit UTR from the payment receipt and paste it below.</li>
              </ol>
              <div className={x.qrBox}>
                <img
                  src={upi.pay[period].qr}
                  alt={`UPI QR code to pay ₹${rupees} to ${upi.payeeName}`}
                  width={184}
                  height={184}
                />
                <p>
                  {upi.payeeName}
                  <br />
                  <code>{upi.payee}</code>
                </p>
                <a className={`${s.btn} ${s.btnLine} ${s.btnSm}`} href={upi.pay[period].link}>
                  Open a UPI app
                </a>
              </div>

              <form action={action} className={x.utrForm}>
                <input type="hidden" name="period" value={period} />
                <label htmlFor={utrId}>UTR (12 digits)</label>
                <input
                  id={utrId}
                  name="utr"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={20}
                  required
                  placeholder="e.g. 412345678901"
                  value={utr}
                  onChange={(e) => setUtr(e.target.value)}
                  aria-invalid={state.status === 'error' ? true : undefined}
                  aria-describedby={state.status === 'error' ? `${utrId}-err` : undefined}
                />
                {state.status === 'error' ? (
                  <p id={`${utrId}-err`} className={x.utrError} role="alert">
                    {state.error}
                  </p>
                ) : null}
                <button
                  type="submit"
                  className={`${s.btn} ${s.btnSolid} ${s.btnBlock}`}
                  disabled={pending}
                  aria-busy={pending || undefined}
                >
                  {pending ? 'Submitting…' : 'I have paid · submit UTR'}
                </button>
              </form>
            </>
          )}
        </>
      )}
    </dialog>
  );
}
