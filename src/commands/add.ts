import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { ConfigManager } from '../lib/config.js';

export function registerAddCommand(program: Command): void {
  const addCmd = program
    .command('add')
    .description('Add items to sync');

  // configsync add <folder> — smart detection
  addCmd
    .command('project <folder>')
    .description('Auto-detect git repo, .env files, and dotfiles in a project folder')
    .action(async (folder: string) => {
      const configManager = new ConfigManager();
      ensureInit(configManager);
      const config = configManager.load();

      const resolved = resolveHome(folder);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        console.error(chalk.red(`'${folder}' is not a directory.`));
        process.exit(1);
      }

      let added = 0;

      // Detect git repo
      if (fs.existsSync(path.join(resolved, '.git'))) {
        try {
          const url = execSync('git remote get-url origin', {
            cwd: resolved, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
          const branch = execSync('git branch --show-current', {
            cwd: resolved, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();

          if (!config.repos.find(r => r.url === url)) {
            config.repos.push({ url, path: folder, branch: branch || 'main', auto_pull: true });
            console.log(chalk.green(`  + repo: ${url} (${branch || 'main'})`));
            added++;
          } else {
            console.log(chalk.dim(`  - repo already tracked: ${url}`));
          }
        } catch {
          console.log(chalk.yellow('  - git repo detected but no remote origin'));
        }
      }

      // Files that contain secrets — always encrypt
      const sensitiveFiles = [
        '.env', '.env.local', '.env.development', '.env.production', '.env.staging', '.env.test',
        '.dev.vars',        // Cloudflare Workers secrets
        '.mcp.json',        // MCP server configs (may contain tokens)
      ];

      for (const name of sensitiveFiles) {
        const filePath = path.join(resolved, name);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const alreadyTracked = config.env_files.find(
            e => resolveHome(e.project_path) === resolved && e.filename === name
          ) || config.configs.find(c => c.source === path.join(folder, name));
          if (!alreadyTracked) {
            config.env_files.push({ project_path: folder, filename: name, encrypt: true });
            console.log(chalk.green(`  + secret: ${name} (encrypted)`));
            added++;
          } else {
            console.log(chalk.dim(`  - already tracked: ${name}`));
          }
        }
      }

      // Files/dirs to skip entirely (build artifacts, caches, IDE config)
      const ignoreList = new Set([
        '.git', '.DS_Store', '.gitignore', '.gitattributes', '.gitmodules',
        '.node_modules', '.next', '.vscode', '.idea', '.turbo',
        '.wrangler', '.open-next', '.vercel', '.netlify',
        '.build-trigger', '.trigger-deploy',
        '.cache', '.parcel-cache', '.eslintcache',
        // Sensitive files handled above
        ...sensitiveFiles,
      ]);

      // Also skip files matching common cache/build patterns
      const ignorePatterns = [
        /^\.tool-/,         // .tool-build-cache.json, .tool-deploy-cache.json, etc.
        /^\.qa-/,           // .qa-checkpoint.json, etc.
        /-cache\.json$/,
        /-trigger$/,
      ];

      // Detect dotfiles/config files worth syncing
      const dotfiles = fs.readdirSync(resolved).filter(f => {
        if (!f.startsWith('.')) return false;
        if (ignoreList.has(f)) return false;
        if (ignorePatterns.some(p => p.test(f))) return false;
        const full = path.join(resolved, f);
        return fs.statSync(full).isFile();
      });

      for (const dotfile of dotfiles) {
        const dotPath = path.join(folder, dotfile);
        if (!config.configs.find(c => c.source === dotPath)) {
          config.configs.push({ source: dotPath });
          console.log(chalk.green(`  + config: ${dotfile}`));
          added++;
        }
      }

      if (added > 0) {
        configManager.save(config);
        console.log(chalk.green(`\nAdded ${added} item${added !== 1 ? 's' : ''} from ${folder}`));
      } else {
        console.log(chalk.dim('\nNothing new to add.'));
      }
    });

  // configsync add config <path>
  addCmd
    .command('config <path>')
    .description('Add a config file to sync (e.g. ~/.zshrc)')
    .option('--encrypt', 'encrypt this config item', false)
    .option('--exclude <pattern>', 'exclude pattern (can be repeated)', collectPatterns, [])
    .action(async (filePath: string, options: { encrypt: boolean; exclude: string[] }) => {
      const configManager = new ConfigManager();
      ensureInit(configManager);
      const config = configManager.load();

      if (config.configs.find((c) => c.source === filePath)) {
        console.error(chalk.red(`'${filePath}' is already tracked.`));
        process.exit(1);
      }

      const item: { source: string; encrypt?: boolean; exclude_patterns?: string[] } = {
        source: filePath,
      };
      if (options.encrypt) item.encrypt = true;
      if (options.exclude.length > 0) item.exclude_patterns = options.exclude;

      config.configs.push(item);
      configManager.save(config);

      const resolved = filePath.replace(/^~/, os.homedir());
      const exists = fs.existsSync(resolved);
      console.log(chalk.green(`Added config: ${filePath}`));
      if (!exists) console.log(chalk.yellow(`  Warning: file does not exist yet at ${resolved}`));
      if (options.encrypt) console.log(chalk.dim('  (will be encrypted)'));
    });

  // configsync add repo <url> <path>
  addCmd
    .command('repo <url> <localPath>')
    .description('Add a git repo to sync (tracks URL, branch, clone location)')
    .option('--branch <branch>', 'default branch', 'main')
    .option('--no-auto-pull', 'do not auto-pull on restore')
    .action(async (url: string, localPath: string, options: { branch: string; autoPull: boolean }) => {
      const configManager = new ConfigManager();
      ensureInit(configManager);
      const config = configManager.load();

      // Resolve the local path for display
      const resolved = localPath.replace(/^~/, os.homedir());
      const absPath = path.resolve(resolved);

      if (config.repos.find((r) => r.url === url || r.path === localPath)) {
        console.error(chalk.red(`Repo '${url}' or path '${localPath}' is already tracked.`));
        process.exit(1);
      }

      config.repos.push({
        url,
        path: localPath,
        branch: options.branch,
        auto_pull: options.autoPull,
      });
      configManager.save(config);

      console.log(chalk.green(`Added repo: ${url}`));
      console.log(`  Path:   ${absPath}`);
      console.log(`  Branch: ${options.branch}`);
    });

  // configsync add env <projectPath>
  addCmd
    .command('env <projectPath>')
    .description('Add a .env file from a project to sync (encrypted by default)')
    .option('--filename <name>', 'env filename', '.env.local')
    .option('--no-encrypt', 'do not encrypt this env file')
    .action(async (projectPath: string, options: { filename: string; encrypt: boolean }) => {
      const configManager = new ConfigManager();
      ensureInit(configManager);
      const config = configManager.load();

      const resolved = projectPath.replace(/^~/, os.homedir());
      const absPath = path.resolve(resolved);
      const envFile = path.join(absPath, options.filename);

      if (config.env_files.find((e) => e.project_path === projectPath && e.filename === options.filename)) {
        console.error(chalk.red(`'${projectPath}/${options.filename}' is already tracked.`));
        process.exit(1);
      }

      config.env_files.push({
        project_path: projectPath,
        filename: options.filename,
        encrypt: options.encrypt,
      });
      configManager.save(config);

      const exists = fs.existsSync(envFile);
      console.log(chalk.green(`Added env file: ${projectPath}/${options.filename}`));
      if (!exists) console.log(chalk.yellow(`  Warning: ${envFile} does not exist yet`));
      if (options.encrypt) console.log(chalk.dim('  (will be encrypted)'));
    });
}

function resolveHome(p: string): string {
  return path.resolve(p.replace(/^~/, os.homedir()));
}

function ensureInit(configManager: ConfigManager): void {
  if (!configManager.exists()) {
    console.error(chalk.red("Error: Run 'configsync init' or 'configsync login' first."));
    process.exit(1);
  }
}

function collectPatterns(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}
