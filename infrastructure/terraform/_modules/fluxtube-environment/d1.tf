resource "cloudflare_d1_database" "fluxtube" {
  account_id = var.cloudflare_account_id
  name       = local.d1_name

  # Read replication is a v5 attribute the live database already carries
  # (set to the API default at create time). Declaring it explicitly keeps
  # Terraform from planning a null-out on every apply. We're single-tenant
  # single-region — no read replicas needed; flip to "enabled" if that ever
  # changes.
  read_replication = {
    mode = "disabled"
  }
}
