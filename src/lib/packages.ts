/**
 * Package manager detection and scanning.
 */
import { execSync } from 'node:child_process';
import os from 'node:os';

export interface PackageManager {
  name: string;
  displayName: string;
  available: boolean;
  packages: string[];
}

interface PackageManagerDef {
  name: string;
  displayName: string;
  checkCmd: string;
  listCmd: string;
  parseOutput: (output: string) => string[];
}

const managers: PackageManagerDef[] = [
  {
    name: 'brew',
    displayName: 'Homebrew',
    checkCmd: 'brew --version',
    // brew leaves = top-level formulas only (not dependencies)
    // brew list --cask = all casks (casks don't have deps)
    listCmd: 'brew leaves && echo "---CASKS---" && brew list --cask -1',
    parseOutput: (output) => {
      const [formulas, casks] = output.split('---CASKS---');
      const formulaList = (formulas || '').trim().split('\n').filter(Boolean).map(p => `brew:${p.trim()}`);
      const caskList = (casks || '').trim().split('\n').filter(Boolean).map(p => `brew-cask:${p.trim()}`);
      return [...formulaList, ...caskList];
    },
  },
  {
    name: 'apt',
    displayName: 'APT',
    checkCmd: 'apt --version',
    // apt-mark showmanual = explicitly installed, not pulled in as dependencies
    listCmd: 'apt-mark showmanual 2>/dev/null',
    parseOutput: (output) => {
      return output
        .split('\n')
        .filter(l => l.trim())
        .map(l => `apt:${l.trim()}`);
    },
  },
  {
    name: 'dnf',
    displayName: 'DNF',
    checkCmd: 'dnf --version',
    // --userinstalled = only packages the user explicitly installed
    listCmd: 'dnf repoquery --userinstalled --qf "%{name}" 2>/dev/null',
    parseOutput: (output) => {
      return output
        .split('\n')
        .filter(l => l.trim())
        .map(l => `dnf:${l.trim()}`);
    },
  },
  {
    name: 'winget',
    displayName: 'Winget',
    checkCmd: 'winget --version',
    listCmd: 'winget list --disable-interactivity',
    parseOutput: (output) => {
      const lines = output.split('\n');
      // Find the header separator line (dashes)
      const sepIdx = lines.findIndex(l => /^-{3,}/.test(l.trim()));
      if (sepIdx < 0) return [];
      return lines
        .slice(sepIdx + 1)
        .filter(l => l.trim())
        .map(l => {
          const id = l.trim().split(/\s{2,}/)[1] || l.trim().split(/\s+/)[0];
          return `winget:${id}`;
        })
        .filter(p => p !== 'winget:');
    },
  },
  {
    name: 'choco',
    displayName: 'Chocolatey',
    checkCmd: 'choco --version',
    listCmd: 'choco list --local-only --no-color',
    parseOutput: (output) => {
      return output
        .split('\n')
        .filter(l => l.trim() && !l.includes(' packages installed'))
        .map(l => `choco:${l.split(' ')[0].trim()}`)
        .filter(p => p !== 'choco:');
    },
  },
  {
    name: 'snap',
    displayName: 'Snap',
    checkCmd: 'snap --version',
    listCmd: 'snap list 2>/dev/null',
    parseOutput: (output) => {
      return output
        .split('\n')
        .slice(1) // skip header
        .filter(l => l.trim())
        .map(l => `snap:${l.split(/\s+/)[0]}`);
    },
  },
];

function cmdExists(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function detectPackageManagers(): string[] {
  return managers
    .filter(m => cmdExists(m.checkCmd))
    .map(m => m.displayName);
}

export function scanPackages(): PackageManager[] {
  const results: PackageManager[] = [];

  for (const mgr of managers) {
    const available = cmdExists(mgr.checkCmd);
    if (!available) continue;

    let packages: string[] = [];
    try {
      const output = execSync(mgr.listCmd, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000,
      });
      packages = mgr.parseOutput(output);
    } catch {
      // Command failed, skip
    }

    if (packages.length > 0) {
      results.push({
        name: mgr.name,
        displayName: mgr.displayName,
        available: true,
        packages,
      });
    }
  }

  return results;
}

export function formatPackageSummary(managers: PackageManager[]): string {
  const lines: string[] = [];
  for (const mgr of managers) {
    lines.push(`  ${mgr.displayName}: ${mgr.packages.length} packages`);
  }
  return lines.join('\n');
}
