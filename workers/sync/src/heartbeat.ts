import type { Logger } from './logger';

export type HeartbeatPhase = 'start' | 'success' | 'fail';

/**
 * Fire-and-forget Healthchecks.io ping. Never throws, never blocks the main
 * flow. A failed ping is logged at `warn` only.
 *
 * `baseUrl` is expected to be the bare ping URL (no trailing slash, no
 * `/fail` suffix). When `baseUrl` is undefined or empty, this is a no-op.
 *
 * The returned Promise resolves once the ping settles, so callers may pass
 * it to `ctx.waitUntil()` to keep the runtime alive long enough to flush
 * the request without awaiting it on the hot path.
 */
export function ping(
  baseUrl: string | undefined,
  phase: HeartbeatPhase,
  logger: Logger,
): Promise<void> {
  if (!baseUrl) return Promise.resolve();

  const trimmed = baseUrl.replace(/\/+$/, '');
  const url = phase === 'success' ? trimmed : `${trimmed}/${phase}`;

  return fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
  })
    .then((res) => {
      if (!res.ok) {
        logger.warn('heartbeat_ping_failed', { phase, status: res.status });
      } else {
        logger.debug('heartbeat_ping_ok', { phase });
      }
    })
    .catch((err: unknown) => {
      logger.warn('heartbeat_ping_failed', {
        phase,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}
