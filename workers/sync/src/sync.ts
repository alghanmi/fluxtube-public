import { extractVideo } from './config';
import { FatalError, MinifluxEntryNotFoundError, VideoUnavailableError } from './types';
import type { CategoryPlaylistMapping, PlaylistItemRef } from './types';
import type { MinifluxClient } from './miniflux';
import type { YouTubeClient } from './youtube';
import type { QueueState } from './state';
import type { Logger } from './logger';

export interface SyncDeps {
  miniflux: MinifluxClient;
  youtube: YouTubeClient;
  state: QueueState;
  logger: Logger;
  now?: () => number;
}

/**
 * High-level outcome of a single sync run. Returned to callers that want to
 * surface counts (e.g. the synchronous `/sync?wait=1` operator endpoint and
 * the structured `sync_complete` log line). Side-effect-equivalent fakes used
 * in tests can ignore the return value.
 */
export interface RunSummary {
  added: number;
  marked_read: number;
  skipped_tracked: number;
  skipped_existing_in_playlist: number;
  skipped_unavailable: number;
  skipped_shorts: number;
  entry_errors: number;
  removal_errors: number;
  quota_used: number;
  duration_ms: number;
}

function emptySummary(): Omit<RunSummary, 'quota_used' | 'duration_ms'> {
  return {
    added: 0,
    marked_read: 0,
    skipped_tracked: 0,
    skipped_existing_in_playlist: 0,
    skipped_unavailable: 0,
    skipped_shorts: 0,
    entry_errors: 0,
    removal_errors: 0,
  };
}

/**
 * Run one sync cycle. Implements the canonical algorithm in AGENTS.md:
 *
 *   Pass 1: for each (category, playlist) pair, fetch unread Miniflux entries
 *           and insert any whose video isn't already in D1 or in the playlist.
 *   Pass 2: for each tracked playlist, detect videos the user has removed and
 *           clean up D1; mark Miniflux entries read once their last D1 row
 *           is gone.
 *
 * Errors strategy: per-entry failures inside Pass 1 are logged and skipped so a
 * single bad entry never aborts the run. Only `FatalError` (quota, invalid
 * grant) escapes; the caller pings Healthchecks failure and rethrows.
 */
