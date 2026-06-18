import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOtlpPayload,
  emitRunMetrics,
  OtlpMetricsSink,
  type MetricSample,
  type RunMetricsInput,
} from '../src/metricsink';

const captured: { url?: string; body?: unknown; headers?: Record<string, string> } = {};

beforeEach(() => {
  captured.url = undefined;
  captured.body = undefined;
  captured.headers = undefined;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    captured.url = url;
    captured.body = init.body ? JSON.parse(init.body as string) : undefined;
    captured.headers = init.headers as Record<string, string>;
    return new Response('ok', { status: 204 });
  });
});

function makeSink(baseUrl = 'https://otlp.example/otlp'): OtlpMetricsSink {
  return new OtlpMetricsSink(
    {
      baseUrl,
      userId: '123456',
      apiToken: 'tok',
      resourceAttributes: {
        'service.name': 'fluxtube',
        'service.namespace': 'production',
        'service.instance.id': 'r1',
      },
    },
    () => {},
  );
}

function makeCtx(): { ctx: ExecutionContext; pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext,
    pending,
  };
}

const SAMPLE_SUMMARY: RunMetricsInput = {
  added: 3,
  marked_read: 2,
  skipped_tracked: 17,
  skipped_existing_in_playlist: 0,
  skipped_unavailable: 1,
  skipped_shorts: 4,
  entry_errors: 0,
  removal_errors: 0,
  quota_used: 251,
  duration_ms: 1234,
};

describe('OtlpMetricsSink', () => {
  it('is a no-op when no samples are buffered', async () => {
    const sink = makeSink();
    const { ctx, pending } = makeCtx();
    sink.flush(ctx);
    expect(pending).toHaveLength(0);
    expect(captured.url).toBeUndefined();
  });

  it('appends /v1/metrics to a base URL that omits it', async () => {
    const sink = makeSink('https://otlp.example/otlp');
    sink.push({ name: 'fluxtube.runs', value: 1, ts: new Date() });
    const { ctx, pending } = makeCtx();
    sink.flush(ctx);
    await Promise.all(pending);
    expect(captured.url).toBe('https://otlp.example/otlp/v1/metrics');
  });

  it('uses the base URL as-is when it already ends with /v1/metrics', async () => {
    const sink = makeSink('https://otlp.example/otlp/v1/metrics');
    sink.push({ name: 'fluxtube.runs', value: 1, ts: new Date() });
    const { ctx, pending } = makeCtx();
    sink.flush(ctx);
    await Promise.all(pending);
    expect(captured.url).toBe('https://otlp.example/otlp/v1/metrics');
  });

  it('sends Basic auth derived from userId:apiToken', async () => {
    const sink = makeSink();
    sink.push({ name: 'fluxtube.runs', value: 1, ts: new Date() });
    const { ctx, pending } = makeCtx();
    sink.flush(ctx);
    await Promise.all(pending);
    expect(captured.headers?.['Authorization']).toBe(`Basic ${btoa('123456:tok')}`);
  });

  it('does not throw when fetch rejects', async () => {
    const warned: { event?: string; fields?: Record<string, unknown> } = {};
    const sink = new OtlpMetricsSink(
      {
        baseUrl: 'https://otlp.example/otlp',
        userId: '1',
        apiToken: 't',
        resourceAttributes: { 'service.name': 'fluxtube' },
      },
      (event, fields) => {
        warned.event = event;
        warned.fields = fields;
      },
    );
    vi.stubGlobal('fetch', async () => {
      throw new Error('connection reset');
    });
    sink.push({ name: 'fluxtube.runs', value: 1, ts: new Date() });
    const { ctx, pending } = makeCtx();
    sink.flush(ctx);
    await Promise.all(pending);
    expect(warned.event).toBe('otlp_push_failed');
    expect(warned.fields).toMatchObject({ error: 'connection reset' });
  });

  it('clears the buffer after flush', async () => {
    const sink = makeSink();
    sink.push({ name: 'fluxtube.runs', value: 1, ts: new Date() });
    const { ctx, pending } = makeCtx();
    sink.flush(ctx);
    await Promise.all(pending);

    captured.url = undefined;
    sink.flush(ctx);
    expect(captured.url).toBeUndefined();
  });
});

