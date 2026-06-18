# FluxTube — Observability

Four surfaces, in order of how much fidelity they give you:

1. **Healthchecks.io** — primary dead-man's switch + typed per-reason failure alerts.
2. **Grafana Cloud Loki** — every log line, queryable for ~14 days.
3. **Grafana Cloud Mimir (via OTLP/HTTP)** — 11 gauge metrics per run, queryable with PromQL; dashboards live here.
4. **`wrangler tail fluxtube-sync`** — live stdout for the current invocation.

Plus the `GET /audit` endpoint, which is a snapshot of state rather than a stream of events.

---

## Healthchecks.io

Three checks, all optional but recommended:

| Check | URL var | Fires on |
|---|---|---|
| `FluxTube` (main) | `HEARTBEAT_URL` | Each successful run (`/success`) + every fatal error (`/fail`). Configure with a period of 30 minutes and a 5-minute grace. If 35 minutes pass with no ping → dead-man alert. |
| `FluxTube — YouTube Auth` | `HEARTBEAT_URL_AUTH` | `invalid_grant` `FatalError` only. The 7-day OAuth refresh expiry. Configure as "Simple" with no expected period (manual pings only). |
| `FluxTube — YouTube Quota` | `HEARTBEAT_URL_QUOTA` | `quota_exhausted` `FatalError` only. Same configuration as the Auth check. |

All three URLs are Worker plain_text bindings (set via `TF_VAR_heartbeat_url*`). Per-reason checks are no-ops when the var is empty.

### Why three checks instead of one?

The main check is a 35-minute-delayed signal, which is fine for "the cron stopped firing" but slow for "OAuth expired." Splitting the auth and quota cases lets you route them through faster channels (mobile push, on-call rotation) while keeping the main check on email.

The main `HEARTBEAT_URL/fail` ping fires alongside the typed one, so dashboards that watch the primary check stay correlated.

---

## Grafana Cloud Loki

Optional. Enable by setting all three of:

| Var | Routing | Description |
|---|---|---|
| `GRAFANA_LOKI_URL` | Worker plain_text binding | E.g. `https://logs-prod-006.grafana.net` |
| `GRAFANA_LOKI_USER` | Worker plain_text binding | The 6-digit user ID from My Account → Loki |
| `GRAFANA_LOKI_TOKEN` | Worker secret | API key with `logs:write` scope |

Missing any of the three → the sink is not constructed and the Worker stays on stdout-only logging.

### Setup

1. Grafana Cloud → My Account → Loki → copy the URL and User ID.
2. Generate an API token: Account → Access Policies → Add token. Scope: `logs:write`. Save the value.
3. Push the URL + USER as plain_text bindings via Terraform (`TF_VAR_grafana_loki_url`, `TF_VAR_grafana_loki_user`), and the TOKEN as a Worker secret via `wrangler secret put GRAFANA_LOKI_TOKEN`. The exact flow depends on your operator setup — see your deploy companion's runbook.
4. Wait for the next cron tick. Open Grafana → Explore → datasource = your Loki → run `{app="fluxtube"}`.

### Labels

Each run produces a single Loki stream with three labels:

| Label | Value | Used for |
|---|---|---|
| `app` | `fluxtube` | Filtering across all FluxTube logs |
| `env` | `production` | Future-proofing for a dev environment |
| `run_id` | a per-invocation UUID | Grouping all log lines from one run |

Stream values are sorted by ns-precision timestamp (Loki requires non-decreasing).

### LogQL recipes

```logql
# All logs from FluxTube, last hour
{app="fluxtube"}

# Only the structured `event` field — extract from the JSON line
{app="fluxtube"} | json | event != ""

# Errors only
{app="fluxtube"} |= "\"level\":\"error\""

# Pinpoint a single run
{app="fluxtube", run_id="<uuid-from-an-earlier-line>"}

# Count of "added" events per hour over the last 24h (derived metric)
sum(count_over_time({app="fluxtube"} |= "\"event\":\"added\"" [1h]))

# Quota burn last 24h — sync_complete carries the run's quota_used
{app="fluxtube"} |= "\"event\":\"sync_complete\"" | json
  | unwrap quota_used [24h]

# Marked-read events per day — useful sanity check that Pass 2 is draining
sum(count_over_time({app="fluxtube"} |= "\"event\":\"marked_read\"" [1d]))
```

