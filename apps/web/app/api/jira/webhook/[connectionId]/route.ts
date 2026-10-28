import { NextResponse, type NextRequest } from 'next/server';
import { parseWebhookDelivery, verifyWebhookAuthorization } from '@specfix/ingest';
import { connectionForWebhook, enqueueJob, recordWebhookDelivery } from '@/lib/repos';
import { readLimited } from '@/lib/read-limited';

/**
 * Jira webhook receiver for one tenant's connection (the id is in the URL the webhook
 * was registered with).
 *
 * A delivery is only a signal: it is authenticated (JWT signed with the app's client
 * secret), de-duplicated by X-Atlassian-Webhook-Identifier, and turned into a
 * jira_issue_sync job — the worker re-reads the issue through the API. Nothing in the
 * body is stored or trusted, so the response is fast and a replayed delivery can at
 * worst cause one harmless re-read.
 *
 * Status codes matter to Jira: it retries 408/409/425/429/5xx, so anything permanent
 * (bad signature, unknown connection) answers 4xx and anything accepted answers 2xx.
 */
const MAX_BODY_BYTES = 1_000_000;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  const secret = process.env.JIRA_CLIENT_SECRET?.trim();
  if (!secret) return new NextResponse(null, { status: 503 });

  if (!verifyWebhookAuthorization(request.headers.get('authorization'), secret)) {
    return new NextResponse(null, { status: 401 });
  }

  const { connectionId } = await params;
  const connection = await connectionForWebhook(connectionId);
  if (!connection) return new NextResponse(null, { status: 404 });

  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });

  const raw = await readLimited(request, MAX_BODY_BYTES);
  if (raw === null) return new NextResponse(null, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  const delivery = parseWebhookDelivery(body);
  if (!delivery?.issueId) return new NextResponse(null, { status: 204 });

  // A delivery for an issue on another site is not for this connection.
  if (delivery.siteOrigin && connection.site_url) {
    if (new URL(connection.site_url).origin !== delivery.siteOrigin) {
      return new NextResponse(null, { status: 204 });
    }
  }

  const deliveryId = request.headers.get('x-atlassian-webhook-identifier');
  if (deliveryId) {
    const fresh = await recordWebhookDelivery(connection.tenant_id, {
      deliveryId,
      event: delivery.webhookEvent,
      issueId: delivery.issueId,
    });
    if (!fresh) return new NextResponse(null, { status: 204 });
  }

  await enqueueJob(connection.tenant_id, {
    kind: 'jira_issue_sync',
    payload: { issueId: delivery.issueId },
    // A burst of edits to one issue collapses into one pending re-read.
    dedupeKey: `issue:${delivery.issueId}`,
    maxAttempts: 4,
  });
  return new NextResponse(null, { status: 202 });
}
