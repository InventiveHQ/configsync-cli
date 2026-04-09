/**
 * v2 init command.
 *
 * Creates a brand new ConfigSync user identity on the server side:
 *
 *   1. Generate an X25519 keypair via envelope-crypto.ts.
 *   2. Wrap the private key with a KEK derived from the user's master
 *      password and upload it (with public_key + kek_salt + iterations)
 *      to POST /api/auth/keypair.
 *   3. Register this machine with the server so subsequent entity link
 *      rows have a machine to point at.
 *   4. Auto-create a `default` profile (POST /api/profiles) that later
 *      activates as the fallback profile on every machine.
 *   5. Persist a v2 session file + a cloud-backed config.yaml.
 *
 * The legacy `--sync-backend local` flow is preserved as a compat
 * fallback until the rest of the commands are rewritten.
 */

import { Command, Option } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ConfigManager } from '../lib/config.js';
import CryptoManager from '../lib/crypto.js';
import { promptPassword } from '../lib/prompt.js';
import {
  generateUserKeypair,
  wrapPrivateKey,
} from '../lib/envelope-crypto.js';
import { CloudV2 } from '../lib/cloud-v2.js';
import { SessionManager } from '../lib/session.js';

interface InitOptions {
  syncBackend: 'local' | 'cloud';
  profile: string;
  token?: string;
  apiUrl: string;
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize ConfigSync on this machine (cloud by default)')
    .addOption(
      new Option('--sync-backend <backend>', 'sync backend to use')
        .choices(['local', 'cloud'])
        .default('cloud'),
    )
    .option('--profile <name>', 'profile name', 'default')
    .option('--token <token>', 'API token (cloud backend only)')
    .option('--api-url <url>', 'API base URL', 'https://configsync.dev')
    .action(async (options: InitOptions) => {
      const configManager = new ConfigManager();

      if (configManager.exists()) {
        console.error(chalk.red('Error: ConfigSync is already initialized.'));
        console.error(chalk.yellow('Delete ~/.configsync to re-initialize.'));
        process.exit(1);
      }

      if (options.syncBackend === 'local') {
        await initLocal(configManager, options);
        return;
      }

      await initCloud(configManager, options);
    });
}

// ---------------------------------------------------------------------------
// Local (legacy) init
// ---------------------------------------------------------------------------

async function initLocal(configManager: ConfigManager, options: InitOptions): Promise<void> {
  const password = await promptPassword('Enter master password: ');
  const confirm = await promptPassword('Confirm master password: ');
  if (password !== confirm) {
    console.error(chalk.red('Error: Passwords do not match.'));
    process.exit(1);
  }
  if (password.length < 8) {
    console.error(chalk.red('Error: Password must be at least 8 characters.'));
    process.exit(1);
  }
  configManager.init(options.profile, 'local');
  const cryptoManager = new CryptoManager(configManager.configDir);
  cryptoManager.initialize(password);
  console.log(chalk.green('ConfigSync initialized (local backend).'));
  console.log(`  Profile:  ${chalk.cyan(options.profile)}`);
  console.log(`  Config:   ${chalk.dim(configManager.configDir)}`);
}

// ---------------------------------------------------------------------------
// Cloud init (v2)
// ---------------------------------------------------------------------------

async function initCloud(configManager: ConfigManager, options: InitOptions): Promise<void> {
  const token = options.token ?? (await promptPassword('Enter API token: '));
  if (!token) {
    console.error(chalk.red('Error: API token is required for cloud init.'));
    process.exit(1);
  }

  // 1. Verify the token is valid before we burn a password prompt.
  const cloud = new CloudV2(options.apiUrl, token);
  const verifySpinner = ora('Verifying API token...').start();
  const ok = await cloud.verifyToken();
  if (!ok) {
    verifySpinner.fail('Invalid API token');
    process.exit(3);
  }
  verifySpinner.succeed('Token valid');

  // 2. Require a fresh master password.
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

  // 3. Check whether this user already has a keypair on the server.
  //    If so, bail and tell them to use `configsync login` instead — init
  //    would clobber their existing wrapped private key.
  const existing = await cloud.fetchKeypair();
  if (existing) {
    console.error(
      chalk.red('Error: A keypair is already registered for this account.'),
    );
    console.error(
      chalk.yellow("Use 'configsync login' on this machine to reuse it."),
    );
    process.exit(1);
  }

  // 4. Generate keypair and wrap the private key.
  const keypairSpinner = ora('Generating X25519 keypair...').start();
  const keypair = generateUserKeypair();
  const wrapped = wrapPrivateKey(keypair.privateKey, password);
  keypairSpinner.succeed('Keypair generated');

  // 5. Upload keypair material to the server.
  const uploadSpinner = ora('Uploading wrapped private key...').start();
  await cloud.uploadKeypair({
    public_key: keypair.publicKey.toString('base64'),
    encrypted_private_key: wrapped.ciphertext.toString('base64'),
    kek_salt: wrapped.kekSalt.toString('base64'),
    kek_iterations: wrapped.kekIterations,
    key_algorithm: 'x25519',
  });
  uploadSpinner.succeed('Keypair uploaded');

  // 6. Register this machine with the server.
  const machine = await cloud.registerMachine();
  const machineId = machine.machine_id ?? CloudV2.generateMachineId();

  // 7. Auto-create the `default` profile if the profiles API is live.
  //    Wave 2 is landing this endpoint in parallel; guard against 404.
  let defaultProfileSlug: string | null = null;
  try {
    const profile = await cloud.createProfile({
      slug: 'default',
      name: 'Default',
      description: 'Auto-created default profile',
      is_default: true,
    });
    defaultProfileSlug = profile?.slug ?? 'default';
    console.log(chalk.green(`  Default profile created: ${defaultProfileSlug}`));
  } catch (err: any) {
    console.log(
      chalk.yellow(
        `  Skipped profile creation (${err.message ?? 'profiles API not yet available'})`,
      ),
    );
  }

  // 8. Write the v2 config.yaml and session file.
  const config = configManager.init(options.profile, 'cloud');
  config.sync.backend = 'cloud';
  config.sync.config.api_url = options.apiUrl;
  config.sync.config.api_key = token;
  configManager.save(config);

  const session = SessionManager.buildSession({
    userId: machine.user_id,
    apiUrl: options.apiUrl,
    machineId,
    keypair,
    wrappedPrivateKey: wrapped,
  });
  new SessionManager(configManager.configDir).save(session);

  console.log(chalk.green('\nConfigSync initialized (cloud backend).'));
  console.log(`  API URL:   ${chalk.cyan(options.apiUrl)}`);
  console.log(`  Machine:   ${chalk.cyan(machineId)}`);
  console.log(`  Config:    ${chalk.dim(configManager.configDir)}`);
  console.log(
    chalk.dim('\nNext steps:\n  configsync project add <path>\n  configsync sync'),
  );
}
