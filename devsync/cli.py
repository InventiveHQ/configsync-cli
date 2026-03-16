"""Command-line interface for DevSync"""

import click
import sys
from pathlib import Path
from rich.console import Console
from rich.table import Table
from rich.tree import Tree
from rich import print as rprint

from .core import DevSync
from .providers import BuiltinProvider
from .providers.keyring_provider import KeyringProvider
from .providers.onepassword import OnePasswordProvider

console = Console()


@click.group()
@click.pass_context
def cli(ctx):
    """DevSync - Sync your development environment between machines"""
    ctx.ensure_object(dict)
    ctx.obj['devsync'] = DevSync()


@cli.command()
@click.option('--profile', default='default', help='Profile name')
@click.option('--sync-backend', default='local',
              type=click.Choice(['local', 'cloud', 's3', 'github', 'dropbox']),
              help='Sync backend to use')
@click.option('--secret-provider', default='builtin',
              type=click.Choice(['builtin', 'keyring', '1password', 'bitwarden']),
              help='Secret storage provider')
@click.pass_context
def init(ctx, profile, sync_backend, secret_provider):
    """Initialize DevSync on this machine"""
    ds = ctx.obj['devsync']

    try:
        config = ds.init(profile, sync_backend)
        config['secrets']['provider'] = secret_provider

        ds.save_config(config)

        console.print(f"✅ Initialized DevSync profile: [bold]{profile}[/bold]")
        console.print(f"📁 Config location: {ds.config_file}")
        console.print(f"🔐 Secret provider: {secret_provider}")
        console.print(f"☁️  Sync backend: {sync_backend}")

    except Exception as e:
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@cli.command()
@click.option('--token', prompt=False, default=None, help='API token from configsync.dev dashboard')
@click.option('--api-url', default='https://configsync.dev', help='API URL')
@click.pass_context
def login(ctx, token, api_url):
    """Authenticate with ConfigSync cloud"""
    ds = ctx.obj['devsync']

    if not token:
        token = click.prompt('API token (from configsync.dev/settings)', hide_input=True)

    try:
        from .backends.cloud import CloudAuthenticator
        if not CloudAuthenticator.verify_token(token, api_url):
            console.print("[red]Error:[/red] Invalid or expired token")
            sys.exit(1)

        # Store token in config
        config = ds.load_config()
        config['sync']['backend'] = 'cloud'
        config['sync']['config']['api_url'] = api_url
        config['sync']['config']['api_key'] = token
        ds.save_config(config)

        console.print("✅ Authenticated successfully!")
        console.print(f"  Backend set to: cloud ({api_url})")
    except FileNotFoundError:
        console.print("[red]Error:[/red] Run 'devsync init' first")
        sys.exit(1)
    except Exception as e:
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@cli.command()
@click.pass_context
def logout(ctx):
    """Remove stored credentials"""
    ds = ctx.obj['devsync']

    try:
        config = ds.load_config()
        config['sync']['config'].pop('api_key', None)
        config['sync']['backend'] = 'local'
        ds.save_config(config)
        console.print("✅ Logged out. Backend reset to local.")
    except Exception as e:
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@cli.group()
@click.pass_context
def add(ctx):
    """Add items to track"""
    pass


@add.command('repo')
@click.argument('url')
@click.argument('path')
@click.option('--branch', default='main', help='Default branch')
@click.option('--no-auto-pull', is_flag=True, help='Disable automatic pulling')
@click.pass_context
def add_repo(ctx, url, path, branch, no_auto_pull):
    """Add a git repository to track"""
    ds = ctx.obj['devsync']

    try:
        repo = ds.add_repo(url, path, branch, not no_auto_pull)
        console.print(f"✅ Added repo: [cyan]{url}[/cyan] → [green]{path}[/green]")
    except Exception as e:
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@add.command('env')
@click.argument('project_path')
@click.option('--filename', default='.env.local', help='Environment filename')
@click.pass_context
def add_env(ctx, project_path, filename):
    """Add an environment file to track"""
    ds = ctx.obj['devsync']

    try:
        env = ds.add_env_file(project_path, filename)
        full_path = Path(project_path).expanduser() / filename
        console.print(f"✅ Added env file: [green]{full_path}[/green]")
    except Exception as e:
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@add.command('config')
@click.argument('path')
@click.option('--encrypt/--no-encrypt', default=False, help='Encrypt this config')
@click.option('--exclude', multiple=True, help='Patterns to exclude')
@click.pass_context
def add_config(ctx, path, encrypt, exclude):
    """Add a configuration file or directory to track"""
    ds = ctx.obj['devsync']

    try:
        config = ds.load_config()
        config_item = {
            "source": path,
            "encrypt": encrypt,
            "exclude_patterns": list(exclude)
        }
        config["configs"].append(config_item)
        ds.save_config(config)

        console.print(f"✅ Added config: [green]{path}[/green]")
        if encrypt:
            console.print("  🔒 Will be encrypted")
        if exclude:
            console.print(f"  ⚠️  Excluding: {', '.join(exclude)}")
    except Exception as e:
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@cli.group()
@click.pass_context
def secret(ctx):
    """Manage secrets"""
    pass


