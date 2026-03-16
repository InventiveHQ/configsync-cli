import { Command } from 'commander';
import chalk from 'chalk';

const bashCompletion = `
# configsync bash completion
_configsync_completions() {
  local cur prev commands subcommands
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  commands="init login logout add push pull status scan secret completions"

  case "\${prev}" in
    configsync)
      COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
      return 0
      ;;
    add)
      COMPREPLY=( $(compgen -W "project group config repo env" -- "\${cur}") )
      return 0
      ;;
    secret)
      COMPREPLY=( $(compgen -W "set get list" -- "\${cur}") )
      return 0
      ;;
    pull)
      COMPREPLY=( $(compgen -W "--force --from --group --project --list-machines" -- "\${cur}") )
      return 0
      ;;
    push)
      COMPREPLY=( $(compgen -W "-m --message" -- "\${cur}") )
      return 0
      ;;
    login)
      COMPREPLY=( $(compgen -W "--token --api-url" -- "\${cur}") )
      return 0
      ;;
    init)
      COMPREPLY=( $(compgen -W "--sync-backend --profile" -- "\${cur}") )
      return 0
      ;;
    --sync-backend)
      COMPREPLY=( $(compgen -W "local cloud" -- "\${cur}") )
      return 0
      ;;
    project|group|config|repo|env)
      # Complete with directories/files
      COMPREPLY=( $(compgen -f -- "\${cur}") )
      return 0
      ;;
  esac

  if [[ "\${cur}" == -* ]]; then
    COMPREPLY=( $(compgen -W "--help --version" -- "\${cur}") )
  fi
}
complete -F _configsync_completions configsync
`.trim();

const zshCompletion = `
# configsync zsh completion
_configsync() {
  local -a commands add_commands secret_commands

  commands=(
    'init:Initialize ConfigSync on this machine'
    'login:Log in to ConfigSync cloud'
    'logout:Log out from ConfigSync cloud'
    'add:Add items to sync'
    'push:Push current state to sync backend'
    'pull:Pull and restore state from sync backend'
    'status:Show current sync status'
    'scan:Scan for installed packages'
    'secret:Manage secrets'
    'completions:Generate shell completions'
  )

  add_commands=(
    'project:Add a project folder'
    'group:Add a folder of projects'
    'config:Add a config file'
    'repo:Add a git repository'
    'env:Add an environment file'
  )

  secret_commands=(
    'set:Store a secret'
    'get:Retrieve a secret'
    'list:List stored secrets'
  )

  if (( CURRENT == 2 )); then
    _describe 'command' commands
  elif (( CURRENT == 3 )); then
    case "\${words[2]}" in
      add)
        _describe 'subcommand' add_commands
        ;;
      secret)
        _describe 'subcommand' secret_commands
        ;;
      pull)
        _arguments \\
          '--force[overwrite existing files]' \\
          '--from[pull from specific machine]:machine:' \\
          '--group[pull specific group]:group:' \\
          '--project[pull specific project]:project:' \\
          '--list-machines[list available machines]'
        ;;
      push)
        _arguments \\
          '-m[snapshot message]:message:' \\
          '--message[snapshot message]:message:'
        ;;
      *)
        _files
        ;;
    esac
  elif (( CURRENT >= 4 )); then
    _files
  fi
}
compdef _configsync configsync
`.trim();

export function registerCompletionsCommand(program: Command): void {
  program
    .command('completions')
    .description('Generate shell completions')
    .argument('[shell]', 'shell type (bash or zsh)', '')
    .action((shell: string) => {
      const detectedShell = shell || (process.env.SHELL?.includes('zsh') ? 'zsh' : 'bash');

      if (detectedShell === 'zsh') {
        console.log(zshCompletion);
        console.error(chalk.dim('\n# Add to your ~/.zshrc:'));
        console.error(chalk.dim('#   eval "$(configsync completions zsh)"'));
      } else {
        console.log(bashCompletion);
        console.error(chalk.dim('\n# Add to your ~/.bashrc:'));
        console.error(chalk.dim('#   eval "$(configsync completions bash)"'));
      }
    });
}
