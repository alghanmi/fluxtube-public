import { extractVideoId } from './config';
import type { CategoryPlaylistMapping, PlaylistItemRef } from './types';
import type { MinifluxClient } from './miniflux';
import type { YouTubeClient } from './youtube';
import type { QueueState } from './state';
import type { Logger } from './logger';

export interface AuditDeps {
  miniflux: MinifluxClient;
  youtube: YouTubeClient;
  state: QueueState;
  logger: Logger;
}

/**
 * Per-pair audit row. Counts come from a single point-in-time snapshot and are
 * meant for operator debugging — not for triggering writes. The four diff
 * buckets are mutually exclusive and partition the union of `miniflux_unread`
 * entries with `state.rowsForPlaylist` rows for the same playlist.
 */
export interface AuditPair {
  category: string;
  category_id: number | null;
  playlist_id: string;
  miniflux_unread_count: number;
  youtube_playlist_size: number;
  d1_tracked_count: number;
  not_a_youtube_url: number;
  untracked_unread_in_playlist: { entry_id: number; video_id: string }[];
  untracked_unread_not_in_playlist: { entry_id: number; video_id: string }[];
  tracked_but_missing_from_playlist: { entry_id: number; video_id: string }[];
}

export interface AuditReport {
  generated_at: string;
  pairs: AuditPair[];
  d1_orphan_playlist_ids: string[];
}

export async function audit(
  mapping: CategoryPlaylistMapping[],
  deps: AuditDeps,
): Promise<AuditReport> {
  const { miniflux, youtube, state } = deps;

  const categories = await miniflux.listCategories();
  const categoryIdByName = new Map<string, number>();
  for (const c of categories) categoryIdByName.set(c.title, c.id);

  const playlistCache = new Map<string, PlaylistItemRef[]>();
  const getPlaylistItems = async (playlistId: string): Promise<PlaylistItemRef[]> => {
    const cached = playlistCache.get(playlistId);
    if (cached !== undefined) return cached;
    const items = await youtube.listPlaylistItems(playlistId);
    playlistCache.set(playlistId, items);
    return items;
  };

  const pairs: AuditPair[] = [];

  for (const pair of mapping) {
    const categoryId = categoryIdByName.get(pair.category) ?? null;

    const unread =
      categoryId === null ? [] : await miniflux.listUnreadInCategory(categoryId);
    const playlistItems = await getPlaylistItems(pair.playlistId);
    const trackedRows = await state.rowsForPlaylist(pair.playlistId);

    const playlistVideoIds = new Set(playlistItems.map((it) => it.videoId));
    const trackedEntryIds = new Set(trackedRows.map((r) => r.minifluxEntryId));

    let notYoutube = 0;
    const untrackedInPlaylist: { entry_id: number; video_id: string }[] = [];
    const untrackedNotInPlaylist: { entry_id: number; video_id: string }[] = [];

    for (const entry of unread) {
      const videoId = extractVideoId(entry.url);
      if (videoId === null) {
        notYoutube++;
        continue;
      }
      if (trackedEntryIds.has(entry.id)) continue;
      if (playlistVideoIds.has(videoId)) {
        untrackedInPlaylist.push({ entry_id: entry.id, video_id: videoId });
      } else {
        untrackedNotInPlaylist.push({ entry_id: entry.id, video_id: videoId });
      }
    }

    const trackedMissing = trackedRows
      .filter((r) => !playlistVideoIds.has(r.youtubeVideoId))
      .map((r) => ({ entry_id: r.minifluxEntryId, video_id: r.youtubeVideoId }));

    pairs.push({
      category: pair.category,
      category_id: categoryId,
      playlist_id: pair.playlistId,
      miniflux_unread_count: unread.length,
      youtube_playlist_size: playlistItems.length,
      d1_tracked_count: trackedRows.length,
      not_a_youtube_url: notYoutube,
      untracked_unread_in_playlist: untrackedInPlaylist,
      untracked_unread_not_in_playlist: untrackedNotInPlaylist,
      tracked_but_missing_from_playlist: trackedMissing,
    });
  }

  const mappingPlaylistIds = new Set(mapping.map((p) => p.playlistId));
  const allTrackedPlaylistIds = await state.allPlaylistIds();
  const d1OrphanPlaylistIds = allTrackedPlaylistIds.filter(
    (id) => !mappingPlaylistIds.has(id),
  );

  return {
    generated_at: new Date().toISOString(),
    pairs,
    d1_orphan_playlist_ids: d1OrphanPlaylistIds,
  };
}
