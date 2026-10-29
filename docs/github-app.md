# GitHub App — setup and how it works

SpecFix connects to GitHub as a **GitHub App** (not an OAuth app and not a personal token):
it acts on the repositories an organisation chooses, with short-lived installation tokens,
and every webhook delivery is signed.

What it does once connected:

- **Links PRs to tickets** by the Jira key (`CART-12`) in the PR's branch name, title or body.
  Branches match in any case (`feature/cart-12-limit`); title and body need the key in upper
  case. Keys are only matched against tickets of the project the repository is mapped to.
- **Reports acceptance on the PR** as a check run named **"SpecFix acceptance"**
  (e.g. "4/5 scenarios passing"; conclusion `success`, `failure`, or `neutral` when nothing
  was reported) on the PR's head commit, from the Playwright report CI posts to
  `/api/ci/results`.
- **Warns on the PR** (one comment, edited in place, never duplicated) while a linked ticket
  is not "Ready for development". When the ticket is signed off, the same comment says so.
- **Opens a PR with scaffolds**: the Specs tab's "Open PR with scaffolds" (owner/admin)
  commits the ticket's approved Playwright scaffolds to `specfix/<KEY>` under
  `tests/specfix/<KEY>/` and opens a PR into the default branch. Clicking again reuses it.
- **Keeps a ticket's CI status honest**: only runs on the repository's default branch set the
  ticket's CI status. PR and feature-branch runs are shown per PR on the ticket's Specs tab.

## 1. Register the app (a person does this, once)

Use an account that owns the team's GitHub organisation, not a personal account.

1. GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**
   (for an organisation: *Organization settings → Developer settings → GitHub Apps*).
2. **GitHub App name**: `SpecFix` (or `SpecFix (staging)`). The URL name GitHub derives from
   it is the **slug** (`https://github.com/apps/<slug>`).
3. **Homepage URL**: the app's public URL.
4. **Callback URL**: `https://<public host>/api/github/callback`
   (locally: `http://localhost:3000/api/github/callback`).
   - Tick **Request user authorization (OAuth) during installation**. This is required:
     SpecFix uses the one-time code to confirm that the person who installed the app can see
     that installation, so nobody can attach another organisation's installation id.
   - Leave **Expire user authorization tokens** on (SpecFix never stores the user token).
   - *Setup URL* is greyed out once OAuth-during-install is ticked; that is expected.
5. **Webhook**: active. **Webhook URL**: `https://<public host>/api/github/webhook`.
   GitHub must be able to reach it, so locally use a tunnel (ngrok, cloudflared).
   **Webhook secret**: generate a long random string yourself, e.g.
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
6. **Repository permissions** (nothing else):

   | Permission    | Access         | Used for                                      |
   |---------------|----------------|-----------------------------------------------|
   | Checks        | Read and write | the "SpecFix acceptance" check run            |
   | Pull requests | Read and write | reading PRs, the "not ready" comment, opening the scaffold PR |
   | Contents      | Read and write | committing scaffolds to the `specfix/<KEY>` branch |
   | Metadata      | Read-only      | mandatory; repository list and default branch |

   Note: PR comments go through the Issues comments API, which GitHub authorises with
   *Pull requests: write* for comments on pull requests.
7. **Subscribe to events**: `Pull request`. (`Installation` and
   `Installation repositories` are always delivered to GitHub Apps; there is no checkbox.)
8. **Where can this GitHub App be installed?** "Only on this account" while testing; "Any
   account" before another company connects.
9. Create the app. On its page:
   - note the **App ID** and **Client ID**;
   - **Generate a new client secret**;
   - **Generate a private key** (downloads a `.pem`).

## 2. Configure the server

Add to the root `.env` (never commit it; `.env.example` lists the names):

```
GITHUB_APP_ID=            # App ID (numbers)
GITHUB_APP_SLUG=          # the app's URL name
GITHUB_APP_CLIENT_ID=     # Client ID (Iv1… / Iv23…)
GITHUB_APP_CLIENT_SECRET= # client secret from step 9
GITHUB_APP_PRIVATE_KEY=   # the .pem: base64 of the whole file, or the PEM with \n escapes
GITHUB_WEBHOOK_SECRET=    # the webhook secret from step 5
TOKEN_ENCRYPTION_KEY=     # already set for Jira; also encrypts cached installation tokens
PUBLIC_BASE_URL=          # https origin; used for links in checks and PR comments
```

To put the private key on one line (PowerShell):
`[Convert]::ToBase64String([IO.File]::ReadAllBytes("specfix.private-key.pem"))`
(bash: `base64 -w0 specfix.private-key.pem`). Delete the downloaded `.pem` once it is in
the secret store.

Apply migration `0016_github_app.sql` (`npm run db:migrate`, run by a person) and restart the
app and the worker (`npm run worker`): check runs, PR comments and repository refreshes are
done by the worker.

## 3. Connect a workspace

1. Settings → Integrations → **Connect GitHub** (owner or admin). GitHub asks which
   repositories to grant, then asks the person to authorise SpecFix (the ownership check).
2. Back in SpecFix, map each repository to a project. Unmapped repositories link PRs to
   tickets of any project in the workspace but never set a project's CI status.
3. In CI, post the Playwright report with the step shown under *CI test results*. On a pull
   request it sends the PR's head commit, branch and number, and `$GITHUB_REPOSITORY`.

## 4. Security notes

- Webhooks: `X-Hub-Signature-256` is verified (HMAC-SHA256, constant-time) over the exact
  body bytes before parsing; bodies over 1 MB are refused, chunked or not; deliveries are
  de-duplicated by `X-GitHub-Delivery`; responses are fixed and bodiless.
- The installation in a delivery decides the workspace; a repository is only resolved through
  that installation, so a delivery cannot reach another workspace's repository.
- The app JWT (RS256, ≤10 minutes) is made in memory from `GITHUB_APP_PRIVATE_KEY`.
  Installation tokens are cached AES-256-GCM-encrypted (bound to tenant and installation),
  refreshed under a row lock, and never logged.
- Text posted to GitHub is built from ticket keys, counts and SpecFix links only — never from
  ticket titles or scenario text.

## 5. Still to verify with a real app

These were built against GitHub's documented API and an in-memory fake; confirm them once a
real app and a public HTTPS URL exist:

- that the `state` parameter of the install URL comes back on the OAuth-during-install
  callback together with `code` and `installation_id`;
- the check run appears on the PR with the expected title and conclusion, and the comment is
  edited (not re-posted) on later pushes;
- "Open PR with scaffolds" on a repository with branch protection and on an empty repository;
- `installation` / `installation_repositories` deliveries (suspend, remove a repository).
