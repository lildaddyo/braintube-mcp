// App-level encryption at rest for third-party tokens we must store (BTMCP-06).
//
// Users' legacy Notion integration tokens (set_notion_api_key) used to be written to
// user_settings.setting_value in plain text. They are now sealed with AES-256-GCM under a
// server-held key before they reach Postgres, so a DB read leak (backup, over-broad policy,
// admin tool) no longer exposes working Notion tokens.
//
// Key: SECRET_BOX_KEY (any string of at least 32 characters; it is hashed with SHA-256 to
// the 32-byte AES key). Fail-safe rollout, because this service auto-deploys from master:
//   - key set   -> new values are sealed ("enc:v1:..."), sealed values are opened.
//   - key unset -> new values are stored as before (plain) with a loud warning, so nothing
//                  breaks before the owner sets the key; sealed values cannot be opened and
//                  the caller gets a clear error.
// Values without the prefix are treated as legacy plain text on read, so existing rows keep
// working and are sealed the next time the user saves their key.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

export const SEALED_PREFIX = 'enc:v1:';
const MIN_KEY_CHARS = 32;

let warnedNoKey = false;

/** The 32-byte AES key derived from SECRET_BOX_KEY, or null when it is unset or too short. */
export function secretBoxKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = (env.SECRET_BOX_KEY ?? '').trim();
  if (raw.length < MIN_KEY_CHARS) return null;
  return createHash('sha256').update(raw, 'utf8').digest();
}

export function isSealed(value: string): boolean {
  return value.startsWith(SEALED_PREFIX);
}

/** Seal `plain` under `key` (AES-256-GCM, random 96-bit IV). */
export function seal(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return SEALED_PREFIX + [iv, tag, ct].map((b) => b.toString('base64url')).join(':');
}

/** Open a value produced by seal(). Throws on a wrong key or tampered value. */
export function open(sealed: string, key: Buffer): string {
  if (!isSealed(sealed)) throw new Error('Value is not sealed');
  const parts = sealed.slice(SEALED_PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Malformed sealed value');
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64url'));
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Malformed sealed value');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** What to store for a secret: sealed when the key is configured, else plain (with a warning). */
export function sealForStorage(plain: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = secretBoxKey(env);
  if (key) return seal(plain, key);
  if (!warnedNoKey) {
    warnedNoKey = true;
    console.error(
      '[secret-box] WARNING: SECRET_BOX_KEY is not set (or shorter than 32 chars) — third-party tokens are being stored UNENCRYPTED. Set SECRET_BOX_KEY on the service.',
    );
  }
  return plain;
}

/** Read a stored secret: opens sealed values, passes legacy plain values through. */
export function openFromStorage(stored: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!isSealed(stored)) return stored;
  const key = secretBoxKey(env);
  if (!key) throw new Error('Stored token is encrypted but SECRET_BOX_KEY is not configured on the server.');
  return open(stored, key);
}
