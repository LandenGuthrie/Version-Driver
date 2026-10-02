// Google sign-in for a desktop app: OAuth 2.0 authorization-code flow with PKCE and a
// loopback redirect. The system browser does the sign-in; when it finishes, a tiny local
// page tells the user to go back to the app, and the app brings itself to the front.
import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { shell, type BrowserWindow } from 'electron';
import { getSecret, setSecret, deleteSecret } from './keystore';
import type { Profile } from '../shared/api';

declare const __GOOGLE_CLIENT_ID__: string;
declare const __GOOGLE_CLIENT_SECRET__: string;

const CLIENT_ID = __GOOGLE_CLIENT_ID__;
// Google requires the secret for desktop clients too, but it isn't confidential for installed apps.
const CLIENT_SECRET = __GOOGLE_CLIENT_SECRET__;

export const SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive.file'];

export const googleConfigured = () => !!CLIENT_ID && !CLIENT_ID.startsWith('your-');

const b64url = (b: Buffer) => b.toString('base64url');

interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  id_token?: string;
}

let access: { token: string; expiresAt: number } | null = null;
let pending: { server: Server; reject: (e: Error) => void } | null = null;

const SUCCESS_PAGE = `<!doctype html><meta charset="utf-8"><title>Version Driver</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px system-ui,sans-serif;background:#0f0f10;color:#ececee}
  main{text-align:center;max-width:380px;padding:32px}
  .dot{width:44px;height:44px;border-radius:50%;background:#3fb950;margin:0 auto 20px;display:grid;place-items:center;color:#0f0f10;font-size:24px}
  h1{font-size:20px;margin:0 0 8px} p{color:#8b8b93;margin:0;line-height:1.5}
</style>
<main><div class="dot">✓</div><h1>You're signed in</h1>
<p>Version Driver is coming to the front. You can close this tab.</p></main>`;

const ERROR_PAGE = (msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>Version Driver</title><body style="font:16px system-ui;padding:40px;background:#0f0f10;color:#ececee"><h1>Sign-in failed</h1><p>${msg.replace(/[<>&]/g, '')}</p>`;

export async function signIn(getWindow: () => BrowserWindow | null): Promise<Profile> {
  if (!googleConfigured()) throw new Error('Google sign-in is not configured yet (missing GOOGLE_CLIENT_ID in app/.env.local).');
  cancelSignIn();

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get('error');
      const gotCode = url.searchParams.get('code');
      if (err || !gotCode || url.searchParams.get('state') !== state) {
        res.writeHead(400, { 'content-type': 'text/html' }).end(ERROR_PAGE(err ?? 'Invalid response'));
        reject(new Error(err ? `Google sign-in: ${err}` : 'Sign-in response did not match the request'));
      } else {
        res.writeHead(200, { 'content-type': 'text/html' }).end(SUCCESS_PAGE);
        const port = (server.address() as { port: number }).port;
        resolve({ code: gotCode, redirectUri: `http://127.0.0.1:${port}/callback` });
        const win = getWindow();
        if (win) {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        }
      }
      setTimeout(() => server.close(), 500);
    });
    pending = { server, reject };
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: `http://127.0.0.1:${port}/callback`,
        response_type: 'code',
        scope: SCOPES.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        access_type: 'offline',
        prompt: 'consent',
      });
      void shell.openExternal(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
    });
    setTimeout(() => {
      reject(new Error('Sign-in timed out. Please try again.'));
      server.close();
    }, 5 * 60_000);
  }).finally(() => {
    pending = null;
  });

  const tokens = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });
  if (!tokens.refresh_token) throw new Error('Google did not return a refresh token. Remove the app from your Google account permissions and try again.');
  setSecret('google:refresh', tokens.refresh_token);

  const info = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  })).json() as { sub: string; name?: string; email: string; picture?: string };

  return { id: info.sub, name: info.name ?? info.email, email: info.email, picture: info.picture, mode: 'google' };
}

export function cancelSignIn() {
  if (pending) {
    pending.reject(new Error('Sign-in cancelled'));
    pending.server.close();
    pending = null;
  }
}

async function tokenRequest(extra: Record<string, string>): Promise<Tokens> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...extra }),
  });
  const body = (await res.json()) as Tokens & { error?: string; error_description?: string };
  if (!res.ok) throw Object.assign(new Error(body.error_description ?? body.error ?? 'Token request failed'), { code: body.error });
  return body;
}

/** A valid access token, refreshing silently when needed. */
export async function getAccessToken(): Promise<string> {
  if (process.env.VD_FAKE_TOKEN) return process.env.VD_FAKE_TOKEN; // tests against the fake Drive only
  if (access && access.expiresAt > Date.now() + 60_000) return access.token;
  const refresh = getSecret('google:refresh');
  if (!refresh) throw Object.assign(new Error('Not signed in to Google'), { code: 'not_signed_in' });
  try {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
    access = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
    return access.token;
  } catch (e: any) {
    if (e.code === 'invalid_grant') {
      deleteSecret('google:refresh');
      throw Object.assign(new Error('Your Google session expired. Please sign in again.'), { code: 'reauth' });
    }
    throw e;
  }
}

export function signOutGoogle() {
  access = null;
  deleteSecret('google:refresh');
}

export const hasGoogleSession = () => !!getSecret('google:refresh');
