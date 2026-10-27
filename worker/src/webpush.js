// Web Push without libraries: VAPID signing (RFC 8292) and aes128gcm payload encryption (RFC 8291),
// using only WebCrypto so it runs on Cloudflare Workers (and in Node 20+ for tests).

const enc = new TextEncoder();

export const b64u = {
  encode(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
    return Uint8Array.from(s, c => c.charCodeAt(0));
  },
};

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

// HKDF with a single expand block, which covers every length Web Push needs (<= 32 bytes).
async function hkdf(salt, ikm, info, length) {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

// One sender key pair per run is fine: every message still gets its own random salt, so the
// content keys differ per message. Reusing it saves CPU on Workers' tight free-plan budget.
export async function newSenderKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { pair, publicRaw: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)) };
}

export async function encryptPayload(text, subscription, sender) {
  const uaPublic = b64u.decode(subscription.keys.p256dh);
  const authSecret = b64u.decode(subscription.keys.auth);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, sender.pair.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, sender.publicRaw), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = concat(enc.encode(text), new Uint8Array([2])); // 0x02 = last (and only) record
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, padded));

  const header = new Uint8Array(16 + 4 + 1);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = sender.publicRaw.length;
  return concat(header, sender.publicRaw, cipher);
}

// The VAPID header proves the push came from this site's key. It depends only on the push
// service's origin, so it's built once per origin per run.
export async function vapidHeader(endpoint, vapid, cache = new Map()) {
  const aud = new URL(endpoint).origin;
  if (cache.has(aud)) return cache.get(aud);
  const head = b64u.encode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.encode(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: vapid.subject })));
  const key = await crypto.subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`));
  const value = `vapid t=${head}.${claims}.${b64u.encode(sig)}, k=${vapid.publicKey}`;
  cache.set(aud, value);
  return value;
}

// Returns the push service's HTTP status. 404/410 mean the subscription is gone for good.
export async function sendPush(subscription, message, { vapid, sender, vapidCache, ttl = 6 * 3600, urgency = 'high' }) {
  const body = await encryptPayload(JSON.stringify(message), subscription, sender);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(subscription.endpoint, vapid, vapidCache),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
    },
    body,
  });
  return res.status;
}
