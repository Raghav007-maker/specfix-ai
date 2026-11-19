'use client';

import { useState } from 'react';
import { UpiDialog, type PayActions, type UpiPay } from '@/components/playground/upi-dialog';
import { useRazorpayCheckout } from '@/components/playground/razorpay-checkout';
import { Button } from '@/components/ui';

/** Opens the same UPI / Razorpay dialog as Pro, for the one-time workspace fee. */
export function PayFee({
  rupees,
  pay,
  upi,
  razorpay,
}: {
  rupees: number;
  pay: PayActions;
  upi: UpiPay | null;
  razorpay: { test: boolean } | null;
}) {
  const [open, setOpen] = useState(false);
  const checkout = useRazorpayCheckout(pay.startRazorpay, pay.confirmRazorpay);
  return (
    <div className="space-y-3">
      <Button type="button" className="w-full" onClick={() => setOpen(true)}>
        Pay ₹{rupees} and open the workspace
      </Button>
      {checkout.status.state !== 'idle' ? (
        <p className="text-sm text-muted-foreground" role="status">
          {checkout.status.state === 'busy'
            ? 'Opening Razorpay…'
            : checkout.status.state === 'paid'
              ? 'Payment received. Opening your workspace…'
              : checkout.status.message}
        </p>
      ) : null}
      <UpiDialog
        open={open}
        onClose={() => setOpen(false)}
        period="workspace"
        upi={upi}
        razorpay={razorpay}
        onRazorpay={() => {
          setOpen(false);
          void checkout.pay('workspace');
        }}
        submit={pay.submitUtr}
      />
    </div>
  );
}
