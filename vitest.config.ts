import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

import 'dotenv/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    setupFiles: ['dotenv/config', r('./test/setup-db.ts')],
  },
  resolve: {
    alias: {
      '@specfix/shared': r('./packages/shared/src/index.ts'),
      '@specfix/core': r('./packages/core/src/index.ts'),
      '@specfix/db': r('./packages/db/src/index.ts'),
      '@specfix/ingest': r('./packages/ingest/src/index.ts'),
      '@specfix/eval': r('./packages/eval/src/index.ts'),
    },
  },
});
