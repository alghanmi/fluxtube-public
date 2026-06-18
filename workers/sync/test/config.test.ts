import { describe, expect, it } from 'vitest';
import { extractVideo, extractVideoId, parseCategoryPlaylistMapping } from '../src/config';

describe('parseCategoryPlaylistMapping', () => {
  it('returns parsed entries for a valid mapping', () => {
    const raw = JSON.stringify([
      { category: 'YouTube — Cycling', playlist_id: 'PLabcdefghijklmnop' },
      { category: 'YouTube — Tech', playlist_id: 'PLqrstuvwxyz123456' },
    ]);
    expect(parseCategoryPlaylistMapping(raw)).toEqual([
      { category: 'YouTube — Cycling', playlistId: 'PLabcdefghijklmnop' },
      { category: 'YouTube — Tech', playlistId: 'PLqrstuvwxyz123456' },
    ]);
  });

  it('trims category whitespace but does not lowercase', () => {
    const raw = JSON.stringify([{ category: '  YouTube — Cycling  ', playlist_id: 'PLxyz' }]);
    expect(parseCategoryPlaylistMapping(raw)).toEqual([
      { category: 'YouTube — Cycling', playlistId: 'PLxyz' },
    ]);
  });

  it('rejects WL with a clear error', () => {
    const raw = JSON.stringify([{ category: 'Watch', playlist_id: 'WL' }]);
    expect(() => parseCategoryPlaylistMapping(raw)).toThrow(/Watch Later/i);
  });

  it('rejects playlist IDs that do not start with PL', () => {
    const raw = JSON.stringify([{ category: 'X', playlist_id: 'XYZabc123' }]);
    expect(() => parseCategoryPlaylistMapping(raw)).toThrow(/must start with "PL"/);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseCategoryPlaylistMapping('not-json')).toThrow(/not valid JSON/i);
  });

  it('rejects non-array top level', () => {
    expect(() => parseCategoryPlaylistMapping('{}')).toThrow(/must be a JSON array/);
  });

  it('rejects entries missing required fields', () => {
    expect(() =>
      parseCategoryPlaylistMapping(JSON.stringify([{ category: 'X' }])),
    ).toThrow(/playlist_id/);
    expect(() =>
      parseCategoryPlaylistMapping(JSON.stringify([{ playlist_id: 'PLxxx' }])),
    ).toThrow(/category/);
  });

  it('allows empty mapping (treated as no-op)', () => {
    expect(parseCategoryPlaylistMapping('[]')).toEqual([]);
  });

  it('throws on missing or empty input', () => {
    expect(() => parseCategoryPlaylistMapping(undefined)).toThrow(/required/);
    expect(() => parseCategoryPlaylistMapping('')).toThrow(/required/);
  });

  it('deduplicates identical (category, playlist) pairs', () => {
    const raw = JSON.stringify([
      { category: 'X', playlist_id: 'PLone' },
      { category: 'X', playlist_id: 'PLone' },
    ]);
    expect(parseCategoryPlaylistMapping(raw)).toHaveLength(1);
  });

  it('preserves many-to-one (multiple categories → one playlist)', () => {
    const raw = JSON.stringify([
      { category: 'A', playlist_id: 'PLshared' },
      { category: 'B', playlist_id: 'PLshared' },
    ]);
    expect(parseCategoryPlaylistMapping(raw)).toHaveLength(2);
  });

  it('preserves one-to-many (one category → multiple playlists)', () => {
    const raw = JSON.stringify([
      { category: 'A', playlist_id: 'PLone' },
      { category: 'A', playlist_id: 'PLtwo' },
    ]);
    expect(parseCategoryPlaylistMapping(raw)).toHaveLength(2);
  });

  it('accepts skip_shorts: true and emits skipShorts: true', () => {
    const raw = JSON.stringify([
      { category: 'A', playlist_id: 'PLxyz', skip_shorts: true },
    ]);
    expect(parseCategoryPlaylistMapping(raw)).toEqual([
      { category: 'A', playlistId: 'PLxyz', skipShorts: true },
    ]);
  });

  it('omits skipShorts entirely when skip_shorts is false or absent', () => {
    const raw = JSON.stringify([
      { category: 'A', playlist_id: 'PLxyz', skip_shorts: false },
      { category: 'B', playlist_id: 'PLabc' },
    ]);
    expect(parseCategoryPlaylistMapping(raw)).toEqual([
      { category: 'A', playlistId: 'PLxyz' },
      { category: 'B', playlistId: 'PLabc' },
    ]);
  });

  it('rejects non-boolean skip_shorts', () => {
    const raw = JSON.stringify([
      { category: 'A', playlist_id: 'PLxyz', skip_shorts: 'yes' },
    ]);
    expect(() => parseCategoryPlaylistMapping(raw)).toThrow(/skip_shorts must be a boolean/);
  });
});

describe('extractVideoId', () => {
  it('parses watch?v= URLs', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&feature=share')).toBe(
      'dQw4w9WgXcQ',
    );
    expect(extractVideoId('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('parses youtu.be short URLs', () => {
    expect(extractVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractVideoId('https://youtu.be/dQw4w9WgXcQ?si=abc')).toBe('dQw4w9WgXcQ');
  });

  it('parses /shorts/ URLs', () => {
    expect(extractVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('flags /shorts/ URLs as Shorts via extractVideo', () => {
    expect(extractVideo('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toEqual({
      videoId: 'dQw4w9WgXcQ',
      isShort: true,
    });
    expect(extractVideo('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({
      videoId: 'dQw4w9WgXcQ',
      isShort: false,
    });
    expect(extractVideo('https://www.youtube.com/live/dQw4w9WgXcQ')).toEqual({
      videoId: 'dQw4w9WgXcQ',
      isShort: false,
    });
    expect(extractVideo('https://youtu.be/dQw4w9WgXcQ')).toEqual({
      videoId: 'dQw4w9WgXcQ',
      isShort: false,
    });
  });

  it('parses /live/ URLs', () => {
    expect(extractVideoId('https://www.youtube.com/live/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('returns null for non-YouTube URLs', () => {
    expect(extractVideoId('https://vimeo.com/12345')).toBeNull();
    expect(extractVideoId('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
  });

  it('returns null for malformed URLs', () => {
    expect(extractVideoId('not-a-url')).toBeNull();
    expect(extractVideoId('')).toBeNull();
  });

  it('returns null for non-video YouTube URLs', () => {
    expect(extractVideoId('https://www.youtube.com/playlist?list=PLxxx')).toBeNull();
    expect(extractVideoId('https://www.youtube.com/@channel')).toBeNull();
    expect(extractVideoId('https://www.youtube.com/')).toBeNull();
  });

  it('returns null for IDs that are not exactly 11 chars', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=short')).toBeNull();
    expect(extractVideoId('https://www.youtube.com/watch?v=way_too_long_video_id')).toBeNull();
  });
});
