# ConfigSync CLI - Development Notes

Last updated: 2026-04-08

## Project Overview

ConfigSync is a developer tool for syncing development environments, configurations, and secrets across machines. This repository is the command-line client distributed as `@inventivehq/configsync` on npm. It talks to the ConfigSync Web API (`configsync-web/`) for auth, state storage, and metadata, and it encrypts all sensitive content locally before upload.

## Tech Stack

- **Language**: TypeScript, ES modules (`"type": "module"`)
- **Runtime**: Node.js >= 18
- **Build**: `tsc` → `dist/`
- **Entry point**: `bin/configsync.js` → `dist/index.js`
- **CLI framework**: `commander` v12
- **YAML**: `js-yaml`
- **Diff**: `diff`
- **Crypto**: Node built-in `node:crypto` + `tweetnacl` (X25519 sealed boxes)
- **Tests**: `vitest`
- **Distribution**: `@inventivehq/configsync` on npm

No libsodium, no Python, no native deps beyond what ships with Node.

## Repository Layout

```
configsync-cli/
├── bin/configsync.js          # shim that loads dist/index.js
├── src/
│   ├── index.ts               # CLI entrypoint, wires up commander
│   ├── commands/              # one file per verb/noun
│   │   ├── add.ts, init.ts, login.ts, logout.ts
│   │   ├── project.ts, profile.ts, vars.ts, secret.ts
│   │   ├── push.ts, pull.ts, sync.ts, watch.ts
│   │   ├── status.ts, list.ts, history.ts, diff.ts, remove.ts
│   │   ├── env.ts, machine.ts, scan.ts, setup.ts
│   │   ├── doctor.ts, completions.ts
│   │   └── index.ts           # command registry
│   └── lib/                   # shared libraries
├── dist/                      # tsc output (gitignored)
└── package.json
```

The split is intentional: **`commands/` is thin glue** that parses flags, prompts the user, and delegates to **`lib/`**, which holds the real logic. Commands should not import other commands; they import from `lib/`.

## Key Libraries (`src/lib/`)

### Crypto

- **`envelope-crypto.ts`** — the v2 envelope encryption implementation. Derives a KEK from the master password via PBKDF2-HMAC-SHA256 (600,000 iterations), generates/unwraps an X25519 keypair, and AES-256-GCMs DEKs and blobs. This is the **cross-machine fix**: every machine with the same master password derives the same KEK (server-side `kek_salt`) and therefore the same private key, so any machine can unwrap any DEK. Covered by `envelope-crypto.test.ts`.
- **`crypto.ts`** — legacy `CryptoManager` using AES-256-GCM with a **per-machine local salt** stored at `~/.configsync/.salt`. This is what the v1 CLI used; it is the root cause of the cross-machine bug (same password on two machines produced different keys). Still imported by older commands that have not been migrated to the envelope model. **New code must use `envelope-crypto.ts`.**
- **`session.ts`** — persistent session that holds the KEK-wrapped private key and a short-lived unlocked copy. Backed by `~/.configsync/session.v2.json`.
- **`dek-cache.ts`** — local cache of env-layer wrapped DEKs to avoid re-fetching on every command.

### Cloud / backend

- **`cloud-v2.ts`** — the v2 HTTP client. Talks to the new `/api/projects`, `/api/workspaces`, `/api/configs`, `/api/modules`, `/api/profiles`, `/api/auth/keypair`, `/api/*/versions`, and `/api/*/keys` routes. Bearer token auth via the existing `api_tokens` flow.
- **`cloud.ts`** — legacy HTTP client. Still used by commands that have not been ported to v2 (`scan`, some of `env`, etc.). Will be removed once migration completes.
- **`backend.ts`** — backend abstraction scaffold. The goal is for `cloud-v2.ts` and a forthcoming `FilesystemBackend` to implement a common interface so the same CLI code paths can run against a real server or a local directory tree (for tests and for future BYO storage).

### Entities

