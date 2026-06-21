# FluxTube — Architecture

Deep-dive on the design. README.md has the elevator pitch; CLAUDE.md is the canonical agent-facing reference. This file is for humans who want to know *why* something is shaped a particular way.

---

## Goals and non-goals

**Goal:** preserve a YouTube-native viewing experience (offline downloads, cross-device progress sync) while removing the manual step of copying RSS-discovered YouTube videos into a playlist. The user keeps reading in Miniflux and watching in YouTube; FluxTube glues the two together.

**Non-goals** (explicitly out of scope; will be rejected without a new requirements discussion):

- Downloading or re-hosting videos.
- Modifying / uploading videos.
- Multi-user support.
- A UI beyond `wrangler tail`, D1 inspection, Healthchecks.io, the `/audit` JSON dump, and Grafana Cloud Loki.
- Custom alerting channels beyond Healthchecks.io and Loki.
- Watch Later (`WL`) — not API-accessible since August 2016.
- Migration tooling between RSS readers.
- Handling non-YouTube video URLs.

---

## Composition

```
                     ┌──────────────────────────────────────┐
                     │       Cloudflare Worker              │
                     │       (TypeScript, V8 isolate)       │
                     │                                      │
                     │  scheduled(cron */30)  ──── runSync  │
                     │  fetch(POST /sync)     ──── runSync  │
                     │  fetch(GET  /audit)    ──── audit    │
                     └─────────────┬────────────────────────┘
                                   │
        ┌──────────────┬───────────┼─────────┬─────────────┐
        ▼              ▼           ▼         ▼             ▼
   ┌─────────┐  ┌─────────────┐  ┌────┐  ┌──────────┐  ┌──────────┐
   │ Miniflux│  │   YouTube   │  │ D1 │  │   HC.io  │  │  Grafana │
   │  REST   │  │  Data API   │  │SQL │  │ (×3 chk) │  │   Loki   │
   │         │  │   (OAuth)   │  │    │  │          │  │ (optional)│
   └─────────┘  └─────────────┘  └────┘  └──────────┘  └──────────┘
```

Every component except D1 is external; D1 is the only state FluxTube owns.

---

## Pass 1 / Pass 2 algorithm

Two sequential passes per run. The split is intentional — Pass 1 only adds, Pass 2 only removes — so the worst-case end state is recoverable even if one pass fails mid-way.

### Pass 1 — add new videos

For each `(category, playlist, skip_shorts?)` in the mapping:

1. Resolve category name → ID via Miniflux's `/v1/categories`.
2. Fetch unread entries in that category, paginated 100 at a time, **oldest first** so playlist order is chronological.
3. Fetch current YouTube playlist contents (once per unique `playlist_id` per run, cached).
4. For each entry, parse the URL with `extractVideo(url)` → `{ videoId, isShort } | null`:
   - If parse fails → log `not_a_youtube_url` and continue (channel pages, malformed links, etc.).
   - If `pair.skipShorts && isShort` → `miniflux.markRead([entry.id])`, log `skipped_short`, continue.
   - If `state.exists(entry.id, playlist_id)` → log `skipped_tracked`, continue.
   - If `videoId` is already in the playlist → backfill the D1 row using the real `playlistItemId` from the `playlistItems.list` response, log `tracked_existing_in_playlist`, continue. *(Handles the user adding videos manually and prior-run D1 rows that were lost.)*
   - Otherwise: `youtube.insertPlaylistItem(playlist_id, videoId)`, then `state.insert(...)`, log `added`. **Push the new item into the cached playlist list** so Pass 2 doesn't immediately think it's missing.

`VideoUnavailableError` (404 / 403 on insert — video is private / deleted / region-locked) is caught and treated as terminal: `miniflux.markRead([entry.id])`, log `skipped_unavailable`. The 4xx tells us the entry will never be watchable.

`FatalError` (`quota_exhausted`, `invalid_grant`) escapes; the top-level handler pings the failure URL and rethrows.

### Pass 2 — detect removals across all tracked playlists

For each distinct `playlist_id` in D1:

1. Fetch the playlist's current videos.
2. Load all tracked rows for that playlist.
3. For each tracked row whose `youtubeVideoId` is **not** in the current playlist (the user removed it):
   - Determine if this is the entry's last tracking row via `state.hasOtherRowsForEntry(entry_id, playlist_id)`.
   - If yes → `miniflux.markRead([entry_id])` **first**, then `state.delete(entry_id, playlist_id)`.
   - If no → just `state.delete(...)`; the entry stays unread because another playlist still tracks it.

