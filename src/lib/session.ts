/**
 * Session management for v2 commands.
 *
 * Holds the user's X25519 keypair between CLI invocations so the user
 * only has to type the master password once per `login` + whatever
 * session timeout the file's mtime implies.
 *
 * The session file is stored at `~/.configsync/session.v2.json` with
 * mode 0600 and contains the X25519 public key, the KEK-wrapped private
 * key, the KEK salt, and the KEK iteration count. On `login` the CLI
 * derives the KEK from the master password, unwraps the private key,
 * verifies it, and writes this file out. Subsequent commands prompt
 * for the password, re-derive the KEK from the stored salt, and unwrap
 * the private key in memory.
 *
 * Design note: we deliberately do NOT cache the unwrapped KEK or
 * plaintext private key on disk. Every command requires the master
 * password. A future iteration can add an OS keychain integration.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  EncryptedPrivateKey,
  UserKeypair,
  unwrapPrivateKey,
  wrapPrivateKey,
} from './envelope-crypto.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionFile {
  version: 2;
  user_id: number;
  email?: string;
  api_url: string;
  machine_id: string;
  public_key_b64: string;
  encrypted_private_key_b64: string;
  kek_salt_b64: string;
  kek_iterations: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  readonly sessionFile: string;

  constructor(configDir: string) {
    this.sessionFile = path.join(configDir, 'session.v2.json');
  }

  exists(): boolean {
    return fs.existsSync(this.sessionFile);
  }

  load(): SessionFile {
    if (!this.exists()) {
      throw new Error("No v2 session found. Run 'configsync login' first.");
    }
    const raw = fs.readFileSync(this.sessionFile, 'utf-8');
    const data = JSON.parse(raw) as SessionFile;
    if (data.version !== 2) {
      throw new Error(`Unsupported session file version: ${data.version}`);
    }
    return data;
  }

  save(data: SessionFile): void {
    fs.mkdirSync(path.dirname(this.sessionFile), { recursive: true });
    fs.writeFileSync(this.sessionFile, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  clear(): void {
    if (this.exists()) fs.unlinkSync(this.sessionFile);
  }

  /**
   * Derive the user's keypair from the session file using the master
   * password. Throws on wrong password (AES-GCM auth tag mismatch).
   */
  unlockKeypair(password: string): UserKeypair {
    const s = this.load();
    const wrapped: EncryptedPrivateKey = {
      ciphertext: Buffer.from(s.encrypted_private_key_b64, 'base64'),
      kekSalt: Buffer.from(s.kek_salt_b64, 'base64'),
      kekIterations: s.kek_iterations,
    };
    try {
      const privateKey = unwrapPrivateKey(wrapped, password);
      return {
        publicKey: Buffer.from(s.public_key_b64, 'base64'),
        privateKey,
      };
    } catch (err: any) {
      throw new Error(
        `Failed to unwrap private key: ${err.message ?? String(err)}\n` +
        `  Salt: ${s.kek_salt_b64}\n` +
        `  Iterations: ${s.kek_iterations}\n` +
        `  This usually means the master password does not match the one used during 'login' on THIS machine.`
      );
    }
  }

  /**
   * Build a fresh session file from a keypair + wrapped-private-key
   * bundle. Used by `init` and `login`. The caller writes the file via
   * `save()`.
   */
  static buildSession(params: {
    userId: number;
    email?: string;
    apiUrl: string;
    machineId: string;
    keypair: UserKeypair;
    wrappedPrivateKey: EncryptedPrivateKey;
  }): SessionFile {
    return {
      version: 2,
      user_id: params.userId,
      email: params.email,
      api_url: params.apiUrl,
      machine_id: params.machineId,
      public_key_b64: params.keypair.publicKey.toString('base64'),
      encrypted_private_key_b64: params.wrappedPrivateKey.ciphertext.toString('base64'),
      kek_salt_b64: params.wrappedPrivateKey.kekSalt.toString('base64'),
      kek_iterations: params.wrappedPrivateKey.kekIterations,
      created_at: new Date().toISOString(),
    };
  }

  /**
   * Re-wrap an existing keypair with a freshly derived KEK. Used on
   * password change (future command).
   */
  static rewrapWithPassword(keypair: UserKeypair, password: string): EncryptedPrivateKey {
    return wrapPrivateKey(keypair.privateKey, password);
  }
}