### Cost

Free tier: 50 GB ingest per month, 14-day retention. FluxTube produces well under 1 MB / day at info level. Set `SYNC_LOG_LEVEL=debug` to see the `skipped_tracked` lines too — still negligible.

### Failure mode

A Loki outage logs `loki_push_failed` at warn level (one line, written via `console.warn` directly to avoid recursion) and is otherwise invisible. The sync run is never affected.

---

## `wrangler tail`

```bash
wrangler tail fluxtube-sync
```

Live stdout for whatever invocation is running. Useful for one-off debugging when you don't want to round-trip through Grafana. Each line is the same JSON the Loki sink ships.

---

## `GET /audit` — state snapshot

Not a log stream — a *current-state* dump. Use it when reconciling drift between Miniflux unread counts and YouTube playlist sizes. Reported per `(category, playlist)` pair plus a top-level orphan list:

| Field | Meaning |
|---|---|
| `miniflux_unread_count` | Total unread in this category |
| `youtube_playlist_size` | Total videos in this playlist |
| `d1_tracked_count` | Total D1 rows for this playlist |
| `not_a_youtube_url` | Unread entries whose URL fails parsing — leak candidates |
| `untracked_unread_in_playlist` | Already in playlist but no D1 row — backfill candidate (Pass 1 handles this) |
| `untracked_unread_not_in_playlist` | Pass 1 hasn't added yet (or has been failing) |
| `tracked_but_missing_from_playlist` | Pass 2 hasn't marked read yet (the user watched + removed) |

Top-level `d1_orphan_playlist_ids` is the list of playlist IDs in D1 that aren't in the current mapping — leftover state from config rotation.

```bash
./scripts/trigger-sync.sh audit | jq
./scripts/trigger-sync.sh audit | jq '.pairs[].tracked_but_missing_from_playlist | length'
```

---

## Metrics — Grafana Cloud OTLP

Workers can't easily produce Prometheus `remote_write` (snappy compression isn't available in the V8 isolate runtime), so FluxTube ships metrics via **OTLP/HTTP JSON** instead. Grafana Cloud's Mimir backend accepts OTLP at the OpenTelemetry gateway and stores the result queryable as native PromQL.

Enable by setting all three of:

| Var | Type | Where |
|---|---|---|
| `GRAFANA_OTLP_URL` | Worker plain_text binding | Base URL from My Account → OpenTelemetry tile, e.g. `https://otlp-gateway-prod-us-east-0.grafana.net/otlp`. The sink appends `/v1/metrics` if you don't. |
| `GRAFANA_OTLP_USER` | Worker plain_text binding | Numeric user ID (often different from the Loki user — Grafana Cloud issues a per-service ID). |
| `GRAFANA_OTLP_TOKEN` | Worker secret | API token with `metrics:write` scope only. |

Missing any of the three → the `OtlpMetricsSink` is not constructed and behavior is unchanged (no metrics shipped).

### Setup

1. **Capture endpoint details.** Grafana Cloud → My Account → OpenTelemetry tile. Note the **OpenTelemetry Endpoint URL** and the **Instance ID** (numeric).
2. **Create the access policy + token.** Security → Access Policies → Add policy `fluxtube-metrics-write`, scope `metrics:write` only. Add a token under it. Save the token.
3. Push the URL + USER as plain_text bindings via Terraform and the TOKEN as a Worker secret via `wrangler secret put GRAFANA_OTLP_TOKEN`. The exact flow depends on your operator setup.
4. Trigger a sync (via `POST /sync` with your `MANUAL_TRIGGER_TOKEN`). Within ~30 seconds, Grafana → Explore → Prometheus datasource → query `fluxtube_items_added` should return a point.

### Metrics reference

All gauges — Workers are stateless, so cumulative counters would need D1 round-trips. Aggregate per-run gauges via `sum_over_time(metric[range])` in PromQL.

