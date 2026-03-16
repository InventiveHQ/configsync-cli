/**
 * Terminal escape sequences and shell integration for ConfigSync.
 *
 * Provides OSC escapes for tab titles, background tints, prompt badges,
 * and shell hooks that keep the terminal in sync with the active environment.
 */

import { EnvironmentManager } from './environment.js';

// ---------------------------------------------------------------------------
// OSC escapes
// ---------------------------------------------------------------------------

/**
 * Returns an OSC 2 escape sequence to set the terminal tab/window title.
 */
export function setTabTitle(title: string): string {
  return `\x1b]2;${title}\x07`;
}

/**
 * Returns an OSC 11 escape sequence for a subtle background tint
 * based on the environment tier. Only applied when the terminal supports it.
 */
export function setBackgroundTint(tier: string): string {
  if (!shouldApplyEffect('background')) return '';

  const tints: Record<string, string> = {
    production: 'rgb:1a/00/00',
    staging: 'rgb:1a/1a/00',
    development: 'rgb:00/1a/00',
  };

  const color = tints[tier];
  if (!color) return '';

  return `\x1b]11;${color}\x07`;
}

/**
 * Returns an OSC 110 escape to reset the terminal background color.
 */
export function resetBackground(): string {
  return '\x1b]110\x07';
}

// ---------------------------------------------------------------------------
// Prompt badges
// ---------------------------------------------------------------------------

/**
 * Returns shell-specific code to add a colored environment badge to the prompt.
 */
export function generatePromptBadge(
  shell: 'bash' | 'zsh' | 'fish',
  envName: string,
  tier: string,
): string {
  const label = EnvironmentManager.tierLabel(tier, envName);

  const colors: Record<string, { fg: string; bg: string; bashFg: string; bashBg: string }> = {
    production: { fg: '15', bg: '1', bashFg: '37', bashBg: '41' },
    staging: { fg: '0', bg: '3', bashFg: '30', bashBg: '43' },
    development: { fg: '0', bg: '2', bashFg: '30', bashBg: '42' },
    custom: { fg: '0', bg: '6', bashFg: '30', bashBg: '46' },
  };
  const c = colors[tier] || colors.custom;

  switch (shell) {
    case 'zsh':
      return `%K{${c.bg}}%F{${c.fg}} ${label} %f%k `;

    case 'bash':
      return `\\[\\e[${c.bashBg};${c.bashFg}m\\] ${label} \\[\\e[0m\\] `;

    case 'fish':
      return `set_color -b ${tierToFishColor(tier)}; set_color ${tier === 'production' ? 'white' : 'black'}; echo -n " ${label} "; set_color normal; echo -n " "`;
  }
}

function tierToFishColor(tier: string): string {
  switch (tier) {
    case 'production': return 'red';
    case 'staging': return 'yellow';
    case 'development': return 'green';
    default: return 'cyan';
  }
}

// ---------------------------------------------------------------------------
// Shell hooks
// ---------------------------------------------------------------------------

/**
 * Returns complete shell hook code that:
 * - Reads ~/.configsync/active-env on each prompt
 * - Sets CONFIGSYNC_ENV and CONFIGSYNC_ENV_TIER env vars
 * - Adds a colored badge to the prompt
 * - Sets the terminal title
 * - Handles env injection: on chpwd checks ~/.configsync/env_inject/*.json for CWD match
 * - Saves/restores the original PS1
 */
export function generateShellHook(shell: 'bash' | 'zsh' | 'fish'): string {
  switch (shell) {
    case 'zsh':
      return zshHook();
    case 'bash':
      return bashHook();
    case 'fish':
      return fishHook();
  }
}

function zshHook(): string {
  return `# ConfigSync environment hook (zsh)
# Add to ~/.zshrc: eval "$(configsync shell-hook zsh)"

_configsync_original_ps1="\${PS1}"

_configsync_update_env() {
  local env_file="\${HOME}/.configsync/active-env"
  local tier_file="\${HOME}/.configsync/active-env-tier"

  if [[ -f "\${env_file}" ]]; then
    export CONFIGSYNC_ENV="$(< "\${env_file}")"
    [[ -f "\${tier_file}" ]] && export CONFIGSYNC_ENV_TIER="$(< "\${tier_file}")"

    local label="\${CONFIGSYNC_ENV:u}"
    local badge=""
    case "\${CONFIGSYNC_ENV_TIER}" in
      production)  badge="%K{1}%F{15} \${label} %f%k " ;;
      staging)     badge="%K{3}%F{0} \${label} %f%k " ;;
      development) badge="%K{2}%F{0} \${label} %f%k " ;;
      *)           badge="%K{6}%F{0} \${label} %f%k " ;;
    esac

    PS1="\${badge}\${_configsync_original_ps1}"
    printf '\\e]2;configsync:%s\\a' "\${CONFIGSYNC_ENV}"
  else
    unset CONFIGSYNC_ENV CONFIGSYNC_ENV_TIER
    PS1="\${_configsync_original_ps1}"
  fi
}

_configsync_chpwd_inject() {
  eval "$(configsync env vars --for-shell 2>/dev/null)"
}

precmd_functions+=(_configsync_update_env)
chpwd_functions+=(_configsync_chpwd_inject)
`;
}

