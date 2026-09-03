import Link from 'next/link';
import type { User } from '@supabase/supabase-js';
import { signOut } from '@/app/(auth)/actions';
import { Button } from '@/components/ui';
import type { MembershipRow } from '@/lib/tenant';

/** The top bar on every authenticated page: product mark, current tenant, sign-out. */
export function AppHeader({ user, tenant }: { user: User; tenant?: MembershipRow | undefined }) {
  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
        <div className="flex items-center gap-3">
          <Link href="/" className="font-semibold tracking-tight">
            SpecFix
          </Link>
          {tenant ? (
            <span className="text-sm text-muted-foreground">
              {tenant.tenant_name}
              <span className="ml-1 text-xs uppercase tracking-wide">· {tenant.role}</span>
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden text-sm text-muted-foreground sm:inline">{user.email}</span>
          <form action={signOut}>
            <Button variant="outline" size="sm" type="submit">
              Sign out
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}
