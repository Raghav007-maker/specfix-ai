'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Re-renders the current server page every `ms` while mounted, e.g. while a job runs. */
export function AutoRefresh({ ms = 4000 }: { ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), ms);
    return () => clearInterval(timer);
  }, [router, ms]);
  return null;
}
