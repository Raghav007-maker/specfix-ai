import { NextResponse } from 'next/server';

/**
 * A redirect to a path on this site, sent as a relative Location. Behind Azure's proxy the
 * standalone server's request.url has its bind address as origin (https://0.0.0.0:8080), so an
 * absolute URL built from it sends the browser nowhere.
 */
export function redirectTo(path: string): NextResponse {
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) {
    throw new Error('redirectTo only takes a path on this site');
  }
  return new NextResponse(null, { status: 307, headers: { Location: path } });
}
