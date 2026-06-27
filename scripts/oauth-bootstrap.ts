#!/usr/bin/env tsx
/**
 * One-time YouTube OAuth bootstrap. Local-only — never run in the Worker.
 *
 * Runs the OAuth 2.0 Authorization Code flow for a Desktop app, redirecting
 * through the FluxTube hosted callback at
 * https://fluxtube.forklabs.cc/oauth/callback. That page reads the `code` and
 * `state` from the URL and displays them with a Copy button. You paste the
 * code back into this terminal; this script exchanges it for a refresh token
 * and prints it.
 *
 * Why a hosted callback instead of an http://127.0.0.1 loopback redirect:
 *   Google's OAuth verification requires Production-state OAuth apps to use a
 *   redirect URI on a domain you control, not loopback. In return, refresh
 *   tokens stop expiring at 7 days (Testing-state policy). Hosting the
 *   callback page on fluxtube.forklabs.cc removes the loopback HTTP server
 *   from this script and is the prerequisite for Google verification.
 *
 * Usage:
 *   export YOUTUBE_CLIENT_ID="..."
 *   export YOUTUBE_CLIENT_SECRET="..."
 *   pnpm --filter @fluxtube/scripts oauth-bootstrap
 *
 * The refresh token printed to stdout is the value you set as the Worker's
 * `YOUTUBE_REFRESH_TOKEN` secret. Store it in your password manager; push it
 * to Cloudflare via your usual sync flow (e.g. `wrangler secret put`).
 */

import { randomBytes } from 'node:crypto';
import * as readline from 'node:readline/promises';
import { stdin as input, stderr as output } from 'node:process';

const SCOPE = 'https://www.googleapis.com/auth/youtube';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TEST_URL =
  'https://www.googleapis.com/youtube/v3/playlists?part=snippet&mine=true&maxResults=1';

// Hosted callback URL — must be registered as an Authorized redirect URI
// in Google Cloud Console (APIs & Services → Credentials → OAuth 2.0 Client
// IDs → Authorized redirect URIs). Overridable via env for local testing
// against a Pages preview URL.
const REDIRECT_URI =
  process.env['OAUTH_REDIRECT_URI'] ?? 'https://fluxtube.forklabs.cc/oauth/callback';

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: 'Bearer';
}

async function main(): Promise<void> {
  // `--json` switches stdout to a single JSON line ({"refresh_token":"..."})
  // so a wrapping script can capture it reliably. All progress/banner output
  // goes to stderr in that mode. Default behavior (no flag) is unchanged.
  const jsonMode = process.argv.includes('--json');
  const out = jsonMode ? console.error : console.log;

  const clientId = process.env['YOUTUBE_CLIENT_ID'];
  const clientSecret = process.env['YOUTUBE_CLIENT_SECRET'];

  if (!clientId || !clientSecret) {
    console.error(
      'Error: YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET must be exported in your shell.',
    );
    console.error('Get them from Google Cloud Console → APIs & Services → Credentials.');
    process.exit(1);
  }

  const expectedState = randomBytes(16).toString('hex');
  const code = await runHostedCallbackFlow({ clientId, expectedState, jsonMode });
  const tokens = await exchangeCodeForTokens({
    clientId,
    clientSecret,
    code,
    redirectUri: REDIRECT_URI,
  });

  if (!tokens.refresh_token) {
    console.error('');
    console.error('No refresh_token returned. Google only issues one per (client, account) pair.');
    console.error('Revoke prior consent at https://myaccount.google.com/permissions and re-run.');
    process.exit(1);
  }

  out('');
  out('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  out('SUCCESS — store this refresh_token as the Worker secret');
  out('  YOUTUBE_REFRESH_TOKEN');
  out('(via your password manager, or directly with `wrangler secret put`)');
  out('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  out('');
  if (!jsonMode) console.log(tokens.refresh_token);
  out('');
  out('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  out('');

  out('Testing the access token with playlists.list…');
  const testRes = await fetch(TEST_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const testBody = await testRes.text();
  if (!testRes.ok) {
    console.error(`  ✗ test call failed: ${testRes.status}`);
    console.error(testBody);
    process.exit(1);
  }
  out('  ✓ test call succeeded — token has the required scope.');
  out('');
  out('Next step: push this refresh_token to the Worker as YOUTUBE_REFRESH_TOKEN.');
  out('  Manual:    pnpm wrangler secret put YOUTUBE_REFRESH_TOKEN');
  out('  Automated: store in your password manager, then run your sync script.');

  if (jsonMode) {
    // Single JSON line on stdout for the wrapping script to capture.
    process.stdout.write(JSON.stringify({ refresh_token: tokens.refresh_token }) + '\n');
  }
}

interface HostedFlowArgs {
  clientId: string;
  expectedState: string;
  jsonMode: boolean;
}

async function runHostedCallbackFlow(args: HostedFlowArgs): Promise<string> {
  const params = new URLSearchParams({
    client_id: args.clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state: args.expectedState,
  });
  const authUrl = `${AUTH_URL}?${params.toString()}`;

  // In --json mode, send progress to stderr so stdout stays parseable.
  const log = args.jsonMode ? console.error : console.log;

  log('');
  log('Open this URL in a browser, sign in with the Google account that owns');
  log('your YouTube playlists, and approve the YouTube write scope:');
  log('');
  log(`  ${authUrl}`);
  log('');
  log('After consent, Google will redirect you to');
  log(`  ${REDIRECT_URI}`);
  log('which displays the code with a Copy button.');
  log('');
  log(`Verify the page shows this state value (CSRF check): ${args.expectedState}`);
  log('');

  // Readline writes its prompt to `output`. We pin that to stderr (not
  // stdout) so wrapper scripts using `$(... oauth-bootstrap -- --json)`
  // get a clean stdout containing only the final JSON line — otherwise
  // the prompt string ("Paste the code from the callback page: ") leaks
  // into the captured value and trips the wrapper's `jq` parse.
  // Interactive users see no difference: stderr and stdout both render
  // on the TTY.
  const rl = readline.createInterface({ input, output });
  try {
    const pastedCode = (await rl.question('Paste the code from the callback page: ')).trim();
    if (!pastedCode) {
      throw new Error('No code provided. Aborting.');
    }
    if (pastedCode.length < 20) {
      // Google's authorization codes are ~60-70 chars. Anything substantially
      // shorter is almost certainly a paste mishap (truncated, partial line).
      throw new Error(
        `Code looks too short (${pastedCode.length} chars). Re-run and paste the full code.`,
      );
    }
    return pastedCode;
  } finally {
    rl.close();
  }
}

interface ExchangeArgs {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}

async function exchangeCodeForTokens(args: ExchangeArgs): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: args.clientId,
    client_secret: args.clientSecret,
    code: args.code,
    grant_type: 'authorization_code',
    redirect_uri: args.redirectUri,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status} ${text}`);
  }
  return JSON.parse(text) as TokenResponse;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
