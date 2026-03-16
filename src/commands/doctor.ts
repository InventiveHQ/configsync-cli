import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { ConfigManager } from '../lib/config.js';
import CloudBackend from '../lib/cloud.js';

function pass(msg: string): void {
  console.log(`  ${chalk.green('✓')} ${msg}`);
}

function fail(msg: string, suggestion?: string): void {
  console.log(`  ${chalk.red('✗')} ${msg}`);
  if (suggestion) {
    console.log(`    ${chalk.dim(suggestion)}`);
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check the health of your ConfigSync installation')
    .action(async () => {
      console.log(chalk.bold('ConfigSync Doctor'));
      console.log();

      let allPassed = true;
      const configManager = new ConfigManager();

      // 1. Config exists
      if (configManager.exists()) {
        pass(`Config file found (${configManager.configFile})`);
      } else {
        fail('Config file not found', "Run: configsync init");
        allPassed = false;
        // Can't continue most checks without config
        printSummary(allPassed);
        return;
      }

      // 2. Crypto initialized
      const keyFile = path.join(configManager.configDir, '.key');
      const saltFile = path.join(configManager.configDir, '.salt');
      if (fs.existsSync(keyFile) && fs.existsSync(saltFile)) {
        pass('Encryption initialized');
      } else {
        fail('Encryption not initialized', "Run: configsync init");
        allPassed = false;
      }

      // 3. Backend configured
      const config = configManager.load();
      const backend = config.sync.backend;
      const isCloud = backend === 'cloud';

      if (!backend) {
        fail('No sync backend configured', "Run: configsync init");
        allPassed = false;
      } else if (isCloud) {
        const apiUrl = config.sync.config.api_url || 'https://configsync.dev';
        const apiKey = config.sync.config.api_key;

        if (!apiKey) {
          fail('Cloud backend configured but no API key set', "Run: configsync login --token <token>");
          allPassed = false;
        } else {
          pass(`Cloud backend configured (${apiUrl})`);
        }

        // 4. Token valid (cloud only)
        if (apiKey) {
          try {
            const cloud = new CloudBackend(apiUrl, apiKey);
            const valid = await cloud.verifyToken();
            if (valid) {
              pass('API token valid');
            } else {
              fail('API token invalid or expired', "Run: configsync login --token <new-token>");
              allPassed = false;
            }
          } catch {
            fail('Could not reach API to verify token', `Check your connection to ${apiUrl}`);
            allPassed = false;
          }

          // 5. Machine registered (cloud only)
          try {
            const cloud = new CloudBackend(apiUrl, apiKey);
            const machines = await cloud.listMachines();
            const thisMachine = machines.find(
              (m: any) => m.machine_id === cloud.generateMachineId()
            );
            if (thisMachine) {
              pass(`Machine registered (${thisMachine.name || thisMachine.machine_id})`);
            } else if (machines.length > 0) {
              pass(`${machines.length} machine(s) registered (this machine not yet registered)`);
            } else {
              fail('No machines registered', "Run: configsync push");
              allPassed = false;
            }
          } catch {
            fail('Could not list machines', "Run: configsync push to register this machine");
            allPassed = false;
          }
        }
      } else {
        pass(`${backend} backend configured`);
      }

      // 6. Tracked items
      const configCount = config.configs?.length ?? 0;
      const projectCount = config.projects?.length ?? 0;
      const groupCount = config.groups?.length ?? 0;
      const packageCount = config.packages?.reduce(
        (sum, p) => sum + p.packages.length, 0
      ) ?? 0;

      const parts: string[] = [];
      if (configCount > 0) parts.push(`${configCount} config${configCount !== 1 ? 's' : ''}`);
      if (projectCount > 0) parts.push(`${projectCount} project${projectCount !== 1 ? 's' : ''}`);
      if (groupCount > 0) parts.push(`${groupCount} group${groupCount !== 1 ? 's' : ''}`);
      if (packageCount > 0) parts.push(`${packageCount} package${packageCount !== 1 ? 's' : ''}`);

      if (parts.length > 0) {
        pass(`${parts.join(', ')} tracked`);
      } else {
        fail('No items tracked', "Run: configsync add config <path>");
        allPassed = false;
      }

      // 7. Git available
      try {
        const gitVersion = execSync('git --version', { encoding: 'utf-8' }).trim();
        const match = gitVersion.match(/(\d+\.\d+\.\d+)/);
        if (match) {
          pass(`Git available (${match[1]})`);
        } else {
          pass('Git available');
        }
      } catch {
        fail('Git not found in PATH', "Install git: https://git-scm.com");
        allPassed = false;
      }

      // 8. Node version
      const nodeVersion = process.version;
      const majorMatch = nodeVersion.match(/^v(\d+)/);
      const major = majorMatch ? parseInt(majorMatch[1], 10) : 0;
      if (major >= 18) {
        pass(`Node.js ${nodeVersion} (>= 18 required)`);
      } else {
        fail(`Node.js ${nodeVersion} is too old (>= 18 required)`, "Upgrade Node.js: https://nodejs.org");
        allPassed = false;
      }

      console.log();
      printSummary(allPassed);
    });
}

function printSummary(allPassed: boolean): void {
  if (allPassed) {
    console.log(chalk.green('All checks passed!'));
  } else {
    console.log(chalk.red('Some checks failed. See suggestions above.'));
  }
}
