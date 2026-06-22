terraform {
  required_version = ">= 1.9"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.21"
    }
  }
}

# NOTE: `cloudflare_worker_cron_trigger` (used below) is deprecated in favor of
# `cloudflare_workers_cron_trigger` (plural). The provider currently rejects a
# `moved` block between the two types ("Move Resource State Not Supported"),
# so the rename is deferred to a follow-up — likely once v5 ships with a
# proper migration path. Until then the deprecation warning is expected.

# The Worker script.
#
# Terraform owns: bindings (D1, plain_text vars) and metadata.
# wrangler owns: the JS bundle (`content`) and module mode.
#
# A placeholder script is written on first apply so the resource exists; the
# `deploy-sync.yml` workflow then runs `wrangler deploy` to push the real code.
# `lifecycle.ignore_changes` on `content` and `main_module` keeps Terraform from
# reverting the wrangler-uploaded bundle on subsequent applies.
resource "cloudflare_workers_script" "sync" {
  account_id          = var.cloudflare_account_id
  name                = local.worker_name
  content             = local.placeholder_script
  module              = true
  compatibility_date  = "2025-05-01"
  compatibility_flags = ["nodejs_compat"]

  plain_text_binding {
    name = "MINIFLUX_URL"
    text = local.worker_vars.MINIFLUX_URL
  }

  plain_text_binding {
    name = "CATEGORY_PLAYLIST_MAPPING"
    text = local.worker_vars.CATEGORY_PLAYLIST_MAPPING
  }

  plain_text_binding {
    name = "SYNC_LOG_LEVEL"
    text = local.worker_vars.SYNC_LOG_LEVEL
  }

  # Optional bindings. Cloudflare's API rejects plain_text bindings whose text
  # is empty, so we omit them entirely when unset. The Worker code already
  # treats missing env vars as "feature disabled" — no behavior change.
  dynamic "plain_text_binding" {
    for_each = local.worker_vars.HEARTBEAT_URL != "" ? [local.worker_vars.HEARTBEAT_URL] : []
    content {
      name = "HEARTBEAT_URL"
      text = plain_text_binding.value
    }
  }

  dynamic "plain_text_binding" {
    for_each = local.worker_vars.HEARTBEAT_URL_AUTH != "" ? [local.worker_vars.HEARTBEAT_URL_AUTH] : []
    content {
      name = "HEARTBEAT_URL_AUTH"
      text = plain_text_binding.value
    }
  }

  dynamic "plain_text_binding" {
    for_each = local.worker_vars.HEARTBEAT_URL_QUOTA != "" ? [local.worker_vars.HEARTBEAT_URL_QUOTA] : []
    content {
      name = "HEARTBEAT_URL_QUOTA"
      text = plain_text_binding.value
    }
  }

  dynamic "plain_text_binding" {
    for_each = local.worker_vars.GRAFANA_LOKI_URL != "" ? [local.worker_vars.GRAFANA_LOKI_URL] : []
    content {
      name = "GRAFANA_LOKI_URL"
      text = plain_text_binding.value
    }
  }

  dynamic "plain_text_binding" {
    for_each = local.worker_vars.GRAFANA_LOKI_USER != "" ? [local.worker_vars.GRAFANA_LOKI_USER] : []
    content {
      name = "GRAFANA_LOKI_USER"
      text = plain_text_binding.value
    }
  }

  dynamic "plain_text_binding" {
    for_each = local.worker_vars.GRAFANA_OTLP_URL != "" ? [local.worker_vars.GRAFANA_OTLP_URL] : []
    content {
      name = "GRAFANA_OTLP_URL"
      text = plain_text_binding.value
    }
  }

  dynamic "plain_text_binding" {
    for_each = local.worker_vars.GRAFANA_OTLP_USER != "" ? [local.worker_vars.GRAFANA_OTLP_USER] : []
    content {
      name = "GRAFANA_OTLP_USER"
      text = plain_text_binding.value
    }
  }

  d1_database_binding {
    name        = "DB"
    database_id = cloudflare_d1_database.fluxtube.id
  }

  # `content` and `module` are wrangler's domain — Terraform writes a placeholder
  # on create, then wrangler deploys (with --keep-vars) push the real bundle on
  # every push to main. `compatibility_date` and `compatibility_flags` must
  # match what wrangler.toml sets or Cloudflare rejects metadata updates
  # against the live bundle.
  lifecycle {
    ignore_changes = [
      content,
      module,
    ]
  }
}

resource "cloudflare_worker_cron_trigger" "sync" {
  # `count = 0` deletes the trigger entirely — used during repo cutovers to
  # stop the old Worker from firing before the new one takes over, or to
  # bring a Worker up with no cron during initial provisioning.
  count = var.cron_enabled ? 1 : 0

  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.sync.name
  schedules   = [var.cron_schedule]
}
