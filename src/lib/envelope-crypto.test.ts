/**
 * Tests for the v2 envelope encryption library.
 *
 * The headline tests are the two cross-machine simulations at the end
 * of the file — they are the whole reason this library exists.
 */

import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';

import {
  DEK_LENGTH,
  KEK_LENGTH,
  PBKDF2_ITERATIONS,
  SALT_LENGTH,
  decryptBlob,
  decryptWithKey,
  deriveKEK,
  encryptBlob,
  encryptWithKey,
  generateDEK,
  generateUserKeypair,
  unwrapDEK,
  unwrapPrivateKey,
  wrapDEK,
  wrapPrivateKey,
} from './envelope-crypto.js';

// ---------------------------------------------------------------------------
// KEK derivation
// ---------------------------------------------------------------------------

describe('deriveKEK', () => {
  it('returns a 32-byte key', () => {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const kek = deriveKEK('correct horse battery staple', salt);
    expect(kek.length).toBe(KEK_LENGTH);
  });

  it('is deterministic for the same password and salt', () => {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const a = deriveKEK('password', salt);
    const b = deriveKEK('password', salt);
    expect(a.equals(b)).toBe(true);
  });

  it('produces different keys for different salts', () => {
    const saltA = crypto.randomBytes(SALT_LENGTH);
    const saltB = crypto.randomBytes(SALT_LENGTH);
    const a = deriveKEK('password', saltA);
    const b = deriveKEK('password', saltB);
    expect(a.equals(b)).toBe(false);
  });

  it('produces different keys for different passwords', () => {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const a = deriveKEK('password-a', salt);
    const b = deriveKEK('password-b', salt);
    expect(a.equals(b)).toBe(false);
  });

  it('rejects a salt of the wrong length', () => {
    expect(() => deriveKEK('password', Buffer.alloc(16))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AES-256-GCM symmetric encryption
// ---------------------------------------------------------------------------

describe('encryptWithKey / decryptWithKey', () => {
  it('round-trips a plaintext buffer', () => {
    const key = crypto.randomBytes(KEK_LENGTH);
    const plaintext = Buffer.from('hello, envelope encryption');
    const ciphertext = encryptWithKey(plaintext, key);
    const decrypted = decryptWithKey(ciphertext, key);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it('produces distinct ciphertexts for the same plaintext (random IV)', () => {
    const key = crypto.randomBytes(KEK_LENGTH);
    const plaintext = Buffer.from('deterministic plaintext');
    const a = encryptWithKey(plaintext, key);
    const b = encryptWithKey(plaintext, key);
    expect(a.equals(b)).toBe(false);
  });

  it('throws when decrypting with the wrong key', () => {
    const keyA = crypto.randomBytes(KEK_LENGTH);
    const keyB = crypto.randomBytes(KEK_LENGTH);
    const ciphertext = encryptWithKey(Buffer.from('secret'), keyA);
    expect(() => decryptWithKey(ciphertext, keyB)).toThrow();
  });

  it('throws when ciphertext has been tampered with', () => {
    const key = crypto.randomBytes(KEK_LENGTH);
    const ciphertext = encryptWithKey(Buffer.from('tamper me'), key);
    // flip a bit in the ciphertext portion
    ciphertext[ciphertext.length - 1] ^= 0x01;
    expect(() => decryptWithKey(ciphertext, key)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Keypair generation
// ---------------------------------------------------------------------------

describe('generateUserKeypair', () => {
  it('produces 32-byte public and private keys', () => {
    const pair = generateUserKeypair();
    expect(pair.publicKey.length).toBe(32);
    expect(pair.privateKey.length).toBe(32);
  });

  it('produces distinct public and private keys', () => {
    const pair = generateUserKeypair();
    expect(pair.publicKey.equals(pair.privateKey)).toBe(false);
  });

  it('produces distinct keypairs across calls', () => {
    const a = generateUserKeypair();
    const b = generateUserKeypair();
    expect(a.publicKey.equals(b.publicKey)).toBe(false);
    expect(a.privateKey.equals(b.privateKey)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wrap / unwrap private key
// ---------------------------------------------------------------------------

describe('wrapPrivateKey / unwrapPrivateKey', () => {
  it('round-trips the private key with the correct password', () => {
    const pair = generateUserKeypair();
    const wrapped = wrapPrivateKey(pair.privateKey, 'correct horse');
    const recovered = unwrapPrivateKey(wrapped, 'correct horse');
    expect(recovered.equals(pair.privateKey)).toBe(true);
  });

  it('stores the expected PBKDF2 iteration count', () => {
    const pair = generateUserKeypair();
    const wrapped = wrapPrivateKey(pair.privateKey, 'password');
    expect(wrapped.kekIterations).toBe(PBKDF2_ITERATIONS);
    expect(wrapped.kekSalt.length).toBe(SALT_LENGTH);
  });

  it('throws with an incorrect password', () => {
    const pair = generateUserKeypair();
    const wrapped = wrapPrivateKey(pair.privateKey, 'correct horse');
    expect(() => unwrapPrivateKey(wrapped, 'wrong horse')).toThrow();
  });

  it('produces different wrappings for the same input (random salt)', () => {
    const pair = generateUserKeypair();
    const a = wrapPrivateKey(pair.privateKey, 'password');
    const b = wrapPrivateKey(pair.privateKey, 'password');
    expect(a.kekSalt.equals(b.kekSalt)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DEK generation
// ---------------------------------------------------------------------------

describe('generateDEK', () => {
  it('produces a 32-byte key', () => {
    expect(generateDEK().length).toBe(DEK_LENGTH);
  });

  it('produces distinct keys across calls', () => {
    const a = generateDEK();
    const b = generateDEK();
    expect(a.equals(b)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// wrapDEK / unwrapDEK (sealed box)
// ---------------------------------------------------------------------------

describe('wrapDEK / unwrapDEK', () => {
  it('round-trips a DEK through the recipient keypair', () => {
    const recipient = generateUserKeypair();
    const dek = generateDEK();
    const wrapped = wrapDEK(dek, recipient.publicKey);
    const recovered = unwrapDEK(wrapped, recipient);
    expect(recovered.equals(dek)).toBe(true);
  });

  it('produces distinct wrappings for the same DEK (fresh ephemeral key)', () => {
    const recipient = generateUserKeypair();
    const dek = generateDEK();
    const a = wrapDEK(dek, recipient.publicKey);
    const b = wrapDEK(dek, recipient.publicKey);
    expect(a.equals(b)).toBe(false);
  });

  it("throws when unwrapping with the wrong recipient's keypair", () => {
    const alice = generateUserKeypair();
    const bob = generateUserKeypair();
    const dek = generateDEK();
    const wrappedForAlice = wrapDEK(dek, alice.publicKey);
    expect(() => unwrapDEK(wrappedForAlice, bob)).toThrow();
  });

  it('throws when the ciphertext has been tampered with', () => {
    const recipient = generateUserKeypair();
    const dek = generateDEK();
    const wrapped = wrapDEK(dek, recipient.publicKey);
    wrapped[wrapped.length - 1] ^= 0x01;
    expect(() => unwrapDEK(wrapped, recipient)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Blob AEAD
// ---------------------------------------------------------------------------

describe('encryptBlob / decryptBlob', () => {
  it('round-trips without AAD', () => {
    const dek = generateDEK();
    const plaintext = Buffer.from('entity blob contents');
    const ciphertext = encryptBlob(plaintext, dek);
    const recovered = decryptBlob(ciphertext, dek);
    expect(recovered.equals(plaintext)).toBe(true);
  });

  it('round-trips with AAD', () => {
    const dek = generateDEK();
    const plaintext = Buffer.from('entity blob contents');
    const aad = Buffer.from('project|abc-123|v7');
    const ciphertext = encryptBlob(plaintext, dek, aad);
    const recovered = decryptBlob(ciphertext, dek, aad);
    expect(recovered.equals(plaintext)).toBe(true);
  });

  it('fails if AAD differs on decrypt', () => {
    const dek = generateDEK();
    const plaintext = Buffer.from('entity blob contents');
    const ciphertext = encryptBlob(plaintext, dek, Buffer.from('project|abc-123|v7'));
    expect(() =>
      decryptBlob(ciphertext, dek, Buffer.from('project|abc-123|v8')),
    ).toThrow();
  });

  it('fails if AAD is missing on decrypt', () => {
    const dek = generateDEK();
    const plaintext = Buffer.from('entity blob contents');
    const ciphertext = encryptBlob(plaintext, dek, Buffer.from('project|abc-123|v7'));
    expect(() => decryptBlob(ciphertext, dek)).toThrow();
  });

  it('fails if AAD is added on decrypt but was not used on encrypt', () => {
    const dek = generateDEK();
    const plaintext = Buffer.from('entity blob contents');
    const ciphertext = encryptBlob(plaintext, dek);
    expect(() => decryptBlob(ciphertext, dek, Buffer.from('any aad'))).toThrow();
  });

  it('fails with the wrong DEK', () => {
    const dekA = generateDEK();
    const dekB = generateDEK();
    const ciphertext = encryptBlob(Buffer.from('secret'), dekA);
    expect(() => decryptBlob(ciphertext, dekB)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Cross-machine simulation (headline tests)
// ---------------------------------------------------------------------------

describe('envelope round-trip through wire-format only', () => {
  it('decrypts a blob after forgetting the DEK and recovering it from wire bytes', () => {
    // Machine sets up an identity and encrypts a blob.
    const identity = generateUserKeypair();

    const originalDek = generateDEK();
    const wrappedDekBytes = wrapDEK(originalDek, identity.publicKey);

    const plaintext = Buffer.from('the launch codes are 12345');
    const encryptedBlobBytes = encryptBlob(plaintext, originalDek);

    // Forget the DEK — from now on the only state is the wire-format
    // bytes and the identity keypair, exactly what would be available
    // to a fresh machine after login.
    originalDek.fill(0);

    // Fresh context.
    const recoveredDek = unwrapDEK(wrappedDekBytes, identity);
    expect(recoveredDek.length).toBe(DEK_LENGTH);

    const recoveredPlaintext = decryptBlob(encryptedBlobBytes, recoveredDek);
    expect(recoveredPlaintext.equals(Buffer.from('the launch codes are 12345'))).toBe(true);
  });
});

describe('full simulated cross-machine flow (headline test for the v2 bug fix)', () => {
  it('Machine B can decrypt a blob pushed by Machine A using only the persisted bundle', () => {
    const password = 'correct horse battery staple';

    // ----- Machine A: user signup + encrypt content -----
    const aKeypair = generateUserKeypair();
    const aWrappedPrivate = wrapPrivateKey(aKeypair.privateKey, password);

    const aDek = generateDEK();
    const aWrappedDek = wrapDEK(aDek, aKeypair.publicKey);

    const aad = Buffer.from('project|proj-42|v1');
    const originalPlaintext = Buffer.from(
      JSON.stringify({ DATABASE_URL: 'postgres://prod', SECRET: 'hunter2' }),
    );
    const aEncryptedBlob = encryptBlob(originalPlaintext, aDek, aad);

    // Persist exactly what would go to the server. Everything else is
    // discarded to simulate a cold second machine.
    const persistedBundle = {
      // from user_keys
      encrypted_private_key: Buffer.from(aWrappedPrivate.ciphertext),
      kek_salt: Buffer.from(aWrappedPrivate.kekSalt),
      kek_iterations: aWrappedPrivate.kekIterations,
      public_key: Buffer.from(aKeypair.publicKey),
      // from project_keys
      wrapped_dek: Buffer.from(aWrappedDek),
      // from R2
      encrypted_blob: Buffer.from(aEncryptedBlob),
      // AAD that the server can reconstruct from plaintext metadata columns
      aad: Buffer.from(aad),
    };

    // Scrub Machine A's in-memory secrets. Machine B has never seen
    // these; only the persisted bundle and the password are available.
    aKeypair.privateKey.fill(0);
    aDek.fill(0);

    // ----- Machine B: fresh login, decrypt pushed content -----
    const bWrapped = {
      ciphertext: persistedBundle.encrypted_private_key,
      kekSalt: persistedBundle.kek_salt,
      kekIterations: persistedBundle.kek_iterations,
    };
    const bPrivate = unwrapPrivateKey(bWrapped, password);
    const bKeypair = {
      publicKey: persistedBundle.public_key,
      privateKey: bPrivate,
    };

    const bDek = unwrapDEK(persistedBundle.wrapped_dek, bKeypair);
    const bPlaintext = decryptBlob(
      persistedBundle.encrypted_blob,
      bDek,
      persistedBundle.aad,
    );

    expect(bPlaintext.toString('utf-8')).toBe(
      JSON.stringify({ DATABASE_URL: 'postgres://prod', SECRET: 'hunter2' }),
    );
  });

  it('Machine B with the wrong password cannot unwrap the private key', () => {
    const aKeypair = generateUserKeypair();
    const aWrapped = wrapPrivateKey(aKeypair.privateKey, 'correct horse');
    expect(() => unwrapPrivateKey(aWrapped, 'wrong horse')).toThrow();
  });
});
