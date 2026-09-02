# CART-08 Enforce a maximum quantity of 99 per line item

## Description

The quantity field on a cart line item currently accepts any positive integer. A
customer entered 100000 last week, which passed validation, reserved the entire
warehouse stock for the 15-minute cart hold window, and blocked other orders.

Cap the quantity at 99 per line item. This is the same cap the checkout API already
enforces (`CartLine.quantity`, `max=99`), so this change makes the storefront match
the API rather than introducing a new rule.

Out of scope: the cart hold window, and any cap on the number of distinct line items
in a cart.

## Acceptance Criteria

- Entering a quantity above 99 in the cart shows the inline error "Maximum 99 per
  item" and the value is not saved
- Entering 99 or below saves normally
- Entering 0 or a negative number shows the existing "Enter a quantity of 1 or more"
  error; that behaviour is unchanged
- The quantity input has `max="99"` so browser stepper controls stop at 99
- An existing cart line with a quantity above 99, created before this change, is
  clamped to 99 the next time the cart is loaded, and the customer sees the notice
  "Quantity reduced to the maximum of 99"
- A `POST /cart/lines` request with quantity above 99 continues to return HTTP 422
  with the existing error body; no change to the API