describe('buildOtlpPayload', () => {
  it('groups samples by name into one metric with shared dataPoints', () => {
    const ts = new Date('2026-06-03T07:00:00Z');
    const samples: MetricSample[] = [
      { name: 'fluxtube.items.added', value: 3, ts },
      { name: 'fluxtube.items.added', value: 5, ts: new Date('2026-06-03T07:30:00Z') },
      { name: 'fluxtube.runs', value: 1, ts, attributes: { outcome: 'success' } },
    ];
    const payload = buildOtlpPayload(samples, { 'service.name': 'fluxtube' });

    expect(payload.resourceMetrics).toHaveLength(1);
    const rm = payload.resourceMetrics[0];
    if (rm === undefined) throw new Error('expected resourceMetrics[0]');
    expect(rm.resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'fluxtube' } },
    ]);
    const sm = rm.scopeMetrics[0];
    if (sm === undefined) throw new Error('expected scopeMetrics[0]');
    expect(sm.scope.name).toBe('@fluxtube/sync');

    expect(sm.metrics).toHaveLength(2);
    const added = sm.metrics.find((m) => m.name === 'fluxtube.items.added');
    expect(added?.gauge.dataPoints).toHaveLength(2);
    expect(added?.gauge.dataPoints[0]?.asDouble).toBe(3);

    const runs = sm.metrics.find((m) => m.name === 'fluxtube.runs');
    expect(runs?.gauge.dataPoints[0]?.attributes).toEqual([
      { key: 'outcome', value: { stringValue: 'success' } },
    ]);
  });

  it('encodes timeUnixNano as a string of ns-precision', () => {
    const ts = new Date(1748934000000); // arbitrary ms
    const samples: MetricSample[] = [{ name: 'fluxtube.runs', value: 1, ts }];
    const payload = buildOtlpPayload(samples, {});
    const dp =
      payload.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0]?.gauge.dataPoints[0];
    if (dp === undefined) throw new Error('expected one data point');
    expect(dp.timeUnixNano).toBe('1748934000000000000');
    expect(typeof dp.timeUnixNano).toBe('string');
  });
});

describe('emitRunMetrics', () => {
  it('pushes exactly 11 samples covering every RunMetricsInput field plus fluxtube.runs', () => {
    const pushed: MetricSample[] = [];
    const sink = { push: (s: MetricSample) => pushed.push(s), flush: () => {} };
    const ts = new Date();
    emitRunMetrics(sink, SAMPLE_SUMMARY, 'success', ts);

    expect(pushed).toHaveLength(11);

    const byName = new Map(pushed.map((s) => [s.name, s]));
    expect(byName.get('fluxtube.items.added')?.value).toBe(3);
    expect(byName.get('fluxtube.items.marked_read')?.value).toBe(2);
    expect(byName.get('fluxtube.items.skipped_tracked')?.value).toBe(17);
    expect(byName.get('fluxtube.items.skipped_existing_in_playlist')?.value).toBe(0);
    expect(byName.get('fluxtube.items.skipped_unavailable')?.value).toBe(1);
    expect(byName.get('fluxtube.items.skipped_shorts')?.value).toBe(4);
    expect(byName.get('fluxtube.errors.entry')?.value).toBe(0);
    expect(byName.get('fluxtube.errors.removal')?.value).toBe(0);
    expect(byName.get('fluxtube.quota.used')?.value).toBe(251);
    expect(byName.get('fluxtube.run.duration_seconds')?.value).toBe(1.234);

    const runs = byName.get('fluxtube.runs');
    expect(runs?.value).toBe(1);
    expect(runs?.attributes).toEqual({ outcome: 'success' });
    expect(runs?.ts).toBe(ts);
  });

  it('labels fluxtube.runs with the supplied outcome on failure', () => {
    const pushed: MetricSample[] = [];
    const sink = { push: (s: MetricSample) => pushed.push(s), flush: () => {} };
    emitRunMetrics(sink, SAMPLE_SUMMARY, 'fatal_invalid_grant', new Date());
    expect(pushed.find((s) => s.name === 'fluxtube.runs')?.attributes).toEqual({
      outcome: 'fatal_invalid_grant',
    });
  });
});
