'use client';

import Link from 'next/link';
import { Button, buttonClasses } from '@/components/ui';

/**
 * Last-resort boundary for errors a page did not turn into a message itself (mutations
 * already redirect back with `?error=`). The error text is not shown — it can be a raw
 * server message — only its digest, which matches the server log.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <p className="text-sm text-muted-foreground">Something went wrong</p>
      <h1 className="mt-2 text-[22px] font-semibold leading-7">This page could not be loaded</h1>
      <p role="alert" className="mt-3 text-sm leading-relaxed text-muted-foreground">
        Something went wrong while loading it. Try again; if it keeps failing, the server log has
        the details.
        {error.digest ? (
          <span className="mt-2 block font-mono text-xs">Reference: {error.digest}</span>
        ) : null}
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Button type="button" onClick={reset}>
          Try again
        </Button>
        <Link href="/" className={buttonClasses('outline')}>
          Back to the review queue
        </Link>
      </div>
    </main>
  );
}
