/**
 * Environment variable detection and tracking.
 */

// Common dev-related env vars worth tracking
const DEV_VAR_PATTERNS = [
  // Paths
  'GOPATH', 'GOROOT', 'GOBIN',
  'JAVA_HOME', 'JDK_HOME',
  'ANDROID_HOME', 'ANDROID_SDK_ROOT',
  'NVM_DIR', 'VOLTA_HOME', 'FNM_DIR',
  'PYENV_ROOT', 'RBENV_ROOT', 'RUSTUP_HOME', 'CARGO_HOME',
  'DENO_INSTALL',
  // Cloud
  'AWS_PROFILE', 'AWS_DEFAULT_REGION', 'AWS_REGION',
  'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_SUBSCRIPTION_ID',
  // Dev tools
  'EDITOR', 'VISUAL',
  'GPG_TTY',
  'DOCKER_HOST', 'COMPOSE_PROJECT_NAME',
  // Node
  'NODE_ENV', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS',
  // Python
  'VIRTUAL_ENV', 'PIPENV_VENV_IN_PROJECT',
  // Misc
  'HOMEBREW_PREFIX', 'HOMEBREW_CELLAR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
];

// Vars to always skip (session-specific, not portable)
const SKIP_VARS = new Set([
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TERM_PROGRAM',
  'TERM_SESSION_ID', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'PWD', 'OLDPWD', 'SHLVL', 'HOSTNAME', '_',
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'SSH_CLIENT', 'SSH_CONNECTION', 'SSH_TTY',
  'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_SESSION_TYPE', 'XDG_RUNTIME_DIR',
  'COLORTERM', 'COLORFGBG', 'ITERM_SESSION_ID', 'ITERM_PROFILE',
  'TERM_PROGRAM_VERSION', 'SECURITYSESSIONID', 'Apple_PubSub_Socket_Render',
  'LaunchInstanceID', 'COMMAND_MODE',
  'PATH',  // Too machine-specific, captured via dotfiles
  'MANPATH', 'INFOPATH',
]);

export interface EnvVarCapture {
  name: string;
  value: string;
}

/**
 * Scan for common dev-related environment variables that are currently set.
 */
export function detectDevEnvVars(): EnvVarCapture[] {
  const found: EnvVarCapture[] = [];

  for (const name of DEV_VAR_PATTERNS) {
    const value = process.env[name];
    if (value) {
      found.push({ name, value });
    }
  }

  return found;
}

/**
 * Capture specific env vars by name.
 */
export function captureEnvVars(names: string[]): EnvVarCapture[] {
  const captured: EnvVarCapture[] = [];

  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) {
      captured.push({ name, value });
    }
  }

  return captured;
}

/**
 * Scan all env vars and return ones that look dev-related
 * (excludes session-specific, system vars).
 */
export function scanAllDevVars(): EnvVarCapture[] {
  const vars: EnvVarCapture[] = [];

  for (const [name, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (SKIP_VARS.has(name)) continue;
    // Skip vars that start with __ (internal)
    if (name.startsWith('__')) continue;
    // Only include vars that look like dev/config vars
    if (DEV_VAR_PATTERNS.includes(name) || name.includes('API') || name.includes('TOKEN')
        || name.includes('KEY') || name.includes('SECRET') || name.includes('HOME')
        || name.includes('ROOT') || name.includes('DIR') || name.includes('PATH')) {
      // But skip PATH itself (already filtered above)
      vars.push({ name, value });
    }
  }

  return vars.sort((a, b) => a.name.localeCompare(b.name));
}

export function getDevVarPatterns(): string[] {
  return DEV_VAR_PATTERNS;
}
