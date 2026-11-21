# Install and update

Last updated: 2026-11-18

How to clone Agent Bros. Pictures, install everything it needs, check the result, and keep the copy current with the upstream repository. Written for a person or for a coding agent (Claude Code, Codex) acting for one. An agent runs each command, reads its output, and stops to ask the user where this page says so.

**Fast path:** [SETUP.md](../SETUP.md). `./setup.sh` (Windows: `./setup.ps1`) plans every step below with its scope, `--apply` runs the approved ones, and `out/setup/REPORT.md` tells the user what works, this machine's limits and which keys unlock what. This page is the manual reference behind it.

## 1. Prerequisites

| Tool | Needed for | macOS | Debian / Ubuntu | Windows |
|---|---|---|---|---|
| git | cloning and updates | `xcode-select --install` | `sudo apt-get install -y git` | `winget install Git.Git` |
| Node.js 26.13.1 (24.22.3 reserve) | everything | `nvm install && nvm use` | `nvm install && nvm use` | Install the exact `.nvmrc` version with nvm-windows |
| pnpm (pinned in `package.json`) | everything | `npm install --global pnpm@12.21.0 --allow-scripts=pnpm` | `npm install --global pnpm@12.21.0 --allow-scripts=pnpm` | `npm install --global pnpm@12.21.0 --allow-scripts=pnpm` |
| FFmpeg + ffprobe | rendering, audio, QA | `brew install ffmpeg` | `sudo apt-get install -y ffmpeg` | `winget install Gyan.FFmpeg` |
| Chromium | rendering | downloaded by Remotion | downloaded by Remotion, plus its system libraries (`pnpm preflight` prints the apt line) | downloaded by Remotion |
| uv ≥0.13.9 | Python workers (audio maps, reference analysis, local speech) | `brew install uv` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` | `winget install astral-sh.uv` |

Exact primary/reserve versions are recorded in `package.json` and checked against the nvm version files; CI tests only those. CLIs also accept any other 26.x or 24.x release with a stderr warning, and refuse anything else. Read [Node runtime](node-runtime.md) before selecting the Node 24 reserve.

Optional extras, each probed by `pnpm preflight` or `pnpm backend --action probe --backend <name>`: Blender 4.2+/5.x (photoreal 3D, simulations), yt-dlp (reference downloads; the locked uv profile fetches it on first use), DaVinci Resolve 19/20 (finishing handoff), whisper.cpp (offline speech, prepared with `pnpm media:prepare`), Xcode command-line tools / `swiftc` (macOS Vision workers).

**Agents:** installing system software (Homebrew, apt, winget) changes the user's machine. Ask before running those lines; the repository commands below are safe to run.

## 2. Clone and install

```bash
git clone https://github.com/ilyamk/agentbros.git
cd agentbros
. "$HOME/.nvm/nvm.sh" # if nvm is not already loaded
nvm install && nvm use
npm install --global pnpm@12.21.0 --allow-scripts=pnpm
pnpm install --frozen-lockfile
uv python install      # exact .python-version pin
uv sync --locked       # developer tools only; workers install their selected group
pnpm preflight          # Node, pnpm, packages, FFmpeg, Chromium, uv, optional backends, which keys are set
pnpm assets:sync --all  # optional: shared HDRIs, 3D models and sounds (otherwise fetched on demand)
```

To contribute, fork on GitHub first and clone your fork instead; section 5 adds the original as `upstream`.

- `pnpm preflight` prints a readable report on stderr and one JSON line on stdout, and exits non-zero only when a required check fails. It runs from the installed packages, so install first. It is a script alias rather than `pnpm doctor`, which is pnpm's own command.
- Media files are not in git. `pnpm assets:sync` downloads or rebuilds them from committed manifests into git-ignored folders and checks each sha256 ([assets](assets.md)).

Python dependencies, isolated worker groups and Blender/SDK exceptions: [Python runtime](python-runtime.md).

## 3. Keys (optional)

Copy `.env.example` to `.env` and fill in only what the user needs. Nothing here is required for local rendering or tests; `pnpm preflight` reports which keys are set, never their values. **Agents never ask the user to paste a key into the chat**: the user edits `.env` themselves.

| Key | Cost | Unlocks |
|---|---|---|
| `ELEVENLABS_API_KEY` | paid | voiceover, music, sound effects, transcription, caption alignment |
| `FAL_KEY` | paid | image and video generation, music, background removal, upscaling |
| `HIGGSFIELD_API_KEY` | paid | Higgsfield image and video models (Seedance, Kling, Genjutsu, Soul); key ID and secret joined by a colon ([Higgsfield](higgsfield.md)) |
| `PEXELS_API_KEY`, `PIXABAY_API_KEY`, `UNSPLASH_ACCESS_KEY` | free | stock photos and video (Unsplash: photos only; paste only its Access Key) |
| `FREESOUND_API_KEY` (`FREESOUND_OAUTH_TOKEN` for originals) | free | sound effects |
| `JAMENDO_CLIENT_ID` | free | stock music (non-commercial tier) |
| `OPENVERSE_*` | free | higher Openverse limits (works anonymously) |
| `POLY_PIZZA_API_KEY`, `SI_API_KEY` | free | 3D model catalogues for Blender |
| `HF_TOKEN` | free | local speaker diarisation (pyannote) |
| `RAPIDAPI_KEY`, `APIFY_TOKEN` | paid | fallback downloads of public social references |

`pnpm keys` lists them with sign-up links and which are set; `pnpm keys --goal voiceover,music` answers "what do I need for this" with the free alternatives. The list lives in `src/lib/setup/keys.ts`, and a test keeps it equal to `.env.example`.

Paid generation always uses the user's own provider accounts behind per-project budgets ([paid execution](paid-execution.md)).

## 4. Check the install

```bash
pnpm exec remotion browser ensure # once: downloads Remotion's Chromium, needed by render and vision tests
uv run --locked pnpm test:fast # pinned Python also reaches Node child tests
uv run --locked pytest -q     # pure Python helpers
```

Tests never load `.env`: the test import sets `AGENTBROS_NO_DOTENV=1`, which every CLI honours, so child processes see no real keys. Set it yourself to run a CLI without `.env`. Spawned-process deadlines default to 30 s; raise them on a slow machine with `AGENTBROS_TEST_SPAWN_TIMEOUT_MS`.

Then the offline first video, with no keys and no service calls:

```bash
pnpm exec tsx examples/workflows/product-ad/prepare-local-demo.ts --directory /tmp/product-ad-local-demo
pnpm exec tsx examples/workflows/product-ad/run-local.ts --request /tmp/product-ad-local-demo/product-ad-request.json --action plan
pnpm exec tsx examples/workflows/product-ad/run-local.ts --request /tmp/product-ad-local-demo/product-ad-request.json --action create
pnpm render --project synthetic-product-ad --timeline --captions on --format vertical
```

The rendered file path is in the JSON `outputs` of the last command; `pnpm project:remove synthetic-product-ad --yes` removes it. The suite matrix and environment gates are in [tests/AGENTS.md](../tests/AGENTS.md).

| Command | Runs |
|---|---|
| `pnpm test:fast` | quick unit suite for local runs; CI runs the full suite in shards |
| `pnpm check` | repo hygiene + Python checks + format check + lint + typecheck + full default suite (slow) |
| `pnpm test:render` | synthetic local render |
| `pnpm test:browser` | browser, review UI and QA evidence suites |
| `pnpm test:workflows` | workflow renders |

## 5. Stay current with upstream

The user's work survives updates because it never lives in tracked files: projects, renders, caches and memory sit in git-ignored folders (`public/projects/`, `src/projects/`, `out/`, `.cache/`, `memory/`, `.env`). Updating only replaces the harness.

Once, in a fork (a plain clone already has the original as `origin`):

```bash
git remote add upstream https://github.com/ilyamk/agentbros.git
```

Each update:

```bash
git status --porcelain                 # must be empty; otherwise stop and ask the user what to do with local edits
git fetch upstream                     # or: git fetch origin, in a plain clone
git merge --ff-only upstream/main      # or: origin/main
pnpm install --frozen-lockfile
pnpm preflight
pnpm test:fast
```

- If `--ff-only` fails, the copy has its own commits. Do not rebase, reset or force anything on the user's behalf: report the divergence and ask whether to merge.
- If a pulled change touched an asset manifest, rerun `pnpm assets:sync --all`.
- Never run `git clean -X` here: it also deletes `.env`, `node_modules` and the user's projects. Cleanup has its own commands (root `AGENTS.md`, *Project cleanup*).
- After an update, read the root [AGENTS.md](../AGENTS.md) again: rules and commands change with the code.

## 6. Send improvements back

A fix or rule that should help everyone goes upstream as a pull request ([CONTRIBUTING.md](../CONTRIBUTING.md), with a signed [CLA](../CLA.md)). For a lesson learned from the user's own work, `pnpm memory:upstream` exports the commits as patches with a generalised description, leak-scanned against the user's memory; it never pushes or opens a pull request itself.

## Where to go next

- [AGENTS.md](../AGENTS.md): the rules every agent follows, and the first step of any video request
- [playbooks](../playbooks/AGENTS.md): the kinds of video and their methods
- [production chain](production-chain.md): the bespoke film steps
- [footage editing](footage-editing.md): a user's own recording

## Optional local Apple tools

On macOS, preflight discovers prepared native tasks without model generation, downloads or system prompts. Start with `pnpm local:capabilities`; ordinary command discovery hides unready Apple-only variants. Preparation, interaction/download policy and task-specific alternatives are in [local macOS](local-macos.md). There is no install-time model download or new macOS application.
