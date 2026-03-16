/**
 * Encryption and security management for ConfigSync.
 *
 * Uses AES-256-GCM (replacing the legacy Fernet/AES-128-CBC from the Python version).
 * Wire format for encrypted buffers: [IV 12 bytes][authTag 16 bytes][ciphertext].
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = 'sha256';
const VERIFICATION_STRING = 'CONFIGSYNC_VERIFICATION';

export default class CryptoManager {
  private configDir: string;
  private keyFile: string;
  private saltFile: string;
  private derivedKey: Buffer | null = null;

  constructor(configDir: string) {
    this.configDir = configDir;
    this.keyFile = path.join(configDir, '.key');
    this.saltFile = path.join(configDir, '.salt');
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Initialize the crypto system with a master password.
   * Generates a random salt, derives a key, and stores a verification token.
   */
  initialize(password: string): void {
    if (fs.existsSync(this.keyFile)) {
      throw new Error("Crypto already initialized. Use 'unlock' instead.");
    }

    // Generate a random salt and persist it
    const salt = crypto.randomBytes(SALT_LENGTH);
    fs.writeFileSync(this.saltFile, salt);
    fs.chmodSync(this.saltFile, 0o600);

    // Derive the master key
    const key = this.deriveKey(password, salt);

    // Encrypt a known verification string so we can validate the password later
    const verification = this.encryptWithKey(Buffer.from(VERIFICATION_STRING, 'utf-8'), key);

    const keyData = {
      verification: verification.toString('base64'),
      version: '2.0', // v2 = AES-256-GCM
    };

    fs.writeFileSync(this.keyFile, JSON.stringify(keyData));
    fs.chmodSync(this.keyFile, 0o600);

    this.derivedKey = key;
  }

  /**
   * Unlock the crypto system by verifying the master password.
   */
  unlock(password: string): void {
    if (this.derivedKey !== null) {
      return; // already unlocked
    }

    if (!fs.existsSync(this.keyFile)) {
      throw new Error("Crypto not initialized. Run 'configsync init' first.");
    }

    const salt = fs.readFileSync(this.saltFile);
    const key = this.deriveKey(password, salt);

    const keyData = JSON.parse(fs.readFileSync(this.keyFile, 'utf-8'));
    const verificationBuf = Buffer.from(keyData.verification, 'base64');

    try {
      const decrypted = this.decryptWithKey(verificationBuf, key);
      if (decrypted.toString('utf-8') !== VERIFICATION_STRING) {
        throw new Error('Invalid password');
      }
    } catch {
      throw new Error('Invalid password');
    }

    this.derivedKey = key;
  }

  /**
   * Returns true when the manager has not yet been unlocked.
   */
  isLocked(): boolean {
    return this.derivedKey === null;
  }

  // ---------------------------------------------------------------------------
  // Encrypt / Decrypt (raw buffers)
  // ---------------------------------------------------------------------------

  /**
   * Encrypt arbitrary data with AES-256-GCM.
   * Returns: [IV (12)][authTag (16)][ciphertext]
   */
  encrypt(data: Buffer): Buffer {
    this.requireUnlocked();
    return this.encryptWithKey(data, this.derivedKey!);
  }

  /**
   * Decrypt data previously encrypted by `encrypt`.
   */
  decrypt(data: Buffer): Buffer {
    this.requireUnlocked();
    return this.decryptWithKey(data, this.derivedKey!);
  }

  // ---------------------------------------------------------------------------
  // Secret-level encrypt / decrypt (key-salted, base64 string I/O)
  // ---------------------------------------------------------------------------

  /**
   * Encrypt a secret value with an additional key-specific salt.
   * Returns a base64-encoded string.
   */
  encryptSecret(key: string, value: string): string {
    this.requireUnlocked();

    const keySalt = crypto.createHash('sha256').update(key).digest().subarray(0, 16);
    const saltedValue = Buffer.concat([keySalt, Buffer.from(value, 'utf-8')]);

    const encrypted = this.encrypt(saltedValue);
    return encrypted.toString('base64');
  }

  /**
   * Decrypt a secret value and verify its key-specific salt.
   */
  decryptSecret(key: string, encrypted: string): string {
    this.requireUnlocked();

    const encryptedBuf = Buffer.from(encrypted, 'base64');
    const decrypted = this.decrypt(encryptedBuf);

    const keySalt = crypto.createHash('sha256').update(key).digest().subarray(0, 16);
    if (!decrypted.subarray(0, 16).equals(keySalt)) {
      throw new Error('Invalid key for this secret');
    }

    return decrypted.subarray(16).toString('utf-8');
  }

  // ---------------------------------------------------------------------------
  // Password rotation
  // ---------------------------------------------------------------------------

  /**
   * Change the master password. Re-encrypts the secrets file with the new key.
   */
  changePassword(oldPassword: string, newPassword: string): void {
    // Ensure the old password is valid
    this.unlock(oldPassword);

    // Derive a new key with a fresh salt
    const newSalt = crypto.randomBytes(SALT_LENGTH);
    const newKey = this.deriveKey(newPassword, newSalt);

    // Re-encrypt the secrets file if it exists
    const secretsFile = path.join(this.configDir, 'secrets.enc');
    if (fs.existsSync(secretsFile)) {
      const raw = fs.readFileSync(secretsFile);
      const plaintext = this.decrypt(raw);
      const reEncrypted = this.encryptWithKey(plaintext, newKey);
      fs.writeFileSync(secretsFile, reEncrypted);
      fs.chmodSync(secretsFile, 0o600);
    }

    // Persist the new salt
    fs.writeFileSync(this.saltFile, newSalt);
    fs.chmodSync(this.saltFile, 0o600);

    // Store new verification token
    const verification = this.encryptWithKey(Buffer.from(VERIFICATION_STRING, 'utf-8'), newKey);
    const keyData = {
      verification: verification.toString('base64'),
      version: '2.0',
    };
    fs.writeFileSync(this.keyFile, JSON.stringify(keyData));
    fs.chmodSync(this.keyFile, 0o600);

    this.derivedKey = newKey;
  }

  // ---------------------------------------------------------------------------
  // Key derivation
  // ---------------------------------------------------------------------------

  /**
   * Derive an encryption key from a password and salt using PBKDF2.
   */
  deriveKey(password: string, salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private requireUnlocked(): void {
    if (this.derivedKey === null) {
      throw new Error('CryptoManager is locked. Call unlock() first.');
    }
  }

  private encryptWithKey(data: Buffer, key: Buffer): Buffer {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Wire format: [iv][authTag][ciphertext]
    return Buffer.concat([iv, authTag, encrypted]);
  }

  private decryptWithKey(data: Buffer, key: Buffer): Buffer {
    const iv = data.subarray(0, IV_LENGTH);
    const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
