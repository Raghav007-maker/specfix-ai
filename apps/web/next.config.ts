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
  // Azure deploys the self-contained server (.next/standalone) so the host never runs npm
  // install or a build. The tracing root is the monorepo root so @specfix/* get traced in.
  output: 'standalone',
  outputFileTracingRoot: resolve(process.cwd(), '../../'),
  // The Spec Compiler and the agent read their prompt files from disk at run time; tracing
  // cannot always see a path built from import.meta.url, so ship them explicitly.
  outputFileTracingIncludes: { '/**': ['../../packages/*/prompts/*.md'] },

  // @specfix/* workspaces ship raw TypeScript from src/ with no build step, so Next
  // has to compile them itself rather than treat them as opaque deps. @specfix/compiler
  // and @specfix/core are here because the Specs tab's generate action calls the Spec
  // Compiler inline (there is no worker yet), and @specfix/agent because the Conversation
  // tab's send action runs an agent turn inline for the same reason. @specfix/ingest holds
  // the GitHub App client and the CI report parser, and @specfix/sync the analysis cost
  // estimate.
  transpilePackages: [
    '@specfix/db',
    '@specfix/ingest',
    '@specfix/sync',
    '@specfix/shared',
    '@specfix/core',
    '@specfix/compiler',
    '@specfix/agent',
  ],

  // pg uses dynamic requires and native-ish internals; bundling it breaks it. openai
  // ships its own runtime shims and is only ever reached from a server action (the
  // generate path), so keep both external and require them at runtime.
  serverExternalPackages: ['pg', 'openai'],

  // Task attachments are posted to a server action; 10 MB files plus the form's own fields.
  // The action re-checks the size, so this is only the transport ceiling.
  // Middleware also buffers request bodies, by default only up to 10 MB.
  experimental: {
    serverActions: { bodySizeLimit: '11mb' },
    middlewareClientMaxBodySize: '11mb',
  },

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

  // Don't advertise the framework.
  poweredByHeader: false,

  // Baseline security headers on every response. The Content-Security-Policy, which needs a
  // per-request nonce, is set by middleware.ts (see lib/csp.ts).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // Browsers ignore HSTS over plain http, so this is harmless on localhost.
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        ],
      },
    ];
  },
};

export default nextConfig;