The mark-read-before-delete order is load-bearing. The earlier version of this code did `state.delete()` then `markRead()`; a transient Miniflux 5xx between the two left the entry unread forever with no D1 record to drive a retry. The current order means a failed mark-read leaves the D1 row in place and the next Pass 2 tries again. `MinifluxEntryNotFoundError` (404 — the entry was rotated out of the Miniflux feed) is treated as a clean miss: delete the row and continue.

---

## Why D1 (not KV, not in-memory)

The mark-read decision depends on a relational question: *"does any tracking row still exist for entry X across **any** playlist?"* Compound primary key `(miniflux_entry_id, youtube_playlist_id)`, plus an index on each column individually, supports both halves:

- `hasOtherRowsForEntry(entry_id, exclude_playlist_id)` for the mark-read predicate.
- `rowsForPlaylist(playlist_id)` for Pass 2 iteration.
- `allPlaylistIds()` for Pass 2's outer loop.

KV would require maintaining hand-rolled reverse indexes per write. In-memory is impossible because Workers are stateless across invocations and we'd lose the link between runs.

D1 storage is negligible — 5 GB free tier, FluxTube uses kilobytes. Rows are never pruned in v1.

```sql
CREATE TABLE queue (
  miniflux_entry_id   INTEGER NOT NULL,
  youtube_video_id    TEXT    NOT NULL,
  youtube_playlist_id TEXT    NOT NULL,
  playlist_item_id    TEXT    NOT NULL,
  added_at            INTEGER NOT NULL,
  PRIMARY KEY (miniflux_entry_id, youtube_playlist_id)
);
CREATE INDEX idx_queue_video    ON queue(youtube_video_id);
CREATE INDEX idx_queue_playlist ON queue(youtube_playlist_id);
```

---

## Idempotency invariants

Every external write is safe to retry:

- Before `youtube.insertPlaylistItem` we check D1 (`state.exists`) and the cached playlist contents. So a re-run with the same input doesn't add duplicates.
- Before `miniflux.markRead` we check that this is the entry's last D1 row. So a re-run can't mark an entry read prematurely.
- `D1` `INSERT` uses `ON CONFLICT(...) DO NOTHING` so a re-run is a no-op.

The only externally visible side-effect FluxTube can produce in error is a video the user already removed from the playlist getting re-added on the next tick. That happens only if Pass 1 sees an unread entry that has no D1 row and whose video is not in the playlist — and Pass 2 only deletes D1 rows on user-removal, so this path is narrow.

---

## YouTube API quota budget

10,000 units per day default. Per operation:

| Operation | Cost | Frequency |
|---|---|---|
| `playlistItems.list` | 1 | Once per unique playlist per run |
| `playlistItems.insert` | 50 | Once per new video |

At 48 runs/day with moderate volume (~10 new videos), expected daily burn is well under 1,000 units. The Worker aborts the current run with `FatalError('quota_exhausted')` if it crosses 8,000 — that gives a 20% reserve for the rest of the day.

Two things we explicitly *don't* do:

- Never call `search.list` (100 units, not needed).
- Never call `playlistItems.delete` — the user removes videos from the playlist; that's the signal we listen for.

---

## Failure modes and recovery

