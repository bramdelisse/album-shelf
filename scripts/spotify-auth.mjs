// Authorization Code flow with PKCE, run locally, once.
//
// PKCE means no client secret exists anywhere — which matters, because this
// repo is public. The refresh token is cached in .spotify-token.json
// (gitignored) so the browser step happens on the first run only.

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { openBrowser } from './open-browser.mjs';

const PORT = 8888;
// Spotify stopped accepting "localhost". The literal loopback IP only, and the
// string here must match the dashboard character for character.
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPE = 'user-library-read';
const TOKEN_FILE = new URL('../.spotify-token.json', import.meta.url);

const base64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function postToken(body) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Spotify rejected the token request (${res.status}).\n` +
        `${json.error ?? ''} ${json.error_description ?? ''}`.trim(),
    );
  }
  return json;
}

/** Run the browser login once and return the token response. */
async function login(clientId) {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(12));

  const authUrl =
    'https://accounts.spotify.com/authorize?' +
    new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      state,
    });

  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const done = (status, message) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><meta charset="utf-8">` +
            `<body style="font:16px/1.5 system-ui;background:#FCFCFA;color:#16181C;padding:3rem">` +
            `<p>${message}</p></body>`,
        );
        server.close();
      };
      if (url.searchParams.get('error')) {
        done(400, 'Login cancelled. You can close this tab.');
        reject(new Error(`Spotify returned: ${url.searchParams.get('error')}`));
      } else if (url.searchParams.get('state') !== state) {
        done(400, 'State mismatch. You can close this tab.');
        reject(new Error('State mismatch — the login response did not match the request.'));
      } else {
        done(200, 'Signed in. You can close this tab and go back to the terminal.');
        resolve(url.searchParams.get('code'));
      }
    });
    server.on('error', (err) =>
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`Port ${PORT} is already in use. Close whatever is on it and run again.`)
          : err,
      ),
    );
    server.listen(PORT, '127.0.0.1', () => {
      console.log('\nOpening Spotify in your browser to sign in.');
      console.log(`If nothing opens, paste this into a browser yourself:\n\n${authUrl}\n`);
      openBrowser(authUrl);
    });
  });

  return postToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });
}

/** Return a usable access token, logging in through the browser only if needed. */
export async function getAccessToken(clientId) {
  if (!clientId) {
    throw new Error(
      'SPOTIFY_CLIENT_ID is not set.\n' +
        'Copy .env.example to .env and put your app\'s client ID in it.',
    );
  }

  if (existsSync(TOKEN_FILE)) {
    const cached = JSON.parse(await readFile(TOKEN_FILE, 'utf8'));
    try {
      const refreshed = await postToken({
        grant_type: 'refresh_token',
        refresh_token: cached.refresh_token,
        client_id: clientId,
      });
      // Spotify does not always return a new refresh token; keep the old one if not.
      await writeFile(
        TOKEN_FILE,
        JSON.stringify({ refresh_token: refreshed.refresh_token ?? cached.refresh_token }, null, 2),
      );
      return refreshed.access_token;
    } catch {
      console.log('Stored login has expired. Signing in again.');
    }
  }

  const tokens = await login(clientId);
  await writeFile(TOKEN_FILE, JSON.stringify({ refresh_token: tokens.refresh_token }, null, 2));
  return tokens.access_token;
}
