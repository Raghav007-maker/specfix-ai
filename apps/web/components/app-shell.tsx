import { Suspense, type ReactNode } from 'react';
import Link from 'next/link';
import { cookies } from 'next/headers';
import {
  BarChart3,
  Bell,
  CalendarDays,
  ChevronDown,
  Folder,
  Gem,
  IndianRupee,
  ListChecks,
  LogOut,
  Menu,
  Plug,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Users,
  UserRound,
  X,
} from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import { signOut } from '@/app/(auth)/actions';
import type { MembershipRow } from '@/lib/tenant';
import { unreadNotificationCount, type VisibleProjectRow } from '@/lib/repos';
import { cn } from '@/lib/cn';
import { safeAvatarUrl } from '@/lib/avatar';
import { buttonClasses } from '@/components/ui';
import { SidebarToggle } from '@/components/sidebar-toggle';
import { LogoMark, LogoWordmark } from '@/components/brand';
import { PlanNotice } from '@/components/plan-notice';
import { isAppOwner, planNoticeFor } from '@/lib/plan';

export type ProjectView =
  | 'summary'
  | 'board'
  | 'backlog'
  | 'list'
  | 'calendar'
  | 'conversation'
  | 'people'
  | 'settings'
  | 'queue';

/** The top-level page a screen is, for the sidebar's and settings menu's active state. */
export type ShellPage =
  | 'queue'
  | 'calendar'
  | 'projects'
  | 'analytics'
  | 'team'
  | 'integrations'
  | 'security'
  | 'inbox'
  | 'pricing'
  | 'payments';

/** Workspace settings: not daily navigation, so grouped behind the gear at the sidebar's foot. */
/** Pricing only for whoever pays (the workspace owner) and SpecFix's own team. */
function settingsLinks(appOwner: boolean, payer: boolean) {
  return [
    {
      key: 'team' as const,
      href: '/team',
      label: 'Team and roles',
      note: 'Invite people, make someone a reviewer or admin',
      icon: Users,
    },
    {
      key: 'integrations' as const,
      href: '/settings/integrations',
      label: 'Integrations',
      note: 'GitHub and CI',
      icon: Plug,
    },
    ...(payer
      ? [
          {
            key: 'pricing' as const,
            href: '/pricing',
            label: 'Pricing and plan',
            note: 'Free or Pro, and paying for it',
            icon: Gem,
          },
        ]
      : []),
    // SpecFix's own team approves payments; nobody else sees this.
    ...(appOwner
      ? [
          {
            key: 'payments' as const,
            href: '/admin/payments',
            label: 'Payments',
            note: 'Approve UPI payments',
            icon: IndianRupee,
          },
        ]
      : []),
  ];
}

/** A project's views, in the order the header tabs and the sidebar list them. */
export function projectViews(
  projectId: string,
  canManage: boolean
): { key: ProjectView; label: string; href: string }[] {
  const base = `/projects/${projectId}`;
  return [
    { key: 'summary' as const, label: 'Summary', href: base },
    { key: 'board' as const, label: 'Board', href: `${base}/board` },
    { key: 'backlog' as const, label: 'Backlog', href: `${base}/backlog` },
    { key: 'list' as const, label: 'List', href: `${base}/list` },
    { key: 'calendar' as const, label: 'Calendar', href: `${base}/calendar` },
    { key: 'conversation' as const, label: 'Conversation', href: `${base}/conversation` },
    { key: 'people' as const, label: 'People', href: `${base}/people` },
    { key: 'queue' as const, label: 'Spec queue', href: `/?project=${projectId}` },
    ...(canManage
      ? [{ key: 'settings' as const, label: 'Settings', href: `${base}/settings` }]
      : []),
  ];
}

/**
 * The workspace frame: a white sidebar and top bar on the light grey ground around one white sheet,
 * matching the dashboard.
 * Below 1024px the frame folds into a 48px bar with a menu. It shows only the product, the
 * workspace, its projects and the account — never ticket or flag data, so it is safe on the
 * blind-first path.
 */
