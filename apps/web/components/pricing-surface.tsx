'use client';

import type { CSSProperties } from 'react';
import { WORKSPACE_SETTINGS, cssVars, dataAttrs } from '@/components/playground/settings';
import { PricingView, type PricingAccount } from '@/components/playground/pricing-view';
import type { PayActions } from '@/components/playground/upi-dialog';
import p from '@/components/playground/playground.module.css';
import x from '@/components/playground/pricing.module.css';

/**
 * The pricing view inside the app shell, in the same workspace styling as the home dashboard so
 * the page matches the design approved in the playground.
 */
export function PricingSurface({ account, pay }: { account: PricingAccount; pay: PayActions }) {
  return (
    <div
      className={p.root}
      data-pg-preview=""
      style={cssVars(WORKSPACE_SETTINGS) as CSSProperties}
      {...dataAttrs(WORKSPACE_SETTINGS)}
    >
      <div className={x.surface}>
        <PricingView account={account} pay={pay} />
      </div>
    </div>
  );
}
