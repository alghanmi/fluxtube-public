import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { audit } from '../src/audit';
import { createLogger } from '../src/logger';
import { QueueState } from '../src/state';
import type {
  CategoryPlaylistMapping,
  MinifluxCategory,
  MinifluxEntry,
  PlaylistItemRef,
} from '../src/types';
import type { MinifluxClient } from '../src/miniflux';
import type { YouTubeClient } from '../src/youtube';

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

interface FakeDepsOpts {
  categories: MinifluxCategory[];
  unreadByCategory: Record<number, MinifluxEntry[]>;
  playlists: Record<string, PlaylistItemRef[]>;
}

function fakes(opts: FakeDepsOpts): {
  miniflux: MinifluxClient;
  youtube: YouTubeClient;
} {
  const miniflux = {
    listCategories: vi.fn(async () => opts.categories),
    listUnreadInCategory: vi.fn(async (id: number) => opts.unreadByCategory[id] ?? []),
    markRead: vi.fn(),
  } as unknown as MinifluxClient;

  const youtube = {
    quotaUsed: 0,
    listPlaylistItems: vi.fn(async (id: string) => opts.playlists[id] ?? []),
    insertPlaylistItem: vi.fn(),
  } as unknown as YouTubeClient;

  return { miniflux, youtube };
}

const logger = createLogger('error');

describe('audit', () => {
  it('partitions Miniflux unread vs D1 tracking vs YouTube playlist into the four buckets', async () => {
    const mapping: CategoryPlaylistMapping[] = [
      { category: 'Cycling', playlistId: 'PLcycling' },
    ];
    const { miniflux, youtube } = fakes({
      categories: [{ id: 1, title: 'Cycling' }],
      unreadByCategory: {
        1: [
          // tracked in D1 and in playlist — should not appear in any bucket
          { id: 100, url: 'https://youtu.be/aaaaaaaaaaa', title: 'a', status: 'unread' },
          // untracked, in playlist — backfill candidate
          { id: 101, url: 'https://youtu.be/bbbbbbbbbbb', title: 'b', status: 'unread' },
          // untracked, not in playlist — Pass 1 has not (yet) added it
          { id: 102, url: 'https://youtu.be/ccccccccccc', title: 'c', status: 'unread' },
          // not a YouTube URL — leak candidate
          { id: 103, url: 'https://vimeo.com/12345', title: 'v', status: 'unread' },
        ],
      },
      playlists: {
        PLcycling: [
          { playlistItemId: 'PI_a', videoId: 'aaaaaaaaaaa' },
          { playlistItemId: 'PI_b', videoId: 'bbbbbbbbbbb' },
          // 'ddddddddddd' is tracked in D1 but not in playlist — should appear in
          // tracked_but_missing_from_playlist
        ],
      },
    });

    const state = new QueueState(db);
    await state.insert({
      minifluxEntryId: 100,
      youtubeVideoId: 'aaaaaaaaaaa',
      youtubePlaylistId: 'PLcycling',
      playlistItemId: 'PI_a',
      addedAt: 1,
    });
    await state.insert({
      minifluxEntryId: 200,
      youtubeVideoId: 'ddddddddddd',
      youtubePlaylistId: 'PLcycling',
      playlistItemId: 'PI_d_gone',
      addedAt: 2,
    });

    const report = await audit(mapping, { miniflux, youtube, state, logger });

    expect(report.pairs).toHaveLength(1);
    const pair = report.pairs[0];
    if (pair === undefined) throw new Error('expected one pair');
    expect(pair.category).toBe('Cycling');
    expect(pair.category_id).toBe(1);
    expect(pair.miniflux_unread_count).toBe(4);
    expect(pair.youtube_playlist_size).toBe(2);
    expect(pair.d1_tracked_count).toBe(2);
    expect(pair.not_a_youtube_url).toBe(1);
    expect(pair.untracked_unread_in_playlist).toEqual([
      { entry_id: 101, video_id: 'bbbbbbbbbbb' },
    ]);
    expect(pair.untracked_unread_not_in_playlist).toEqual([
      { entry_id: 102, video_id: 'ccccccccccc' },
    ]);
    expect(pair.tracked_but_missing_from_playlist).toEqual([
      { entry_id: 200, video_id: 'ddddddddddd' },
    ]);
    expect(report.d1_orphan_playlist_ids).toEqual([]);
  });

  it('surfaces playlist IDs in D1 that no longer appear in the mapping', async () => {
    const mapping: CategoryPlaylistMapping[] = [
      { category: 'Cycling', playlistId: 'PLcycling' },
    ];
    const { miniflux, youtube } = fakes({
      categories: [{ id: 1, title: 'Cycling' }],
      unreadByCategory: { 1: [] },
      playlists: { PLcycling: [] },
    });

    const state = new QueueState(db);
    await state.insert({
      minifluxEntryId: 100,
      youtubeVideoId: 'aaaaaaaaaaa',
      youtubePlaylistId: 'PLold_orphan',
      playlistItemId: 'PI_old',
      addedAt: 1,
    });

    const report = await audit(mapping, { miniflux, youtube, state, logger });
    expect(report.d1_orphan_playlist_ids).toEqual(['PLold_orphan']);
  });

  it('reports null category_id when the configured category is not found in Miniflux', async () => {
    const mapping: CategoryPlaylistMapping[] = [
      { category: 'Missing', playlistId: 'PLa' },
    ];
    const { miniflux, youtube } = fakes({
      categories: [{ id: 1, title: 'Other' }],
      unreadByCategory: {},
      playlists: { PLa: [] },
    });

    const state = new QueueState(db);
    const report = await audit(mapping, { miniflux, youtube, state, logger });
    expect(report.pairs[0]?.category_id).toBe(null);
    expect(report.pairs[0]?.miniflux_unread_count).toBe(0);
  });
});
