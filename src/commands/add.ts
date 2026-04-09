import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { ConfigManager, ProjectConfig, GroupConfig, ModuleConfig } from '../lib/config.js';
import { listModules, getModule, getAvailableModuleNames } from '../lib/modules.js';
import { addProject } from './project.js';
import { mutateWorkspaceProjectList } from './workspace.js';
import { SessionManager } from '../lib/session.js';
import CloudV2 from '../lib/cloud-v2.js';
import { promptPassword } from '../lib/prompt.js';
import { slugify } from '../lib/git-info.js';

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

      const projectName = path.basename(resolved);
      // Always store absolute path so ./  doesn't collide across directories
      const storedPath = resolved.startsWith(os.homedir())
        ? '~' + resolved.slice(os.homedir().length)
        : resolved;

      // Check if project already exists by path
      if (!config.projects) config.projects = [];
      const existing = config.projects.find(p => resolveHome(p.path) === resolved);
      if (existing) {
        console.error(chalk.red(`Project '${existing.name}' already tracked at ${existing.path}`));
        process.exit(1);
      }

      const project: ProjectConfig = {
        name: projectName,
        path: storedPath,
        secrets: [],
        configs: [],
      };

      // Detect git repo
      if (fs.existsSync(path.join(resolved, '.git'))) {
        try {
          const url = execSync('git remote get-url origin', {
            cwd: resolved, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
          const branch = execSync('git branch --show-current', {
            cwd: resolved, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();

          project.repo = { url, branch: branch || 'main' };
          console.log(chalk.green(`  + repo: ${url} (${branch || 'main'})`));
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
          project.secrets.push(name);
          console.log(chalk.green(`  + secret: ${name} (encrypted)`));
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
        project.configs.push(dotfile);
        console.log(chalk.green(`  + config: ${dotfile}`));
      }

      const totalItems = (project.repo ? 1 : 0) + project.secrets.length + project.configs.length;

      if (totalItems > 0) {
        config.projects.push(project);
        configManager.save(config);
        console.log(chalk.green(`\nAdded project '${projectName}' with ${totalItems} item${totalItems !== 1 ? 's' : ''}`));
      } else {
        console.log(chalk.dim('\nNothing found to track in this folder.'));
      }
    });

  // configsync add workspace <folder> — bulk-add a folder of git repos as a v2 workspace
  addCmd
    .command('workspace <folder>')
    .description('Scan a folder for git repos, add each as a project, and group them into a v2 workspace')
    .option('-n, --name <name>', 'workspace name (defaults to folder basename)')
    .action(async (folder: string, options: { name?: string }) => {
      const resolved = resolveHome(folder);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        console.error(chalk.red(`'${folder}' is not a directory.`));
        process.exit(1);
      }

      const configManager = new ConfigManager();
      const sessionMgr = new SessionManager(configManager.configDir);
      if (!sessionMgr.exists()) {
        console.error(chalk.red("No v2 session. Run 'configsync login' first."));
        process.exit(1);
      }

      // Find subfolders that are git repos
      const subdirs = fs
        .readdirSync(resolved, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => path.join(resolved, d.name))
        .filter((p) => fs.existsSync(path.join(p, '.git')));

      if (subdirs.length === 0) {
        console.error(chalk.red(`No git repos found in '${folder}'.`));
        console.error(chalk.dim('Each subfolder must contain a .git directory.'));
        process.exit(1);
      }

      const workspaceName = options.name ?? path.basename(resolved);
      const workspaceSlug = slugify(workspaceName);

      console.log(chalk.bold(`Workspace: ${workspaceName}`));
      console.log(chalk.dim(`Found ${subdirs.length} git repo${subdirs.length !== 1 ? 's' : ''}`));
      console.log();

      // Prompt for password ONCE; subsequent addProject calls reuse it via env var.
      // (passwordFromEnv() in prompt.ts honors CONFIGSYNC_MASTER_PASSWORD.)
      const password = await promptPassword('Enter master password: ');
      const hadEnvPassword = process.env.CONFIGSYNC_MASTER_PASSWORD !== undefined;
      process.env.CONFIGSYNC_MASTER_PASSWORD = password;

      try {
        // Step 1: add each subfolder as a project
        const projectSlugs: string[] = [];
        const projectIds: number[] = [];
        for (const subdir of subdirs) {
          console.log(chalk.cyan(`\n→ ${path.basename(subdir)}`));
          try {
            const project = await addProject(subdir, {});
            projectSlugs.push(project.slug);
            projectIds.push(project.id);
          } catch (err: any) {
            console.error(chalk.red(`  Failed: ${err.message}`));
          }
        }

        if (projectIds.length === 0) {
          console.error(chalk.red('\nNo projects were added; not creating workspace.'));
          process.exit(1);
        }

        // Step 2: create the workspace entity
        console.log(chalk.cyan(`\n→ Creating workspace '${workspaceSlug}'`));
        const apiUrl = configManager.load().sync.config.api_url as string;
        const apiKey = configManager.load().sync.config.api_key as string;
        const machineId = sessionMgr.load().machine_id;
        const cloud = new CloudV2(apiUrl, apiKey, machineId);

        const existing = await cloud.listWorkspaces();
        const match = existing.find((w: any) => w.slug === workspaceSlug);
        if (match) {
          console.log(chalk.dim(`  Reusing existing workspace '${workspaceSlug}'`));
        } else {
          const ws = await cloud.createWorkspace({ slug: workspaceSlug, name: workspaceName });
          console.log(chalk.green(`  Created workspace '${workspaceSlug}' (id=${ws.id})`));
        }

        // Step 3: link each project to the workspace via the encrypted blob
        console.log(chalk.cyan(`\n→ Linking ${projectSlugs.length} projects to workspace`));
        for (const slug of projectSlugs) {
          try {
            await mutateWorkspaceProjectList(workspaceSlug, slug, 'add');
            console.log(chalk.dim(`  ${slug}`));
          } catch (err: any) {
            console.log(chalk.dim(`  ${slug} (skipped: ${err.message})`));
          }
        }

        console.log(chalk.green.bold(`\n✓ Workspace '${workspaceSlug}' ready with ${projectIds.length} projects`));
        console.log(chalk.dim(`\nOn another machine: configsync pull --workspace ${workspaceSlug}`));
      } finally {
        if (!hadEnvPassword) delete process.env.CONFIGSYNC_MASTER_PASSWORD;
      }
    });

  // configsync add group <folder> — scan all subfolders as projects
  addCmd
    .command('group <folder>')
    .description('DEPRECATED alias for `add workspace`. Use `add workspace` instead.')
    .action(async (folder: string) => {
      process.stderr.write(
        '\x1b[33mwarning:\x1b[0m `configsync add group` is deprecated. ' +
          'Use `configsync add workspace` instead.\n',
      );
      const configManager = new ConfigManager();
      ensureInit(configManager);
      const config = configManager.load();

      const resolved = resolveHome(folder);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        console.error(chalk.red(`'${folder}' is not a directory.`));
        process.exit(1);
      }

      const groupName = path.basename(resolved);
      const storedGroupPath = resolved.startsWith(os.homedir())
        ? '~' + resolved.slice(os.homedir().length)
        : resolved;

      if (!config.groups) config.groups = [];
      const existingGroup = config.groups.find(g => resolveHome(g.path) === resolved);
      if (existingGroup) {
        console.error(chalk.red(`Group '${existingGroup.name}' already tracked at ${existingGroup.path}`));
        process.exit(1);
      }

      const group: GroupConfig = {
        name: groupName,
        path: storedGroupPath,
        projects: [],
      };

      // Scan each subdirectory
      const subdirs = fs.readdirSync(resolved).filter(f => {
        const full = path.join(resolved, f);
        return fs.statSync(full).isDirectory() && !f.startsWith('.') && f !== 'node_modules';
      });

      console.log(chalk.bold(`Scanning ${groupName}/ (${subdirs.length} folders)...\n`));

      for (const subdir of subdirs) {
        const subPath = path.join(resolved, subdir);
        const storedSubPath = subPath.startsWith(os.homedir())
          ? '~' + subPath.slice(os.homedir().length)
          : subPath;

        // Only include folders that are git repos
        if (!fs.existsSync(path.join(subPath, '.git'))) {
          console.log(chalk.dim(`  - ${subdir}/ (not a git repo, skipping)`));
          continue;
        }

        const project: ProjectConfig = {
          name: subdir,
          path: storedSubPath,
          secrets: [],
          configs: [],
        };

        // Git info
        try {
          const url = execSync('git remote get-url origin', {
            cwd: subPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
          const branch = execSync('git branch --show-current', {
            cwd: subPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
          project.repo = { url, branch: branch || 'main' };
        } catch {
          // No remote, still track the folder
        }

        // Scan for secrets
        const sensitiveFiles = [
          '.env', '.env.local', '.env.development', '.env.production', '.env.staging', '.env.test',
          '.dev.vars', '.mcp.json',
        ];
        for (const name of sensitiveFiles) {
          if (fs.existsSync(path.join(subPath, name))) {
            project.secrets.push(name);
          }
        }

        // Scan for dotfiles
        const ignoreList = new Set([
          '.git', '.DS_Store', '.gitignore', '.gitattributes', '.gitmodules',
          '.node_modules', '.next', '.vscode', '.idea', '.turbo',
          '.wrangler', '.open-next', '.vercel', '.netlify',
          '.build-trigger', '.trigger-deploy',
          '.cache', '.parcel-cache', '.eslintcache',
          ...sensitiveFiles,
        ]);
        const ignorePatterns = [/^\.tool-/, /^\.qa-/, /-cache\.json$/, /-trigger$/];

        const dotfiles = fs.readdirSync(subPath).filter(f => {
          if (!f.startsWith('.')) return false;
          if (ignoreList.has(f)) return false;
          if (ignorePatterns.some(p => p.test(f))) return false;
          return fs.statSync(path.join(subPath, f)).isFile();
        });
        project.configs = dotfiles;

        group.projects.push(project);

        const repoLabel = project.repo ? chalk.dim(` (${project.repo.url.split('/').pop()?.replace('.git', '')})`) : '';
        const itemCount = (project.repo ? 1 : 0) + project.secrets.length + project.configs.length;
        console.log(chalk.green(`  + ${subdir}/${repoLabel} — ${itemCount} items`));
        if (project.secrets.length > 0) {
          console.log(chalk.dim(`      secrets: ${project.secrets.join(', ')}`));
        }
      }

      if (group.projects.length > 0) {
        config.groups.push(group);
        configManager.save(config);
        console.log(chalk.green(`\nAdded group '${groupName}' with ${group.projects.length} project${group.projects.length !== 1 ? 's' : ''}`));
      } else {
        console.log(chalk.yellow('\nNo git repos found in subdirectories.'));
      }
    });

  // configsync add module [name] — add a known tool module
  addCmd
    .command('module [name]')
    .description('Add a known tool module (ssh, vscode, claude-desktop, claude-code, git, zsh, vim, cursor)')
    .action(async (name?: string) => {
      const configManager = new ConfigManager();
      ensureInit(configManager);
      const config = configManager.load();
      if (!config.modules) config.modules = [];

      // If no name, show detected modules
      if (!name) {
        const allModules = listModules();
        const detected = allModules.filter(m => m.detected);
        const notDetected = allModules.filter(m => !m.detected);

        if (detected.length > 0) {
          console.log(chalk.bold('Detected on this machine:\n'));
          for (const m of detected) {
            const already = config.modules.find(cm => cm.name === m.name);
            const status = already ? chalk.dim(' (already added)') : '';
            console.log(`  ${chalk.green(m.displayName)}${status} — ${m.description}`);
            console.log(chalk.dim(`    configsync add module ${m.name}`));
            if (m.files.length > 0) {
              console.log(chalk.dim(`    ${m.files.length} files found`));
            }
            console.log('');
          }
        }

        if (notDetected.length > 0) {
          console.log(chalk.dim('Not detected:'));
          for (const m of notDetected) {
            console.log(chalk.dim(`  ${m.displayName} — ${m.description}`));
          }
        }
        return;
      }

      // Add specific module
      const mod = getModule(name);
      if (!mod) {
        console.error(chalk.red(`Unknown module '${name}'.`));
        console.log(chalk.dim(`Available: ${getAvailableModuleNames().join(', ')}`));
        process.exit(1);
      }

      if (!mod.detected) {
        console.error(chalk.yellow(`${mod.displayName} not detected on this machine.`));
        process.exit(1);
      }

      if (config.modules.find(m => m.name === mod.name)) {
        console.error(chalk.red(`Module '${mod.displayName}' is already added.`));
        process.exit(1);
      }

      const existingFiles = mod.files.filter(f => f.exists);

      const moduleConfig: ModuleConfig = {
        name: mod.name,
        files: existingFiles.map(f => ({ path: f.relative, encrypt: f.encrypt })),
      };

      if (mod.extras) {
        moduleConfig.extras = mod.extras;
      }

      config.modules.push(moduleConfig);
      configManager.save(config);

      console.log(chalk.green(`Added module: ${mod.displayName}\n`));
      for (const f of existingFiles) {
        const icon = f.encrypt ? '🔒' : '📄';
        console.log(`  ${icon} ${f.relative}`);
      }
      if (mod.extras?.extensions) {
        console.log(`\n  ${chalk.dim(`${mod.extras.extensions.length} VS Code extensions tracked`)}`);
      }
      console.log(chalk.dim(`\n${existingFiles.length} files will be synced.`));
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

  // configsync add env-var <name> — track a specific environment variable
  addCmd
    .command('env-var [name]')
    .description('Track an environment variable (or list detected dev vars)')
    .action(async (name?: string) => {
      const configManager = new ConfigManager();
      ensureInit(configManager);
      const config = configManager.load();
      if (!config.env_vars) config.env_vars = [];

      if (!name) {
        // Show detected dev vars
        const { detectDevEnvVars } = await import('../lib/envvars.js');
        const detected = detectDevEnvVars();

        if (detected.length === 0) {
          console.log(chalk.dim('No common dev environment variables detected.'));
          return;
        }

        console.log(chalk.bold('Detected dev environment variables:\n'));
        for (const v of detected) {
          const tracked = config.env_vars.includes(v.name);
          const status = tracked ? chalk.dim(' (tracked)') : '';
          const val = v.value.length > 50 ? v.value.slice(0, 50) + '...' : v.value;
          console.log(`  ${chalk.cyan(v.name)}${status}`);
          console.log(chalk.dim(`    = ${val}`));
        }
        console.log(chalk.dim(`\nTrack with: configsync add env-var <NAME>`));
        console.log(chalk.dim(`Track all:  configsync add env-var --all`));
        return;
      }

      // --all flag: add all detected dev vars
      if (name === '--all') {
        const { detectDevEnvVars } = await import('../lib/envvars.js');
        const detected = detectDevEnvVars();
        let added = 0;
        for (const v of detected) {
          if (!config.env_vars.includes(v.name)) {
            config.env_vars.push(v.name);
            console.log(chalk.green(`  + ${v.name}`));
            added++;
          }
        }
        if (added > 0) {
          configManager.save(config);
          console.log(chalk.green(`\nAdded ${added} environment variable${added !== 1 ? 's' : ''}`));
        } else {
          console.log(chalk.dim('All detected vars already tracked.'));
        }
        return;
      }

      // Add specific var
      if (config.env_vars.includes(name)) {
        console.error(chalk.red(`'${name}' is already tracked.`));
        process.exit(1);
      }

      config.env_vars.push(name);
      configManager.save(config);

      const value = process.env[name];
      console.log(chalk.green(`Added env var: ${name}`));
      if (value) {
        console.log(chalk.dim(`  Current value: ${value.length > 60 ? value.slice(0, 60) + '...' : value}`));
      } else {
        console.log(chalk.yellow(`  Warning: ${name} is not currently set in this shell`));
      }
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
