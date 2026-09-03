import type { NextConfig } from 'next';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

// The monorepo keeps a single .env at its root. Next only auto-loads .env from the
// app directory, so load the root file here — before the `env` block below reads
// process.env — so server code (pg via DATABASE_URL, the Supabase server client)
// sees exactly the configuration the rest of the workspace uses. dotenv does not
// overwrite variables that are already set, so a real deploy's platform env wins.
loadEnv({ path: resolve(process.cwd(), '../../.env') });

const nextConfig: NextConfig = {
  // @specfix/db and @specfix/shared ship raw TypeScript from src/ with no build
  // step, so Next has to compile them itself rather than treat them as opaque deps.
  transpilePackages: ['@specfix/db', '@specfix/shared'],

  // pg uses dynamic requires and native-ish internals; bundling it breaks it. Keep
  // it external and require it at runtime. It is only ever imported from server code.
  serverExternalPackages: ['pg'],

  // The Supabase URL and anon key are public by design (the anon key is meant to
  // ship to browsers). Bridge them from the root .env to the NEXT_PUBLIC_ names the
  // browser/auth client reads, so the secret material lives in exactly one file.
  env: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  },

  // The workspace is linted at the root with typescript-eslint; don't run Next's
  // separate eslint pass during builds.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
