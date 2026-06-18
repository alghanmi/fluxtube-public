-- Tracking table: one row per (entry, playlist) pair.
-- Compound PK supports a single entry being tracked in multiple playlists,
-- which is required for future many-to-many category/playlist mappings.
CREATE TABLE IF NOT EXISTS queue (
  miniflux_entry_id   INTEGER NOT NULL,
  youtube_video_id    TEXT    NOT NULL,
  youtube_playlist_id TEXT    NOT NULL,
  playlist_item_id    TEXT    NOT NULL,  -- returned by playlistItems.insert
  added_at            INTEGER NOT NULL,  -- unix seconds UTC
  PRIMARY KEY (miniflux_entry_id, youtube_playlist_id)
);

CREATE INDEX IF NOT EXISTS idx_queue_video    ON queue(youtube_video_id);
CREATE INDEX IF NOT EXISTS idx_queue_playlist ON queue(youtube_playlist_id);
