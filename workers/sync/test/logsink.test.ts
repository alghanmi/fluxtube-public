import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LokiSink } from '../src/logsink';

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

function makeSink(): LokiSink {
  return new LokiSink(
    {
      baseUrl: 'https://logs.example',
      userId: '123456',
      apiToken: 'tok',
      labels: { app: 'fluxtube', env: 'production', run_id: 'r1' },
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

describe('LokiSink', () => {
  it('is a no-op when no entries are buffered', async () => {
    const sink = makeSink();
    const { ctx, pending } = makeCtx();
    sink.flush(ctx);
    expect(pending).toHaveLength(0);
    expect(captured.url).toBeUndefined();
  });

  it('posts a single stream containing all buffered entries', async () => {
    const sink = makeSink();
    sink.push({ ts: new Date('2026-06-02T00:00:00Z'), level: 'info', event: 'sync_start' });
    sink.push({
      ts: new Date('2026-06-02T00:00:01Z'),
      level: 'info',
      event: 'added',
      fields: { entry_id: 100 },
    });
    const { ctx, pending } = makeCtx();
    sink.flush(ctx);
    await Promise.all(pending);

    expect(captured.url).toBe('https://logs.example/loki/api/v1/push');
    const body = captured.body as { streams: { stream: Record<string, string>; values: [string, string][] }[] };
    expect(body.streams).toHaveLength(1);
    expect(body.streams[0]?.stream).toEqual({
      app: 'fluxtube',
      env: 'production',
      run_id: 'r1',
    });
    expect(body.streams[0]?.values).toHaveLength(2);

    // Each value is [ns_ts, json_line]
    const firstStream = body.streams[0];
    if (firstStream === undefined) throw new Error('expected one stream');
    const firstValue = firstStream.values[0];
    if (firstValue === undefined) throw new Error('expected at least one value');
    const [tsNs, line] = firstValue;
    expect(tsNs).toMatch(/^[0-9]+$/);
    const parsed = JSON.parse(line) as { event: string };
    expect(parsed.event).toBe('sync_start');
  });

  it('sorts entries by timestamp before shipping (Loki requires non-decreasing)', async () => {
    const sink = makeSink();
    sink.push({ ts: new Date('2026-06-02T00:00:02Z'), level: 'info', event: 'b' });
    sink.push({ ts: new Date('2026-06-02T00:00:01Z'), level: 'info', event: 'a' });
    const { ctx, pending } = makeCtx();
    sink.flush(ctx);
    await Promise.all(pending);

    const body = captured.body as { streams: { values: [string, string][] }[] };
    const firstStream = body.streams[0];
    if (firstStream === undefined) throw new Error('expected one stream');
    const events = firstStream.values.map(([, line]) => (JSON.parse(line) as { event: string }).event);
    expect(events).toEqual(['a', 'b']);
  });

  it('sends Basic auth derived from userId:apiToken', async () => {
    const sink = makeSink();
    sink.push({ ts: new Date(), level: 'info', event: 'x' });
    const { ctx, pending } = makeCtx();
    sink.flush(ctx);
    await Promise.all(pending);

    const expected = `Basic ${btoa('123456:tok')}`;
    expect(captured.headers?.['Authorization']).toBe(expected);
  });

  it('does not throw when fetch rejects (Loki outage must not affect the run)', async () => {
    const warned: { event?: string; fields?: Record<string, unknown> } = {};
    const sink = new LokiSink(
      {
        baseUrl: 'https://logs.example',
        userId: '1',
        apiToken: 't',
        labels: { app: 'fluxtube' },
      },
      (event, fields) => {
        warned.event = event;
        warned.fields = fields;
      },
    );
    vi.stubGlobal('fetch', async () => {
      throw new Error('connection reset');
    });
    sink.push({ ts: new Date(), level: 'error', event: 'fatal' });
    const { ctx, pending } = makeCtx();
    sink.flush(ctx);
    await Promise.all(pending);
    expect(warned.event).toBe('loki_push_failed');
    expect(warned.fields).toMatchObject({ error: 'connection reset' });
  });

  it('clears the buffer after flush so re-using the sink does not duplicate', async () => {
    const sink = makeSink();
    sink.push({ ts: new Date(), level: 'info', event: 'a' });
    const { ctx, pending } = makeCtx();
    sink.flush(ctx);
    await Promise.all(pending);

    // Second flush with nothing buffered should be a no-op.
    const before = captured.url;
    captured.url = undefined;
    sink.flush(ctx);
    expect(captured.url).toBeUndefined();
    expect(before).toBe('https://logs.example/loki/api/v1/push');
  });
});