export async function AppShell({
  user,
  tenant,
  projects,
  activeProjectId,
  projectView,
  current,
  breadcrumb,
  children,
}: {
  user: User;
  tenant: MembershipRow;
  projects: VisibleProjectRow[];
  activeProjectId?: string;
  /** Which view of the active project this page is; its views are listed under it. */
  projectView?: ProjectView;
  /** Which top-level destination this page is, for the sidebar's active state. */
  current?: ShellPage;
  breadcrumb: ReactNode;
  children: ReactNode;
}) {
  const sidebarHidden = (await cookies()).get('sf_sidebar')?.value === 'hidden';
  // Create says what it makes: inside a project, a task in it; elsewhere, a new project for
  // owners, or (admins and reviewers, who cannot make projects) a task in the first project.
  const canCreateProject = tenant.role === 'owner';
  const taskProject = activeProjectId ?? (canCreateProject ? undefined : projects[0]?.id);
  const create = taskProject
    ? { href: `/projects/${taskProject}/tasks/new`, label: 'Create task' }
    : canCreateProject
      ? { href: '/projects?new=1#new-project', label: 'Create project' }
      : null;
  const nav = (
    <Nav
      tenant={tenant}
      projects={projects}
      activeProjectId={activeProjectId}
      projectView={projectView}
      current={current}
      email={user.email ?? ''}
      appOwner={isAppOwner(user)}
    />
  );

  return (
    <div
      id="app-shell"
      data-sidebar={sidebarHidden ? 'hidden' : 'shown'}
      className="group/shell min-h-screen bg-frame lg:grid lg:grid-cols-[228px_minmax(0,1fr)] lg:grid-rows-[48px_minmax(0,1fr)] lg:data-[sidebar=hidden]:grid-cols-[minmax(0,1fr)]"
    >
      <aside
        id="app-sidebar"
        className="flex flex-col overflow-y-auto border-r border-border bg-sheet px-3 pb-4 pt-4 max-lg:hidden lg:sticky lg:top-0 lg:row-span-2 lg:h-screen lg:group-data-[sidebar=hidden]/shell:hidden"
      >
        {nav}
      </aside>

      <header className="flex h-12 items-center gap-3 px-6 max-lg:hidden lg:group-data-[sidebar=hidden]/shell:pl-3">
        <SidebarToggle action="show" />
        <Link
          href="/"
          aria-label="SpecFix home"
          translate="no"
          className="hidden flex-none items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal lg:group-data-[sidebar=hidden]/shell:flex"
        >
          <LogoMark size={22} className="text-text" />
        </Link>
        <div className="min-w-0 flex-1">{breadcrumb}</div>
        <form
          action="/search"
          method="get"
          role="search"
          className="relative w-56 transition-[width] duration-300 ease-out focus-within:w-72 xl:w-80 xl:focus-within:w-96"
        >
          <Search
            aria-hidden
            size={15}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            name="q"
            aria-label="Search tasks and projects"
            placeholder="Search"
            maxLength={100}
            className="h-8 w-full rounded-md border border-border bg-sheet pl-8 pr-2 text-sm transition-[border-color,box-shadow] duration-200 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
          />
        </form>
        {create ? (
          <Link
            href={create.href}
            className={cn(buttonClasses('default', 'sm'), 'group/create h-8')}
          >
            <Plus
              aria-hidden
              size={15}
              strokeWidth={2}
              className="transition-transform duration-300 group-hover/create:rotate-90"
            />
            {create.label}
          </Link>
        ) : null}
        <Suspense fallback={null}>
          <PlanNoticeSlot user={user} tenant={tenant} />
        </Suspense>
        <Suspense fallback={<BellLink count={0} />}>
          <BellSlot user={user} tenant={tenant} />
        </Suspense>
        <AccountMenu user={user} tenant={tenant} projects={projects} />
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
        <Suspense fallback={<BellLink count={0} />}>
          <BellSlot user={user} tenant={tenant} />
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

/** The bell in the top bar, with the number of unread notifications when there are any. */
function BellLink({ count }: { count: number }) {
  return (
    <Link
      href="/inbox"
      aria-label={count ? `Notifications, ${count} unread` : 'Notifications'}
      className="bell-ring relative flex h-9 w-9 flex-none items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
    >
      <Bell aria-hidden size={18} strokeWidth={1.6} />
      {count ? (
        <span className="num-pop absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full bg-negative px-1 text-center text-[11px] font-semibold leading-[18px] text-white tabular-nums">
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
    </Link>
  );
}

/** The bell with its unread count, streamed so the page never waits on the count. */
async function BellSlot({ user, tenant }: { user: User; tenant: MembershipRow }) {
  const count = await unreadNotificationCount(tenant.tenant_id, user.id).catch(() => 0);
  return <BellLink count={count} />;
}

/** The gear at the sidebar's foot: the workspace's settings pages, opening upward. */
function SettingsMenu({
  current,
  appOwner,
  payer,
}: {
  current?: ShellPage;
  appOwner: boolean;
  payer: boolean;
}) {
  const links = settingsLinks(appOwner, payer);
  const inSettings = links.some((l) => l.key === current);
  return (
    <details className="group/settings relative">
      <summary
        className={cn(
          'nav-item flex h-10 cursor-pointer list-none items-center gap-3 rounded-lg px-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal max-lg:h-11 [&::-webkit-details-marker]:hidden',
          inSettings
            ? 'bg-active font-medium text-text'
            : 'text-muted-foreground hover:bg-raised hover:text-text'
        )}
      >
        <Settings
          aria-hidden
          size={18}
          strokeWidth={1.6}
          className="transition-transform duration-500 group-open/settings:rotate-90"
        />
        <span>Settings</span>
      </summary>
      <div className="menu-pop menu-up absolute bottom-full left-0 z-40 mb-1 w-full min-w-64 rounded-lg border border-border bg-sheet p-2 shadow-[var(--float)]">
        <p className="px-2.5 pb-1 pt-1.5 text-xs font-semibold text-muted-foreground">
          Workspace settings
        </p>
        <nav aria-label="Settings" className="flex flex-col">
          {links.map(({ key, href, label, note, icon: Icon }) => (
            <Link
              key={key}
              href={href}
              aria-current={current === key ? 'page' : undefined}
              className={cn(
                'flex items-start gap-3 rounded-md px-2.5 py-2 hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal',
                current === key && 'bg-active'
              )}
            >
              <Icon aria-hidden size={17} strokeWidth={1.6} className="mt-0.5 flex-none" />
              <span>
                <span className="block text-sm text-text">{label}</span>
                <span className="block text-xs text-muted-foreground">{note}</span>
              </span>
            </Link>
          ))}
        </nav>
      </div>
    </details>
  );
}

/**
 * The avatar at the top right, as in Jira: who is signed in, and links to their notifications
 * and security settings, and Log out. A plain <details>, so it works without JavaScript.
 */
function AccountMenu({
  user,
  tenant,
  projects,
}: {
  user: User;
  tenant: MembershipRow;
  projects: VisibleProjectRow[];
}) {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const name =
    (typeof meta.full_name === 'string' && meta.full_name.trim()) ||
    (typeof meta.name === 'string' && meta.name.trim()) ||
    null;
  const photo = safeAvatarUrl(
    (typeof meta.avatar_url === 'string' && meta.avatar_url) ||
      (typeof meta.picture === 'string' && meta.picture) ||
      null
  );
  const email = user.email ?? '';
  const letters = (name ?? email)
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  const avatar = (size: string) =>
    photo ? (
      <img
        src={photo}
        alt=""
        referrerPolicy="no-referrer"
        className={cn(size, 'rounded-full object-cover')}
      />
    ) : (
      <span
        aria-hidden
        className={cn(
          size,
          'flex items-center justify-center rounded-full bg-text font-semibold text-sheet'
        )}
      >
        {letters || '?'}
      </span>
    );
  const item =
    'flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm text-text hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal';
  return (
    <details className="relative">
      <summary
        aria-label="Account"
        className="flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-full ring-0 ring-teal/30 transition-[box-shadow,transform] duration-200 hover:scale-105 hover:ring-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal [&::-webkit-details-marker]:hidden"
      >
        {avatar('h-8 w-8 text-xs')}
      </summary>
      <div className="menu-pop menu-down absolute right-0 top-11 z-40 w-72 rounded-lg border border-border bg-sheet p-2 shadow-[var(--float)]">
        <div className="flex items-center gap-3 rounded-md bg-raised p-3">
          {avatar('h-11 w-11 text-sm')}
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{name ?? email}</p>
            <p className="truncate text-xs text-muted-foreground">{email}</p>
            <p className="truncate text-xs capitalize text-muted-foreground">
              {tenant.role} · {tenant.tenant_name}
            </p>
          </div>
        </div>
        {/* A dropdown inside the menu: closed by default, it opens to every project. */}
        <details className="group/projects mt-2 border-b border-border pb-2">
          <summary
            id="my-projects-h"
            className={cn(
              item,
              'cursor-pointer list-none justify-between font-medium [&::-webkit-details-marker]:hidden'
            )}
          >
            <span className="flex items-center gap-2.5">
              <Folder aria-hidden size={16} strokeWidth={1.6} />
              My projects
              <span className="rounded-full bg-raised px-1.5 text-xs tabular-nums text-muted-foreground">
                {projects.length}
              </span>
            </span>
            <ChevronDown
              aria-hidden
              size={16}
              className="text-muted-foreground transition-transform group-open/projects:rotate-180"
            />
          </summary>
          {projects.length === 0 ? (
            <p className="px-2.5 py-1 text-xs text-muted-foreground">No projects yet.</p>
          ) : (
            <ul
              aria-label="My projects"
              className="ml-4 max-h-56 overflow-y-auto border-l border-border pl-1"
            >
              {projects.map((p) => (
                <li key={p.id}>
                  <Link href={`/projects/${p.id}`} className={item}>
                    <span className="truncate">{p.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </details>
        <nav aria-label="Account" className="mt-2 flex flex-col">
          <Link href="/settings/profile" className={item}>
            <UserRound aria-hidden size={16} strokeWidth={1.6} />
            Profile and photo
          </Link>
          <Link href="/inbox" className={item}>
            <Bell aria-hidden size={16} strokeWidth={1.6} />
            Notifications and email
          </Link>
          <Link href="/settings/security" className={item}>
            <ShieldCheck aria-hidden size={16} strokeWidth={1.6} />
            Security
          </Link>
        </nav>
        <form action={signOut} className="mt-1 border-t border-border pt-1">
          <button type="submit" className={cn(item, 'w-full text-muted-foreground')}>
            <LogOut aria-hidden size={16} strokeWidth={1.6} />
            Log out
          </button>
        </form>
      </div>
    </details>
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
  projectView,
  current,
  email,
  appOwner,
}: {
  tenant: MembershipRow;
  projects: VisibleProjectRow[];
  activeProjectId?: string;
  projectView?: ProjectView;
  current?: ShellPage;
  email: string;
  /** SpecFix's own team also sees the payments to approve. */
  appOwner: boolean;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <Link
          href="/"
          className="flex h-9 items-center gap-2 rounded-md px-2 text-base font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
          translate="no"
          aria-label="SpecFix home"
        >
          <LogoMark size={26} className="flex-none text-text" />
          <LogoWordmark height={17} className="text-text" />
        </Link>
        {/* Desktop only: on a phone the sidebar is already a menu that opens and closes. */}
        <span className="max-lg:hidden">
          <SidebarToggle action="hide" />
        </span>
      </div>

      <div className="mt-3 px-2">
        <p className="truncate text-sm font-medium">{tenant.tenant_name}</p>
        <p className="text-xs capitalize text-muted-foreground">{tenant.role}</p>
      </div>

      <nav aria-label="Main" className="nav-stagger mt-5 flex flex-col gap-0.5">
        <NavLink
          href="/"
          active={current === 'queue'}
          icon={<ListChecks aria-hidden size={18} strokeWidth={1.6} />}
        >
          Home
        </NavLink>
        <NavLink
          href="/calendar"
          active={current === 'calendar'}
          icon={<CalendarDays aria-hidden size={18} strokeWidth={1.6} />}
        >
          Calendar
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
        {projects.length > 0 ? (
          <>
            <p className="mb-1 mt-5 px-2 text-xs text-muted-foreground">Projects</p>
            {projects.map((project) => (
              <div key={project.id}>
                <NavLink
                  href={`/projects/${project.id}`}
                  active={project.id === activeProjectId && !projectView}
                  icon={<Folder aria-hidden size={18} strokeWidth={1.6} />}
                >
                  {project.name}
                </NavLink>
                {project.id === activeProjectId ? (
                  <ul
                    aria-label={`${project.name} views`}
                    className="nav-unfold mb-1 ml-[1.15rem] mt-0.5 space-y-0.5 border-l border-border pl-2"
                  >
                    {projectViews(project.id, project.role !== 'reviewer').map((view) => (
                      <li key={view.key}>
                        <Link
                          href={view.href}
                          aria-current={view.key === projectView ? 'page' : undefined}
                          className={cn(
                            'nav-item flex h-8 items-center rounded-md px-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal max-lg:h-11',
                            view.key === projectView
                              ? 'bg-active font-medium text-text'
                              : 'text-muted-foreground hover:bg-raised hover:text-text'
                          )}
                        >
                          <span>{view.label}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </>
        ) : null}
      </nav>

      <div className="mt-auto border-t border-border pt-3">
        {/* A phone has no top bar menus, so notifications and the account also live here. */}
        <div className="lg:hidden">
          <p className="truncate px-2 text-xs text-muted-foreground" title={email}>
            {email}
          </p>
          <div className="mt-1">
            <NavLink
              href="/inbox"
              active={current === 'inbox'}
              icon={<Bell aria-hidden size={18} strokeWidth={1.6} />}
            >
              Notifications
            </NavLink>
            <NavLink
              href="/settings/security"
              active={current === 'security'}
              icon={<ShieldCheck aria-hidden size={18} strokeWidth={1.6} />}
            >
              Security
            </NavLink>
          </div>
        </div>
        <SettingsMenu
          current={current}
          appOwner={appOwner}
          payer={appOwner || tenant.role === 'owner'}
        />
        <form action={signOut} className="lg:hidden">
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
        'nav-item flex h-10 items-center gap-3 rounded-lg px-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal max-lg:h-11',
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
