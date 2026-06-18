import { audit } from './audit';
import { parseCategoryPlaylistMapping } from './config';
import { emitRunMetrics } from './metricsink';
import { runSync } from './sync';
import { FatalError } from './types';
import type { MetricsSink } from './metricsink';
import type { Env } from './types';
import type { Logger } from './logger';
import type { SyncDeps } from './sync';

export type RouterDeps = SyncDeps;

/**
 * HTTP entrypoint for operator-driven actions. All routes require a Bearer
 * token matching `MANUAL_TRIGGER_TOKEN`. The Worker has no public-facing
 * unauthenticated surface.
 *
 * `POST /sync`         — kicks off a sync run in the background, returns 202.
 *                        No Healthchecks ping (those signal cron liveness,
 *                        not manual runs).
 * `POST /sync?wait=1`  — runs synchronously and returns 200 + the run summary
 *                        (counts of added / marked_read / errors / quota).
 * `GET  /audit`        — read-only diagnostic dump, returns JSON.
 */
export async function handleFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  logger: Logger,
  deps: RouterDeps,
  metrics?: MetricsSink,
): Promise<Response> {
  if (!authorized(request, env.MANUAL_TRIGGER_TOKEN)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const url = new URL(request.url);

  if (url.pathname === '/sync') {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    const requestId = crypto.randomUUID();
    const wait = url.searchParams.get('wait') === '1';
    const startedAt = new Date();
    logger.info('manual_sync_triggered', { request_id: requestId, wait });

    const mapping = parseCategoryPlaylistMapping(env.CATEGORY_PLAYLIST_MAPPING);

    if (wait) {
      try {
        const summary = await runSync(mapping, deps);
        if (metrics) emitRunMetrics(metrics, summary, 'success', startedAt);
        logger.info('manual_sync_complete', { request_id: requestId, ...summary });
        return jsonResponse(
          { status: 'completed', request_id: requestId, summary },
          200,
        );
      } catch (err) {
        const reason = err instanceof FatalError ? err.reason : undefined;
        logger.error('manual_sync_failed', {
          request_id: requestId,
          reason,
          message: err instanceof Error ? err.message : String(err),
        });
        if (metrics) {
          metrics.push({
            name: 'fluxtube.runs',
            value: 1,
            ts: startedAt,
            attributes: { outcome: fatalOutcomeAttr(reason) },
          });
        }
        return jsonResponse(
          {
            status: 'failed',
            request_id: requestId,
            reason: reason ?? 'unknown',
            message: err instanceof Error ? err.message : String(err),
          },
          500,
        );
      }
    }

    ctx.waitUntil(
      runSync(mapping, deps)
        .then((summary) => {
          if (metrics) emitRunMetrics(metrics, summary, 'success', startedAt);
          logger.info('manual_sync_complete', { request_id: requestId, ...summary });
        })
        .catch((err) => {
          const reason = err instanceof FatalError ? err.reason : undefined;
          if (metrics) {
            metrics.push({
              name: 'fluxtube.runs',
              value: 1,
              ts: startedAt,
              attributes: { outcome: fatalOutcomeAttr(reason) },
            });
          }
          logger.error('manual_sync_failed', {
            request_id: requestId,
            reason,
            message: err instanceof Error ? err.message : String(err),
          });
        }),
    );
    return jsonResponse({ status: 'accepted', request_id: requestId }, 202);
  }

  if (url.pathname === '/audit') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    const mapping = parseCategoryPlaylistMapping(env.CATEGORY_PLAYLIST_MAPPING);
    const report = await audit(mapping, deps);
    return jsonResponse(report, 200);
  }

  return jsonResponse({ error: 'not_found' }, 404);
}

function fatalOutcomeAttr(
  reason: string | undefined,
): 'fatal_invalid_grant' | 'fatal_quota_exhausted' | 'fatal_other' {
  if (reason === 'invalid_grant') return 'fatal_invalid_grant';
  if (reason === 'quota_exhausted') return 'fatal_quota_exhausted';
  return 'fatal_other';
}

function authorized(request: Request, expected: string): boolean {
  if (!expected) return false;
  const header = request.headers.get('Authorization');
  if (header === null) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match === null) return false;
  return timingSafeEqual(match[1] as string, expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function methodNotAllowed(allowed: string): Response {
  return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json', Allow: allowed },
  });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
