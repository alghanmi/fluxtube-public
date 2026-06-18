// Build-time string literal injected by wrangler. Three injection sites:
//   - Production deploys: `wrangler --define VERSION:'"<version>"'` in
//     .github/workflows/deploy-sync.yml, sourced from `workers/sync/package.json`.
//   - Local `wrangler dev`: wrangler.toml `[define] VERSION = '"0.0.0-dev"'`.
//   - Tests: same wrangler.toml [define] flows through @cloudflare/vitest-pool-workers,
//     so test assertions see `"0.0.0-dev"`.
// The identifier is a *bare* global, not a property on `env`, because Terraform owns
// the runtime `env.*` bindings and `wrangler deploy --keep-vars` would refuse to
// touch them. Build-time define sidesteps that ownership entirely.
declare const VERSION: string;
