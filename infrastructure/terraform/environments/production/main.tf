terraform {
  required_version = ">= 1.9"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.21"
    }
  }

  # Partial backend: every identifying value (`bucket`, `key`, `endpoints`) is
  # supplied at `terraform init` time via -backend-config flags from CI. The
  # deploy workflow (in alghanmi/fluxtube-deploy) reads TF_STATE_BUCKET +
  # TF_STATE_KEY from variables and CF_ACCOUNT_ID from a secret, builds the
  # endpoints URL inline, and passes all three. Keeps real values out of this
  # repo entirely.
  backend "s3" {
    region                      = "auto"
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

module "fluxtube" {
  source = "../../_modules/fluxtube-environment"

  cloudflare_account_id     = var.cloudflare_account_id
  name_suffix               = ""
  miniflux_url              = var.miniflux_url
  category_playlist_mapping = var.category_playlist_mapping
  sync_log_level            = var.sync_log_level
  heartbeat_url             = var.heartbeat_url
  heartbeat_url_auth        = var.heartbeat_url_auth
  heartbeat_url_quota       = var.heartbeat_url_quota
  cron_schedule             = var.cron_schedule
  cron_enabled              = var.cron_enabled
  grafana_loki_url          = var.grafana_loki_url
  grafana_loki_user         = var.grafana_loki_user
  grafana_otlp_url          = var.grafana_otlp_url
  grafana_otlp_user         = var.grafana_otlp_user
}

output "worker_name" {
  value = module.fluxtube.worker_name
}

output "d1_database_id" {
  value = module.fluxtube.d1_database_id
}

output "d1_database_name" {
  value = module.fluxtube.d1_database_name
}

output "cron_schedule" {
  value = module.fluxtube.cron_schedule
}