function bashHook(): string {
  return `# ConfigSync environment hook (bash)
# Add to ~/.bashrc: eval "$(configsync shell-hook bash)"

_configsync_original_ps1="\${PS1}"
_configsync_last_pwd=""

_configsync_prompt_command() {
  local env_file="\${HOME}/.configsync/active-env"
  local tier_file="\${HOME}/.configsync/active-env-tier"

  if [[ -f "\${env_file}" ]]; then
    export CONFIGSYNC_ENV="$(< "\${env_file}")"
    [[ -f "\${tier_file}" ]] && export CONFIGSYNC_ENV_TIER="$(< "\${tier_file}")"

    local label="\${CONFIGSYNC_ENV^^}"
    local badge=""
    case "\${CONFIGSYNC_ENV_TIER}" in
      production)  badge="\\[\\e[41;37m\\] \${label} \\[\\e[0m\\] " ;;
      staging)     badge="\\[\\e[43;30m\\] \${label} \\[\\e[0m\\] " ;;
      development) badge="\\[\\e[42;30m\\] \${label} \\[\\e[0m\\] " ;;
      *)           badge="\\[\\e[46;30m\\] \${label} \\[\\e[0m\\] " ;;
    esac

    PS1="\${badge}\${_configsync_original_ps1}"
    printf '\\e]2;configsync:%s\\a' "\${CONFIGSYNC_ENV}"
  else
    unset CONFIGSYNC_ENV CONFIGSYNC_ENV_TIER
    PS1="\${_configsync_original_ps1}"
  fi

  # Only run env injection when directory actually changes
  if [[ "\${PWD}" != "\${_configsync_last_pwd}" ]]; then
    _configsync_last_pwd="\${PWD}"
    eval "$(configsync env vars --for-shell 2>/dev/null)"
  fi
}

PROMPT_COMMAND="_configsync_prompt_command\${PROMPT_COMMAND:+;}\${PROMPT_COMMAND}"
`;
}

function fishHook(): string {
  return `# ConfigSync environment hook (fish)
# Add to ~/.config/fish/conf.d/configsync.fish

set -g _configsync_original_fish_prompt (functions fish_prompt)

function _configsync_update_env --on-event fish_prompt
  set -l env_file "$HOME/.configsync/active-env"
  set -l tier_file "$HOME/.configsync/active-env-tier"

  if test -f $env_file
    set -gx CONFIGSYNC_ENV (string trim (cat $env_file))
    test -f $tier_file; and set -gx CONFIGSYNC_ENV_TIER (string trim (cat $tier_file))
  else
    set -e CONFIGSYNC_ENV
    set -e CONFIGSYNC_ENV_TIER
  end
end

function fish_prompt
  _configsync_update_env

  if set -q CONFIGSYNC_ENV
    set -l label (string upper $CONFIGSYNC_ENV)
    switch $CONFIGSYNC_ENV_TIER
      case production
        set_color -b red; set_color white
      case staging
        set_color -b yellow; set_color black
      case development
        set_color -b green; set_color black
      case '*'
        set_color -b cyan; set_color black
    end
    echo -n " $label "
    set_color normal
    echo -n " "
    printf '\\e]2;configsync:%s\\a' $CONFIGSYNC_ENV
  end

  # Call original prompt
  eval $_configsync_original_fish_prompt
end

function _configsync_chpwd --on-variable PWD
  eval (configsync env vars --for-shell 2>/dev/null)
end
`;
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

/**
 * Returns ANSI sequences to set a persistent bottom status bar.
 * Uses a scrolling region to reserve the bottom line.
 */
export function setStatusBar(text: string, tier: string): string {
  const rows = process.stdout.rows || 24;
  const cols = process.stdout.columns || 80;

  const bgColors: Record<string, string> = {
    production: '41',
    staging: '43',
    development: '42',
    custom: '46',
  };
  const fgColors: Record<string, string> = {
    production: '37',
    staging: '30',
    development: '30',
    custom: '30',
  };

  const bg = bgColors[tier] || bgColors.custom;
  const fg = fgColors[tier] || fgColors.custom;
  const padded = text.padEnd(cols);

  return [
    `\x1b[${rows};1H`,              // move to last row
    `\x1b[${bg};${fg}m`,            // set colors
    padded,                          // status text
    `\x1b[0m`,                      // reset colors
    `\x1b[1;${rows - 1}r`,          // set scrolling region (exclude last row)
    `\x1b[${rows - 1};1H`,          // move cursor back to usable area
  ].join('');
}

/**
 * Reset the scrolling region to the full terminal height.
 */
export function resetStatusBar(): string {
  const rows = process.stdout.rows || 24;
  return `\x1b[1;${rows}r\x1b[${rows};1H\x1b[2K`;
}

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

/**
 * Check whether a terminal effect is safe to apply based on the current
 * terminal emulator and environment (TERM_PROGRAM, $TMUX, $STY).
 */
export function shouldApplyEffect(effect: string): boolean {
  const term = process.env.TERM_PROGRAM || '';
  const inTmux = !!process.env.TMUX;
  const inScreen = !!process.env.STY;

  // VS Code integrated terminal — skip visual effects
  if (term === 'vscode') return false;

  switch (effect) {
    case 'background': {
      // Safe in iTerm2, Windows Terminal, GNOME Terminal
      const safe = ['iTerm.app', 'WezTerm', 'Windows_Terminal', 'GNOME Terminal'];
      if (safe.includes(term)) return true;
      // tmux needs DCS passthrough — supported but flag it
      if (inTmux || inScreen) return false;
      return false;
    }

    case 'title':
      // Tab titles are broadly supported
      return true;

    case 'status_bar':
      // Scrolling region trick works in most terminals
      if (term === 'vscode') return false;
      return true;

    default:
      return false;
  }
}