| PromQL name | Source field | Notes |
|---|---|---|
| `fluxtube_items_added` | `summary.added` | New videos pushed into playlists this run |
| `fluxtube_items_marked_read` | `summary.marked_read` | Miniflux entries marked read this run |
| `fluxtube_items_skipped_tracked` | `summary.skipped_tracked` | Entries already in D1 |
| `fluxtube_items_skipped_existing_in_playlist` | `summary.skipped_existing_in_playlist` | Backfilled D1 rows for videos that were already in the playlist |
| `fluxtube_items_skipped_unavailable` | `summary.skipped_unavailable` | Private / deleted / region-blocked videos; marked read |
| `fluxtube_items_skipped_shorts` | `summary.skipped_shorts` | `/shorts/` URLs on mappings with `skip_shorts: true` |
| `fluxtube_errors_entry` | `summary.entry_errors` | Per-entry failures in Pass 1 |
| `fluxtube_errors_removal` | `summary.removal_errors` | Per-row failures in Pass 2 |
| `fluxtube_quota_used` | `summary.quota_used` | YouTube quota units spent this run |
| `fluxtube_run_duration_seconds` | `summary.duration_ms / 1000` | Wall time |
| `fluxtube_runs` | `1` per run | Carries `outcome ∈ {success, fatal_invalid_grant, fatal_quota_exhausted, fatal_other}` |

All metrics ship with resource attributes `service.name=fluxtube`, `service.namespace=production`, `service.instance.id=<run_id>` — the same UUID labels the Loki stream, so an operator can pivot from log lines to the run's metric data points.

### PromQL recipes

```promql
# Success rate over the last 24h
sum(sum_over_time(fluxtube_runs{outcome="success"}[24h]))
/ sum(sum_over_time(fluxtube_runs[24h]))

# Items added per hour, last 7d
sum_over_time(fluxtube_items_added[1h])

# Daily quota burn (units, projected over 24h)
sum_over_time(fluxtube_quota_used[24h])

# p99 run duration over the last 6h
quantile_over_time(0.99, fluxtube_run_duration_seconds[6h])

# Pass 2 not draining: D1 rows missing from playlist, with no mark-reads in the same window
# (combine with a Loki query — Grafana can render side-by-side)
sum_over_time(fluxtube_items_marked_read[2h]) == 0
```

### Dashboard

A starter dashboard ships in this repo: `docs/grafana/dashboards/fluxtube-overview.json`. Four panels:

| Panel | Query |
|---|---|
| Run outcomes (stacked) | `sum by (outcome) (sum_over_time(fluxtube_runs[$__interval]))` |
| Run duration (p95) | `quantile_over_time(0.95, fluxtube_run_duration_seconds[$__range])` |
| Items added | `sum_over_time(fluxtube_items_added[$__interval])` |
| Items marked read | `sum_over_time(fluxtube_items_marked_read[$__interval])` |

Installation is automatic via the `sync-grafana.yml` workflow — see the **Grafana sync workflow** section below. You don't import dashboards via the UI; you edit JSON in the repo and merge.

### Failure mode

A failed OTLP push logs `otlp_push_failed` at warn level (via `console.warn` directly, same recursion guard as the Loki sink). The sync run is never affected.

### Cost

Free tier: 10k active metrics / month, 14-day retention. FluxTube emits 11 metrics with a tiny label cardinality (`outcome` × 4 values + per-`run_id` resource attributes). Well within budget.

### Deployment correlation

Every `deploy-sync.yml` run pushes one OTLP signal to Grafana Cloud so you can ask "did that error spike start after the last deploy?" without leaving the dashboard:

**OTLP metric** — `fluxtube.deploys` (gauge value 1, labeled `outcome ∈ {success, failure}`, `sha`, `actor`) and `fluxtube.deploy.duration_seconds`. Same OTLP endpoint as the Worker run metrics; queryable in PromQL as `fluxtube_deploys` / `fluxtube_deploy_duration_seconds`. Resource attribute `service.instance.id=gh-run-<id>` is distinct from the Worker's `service.instance.id=<run-uuid>`, so queries can scope to either.

The step is `if: always()` so failed deploys also register, and it's fire-and-forget — a Grafana outage logs `::warning::` and the deploy job keeps going. Reuses the existing `GRAFANA_OTLP_URL/USER/TOKEN`; no extra credentials, no service accounts.

#### Vertical line markers on the dashboard