export async function runSync(
  mapping: CategoryPlaylistMapping[],
  deps: SyncDeps,
): Promise<RunSummary> {
  const { miniflux, youtube, state, logger } = deps;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const startedAt = Date.now();
  const counts = emptySummary();

  if (mapping.length === 0) {
    logger.info('sync_noop', { reason: 'empty_mapping' });
    return { ...counts, quota_used: youtube.quotaUsed, duration_ms: Date.now() - startedAt };
  }

  // ── Resolve category names → category IDs once per run ────────────────────
  const categories = await miniflux.listCategories();
  const categoryIdByName = new Map<string, number>();
  for (const c of categories) categoryIdByName.set(c.title, c.id);

  // ── Cache YouTube playlist contents (one fetch per unique playlist) ───────
  const playlistCache = new Map<string, PlaylistItemRef[]>();

  async function getPlaylistItems(playlistId: string): Promise<PlaylistItemRef[]> {
    const cached = playlistCache.get(playlistId);
    if (cached !== undefined) return cached;
    const items = await youtube.listPlaylistItems(playlistId);
    playlistCache.set(playlistId, items);
    return items;
  }

  // ── Pass 1: add new videos ────────────────────────────────────────────────
  for (const pair of mapping) {
    const categoryId = categoryIdByName.get(pair.category);
    if (categoryId === undefined) {
      logger.warn('miniflux_category_not_found', {
        category: pair.category,
        playlist_id: pair.playlistId,
      });
      continue;
    }

    let unread: Awaited<ReturnType<MinifluxClient['listUnreadInCategory']>>;
    try {
      unread = await miniflux.listUnreadInCategory(categoryId);
    } catch (err) {
      logger.error('miniflux_list_unread_failed', {
        category: pair.category,
        category_id: categoryId,
        error: errMsg(err),
      });
      continue;
    }

    let playlistItems: PlaylistItemRef[];
    try {
      playlistItems = await getPlaylistItems(pair.playlistId);
    } catch (err) {
      if (err instanceof FatalError) throw err;
      logger.error('youtube_list_playlist_failed', {
        playlist_id: pair.playlistId,
        error: errMsg(err),
      });
      continue;
    }
    // videoId → PlaylistItemRef lookup so we can grab the real playlistItemId
    // when a video is already in the playlist (e.g. user added it manually,
    // or FluxTube added it on a prior run and the D1 row was lost). We still
    // need to write a D1 row so Pass 2 can detect the user's removal later.
    const playlistItemByVideoId = new Map(playlistItems.map((it) => [it.videoId, it]));

    for (const entry of unread) {
      const extracted = extractVideo(entry.url);
      if (extracted === null) {
        logger.warn('not_a_youtube_url', {
          entry_id: entry.id,
          url: entry.url,
        });
        continue;
      }
      const { videoId, isShort } = extracted;

      try {
        // skip_shorts: drop /shorts/ URLs cleanly — never inserted into the
        // playlist; the Miniflux entry is marked read directly so the queue
        // doesn't grow. URL-based detection only; Shorts that arrive as
        // /watch?v= URLs slip through (would need a videos.list quota call).
        if (pair.skipShorts && isShort) {
          try {
            await miniflux.markRead([entry.id]);
          } catch (markErr) {
            if (markErr instanceof MinifluxEntryNotFoundError) {
              logger.info('entry_gone_from_miniflux', { entry_id: entry.id });
            } else {
              logger.error('miniflux_mark_read_failed', {
                entry_id: entry.id,
                error: errMsg(markErr),
              });
            }
          }
          counts.skipped_shorts++;
          logger.info('skipped_short', {
            entry_id: entry.id,
            video_id: videoId,
            playlist_id: pair.playlistId,
          });
          continue;
        }

        if (await state.exists(entry.id, pair.playlistId)) {
          counts.skipped_tracked++;
          logger.debug('skipped_tracked', {
            entry_id: entry.id,
            video_id: videoId,
            playlist_id: pair.playlistId,
          });
          continue;
        }

        const existingRef = playlistItemByVideoId.get(videoId);
        if (existingRef !== undefined) {
          // Video is already in the playlist but no D1 row exists for it:
          // either the user added it manually, or FluxTube added it on a
          // prior run whose D1 row was lost. Track it now so Pass 2 can
          // detect the user removing it later and mark the Miniflux entry
          // read at that point.
          await state.insert({
            minifluxEntryId: entry.id,
            youtubeVideoId: videoId,
            youtubePlaylistId: pair.playlistId,
            playlistItemId: existingRef.playlistItemId,
            addedAt: now(),
          });
          counts.skipped_existing_in_playlist++;
          logger.info('tracked_existing_in_playlist', {
            entry_id: entry.id,
            video_id: videoId,
            playlist_id: pair.playlistId,
            playlist_item_id: existingRef.playlistItemId,
          });
          continue;
        }

        const item = await youtube.insertPlaylistItem(pair.playlistId, videoId);
        await state.insert({
          minifluxEntryId: entry.id,
          youtubeVideoId: videoId,
          youtubePlaylistId: pair.playlistId,
          playlistItemId: item.playlistItemId,
          addedAt: now(),
        });
        playlistItemByVideoId.set(videoId, item);
        // Keep the per-run playlist cache consistent with what we just
        // inserted on YouTube — otherwise Pass 2, which reads from the same
        // cache, treats the just-added video as "no longer in playlist" and
        // wrongly deletes the D1 row + marks the Miniflux entry read.
        playlistItems.push(item);
        counts.added++;
        logger.info('added', {
          entry_id: entry.id,
          video_id: videoId,
          playlist_id: pair.playlistId,
          playlist_item_id: item.playlistItemId,
        });
      } catch (err) {
        if (err instanceof VideoUnavailableError) {
          try {
            await miniflux.markRead([entry.id]);
          } catch (markErr) {
            if (markErr instanceof MinifluxEntryNotFoundError) {
              logger.info('entry_gone_from_miniflux', { entry_id: entry.id });
            } else {
              logger.error('miniflux_mark_read_failed', {
                entry_id: entry.id,
                error: errMsg(markErr),
              });
            }
          }
          counts.skipped_unavailable++;
          logger.info('skipped_unavailable', {
            entry_id: entry.id,
            video_id: videoId,
          });
          continue;
        }
        if (err instanceof FatalError) throw err;
        counts.entry_errors++;
        logger.error('entry_processing_failed', {
          entry_id: entry.id,
          video_id: videoId,
          playlist_id: pair.playlistId,
          error: errMsg(err),
        });
      }
    }
  }

  // ── Pass 2: detect removals across all tracked playlists ──────────────────
  const trackedPlaylistIds = await state.allPlaylistIds();

  for (const playlistId of trackedPlaylistIds) {
    let playlistItems: PlaylistItemRef[];
    try {
      playlistItems = await getPlaylistItems(playlistId);
    } catch (err) {
      if (err instanceof FatalError) throw err;
      logger.error('youtube_list_playlist_failed', {
        playlist_id: playlistId,
        phase: 'pass2',
        error: errMsg(err),
      });
      continue;
    }
    const currentVideoIds = new Set(playlistItems.map((it) => it.videoId));

    let tracked: Awaited<ReturnType<QueueState['rowsForPlaylist']>>;
    try {
      tracked = await state.rowsForPlaylist(playlistId);
    } catch (err) {
      logger.error('state_rows_for_playlist_failed', {
        playlist_id: playlistId,
        error: errMsg(err),
      });
      continue;
    }

    for (const row of tracked) {
      if (currentVideoIds.has(row.youtubeVideoId)) continue;

      try {
        // Mark Miniflux read BEFORE deleting the D1 row. If we deleted first
        // and the markRead call later failed with a non-404, we'd lose the
        // link between the entry and any D1 record — the entry would stay
        // unread in Miniflux forever with no retry. With this order, a
        // transient markRead failure leaves the D1 row in place and the next
        // Pass 2 retries naturally. 404 is a clean miss — proceed to delete.
        const isLastTrackingRow = !(await state.hasOtherRowsForEntry(
          row.minifluxEntryId,
          playlistId,
        ));

        if (isLastTrackingRow) {
          try {
            await miniflux.markRead([row.minifluxEntryId]);
            counts.marked_read++;
            logger.info('marked_read', {
              entry_id: row.minifluxEntryId,
              video_id: row.youtubeVideoId,
              playlist_id: playlistId,
            });
          } catch (err) {
            if (err instanceof MinifluxEntryNotFoundError) {
              counts.marked_read++;
              logger.info('entry_gone_from_miniflux', {
                entry_id: row.minifluxEntryId,
                video_id: row.youtubeVideoId,
                playlist_id: playlistId,
              });
            } else {
              throw err;
            }
          }
        }

        await state.delete(row.minifluxEntryId, playlistId);
      } catch (err) {
        if (err instanceof FatalError) throw err;
        counts.removal_errors++;
        logger.error('removal_processing_failed', {
          entry_id: row.minifluxEntryId,
          video_id: row.youtubeVideoId,
          playlist_id: playlistId,
          error: errMsg(err),
        });
      }
    }
  }

  const summary: RunSummary = {
    ...counts,
    quota_used: youtube.quotaUsed,
    duration_ms: Date.now() - startedAt,
  };
  logger.info('sync_complete', { ...summary });
  return summary;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
