/**
 * Cross-platform package name mappings.
 *
 * Maps canonical tool names to their package names across different managers,
 * allowing diffPackages() to match e.g. brew:ripgrep against apt:ripgrep
 * or brew:fd against apt:fd-find.
 */
import { PackageMapping } from './package-diff.js';

export const defaultMappings: PackageMapping[] = [
  // --- CLI utilities ---
  {
    canonical: 'ripgrep',
    packages: { brew: 'ripgrep', apt: 'ripgrep', dnf: 'ripgrep', pacman: 'ripgrep', choco: 'ripgrep', winget: 'BurntSushi.ripgrep.MSVC', snap: 'ripgrep', cargo: 'ripgrep' },
  },
  {
    canonical: 'fd',
    packages: { brew: 'fd', apt: 'fd-find', dnf: 'fd-find', pacman: 'fd', choco: 'fd', winget: 'sharkdp.fd', cargo: 'fd-find' },
  },
  {
    canonical: 'bat',
    packages: { brew: 'bat', apt: 'bat', dnf: 'bat', pacman: 'bat', choco: 'bat', winget: 'sharkdp.bat', cargo: 'bat' },
  },
  {
    canonical: 'jq',
    packages: { brew: 'jq', apt: 'jq', dnf: 'jq', pacman: 'jq', choco: 'jq', winget: 'jqlang.jq' },
  },
  {
    canonical: 'yq',
    packages: { brew: 'yq', apt: 'yq', dnf: 'yq', snap: 'yq', choco: 'yq', winget: 'MikeFarah.yq' },
  },
  {
    canonical: 'fzf',
    packages: { brew: 'fzf', apt: 'fzf', dnf: 'fzf', pacman: 'fzf', choco: 'fzf', winget: 'junegunn.fzf' },
  },
  {
    canonical: 'tmux',
    packages: { brew: 'tmux', apt: 'tmux', dnf: 'tmux', pacman: 'tmux' },
  },
  {
    canonical: 'htop',
    packages: { brew: 'htop', apt: 'htop', dnf: 'htop', pacman: 'htop', snap: 'htop' },
  },
  {
    canonical: 'btop',
    packages: { brew: 'btop', apt: 'btop', dnf: 'btop', pacman: 'btop', snap: 'btop' },
  },
  {
    canonical: 'neovim',
    packages: { brew: 'neovim', apt: 'neovim', dnf: 'neovim', pacman: 'neovim', choco: 'neovim', winget: 'Neovim.Neovim', snap: 'nvim' },
  },
  {
    canonical: 'tree',
    packages: { brew: 'tree', apt: 'tree', dnf: 'tree', pacman: 'tree', choco: 'tree' },
  },
  {
    canonical: 'eza',
    packages: { brew: 'eza', apt: 'eza', dnf: 'eza', pacman: 'eza', cargo: 'eza' },
  },
  {
    canonical: 'zoxide',
    packages: { brew: 'zoxide', apt: 'zoxide', dnf: 'zoxide', pacman: 'zoxide', cargo: 'zoxide' },
  },
  {
    canonical: 'starship',
    packages: { brew: 'starship', apt: 'starship', pacman: 'starship', choco: 'starship', winget: 'Starship.Starship', cargo: 'starship' },
  },
  {
    canonical: 'delta',
    packages: { brew: 'git-delta', apt: 'git-delta', dnf: 'git-delta', pacman: 'git-delta', choco: 'delta', cargo: 'git-delta' },
  },
  {
    canonical: 'dust',
    packages: { brew: 'dust', apt: 'dust', pacman: 'dust', cargo: 'du-dust' },
  },
  {
    canonical: 'duf',
    packages: { brew: 'duf', apt: 'duf', dnf: 'duf', pacman: 'duf', snap: 'duf' },
  },
  {
    canonical: 'procs',
    packages: { brew: 'procs', pacman: 'procs', cargo: 'procs' },
  },
  {
    canonical: 'sd',
    packages: { brew: 'sd', pacman: 'sd', cargo: 'sd' },
  },
  {
    canonical: 'hyperfine',
    packages: { brew: 'hyperfine', apt: 'hyperfine', pacman: 'hyperfine', cargo: 'hyperfine' },
  },
  {
    canonical: 'tokei',
    packages: { brew: 'tokei', pacman: 'tokei', cargo: 'tokei' },
  },

  // --- Networking ---
  {
    canonical: 'curl',
    packages: { brew: 'curl', apt: 'curl', dnf: 'curl', pacman: 'curl', choco: 'curl', winget: 'cURL.cURL' },
  },
  {
    canonical: 'wget',
    packages: { brew: 'wget', apt: 'wget', dnf: 'wget', pacman: 'wget', choco: 'wget', winget: 'JernejSimoncic.Wget' },
  },
  {
    canonical: 'httpie',
    packages: { brew: 'httpie', apt: 'httpie', dnf: 'httpie', pacman: 'httpie', pip: 'httpie', snap: 'httpie' },
  },
  {
    canonical: 'nmap',
    packages: { brew: 'nmap', apt: 'nmap', dnf: 'nmap', pacman: 'nmap', choco: 'nmap', winget: 'Insecure.Nmap' },
  },
  {
    canonical: 'wireshark',
    packages: { brew: 'wireshark', apt: 'wireshark', dnf: 'wireshark', pacman: 'wireshark-qt', choco: 'wireshark', winget: 'WiresharkFoundation.Wireshark' },
  },
  {
    canonical: 'socat',
    packages: { brew: 'socat', apt: 'socat', dnf: 'socat', pacman: 'socat' },
  },
  {
    canonical: 'mtr',
    packages: { brew: 'mtr', apt: 'mtr-tiny', dnf: 'mtr', pacman: 'mtr' },
  },

  // --- Version control ---
  {
    canonical: 'git',
    packages: { brew: 'git', apt: 'git', dnf: 'git', pacman: 'git', choco: 'git', winget: 'Git.Git' },
  },
  {
    canonical: 'gh',
    packages: { brew: 'gh', apt: 'gh', dnf: 'gh', pacman: 'github-cli', choco: 'gh', winget: 'GitHub.cli', snap: 'gh' },
  },
  {
    canonical: 'lazygit',
    packages: { brew: 'lazygit', dnf: 'lazygit', pacman: 'lazygit', choco: 'lazygit', winget: 'JesseDuffield.lazygit' },
  },

  // --- Containers & orchestration ---
  {
    canonical: 'docker',
    packages: { brew: 'docker', apt: 'docker-ce', dnf: 'docker-ce', pacman: 'docker', choco: 'docker-desktop', winget: 'Docker.DockerDesktop' },
  },
  {
    canonical: 'podman',
    packages: { brew: 'podman', apt: 'podman', dnf: 'podman', pacman: 'podman', choco: 'podman-desktop', winget: 'RedHat.Podman' },
  },
  {
    canonical: 'kubectl',
    packages: { brew: 'kubernetes-cli', apt: 'kubectl', dnf: 'kubectl', pacman: 'kubectl', choco: 'kubernetes-cli', winget: 'Kubernetes.kubectl', snap: 'kubectl' },
  },
  {
    canonical: 'helm',
    packages: { brew: 'helm', apt: 'helm', dnf: 'helm', pacman: 'helm', choco: 'kubernetes-helm', winget: 'Helm.Helm', snap: 'helm' },
  },
  {
    canonical: 'k9s',
    packages: { brew: 'k9s', pacman: 'k9s', choco: 'k9s', winget: 'Derailed.k9s', snap: 'k9s' },
  },
  {
    canonical: 'terraform',
    packages: { brew: 'terraform', apt: 'terraform', dnf: 'terraform', pacman: 'terraform', choco: 'terraform', winget: 'Hashicorp.Terraform' },
  },
  {
    canonical: 'ansible',
    packages: { brew: 'ansible', apt: 'ansible', dnf: 'ansible', pacman: 'ansible', pip: 'ansible' },
  },

  // --- Languages & runtimes ---
  {
    canonical: 'go',
    packages: { brew: 'go', apt: 'golang', dnf: 'golang', pacman: 'go', choco: 'golang', winget: 'GoLang.Go', snap: 'go' },
  },
  {
    canonical: 'rustup',
    packages: { brew: 'rustup', apt: 'rustup', dnf: 'rustup', pacman: 'rustup', choco: 'rustup.install', winget: 'Rustlang.Rustup' },
  },
  {
    canonical: 'node',
    packages: { brew: 'node', apt: 'nodejs', dnf: 'nodejs', pacman: 'nodejs', choco: 'nodejs', winget: 'OpenJS.NodeJS' },
  },
  {
    canonical: 'python3',
    packages: { brew: 'python@3', apt: 'python3', dnf: 'python3', pacman: 'python', choco: 'python3', winget: 'Python.Python.3.12' },
  },
  {
    canonical: 'ruby',
    packages: { brew: 'ruby', apt: 'ruby', dnf: 'ruby', pacman: 'ruby', choco: 'ruby', winget: 'RubyInstallerTeam.Ruby.3.3' },
  },
  {
    canonical: 'java',
    packages: { brew: 'openjdk', apt: 'default-jdk', dnf: 'java-latest-openjdk', pacman: 'jdk-openjdk', choco: 'openjdk', winget: 'EclipseAdoptium.Temurin.21.JDK' },
  },
  {
    canonical: 'deno',
    packages: { brew: 'deno', pacman: 'deno', choco: 'deno', winget: 'DenoLand.Deno', cargo: 'deno' },
  },
  {
    canonical: 'bun',
    packages: { brew: 'oven-sh/bun/bun', npm: 'bun', winget: 'Oven-sh.Bun' },
  },

  // --- Build tools ---
  {
    canonical: 'gcc',
    packages: { brew: 'gcc', apt: 'gcc', dnf: 'gcc', pacman: 'gcc', choco: 'mingw' },
  },
  {
    canonical: 'make',
    packages: { brew: 'make', apt: 'make', dnf: 'make', pacman: 'make', choco: 'make' },
  },
  {
    canonical: 'cmake',
    packages: { brew: 'cmake', apt: 'cmake', dnf: 'cmake', pacman: 'cmake', choco: 'cmake', winget: 'Kitware.CMake', pip: 'cmake' },
  },
  {
    canonical: 'llvm',
    packages: { brew: 'llvm', apt: 'llvm', dnf: 'llvm', pacman: 'llvm', choco: 'llvm', winget: 'LLVM.LLVM' },
  },
  {
    canonical: 'ninja',
    packages: { brew: 'ninja', apt: 'ninja-build', dnf: 'ninja-build', pacman: 'ninja', choco: 'ninja', pip: 'ninja' },
  },
  {
    canonical: 'meson',
    packages: { brew: 'meson', apt: 'meson', dnf: 'meson', pacman: 'meson', pip: 'meson' },
  },

  // --- Libraries & crypto ---
  {
    canonical: 'openssl',
    packages: { brew: 'openssl', apt: 'openssl', dnf: 'openssl', pacman: 'openssl', choco: 'openssl', winget: 'ShiningLight.OpenSSL' },
  },
  {
    canonical: 'gnupg',
    packages: { brew: 'gnupg', apt: 'gnupg', dnf: 'gnupg2', pacman: 'gnupg', choco: 'gnupg' },
  },

  // --- Databases ---
  {
    canonical: 'sqlite',
    packages: { brew: 'sqlite', apt: 'sqlite3', dnf: 'sqlite', pacman: 'sqlite', choco: 'sqlite', winget: 'SQLite.SQLite' },
  },
  {
    canonical: 'postgresql-client',
    packages: { brew: 'libpq', apt: 'postgresql-client', dnf: 'postgresql', pacman: 'postgresql' },
  },
  {
    canonical: 'redis-cli',
    packages: { brew: 'redis', apt: 'redis-tools', dnf: 'redis', pacman: 'redis' },
  },
  {
    canonical: 'mysql-client',
    packages: { brew: 'mysql-client', apt: 'mysql-client', dnf: 'mysql', pacman: 'mariadb-clients' },
  },

  // --- Cloud CLIs ---
  {
    canonical: 'awscli',
    packages: { brew: 'awscli', apt: 'awscli', dnf: 'awscli', pacman: 'aws-cli', choco: 'awscli', winget: 'Amazon.AWSCLI', pip: 'awscli', snap: 'aws-cli' },
  },
  {
    canonical: 'azure-cli',
    packages: { brew: 'azure-cli', apt: 'azure-cli', dnf: 'azure-cli', choco: 'azure-cli', winget: 'Microsoft.AzureCLI', pip: 'azure-cli' },
  },
  {
    canonical: 'gcloud',
    packages: { brew: 'google-cloud-sdk', apt: 'google-cloud-cli', dnf: 'google-cloud-cli', choco: 'gcloudsdk', winget: 'Google.CloudSDK', snap: 'google-cloud-cli' },
  },

  // --- Media ---
  {
    canonical: 'ffmpeg',
    packages: { brew: 'ffmpeg', apt: 'ffmpeg', dnf: 'ffmpeg', pacman: 'ffmpeg', choco: 'ffmpeg', winget: 'Gyan.FFmpeg', snap: 'ffmpeg' },
  },
  {
    canonical: 'imagemagick',
    packages: { brew: 'imagemagick', apt: 'imagemagick', dnf: 'ImageMagick', pacman: 'imagemagick', choco: 'imagemagick', winget: 'ImageMagick.ImageMagick' },
  },

  // --- Editors ---
  {
    canonical: 'vim',
    packages: { brew: 'vim', apt: 'vim', dnf: 'vim-enhanced', pacman: 'vim', choco: 'vim', winget: 'vim.vim' },
  },
  {
    canonical: 'emacs',
    packages: { brew: 'emacs', apt: 'emacs', dnf: 'emacs', pacman: 'emacs', choco: 'emacs', winget: 'GNU.Emacs', snap: 'emacs' },
  },
  {
    canonical: 'code',
    packages: { 'brew-cask': 'visual-studio-code', apt: 'code', dnf: 'code', pacman: 'code', choco: 'vscode', winget: 'Microsoft.VisualStudioCode', snap: 'code' },
  },

  // --- Shell tools ---
  {
    canonical: 'zsh',
    packages: { brew: 'zsh', apt: 'zsh', dnf: 'zsh', pacman: 'zsh', choco: 'zsh' },
  },
  {
    canonical: 'fish',
    packages: { brew: 'fish', apt: 'fish', dnf: 'fish', pacman: 'fish', choco: 'fish' },
  },
  {
    canonical: 'shellcheck',
    packages: { brew: 'shellcheck', apt: 'shellcheck', dnf: 'ShellCheck', pacman: 'shellcheck', choco: 'shellcheck', snap: 'shellcheck' },
  },
  {
    canonical: 'shfmt',
    packages: { brew: 'shfmt', apt: 'shfmt', pacman: 'shfmt', snap: 'shfmt' },
  },

  // --- Linters & formatters ---
  {
    canonical: 'prettier',
    packages: { npm: 'prettier' },
  },
  {
    canonical: 'eslint',
    packages: { npm: 'eslint' },
  },
  {
    canonical: 'black',
    packages: { pip: 'black' },
  },
  {
    canonical: 'ruff',
    packages: { brew: 'ruff', pip: 'ruff', cargo: 'ruff' },
  },
  {
    canonical: 'mypy',
    packages: { pip: 'mypy' },
  },

  // --- Misc dev tools ---
  {
    canonical: 'direnv',
    packages: { brew: 'direnv', apt: 'direnv', dnf: 'direnv', pacman: 'direnv' },
  },
  {
    canonical: 'watchexec',
    packages: { brew: 'watchexec', pacman: 'watchexec', cargo: 'watchexec-cli' },
  },
  {
    canonical: 'just',
    packages: { brew: 'just', pacman: 'just', cargo: 'just' },
  },
  {
    canonical: 'act',
    packages: { brew: 'act', pacman: 'act', choco: 'act-cli', winget: 'nektos.act' },
  },
  {
    canonical: 'age',
    packages: { brew: 'age', apt: 'age', pacman: 'age' },
  },
  {
    canonical: 'sops',
    packages: { brew: 'sops', pacman: 'sops' },
  },
  {
    canonical: 'pre-commit',
    packages: { brew: 'pre-commit', pip: 'pre-commit' },
  },
  {
    canonical: 'tldr',
    packages: { brew: 'tldr', apt: 'tldr', npm: 'tldr', pip: 'tldr', cargo: 'tealdeer' },
  },
  {
    canonical: 'gh-dash',
    packages: { brew: 'gh-dash' },
  },
  {
    canonical: 'stow',
    packages: { brew: 'stow', apt: 'stow', dnf: 'stow', pacman: 'stow' },
  },
  {
    canonical: 'rsync',
    packages: { brew: 'rsync', apt: 'rsync', dnf: 'rsync', pacman: 'rsync' },
  },
  {
    canonical: 'unzip',
    packages: { brew: 'unzip', apt: 'unzip', dnf: 'unzip', pacman: 'unzip' },
  },
];

export function loadMappings(config: any): PackageMapping[] {
  const userMappings: PackageMapping[] = config?.package_mappings ?? [];

  if (userMappings.length === 0) return defaultMappings;

  // Index defaults by canonical name for merging
  const merged = new Map<string, PackageMapping>();
  for (const m of defaultMappings) {
    merged.set(m.canonical, { ...m, packages: { ...m.packages } });
  }

  // User overrides win: merge package entries, add new canonicals
  for (const m of userMappings) {
    const existing = merged.get(m.canonical);
    if (existing) {
      Object.assign(existing.packages, m.packages);
    } else {
      merged.set(m.canonical, { ...m, packages: { ...m.packages } });
    }
  }

  return Array.from(merged.values());
}
