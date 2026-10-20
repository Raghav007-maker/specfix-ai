# 09 — Environment & Deployment

## 1. Prerequisites & System Requirements

* **Runtime:** Node.js `>=22.0.0` (tested with v22.9.0 / v24.14.1)
* **Package Manager:** npm `>=10.0.0` (with npm workspaces support)
* **Database Engine:** PostgreSQL `>=16.0` with `vector` extension enabled (`pgvector`)
* **AI Provider:** Azure OpenAI Service account (or standard OpenAI API key)

---

## 2. Environment Variables Specification

Configure `.env` in the repository root. **Never commit `.env` to version control.**

### 1. Azure OpenAI Configuration
* `AZURE_OPENAI_ENDPOINT`: Full endpoint URL (e.g. `https://<resource>.openai.azure.com/`).
* `AZURE_OPENAI_API_KEY`: Secret key from Azure Portal under *Keys and Endpoint*.
* `AZURE_OPENAI_API_VERSION`: API version string (e.g. `2024-10-21`).
* `OPENAI_MODEL_EXTRACT`: Azure deployment name for extractor pass (e.g. `gpt-5.4-mini` or `gpt-4o-mini`).
* `OPENAI_MODEL_JUDGE`: Azure deployment name for critic pass (e.g. `gpt-5.4-mini`).
* `OPENAI_MODEL_COMPILE`: Azure deployment name for spec compiler (e.g. `gpt-5.4-mini`).
* `OPENAI_MODEL_EMBED`: Azure deployment name for embeddings (e.g. `text-embedding-3-small`).

### 2. Standard OpenAI Fallback (Alternative to Azure)
* `OPENAI_API_KEY`: Standard OpenAI API key (`sk-...`).
* `OPENAI_BASE_URL`: Optional custom base URL or reverse proxy endpoint.

### 3. Model Parameters & Spend Limits
* `OPENAI_TEMPERATURE`: Sampling temperature (set to `0` for determinism).
* `OPENAI_SEED`: Integer seed (e.g. `1337`) for reproducible evaluations.
* `MAX_TICKET_INPUT_TOKENS`: Maximum character token limit before input truncation (default `8000`).
* `MONTHLY_TOKEN_CAP`: Tenant monthly token threshold (default `5000000`).

### 4. Supabase & Database Configuration
* `DATABASE_URL`: Full PostgreSQL connection string (`postgresql://postgres:<password>@<host>:5432/postgres`).
* `PG_TIMEOUT_MS`: Connection pool connection timeout in milliseconds (default `30000`).
* `SUPABASE_URL`: Supabase project URL (`https://<project>.supabase.co`).
* `SUPABASE_ANON_KEY`: Public/anonymous JWT API key for browser client sessions.
* `SUPABASE_SERVICE_ROLE_KEY`: Service role key for backend admin operations bypassing RLS.
* `SPECFIX_TEST_DATABASE_URL`: Dedicated database for destructive integration test fixtures (isolated from production).
* `SPECFIX_TENANT_ID`: Active workspace UUID for CLI scripts (`scripts/ops.ts`, `embed-backfill.ts`).

---

## 3. Developer Onboarding & Local Setup

Execute the following commands to initialize a development environment:

```bash
# 1. Clone repository & install dependencies
git clone <repo-url>
cd miniproject3rd\ year
npm ci

# 2. Configure environment
cp .env.example .env
# Edit .env and supply Azure OpenAI and Supabase credentials

# 3. Apply database migrations
npm run db:migrate

# 4. Verify TypeScript and code formatting
npm run typecheck
npm run lint
npm run format:check

# 5. Run test suite
npx vitest run

# 6. Seed fixture workspace (creates initial user, tenant, and sample tickets)
npm run ops -- provision --email admin@example.com --password YourPassword123!
npm run ops -- seed --owner admin@example.com --tenant "Acme Corp" --project "Checkout" --dir fixtures/tickets/sample --analyze

# 7. Start local development server
npm run dev
# Web application available at http://localhost:3000
```

---

## 4. CI/CD & Operational Deployment

### GitHub Actions Workflow (`.github/workflows/ci.yml`)
* **Trigger:** Push to `main` branch or pull requests.
* **Services:** Spins up container `pgvector/pgvector:pg16` on port `5432`.
* **Steps Executed:**
  1. `npm ci`
  2. `npm run format:check`
  3. `npm run lint`
  4. `npm run typecheck`
  5. `npm run db:migrate -- --shim` (Applies `auth-shim.sql` and migrations 0001–0004)
  6. `npm test` (Runs all unit tests and database tenant-isolation tests against container)
  7. `npm run eval -- validate --set gold-v1`
  8. `npm audit --audit-level=high` (Informational advisory)

### Production Deployment Strategy
* **Web App (`apps/web`):** Deployable to Vercel, Railway, or AWS Amplify via standard Next.js build (`npm run build`).
* **Database:** Hosted Supabase PostgreSQL instance with pgvector extension enabled.
