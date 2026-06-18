# Security Policy

## Reporting a Vulnerability

Please do not open a public GitHub issue for security vulnerabilities.

To report a vulnerability, email **alghanmi@gmail.com** with:

- A description of the vulnerability
- Steps to reproduce
- Potential impact

You can expect a response within 72 hours. If the issue is confirmed, a fix will be prioritised and you will be credited in the release notes unless you prefer otherwise.

## Scope

This is a personal automation tool that runs in a single-user Cloudflare Worker. The main security surface areas are:

- **OAuth credentials** — YouTube refresh token, stored as a Cloudflare Worker secret
- **API tokens** — Miniflux and Cloudflare tokens, stored as Worker secrets or GitHub secrets
- **D1 state** — tracks Miniflux entry IDs and YouTube playlist item IDs (no PII)
- **Dependencies** — npm packages in `workers/sync/` and `scripts/`

## Out of Scope

- Issues requiring physical access to the developer's machine
- Issues in Cloudflare, GitHub, Google, or Miniflux infrastructure directly
- Social engineering
