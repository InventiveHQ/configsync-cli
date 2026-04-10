/**
 * Envelope encryption library for ConfigSync v2.
 *
 * Implements §4 of the v2 refactor plan. The fundamental problem with v1
 * is that each machine generated its own local PBKDF2 salt, so two
 * machines with the same master password produced different keys and
 * could not decrypt each other's data.
 *
 * v2 fixes this with envelope encryption:
 *
 *   1. Each user has an X25519 keypair. The private key is wrapped with a
 *      KEK derived from the master password + a server-stored salt, so
 *      any machine with the password can recover the private key.
 *   2. Each entity has a random DEK. The DEK is wrapped with the user's
 *      public key via a libsodium-style sealed box, so anyone with the
 *      matching private key can unwrap it.
 *   3. Entity blobs are encrypted with the DEK using AES-256-GCM, with
 *      optional AAD binding the ciphertext to the entity identity to
 *      prevent cross-entity swap attacks.
 *
 * AES-256-GCM is preserved from the legacy CryptoManager so the blob
 * wire format is consistent. tweetnacl provides X25519 primitives; all
 * symmetric crypto goes through Node's built-in `node:crypto`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import nacl from 'tweetnacl';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PBKDF2_ITERATIONS = 600_000;
export const PBKDF2_DIGEST = 'sha256';
export const KEK_LENGTH = 32;
export const SALT_LENGTH = 32;
export const SYMMETRIC_CIPHER = 'aes-256-gcm';
export const IV_LENGTH = 12;
export const AUTH_TAG_LENGTH = 16;
export const DEK_LENGTH = 32;

const X25519_PUBKEY_LENGTH = 32;
const X25519_SECRETKEY_LENGTH = 32;
const SEALED_BOX_NONCE_LENGTH = 24; // nacl.box expects 24-byte nonces

// ---------------------------------------------------------------------------
// KEK derivation
// ---------------------------------------------------------------------------

/**
 * Derive a 32-byte key encryption key (KEK) from the master password
 * and a server-visible salt using PBKDF2-HMAC-SHA256 with 600k
 * iterations.
 *
 * The salt is supplied from `user_keys.kek_salt` on the server, so every
 * machine derives the same KEK from the same password.
 */
export function deriveKEK(password: string, salt: Buffer): Buffer {
  if (salt.length !== SALT_LENGTH) {
    throw new Error(`KEK salt must be ${SALT_LENGTH} bytes, got ${salt.length}`);
  }
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEK_LENGTH, PBKDF2_DIGEST);
}

// ---------------------------------------------------------------------------
// AES-256-GCM symmetric encryption
// ---------------------------------------------------------------------------

/**
 * Encrypt `plaintext` with a 32-byte symmetric key using AES-256-GCM.
 *
 * Wire format: `[iv (12)][authTag (16)][ciphertext]`. Matches the legacy
 * CryptoManager so downstream code can reuse parsing helpers.
 */
export function encryptWithKey(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== KEK_LENGTH) {
    throw new Error(`Key must be ${KEK_LENGTH} bytes, got ${key.length}`);
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(SYMMETRIC_CIPHER, key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, ciphertext]);
}

/**
 * Decrypt data previously produced by `encryptWithKey`. Throws on
 * auth-tag mismatch.
 */
