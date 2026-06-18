import type { QueueRow } from './types';

/**
 * D1 access for the `queue` tracking table. All times are unix seconds UTC.
 *
 * Column ↔ field mapping is camelCase on the TS side, snake_case in SQL.
 */
export class QueueState {
  constructor(private readonly db: D1Database) {}

  async exists(minifluxEntryId: number, youtubePlaylistId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        'SELECT 1 AS x FROM queue WHERE miniflux_entry_id = ? AND youtube_playlist_id = ? LIMIT 1',
      )
      .bind(minifluxEntryId, youtubePlaylistId)
      .first<{ x: number }>();
    return row !== null;
  }

  async insert(row: QueueRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO queue
           (miniflux_entry_id, youtube_video_id, youtube_playlist_id, playlist_item_id, added_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(miniflux_entry_id, youtube_playlist_id) DO NOTHING`,
      )
      .bind(
        row.minifluxEntryId,
        row.youtubeVideoId,
        row.youtubePlaylistId,
        row.playlistItemId,
        row.addedAt,
      )
      .run();
  }

  async delete(minifluxEntryId: number, youtubePlaylistId: string): Promise<void> {
    await this.db
      .prepare(
        'DELETE FROM queue WHERE miniflux_entry_id = ? AND youtube_playlist_id = ?',
      )
      .bind(minifluxEntryId, youtubePlaylistId)
      .run();
  }

  async rowsForPlaylist(youtubePlaylistId: string): Promise<QueueRow[]> {
    const result = await this.db
      .prepare(
        `SELECT miniflux_entry_id, youtube_video_id, youtube_playlist_id, playlist_item_id, added_at
         FROM queue WHERE youtube_playlist_id = ?`,
      )
      .bind(youtubePlaylistId)
      .all<{
        miniflux_entry_id: number;
        youtube_video_id: string;
        youtube_playlist_id: string;
        playlist_item_id: string;
        added_at: number;
      }>();

    return (result.results ?? []).map((r) => ({
      minifluxEntryId: r.miniflux_entry_id,
      youtubeVideoId: r.youtube_video_id,
      youtubePlaylistId: r.youtube_playlist_id,
      playlistItemId: r.playlist_item_id,
      addedAt: r.added_at,
    }));
  }

  async noRowsForEntry(minifluxEntryId: number): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT 1 AS x FROM queue WHERE miniflux_entry_id = ? LIMIT 1')
      .bind(minifluxEntryId)
      .first<{ x: number }>();
    return row === null;
  }

  /**
   * True iff the entry is tracked in at least one playlist OTHER than the
   * given one. Used by Pass 2 to decide — before deleting the row for
   * `excludePlaylistId` — whether removing it will leave the entry orphaned
   * across all playlists.
   */
  async hasOtherRowsForEntry(
    minifluxEntryId: number,
    excludePlaylistId: string,
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        'SELECT 1 AS x FROM queue WHERE miniflux_entry_id = ? AND youtube_playlist_id != ? LIMIT 1',
      )
      .bind(minifluxEntryId, excludePlaylistId)
      .first<{ x: number }>();
    return row !== null;
  }

  async allPlaylistIds(): Promise<string[]> {
    const result = await this.db
      .prepare('SELECT DISTINCT youtube_playlist_id FROM queue')
      .all<{ youtube_playlist_id: string }>();
    return (result.results ?? []).map((r) => r.youtube_playlist_id);
  }
}
