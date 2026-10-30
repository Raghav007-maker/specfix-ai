import { Suspense, type ReactNode } from 'react';
import Link from 'next/link';
import {
  BarChart3,
  Bell,
  Folder,
  Gem,
  IndianRupee,
  ListChecks,
  LogOut,
  Menu,
  Plug,
  Users,
  X,
} from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import { signOut } from '@/app/(auth)/actions';
import type { MembershipRow } from '@/lib/tenant';
import type { ProjectRow } from '@/lib/repos';
import { cn } from '@/lib/cn';
import { LogoMark, LogoWordmark } from '@/components/brand';
import { PlanNotice } from '@/components/plan-notice';
import { isAppOwner, planNoticeFor } from '@/lib/plan';

/**
 * The workspace frame: a white sidebar and top bar on the light grey ground around one white sheet,
 * matching the dashboard.
 * Below 1024px the frame folds into a 48px bar with a menu. It shows only the product, the
 * workspace, its projects and the account — never ticket or flag data, so it is safe on the
 * blind-first path.
 */
export function AppShell({
  user,
  tenant,
  projects,
  activeProjectId,
  current,
  breadcrumb,
  children,
}: {
  user: User;
  tenant: MembershipRow;
  projects: ProjectRow[];
  activeProjectId?: string;
  /** Which top-level destination this page is, for the sidebar's active state. */
  current?: 'queue' | 'analytics' | 'team' | 'integrations' | 'inbox' | 'pricing' | 'payments';
  breadcrumb: ReactNode;
  children: ReactNode;
}) {
  const nav = (
    <Nav
      tenant={tenant}
      projects={projects}
      activeProjectId={activeProjectId}
      current={current}
      email={user.email ?? ''}
      appOwner={isAppOwner(user)}
    />
  );

  return (
    <div className="min-h-screen bg-frame lg:grid lg:grid-cols-[228px_minmax(0,1fr)] lg:grid-rows-[48px_minmax(0,1fr)]">
      <aside className="flex flex-col border-r border-border bg-sheet px-3 pb-4 pt-4 max-lg:hidden lg:sticky lg:top-0 lg:row-span-2 lg:h-screen">
        {nav}
      </aside>

      <header className="flex h-12 items-center gap-3 px-6 max-lg:hidden">
        <div className="min-w-0 flex-1">{breadcrumb}</div>
        <Suspense fallback={null}>
          <PlanNoticeSlot user={user} tenant={tenant} />
        </Suspense>
      </header>

      <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-border bg-frame px-2 lg:hidden">
        <details className="group">
          <summary
            aria-label="Menu"
            className="flex h-11 w-11 cursor-pointer list-none items-center justify-center rounded-md text-muted-foreground hover:bg-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
          >
            <Menu aria-hidden size={18} strokeWidth={1.5} className="group-open:hidden" />
            <X aria-hidden size={18} strokeWidth={1.5} className="hidden group-open:block" />
          </summary>
          <div className="fixed inset-x-0 bottom-0 top-12 z-30 flex flex-col overflow-y-auto bg-frame px-3 pb-4 pt-3">
            {nav}
          </div>
        </details>
        <div className="min-w-0 flex-1">{breadcrumb}</div>
        <Suspense fallback={null}>
          <PlanNoticeSlot user={user} tenant={tenant} />
        </Suspense>
      </header>

      <main
        id="main"
        className="app-sheet min-w-0 px-4 pb-12 pt-5 md:px-6 lg:mb-3 lg:ml-3 lg:mr-3 lg:min-h-[calc(100vh-60px)] lg:rounded-sheet lg:border lg:border-border lg:pt-6"
      >
        <div className="page-enter">{children}</div>
      </main>
    </div>
  );
}

/** The plan notice for owners and admins, when there is one to show. Streamed in its own
 * Suspense boundary so the page never waits on this extra query. */
async function PlanNoticeSlot({ user, tenant }: { user: User; tenant: MembershipRow }) {
  const notice = await planNoticeFor(user, tenant);
  return notice ? <PlanNotice notice={notice} /> : null;
}

