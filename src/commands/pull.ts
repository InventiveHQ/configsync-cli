import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ConfigManager } from '../lib/config.js';
import CryptoManager from '../lib/crypto.js';
import CloudBackend from '../lib/cloud.js';
import { promptPassword } from '../lib/prompt.js';

export function registerPullCommand(program: Command): void {
  program
    .command('pull')
    .description('Pull and restore state from sync backend')
    .option('--force', 'overwrite existing files without backup', false)
    .action(async (options: { force: boolean }) => {
      const configManager = new ConfigManager();

      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();

      const password = await promptPassword('Enter master password: ');
      const cryptoManager = new CryptoManager(configManager.configDir);
      cryptoManager.unlock(password);

      const spinner = ora('Pulling state...').start();

      try {
        let state: Record<string, any> | null = null;

        if (config.sync.backend === 'cloud') {
          const apiUrl = config.sync.config.api_url;
          const apiKey = config.sync.config.api_key;

          if (!apiUrl || !apiKey) {
            spinner.fail('Cloud backend not configured. Run "configsync login" first.');
            process.exit(1);
          }

          const backend = new CloudBackend(apiUrl, apiKey);
          state = await backend.pull(cryptoManager);
        } else {
          // Local backend
          const stateFile = path.join(configManager.stateDir, 'state.json');
          if (fs.existsSync(stateFile)) {
            const raw = fs.readFileSync(stateFile, 'utf-8');
            state = JSON.parse(raw);
          }
        }

        if (!state) {
          spinner.fail('No state found. Run "configsync push" first.');
          process.exit(1);
        }

        let restoredCount = 0;

        for (const entry of state.configs || []) {
          const sourcePath = (entry.source as string).replace(/^~/, os.homedir());
          const resolvedPath = path.resolve(sourcePath);

          // Backup existing file if not forcing
          if (fs.existsSync(resolvedPath) && !options.force) {
            const backupName = `${path.basename(resolvedPath)}.${Date.now()}.bak`;
            const backupPath = path.join(configManager.backupDir, backupName);
            fs.copyFileSync(resolvedPath, backupPath);
          }

          // Ensure parent directory exists
          fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

          // Decode content
          let content: Buffer = Buffer.from(entry.content, 'base64');

          // Decrypt if needed
          if (entry.encrypted) {
            content = Buffer.from(cryptoManager.decrypt(content));
          }

          fs.writeFileSync(resolvedPath, content);
          restoredCount++;
        }

        spinner.succeed(
          `State restored successfully! (${restoredCount} config${restoredCount === 1 ? '' : 's'})`
        );

        if (state.timestamp) {
          console.log(`  ${chalk.dim('Snapshot from:')} ${state.timestamp}`);
        }
        if (state.message) {
          console.log(`  ${chalk.dim('Message:')} ${state.message}`);
        }
      } catch (err: any) {
        spinner.fail(`Pull failed: ${err.message}`);
        process.exit(1);
      }
    });
}
