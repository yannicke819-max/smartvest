#!/usr/bin/env node
// Génère une paire de clés VAPID P-256 pour Web Push (LISA B.4.c).
// Sortie : VAPID_PUBLIC_KEY (base64url uncompressed 65 bytes)
//          VAPID_PRIVATE_KEY (base64url raw 32 bytes)
//
// Usage : node scripts/generate-vapid-keys.mjs
// Puis : fly secrets set -a smartvest VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=...
//        NEXT_PUBLIC_VAPID_PUBLIC_KEY=<same as public> en .env web pour subscribe.

import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pubJwk = publicKey.export({ format: 'jwk' });
const privJwk = privateKey.export({ format: 'jwk' });

// VAPID public key = 0x04 + X + Y (uncompressed point)
const xBuf = Buffer.from(pubJwk.x.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const yBuf = Buffer.from(pubJwk.y.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const uncompressed = Buffer.concat([Buffer.from([0x04]), xBuf, yBuf]);
const vapidPublic = uncompressed.toString('base64')
  .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const vapidPrivate = privJwk.d; // already base64url

console.log('VAPID keypair generated (P-256). Set these in your env :\n');
console.log(`VAPID_PUBLIC_KEY=${vapidPublic}`);
console.log(`VAPID_PRIVATE_KEY=${vapidPrivate}`);
console.log(`NEXT_PUBLIC_VAPID_PUBLIC_KEY=${vapidPublic}  # web subscribe`);
console.log(`VAPID_SUBJECT=mailto:lisa@smartvest.app       # contact admin`);