- **`entity-blob.ts`** — serialize/encrypt and decrypt/deserialize per-entity JSON blobs (projects, workspaces, configs, modules, profiles). Handles the AAD `entity_type || entity_id || version` to prevent cross-entity swap attacks.
- **`entity-sync.ts`** — 3-way sync engine. Compares `current_version` (cloud), local working copy, and `last_synced_version` (the baseline recorded in the machine link table) to classify each entity as clean / push / pull / conflict. Honors `--cloud-wins`, `--local-wins`, `--prompt`, and the fail-closed default.
- **`git-info.ts`** — reads git remote URL / branch for `configsync add project` dedupe hints.

### Local config and runtime

- **`config.ts`** — local YAML config schema at `~/.configsync/config.yaml`. Defines repos, projects, configs, env files, modules, environments, profiles, hooks, bootstrap. In v2 most of this state migrates to cloud entities, but the local file remains as the machine-side manifest.
- **`profiles.ts`** — directory-scoped overlay profiles (the legacy CLI concept): `{name, paths[], vars{}, env_overrides{}}` that auto-activate when the current directory matches. Preserved as-is in v2. **Not to be confused with the new v2 "profile entity"** (which is a container of workspaces, modules, and packages); `commands/profile.ts` will eventually host both.
- **`environment.ts`** — environment tier resolver (dev/staging/prod). Applies terminal effects (status bar, tab title, tint) when a protected tier is active.
- **`modules.ts`** — canonical module catalog (`ssh`, `vscode`, `claude-code`, `claude-desktop`, `git`, `zsh`, `vim`, `cursor`, `wrangler`, `aws`, `npm`, `docker`, …). Each module declares which files it captures.
- **`packages.ts`** / **`package-mappings.ts`** — package manager abstraction (brew, apt, dnf, pacman, winget, scoop, npm, pipx) and per-platform name mapping.
- **`package-diff.ts`** — diff the declared package set against what's currently installed.
- **`hooks.ts`** — pre/post hook execution for `push`, `pull`, and (v2) `sync`. Pre-hooks abort on failure, post-hooks warn.
- **`hash-cache.ts`** — file content hash cache at `~/.configsync/hash-cache.json` used to skip re-encryption of unchanged files.
- **`envvars.ts`** — the legacy env-injection system that writes per-project JSON to `~/.configsync/env_inject/` and renders exports via `configsync env vars --for-shell`. Being subsumed by the v2 `vars render` command.
- **`template.ts`** — machine-specific variable substitution in captured files.
- **`safety.ts`** — `requireConfirmation()` gate for destructive ops in protected environments.
- **`prompt.ts`** — master password prompt, with `CONFIGSYNC_MASTER_PASSWORD` env var resolution for non-TTY use.
- **`filter.ts`** — `--filter modules:ssh,configs` selective push/pull scoping.
- **`banner.ts`**, **`terminal.ts`** — terminal effects (background tint, tab title, status bar).
- **`concurrency.ts`** — bounded parallelism for entity fan-out.
- **`dependency-graph.ts`** — topological ordering for module/package dependencies.
- **`bootstrap.ts`** — `~/.configsync/bootstrap.sh` capture and first-pull execution.

## Development

### Build

```bash
npm install
npm run build          # tsc
npm run dev            # tsc --watch
```

### Run locally

```bash
node bin/configsync.js --help
# or, after build:
./bin/configsync.js <command>
```

### Tests

```bash
npm test               # vitest run
```

Current coverage is thin — the only committed suite is `src/lib/envelope-crypto.test.ts` (31 tests covering the v2 crypto primitives). Expanding test coverage is in scope for Wave 3 (see `configsync-web/docs/REFACTOR_V2_PLAN.md` §M.4–M.6).

## v2 Architectural Model

**Entities**. The five user-owned entity types are `project`, `workspace`, `config`, `module`, and `profile`. Each has a D1 row (thin index: id, slug, name, `current_version`, `r2_key_prefix`) and a chain of R2 blobs at `entities/{type}/{userId}/{entityId}/v{n}.enc`. Machines are **not** entities — they're hardware that subscribes to entities via `machine_*` link tables and pulls their content.

**Envelope encryption**. Every user has an X25519 keypair. The private key is wrapped by a KEK derived from the master password (PBKDF2-HMAC-SHA256, 600k iterations, server-stored salt). Every entity has a random AES-256-GCM DEK, wrapped to the user's public key via a tweetnacl sealed box. On any machine, the same password → same KEK → same private key → can unwrap any DEK → can decrypt any blob. This is what makes cross-machine sync work.

