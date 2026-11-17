import { requireUser } from '@/lib/session';
import { currentMemberships, requireTenant } from '@/lib/tenant';
import { listProjects } from '@/lib/repos';
import { createClient } from '@/lib/supabase/server';
import { AppShell } from '@/components/app-shell';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Notice,
  Pill,
} from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { disableTotp } from './actions';
import { TotpSetup } from './totp-setup';

const PROVIDER_NAMES: Record<string, string> = { email: 'Email and password', google: 'Google' };

/** Your account's sign-in security: two-step verification and the ways you can sign in. */
export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const user = await requireUser();
  const [memberships, { error, notice }, supabase] = await Promise.all([
    currentMemberships(user.id),
    searchParams,
    createClient(),
  ]);
  const tenant = await requireTenant(user.id, memberships);
  const [projects, factors] = await Promise.all([
    listProjects(tenant.tenant_id),
    supabase.auth.mfa.listFactors(),
  ]);
  const enabled = factors.data?.totp.some((f) => f.status === 'verified') ?? false;
  const methods = [...new Set((user.identities ?? []).map((i) => i.provider))];

  return (
    <AppShell
      user={user}
      tenant={tenant}
      projects={projects}
      current="security"
      breadcrumb={
        <p className="flex min-w-0 items-center gap-2 text-sm">
          <span className="truncate text-muted-foreground">{user.email}</span>
          <span aria-hidden className="text-muted-foreground">
            /
          </span>
          <span className="truncate">Security</span>
        </p>
      }
    >
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-[-0.012em]">Security</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          How you sign in to SpecFix. These settings are yours, in every workspace.
        </p>
      </div>

      {error ? (
        <Notice tone="error" className="mb-6">
          {error}
        </Notice>
      ) : null}
      {notice ? (
        <Notice tone="success" className="mb-6">
          {notice}
        </Notice>
      ) : null}

      <div className="grid max-w-3xl gap-6">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">Two-step verification</CardTitle>
              <Pill tone={enabled ? 'positive' : 'neutral'}>{enabled ? 'On' : 'Off'}</Pill>
            </div>
            <p className="text-sm text-muted-foreground">
              After your password or Google, SpecFix asks for a 6-digit code from an authenticator
              app on your phone, so a stolen password alone cannot open your account.
            </p>
          </CardHeader>
          <CardContent>
            {factors.error ? (
              <Notice tone="error">Could not read your settings. Reload the page.</Notice>
            ) : enabled ? (
              <form action={disableTotp} className="flex flex-wrap items-end gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="disable-code">Current code</Label>
                  <Input
                    id="disable-code"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={7}
                    required
                    className="w-40"
                  />
                </div>
                <SubmitButton variant="destructive" pendingLabel="Turning off…">
                  Turn off
                </SubmitButton>
              </form>
            ) : (
              <TotpSetup />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Ways to sign in</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {methods.map((m) => (
                <li key={m}>{PROVIDER_NAMES[m] ?? m}</li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              Signing in with Google uses the same account when the Google email matches.
            </p>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
