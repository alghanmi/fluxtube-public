terraform {
  required_version = ">= 1.9"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.21"
    }
  }
}

# ── Bindings: collapsed into a single typed list ────────────────────────────
#
# v4 used per-binding-type HCL blocks (`plain_text_binding {}`,
# `d1_database_binding {}`). v5 collapses them into a single `bindings`
# attribute — a list of objects discriminated by a `type` field. The two
# locals below split the plain_text bindings into "required" (always
# present) and "optional" (only emitted when non-empty) so the conditional
# logic from the old `dynamic` blocks survives without re-introducing
# block syntax.
locals {
  required_plain_text_bindings = {
    MINIFLUX_URL              = local.worker_vars.MINIFLUX_URL
    CATEGORY_PLAYLIST_MAPPING = local.worker_vars.CATEGORY_PLAYLIST_MAPPING
    SYNC_LOG_LEVEL            = local.worker_vars.SYNC_LOG_LEVEL
  }

  # Cloudflare's API rejects plain_text bindings whose text is empty, so we
  # filter empties out before reaching the resource. The Worker code already
  # treats missing env vars as "feature disabled" — no behavior change.
  optional_plain_text_bindings = {
    HEARTBEAT_URL       = local.worker_vars.HEARTBEAT_URL
    HEARTBEAT_URL_AUTH  = local.worker_vars.HEARTBEAT_URL_AUTH
    HEARTBEAT_URL_QUOTA = local.worker_vars.HEARTBEAT_URL_QUOTA
    GRAFANA_LOKI_URL    = local.worker_vars.GRAFANA_LOKI_URL
    GRAFANA_LOKI_USER   = local.worker_vars.GRAFANA_LOKI_USER
    GRAFANA_OTLP_URL    = local.worker_vars.GRAFANA_OTLP_URL
    GRAFANA_OTLP_USER   = local.worker_vars.GRAFANA_OTLP_USER
  }
}

# The Worker script.
#
# Ownership split:
#   - Terraform owns:  bindings (D1, plain_text vars), metadata
#                      (compatibility_date, compatibility_flags),
#                      observability config.
#   - wrangler owns:   the JS bundle (`content`) and entry-module name
#                      (`main_module`) — see lifecycle.ignore_changes below.
#
# A placeholder script is written on first apply so the resource exists;
# the `deploy-sync.yml` workflow then runs `wrangler deploy` to push the
# real code. The lifecycle block keeps Terraform from reverting the
# wrangler-uploaded bundle on subsequent applies.
resource "cloudflare_workers_script" "sync" {
  account_id          = var.cloudflare_account_id
  script_name         = local.worker_name
  content             = local.placeholder_script
  main_module         = "worker.js"
  compatibility_date  = "2025-05-01"
  compatibility_flags = ["nodejs_compat"]

  bindings = concat(
    [for k, v in local.required_plain_text_bindings : { name = k, type = "plain_text", text = v }],
    [
      for k, v in local.optional_plain_text_bindings : { name = k, type = "plain_text", text = v }
      if v != ""
    ],
    [
      {
        name = "DB"
        type = "d1"
        id   = cloudflare_d1_database.fluxtube.id
      }
    ],
  )

  # Observability. Workers Logs + Tail capture every invocation; sampling
  # stays at 1 (100%) since FluxTube's volume is tiny. Traces are off —
  # we ship structured logs to Loki instead, and OTLP metrics to Mimir,
  # so Workers-side traces don't add information. Persist on so the data
  # is queryable in the Cloudflare dashboard, not just streamed.
  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs = {
      enabled            = true
      head_sampling_rate = 1
      invocation_logs    = true
      persist            = true
    }
    traces = {
      enabled            = false
      head_sampling_rate = 1
      persist            = true
    }
  }

  # `content` and `main_module` are wrangler's domain — Terraform writes a
  # placeholder on create, then wrangler deploys (with --keep-vars) push the
  # real bundle on every push to main. `compatibility_date` and
  # `compatibility_flags` must match what wrangler.toml sets or Cloudflare
  # rejects metadata updates against the live bundle. Everything else
  # (bindings, observability) IS managed by Terraform — declared above
  # rather than ignored, so the source of truth is auditable in HCL.
  lifecycle {
    ignore_changes = [
      content,
      main_module,
    ]
  }
}

# Cron trigger.
#
# Renamed from v4's `cloudflare_worker_cron_trigger` (singular). The
# `schedules` attribute also changed shape: v4 wanted a list of strings,
# v5 wants a list of objects with a `cron` field.
#
# Kill switch: in v4, `count = 0` deleted the trigger via the CF API. In v5
# the provider explicitly cannot destroy this resource type ("This resource
# cannot be destroyed from Terraform. If you create this resource, it will
# be present in the API until manually deleted." — provider warning). So
# toggling `count` only removes terraform's view of it; the cron keeps
# firing on Cloudflare.
#
# v5-shaped kill switch: leave the resource declared, drive `schedules` from
# `var.cron_enabled`. An empty schedules list tells the API "no scheduled
# invocations" — same operational effect as the v4 destroy, but without
# fighting the provider's destroy ban.
resource "cloudflare_workers_cron_trigger" "sync" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.sync.script_name
  schedules   = var.cron_enabled ? [{ cron = var.cron_schedule }] : []
}

# Address rename: dropping the `count` shifts the state key from
# `…sync[0]` (count=1) to `…sync` (no index). The `moved` block tells
# terraform to migrate the existing state entry to the new address
# automatically — no `terraform state mv` operator step needed.
moved {
  from = cloudflare_workers_cron_trigger.sync[0]
  to   = cloudflare_workers_cron_trigger.sync
}
