import { parseCategoryPlaylistMapping } from './config';
import { ping } from './heartbeat';
import { createLogger, parseLogLevel } from './logger';
import { LokiSink } from './logsink';
import { emitRunMetrics, OtlpMetricsSink } from './metricsink';
import { MinifluxClient } from './miniflux';
import { handleFetch } from './router';
import { QueueState } from './state';
import { runSync, type SyncDeps } from './sync';
import { FatalError } from './types';
import { YouTubeClient } from './youtube';
import type { LogSink } from './logsink';
import type { MetricsSink } from './metricsink';
import type { Env } from './types';
import type { Logger } from './logger';

function buildDeps(env: Env, logger: Logger): SyncDeps {
  const miniflux = new MinifluxClient(env.MINIFLUX_URL, env.MINIFLUX_API_TOKEN);
  const youtube = new YouTubeClient({
    clientId: env.YOUTUBE_CLIENT_ID,
    clientSecret: env.YOUTUBE_CLIENT_SECRET,
    refreshToken: env.YOUTUBE_REFRESH_TOKEN,
  });
  const state = new QueueState(env.DB);
  return { miniflux, youtube, state, logger };
}

/**
 * Construct a LokiSink iff all three GRAFANA_LOKI_* env vars are set.
 * A `run_id` label is added so the operator can group all lines from a
 * single invocation in Grafana Explore (`{run_id="..."}`).
 */
function buildLokiSink(env: Env, runId: string): LogSink | undefined {
  if (!env.GRAFANA_LOKI_URL || !env.GRAFANA_LOKI_USER || !env.GRAFANA_LOKI_TOKEN) {
    return undefined;
  }
  return new LokiSink(
    {
      baseUrl: env.GRAFANA_LOKI_URL,
      userId: env.GRAFANA_LOKI_USER,
      apiToken: env.GRAFANA_LOKI_TOKEN,
      labels: { app: 'fluxtube', env: 'production', run_id: runId, version: VERSION },
    },
    warnToStderr,
  );
}

/**
 * Construct an OtlpMetricsSink iff all three GRAFANA_OTLP_* env vars are
 * set. `service.instance.id` carries the run_id so an operator can pivot
 * from a Loki log line to its metric data points using the same UUID.
 */
function buildMetricsSink(env: Env, runId: string): MetricsSink | undefined {
  if (!env.GRAFANA_OTLP_URL || !env.GRAFANA_OTLP_USER || !env.GRAFANA_OTLP_TOKEN) {
    return undefined;
  }
  return new OtlpMetricsSink(
    {
      baseUrl: env.GRAFANA_OTLP_URL,
      userId: env.GRAFANA_OTLP_USER,
      apiToken: env.GRAFANA_OTLP_TOKEN,
      resourceAttributes: {
        'service.name': 'fluxtube',
        'service.namespace': 'production',
        'service.instance.id': runId,
        'service.version': VERSION,
      },
    },
    warnToStderr,
  );
}

// Use console.warn directly rather than the logger so a sink that fails
// while emitting its own warn line can't recurse back into itself.
function warnToStderr(event: string, fields?: Record<string, unknown>): void {
  console.warn(
    JSON.stringify({ ts: new Date().toISOString(), level: 'warn', event, ...(fields ?? {}) }),
  );
}

function fatalOutcome(err: unknown): 'fatal_invalid_grant' | 'fatal_quota_exhausted' | 'fatal_other' {
  if (err instanceof FatalError) {
    if (err.reason === 'invalid_grant') return 'fatal_invalid_grant';
    if (err.reason === 'quota_exhausted') return 'fatal_quota_exhausted';
  }
  return 'fatal_other';
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const runId = crypto.randomUUID();
    const sink = buildLokiSink(env, runId);
    const metrics = buildMetricsSink(env, runId);
    const logger = createLogger(parseLogLevel(env.SYNC_LOG_LEVEL), sink);
    const startedAt = new Date();

    // Optional start-ping; fire-and-forget but kept alive past the handler.
    if (env.HEARTBEAT_URL) {
      ctx.waitUntil(ping(env.HEARTBEAT_URL, 'start', logger));
    }

    try {
      const mapping = parseCategoryPlaylistMapping(env.CATEGORY_PLAYLIST_MAPPING);
      const summary = await runSync(mapping, buildDeps(env, logger));

      if (metrics) {
        emitRunMetrics(metrics, summary, 'success', startedAt);
        metrics.flush(ctx);
      }
      if (env.HEARTBEAT_URL) {
        ctx.waitUntil(ping(env.HEARTBEAT_URL, 'success', logger));
      }
      logger.flush(ctx);
    } catch (err) {
      const reason =
        err instanceof FatalError
          ? err.reason
          : err instanceof Error
            ? err.name || 'unknown'
            : 'unknown';
      logger.error('fatal', {
        reason,
        message: err instanceof Error ? err.message : String(err),
      });

      // Per-reason failure routing: a FatalError tagged invalid_grant pings
      // the AUTH check; quota_exhausted pings the QUOTA check. Both are
      // optional; missing URLs are no-ops. The main HEARTBEAT_URL is always
      // pinged in addition so the primary dashboard view stays correlated.
      if (err instanceof FatalError) {
        if (err.reason === 'invalid_grant' && env.HEARTBEAT_URL_AUTH) {
          ctx.waitUntil(ping(env.HEARTBEAT_URL_AUTH, 'fail', logger));
        }
        if (err.reason === 'quota_exhausted' && env.HEARTBEAT_URL_QUOTA) {
          ctx.waitUntil(ping(env.HEARTBEAT_URL_QUOTA, 'fail', logger));
        }
      }
      if (env.HEARTBEAT_URL) {
        ctx.waitUntil(ping(env.HEARTBEAT_URL, 'fail', logger));
      }
      // Emit the fluxtube.runs metric with the failure outcome so the
      // success-rate panel reflects the run. We don't emit the per-summary
      // gauges — runSync didn't return a summary.
      if (metrics) {
        metrics.push({
          name: 'fluxtube.runs',
          value: 1,
          ts: startedAt,
          attributes: { outcome: fatalOutcome(err) },
        });
        metrics.flush(ctx);
      }
      logger.flush(ctx);
      throw err;
    }
  },

  // Manual operator endpoints. Auth + routing live in `router.ts`.
  // Intentionally does NOT ping Healthchecks — those are the cron's dead-man
  // switch; satisfying them from a manual call would mask a stuck schedule.
  // The MetricsSink is built but only emitted from inside `runSync` paths
  // (the router calls runSync for /sync, but not for /audit) — flushed
  // unconditionally in `finally` so any buffered points (e.g. a manual /sync
  // run) ship before the request returns.
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const runId = crypto.randomUUID();
    const sink = buildLokiSink(env, runId);
    const metrics = buildMetricsSink(env, runId);
    const logger = createLogger(parseLogLevel(env.SYNC_LOG_LEVEL), sink);
    try {
      return await handleFetch(request, env, ctx, logger, buildDeps(env, logger), metrics);
    } finally {
      metrics?.flush(ctx);
      logger.flush(ctx);
    }
  },
} satisfies ExportedHandler<Env>;