`docs/grafana/fluxtube-overview.json` ships with an `annotations.list[]` entry that points at the `fluxtube_deploys` metric directly. Grafana renders each non-zero point as a vertical line on every time-series panel — same visual effect the Grafana annotations API would give, but driven by the metric the workflow is already shipping. Annotation labels carry `outcome`, `sha`, and `actor` from the metric's attributes.

When you re-import the dashboard JSON (or import for the first time), the "Deploys" annotation source appears under the dashboard's gear icon → Annotations; you can toggle visibility per session.

Trade-off vs API-stored annotations: this approach is dashboard-scoped — the Deploys overlay only appears on dashboards that carry the `annotations.list[]` config. For our single-dashboard project that's a non-issue, and it avoids the Grafana Editor-role service account otherwise required.

#### Useful PromQL queries

```promql
# Number of deploys per day
sum_over_time(fluxtube_deploys[1d])

# Deploy success rate
sum(fluxtube_deploys{outcome="success"}) / sum(fluxtube_deploys)

# Deploy duration trend
fluxtube_deploy_duration_seconds
```

---

## Alerting

Two systems own different parts of the alert surface. Keep both — each is good at what the other is bad at.

| Alert source | Owns | Why |
|---|---|---|
| **Healthchecks.io** (third-party, independent of Grafana / Cloudflare) | Cron silence (35-min dead-man), typed `FatalError` per-reason fast alerts (`invalid_grant`, `quota_exhausted`) | Purpose-built for cron jobs; works even if Grafana Cloud is down; mobile push routes via Pushover/Slack are one click; free tier covers 20 checks indefinitely |
| **Grafana Cloud** (queries shipped metrics) | Trend, threshold, correlation alerts that Healthchecks can't express | Has metric history; can do `quantile_over_time`, `sum_over_time`, derived alerts; lives in the same UI as the dashboards |

When in doubt: "go/no-go right now" → Healthchecks. "Has X been weird over time?" → Grafana.

### Grafana rules — five starter alerts

One file per rule under `docs/grafana/alerts/`. Each rule has `for: 15m` debounce and tags `app=fluxtube, severity=warning`. Notification policy → your default email/integration.

| Alert | PromQL | When it triggers |
|---|---|---|
| **Pass 2 not draining** | `sum_over_time(fluxtube_items_marked_read[3h]) == 0 AND sum_over_time(fluxtube_runs{outcome="success"}[3h]) > 3` | 3+ successful runs in 3h but zero mark-reads — backlog clearing has stopped. Audit endpoint is the next debugging step. |
| **Sustained Pass 1 errors** | `sum_over_time(fluxtube_errors_entry[1h]) > 3` | More than 3 per-entry failures in 1h. Usually transient (YouTube rate limiting, weird entry shapes) — sustained means investigate. |
| **Sustained Pass 2 errors** | `sum_over_time(fluxtube_errors_removal[1h]) > 2` | More than 2 per-row removal failures in 1h. The mark-read-then-delete order means retries should self-heal; sustained means they aren't. |
| **Quota burn rate too high** | `sum_over_time(fluxtube_quota_used[24h]) > 8000` | Cumulative daily quota approaching the 10k cap. Softer trend warning to the per-run `quota_exhausted` Healthchecks alert. |
| **Run duration regression** | `quantile_over_time(0.95, fluxtube_run_duration_seconds[6h]) > 25` | p95 wall time within 5s of the 30s Worker cap. Upstream slowness or backlog explosion. |

### Importing the rules

You don't. The `sync-grafana.yml` workflow handles it — every PR touching `docs/grafana/**` dry-runs, every merge to main pushes. See the **Grafana sync workflow** section below for setup.

`${DS_PROMETHEUS}` placeholders in the JSON are substituted at push time with the auto-discovered Prometheus datasource UID from your Grafana instance. The `folderUID` is auto-resolved from a folder named `fluxtube` that you create once.

### Adding a new alert