@secret.command('set')
@click.argument('key')
@click.option('--value', help='Secret value (will prompt if not provided)')
@click.pass_context
def secret_set(ctx, key, value):
    """Store a secret"""
    ds = ctx.obj['devsync']

    try:
        result = ds.set_secret(key, value, interactive=value is None)
        console.print(f"✅ Secret stored: [cyan]{key}[/cyan]")
    except Exception as e:
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@secret.command('get')
@click.argument('key')
@click.option('--show', is_flag=True, help='Show the actual value')
@click.pass_context
def secret_get(ctx, key, show):
    """Retrieve a secret"""
    ds = ctx.obj['devsync']

    try:
        value = ds.get_secret(key)
        if value:
            if show:
                console.print(f"{key}: {value}")
            else:
                console.print(f"✅ Secret exists: [cyan]{key}[/cyan]")
                console.print("  Use --show to display value")
        else:
            console.print(f"[yellow]Secret not found:[/yellow] {key}")
    except Exception as e:
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@secret.command('list')
@click.pass_context
def secret_list(ctx):
    """List stored secrets"""
    ds = ctx.obj['devsync']

    try:
        # Get secrets based on provider
        config = ds.load_config()
        provider = config['secrets']['provider']

        if provider == 'builtin':
            secrets_file = ds.config_dir / "secrets.enc"
            if secrets_file.exists():
                import json
                with open(secrets_file, 'rb') as f:
                    secrets = json.loads(ds.crypto.decrypt(f.read()))
                    keys = list(secrets.keys())
            else:
                keys = []
        else:
            # Would use provider-specific listing
            keys = []

        if keys:
            console.print("🔑 Stored secrets:")
            for key in sorted(keys):
                console.print(f"  • {key}")
        else:
            console.print("[yellow]No secrets stored[/yellow]")

    except Exception as e:
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@cli.command()
@click.option('--message', '-m', help='Push message')
@click.pass_context
def push(ctx, message):
    """Push current environment state"""
    ds = ctx.obj['devsync']

    with console.status("[bold green]Pushing state...") as status:
        try:
            state = ds.push(message)

            console.print("✅ [bold green]State pushed successfully![/bold green]")
            console.print(f"  📦 {len(state['repos'])} repositories")
            console.print(f"  ⚙️  {len(state['configs'])} config files")
            console.print(f"  🔧 {len(state['env_files'])} env files")
            console.print(f"  ⏰ {state['timestamp']}")

        except Exception as e:
            console.print(f"[red]Error:[/red] {e}")
            sys.exit(1)


@cli.command()
@click.option('--force', is_flag=True, help='Force overwrite local files')
@click.pass_context
def pull(ctx, force):
    """Pull and restore environment state"""
    ds = ctx.obj['devsync']

    with console.status("[bold green]Pulling state...") as status:
        try:
            results = ds.pull(force)

            console.print("✅ [bold green]State pulled successfully![/bold green]")

            if results['repos_cloned']:
                console.print(f"  📥 Cloned {len(results['repos_cloned'])} repos")
                for repo in results['repos_cloned']:
                    console.print(f"     • {repo}")

            if results['repos_updated']:
                console.print(f"  🔄 Updated {len(results['repos_updated'])} repos")

            if results['configs_restored']:
                console.print(f"  ⚙️  Restored {len(results['configs_restored'])} configs")

            if results['env_files_restored']:
                console.print(f"  🔧 Restored {len(results['env_files_restored'])} env files")

            if results['warnings']:
                console.print("\n[yellow]⚠️  Warnings:[/yellow]")
                for warning in results['warnings']:
                    console.print(f"  • {warning}")

        except Exception as e:
            console.print(f"[red]Error:[/red] {e}")
            sys.exit(1)


@cli.command()
@click.pass_context
def status(ctx):
    """Show current sync status"""
    ds = ctx.obj['devsync']

    try:
        status = ds.status()

        # Create a tree view
        tree = Tree(f"[bold]DevSync Status[/bold] (Profile: {status['profile']})")

        # Repos section
        repos_branch = tree.add("📦 Git Repositories")
        for repo in status['repos']:
            if repo['exists']:
                icon = "✅" if repo.get('clean') else "⚠️"
                branch = repo.get('branch', 'unknown')
                repos_branch.add(f"{icon} {repo['path']} [{branch}]")
            else:
                repos_branch.add(f"❌ {repo['path']} (not cloned)")

        # Configs section
        configs_branch = tree.add("⚙️  Config Files")
        for cfg in status['configs']:
            icon = "✅" if cfg['exists'] else "❌"
            lock = "🔒" if cfg['encrypted'] else ""
            configs_branch.add(f"{icon} {cfg['path']} {lock}")

        # Env files section
        if status['env_files']:
            env_branch = tree.add("🔧 Environment Files")
            for env in status['env_files']:
                icon = "✅" if env['exists'] else "❌"
                lock = "🔒" if env['encrypted'] else ""
                env_branch.add(f"{icon} {env['path']} {lock}")

        # Secrets section
        if status['secrets']:
            secrets_branch = tree.add(f"🔑 Secrets ({len(status['secrets'])} stored)")
            for secret in status['secrets'][:5]:  # Show first 5
                secrets_branch.add(secret)
            if len(status['secrets']) > 5:
                secrets_branch.add(f"... and {len(status['secrets']) - 5} more")

        rprint(tree)

    except Exception as e:
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


def main():
    """Main entry point"""
    cli(obj={})


if __name__ == '__main__':
    main()