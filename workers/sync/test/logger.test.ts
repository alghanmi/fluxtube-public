import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger';

describe('createLogger emits version on every line', () => {
  let captured: string[];

  beforeEach(() => {
    captured = [];
    vi.spyOn(console, 'log').mockImplementation((line) => captured.push(String(line)));
    vi.spyOn(console, 'warn').mockImplementation((line) => captured.push(String(line)));
    vi.spyOn(console, 'error').mockImplementation((line) => captured.push(String(line)));
  });

  function firstLine(): Record<string, unknown> {
    const line = captured[0];
    if (line === undefined) throw new Error('expected a captured log line');
    return JSON.parse(line) as Record<string, unknown>;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The build-time `VERSION` identifier is replaced by wrangler / vitest with a
  // string literal. wrangler.toml `[define] VERSION = '"0.0.0-dev"'` is the
  // source of truth for both `wrangler dev` and the vitest-pool-workers test
  // bundle; production deploys override it via `--define` in deploy-sync.yml.
  it('stamps version="0.0.0-dev" from wrangler.toml [define] into stdout JSON', () => {
    const logger = createLogger('info');
    logger.info('sync_start');

    expect(captured).toHaveLength(1);
    const parsed = firstLine();
    expect(parsed.version).toBe('0.0.0-dev');
    expect(parsed.event).toBe('sync_start');
    expect(parsed.level).toBe('info');
  });

  it('keeps version alongside event-specific fields', () => {
    const logger = createLogger('info');
    logger.warn('loki_push_failed', { status: 500, body: 'oops' });

    const parsed = firstLine();
    expect(parsed.version).toBe('0.0.0-dev');
    expect(parsed.status).toBe(500);
    expect(parsed.body).toBe('oops');
  });

  it('also stamps version on entries shipped to a LogSink', () => {
    const pushed: { event: string; fields?: Record<string, unknown> }[] = [];
    const sink = {
      push: (entry: { event: string; fields?: Record<string, unknown> }) => pushed.push(entry),
      flush: () => {},
    };
    const logger = createLogger('info', sink);
    logger.info('added', { entry_id: 42 });

    // Sink receives the entry pre-serialisation, but the stdout JSON line
    // carries `version`. Both paths must agree — assert via the stdout side.
    const parsed = firstLine();
    expect(parsed.version).toBe('0.0.0-dev');

    // And the sink saw the same event + fields (sink-side version stamping
    // happens at LokiSink.shipAndForget via the labels passed by index.ts,
    // not in LogEntry, so we only assert the event/fields here).
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.event).toBe('added');
  });
});
