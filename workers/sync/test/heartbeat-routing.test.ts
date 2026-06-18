import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ping } from '../src/heartbeat';

// Smoke test the ping URL-construction. The actual per-reason routing is
// asserted indirectly: the scheduled handler builds the URLs it pings from
// env, so we don't need to invoke the full Worker — we just need to verify
// `ping` constructs the right URL for each phase, which the routing code in
// index.ts then drives based on the FatalError reason.
//
// We stub global `fetch` and check what URL the handler hits.

const lastFetched: { url?: string; phase?: string } = {};

beforeEach(() => {
  lastFetched.url = undefined;
  lastFetched.phase = undefined;
  vi.stubGlobal('fetch', async (url: string) => {
    lastFetched.url = url;
    return new Response('ok', { status: 200 });
  });
});

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: () => {},
};

describe('heartbeat ping URL routing', () => {
  it('appends /fail for the fail phase', async () => {
    await ping('https://hc-ping.com/auth-uuid', 'fail', noopLogger);
    expect(lastFetched.url).toBe('https://hc-ping.com/auth-uuid/fail');
  });

  it('uses the bare URL for the success phase', async () => {
    await ping('https://hc-ping.com/main-uuid', 'success', noopLogger);
    expect(lastFetched.url).toBe('https://hc-ping.com/main-uuid');
  });

  it('appends /start for the start phase', async () => {
    await ping('https://hc-ping.com/main-uuid', 'start', noopLogger);
    expect(lastFetched.url).toBe('https://hc-ping.com/main-uuid/start');
  });

  it('strips a trailing slash on the base URL', async () => {
    await ping('https://hc-ping.com/quota-uuid/', 'fail', noopLogger);
    expect(lastFetched.url).toBe('https://hc-ping.com/quota-uuid/fail');
  });

  it('is a no-op when the base URL is undefined or empty', async () => {
    await ping(undefined, 'fail', noopLogger);
    expect(lastFetched.url).toBeUndefined();
    await ping('', 'fail', noopLogger);
    expect(lastFetched.url).toBeUndefined();
  });
});
