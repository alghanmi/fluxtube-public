export interface Env {
  DB: D1Database;

  MINIFLUX_URL: string;
  CATEGORY_PLAYLIST_MAPPING: string;
  SYNC_LOG_LEVEL?: string;
  HEARTBEAT_URL?: string;
  // Optional per-reason failure check URLs. Pinged on FatalError matching the
  // suffix's reason (`invalid_grant` → AUTH, `quota_exhausted` → QUOTA). Each
  // one is a separate Healthchecks check that an operator wires up with its
  // own email/SMS/webhook routing. The main HEARTBEAT_URL is always pinged
  // too so the primary dashboard stays correlated.
  HEARTBEAT_URL_AUTH?: string;
  HEARTBEAT_URL_QUOTA?: string;

  MINIFLUX_API_TOKEN: string;
  YOUTUBE_CLIENT_ID: string;
  YOUTUBE_CLIENT_SECRET: string;
  YOUTUBE_REFRESH_TOKEN: string;
  MANUAL_TRIGGER_TOKEN: string;

  // Optional Grafana Cloud Loki sink — all three must be set to enable
  // log shipping. Missing any → the LokiSink is not constructed and the
  // Worker just logs to stdout (current behavior).
  GRAFANA_LOKI_URL?: string;
  GRAFANA_LOKI_USER?: string;
  GRAFANA_LOKI_TOKEN?: string;

  // Optional Grafana Cloud metrics sink via OTLP/HTTP JSON. All three must
  // be set to enable metrics shipping. URL is the OpenTelemetry endpoint
  // (My Account → OpenTelemetry tile), e.g. https://otlp-gateway-prod-<region>
  // .grafana.net/otlp ; the sink appends /v1/metrics if missing.
  GRAFANA_OTLP_URL?: string;
  GRAFANA_OTLP_USER?: string;
  GRAFANA_OTLP_TOKEN?: string;
}

export interface CategoryPlaylistMapping {
  category: string;
  playlistId: string;
  /**
   * When true, entries whose URL is recognised as a YouTube Short
   * (`/shorts/VIDEO_ID`) are not added to the playlist; their Miniflux
   * entry is marked read directly. URL-based detection only — Shorts
   * served as plain `/watch?v=` URLs slip through. Default false.
   */
  skipShorts?: boolean;
}

/**
 * Result of parsing a YouTube video URL. `isShort` is true only for
 * `/shorts/VIDEO_ID` URLs; standard watch URLs that happen to point to a
 * Short video are not detected here (would require a `videos.list` API
 * call to read the duration / aspect ratio).
 */
export interface ExtractedVideo {
  videoId: string;
  isShort: boolean;
}

export interface MinifluxCategory {
  id: number;
  title: string;
}

export interface MinifluxEntry {
  id: number;
  url: string;
  title: string;
  status: 'unread' | 'read' | 'removed';
}

export interface PlaylistItemRef {
  playlistItemId: string;
  videoId: string;
}

export interface QueueRow {
  minifluxEntryId: number;
  youtubeVideoId: string;
  youtubePlaylistId: string;
  playlistItemId: string;
  addedAt: number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Thrown when a YouTube `playlistItems.insert` indicates the video is
 * private, deleted, region-blocked, or otherwise terminally unavailable.
 * The sync loop swallows this and marks the Miniflux entry read.
 */
export class VideoUnavailableError extends Error {
  constructor(
    public readonly videoId: string,
    message: string,
  ) {
    super(message);
    this.name = 'VideoUnavailableError';
  }
}

/**
 * Thrown when Miniflux returns 404 on `mark_read`. Expected outcome when
 * an entry has been rotated out of the feed or deleted by the publisher.
 */
export class MinifluxEntryNotFoundError extends Error {
  constructor(public readonly entryId: number) {
    super(`miniflux entry ${entryId} not found`);
    this.name = 'MinifluxEntryNotFoundError';
  }
}

/**
 * Thrown for conditions that must abort the run: quota exhaustion,
 * `invalid_grant` on OAuth refresh, and similar non-recoverable states.
 * The top-level handler pings the Healthchecks failure URL and rethrows.
 */
export class FatalError extends Error {
  constructor(
    public readonly reason: string,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = 'FatalError';
  }
}
