import type { LogLevel } from './types';

/**
 * Buffered log entry queued for shipping to an external sink. Shape mirrors
 * what `createLogger().emit` already builds for stdout: ISO timestamp,
 * severity, structured `event` name, and an arbitrary JSON fields bag.
 */
export interface LogEntry {
  ts: Date;
  level: LogLevel;
  event: string;
  fields?: Record<string, unknown>;
}

/**
 * Pluggable log sink. The Worker logger fans every emitted line out to one
 * of these in addition to stdout. `flush` is called once at the end of a
 * run (success or fatal); the implementation typically batches in `push`
 * and ships via `ctx.waitUntil(fetch(...))` so a slow Loki does not stretch
 * the run's wall time.
 */
export interface LogSink {
  push(entry: LogEntry): void;
  flush(ctx: ExecutionContext): void;
}

export interface LokiConfig {
  /** Base URL of the Grafana Cloud Loki instance, e.g. `https://logs-prod-006.grafana.net`. */
  baseUrl: string;
  /** Numeric user ID from Grafana Cloud (the part before `:` in the auth pair). */
  userId: string;
  /** API token with `logs:write` scope. */
  apiToken: string;
  /** Static labels attached to every stream — `{ app: 'fluxtube', env: 'production', run_id: '...' }`. */
  labels: Record<string, string>;
}

/**
 * Loki HTTP push sink.
 *
 * Free tier endpoint: `POST <baseUrl>/loki/api/v1/push`, Basic auth
 * `<userId>:<apiToken>`. Payload is `{ streams: [{ stream: {<labels>},
 * values: [[<ns_ts>, <json line>], ...] }] }`.
 *
 * Push is in-memory only; no network until `flush(ctx)`. A flush with no
 * buffered entries is a no-op (no empty payload). Failures log at warn
 * level but never throw — Loki being down must not affect the sync run.
 */
export class LokiSink implements LogSink {
  private buffer: LogEntry[] = [];

  constructor(
    private readonly config: LokiConfig,
    private readonly warn: (event: string, fields?: Record<string, unknown>) => void,
  ) {}

  push(entry: LogEntry): void {
    this.buffer.push(entry);
  }

  flush(ctx: ExecutionContext): void {
    if (this.buffer.length === 0) return;
    const entries = this.buffer;
    this.buffer = [];
    ctx.waitUntil(this.shipAndForget(entries));
  }

  private async shipAndForget(entries: LogEntry[]): Promise<void> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/loki/api/v1/push`;
    const credentials =
      typeof btoa === 'function'
        ? btoa(`${this.config.userId}:${this.config.apiToken}`)
        : Buffer.from(`${this.config.userId}:${this.config.apiToken}`).toString('base64');

    // Loki accepts one or more streams. We send a single stream per run with
    // a run_id label so an operator can group all lines from one invocation
    // in Explore. Sorting is required: timestamps must be non-decreasing.
    const values: [string, string][] = entries
      .slice()
      .sort((a, b) => a.ts.getTime() - b.ts.getTime())
      .map((entry) => [
        toNanoTimestamp(entry.ts),
        JSON.stringify({
          ts: entry.ts.toISOString(),
          level: entry.level,
          event: entry.event,
          ...(entry.fields ?? {}),
        }),
      ]);

    const body = JSON.stringify({
      streams: [{ stream: this.config.labels, values }],
    });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${credentials}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '<no body>');
        this.warn('loki_push_failed', {
          status: res.status,
          body: text.slice(0, 200),
        });
      }
    } catch (err) {
      this.warn('loki_push_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Nanosecond Unix timestamp as a string — Loki's expected format. `getTime`
 * returns ms, so we left-pad with `000000` for ns precision.
 */
function toNanoTimestamp(date: Date): string {
  return `${date.getTime()}000000`;
}
