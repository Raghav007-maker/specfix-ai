/**
 * The Content-Security-Policy for every page, with a fresh nonce per request.
 *
 * Scripts run only if they carry this request's nonce (Next.js adds it to its own scripts when
 * it sees the policy on the request), or were added by such a script ('strict-dynamic': this is
 * how the Razorpay checkout script loads). So an injected <script> or inline handler never runs,
 * even if some HTML escaping were ever missed.
 *
 * Styles allow 'unsafe-inline' because React style attributes and Next's font CSS are inline;
 * that cannot run code. Images allow any https host because the page decides which avatar URLs
 * it renders (see safeAvatarUrl).
 */
export function contentSecurityPolicy(nonce: string, dev: boolean): string {
  const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
  const supabaseHost = supabase ? new URL(supabase).host : '';
  return [
    `default-src 'self'`,
    // Dev mode's hot reload evaluates code; production never does.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? ` 'unsafe-eval'` : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: https:`,
    `font-src 'self' data:`,
    `connect-src 'self'${supabaseHost ? ` https://${supabaseHost} wss://${supabaseHost}` : ''} https://*.razorpay.com${dev ? ' ws:' : ''}`,
    `frame-src https://api.razorpay.com https://checkout.razorpay.com`,
    `form-action 'self'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    `frame-ancestors 'none'`,
  ].join('; ');
}
