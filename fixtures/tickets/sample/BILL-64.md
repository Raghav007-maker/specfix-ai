# BILL-64 Prorate charges when a plan changes mid-cycle

## Description

Right now changing a plan charges the full new price immediately and the customer
loses whatever they already paid for the current period. Support is issuing manual
credits every week to fix it.

When a customer changes plan partway through a billing period we should charge or
credit the difference for the remaining days.

Upgrades take effect immediately. Downgrades take effect immediately as well, and
the customer keeps access to the higher tier until the end of the period they paid
for.

## Acceptance Criteria

- Changing plan mid-cycle produces a prorated charge or credit
- The prorated amount appears as a line item on the next invoice
- Customer sees the amount before confirming the change
- Finance can see the proration calculation for any change
