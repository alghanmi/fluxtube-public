#!/usr/bin/env tsx
/**
 * One-time YouTube OAuth bootstrap. Local-only — never run in the Worker.
 *
 * Runs the OAuth 2.0 Authorization Code flow for a Desktop app using a local
 * loopback redirect (RFC 8252). On success it prints the long-lived refresh
 * token and runs a smoke-test API call to confirm the token has the required
 * scope.
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

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';

const SCOPE = 'https://www.googleapis.com/auth/youtube';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TEST_URL =
  'https://www.googleapis.com/youtube/v3/playlists?part=snippet&mine=true&maxResults=1';

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
  const { code, redirectUri } = await runLoopbackFlow({ clientId, expectedState, jsonMode });
  const tokens = await exchangeCodeForTokens({ clientId, clientSecret, code, redirectUri });

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

interface LoopbackArgs {
  clientId: string;
  expectedState: string;
  jsonMode: boolean;
}

interface AuthCodeResult {
  code: string;
  redirectUri: string;
}

function runLoopbackFlow(args: LoopbackArgs): Promise<AuthCodeResult> {
  return new Promise((resolve, reject) => {
    let redirectUri = '';

    const server = createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400).end('missing url');
        return;
      }
      const reqUrl = new URL(req.url, 'http://localhost');
      if (reqUrl.pathname !== '/callback') {
        res.writeHead(404).end('not found');
        return;
      }
      const code = reqUrl.searchParams.get('code');
      const state = reqUrl.searchParams.get('state');
      const error = reqUrl.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end(`OAuth error: ${error}`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      if (!code || state !== args.expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Missing or mismatched code/state.');
        server.close();
        reject(new Error('Missing or mismatched code/state'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' }).end(
        '<!doctype html><html><body><h1>FluxTube OAuth complete</h1><p>You can close this tab and return to the terminal.</p></body></html>',
      );
      server.close();
      // server.close() only stops accepting new connections; the browser's
      // keep-alive socket keeps the event loop alive for ~120s and hangs the
      // process. closeAllConnections() drops it immediately so the script
      // exits naturally after main() returns. Critical when run under
      // `$(pnpm ... oauth-bootstrap -- --json)` — the wrapper waits forever
      // otherwise.
      server.closeAllConnections();
      resolve({ code, redirectUri });
    });

    server.on('error', reject);

    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo | null;
      if (address === null || typeof address === 'string') {
        reject(new Error('failed to bind local server'));
        return;
      }
      redirectUri = `http://127.0.0.1:${address.port}/callback`;

      const params = new URLSearchParams({
        client_id: args.clientId,
        redirect_uri: redirectUri,
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
      log(`Listening on ${redirectUri} for the redirect…`);
    });
  });
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
