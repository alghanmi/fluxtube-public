import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger';
import { QueueState } from '../src/state';
import { runSync } from '../src/sync';
import {
  FatalError,
  MinifluxEntryNotFoundError,
  VideoUnavailableError,
} from '../src/types';
import type { CategoryPlaylistMapping, MinifluxCategory, MinifluxEntry, PlaylistItemRef } from '../src/types';
import type { MinifluxClient } from '../src/miniflux';
import type { YouTubeClient } from '../src/youtube';

// D1's `exec()` requires each statement on a single line; use prepare().run()
// for the multi-line CREATE TABLE.
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS queue (
    miniflux_entry_id   INTEGER NOT NULL,
    youtube_video_id    TEXT    NOT NULL,
    youtube_playlist_id TEXT    NOT NULL,
    playlist_item_id    TEXT    NOT NULL,
    added_at            INTEGER NOT NULL,
    PRIMARY KEY (miniflux_entry_id, youtube_playlist_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_queue_video ON queue(youtube_video_id)',
  'CREATE INDEX IF NOT EXISTS idx_queue_playlist ON queue(youtube_playlist_id)',
];

const db = (env as unknown as { DB: D1Database }).DB;

beforeEach(async () => {
  await db.prepare('DROP TABLE IF EXISTS queue').run();
  for (const stmt of SCHEMA_STATEMENTS) {
    await db.prepare(stmt).run();
  }
});

interface FakeMinifluxOptions {
  categories: MinifluxCategory[];
  unreadByCategory: Record<number, MinifluxEntry[]>;
  markReadNotFound?: Set<number>;
  markReadFails?: Set<number>;
}

function fakeMiniflux(opts: FakeMinifluxOptions): {
  client: MinifluxClient;
  marked: number[];
} {
  const marked: number[] = [];
  const client = {
    listCategories: vi.fn(async () => opts.categories),
    listUnreadInCategory: vi.fn(async (id: number) => opts.unreadByCategory[id] ?? []),
    markRead: vi.fn(async (ids: number[]) => {
      if (ids.length === 1) {
        const id = ids[0] as number;
        if (opts.markReadNotFound?.has(id)) {
          throw new MinifluxEntryNotFoundError(id);
        }
        if (opts.markReadFails?.has(id)) {
          throw new Error(`miniflux 500 for ${id}`);
        }
      }
      marked.push(...ids);
    }),
  } as unknown as MinifluxClient;
  return { client, marked };
}

interface FakeYouTubeOptions {
  initialItems: Record<string, PlaylistItemRef[]>;
  unavailableVideoIds?: Set<string>;
  insertFails?: Set<string>;
  fatalOnList?: boolean;
}

function fakeYouTube(opts: FakeYouTubeOptions): {
  client: YouTubeClient;
  inserted: { playlistId: string; videoId: string }[];
  state: Record<string, PlaylistItemRef[]>;
} {
  const state = structuredClone(opts.initialItems);
  const inserted: { playlistId: string; videoId: string }[] = [];
  let counter = 0;

  const client = {
    quotaUsed: 0,
    listPlaylistItems: vi.fn(async (playlistId: string) => {
      if (opts.fatalOnList) throw new FatalError('quota_exhausted', 'simulated');
      return state[playlistId] ?? [];
    }),
    insertPlaylistItem: vi.fn(async (playlistId: string, videoId: string) => {
      if (opts.unavailableVideoIds?.has(videoId)) {
        throw new VideoUnavailableError(videoId, 'simulated unavailable');
      }
      if (opts.insertFails?.has(videoId)) {
        throw new Error('simulated insert failure');
      }
      const ref: PlaylistItemRef = { playlistItemId: `PI_${++counter}`, videoId };
      const list = state[playlistId] ?? (state[playlistId] = []);
      list.push(ref);
      inserted.push({ playlistId, videoId });
      return ref;
    }),
  } as unknown as YouTubeClient;
  return { client, inserted, state };
}

const logger = createLogger('error');

describe('runSync — Pass 1: add new videos', () => {
  it('adds an unread entry whose video is not in the playlist or D1', async () => {
    const mapping: CategoryPlaylistMapping[] = [
      { category: 'YouTube', playlistId: 'PLa' },
    ];
    const { client: miniflux } = fakeMiniflux({
      categories: [{ id: 1, title: 'YouTube' }],
      unreadByCategory: {
        1: [
          { id: 100, url: 'https://youtu.be/aaaaaaaaaaa', title: 'A', status: 'unread' },
        ],
      },
    });
    const { client: youtube, inserted } = fakeYouTube({ initialItems: { PLa: [] } });

    const state = new QueueState(db);
    await runSync(mapping, { miniflux, youtube, state, logger, now: () => 42 });

    expect(inserted).toEqual([{ playlistId: 'PLa', videoId: 'aaaaaaaaaaa' }]);
    expect(await state.exists(100, 'PLa')).toBe(true);
  });

  it('skips videos already tracked in D1', async () => {
    const mapping: CategoryPlaylistMapping[] = [{ category: 'X', playlistId: 'PLa' }];
    const { client: miniflux } = fakeMiniflux({
      categories: [{ id: 1, title: 'X' }],
      unreadByCategory: {
        1: [{ id: 100, url: 'https://youtu.be/aaaaaaaaaaa', title: 'A', status: 'unread' }],
      },
    });
    const { client: youtube, inserted } = fakeYouTube({ initialItems: { PLa: [] } });

    const state = new QueueState(db);
    await state.insert({
      minifluxEntryId: 100,
      youtubeVideoId: 'aaaaaaaaaaa',
      youtubePlaylistId: 'PLa',
      playlistItemId: 'PI_existing',
      addedAt: 1,
    });
    await runSync(mapping, { miniflux, youtube, state, logger });

    expect(inserted).toHaveLength(0);
  });

  it('tracks an entry whose video is already in the playlist (no insert, but writes D1 row)', async () => {
    const mapping: CategoryPlaylistMapping[] = [{ category: 'X', playlistId: 'PLa' }];
    const { client: miniflux } = fakeMiniflux({
      categories: [{ id: 1, title: 'X' }],
      unreadByCategory: {
        1: [{ id: 100, url: 'https://youtu.be/aaaaaaaaaaa', title: 'A', status: 'unread' }],
      },
    });
    const { client: youtube, inserted } = fakeYouTube({
      initialItems: {
        PLa: [{ playlistItemId: 'manual-add', videoId: 'aaaaaaaaaaa' }],
      },
    });

    const state = new QueueState(db);
    await runSync(mapping, { miniflux, youtube, state, logger });

    expect(inserted).toHaveLength(0);
    expect(await state.exists(100, 'PLa')).toBe(true);

    // Subsequent Pass 2 detection of removal should now work: removing the
    // video from the playlist on the next run causes the D1 row to be
    // deleted and the Miniflux entry to be marked read.
    const trackedRows = await state.rowsForPlaylist('PLa');
    expect(trackedRows).toHaveLength(1);
    expect(trackedRows[0]?.playlistItemId).toBe('manual-add');
  });

  it('recovers a previously lost D1 row when video is still in the playlist', async () => {
    // Repro of the "32 stuck entries" scenario: user re-marks an entry
    // unread in Miniflux after FluxTube prematurely marked it read. The
    // video is still in the YouTube playlist (FluxTube never deletes from
    // playlists). On the next tick we should re-track it so the natural
    // remove-from-playlist cleanup flow works again.
    const mapping: CategoryPlaylistMapping[] = [{ category: 'X', playlistId: 'PLa' }];
    const { client: miniflux, marked } = fakeMiniflux({
      categories: [{ id: 1, title: 'X' }],
      unreadByCategory: {
        1: [{ id: 100, url: 'https://youtu.be/aaaaaaaaaaa', title: 'A', status: 'unread' }],
      },
    });
    const { client: youtube, inserted } = fakeYouTube({
      initialItems: {
        PLa: [{ playlistItemId: 'PI_was_in_d1_before', videoId: 'aaaaaaaaaaa' }],
      },
    });

    const state = new QueueState(db);
    // D1 starts empty (the stuck-entry case: prior buggy run marked read
    // and cleaned up D1).
    expect(await state.noRowsForEntry(100)).toBe(true);

    await runSync(mapping, { miniflux, youtube, state, logger });

    expect(inserted).toHaveLength(0); // no YouTube write — already there
    expect(marked).toEqual([]); // not prematurely marked read again
    expect(await state.exists(100, 'PLa')).toBe(true);
  });

  it('marks read and continues when YouTube reports the video as unavailable', async () => {
    const mapping: CategoryPlaylistMapping[] = [{ category: 'X', playlistId: 'PLa' }];
    const { client: miniflux, marked } = fakeMiniflux({
      categories: [{ id: 1, title: 'X' }],
      unreadByCategory: {
        1: [
          { id: 100, url: 'https://youtu.be/aaaaaaaaaaa', title: 'A', status: 'unread' },
          { id: 101, url: 'https://youtu.be/bbbbbbbbbbb', title: 'B', status: 'unread' },
        ],
      },
    });
    const { client: youtube, inserted } = fakeYouTube({
      initialItems: { PLa: [] },
      unavailableVideoIds: new Set(['aaaaaaaaaaa']),
    });

    const state = new QueueState(db);
    await runSync(mapping, { miniflux, youtube, state, logger });

    expect(marked).toContain(100);
    expect(inserted).toEqual([{ playlistId: 'PLa', videoId: 'bbbbbbbbbbb' }]);
    expect(await state.exists(101, 'PLa')).toBe(true);
    expect(await state.exists(100, 'PLa')).toBe(false);
  });

  it('with skipShorts=true, marks /shorts/ entries read and never inserts', async () => {
    const mapping: CategoryPlaylistMapping[] = [
      { category: 'X', playlistId: 'PLa', skipShorts: true },
    ];
    const { client: miniflux, marked } = fakeMiniflux({
      categories: [{ id: 1, title: 'X' }],
      unreadByCategory: {
        1: [
          // Short — should be marked read, not inserted
          { id: 100, url: 'https://www.youtube.com/shorts/aaaaaaaaaaa', title: 'S', status: 'unread' },
          // Regular video — should still be inserted
          { id: 101, url: 'https://youtu.be/bbbbbbbbbbb', title: 'V', status: 'unread' },
          // /watch?v= URL that happens to be a Short (we can't detect it by URL) — inserted
          { id: 102, url: 'https://www.youtube.com/watch?v=ccccccccccc', title: 'W', status: 'unread' },
        ],
      },
    });
    const { client: youtube, inserted } = fakeYouTube({ initialItems: { PLa: [] } });

    const state = new QueueState(db);
    await runSync(mapping, { miniflux, youtube, state, logger });

    expect(marked).toEqual([100]);
    expect(inserted.map((i) => i.videoId).sort()).toEqual(['bbbbbbbbbbb', 'ccccccccccc']);
    expect(await state.exists(100, 'PLa')).toBe(false);
    expect(await state.exists(101, 'PLa')).toBe(true);
    expect(await state.exists(102, 'PLa')).toBe(true);
  });

  it('with skipShorts unset, inserts /shorts/ entries normally', async () => {
    const mapping: CategoryPlaylistMapping[] = [{ category: 'X', playlistId: 'PLa' }];
    const { client: miniflux, marked } = fakeMiniflux({
      categories: [{ id: 1, title: 'X' }],
      unreadByCategory: {
        1: [
          { id: 100, url: 'https://www.youtube.com/shorts/aaaaaaaaaaa', title: 'S', status: 'unread' },
        ],
      },
    });
    const { client: youtube, inserted } = fakeYouTube({ initialItems: { PLa: [] } });

    const state = new QueueState(db);
    await runSync(mapping, { miniflux, youtube, state, logger });
    expect(inserted).toEqual([{ playlistId: 'PLa', videoId: 'aaaaaaaaaaa' }]);
    expect(marked).toEqual([]);
  });

  it('skips entries whose URL is not a recognized YouTube video', async () => {
    const mapping: CategoryPlaylistMapping[] = [{ category: 'X', playlistId: 'PLa' }];
    const { client: miniflux } = fakeMiniflux({
      categories: [{ id: 1, title: 'X' }],
      unreadByCategory: {
        1: [
          { id: 100, url: 'https://vimeo.com/12345', title: 'V', status: 'unread' },
          { id: 101, url: 'https://youtu.be/aaaaaaaaaaa', title: 'YT', status: 'unread' },
        ],
      },
    });
    const { client: youtube, inserted } = fakeYouTube({ initialItems: { PLa: [] } });

    const state = new QueueState(db);
    await runSync(mapping, { miniflux, youtube, state, logger });
    expect(inserted).toEqual([{ playlistId: 'PLa', videoId: 'aaaaaaaaaaa' }]);
  });

  it('warns and continues when a configured Miniflux category does not exist', async () => {
    const mapping: CategoryPlaylistMapping[] = [
      { category: 'Missing', playlistId: 'PLa' },
      { category: 'Real', playlistId: 'PLb' },
    ];
    const { client: miniflux } = fakeMiniflux({
      categories: [{ id: 2, title: 'Real' }],
      unreadByCategory: {
        2: [{ id: 100, url: 'https://youtu.be/aaaaaaaaaaa', title: 'A', status: 'unread' }],
      },
    });
    const { client: youtube, inserted } = fakeYouTube({
      initialItems: { PLa: [], PLb: [] },
    });

    const state = new QueueState(db);
    await runSync(mapping, { miniflux, youtube, state, logger });
    expect(inserted).toEqual([{ playlistId: 'PLb', videoId: 'aaaaaaaaaaa' }]);
  });

  it('caches playlist contents — one fetch per unique playlist per run', async () => {
    const mapping: CategoryPlaylistMapping[] = [
      { category: 'A', playlistId: 'PLshared' },
      { category: 'B', playlistId: 'PLshared' },
    ];
    const { client: miniflux } = fakeMiniflux({
      categories: [
        { id: 1, title: 'A' },
        { id: 2, title: 'B' },
      ],
      unreadByCategory: { 1: [], 2: [] },
    });
    const { client: youtube } = fakeYouTube({ initialItems: { PLshared: [] } });

    const state = new QueueState(db);
    await runSync(mapping, { miniflux, youtube, state, logger });
    expect(youtube.listPlaylistItems).toHaveBeenCalledTimes(1);
  });

  it('does NOT mark Pass-1-added entries read in the same run (regression)', async () => {
    // Bug: Pass 2 reused Pass 1's cached playlist snapshot, which was taken
    // BEFORE any inserts. Pass 2 then thought every just-inserted video was
    // "no longer in the playlist" and deleted the D1 row + marked the
    // Miniflux entry read. Fixed by mutating the cached playlist list when
    // we insert.
    const mapping: CategoryPlaylistMapping[] = [{ category: 'X', playlistId: 'PLa' }];
    const { client: miniflux, marked } = fakeMiniflux({
      categories: [{ id: 1, title: 'X' }],
      unreadByCategory: {
        1: [
          { id: 100, url: 'https://youtu.be/aaaaaaaaaaa', title: 'A', status: 'unread' },
          { id: 101, url: 'https://youtu.be/bbbbbbbbbbb', title: 'B', status: 'unread' },
        ],
      },
    });
    const { client: youtube, inserted } = fakeYouTube({ initialItems: { PLa: [] } });

    const state = new QueueState(db);
    await runSync(mapping, { miniflux, youtube, state, logger });

    expect(inserted.map((i) => i.videoId)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
    expect(marked).toEqual([]); // no premature mark-read
    expect(await state.exists(100, 'PLa')).toBe(true);
    expect(await state.exists(101, 'PLa')).toBe(true);
  });
});

describe('runSync — Pass 2: detect removals', () => {
  it('marks entry read and deletes D1 row when video is no longer in playlist', async () => {
    const mapping: CategoryPlaylistMapping[] = [{ category: 'X', playlistId: 'PLa' }];
    const { client: miniflux, marked } = fakeMiniflux({
      categories: [{ id: 1, title: 'X' }],
      unreadByCategory: { 1: [] },
    });
    const { client: youtube } = fakeYouTube({ initialItems: { PLa: [] } });

    const state = new QueueState(db);
    await state.insert({
      minifluxEntryId: 100,
      youtubeVideoId: 'aaaaaaaaaaa',
      youtubePlaylistId: 'PLa',
      playlistItemId: 'PI1',
      addedAt: 1,
    });

    await runSync(mapping, { miniflux, youtube, state, logger });
    expect(marked).toEqual([100]);
    expect(await state.exists(100, 'PLa')).toBe(false);
  });

  it('does not mark entry read until removed from all tracked playlists', async () => {
    const mapping: CategoryPlaylistMapping[] = [
      { category: 'A', playlistId: 'PLa' },
      { category: 'B', playlistId: 'PLb' },
    ];
    const { client: miniflux, marked } = fakeMiniflux({
      categories: [
        { id: 1, title: 'A' },
        { id: 2, title: 'B' },
      ],
      unreadByCategory: { 1: [], 2: [] },
    });
    const { client: youtube } = fakeYouTube({
      initialItems: {
        PLa: [],
        PLb: [{ playlistItemId: 'PI2', videoId: 'aaaaaaaaaaa' }],
      },
    });

    const state = new QueueState(db);
    await state.insert({
      minifluxEntryId: 100,
      youtubeVideoId: 'aaaaaaaaaaa',
      youtubePlaylistId: 'PLa',
      playlistItemId: 'PI1',
      addedAt: 1,
    });
    await state.insert({
      minifluxEntryId: 100,
      youtubeVideoId: 'aaaaaaaaaaa',
      youtubePlaylistId: 'PLb',
      playlistItemId: 'PI2',
      addedAt: 2,
    });

    await runSync(mapping, { miniflux, youtube, state, logger });
    expect(marked).toEqual([]);
    expect(await state.exists(100, 'PLa')).toBe(false);
    expect(await state.exists(100, 'PLb')).toBe(true);
  });

  it('preserves D1 row when markRead throws non-404 so the next run can retry (regression)', async () => {
    // Pre-fix bug: Pass 2 deleted the D1 row, THEN called markRead. If
    // markRead failed with anything other than 404 (transient 5xx, network
    // blip), the catch logged and continued — but the D1 row was already
    // gone, leaving the Miniflux entry unread forever with no record to
    // drive a retry. The fix reverses the order: markRead first, only
    // delete on success or 404.
    const mapping: CategoryPlaylistMapping[] = [{ category: 'X', playlistId: 'PLa' }];
    const { client: miniflux } = fakeMiniflux({
      categories: [{ id: 1, title: 'X' }],
      unreadByCategory: { 1: [] },
      markReadFails: new Set([100]),
    });
    const { client: youtube } = fakeYouTube({ initialItems: { PLa: [] } });

    const state = new QueueState(db);
    await state.insert({
      minifluxEntryId: 100,
      youtubeVideoId: 'aaaaaaaaaaa',
      youtubePlaylistId: 'PLa',
      playlistItemId: 'PI1',
      addedAt: 1,
    });

    // Should not throw — failures are logged at error and the run continues.
    await runSync(mapping, { miniflux, youtube, state, logger });

    // D1 row preserved so the next run will retry markRead.
    expect(await state.exists(100, 'PLa')).toBe(true);
  });

  it('treats Miniflux 404 on mark_read as clean terminal state', async () => {
    const mapping: CategoryPlaylistMapping[] = [{ category: 'X', playlistId: 'PLa' }];
    const { client: miniflux } = fakeMiniflux({
      categories: [{ id: 1, title: 'X' }],
      unreadByCategory: { 1: [] },
      markReadNotFound: new Set([100]),
    });
    const { client: youtube } = fakeYouTube({ initialItems: { PLa: [] } });

    const state = new QueueState(db);
    await state.insert({
      minifluxEntryId: 100,
      youtubeVideoId: 'aaaaaaaaaaa',
      youtubePlaylistId: 'PLa',
      playlistItemId: 'PI1',
      addedAt: 1,
    });

    // Should not throw
    await runSync(mapping, { miniflux, youtube, state, logger });
    expect(await state.exists(100, 'PLa')).toBe(false);
  });
});

describe('runSync — fatal errors', () => {
  it('propagates FatalError from YouTube list (e.g. quota exhausted)', async () => {
    const mapping: CategoryPlaylistMapping[] = [{ category: 'X', playlistId: 'PLa' }];
    const { client: miniflux } = fakeMiniflux({
      categories: [{ id: 1, title: 'X' }],
      unreadByCategory: { 1: [] },
    });
    const { client: youtube } = fakeYouTube({ initialItems: { PLa: [] }, fatalOnList: true });

    const state = new QueueState(db);
    await expect(
      runSync(mapping, { miniflux, youtube, state, logger }),
    ).rejects.toBeInstanceOf(FatalError);
  });

  it('returns immediately when mapping is empty', async () => {
    const { client: miniflux } = fakeMiniflux({
      categories: [],
      unreadByCategory: {},
    });
    const { client: youtube } = fakeYouTube({ initialItems: {} });
    const state = new QueueState(db);
    await runSync([], { miniflux, youtube, state, logger });
    expect(miniflux.listCategories).not.toHaveBeenCalled();
  });
});
