import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleFetch } from '../src/router';
import { createLogger } from '../src/logger';
import type { Env, PlaylistItemRef } from '../src/types';
import type { MinifluxClient } from '../src/miniflux';
import type { YouTubeClient } from '../src/youtube';
import type { QueueState } from '../src/state';

const TOKEN = 'super-secret-trigger-token-32-bytes-of-entropy';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: undefined as unknown as D1Database,
    MINIFLUX_URL: 'https://miniflux.example',
    CATEGORY_PLAYLIST_MAPPING: '[{"category":"X","playlist_id":"PLa"}]',
    MINIFLUX_API_TOKEN: 'm',
    YOUTUBE_CLIENT_ID: 'y',
    YOUTUBE_CLIENT_SECRET: 's',
    YOUTUBE_REFRESH_TOKEN: 'r',
    MANUAL_TRIGGER_TOKEN: TOKEN,
    ...overrides,
  };
}

function makeDeps(overrides: {
  unread?: { id: number; url: string; title: string; status: 'unread' }[];
  playlistItems?: PlaylistItemRef[];
  rowsForPlaylist?: never;
} = {}) {
  const miniflux = {
    listCategories: vi.fn(async () => [{ id: 1, title: 'X' }]),
    listUnreadInCategory: vi.fn(async () => overrides.unread ?? []),
    markRead: vi.fn(),
  } as unknown as MinifluxClient;

  const youtube = {
    quotaUsed: 0,
    listPlaylistItems: vi.fn(async () => overrides.playlistItems ?? []),
    insertPlaylistItem: vi.fn(),
  } as unknown as YouTubeClient;

  const state = {
    exists: vi.fn(async () => false),
    insert: vi.fn(),
    delete: vi.fn(),
    rowsForPlaylist: vi.fn(async () => []),
    noRowsForEntry: vi.fn(async () => true),
    allPlaylistIds: vi.fn(async () => []),
  } as unknown as QueueState;

  return { miniflux, youtube, state, logger: createLogger('error') };
}

function makeCtx(): ExecutionContext {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => {},
    pending,
  } as unknown as ExecutionContext & { pending: Promise<unknown>[] };
  return ctx;
}

describe('handleFetch — auth', () => {
  let env: Env;
  let deps: ReturnType<typeof makeDeps>;
  let ctx: ExecutionContext;

  beforeEach(() => {
    env = makeEnv();
    deps = makeDeps();
    ctx = makeCtx();
  });

  it('returns 401 when Authorization header is missing', async () => {
    const res = await handleFetch(
      new Request('https://w.example/audit'),
      env,
      ctx,
      deps.logger,
      deps,
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when Authorization scheme is wrong', async () => {
    const res = await handleFetch(
      new Request('https://w.example/audit', { headers: { Authorization: `Basic ${TOKEN}` } }),
      env,
      ctx,
      deps.logger,
      deps,
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 on token mismatch', async () => {
    const res = await handleFetch(
      new Request('https://w.example/audit', { headers: { Authorization: 'Bearer wrong-token' } }),
      env,
      ctx,
      deps.logger,
      deps,
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when MANUAL_TRIGGER_TOKEN is empty even if header matches', async () => {
    env = makeEnv({ MANUAL_TRIGGER_TOKEN: '' });
    const res = await handleFetch(
      new Request('https://w.example/audit', { headers: { Authorization: 'Bearer ' } }),
      env,
      ctx,
      deps.logger,
      deps,
    );
    expect(res.status).toBe(401);
  });
});

describe('handleFetch — routing', () => {
  let env: Env;
  let deps: ReturnType<typeof makeDeps>;
  let ctx: ExecutionContext & { pending: Promise<unknown>[] };

  beforeEach(() => {
    env = makeEnv();
    deps = makeDeps();
    ctx = makeCtx() as ExecutionContext & { pending: Promise<unknown>[] };
  });

  function req(path: string, method = 'GET'): Request {
    return new Request(`https://w.example${path}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  }

  it('returns 404 on unknown paths', async () => {
    const res = await handleFetch(req('/nope'), env, ctx, deps.logger, deps);
    expect(res.status).toBe(404);
  });

  it('returns 405 when /sync is called with GET', async () => {
    const res = await handleFetch(req('/sync', 'GET'), env, ctx, deps.logger, deps);
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
  });

  it('returns 405 when /audit is called with POST', async () => {
    const res = await handleFetch(req('/audit', 'POST'), env, ctx, deps.logger, deps);
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET');
  });

  it('POST /sync returns 202 with a request_id and schedules the run', async () => {
    const res = await handleFetch(req('/sync', 'POST'), env, ctx, deps.logger, deps);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; request_id: string };
    expect(body.status).toBe('accepted');
    expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctx.pending).toHaveLength(1);
    await Promise.all(ctx.pending);
  });

  it('POST /sync?wait=1 runs synchronously and returns 200 with the run summary', async () => {
    const res = await handleFetch(req('/sync?wait=1', 'POST'), env, ctx, deps.logger, deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      request_id: string;
      summary: {
        added: number;
        marked_read: number;
        quota_used: number;
        duration_ms: number;
      };
    };
    expect(body.status).toBe('completed');
    expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.summary.added).toBe(0);
    expect(body.summary.marked_read).toBe(0);
    expect(typeof body.summary.duration_ms).toBe('number');
    // Synchronous mode does not enqueue any ctx.waitUntil promises.
    expect(ctx.pending).toHaveLength(0);
  });

  it('GET /audit returns 200 with the expected shape', async () => {
    const res = await handleFetch(req('/audit'), env, ctx, deps.logger, deps);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const body = (await res.json()) as { pairs: unknown[]; d1_orphan_playlist_ids: unknown[] };
    expect(Array.isArray(body.pairs)).toBe(true);
    expect(Array.isArray(body.d1_orphan_playlist_ids)).toBe(true);
  });
});