**Sync semantics**. `configsync sync` walks every linked entity and does a per-entity 3-way diff (cloud version vs local working copy vs `last_synced_version` baseline). Clean entities are skipped; one-sided changes push or pull; two-sided changes are conflicts. The default on conflict is to **fail closed** (exit code 2) with no data loss — opt in to `--cloud-wins`, `--local-wins`, or `--prompt` to resolve. Sync is per-entity, not per-machine; partial success is normal.

## Important Files On Disk

```
~/.configsync/
├── config.yaml               # local YAML config (projects, env files, hooks, ...)
├── .salt                     # legacy per-machine salt (v1, crypto.ts) — DO NOT rely on cross-machine
├── .key                      # legacy wrapped master key (v1)
├── session.v2.json           # v2 session: KEK-wrapped private key, expiry
├── env-layer-keys.json       # wrapped DEKs for shared/personal env-var layers
├── hash-cache.json           # content hash cache for skipping re-encryption
├── bootstrap.sh              # optional first-pull init script
└── env_inject/               # per-project JSON files rendered to shell exports (legacy)
```

The `.salt` / `.key` files are the v1 artifacts that made cross-machine sync impossible. v2 leaves them on disk for backwards compatibility with not-yet-migrated commands but does not use them for any new encryption.

## Common Pitfalls

1. **Cross-machine encryption was broken in v1.** Two machines with the same master password produced different keys because `.salt` was generated locally on each. Encrypted state pushed from machine A could not be decrypted on machine B, ever. The dashboard appeared to work only because unencrypted `profile.json` metadata was rendered alongside the opaque ciphertext. v2 fixes this via envelope encryption — if you're writing new crypto code, use `envelope-crypto.ts`, never `crypto.ts`.
2. **`profiles.ts` (legacy, directory overlays) and the v2 "profile entity" are different things** sharing one word. The legacy overlay stays local; the entity is a cloud-synced container of workspaces, modules, and packages. `commands/profile.ts` hosts both.
3. **`env.ts` is the environment-tier command (dev/staging/prod), not a variables command.** The new structured variables live in `commands/vars.ts`. Do not collide their namespaces.
4. **Commands must not import each other.** Shared logic belongs in `lib/`. Breaking this rule creates dependency loops when testing.
5. **The `cloud.ts` / `cloud-v2.ts` split is transitional.** Prefer `cloud-v2.ts` for anything new; `cloud.ts` exists only for commands that have not yet been ported.
6. **`requireConfirmation()` gates destructive ops in protected environments.** Don't bypass it. Production tier uses red terminal effects for a reason.
7. **Hash cache is per-file-path, not per-entity.** Moving a file invalidates its entry. Don't hand-edit the cache file.

## Guidelines

- **Git commits**: never mention "Claude", "AI", or "assistant" in commit messages. Write commits as if you are the developer. This rule applies to every commit in this repo regardless of who authored the change.
- **Do not add dependencies casually.** The current dependency tree (chalk, commander, diff, js-yaml, ora, tweetnacl) is small on purpose. If you need a new dep, justify it.
- **Do not remove `crypto.ts` yet.** It will be deleted in a dedicated cleanup pass once every command has migrated to the envelope model (see Wave 3 §M.7).
- **Prefer `async`/`await` over callbacks.** The codebase is uniformly async.
- **Errors exit with codes**: `0` clean, `1` general error, `2` sync conflict with no strategy, `3` auth failure. Keep these stable — scripts and CI rely on them.

## Related Repositories

- `configsync-web/` — Next.js + Cloudflare Workers backend (D1, R2, API routes, dashboard). The source of truth for the v2 schema and the API contract this CLI consumes. See `configsync-web/docs/REFACTOR_V2_PLAN.md` for the full v2 plan and `configsync-web/docs/ARCHITECTURE.md` for the conceptual model.
- `configsync-plugins/` — plugin packages (effectively empty, out of scope for v2).

## GitHub Repository

https://github.com/InventiveHQ/configsync-cli
