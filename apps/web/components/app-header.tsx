import Link from 'next/link';
import type { User } from '@supabase/supabase-js';
import { signOut } from '@/app/(auth)/actions';
import { switchTenant } from '@/app/actions';
import { RoleBadge } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { MembershipRow } from '@/lib/tenant';

type Section = 'queue' | 'team';

/**
 * The navy bar on every authenticated page: product mark, the workspace menu (switch
 * workspace when you belong to more than one), section links, and who you are.
 */
export function AppHeader({
  user,
  tenant,
  memberships = [],
  active,
}: {
  user: User;
  tenant?: MembershipRow | undefined;
  memberships?: MembershipRow[] | undefined;
  active?: Section | undefined;
}) {
  return (
    <header className="sticky top-0 z-20 bg-[hsl(var(--nav))] text-white shadow-sm">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-4 sm:gap-6">
          <Link href="/" className="text-lg font-bold tracking-tight">
            SpecFix
          </Link>
          {tenant ? <WorkspaceMenu tenant={tenant} memberships={memberships} /> : null}
          {tenant ? (
            <nav className="hidden items-center gap-1 md:flex">
              <NavLink href="/" active={active === 'queue'}>
                Review queue
              </NavLink>
              <NavLink href="/team" active={active === 'team'}>
                Team
              </NavLink>
            </nav>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-3 text-sm">
          <span className="hidden text-white/80 lg:inline">{user.email}</span>
          {tenant ? (
            <span className="hidden rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-medium capitalize text-white sm:inline-flex">
              {tenant.role}
            </span>
          ) : null}
          <form action={signOut}>
            <button
              type="submit"
              className="rounded-md px-2 py-1 text-white/90 hover:bg-white/10 hover:text-white"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
      {tenant ? (
        <nav className="flex gap-1 border-t border-white/10 px-4 py-1.5 md:hidden">
          <NavLink href="/" active={active === 'queue'}>
            Review queue
          </NavLink>
          <NavLink href="/team" active={active === 'team'}>
            Team
          </NavLink>
        </nav>
      ) : null}
    </header>
  );
}

function NavLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        active ? 'bg-white/15 text-white' : 'text-white/75 hover:bg-white/10 hover:text-white'
      )}
    >
      {children}
    </Link>
  );
}

/** A native <details> menu, so switching workspace needs no client JavaScript. */
function WorkspaceMenu({
  tenant,
  memberships,
}: {
  tenant: MembershipRow;
  memberships: MembershipRow[];
}) {
  if (memberships.length <= 1) {
    return <span className="truncate text-sm text-white/85">{tenant.tenant_name}</span>;
  }

  return (
    <details className="group relative">
      <summary className="flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-sm text-white/90 hover:bg-white/10">
        <span className="max-w-[10rem] truncate">{tenant.tenant_name}</span>
        <span aria-hidden className="text-xs transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <div className="absolute left-0 mt-2 w-64 overflow-hidden rounded-lg border bg-card text-card-foreground shadow-lg">
        <p className="border-b px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Switch workspace
        </p>
        <ul className="py-1">
          {memberships.map((m) => (
            <li key={m.tenant_id}>
              <form action={switchTenant}>
                <input type="hidden" name="tenantId" value={m.tenant_id} />
                <button
                  type="submit"
                  className={cn(
                    'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent',
                    m.tenant_id === tenant.tenant_id && 'font-semibold text-primary'
                  )}
                >
                  <span className="truncate">{m.tenant_name}</span>
                  <RoleBadge role={m.role} />
                </button>
              </form>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
