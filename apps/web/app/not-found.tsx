import Link from 'next/link';
import { buttonClasses } from '@/components/ui';

export default function NotFound() {
  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <p className="text-sm text-muted-foreground">Error 404</p>
      <h1 className="mt-2 text-[22px] font-semibold leading-7">Nothing to review here</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        This page or ticket does not exist, or it belongs to a workspace you are not in.
      </p>
      <Link href="/" className={`${buttonClasses('outline')} mt-6 self-start`}>
        Back to the review queue
      </Link>
    </main>
  );
}
