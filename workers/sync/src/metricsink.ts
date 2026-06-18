/**
 * Buffered metric sample queued for shipping to Grafana Cloud's OTLP/HTTP
 * gateway. Each sample becomes one data point on a gauge metric. Samples
 * with the same `name` are grouped into a single OTLP `metric` entry
 * sharing a `dataPoints` array.
 */
export interface MetricSample {
  /**
   * Dot-style metric name (`fluxtube.items.added`). Mimir's OTLP receiver
   * converts dots to underscores so PromQL queries use `fluxtube_items_added`.
   */
  name: string;
  value: number;
  ts: Date;
  /**
   * Optional per-point attributes, e.g. `{ outcome: 'success' }` on the
   * `fluxtube.runs` metric. Become Prometheus labels.
   */
  attributes?: Record<string, string>;
}

export interface MetricsSink {
  push(sample: MetricSample): void;
  flush(ctx: ExecutionContext): void;
}

export interface OtlpConfig {
  /**
   * Base URL of the Grafana Cloud OpenTelemetry gateway, e.g.
   * `https://otlp-gateway-prod-us-east-0.grafana.net/otlp`. The sink
   * appends `/v1/metrics` if the URL doesn't already end with it, so
   * both forms work.
   */
  baseUrl: string;
  userId: string;
  apiToken: string;
  /**
   * Resource-level attributes attached to every sample.
   * Conventionally `{ 'service.name': 'fluxtube', 'service.namespace':
   * 'production', 'service.instance.id': '<run_id>' }`.
   */
  resourceAttributes: Record<string, string>;
}

/**
 * OTLP/HTTP JSON metrics sink for Grafana Cloud (Mimir-backed).
 *
 * Endpoint: `POST <baseUrl>/v1/metrics`, Basic auth `<userId>:<apiToken>`.
 * Payload follows the OpenTelemetry protocol JSON encoding for metrics —
 * see https://opentelemetry.io/docs/specs/otlp/#otlphttp.
 *
 * All metrics are emitted as gauges; cumulative counters would require
 * cross-invocation state which Workers can't carry cheaply. Aggregate
 * via `sum_over_time(metric[range])` in PromQL.
 *
 * Push is in-memory only; no network until `flush(ctx)`. Failures log a
 * warn callback but never throw — Grafana being down must not affect
 * the sync run.
 */
export class OtlpMetricsSink implements MetricsSink {
  private buffer: MetricSample[] = [];

  constructor(
    private readonly config: OtlpConfig,
    private readonly warn: (event: string, fields?: Record<string, unknown>) => void,
  ) {}

  push(sample: MetricSample): void {
    this.buffer.push(sample);
  }

  flush(ctx: ExecutionContext): void {
    if (this.buffer.length === 0) return;
    const samples = this.buffer;
    this.buffer = [];
    ctx.waitUntil(this.shipAndForget(samples));
  }

  private async shipAndForget(samples: MetricSample[]): Promise<void> {
    const url = this.endpointUrl();
    const credentials =
      typeof btoa === 'function'
        ? btoa(`${this.config.userId}:${this.config.apiToken}`)
        : Buffer.from(`${this.config.userId}:${this.config.apiToken}`).toString('base64');

    const body = JSON.stringify(buildOtlpPayload(samples, this.config.resourceAttributes));

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
        this.warn('otlp_push_failed', {
          status: res.status,
          body: text.slice(0, 200),
        });
      }
    } catch (err) {
      this.warn('otlp_push_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private endpointUrl(): string {
    const trimmed = this.config.baseUrl.replace(/\/+$/, '');
    return trimmed.endsWith('/v1/metrics') ? trimmed : `${trimmed}/v1/metrics`;
  }
}

/**
 * Build the OTLP/HTTP JSON payload from buffered samples. Samples sharing
 * the same `name` are grouped into one metric with multiple `dataPoints`.
 * Exported for tests; not part of the public sink interface.
 */
