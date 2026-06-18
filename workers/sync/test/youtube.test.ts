import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUOTA_ABORT_THRESHOLD, YouTubeClient } from '../src/youtube';
import { FatalError, VideoUnavailableError } from '../src/types';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

function tokenResponse(token = 'access-token-1') {
  return jsonResponse({ access_token: token, expires_in: 3600, token_type: 'Bearer' });
}

const creds = {
  clientId: 'cid',
  clientSecret: 'csecret',
  refreshToken: 'rtoken',
};

describe('YouTubeClient — token refresh', () => {
  it('mints an access token once and reuses it across calls', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ items: [], nextPageToken: undefined }))
      .mockResolvedValueOnce(jsonResponse({ items: [], nextPageToken: undefined }));

    const yt = new YouTubeClient(creds);
    await yt.listPlaylistItems('PLone');
    await yt.listPlaylistItems('PLtwo');

    const tokenCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).startsWith('https://oauth2.googleapis.com/token'),
    );
    expect(tokenCalls).toHaveLength(1);
  });

  it('throws FatalError(invalid_grant) when token refresh returns invalid_grant', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, { status: 400 }));

    const yt = new YouTubeClient(creds);
    await expect(yt.listPlaylistItems('PLone')).rejects.toMatchObject({
      name: 'FatalError',
      reason: 'invalid_grant',
    });
  });
});

describe('YouTubeClient — listPlaylistItems', () => {
  it('paginates through nextPageToken and aggregates videoIds', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            { id: 'PI_a', contentDetails: { videoId: 'aaaaaaaaaaa' } },
            { id: 'PI_b', contentDetails: { videoId: 'bbbbbbbbbbb' } },
          ],
          nextPageToken: 'page2',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: 'PI_c', contentDetails: { videoId: 'ccccccccccc' } }],
        }),
      );

    const yt = new YouTubeClient(creds);
    const items = await yt.listPlaylistItems('PLfoo');
    expect(items).toEqual([
      { playlistItemId: 'PI_a', videoId: 'aaaaaaaaaaa' },
      { playlistItemId: 'PI_b', videoId: 'bbbbbbbbbbb' },
      { playlistItemId: 'PI_c', videoId: 'ccccccccccc' },
    ]);
    expect(yt.quotaUsed).toBe(2);
  });
});

describe('YouTubeClient — insertPlaylistItem', () => {
  it('returns the new playlist item ref on 200', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ id: 'PI_new' }));
    const yt = new YouTubeClient(creds);
    const ref = await yt.insertPlaylistItem('PLfoo', 'vvvvvvvvvvv');
    expect(ref).toEqual({ playlistItemId: 'PI_new', videoId: 'vvvvvvvvvvv' });
  });

  it('throws VideoUnavailableError on 404', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response('not found', { status: 404 }));
    const yt = new YouTubeClient(creds);
    await expect(yt.insertPlaylistItem('PLfoo', 'xxxxxxxxxxx')).rejects.toBeInstanceOf(
      VideoUnavailableError,
    );
  });

  it('throws VideoUnavailableError on 403', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    const yt = new YouTubeClient(creds);
    await expect(yt.insertPlaylistItem('PLfoo', 'xxxxxxxxxxx')).rejects.toBeInstanceOf(
      VideoUnavailableError,
    );
  });

  it('charges 50 quota units per insert', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ id: 'PI_new' }));
    const yt = new YouTubeClient(creds);
    await yt.insertPlaylistItem('PLfoo', 'vvvvvvvvvvv');
    expect(yt.quotaUsed).toBe(50);
  });
});

describe('YouTubeClient — quota abort', () => {
  it('aborts with FatalError once quota crosses the threshold', async () => {
    const okList = jsonResponse({ items: [] });
    fetchMock.mockResolvedValueOnce(tokenResponse());
    // Each list costs 1 unit; chain enough to exceed the threshold.
    const callsNeeded = QUOTA_ABORT_THRESHOLD + 1;
    for (let i = 0; i < callsNeeded; i++) {
      fetchMock.mockResolvedValueOnce(okList.clone());
    }

    const yt = new YouTubeClient(creds);
    let caught: unknown;
    try {
      for (let i = 0; i < callsNeeded; i++) {
        await yt.listPlaylistItems('PLfoo');
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FatalError);
    expect((caught as FatalError).reason).toBe('quota_exhausted');
  });
});
