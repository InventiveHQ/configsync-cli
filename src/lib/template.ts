/**
 * Lightweight template engine for ConfigSync.
 *
 * Supports two constructs:
 * - Variable substitution: {{platform}}, {{vars.email}}
 * - Conditional blocks: {{#if platform == "darwin"}}...{{/if}},
 *   {{#unless platform == "win32"}}...{{/unless}}
 */

import os from 'node:os';

import type { MachineConfig, ProfileDef } from './config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TemplateContext {
  platform: string;
  arch: string;
  hostname: string;
  home: string;
  tags: string[];
  vars: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Build a template context from OS builtins, optional machine config,
 * and optional active profile (profile vars override machine vars).
 */
export function buildContext(machine?: MachineConfig, profile?: ProfileDef | null): TemplateContext {
  const vars = { ...(machine?.vars ?? {}) };
  // Profile vars override machine vars
  if (profile?.vars) {
    Object.assign(vars, profile.vars);
  }
  return {
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    home: os.homedir(),
    tags: machine?.tags ?? [],
    vars,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const CONDITIONAL_RE =
  /\{\{#(if|unless)\s+(.+?)\}\}([\s\S]*?)\{\{\/(if|unless)\}\}/g;

const VARIABLE_RE = /\{\{([\w.]+)\}\}/g;

/**
 * Evaluate a condition string against the template context.
 *
 * Supported forms:
 *   platform == "darwin"
 *   platform != "win32"
 *   tags contains "work"
 */
function evaluateCondition(condition: string, ctx: TemplateContext): boolean {
  const eqMatch = condition.match(/^(\w+)\s*==\s*"([^"]*)"$/);
  if (eqMatch) {
    const value = resolveValue(eqMatch[1], ctx);
    return value === eqMatch[2];
  }

  const neqMatch = condition.match(/^(\w+)\s*!=\s*"([^"]*)"$/);
  if (neqMatch) {
    const value = resolveValue(neqMatch[1], ctx);
    return value !== neqMatch[2];
  }

  const containsMatch = condition.match(/^(\w+)\s+contains\s+"([^"]*)"$/);
  if (containsMatch) {
    if (containsMatch[1] === 'tags') {
      return ctx.tags.includes(containsMatch[2]);
    }
    return false;
  }

  return false;
}

/**
 * Resolve a simple identifier to its string value from the context.
 */
function resolveValue(key: string, ctx: TemplateContext): string {
  if (key in ctx && typeof (ctx as any)[key] === 'string') {
    return (ctx as any)[key];
  }
  return '';
}

/**
 * Render a template string by processing conditionals then substituting variables.
 */
export function renderTemplate(content: string, context: TemplateContext): string {
  // Step 1: Process conditional blocks
  let result = content.replace(
    CONDITIONAL_RE,
    (_match, directive: string, condition: string, body: string, closing: string) => {
      // Mismatched open/close — leave as-is
      if (directive !== closing) return _match;

      const condResult = evaluateCondition(condition.trim(), context);
      const keep = directive === 'if' ? condResult : !condResult;
      return keep ? body : '';
    },
  );

  // Step 2: Substitute variables
  result = result.replace(VARIABLE_RE, (_match, key: string) => {
    // vars.* — user-defined variables
    if (key.startsWith('vars.')) {
      const varName = key.slice(5);
      return context.vars[varName] ?? '';
    }

    // Built-in context values
    if (key in context && typeof (context as any)[key] === 'string') {
      return (context as any)[key];
    }

    return '';
  });

  return result;
}