export function buildOtlpPayload(
  samples: MetricSample[],
  resourceAttributes: Record<string, string>,
): OtlpPayload {
  const byName = new Map<string, MetricSample[]>();
  for (const sample of samples) {
    const list = byName.get(sample.name);
    if (list === undefined) {
      byName.set(sample.name, [sample]);
    } else {
      list.push(sample);
    }
  }

  const metrics: OtlpMetric[] = [];
  for (const [name, points] of byName) {
    metrics.push({
      name,
      gauge: {
        dataPoints: points.map((p) => ({
          timeUnixNano: toNanoTimestamp(p.ts),
          asDouble: p.value,
          attributes: toAttributes(p.attributes),
        })),
      },
    });
  }

  return {
    resourceMetrics: [
      {
        resource: { attributes: toAttributes(resourceAttributes) },
        scopeMetrics: [
          {
            scope: { name: '@fluxtube/sync' },
            metrics,
          },
        ],
      },
    ],
  };
}

/**
 * Push the 11 gauge samples that summarise one `runSync` invocation onto
 * the sink. All samples share the same timestamp so they line up on the
 * dashboard's time axis. `outcome` labels the `fluxtube.runs` gauge.
 */
export function emitRunMetrics(
  sink: MetricsSink,
  summary: RunMetricsInput,
  outcome: 'success' | 'fatal_invalid_grant' | 'fatal_quota_exhausted' | 'fatal_other',
  ts: Date,
): void {
  const push = (name: string, value: number, attributes?: Record<string, string>): void => {
    sink.push({ name, value, ts, ...(attributes ? { attributes } : {}) });
  };

  push('fluxtube.items.added', summary.added);
  push('fluxtube.items.marked_read', summary.marked_read);
  push('fluxtube.items.skipped_tracked', summary.skipped_tracked);
  push('fluxtube.items.skipped_existing_in_playlist', summary.skipped_existing_in_playlist);
  push('fluxtube.items.skipped_unavailable', summary.skipped_unavailable);
  push('fluxtube.items.skipped_shorts', summary.skipped_shorts);
  push('fluxtube.errors.entry', summary.entry_errors);
  push('fluxtube.errors.removal', summary.removal_errors);
  push('fluxtube.quota.used', summary.quota_used);
  push('fluxtube.run.duration_seconds', summary.duration_ms / 1000);
  push('fluxtube.runs', 1, { outcome });
}

/**
 * Same as a `RunSummary` from sync.ts. Re-declared here to keep this
 * module free of imports from the sync core so it can be unit-tested
 * without dragging in D1 / Worker globals.
 */
export interface RunMetricsInput {
  added: number;
  marked_read: number;
  skipped_tracked: number;
  skipped_existing_in_playlist: number;
  skipped_unavailable: number;
  skipped_shorts: number;
  entry_errors: number;
  removal_errors: number;
  quota_used: number;
  duration_ms: number;
}

function toAttributes(attrs: Record<string, string> | undefined): OtlpAttribute[] {
  if (attrs === undefined) return [];
  return Object.entries(attrs).map(([key, value]) => ({
    key,
    value: { stringValue: value },
  }));
}

function toNanoTimestamp(date: Date): string {
  return `${date.getTime()}000000`;
}

// ── OTLP/HTTP JSON schema (subset) ───────────────────────────────────────────
// https://opentelemetry.io/docs/specs/otlp/#otlphttp

interface OtlpAttribute {
  key: string;
  value: { stringValue: string };
}

interface OtlpDataPoint {
  timeUnixNano: string;
  asDouble: number;
  attributes: OtlpAttribute[];
}

interface OtlpMetric {
  name: string;
  gauge: { dataPoints: OtlpDataPoint[] };
}

interface OtlpScopeMetrics {
  scope: { name: string };
  metrics: OtlpMetric[];
}

interface OtlpResourceMetrics {
  resource: { attributes: OtlpAttribute[] };
  scopeMetrics: OtlpScopeMetrics[];
}

export interface OtlpPayload {
  resourceMetrics: OtlpResourceMetrics[];
}
