import { FatalError, VideoUnavailableError } from './types';
import type { PlaylistItemRef } from './types';

const FETCH_TIMEOUT_MS = 10_000;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PLAYLIST_ITEMS_URL = 'https://www.googleapis.com/youtube/v3/playlistItems';

const COST_LIST = 1;
const COST_INSERT = 50;

/** Abort the run if a single invocation has spent more than this much. */
export const QUOTA_ABORT_THRESHOLD = 8000;

export interface YouTubeCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export class YouTubeClient {
  private accessToken: string | null = null;
  private quotaSpent = 0;

  constructor(private readonly creds: YouTubeCredentials) {
    if (!creds.clientId) throw new Error('YOUTUBE_CLIENT_ID is required');
    if (!creds.clientSecret) throw new Error('YOUTUBE_CLIENT_SECRET is required');
    if (!creds.refreshToken) throw new Error('YOUTUBE_REFRESH_TOKEN is required');
  }

  /** Total quota units consumed so far in this run. */
  get quotaUsed(): number {
    return this.quotaSpent;
  }

  /**
   * Mint a fresh access token from the refresh token. Workers are stateless
   * so this runs once per invocation; the access token mint itself does not
   * count against the 10k quota.
   *
   * `invalid_grant` is fatal — the refresh token has been revoked and the
   * user must re-run `oauth-bootstrap`. Caller should ping Healthchecks fail.
   */
  private async ensureAccessToken(): Promise<string> {
    if (this.accessToken !== null) return this.accessToken;

    const body = new URLSearchParams({
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
      refresh_token: this.creds.refreshToken,
      grant_type: 'refresh_token',
    });

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new FatalError(
        'oauth_token_unparseable',
        `OAuth token endpoint returned non-JSON: ${res.status} ${text.slice(0, 200)}`,
      );
    }

    if (!res.ok) {
      const errCode =
        parsed !== null && typeof parsed === 'object' && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : 'unknown';
      if (errCode === 'invalid_grant') {
        throw new FatalError(
          'invalid_grant',
          'YouTube refresh token has been revoked or is expired. Re-run scripts/oauth-bootstrap.ts.',
        );
      }
      throw new FatalError(
        'oauth_refresh_failed',
        `OAuth refresh failed: ${res.status} ${errCode}`,
      );
    }

    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof (parsed as { access_token?: unknown }).access_token !== 'string'
    ) {
      throw new FatalError('oauth_token_invalid', 'OAuth token response missing access_token');
    }

    this.accessToken = (parsed as { access_token: string }).access_token;
    return this.accessToken;
  }

  private chargeQuota(units: number): void {
    this.quotaSpent += units;
    if (this.quotaSpent > QUOTA_ABORT_THRESHOLD) {
      throw new FatalError(
        'quota_exhausted',
        `YouTube quota usage ${this.quotaSpent} exceeded threshold ${QUOTA_ABORT_THRESHOLD}`,
      );
    }
  }

  private async authedFetch(url: string, init: RequestInit): Promise<Response> {
    const token = await this.ensureAccessToken();
    return fetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  }

  /**
   * List every video ID currently in a playlist. Pages through the API
   * (50 per page) until exhausted. Costs 1 unit per page.
   */
  async listPlaylistItems(playlistId: string): Promise<PlaylistItemRef[]> {
    const out: PlaylistItemRef[] = [];
    let pageToken: string | undefined;

    for (;;) {
      const params = new URLSearchParams({
        part: 'contentDetails',
        playlistId,
        maxResults: '50',
      });
      if (pageToken !== undefined) params.set('pageToken', pageToken);

      this.chargeQuota(COST_LIST);
      const res = await this.authedFetch(`${PLAYLIST_ITEMS_URL}?${params.toString()}`, {
        method: 'GET',
      });

      if (!res.ok) {
        // 404 on a playlist we own should not happen unless the playlist was
        // deleted. Surface as fatal; the user must update their config.
        throw new FatalError(
          'playlist_list_failed',
          `playlistItems.list failed for ${playlistId}: ${res.status} ${await safeText(res)}`,
        );
      }

      const body: unknown = await res.json();
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('playlistItems.list returned non-object');
      }
      const items = (body as { items?: unknown }).items;
      if (!Array.isArray(items)) {
        throw new Error('playlistItems.list response missing `items` array');
      }

      for (const [i, raw] of items.entries()) {
        if (raw === null || typeof raw !== 'object') {
          throw new Error(`playlistItems[${i}] is not an object`);
        }
        const obj = raw as Record<string, unknown>;
        const itemId = obj['id'];
        const cd = obj['contentDetails'];
        if (typeof itemId !== 'string' || cd === null || typeof cd !== 'object') {
          throw new Error(`playlistItems[${i}] missing id or contentDetails`);
        }
        const videoId = (cd as { videoId?: unknown }).videoId;
        if (typeof videoId !== 'string') {
          throw new Error(`playlistItems[${i}].contentDetails.videoId missing`);
        }
        out.push({ playlistItemId: itemId, videoId });
      }

      const next = (body as { nextPageToken?: unknown }).nextPageToken;
      if (typeof next !== 'string' || next === '') break;
      pageToken = next;
    }

    return out;
  }

  /**
   * Add a video to a playlist. Costs 50 quota units.
   *
   * 404/403 responses are terminal for the video (private, deleted,
   * region-blocked, removed by uploader) — caller should mark the Miniflux
   * entry read and not retry. Surfaced as `VideoUnavailableError`.
   */
  async insertPlaylistItem(playlistId: string, videoId: string): Promise<PlaylistItemRef> {
    this.chargeQuota(COST_INSERT);

    const params = new URLSearchParams({ part: 'snippet' });
    const res = await this.authedFetch(`${PLAYLIST_ITEMS_URL}?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        snippet: {
          playlistId,
          resourceId: { kind: 'youtube#video', videoId },
        },
      }),
    });

    if (res.status === 404 || res.status === 403) {
      throw new VideoUnavailableError(
        videoId,
        `playlistItems.insert returned ${res.status} for video ${videoId}`,
      );
    }

    if (!res.ok) {
      throw new Error(
        `playlistItems.insert failed for video ${videoId}: ${res.status} ${await safeText(res)}`,
      );
    }

    const body: unknown = await res.json();
    if (
      body === null ||
      typeof body !== 'object' ||
      typeof (body as { id?: unknown }).id !== 'string'
    ) {
      throw new Error('playlistItems.insert response missing id');
    }
    return { playlistItemId: (body as { id: string }).id, videoId };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}