function Nav({
  tenant,
  projects,
  activeProjectId,
  current,
  email,
  appOwner,
}: {
  tenant: MembershipRow;
  projects: ProjectRow[];
  activeProjectId?: string;
  current?: 'queue' | 'analytics' | 'team' | 'integrations' | 'inbox' | 'pricing' | 'payments';
  email: string;
  /** SpecFix's own team also sees the payments to approve. */
  appOwner: boolean;
}) {
  return (
    <>
      <Link
        href="/"
        className="flex h-9 items-center gap-2 rounded-md px-2 text-base font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
        translate="no"
        aria-label="SpecFix home"
      >
        <LogoMark size={26} className="flex-none text-text" />
        <LogoWordmark height={17} className="text-text" />
      </Link>

      <div className="mt-3 px-2">
        <p className="truncate text-sm font-medium">{tenant.tenant_name}</p>
        <p className="text-xs capitalize text-muted-foreground">{tenant.role}</p>
      </div>

      <nav aria-label="Main" className="mt-5 flex flex-col gap-0.5">
        <NavLink
          href="/"
          active={current === 'queue'}
          icon={<ListChecks aria-hidden size={18} strokeWidth={1.6} />}
        >
          Home
        </NavLink>
        <NavLink
          href="/inbox"
          active={current === 'inbox'}
          icon={<Bell aria-hidden size={18} strokeWidth={1.6} />}
        >
          Inbox
        </NavLink>
        <NavLink
          href="/analytics"
          active={current === 'analytics'}
          icon={<BarChart3 aria-hidden size={18} strokeWidth={1.6} />}
        >
          Ticket analytics
        </NavLink>
        <NavLink
          href="/team"
          active={current === 'team'}
          icon={<Users aria-hidden size={18} strokeWidth={1.6} />}
        >
          Team
        </NavLink>
        <NavLink
          href="/settings/integrations"
          active={current === 'integrations'}
          icon={<Plug aria-hidden size={18} strokeWidth={1.6} />}
        >
          Integrations
        </NavLink>
        <NavLink
          href="/pricing"
          active={current === 'pricing'}
          icon={<Gem aria-hidden size={18} strokeWidth={1.6} />}
        >
          Pricing
        </NavLink>
        {appOwner ? (
          <NavLink
            href="/admin/payments"
            active={current === 'payments'}
            icon={<IndianRupee aria-hidden size={18} strokeWidth={1.6} />}
          >
            Payments
          </NavLink>
        ) : null}

        {projects.length > 0 ? (
          <>
            <p className="mb-1 mt-5 px-2 text-xs text-muted-foreground">Projects</p>
            {projects.map((project) => (
              <NavLink
                key={project.id}
                href={`/?project=${project.id}`}
                active={project.id === activeProjectId}
                icon={<Folder aria-hidden size={18} strokeWidth={1.6} />}
              >
                {project.name}
              </NavLink>
            ))}
          </>
        ) : null}
      </nav>

      <div className="mt-auto border-t border-border pt-3">
        <p className="truncate px-2 text-xs text-muted-foreground" title={email}>
          {email}
        </p>
        <form action={signOut} className="mt-1">
          <button
            type="submit"
            className="flex h-10 w-full items-center gap-3 rounded-lg px-2.5 text-sm text-muted-foreground transition-colors hover:bg-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal max-lg:h-11"
          >
            <LogOut aria-hidden size={18} strokeWidth={1.6} />
            Sign out
          </button>
        </form>
      </div>
    </>
  );
}

function NavLink({
  href,
  active,
  icon,
  children,
}: {
  href: string;
  active: boolean;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-10 items-center gap-3 rounded-lg px-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal max-lg:h-11',
        active
          ? 'bg-active font-medium text-text shadow-[0_0_0_1px_rgb(var(--border))]'
          : 'text-muted-foreground hover:bg-raised hover:text-text'
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
    </Link>
  );
}

/** Breadcrumb for the top bar: parent link, then the current item. */
export function Breadcrumb({
  parent,
  current,
}: {
  parent: { href: string; label: string };
  current: string;
}) {
  return (
    <nav aria-label="Breadcrumb" className="min-w-0 text-sm">
      <ol className="flex min-w-0 items-center gap-2">
        <li className="min-w-0">
          <Link
            href={parent.href}
            className="inline-block max-w-[40vw] truncate rounded-sm py-1 align-middle text-muted-foreground transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
          >
            {parent.label}
          </Link>
        </li>
        <li aria-hidden className="text-muted-foreground">
          /
        </li>
        <li aria-current="page" translate="no" className="truncate font-mono text-[13px]">
          {current}
        </li>
      </ol>
    </nav>
  );
}
