/**
 * Package diffing between local and remote machines.
 */
import chalk from 'chalk';
import { PackageManager } from './packages.js';
import { PackageList } from './config.js';

export interface PackageMapping {
  canonical: string;
  packages: Record<string, string>;
}

export interface PackageDiff {
  missing: Map<string, string[]>;   // manager -> package names missing locally
  extra: Map<string, string[]>;     // manager -> packages only on local
  matched: number;
  unmappable: string[];             // remote packages with no local manager available
}

export function diffPackages(
  local: PackageManager[],
  remote: PackageList[],
  mappings: PackageMapping[]
): PackageDiff {
  const diff: PackageDiff = {
    missing: new Map(),
    extra: new Map(),
    matched: 0,
    unmappable: [],
  };

  // Build local package sets keyed by manager name
  const localByManager = new Map<string, Set<string>>();
  const localManagerNames = new Set<string>();
  for (const mgr of local) {
    localManagerNames.add(mgr.name);
    const pkgSet = new Set<string>();
    for (const p of mgr.packages) {
      // Packages are stored as "manager:name", extract the name part
      const colonIdx = p.indexOf(':');
      const name = colonIdx >= 0 ? p.slice(colonIdx + 1) : p;
      pkgSet.add(name);
    }
    localByManager.set(mgr.name, pkgSet);
  }

  // Build canonical lookup: canonical -> { manager -> packageName }
  const canonicalMap = new Map<string, Record<string, string>>();
  for (const mapping of mappings) {
    canonicalMap.set(mapping.canonical, mapping.packages);
  }

  // Reverse lookup: "manager:packageName" -> canonical
  const reverseMap = new Map<string, string>();
  for (const mapping of mappings) {
    for (const [mgr, pkg] of Object.entries(mapping.packages)) {
      reverseMap.set(`${mgr}:${pkg}`, mapping.canonical);
    }
  }

  // Track which local packages are accounted for
  const matchedLocal = new Map<string, Set<string>>();
  for (const mgr of local) {
    matchedLocal.set(mgr.name, new Set());
  }

  // Check each remote package
  for (const remoteMgr of remote) {
    for (const pkg of remoteMgr.packages) {
      const colonIdx = pkg.indexOf(':');
      const remoteManager = colonIdx >= 0 ? pkg.slice(0, colonIdx) : remoteMgr.manager;
      const remoteName = colonIdx >= 0 ? pkg.slice(colonIdx + 1) : pkg;

      // Direct match: same manager exists locally and has the package
      const localSet = localByManager.get(remoteManager);
      if (localSet && localSet.has(remoteName)) {
        diff.matched++;
        matchedLocal.get(remoteManager)?.add(remoteName);
        continue;
      }

      // Check mappings for cross-platform equivalent
      const canonical = reverseMap.get(`${remoteManager}:${remoteName}`);
      if (canonical) {
        const equivalents = canonicalMap.get(canonical)!;
        let found = false;

        // Look for equivalent in any available local manager
        for (const [mgrName, equivPkg] of Object.entries(equivalents)) {
          const mgrSet = localByManager.get(mgrName);
          if (mgrSet && mgrSet.has(equivPkg)) {
            diff.matched++;
            matchedLocal.get(mgrName)?.add(equivPkg);
            found = true;
            break;
          }
        }

        if (!found) {
          // Find a local manager that could install the equivalent
          let added = false;
          for (const [mgrName, equivPkg] of Object.entries(equivalents)) {
            if (localManagerNames.has(mgrName)) {
              if (!diff.missing.has(mgrName)) diff.missing.set(mgrName, []);
              diff.missing.get(mgrName)!.push(equivPkg);
              added = true;
              break;
            }
          }
          if (!added) {
            diff.unmappable.push(`${remoteManager}:${remoteName}`);
          }
        }
        continue;
      }

      // No mapping — check if the manager exists locally
      if (localManagerNames.has(remoteManager)) {
        if (!diff.missing.has(remoteManager)) diff.missing.set(remoteManager, []);
        diff.missing.get(remoteManager)!.push(remoteName);
      } else {
        diff.unmappable.push(`${remoteManager}:${remoteName}`);
      }
    }
  }

  // Find extra packages: local packages not in remote
  const remoteByManager = new Map<string, Set<string>>();
  for (const remoteMgr of remote) {
    for (const pkg of remoteMgr.packages) {
      const colonIdx = pkg.indexOf(':');
      const manager = colonIdx >= 0 ? pkg.slice(0, colonIdx) : remoteMgr.manager;
      const name = colonIdx >= 0 ? pkg.slice(colonIdx + 1) : pkg;
      if (!remoteByManager.has(manager)) remoteByManager.set(manager, new Set());
      remoteByManager.get(manager)!.add(name);
    }
  }

  for (const mgr of local) {
    const remoteSet = remoteByManager.get(mgr.name) || new Set();
    const extras: string[] = [];
    for (const pkg of mgr.packages) {
      const colonIdx = pkg.indexOf(':');
      const name = colonIdx >= 0 ? pkg.slice(colonIdx + 1) : pkg;
      if (!remoteSet.has(name)) {
        // Also check if it's matched via mapping
        if (!matchedLocal.get(mgr.name)?.has(name)) {
          extras.push(name);
        }
      }
    }
    if (extras.length > 0) {
      diff.extra.set(mgr.name, extras);
    }
  }

  return diff;
}

export function formatDiff(diff: PackageDiff): string {
  const lines: string[] = [];

  lines.push(chalk.bold('Package Diff'));
  lines.push('');

  // Matched
  lines.push(chalk.green(`  ✓ ${diff.matched} packages matched`));

  // Missing
  let totalMissing = 0;
  for (const [manager, packages] of diff.missing) {
    totalMissing += packages.length;
  }
  if (totalMissing > 0) {
    lines.push('');
    lines.push(chalk.yellow(`  ✗ ${totalMissing} packages missing locally:`));
    for (const [manager, packages] of diff.missing) {
      for (const pkg of packages) {
        lines.push(chalk.yellow(`    ${manager}:${pkg}`));
      }
    }
  }

  // Extra
  let totalExtra = 0;
  for (const [manager, packages] of diff.extra) {
    totalExtra += packages.length;
  }
  if (totalExtra > 0) {
    lines.push('');
    lines.push(chalk.blue(`  + ${totalExtra} packages only on this machine:`));
    for (const [manager, packages] of diff.extra) {
      for (const pkg of packages) {
        lines.push(chalk.blue(`    ${manager}:${pkg}`));
      }
    }
  }

  // Unmappable
  if (diff.unmappable.length > 0) {
    lines.push('');
    lines.push(chalk.dim(`  ? ${diff.unmappable.length} packages could not be mapped:`));
    for (const pkg of diff.unmappable) {
      lines.push(chalk.dim(`    ${pkg}`));
    }
  }

  return lines.join('\n');
}
