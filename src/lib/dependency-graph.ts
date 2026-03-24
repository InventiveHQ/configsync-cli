/**
 * Dependency graph for restore ordering.
 * Determines which categories can be restored in parallel vs sequentially.
 */

const RESTORE_DEPS: Record<string, string[]> = {
  configs: [],
  env_files: [],
  modules: [],
  packages: [],
  repos: ['modules'],
  projects: ['repos'],
  groups: ['repos'],
};

/**
 * Returns execution levels via topological sort.
 * Items at the same level can run in parallel.
 * Each level must complete before the next begins.
 *
 * Result: [['configs', 'env_files', 'modules', 'packages'], ['repos'], ['projects', 'groups']]
 */
export function getRestoreLevels(): string[][] {
  const resolved = new Set<string>();
  const levels: string[][] = [];
  const remaining = new Set(Object.keys(RESTORE_DEPS));

  while (remaining.size > 0) {
    const level: string[] = [];

    for (const node of remaining) {
      const deps = RESTORE_DEPS[node] || [];
      if (deps.every(dep => resolved.has(dep))) {
        level.push(node);
      }
    }

    if (level.length === 0) {
      // Circular dependency — shouldn't happen, but break to avoid infinite loop
      level.push(...remaining);
      remaining.clear();
    }

    for (const node of level) {
      remaining.delete(node);
      resolved.add(node);
    }

    levels.push(level);
  }

  return levels;
}
