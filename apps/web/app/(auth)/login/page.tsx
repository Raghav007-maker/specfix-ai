import { redirect } from 'next/navigation';
import { getUser } from '@/lib/session';
import { signIn, signUp } from '@/app/(auth)/actions';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '@/components/ui';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  // A signed-in user has no business on the login page.
  if (await getUser()) redirect('/');

  const { error, message } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">SpecFix</CardTitle>
          <p className="text-sm text-muted-foreground">
            Sign in to review requirements before development starts.
          </p>
        </CardHeader>
        <CardContent>
          <form className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" autoComplete="email" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                minLength={6}
              />
            </div>

            {error ? (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {message ? (
              <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                {message}
              </p>
            ) : null}

            <div className="flex gap-3">
              <Button type="submit" formAction={signIn} className="flex-1">
                Sign in
              </Button>
              <Button type="submit" formAction={signUp} variant="outline" className="flex-1">
                Create account
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
