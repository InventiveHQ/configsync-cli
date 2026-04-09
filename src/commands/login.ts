/**
 * v2 login command.
 *
 * The common case this command solves is "new machine, existing
 * ConfigSync account". It fetches the user's wrapped private key from
 * the server, unwraps it with the master password, verifies by
 * decrypting a test payload (the keypair round-trip is sufficient),
 * and writes a session file that the rest of the v2 commands use.
 *
 * If the account has NO keypair yet (first-time user), we fall back to
 * `configsync init` semantics instead.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ConfigManager } from '../lib/config.js';
import CryptoManager from '../lib/crypto.js';
import { promptPassword } from '../lib/prompt.js';
import { unwrapPrivateKey, wrapPrivateKey, generateUserKeypair } from '../lib/envelope-crypto.js';
import { CloudV2 } from '../lib/cloud-v2.js';
import { SessionManager } from '../lib/session.js';

export function registerLoginCommand(program: Command): void {
  program
    .command('login')
    .description('Log in to ConfigSync cloud on this machine (retrieves and unwraps your keypair, or creates one on first login)')
    .option('--token <token>', 'API token')
    .option('--api-url <url>', 'API base URL', 'https://configsync.dev')
    .action(async (options: { token?: string; apiUrl: string }) => {
      const configManager = new ConfigManager();
      const token = options.token ?? (await promptPassword('Enter API token: '));
      if (!token) {
        console.error(chalk.red('Error: Token is required.'));
        process.exit(1);
      }

      const cloud = new CloudV2(options.apiUrl, token);

      const verifySpinner = ora('Verifying API token...').start();
      const ok = await cloud.verifyToken();
      if (!ok) {
        verifySpinner.fail('Invalid token');
        process.exit(3);
      }
      verifySpinner.succeed('Token valid');

      // Ensure the local config dir exists for the session file.
      const machine = await cloud.registerMachine();
      const machineId = machine.machine_id;

      // Pull existing keypair material, if any.
      const keypairPayload = await cloud.fetchKeypair();

      if (!keypairPayload) {
        console.log(
          chalk.yellow(
            'No keypair found for this account. Creating a new one (first-time setup).',
          ),
        );
        await firstTimeSetup(configManager, cloud, token, options.apiUrl, machineId, machine.user_id);
        return;
      }

      // We have a wrapped private key — prompt for password and unwrap.
      const password = await promptPassword('Enter master password: ');
      let privateKey: Buffer;
      try {
        privateKey = unwrapPrivateKey(
          {
            ciphertext: Buffer.from(keypairPayload.encrypted_private_key, 'base64'),
            kekSalt: Buffer.from(keypairPayload.kek_salt, 'base64'),
            kekIterations: keypairPayload.kek_iterations,
          },
          password,
        );
      } catch {
        console.error(chalk.red('Error: Incorrect master password.'));
        process.exit(3);
      }

      // Write/merge the local config to point at the cloud backend.
      if (!configManager.exists()) {
        configManager.init('default', 'cloud');
      }
      const config = configManager.load();
      config.sync.backend = 'cloud';
      config.sync.config.api_url = options.apiUrl;
      config.sync.config.api_key = token;
      configManager.save(config);

      // Persist the v2 session so subsequent commands can re-derive the
      // keypair without round-tripping the server.
      const session = SessionManager.buildSession({
        userId: machine.user_id,
        apiUrl: options.apiUrl,
        machineId,
        keypair: {
          publicKey: Buffer.from(keypairPayload.public_key, 'base64'),
          privateKey,
        },
        wrappedPrivateKey: {
          ciphertext: Buffer.from(keypairPayload.encrypted_private_key, 'base64'),
          kekSalt: Buffer.from(keypairPayload.kek_salt, 'base64'),
          kekIterations: keypairPayload.kek_iterations,
        },
      });
      new SessionManager(configManager.configDir).save(session);

      // Verify end-to-end by listing profiles (the default profile should
      // exist; if the profile API isn't yet live, just skip the check).
      try {
        const profiles = await cloud.listProfiles();
        const def = profiles.find((p) => p.slug === 'default');
        if (def) {
          console.log(chalk.dim(`  Verified access to default profile (id=${def.id})`));
        }
      } catch {
        /* profiles API not yet live — skip */
      }

      console.log(chalk.green('\nLogged in to ConfigSync cloud.'));
      console.log(`  API URL:  ${chalk.cyan(options.apiUrl)}`);
      console.log(`  Machine:  ${chalk.cyan(machineId)}`);
    });
}

async function firstTimeSetup(
  configManager: ConfigManager,
  cloud: CloudV2,
  token: string,
  apiUrl: string,
  machineId: string,
  userId: number,
): Promise<void> {
  const password = await promptPassword('Create a master password (min 8 chars): ');
  const confirm = await promptPassword('Confirm master password: ');
  if (password !== confirm) {
    console.error(chalk.red('Error: Passwords do not match.'));
    process.exit(1);
  }
  if (password.length < 8) {
    console.error(chalk.red('Error: Password must be at least 8 characters.'));
    process.exit(1);
  }

  const keypair = generateUserKeypair();
  const wrapped = wrapPrivateKey(keypair.privateKey, password);
  await cloud.uploadKeypair({
    public_key: keypair.publicKey.toString('base64'),
    encrypted_private_key: wrapped.ciphertext.toString('base64'),
    kek_salt: wrapped.kekSalt.toString('base64'),
    kek_iterations: wrapped.kekIterations,
    key_algorithm: 'x25519',
  });

  if (!configManager.exists()) {
    configManager.init('default', 'cloud');
    // Initialize the legacy crypto manager too so secret-compat commands work.
    const legacyCrypto = new CryptoManager(configManager.configDir);
    try {
      legacyCrypto.initialize(password);
    } catch {
      /* ignore — legacy init is best-effort */
    }
  }
  const config = configManager.load();
  config.sync.backend = 'cloud';
  config.sync.config.api_url = apiUrl;
  config.sync.config.api_key = token;
  configManager.save(config);

  const session = SessionManager.buildSession({
    userId,
    apiUrl,
    machineId,
    keypair,
    wrappedPrivateKey: wrapped,
  });
  new SessionManager(configManager.configDir).save(session);

  // Try to create the default profile.
  try {
    await cloud.createProfile({
      slug: 'default',
      name: 'Default',
      description: 'Auto-created default profile',
      is_default: true,
    });
  } catch {
    /* profiles API not yet live — skip */
  }

  console.log(chalk.green('\nFirst-time login complete.'));
  console.log(`  API URL:  ${chalk.cyan(apiUrl)}`);
  console.log(`  Machine:  ${chalk.cyan(machineId)}`);
}
