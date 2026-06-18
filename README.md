# FluxTube

A Cloudflare Worker that syncs unread YouTube entries from [Miniflux](https://miniflux.app) into YouTube playlists, then marks Miniflux entries as read once you've watched and removed them from the playlist.

The goal: keep YouTube as the native viewing surface (offline downloads, cross-device progress sync) while eliminating the manual step of copying RSS-discovered links into a playlist.

## How it works

On a cron tick (every 30 minutes by default):

1. For each configured `(category, playlist)` pair, fetch unread Miniflux entries; for each one whose URL is a YouTube video that isn't already in the playlist, call `playlistItems.insert` and record a row in D1.
2. For each tracked row, check whether the video is still in its playlist; if you've removed it, mark the Miniflux entry read and delete the D1 row.

Pass 1 only adds, Pass 2 only removes. See [`docs/architecture.md`](./docs/architecture.md) for the algorithm in detail.

## Quick start (local development)

```sh
git clone https://github.com/alghanmi/fluxtube.git
cd fluxtube
pnpm install
pnpm --filter @fluxtube/sync test
```

For running the Worker against your own Cloudflare account, you'll need:
- A Cloudflare account with Workers + D1
- A Miniflux instance (self-hosted or [reader.miniflux.app](https://reader.miniflux.app))
- YouTube playlists (PL... — Watch Later is API-disabled)
- A Google Cloud project with YouTube Data API v3 enabled, OAuth 2.0 Desktop client
- Optional: [Healthchecks.io](https://healthchecks.io/), [Grafana Cloud](https://grafana.com/products/cloud/) for observability

Deployment is automated via a companion deploy repo — see [Deploying your own instance](#deploying-your-own-instance) below.

## Repo layout

```
.
├── workers/sync/                # The Worker — TypeScript, vitest, wrangler
├── infrastructure/terraform/    # IaC: Worker + D1 + cron trigger + bindings
├── docs/grafana/                # Dashboards + alert rules as code
│   ├── dashboards/
│   └── alerts/
├── scripts/
│   ├── oauth-bootstrap.ts       # One-time YouTube OAuth flow (local-only)
│   └── sync-grafana.ts          # Push dashboards + alerts to Grafana Cloud
└── .github/workflows/
    ├── pr-checks.yml            # typecheck + lint + test + audit
    ├── terraform-check.yml      # fmt + validate on PR
    ├── release-please.yml       # version + CHANGELOG management
    └── notify-deploy.yml        # fires on release → dispatches to deploy repo
```

## Deploying your own instance

Production deploys live in a **private companion repo** that holds your account-specific values (D1 UUID, R2 bucket, API tokens, dashboard credentials). When you publish a release on this repo, that deploy repo's workflow listens for a `repository_dispatch` event and runs the full pipeline: `terraform apply` → `wrangler deploy --define VERSION:'"X.Y.Z"'` → push Grafana dashboards + alerts → emit deploy metric.

The deploy companion is one of:
- Yours: fork or create a `*-deploy` repo, mirror the shape from your favourite operator runbook (Bitwarden, 1Password, `pass`, or any vault).
- Mine: see [`alghanmi/fluxtube-deploy`](https://github.com/alghanmi/fluxtube-deploy) (private; you can't browse it but its `TODO.md` is the operator checklist).

The split-repo pattern is described in [`docs/architecture.md` → "How the public + private split works"](./docs/architecture.md#how-the-public--private-split-works).

## Observability

All four surfaces are optional; enable any subset.

| Surface | What | Configure via |
|---|---|---|
| **stdout JSON logs** | Always on, viewable via `wrangler tail` | — |
| **Healthchecks.io** | Cron dead-man's switch + per-reason failure alerts | `HEARTBEAT_URL`, `HEARTBEAT_URL_AUTH`, `HEARTBEAT_URL_QUOTA` |
| **Grafana Cloud Loki** | Structured log shipping | `GRAFANA_LOKI_URL` + `_USER` + `_TOKEN` |
| **Grafana Cloud OTLP** | 11 gauge metrics per run via OTLP/HTTP JSON | `GRAFANA_OTLP_URL` + `_USER` + `_TOKEN` |

See [`docs/observability.md`](./docs/observability.md) for LogQL + PromQL recipes and the metric reference.

## Contributing

PRs welcome. Conventional Commits (`feat:` / `fix:` / `chore:`). release-please opens a release PR after each commit on `main` — merging it cuts a tag + GH release + CHANGELOG entry, which fires the deploy if you have a companion repo wired up.

## License

MIT. See [`LICENSE`](./LICENSE).

## Security

See [`SECURITY.md`](./SECURITY.md) for the vulnerability disclosure policy.
