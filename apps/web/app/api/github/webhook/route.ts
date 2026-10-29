import { NextResponse, type NextRequest } from 'next/server';
import { isGithubDeliveryId, parseGithubDelivery, verifyGithubSignature } from '@specfix/ingest';
import {
  enqueueJob,
  installationForWebhook,
  recordGithubDelivery,
  removeGithubInstallation,
  repositoryForWebhook,
  setGithubInstallationSuspended,
} from '@/lib/repos';
import { readLimitedBytes } from '@/lib/read-limited';

/**
 * GitHub App webhook receiver (one URL for every installation).
 *
 * Order matters: the signature header must be present before the body is read; the body
 * is read with a byte cap; the HMAC is checked over those exact bytes before anything
 * parses them; the installation in the body decides the workspace; the delivery id is
 * recorded so GitHub's redeliveries are dropped; and then the work is queued. A pull
 * request delivery is only a signal: the worker re-reads the PR through the API.
 *
 * Responses are fixed and bodiless. 4xx for anything permanent (bad signature, oversized
 * body), 2xx for anything accepted or deliberately ignored, so GitHub does not retry it.
 */
const MAX_BODY_BYTES = 1_000_000;

const status = (code: number) => new NextResponse(null, { status: code });

export async function POST(request: NextRequest) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!secret) return status(503);

  const signature = request.headers.get('x-hub-signature-256');
  if (!signature) return status(401);

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return status(413);
  const raw = await readLimitedBytes(request, MAX_BODY_BYTES);
  if (raw === null) return status(413);

  if (!verifyGithubSignature(raw, signature, secret)) return status(401);

  const deliveryId = request.headers.get('x-github-delivery');
  if (!isGithubDeliveryId(deliveryId)) return status(400);

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return status(400);
  }
  const delivery = parseGithubDelivery(request.headers.get('x-github-event'), body);
  if (!delivery || delivery.event === 'ping') return status(204);

  try {
    const installation = await installationForWebhook(delivery.installationId);
    // An installation no workspace has connected (yet): nothing to do.
    if (!installation) return status(204);
    const tenantId = installation.tenant_id;

    const fresh = await recordGithubDelivery(tenantId, {
      deliveryId,
      event: delivery.event,
      action: delivery.action,
    });
    if (!fresh) return status(204);

    if (delivery.event === 'installation') {
      if (delivery.action === 'deleted') {
        await removeGithubInstallation(tenantId, delivery.installationId);
      } else if (delivery.action === 'suspend' || delivery.action === 'unsuspend') {
        await setGithubInstallationSuspended(
          tenantId,
          delivery.installationId,
          delivery.action === 'suspend'
        );
      }
      return status(202);
    }

    if (delivery.event === 'installation_repositories') {
      await enqueueJob(tenantId, {
        kind: 'github_repo_sync',
        payload: { installationId: delivery.installationId },
        dedupeKey: `gh-repos:${delivery.installationId}`,
      });
      return status(202);
    }

    if (installation.suspended) return status(204);
    // The repository is resolved through this installation and workspace only, so a
    // delivery cannot reach another workspace's repository by naming its id.
    const repo = await repositoryForWebhook(tenantId, delivery.installationId, delivery.repoId);
    if (!repo) return status(204);
    await enqueueJob(tenantId, {
      kind: 'github_pr_sync',
      payload: { repositoryId: repo.id, number: delivery.number },
      // A burst of pushes to one PR collapses into one pending re-read.
      dedupeKey: `gh-pr:${repo.id}:${delivery.number}`,
      maxAttempts: 4,
    });
    return status(202);
  } catch (error) {
    console.error(
      '[github] webhook handling failed',
      error instanceof Error ? error.name : 'error'
    );
    return status(500);
  }
}
