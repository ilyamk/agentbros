# Project Node runtime

Last updated: 2026-11-18

The primary runtime is **Node 26.13.1**, with **24.22.3** as the explicitly tested reserve. `package.json` is the policy source: `config.nodePrimary` selects the primary, `config.nodeFallback` names the reserve, and `engines.node` accepts any release of those two majors. `.nvmrc` and `.nvmrc.fallback` must match; runtime tests reject drift.

Accepted range (2026-11-16): any release of either major (`^26.0.0 || ^24.0.0` in `engines`) runs CLIs, MCP and contribution tools as role `compatible`, with one stderr warning per command because CI tests only the exact pins; `preflight` reports it as a warning and `runtime:check` still requires the exact pin. Other majors are refused with a hint to run `nvm install && nvm use` (reads `.nvmrc`). The pre-push hook switches to `.nvmrc` through nvm when the shell default is another major, and prints the leak check's reason when it blocks a push.

nvm must already be installed, or provision the exact Node version with its official installer. Noninteractive agent shells can load the existing nvm script explicitly; they must not assume an interactive shell function was inherited.

## Normal installation and execution

```bash
. "$HOME/.nvm/nvm.sh" # when nvm is not already loaded
nvm install && nvm use
npm install --global pnpm@12.21.0 --allow-scripts=pnpm
pnpm install --frozen-lockfile
pnpm runtime:check
pnpm preflight
```

pnpm is pinned separately through `packageManager`. nvm (locally) and setup-node (CI) select Node before pnpm runs. Corepack is not required. Enable the exact trusted pnpm bootstrap's lifecycle scripts: disabling them can leave a shell-only placeholder that fails direct process execution. Repository dependency installs in CI still use `--ignore-scripts` and ignore the pnpmfile. `engineStrict` checks dependency engine compatibility. The common production/offline CLI runners refuse versions outside the accepted range before loading task inputs or `.env`; `AGENTBROS_NO_DOTENV=1` skips `.env` entirely (tests set it).

`runtime:check` reports the actual executable and checks children launched through both `process.execPath` and bare `node`, plus direct `pnpm --version` execution without a shell. Primary mode is the default; a reserve check must explicitly request `--expected fallback`. `preflight` labels a supported reserve as a warning. These checks inspect actual processes, not a claimed environment version.

On this development machine the nvm default is 26.13.1 and `agentbros-fallback` is 24.22.3. Shell startup honours the configured default instead of choosing the newest installed directory. Existing applications/agent processes retain their inherited PATH until restarted; their project commands must pass the exact runtime check. Other installed Node versions are retained for other projects.

## Reserve installation

Use a separate checkout or worktree to test the reserve independently:

```bash
git worktree add --detach ../agentbros-node24 main
cd ../agentbros-node24
. "$HOME/.nvm/nvm.sh"
nvm install 24.22.3 && nvm use 24.22.3
npm install --global pnpm@12.21.0 --allow-scripts=pnpm
pnpm install --frozen-lockfile
pnpm runtime:check --expected fallback
pnpm check
```

The project intentionally does not install Node into `node_modules`: both supported versions are selected explicitly before dependency installation. A pnpm-managed Node can remain linked even after changing shell PATH or reinstalling with `--no-runtime`, making a claimed Node 24 test run on 26. If migrating an old checkout containing that experimental runtime, use a fresh dependency installation and check the actual role. Never silently relabel such a run accepted.

In CI both runtime roles have independent fresh installations for lint/types, four full-suite shards, browser/render and macOS worker checks. setup-node reads `.nvmrc` or `.nvmrc.fallback`; every job verifies its actual role and child Node before checks. Other workflows use the primary pin and explicit pnpm bootstrap.

## Updates and verification

Update the primary or reserve pin as one reviewed change: package metadata, matching nvm file, dependency installation, notices and documentation. Bootstrap versions in workflow/install examples must match `packageManager`; tests guard them. Avoid ranges such as `latest`, `26` or `>=20` for the development runtime.

Validate frozen installs with lifecycle scripts enabled locally, dependency engines, lint/type checks, full tests, browser/render, MCP and child-process behaviour, plus installed native workers on both runtimes. Preserve a reproducible baseline for failures caused by absent historical external evidence; do not repin old evidence or call skipped tests accepted. A runtime upgrade does not itself establish semantic/creative quality of Apple models.

Official references: [Node 26.13.1](https://nodejs.org/en/blog/release/v26.13.1), [Node 24.22.3](https://nodejs.org/en/blog/release/v24.22.3), [pnpm engine checks](https://pnpm.io/package_json#engines).
