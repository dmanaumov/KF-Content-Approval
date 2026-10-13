// secretHash.js — one-way hashing for secrets this app owns outright: the
// self-serve "tool only" account passwords AND invite one-time codes (see
// toolAuth.js / toolInvites.js). Uses Node's own crypto.scrypt — no bcrypt —
// so this backend doesn't gain a native npm dependency (everything in
// package.json today is pure JS / no native build: pg, express, multer,
// node-fetch, web-push).
const crypto = require('crypto');
const { promisify } = require('util');
const scryptAsync = promisify(crypto.scrypt);

const KEYLEN = 64;

async function hashSecret(plain) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(String(plain), salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifySecret(plain, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (!salt.length || !expected.length) return false;
  const actual = await scryptAsync(String(plain), salt, expected.length);
  // timingSafeEqual throws on length mismatch rather than returning false —
  // guarded above by checking actual.length === expected.length first.
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

module.exports = { hashSecret, verifySecret };
