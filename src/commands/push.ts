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

export function registerPushCommand(program: Command): void {
  program
    .command('push')
    .description('Push current state to sync backend')
    .option('-m, --message <msg>', 'message describing this snapshot')
    .action(async (options: { message?: string }) => {
      const configManager = new ConfigManager();

      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();

      const password = await promptPassword('Enter master password: ');
      const cryptoManager = new CryptoManager(configManager.configDir);
      cryptoManager.unlock(password);

      const spinner = ora('Pushing state...').start();

      try {
        // Capture config files
        const capturedConfigs: Record<string, any>[] = [];

        for (const item of config.configs) {
          const sourcePath = item.source.replace(/^~/, os.homedir());
          const resolvedPath = path.resolve(sourcePath);

          if (!fs.existsSync(resolvedPath)) {
            continue;
          }

          const stat = fs.statSync(resolvedPath);
          if (!stat.isFile()) {
            continue; // Skip directories for now
          }

          let content: Buffer = Buffer.from(fs.readFileSync(resolvedPath));

          if (item.encrypt) {
            content = Buffer.from(cryptoManager.encrypt(content));
          }

          capturedConfigs.push({
            source: item.source,
            content: content.toString('base64'),
            encrypted: !!item.encrypt,
          });
        }

        const state: Record<string, any> = {
          timestamp: new Date().toISOString(),
          message: options.message || '',
          configs: capturedConfigs,
          repos: [],
          env_files: [],
        };

        if (config.sync.backend === 'cloud') {
          const apiUrl = config.sync.config.api_url;
          const apiKey = config.sync.config.api_key;

          if (!apiUrl || !apiKey) {
            spinner.fail('Cloud backend not configured. Run "configsync login" first.');
            process.exit(1);
          }

          const backend = new CloudBackend(apiUrl, apiKey);
          await backend.registerMachine();
          await backend.push(state, cryptoManager);
        } else {
          // Local backend
          const stateFile = path.join(configManager.stateDir, 'state.json');
          fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
        }

        spinner.succeed(
          `State pushed successfully! (${capturedConfigs.length} config${capturedConfigs.length === 1 ? '' : 's'})`
        );
      } catch (err: any) {
        spinner.fail(`Push failed: ${err.message}`);
        process.exit(1);
      }
    });
}
