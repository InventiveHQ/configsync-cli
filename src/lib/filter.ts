/**
 * Filter system for selective push/pull operations.
 */

export type FilterType = 'configs' | 'repos' | 'env_files' | 'modules' | 'packages' | 'projects' | 'groups';

const VALID_TYPES: Set<string> = new Set(['configs', 'repos', 'env_files', 'modules', 'packages', 'projects', 'groups']);

export interface Filter {
  type: FilterType;
  name?: string;
}

/**
 * Parse filter strings like "modules:ssh", "configs", "modules:ssh,configs"
 * Accepts an array of strings (from commander variadic), each potentially comma-separated.
 */
export function parseFilters(raw: string[]): Filter[] {
  const filters: Filter[] = [];

  for (const arg of raw) {
    for (const part of arg.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) {
        if (VALID_TYPES.has(trimmed)) {
          filters.push({ type: trimmed as FilterType });
        }
      } else {
        const type = trimmed.slice(0, colonIdx);
        const name = trimmed.slice(colonIdx + 1);
        if (VALID_TYPES.has(type) && name) {
          filters.push({ type: type as FilterType, name });
        }
      }
    }
  }

  return filters;
}

/**
 * Check if an item should be included given active filters.
 * If no filters are set, everything is included.
 * If filters are set, only matching types (and optionally names) are included.
 */
export function shouldInclude(type: FilterType, name: string | undefined, filters: Filter[]): boolean {
  if (filters.length === 0) return true;

  return filters.some(f => {
    if (f.type !== type) return false;
    if (f.name && name) return name.toLowerCase().includes(f.name.toLowerCase());
    if (f.name && !name) return false;
    return true;
  });
}

export function isFilterActive(filters: Filter[]): boolean {
  return filters.length > 0;
}