1. Decide whether Healthchecks owns it (binary "did this thing fail right now?") or Grafana (trend / correlation / history).
2. For Grafana: write the PromQL in **Explore** first, iterate until it's a single boolean expression that returns 1 when alarming. Wrap with `$A > N` math expression in the rule definition.
3. Add `for: 15m` to avoid flapping on transient spikes.
4. Add a new file `docs/grafana/alerts/<slug>.json` matching the shape of the existing rules. The `uid` field is what makes the push idempotent — pick `fluxtube-<slug>`.
5. Open a PR. The `sync-grafana` workflow dry-runs against your real Grafana on the PR; merging applies it.
6. Update the table above and the rule's `summary` / `description` annotations.

## Grafana sync workflow

`.github/workflows/sync-grafana.yml` pushes everything under `docs/grafana/` to Grafana Cloud. The repo is the source of truth; UI edits are blocked by Grafana (no `X-Disable-Provenance` header is sent), so the dashboard pencil-with-slash icon means "edit the repo, not me."

### What it manages

| Source file | API endpoint | Idempotency |
|---|---|---|
| `docs/grafana/dashboards/*.json` | `POST /api/dashboards/db` with `overwrite: true` | Dashboard `uid` field — same UID always overwrites |
| `docs/grafana/alerts/*.json` | `POST` (create) or `PUT` (update) `/api/v1/provisioning/alert-rules` | Rule `uid` field — script GETs first, then chooses verb |

### What it does NOT manage

- Contact points (Email, Slack, Pushover destinations) — these are org-wide, shared with every other Grafana-using project; manual in the UI.
- Notification policies (the routing tree that maps labels → contact points) — also org-wide.
- Folders — operator creates the `fluxtube` folder once (see **Setup**); script doesn't touch folder lifecycle.
- Datasources — already configured in Grafana Cloud; the script reads their UIDs but doesn't write them.

### Setup (one-time)

The `sync-grafana.ts` script in this repo takes care of pushing every JSON file under `docs/grafana/` to your Grafana instance. The **workflow that runs it** lives in the deploy companion (since the Grafana API token lives there). What you need to do once:

1. **Service account** in Grafana → Administration → Users and access → Service accounts → Add. Name: `fluxtube-sync`. Assign the **Editor** role on the org (or the fine-grained scopes: `dashboards:write`, `alert.rules:read`, `alert.rules:write`, `datasources:read`, `folders:read`).
2. **Generate a token** under that service account. Save it.
3. **Create the `fluxtube` folder** in Grafana → Dashboards → New → New folder → "fluxtube". The script looks up its UID by name; case-insensitive match with a diagnostic dump on failure.
4. Hand `GRAFANA_API_URL` (e.g. `https://<stack>.grafana.net`) and `GRAFANA_API_TOKEN` to your deploy companion's secret-management flow. The companion's `deploy-on-release.yml` reads them.

### Trying it locally

```sh
export GRAFANA_API_URL=https://<stack>.grafana.net
export GRAFANA_API_TOKEN=<from step 2>

# Dry-run — prints what would be pushed without writing:
pnpm --filter @fluxtube/scripts sync-grafana -- --dry-run

# Real apply (idempotent — safe to re-run):
pnpm --filter @fluxtube/scripts sync-grafana
```

### Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| "No Prometheus datasource found" | Grafana stack doesn't have a Prometheus datasource configured | Connections → Add new → Prometheus → point at the same Mimir endpoint you query interactively |
| "Multiple Prometheus datasources found and none/multiple marked default" | Stack has >1 Prometheus DS and the `isDefault` heuristic can't disambiguate. Grafana Cloud's default setup (one metrics DS + `grafanacloud-usage`) is handled automatically because only the metrics DS is `isDefault`. | Set `GRAFANA_PROMETHEUS_DATASOURCE_UID` to the metrics DS's UID via your secret-management flow |
| `Folder "fluxtube" not found` | The one-time folder wasn't created (or was renamed) | Recreate it; names are matched case-insensitively |
| `401 Unauthorized` | Token invalid or expired | Regenerate in Grafana, push the new token through your secret-management flow |
| `403 Forbidden` on a specific endpoint | Token scopes incomplete | Re-check the scope list in step 1 |

### Alerting failure mode

A Grafana outage means rules don't fire; **but** the Loki-shipping failure that would normally accompany such an outage logs `loki_push_failed` to stdout (where `wrangler tail` shows it), and the Healthchecks dead-man's switch continues independently. Cross-check both surfaces when something looks off.
