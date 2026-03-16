import { Command } from 'commander';
import chalk from 'chalk';

const bashCompletion = `
# configsync bash completion
_configsync_completions() {
  local cur prev commands subcommands
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  commands="init login logout add remove list push pull status scan secret completions sync doctor machine env profile"

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
    machine)
      COMPREPLY=( $(compgen -W "tag var" -- "\${cur}") )
      return 0
      ;;
    tag)
      COMPREPLY=( $(compgen -W "add remove list" -- "\${cur}") )
      return 0
      ;;
    var)
      COMPREPLY=( $(compgen -W "set get list" -- "\${cur}") )
      return 0
      ;;
    env)
      COMPREPLY=( $(compgen -W "list create activate deactivate current shell hook delete vars" -- "\${cur}") )
      return 0
      ;;
    profile)
      COMPREPLY=( $(compgen -W "list create switch delete show set-path remove-path set-var set-env-override unset-var unset-env-override" -- "\${cur}") )
      return 0
      ;;
    pull)
      COMPREPLY=( $(compgen -W "--force --from --group --project --list-machines --install --install-yes --no-packages --env" -- "\${cur}") )
      return 0
      ;;
    push)
      COMPREPLY=( $(compgen -W "-m --message --env" -- "\${cur}") )
      return 0
      ;;
    scan)
      COMPREPLY=( $(compgen -W "--diff" -- "\${cur}") )
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
    hook)
      COMPREPLY=( $(compgen -W "bash zsh fish" -- "\${cur}") )
      return 0
      ;;
    create|activate|shell|delete)
      # Would need dynamic completions from config
      return 0
      ;;
    project|group|config|repo)
      # Complete with directories/files
      COMPREPLY=( $(compgen -f -- "\${cur}") )
      return 0
      ;;
  esac

  if [[ "\${cur}" == -* ]]; then
    COMPREPLY=( $(compgen -W "--help --version --env --profile" -- "\${cur}") )
  fi
}
complete -F _configsync_completions configsync
`.trim();

const zshCompletion = `
# configsync zsh completion
_configsync() {
  local -a commands add_commands secret_commands machine_commands tag_commands var_commands env_commands profile_commands

  commands=(
    'init:Initialize ConfigSync on this machine'
    'login:Log in to ConfigSync cloud'
    'logout:Log out from ConfigSync cloud'
    'add:Add items to sync'
    'remove:Remove items from sync'
    'list:List tracked items'
    'push:Push current state to sync backend'
    'pull:Pull and restore state from sync backend'
    'status:Show current sync status'
    'scan:Scan for installed packages'
    'secret:Manage secrets'
    'completions:Generate shell completions'
    'sync:Apply pending actions from dashboard'
    'doctor:Run system diagnostics'
    'machine:Manage machine tags and variables'
    'env:Manage environments (dev, staging, prod)'
    'profile:Manage configuration profiles'
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

  machine_commands=(
    'tag:Manage machine tags'
    'var:Manage machine variables'
  )

  tag_commands=(
    'add:Add a tag'
    'remove:Remove a tag'
    'list:List tags'
  )

  var_commands=(
    'set:Set a variable'
    'get:Get a variable'
    'list:List variables'
  )

  env_commands=(
    'list:List environments'
    'create:Create an environment'
    'activate:Activate an environment'
    'deactivate:Deactivate the current environment'
    'current:Show the active environment'
    'shell:Spawn a subshell with an environment'
    'hook:Print shell hook code'
    'delete:Delete an environment'
    'vars:Output export statements for current project'
  )

  profile_commands=(
    'list:List all profiles'
    'create:Create a new profile'
    'switch:Switch to a profile'
    'delete:Delete a profile'
    'show:Show profile details'
    'set-path:Add a path to a profile'
    'remove-path:Remove a path from a profile'
    'set-var:Set a profile variable'
    'set-env-override:Set a profile env override'
    'unset-var:Remove a profile variable'
    'unset-env-override:Remove a profile env override'
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
      machine)
        _describe 'subcommand' machine_commands
        ;;
      env)
        _describe 'subcommand' env_commands
        ;;
      profile)
        _describe 'subcommand' profile_commands
        ;;
      pull)
        _arguments \\
          '--force[overwrite existing files]' \\
          '--from[pull from specific machine]:machine:' \\
          '--group[pull specific group]:group:' \\
          '--project[pull specific project]:project:' \\
          '--list-machines[list available machines]' \\
          '--install[install missing packages]' \\
          '--install-yes[install without prompting]' \\
          '--no-packages[skip package reconciliation]' \\
          '--env[set active environment]:environment:'
        ;;
      push)
        _arguments \\
          '-m[snapshot message]:message:' \\
          '--message[snapshot message]:message:' \\
          '--env[set active environment]:environment:'
        ;;
      scan)
        _arguments \\
          '--diff[show diff against remote packages]'
        ;;
      *)
        _files
        ;;
    esac
  elif (( CURRENT == 4 )); then
    case "\${words[2]}" in
      machine)
        case "\${words[3]}" in
          tag) _describe 'tag subcommand' tag_commands ;;
          var) _describe 'var subcommand' var_commands ;;
        esac
        ;;
      env)
        case "\${words[3]}" in
          hook) _values 'shell' bash zsh fish ;;
          *) _files ;;
        esac
        ;;
      *)
        _files
        ;;
    esac
  elif (( CURRENT >= 5 )); then
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
