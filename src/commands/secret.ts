import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigManager } from '../lib/config.js';
import CryptoManager from '../lib/crypto.js';
import { promptPassword } from '../lib/prompt.js';

interface SecretsStore {
  [key: string]: string; // key -> encrypted base64 value
}

function loadSecrets(secretsFile: string): SecretsStore {
  if (!fs.existsSync(secretsFile)) {
    return {};
  }
  const raw = fs.readFileSync(secretsFile, 'utf-8');
  return JSON.parse(raw) as SecretsStore;
}

function saveSecrets(secretsFile: string, secrets: SecretsStore): void {
  fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2), { mode: 0o600 });
}

export function registerSecretCommand(program: Command): void {
  const secretCmd = program
    .command('secret')
    .description('Manage secrets');

  secretCmd
    .command('set <key>')
    .description('Set a secret value')
    .action(async (key: string) => {
      const configManager = new ConfigManager();

      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const password = await promptPassword('Enter master password: ');
      const cryptoManager = new CryptoManager(configManager.configDir);
      cryptoManager.unlock(password);

      const value = await promptPassword(`Enter value for '${key}': `);

      if (!value) {
        console.error(chalk.red('Error: Value cannot be empty.'));
        process.exit(1);
      }

      const secretsFile = path.join(configManager.configDir, 'secrets.enc');
      const secrets = loadSecrets(secretsFile);

      const encrypted = cryptoManager.encryptSecret(key, value);
      secrets[key] = encrypted;
      saveSecrets(secretsFile, secrets);

      console.log(chalk.green(`Secret '${key}' saved.`));
    });

  secretCmd
    .command('get <key>')
    .description('Get a secret value')
    .option('--show', 'display the secret value', false)
    .action(async (key: string, options: { show: boolean }) => {
      const configManager = new ConfigManager();

      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const password = await promptPassword('Enter master password: ');
      const cryptoManager = new CryptoManager(configManager.configDir);
      cryptoManager.unlock(password);

      const secretsFile = path.join(configManager.configDir, 'secrets.enc');
      const secrets = loadSecrets(secretsFile);

      if (!(key in secrets)) {
        console.error(chalk.red(`Error: Secret '${key}' not found.`));
        process.exit(1);
      }

      if (options.show) {
        const value = cryptoManager.decryptSecret(key, secrets[key]);
        console.log(value);
      } else {
        console.log(chalk.green(`Secret '${key}' exists.`));
      }
    });

  secretCmd
    .command('list')
    .description('List all stored secret keys')
    .action(async () => {
      const configManager = new ConfigManager();

      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const password = await promptPassword('Enter master password: ');
      const cryptoManager = new CryptoManager(configManager.configDir);
      cryptoManager.unlock(password);

      const secretsFile = path.join(configManager.configDir, 'secrets.enc');
      const secrets = loadSecrets(secretsFile);
      const keys = Object.keys(secrets);

      if (keys.length === 0) {
        console.log(chalk.yellow('No secrets stored.'));
        return;
      }

      console.log(chalk.bold(`Secrets (${keys.length}):`));
      for (const k of keys) {
        console.log(`  ${chalk.cyan(k)}`);
      }
    });
}