| Failure | Symptom | Recovery |
|---|---|---|
| YouTube refresh token expires (Google's 7-day Testing-mode policy) | `invalid_grant` in logs → `HEARTBEAT_URL_AUTH/fail` fires within one tick | `./scripts/sync-worker-secrets.sh production --refresh-youtube-token` |
| YouTube quota exhausted | `quota_exhausted` → `HEARTBEAT_URL_QUOTA/fail` | Wait until midnight Pacific; quota resets daily |
| Miniflux transient 5xx mid-run | One or more `entry_processing_failed` / `removal_processing_failed` log lines; run continues | Next cron tick picks up where this one left off |
| Video unavailable on YouTube (private / deleted) | `skipped_unavailable` log line; entry marked read | Nothing to do — terminal state |
| Miniflux entry deleted while still in D1 | `entry_gone_from_miniflux` log line; D1 row cleaned up | Nothing to do — terminal state |
| D1 transient error | One log line per failed row; run continues | Idempotent, next tick reconciles |
| Worker cron didn't fire | Healthchecks.io main check goes red after 35 min | Check Cloudflare dashboard → Cron Triggers |

The **`/audit`** endpoint is the operator's tool for reconciling drift after these failures. It returns a per-pair JSON dump showing, separately:

- Miniflux entries unread but not in D1 and not in the playlist (Pass 1 hasn't added them yet).
- Miniflux entries unread but already in the playlist with no D1 row (backfill candidate).
- D1 rows whose video isn't in the playlist (pending Pass 2 cleanup).
- Entries with unparseable URLs.
- D1 playlist IDs that aren't in the current mapping (orphans from config rotation).

---

## Logging and observability

Every significant event emits one JSON line to stdout, structured:

```json
{"ts":"2026-06-02T07:30:00.000Z","level":"info","event":"added","entry_id":12345,"video_id":"abc...","playlist_id":"PL..."}
```

When `GRAFANA_LOKI_URL` / `_USER` / `_TOKEN` are set, every line is also fanned out to Grafana Cloud Loki via the `LokiSink` (see `workers/sync/src/logsink.ts`):

- Buffered in memory during the run.
- Flushed via `ctx.waitUntil(fetch(...))` at end-of-run (success **or** fatal).
- One stream per invocation, labels `{app: "fluxtube", env: "production", run_id: "<uuid>"}`.
- Fire-and-forget; a Loki outage logs `loki_push_failed` at warn and never affects the sync.

See `docs/observability.md` for query examples.

---

## Cron + manual trigger split

The `scheduled` handler is the production driver: every 30 minutes, Cloudflare Cron Triggers fires it. The `fetch` handler exists for operator actions and is reached on the `workers.dev` subdomain with Bearer auth.

Critical separation: the **`fetch` handler does not ping Healthchecks**. The dead-man's switch is exclusively the cron's signal. Pinging it from a manual call would mask a stuck schedule.

---

## Why Cloudflare (not AWS Lambda or self-hosted)

The decision was three things:

1. **Fewer primitives.** Workers + D1 + Cron + R2 (for TF state) is four resources, all in one console. The equivalent on AWS is Lambda + EventBridge + DynamoDB + S3 + IAM glue.
2. **The data model fits D1 better than DynamoDB.** "Does any row exist for entry X across all playlists?" is a one-line SQL query in D1 and requires a GSI in DynamoDB.
3. **No cold start on cron.** V8 isolates start in microseconds. Every cron tick is fast.

The Workers free tier's 10ms CPU limit is irrelevant here — almost all wall time is `fetch()` I/O, which doesn't count against CPU. If profiling ever shows CPU pressure, $5/mo Workers Paid lifts it to 30s.

---

## What lives where

| Source of truth | Owns |
|---|---|
| This repo (public) | Worker source, Terraform code, dashboards + alerts JSON, release-please config |
| The deploy companion (private) | The values Terraform consumes (CF account ID, R2 bucket, etc.), the secrets the Worker reads, the deploy workflow that stitches it all together |
| Terraform HCL (here, applied from the deploy companion) | All Cloudflare resources: D1, Worker script, cron trigger, plain_text bindings |
| Wrangler (`wrangler deploy --keep-vars`, run by the deploy companion's workflow) | The Worker's JS bundle. `--keep-vars` means Terraform's plain_text bindings survive every deploy |
| `scripts/oauth-bootstrap.ts` (here, local-only) | Runs the YouTube OAuth flow via the hosted callback at `https://fluxtube.forklabs.cc/oauth/callback`; the operator pastes the code back from that page. Prints the refresh token (or JSON-encodes it via `--json` for an auto-refresh script in the deploy companion to capture). |

Nothing sensitive is ever committed to this repository or persisted on disk after a script run completes.

## How the public + private split works

The deploy companion runs a workflow that listens for `repository_dispatch` events from this repo's `notify-deploy.yml`. On receipt, it:

1. Checks out **itself** for `backend.hcl`, `terraform.tfvars`, ops scripts.
2. Checks out **this repo at the released tag** for Terraform code, Worker source, and `docs/grafana/`.
3. Runs `terraform init -backend-config=$private/backend.hcl` against this repo's HCL.
4. Runs `terraform apply` with `TF_VAR_*` env vars sourced from its own GitHub Secrets.
5. Runs `wrangler deploy --keep-vars --define VERSION:'"X.Y.Z"'` against the checked-out Worker source.
6. Runs `pnpm sync-grafana` against the checked-out dashboards + alerts.
7. Pushes an OTLP `fluxtube.deploys` metric attributing the deploy.

The compromise model: this repo holds **one secret**, `DEPLOY_DISPATCH_TOKEN`, scoped to fire dispatches on the deploy companion only. Leaking it lets an attacker re-deploy already-released code; it does not grant the ability to deploy arbitrary code.