export function decryptWithKey(ciphertext: Buffer, key: Buffer): Buffer {
  if (key.length !== KEK_LENGTH) {
    throw new Error(`Key must be ${KEK_LENGTH} bytes, got ${key.length}`);
  }
  if (ciphertext.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Ciphertext too short');
  }

  const iv = ciphertext.subarray(0, IV_LENGTH);
  const authTag = ciphertext.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ct = ciphertext.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(SYMMETRIC_CIPHER, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ---------------------------------------------------------------------------
// X25519 keypair generation
// ---------------------------------------------------------------------------

export interface UserKeypair {
  /** 32-byte X25519 public key. Safe to share. */
  publicKey: Buffer;
  /** 32-byte X25519 secret key. Must be held only in memory on the client. */
  privateKey: Buffer;
}

/**
 * Generate a fresh X25519 keypair via tweetnacl. Both halves are 32
 * bytes. The public key is stored plaintext in `user_keys.public_key`;
 * the private key is encrypted with the KEK before leaving the machine.
 */
export function generateUserKeypair(): UserKeypair {
  const pair = nacl.box.keyPair();
  return {
    publicKey: Buffer.from(pair.publicKey),
    privateKey: Buffer.from(pair.secretKey),
  };
}

// ---------------------------------------------------------------------------
// Wrapping / unwrapping the user's private key with the KEK
// ---------------------------------------------------------------------------

export interface EncryptedPrivateKey {
  /** AES-256-GCM ciphertext, wire format `[iv][authTag][ct]`. */
  ciphertext: Buffer;
  /** Fresh 32-byte salt used to derive the KEK. */
  kekSalt: Buffer;
  /** PBKDF2 iteration count. Stored so iterations can be bumped later. */
  kekIterations: number;
}

/**
 * Wrap the user's X25519 private key with a KEK derived from the
 * supplied password and a fresh random salt. The returned bundle is
 * exactly what gets persisted to the server's `user_keys` row:
 *
 *   - `ciphertext` → `user_keys.encrypted_private_key`
 *   - `kekSalt`    → `user_keys.kek_salt`
 *   - `kekIterations` → `user_keys.kek_iterations`
 */
export function wrapPrivateKey(privateKey: Buffer, password: string): EncryptedPrivateKey {
  if (privateKey.length !== X25519_SECRETKEY_LENGTH) {
    throw new Error(
      `Private key must be ${X25519_SECRETKEY_LENGTH} bytes, got ${privateKey.length}`,
    );
  }

  const salt = crypto.randomBytes(SALT_LENGTH);
  const kek = deriveKEK(password, salt);
  const ciphertext = encryptWithKey(privateKey, kek);

  return {
    ciphertext,
    kekSalt: salt,
    kekIterations: PBKDF2_ITERATIONS,
  };
}

/**
 * Reverse of `wrapPrivateKey`. Re-derives the KEK from the password and
 * the stored salt+iterations, then decrypts the wrapped private key.
 * Throws on wrong password (AES-GCM auth tag mismatch).
 */
export function unwrapPrivateKey(wrapped: EncryptedPrivateKey, password: string): Buffer {
  if (wrapped.kekSalt.length !== SALT_LENGTH) {
    throw new Error(`KEK salt must be ${SALT_LENGTH} bytes, got ${wrapped.kekSalt.length}`);
  }

  // Honor the stored iteration count rather than hard-coding the current
  // default, so records written by an older client still unwrap cleanly.
  const kek = crypto.pbkdf2Sync(
    password,
    wrapped.kekSalt,
    wrapped.kekIterations,
    KEK_LENGTH,
    PBKDF2_DIGEST,
  );

  try {
    return decryptWithKey(wrapped.ciphertext, kek);
  } catch (err: any) {
    const msg = err.message ?? String(err);
    const detail = 
      `\n!!! PRIVATE KEY UNWRAP FAILURE !!!\n` +
      `Error: ${msg}\n` +
      `Salt: ${wrapped.kekSalt.toString('hex')}\n` +
      `Iterations: ${wrapped.kekIterations}\n` +
      `!!! -------------------------- !!!\n`;
    fs.writeSync(2, detail);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// DEK generation and sealed-box wrapping
// ---------------------------------------------------------------------------

/**
 * Generate a fresh 32-byte data encryption key. Each entity (project,
 * env file, vault secret, ...) gets its own DEK.
 */
export function generateDEK(): Buffer {
  return crypto.randomBytes(DEK_LENGTH);
}

/**
 * Derive the deterministic nonce used by the sealed-box construction.
 *
 * The canonical libsodium sealed box uses Blake2b over
 * `ephemeral_pubkey || recipient_pubkey`. tweetnacl doesn't expose
 * Blake2b, so we use SHA-256 truncated to 24 bytes instead. The nonce
 * is only required to be unique per encryption, and the ephemeral
 * keypair is fresh per call, so SHA-256 of the two public keys meets
 * that bar.
 */
function sealedBoxNonce(ephemeralPublicKey: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
  const digest = crypto
    .createHash('sha256')
    .update(Buffer.from(ephemeralPublicKey))
    .update(Buffer.from(recipientPublicKey))
    .digest();
  return new Uint8Array(digest.subarray(0, SEALED_BOX_NONCE_LENGTH));
}

/**
 * Wrap a DEK to a recipient's X25519 public key using a libsodium-style
 * sealed box. Produces an anonymous-sender ciphertext: the recipient can
 * decrypt it without knowing who sent it.
 *
 * Wire format: `[ephemeral_pubkey (32)][ciphertext]`. The nonce is not
 * stored because it's deterministically reproducible from the two
 * public keys.
 */
export function wrapDEK(dek: Buffer, recipientPublicKey: Buffer): Buffer {
  if (dek.length !== DEK_LENGTH) {
    throw new Error(`DEK must be ${DEK_LENGTH} bytes, got ${dek.length}`);
  }
  if (recipientPublicKey.length !== X25519_PUBKEY_LENGTH) {
    throw new Error(
      `Recipient public key must be ${X25519_PUBKEY_LENGTH} bytes, got ${recipientPublicKey.length}`,
    );
  }

  const ephemeral = nacl.box.keyPair();
  const recipientPub = new Uint8Array(recipientPublicKey);
  const nonce = sealedBoxNonce(ephemeral.publicKey, recipientPub);

  const ciphertext = nacl.box(new Uint8Array(dek), nonce, recipientPub, ephemeral.secretKey);

  // Zero out the ephemeral secret key. Not strictly necessary since it
  // was only in memory, but good hygiene and cheap.
  ephemeral.secretKey.fill(0);

  return Buffer.concat([Buffer.from(ephemeral.publicKey), Buffer.from(ciphertext)]);
}

/**
 * Unwrap a DEK previously wrapped by `wrapDEK`, using the recipient's
 * keypair. Throws if the ciphertext doesn't authenticate under the
 * recipient's private key.
 */
export function unwrapDEK(wrapped: Buffer, recipientKeypair: UserKeypair): Buffer {
  if (wrapped.length <= X25519_PUBKEY_LENGTH) {
    throw new Error('Wrapped DEK too short');
  }
  if (recipientKeypair.privateKey.length !== X25519_SECRETKEY_LENGTH) {
    throw new Error(
      `Recipient private key must be ${X25519_SECRETKEY_LENGTH} bytes, got ${recipientKeypair.privateKey.length}`,
    );
  }
  if (recipientKeypair.publicKey.length !== X25519_PUBKEY_LENGTH) {
    throw new Error(
      `Recipient public key must be ${X25519_PUBKEY_LENGTH} bytes, got ${recipientKeypair.publicKey.length}`,
    );
  }

  const ephemeralPub = new Uint8Array(wrapped.subarray(0, X25519_PUBKEY_LENGTH));
  const ciphertext = new Uint8Array(wrapped.subarray(X25519_PUBKEY_LENGTH));
  const recipientPub = new Uint8Array(recipientKeypair.publicKey);
  const recipientSec = new Uint8Array(recipientKeypair.privateKey);

  const nonce = sealedBoxNonce(ephemeralPub, recipientPub);

  const dek = nacl.box.open(ciphertext, nonce, ephemeralPub, recipientSec);
  if (dek === null) {
    const detail = 
      `\n!!! DEK UNWRAP FAILURE !!!\n` +
      `Recipient PubKey: ${recipientKeypair.publicKey.toString('hex')}\n` +
      `!!! ------------------ !!!\n`;
    fs.writeSync(2, detail);
    throw new Error('Failed to unwrap DEK: authentication failed');
  }

  return Buffer.from(dek);
}

// ---------------------------------------------------------------------------
// Entity blob encryption
// ---------------------------------------------------------------------------

/**
 * Encrypt an entity blob with its DEK using AES-256-GCM.
 *
 * If `aad` is supplied it is bound to the ciphertext via AES-GCM's AAD
 * mechanism. Per §4.4 of the plan, callers pass
 * `entity_type || entity_id || version` as AAD to prevent cross-entity
 * swap attacks. If AAD is used on encrypt, the same AAD MUST be passed
 * on decrypt or authentication will fail.
 *
 * Wire format matches `encryptWithKey`: `[iv (12)][authTag (16)][ct]`.
 */
export function encryptBlob(plaintext: Buffer, dek: Buffer, aad?: Buffer): Buffer {
  if (dek.length !== DEK_LENGTH) {
    throw new Error(`DEK must be ${DEK_LENGTH} bytes, got ${dek.length}`);
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(SYMMETRIC_CIPHER, dek, iv);

  if (aad !== undefined) {
    cipher.setAAD(aad);
  }

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, ciphertext]);
}

/**
 * Decrypt an entity blob. If the blob was encrypted with AAD, the same
 * AAD must be supplied here. Throws on auth tag mismatch.
 */
export function decryptBlob(ciphertext: Buffer, dek: Buffer, aad?: Buffer): Buffer {
  if (dek.length !== DEK_LENGTH) {
    throw new Error(`DEK must be ${DEK_LENGTH} bytes, got ${dek.length}`);
  }
  if (ciphertext.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Ciphertext too short');
  }

  const iv = ciphertext.subarray(0, IV_LENGTH);
  const authTag = ciphertext.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ct = ciphertext.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(SYMMETRIC_CIPHER, dek, iv);
  decipher.setAuthTag(authTag);

  if (aad !== undefined) {
    decipher.setAAD(aad);
  }

  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (err: any) {
    const msg = err.message ?? String(err);
    const detail = 
      `\n!!! BLOB DECRYPTION FAILURE !!!\n` +
      `Error: ${msg}\n` +
      `AAD (raw): ${aad ? aad.toString('utf-8') : 'none'}\n` +
      `Ciphertext size: ${ct.length} bytes\n` +
      `!!! ----------------------- !!!\n`;
    fs.writeSync(2, detail);
    throw err;
  }
}
