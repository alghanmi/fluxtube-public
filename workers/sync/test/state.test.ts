import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { QueueState } from '../src/state';

// D1's `exec()` requires each statement on a single line — multi-line
// CREATE TABLE bodies error with "incomplete input". Use prepare().run()
// instead, which has no such restriction.
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

describe('QueueState', () => {
  it('inserts and detects existence by (entry, playlist)', async () => {
    const state = new QueueState(db);
    expect(await state.exists(1, 'PLa')).toBe(false);

    await state.insert({
      minifluxEntryId: 1,
      youtubeVideoId: 'aaaaaaaaaaa',
      youtubePlaylistId: 'PLa',
      playlistItemId: 'PI1',
      addedAt: 1700000000,
    });
    expect(await state.exists(1, 'PLa')).toBe(true);
    expect(await state.exists(1, 'PLother')).toBe(false);
  });

  it('insert is idempotent on the compound PK', async () => {
    const state = new QueueState(db);
    const row = {
      minifluxEntryId: 1,
      youtubeVideoId: 'aaaaaaaaaaa',
      youtubePlaylistId: 'PLa',
      playlistItemId: 'PI1',
      addedAt: 1700000000,
    };
    await state.insert(row);
    await state.insert(row);
    const rows = await state.rowsForPlaylist('PLa');
    expect(rows).toHaveLength(1);
  });

  it('supports the same entry tracked across multiple playlists', async () => {
    const state = new QueueState(db);
    await state.insert({
      minifluxEntryId: 1,
      youtubeVideoId: 'aaaaaaaaaaa',
      youtubePlaylistId: 'PLa',
      playlistItemId: 'PI1',
      addedAt: 1700000000,
    });
    await state.insert({
      minifluxEntryId: 1,
      youtubeVideoId: 'aaaaaaaaaaa',
      youtubePlaylistId: 'PLb',
      playlistItemId: 'PI2',
      addedAt: 1700000001,
    });
    expect(await state.exists(1, 'PLa')).toBe(true);
    expect(await state.exists(1, 'PLb')).toBe(true);
    expect(await state.noRowsForEntry(1)).toBe(false);
  });

  it('delete removes only the specified (entry, playlist) row', async () => {
    const state = new QueueState(db);
    await state.insert({
      minifluxEntryId: 1,
      youtubeVideoId: 'aaaaaaaaaaa',
      youtubePlaylistId: 'PLa',
      playlistItemId: 'PI1',
      addedAt: 1,
    });
    await state.insert({
      minifluxEntryId: 1,
      youtubeVideoId: 'aaaaaaaaaaa',
      youtubePlaylistId: 'PLb',
      playlistItemId: 'PI2',
      addedAt: 2,
    });
    await state.delete(1, 'PLa');
    expect(await state.exists(1, 'PLa')).toBe(false);
    expect(await state.exists(1, 'PLb')).toBe(true);
    expect(await state.noRowsForEntry(1)).toBe(false);

    await state.delete(1, 'PLb');
    expect(await state.noRowsForEntry(1)).toBe(true);
  });

  it('rowsForPlaylist returns all tracked rows for a playlist', async () => {
    const state = new QueueState(db);
    await state.insert({
      minifluxEntryId: 1,
      youtubeVideoId: 'aaaaaaaaaaa',
      youtubePlaylistId: 'PLa',
      playlistItemId: 'PI1',
      addedAt: 1,
    });
    await state.insert({
      minifluxEntryId: 2,
      youtubeVideoId: 'bbbbbbbbbbb',
      youtubePlaylistId: 'PLa',
      playlistItemId: 'PI2',
      addedAt: 2,
    });
    await state.insert({
      minifluxEntryId: 3,
      youtubeVideoId: 'ccccccccccc',
      youtubePlaylistId: 'PLb',
      playlistItemId: 'PI3',
      addedAt: 3,
    });

    const rows = await state.rowsForPlaylist('PLa');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.minifluxEntryId).sort()).toEqual([1, 2]);
  });

  it('allPlaylistIds returns distinct playlist IDs', async () => {
    const state = new QueueState(db);
    await state.insert({
      minifluxEntryId: 1,
      youtubeVideoId: 'aaaaaaaaaaa',
      youtubePlaylistId: 'PLa',
      playlistItemId: 'PI1',
      addedAt: 1,
    });
    await state.insert({
      minifluxEntryId: 2,
      youtubeVideoId: 'bbbbbbbbbbb',
      youtubePlaylistId: 'PLa',
      playlistItemId: 'PI2',
      addedAt: 2,
    });
    await state.insert({
      minifluxEntryId: 3,
      youtubeVideoId: 'ccccccccccc',
      youtubePlaylistId: 'PLb',
      playlistItemId: 'PI3',
      addedAt: 3,
    });
    const ids = (await state.allPlaylistIds()).sort();
    expect(ids).toEqual(['PLa', 'PLb']);
  });
});
