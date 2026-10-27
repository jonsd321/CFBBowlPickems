// Verifies a Firebase Auth ID token (RS256 JWT) and returns the player's uid.
// Google publishes the signing keys as JWKs, which WebCrypto can import directly.

import { b64u } from './webpush.js';

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const dec = new TextDecoder();

let cachedKeys = null;
let cachedUntil = 0;

async function signingKeys() {
  if (cachedKeys && Date.now() < cachedUntil) return cachedKeys;
  const res = await fetch(JWKS_URL, { cf: { cacheTtl: 3600 } });
  if (!res.ok) throw new Error(`Couldn't load Google signing keys (${res.status})`);
  cachedKeys = (await res.json()).keys || [];
  cachedUntil = Date.now() + 3600 * 1000;
  return cachedKeys;
}

export async function verifyIdToken(token, projectId) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Missing or malformed sign-in token');
  const [h, p, s] = parts;
  const header = JSON.parse(dec.decode(b64u.decode(h)));
  const claims = JSON.parse(dec.decode(b64u.decode(p)));
  const now = Math.floor(Date.now() / 1000);

  if (header.alg !== 'RS256') throw new Error('Unexpected token algorithm');
  if (claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('Token is for a different project');
  if (!claims.sub || claims.exp <= now || claims.iat > now + 300) throw new Error('Sign-in token expired; reload the page');

  const jwk = (await signingKeys()).find(k => k.kid === header.kid);
  if (!jwk) throw new Error('Unknown token signing key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u.decode(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new Error('Invalid sign-in token');
  return claims.sub;
}
