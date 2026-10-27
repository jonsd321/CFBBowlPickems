// Creates the push (VAPID) key pair. Run once:  node worker/scripts/generate-vapid.mjs
// - Prints the public key: put it in js/config.js (push.vapidPublicKey) and worker/wrangler.toml.
// - Writes the private key to worker/.vapid-private.json (git-ignored). Upload it with
//     npx wrangler secret put VAPID_PRIVATE_JWK
//   and paste the file's contents. Don't commit it or share it.
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../.vapid-private.json', import.meta.url));
if (existsSync(out) && !process.argv.includes('--force')) {
  console.error(`${out} already exists. Re-run with --force to replace it (existing subscriptions will stop working).`);
  process.exit(1);
}

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
const publicKey = Buffer.from(raw).toString('base64url');

writeFileSync(out, JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }));
console.log('Public key (config.js + wrangler.toml):');
console.log(publicKey);
console.log(`\nPrivate key written to ${out}`);
