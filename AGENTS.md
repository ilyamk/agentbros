# Agent Bros. Pictures — Agent Rules

Last updated: 2026-11-18

Remotion 4 · React 19 · TypeScript · Tailwind CSS v4 · pnpm · Node 26.13.1 (reserve 24.22.3). **vertical** 1080×1920, **square** 1080×1080, **landscape** 1920×1080, 30fps.

## Start here

Every video request starts with its **playbook**, the kind of video with its method, quality bar and tools (index: [playbooks](playbooks/AGENTS.md), `pnpm playbook --list`).

1. **Choose**: `pnpm playbook --match "<the user's request>"`, then read the candidates' `playbooks/<id>/AGENTS.md`. Ask the user when weak or tied; none fits: proceed by route ([no playbook](playbooks/AGENTS.md)); a `modifiers` entry adds the reference row below.
2. **Bind and start**: follow the playbook's `Start` block. Pass a short `--title` to `film:init` or `project:new`. For an existing project use `pnpm playbook --use <pb> --project <id>`.
3. **Proceed**: Run `pnpm next --project <id>` (or `film:next`/`footage:next`) and repeat, reading only its `read` list, playbook first. On start or resume, open `console.url` in the built-in browser, reusing the dashboard tab and verifying the project. If unavailable, share the link or report the error. At a Claude Code gate, background `pnpm console:wait --project <id>` unless `hooks.claude` is `installed`.

| Also | Do this |
|---|---|
| A film in the style of a reference (any playbook) | `reference-to-video` skill: `pnpm ref:add`, `ref:analyze`, then the playbook's start |
| Copy a given film exactly (only on the user's explicit ask) | `reference-replica` skill: `film:init --type replica`, `film:rights`, then `film:next` |
| The user's own recording (any playbook) | Transcribe only with `transcribe` (paid) or `speech:local` (free); `caption-editor` is for generated voiceover only. The user approves plans before anything is made or paid for |
| An existing project | `pnpm next --project <id>` (`project.json`: render, QA, delivery; old `pipeline-state.json` ignored) |
| Improving the harness from a fork | [contrib/AGENTS.md](contrib/AGENTS.md); gates in [CONTRIBUTING.md](CONTRIBUTING.md) |
| A quick edit, re-render or asset swap | Directly, no playbook: `pnpm render` (project.json), `pnpm film:render --composition <id>` (bespoke film) |
| Developing the software | [Architecture](docs/architecture.md) first (a structural change updates it and its date), then the area's `AGENTS.md`; production gates do not bind authorised software work |

Start visuals with the motion library (`pnpm library:list`, `motion-library`); new scene code only for missing blocks. 3D/Blender/Vork (`engine-selection`, `blender-3d`, `vork-3d-vfx`) and real product UI (`capture:app`) are material/build tools, not routes.

## Instruction files

Instructions live only in `AGENTS.md` files. The root `CLAUDE.md` is the one-line import `@AGENTS.md`, kept only so Claude Code loads this file; never add another (nested, `.claude/CLAUDE.md`, `CLAUDE.local.md`).

Run Codex and Claude Code from the repository root: they load this file only; nested files are opened, not auto-loaded. Before changing an area's code or docs, open its `AGENTS.md`.

| Working on | Read |
|---|---|
| CLI scripts, command catalogue, adding a command | [scripts](scripts/AGENTS.md) |
| [Python runtime](docs/python-runtime.md), Swift workers; Blender kit and shots | [scripts/workers](scripts/workers/AGENTS.md), [scripts/blender](scripts/blender/AGENTS.md) |
| Domain libraries: providers, paid jobs, budgets, delivery, tokens and fonts, external APIs | [src/lib](src/lib/AGENTS.md) |
| Bespoke film chain: steps, routes, briefs, approvals | [src/lib/film](src/lib/film/AGENTS.md) |
| Audio analysis, mixing, sync maps, music structure, SFX | [src/lib/audio](src/lib/audio/AGENTS.md) |
| Zod schemas and artefact contracts | [src/types](src/types/AGENTS.md) |
| MCP bridge: tools, exclusions, safety | [src/mcp](src/mcp/AGENTS.md) |
| Templates, text components, backgrounds, device mockups, left panels, **talking-head videos** | [src/templates](src/templates/AGENTS.md) |
| Compositions and scene components | [src/components](src/components/AGENTS.md) |
| Motion primitives and Motion Lab examples | [src/motion](src/motion/AGENTS.md) |
| Motion library blocks: adding or changing one | [src/motion/library](src/motion/library/AGENTS.md) |
| Tests, fixtures, environment-gated suites | [tests](tests/AGENTS.md) |
| Playbooks: kinds of video, their method and tools; adding one | [playbooks](playbooks/AGENTS.md) |
| Guides, RFCs, verification evidence | [docs](docs/AGENTS.md) |
| Visual references and the design system | [design-reference](design-reference/AGENTS.md) |
| Studio console UI ([guide](docs/console.md)) | [apps/console](apps/console/AGENTS.md) |
| GitHub workflows and automation | [docs/github.md](docs/github.md) |
| The user's local memory | [memory](memory/AGENTS.md) |

Skills and leaf agents are canonical in `.agents/` (index: [.agents/agents/README.md](.agents/agents/README.md); vendored: [.agents/skills/THIRD_PARTY.md](.agents/skills/THIRD_PARTY.md)); `.claude/skills` and `.claude/agents` are links to them, never a second copy; other harnesses: `pnpm harness:setup`. `.agents/` has no `AGENTS.md`. Use the configured harness model and existing approvals.

### Keeping these files current

- Update the nearest `AGENTS.md` with a described change and date only files changed that day; detail belongs below.
- Credit sources in `credits/<id>.json`; run `pnpm credits:write-doc` and retain block `inspiredBy`.
- Read [instruction maintenance](docs/AGENTS.md#keeping-agentsmd-files-current) for size budgets, indexes, credits, playbook names and checks.

## Repository map

```
.agents/{agents,skills}/  canonical agents and skills
public/projects/{id}/  project config, pipeline and media (git-ignored)
public/shared/  shared media, fonts, models and manifests
src/Root.tsx  Remotion compositions
src/motion/  library/ blocks (docs/library/catalogue.json); sync/ beat grid, <CueSounds>; gsap.ts, the only GSAP import
src/components/  compositions and scenes
src/templates/  text, effects, backgrounds, talkinghead, leftpanel
src/lib/  domain libraries and CLI helpers
src/mcp/, src/types/  MCP bridge; Zod schemas
src/projects/  project code (git-ignored)
scripts/  CLIs; workers/ native helpers; blender/ studio kit
ui-sources/, workers/, vendor/hyperframes/  shadcn scratch; Resolve worker; seek adapter
apps/console/  studio console UI
examples/workflows/  video:workflow examples
tests/  node:test suites and fixtures
playbooks/{id}/  video methods, quality bars and tools
docs/  guides, rfcs/, plans; how-it-works.md for humans
contrib/, .changes/, credits/  contribution gates, release entries, credit sources
bench/, showcases/, community/, site/  benchmarks, gallery, profiles, site builder
.github/  workflows, issue forms and PR automation
design-reference/  design system and visual references
out/{id}/  renders; out/qa evidence (git-ignored)
memory/  local memory (git-ignored)
```

**Asset paths:** `staticFile("projects/{id}/music/bg.mp3")`, `staticFile("shared/images/logo.png")`

## Learning loop

The orchestrator runs two:

- **Memory (local):** at each user verdict, delivery and tool workaround, `pnpm memory --add`: the user's words as decision, preference or lesson; an agent's view as observation; a workaround as gap; a delivery as episode. Read the `memory` field of next-step answers ([memory](memory/AGENTS.md)).
- **System (tracked):** a problem seen twice (`pnpm memory --consolidate`) becomes a proposed change to a sensor, rule, playbook or tool ([creative-postmortem](.agents/skills/creative-postmortem/SKILL.md)): on the user's go-ahead, with a test. No personal data in tracked files.

## Design principles

Starting points, not law. Justify each choice by this video's idea and rhythm. Hard limits: determinism and the technical rules below.

- **Idea first.** Restraint and maximalism are both valid. Structure follows the idea; no arc is mandatory.
- **Typography carries the message**: hierarchy must read at playback size. Defaults in `src/lib/design-tokens.ts` ([tokens](src/lib/AGENTS.md)).
- **Intentional motion**: every movement has a purpose; pick the curve for the feeling. Vocabulary: [motion grammar](.agents/skills/motion-and-typography/references/motion-grammar.md).
- **Rhythm** follows speech, music and information; no fixed interval. Choose each exit (cut, match cut, wipe, whip, hold, fade) and set `transitionToNext` explicitly.
- **Material**: use the voice, music and visuals the idea needs. An abstract shape standing in for a product is not acceptable.
- **Audio balance** starting points: music 0.25–0.35 under voiceover, 0.4–0.6 without; SFX 0.3–0.5.
- **Final frame** does not fade unless the script intends it: it is the thumbnail and loop frame.

Renderer fades are defaults, not rules ([components](src/components/AGENTS.md)).

## Hard rules

### Determinism

**Determinism law (hard):** every animated value is a pure function of the frame. Randomness only with a seed: `random(seed)` from `remotion`.

```tsx
const frame = useCurrentFrame();
const { fps } = useVideoConfig();
const opacity = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: "clamp" });
const scale = spring({ frame, fps, config: { damping: 200, stiffness: 100 } });
```

**Available:** `interpolate()`, `spring()`, `Easing.*`, `<Sequence>`, `<Series>`, `<TransitionSeries>`, `<Freeze>`, `evolvePath()`, `<ThreeCanvas>` (with `useCurrentFrame()` only), and any CSS value set per frame: translate, rotate, skew, clip-path, mask, filter.

**Forbidden** (own clock): `Date.now`, CSS/Tailwind animations and transitions, WAAPI, timers, `requestAnimationFrame`, R3F `useFrame()`, framer-motion, react-spring, anime.js. `pnpm lint` fails them in `src/`; in a film's `src/projects/<id>/` the animatic and build done checks do (`pnpm lint --project <id>`, [verification](docs/local-verification.md)).

**GSAP** is first-class through `useGsapTimeline` from `@remotion/gsap`: a paused timeline seeked from the frame. Import GSAP and its plugins only from `src/motion/gsap.ts` (it lists the rules: no callbacks, seeded randomness, fonts before SplitText). The library's `kinetic` blocks use it. HTML capture stays for third-party HTML and shaders ([html-capture](docs/html-capture.md)).

### Media

`<Img>` from `remotion`, `<Video>`/`<Audio>` from `@remotion/media`, `staticFile()` for every `public/` path; lint (`src/lib/verification/lint.ts`) fails native tags, bare `projects/…` paths and CSS `background-image: url()`. No media binaries in git: a manifest and `pnpm assets:sync`; `repo:hygiene --check` fails any outside [docs/assets.md](docs/assets.md) row (c).

### Product interfaces

When a film shows an app, a website, a chat or any product screen, it must be 90–100% identical to the real one: render or record the real page or app (`capture:app`, computer use on a device, the local repo run with test data), or, for a third-party platform such as Telegram or WhatsApp, a pixel-faithful replica built from a fresh, dated reference screenshot. Never a generic component standing in for the product. If the source is not obvious, ask the user. Routes and checks: [real-ui](docs/real-ui.md).

### CLI JSON contract

Production scripts under `scripts/` emit **one JSON line** on stdout: `{ ok, outputs?, metadata?, elapsedMs, error?, message?, retryAfterMs? }`; human progress goes to stderr; exit code is 0 only on success. Invoke with literal argument arrays and parse the whole line. Helper: `src/lib/cli/` ([scripts/AGENTS.md](scripts/AGENTS.md)).

- `RATE_LIMIT` with `retryAfterMs`: wait, retry once.
- `FFMPEG_MISSING`: halt with a `brew install ffmpeg` hint; never retry.
- `PROJECT_NOT_FOUND`, `INVALID_INPUT`, `VALIDATION`: caller error, halt.
- `BUDGET_EXCEEDED`: admission refused; `details` carry the amounts and `maxAdmissibleUsd`; ask the user, never retry.
- `PAUSED`: the user paused or stopped the project in the console; halt and tell the user; never retry.
- `ASSET_MISSING`: run the `pnpm assets:sync --id` command it names, then retry once.
- `NETWORK`, `TIMEOUT`: retry with bounded backoff; never blindly resubmit an ambiguous paid job.

### Subagents

All agents in `.agents/agents/` are leaf agents (depth 1) and **must not** spawn sub-agents. Front-matter: `name`, `description`, `model`, `tools`.

### Paid operations and budget

- `src/lib/pricing.ts` and the endpoint registry are the price source of truth. **Unknown prices are not free**: they need an explicitly authorised positive `--max-cost-usd` (asset metadata `maxCostUsd`), which is a planning bound, not a cap on provider billing. Do not embed old estimates or assume a sibling endpoint costs the same.
- New generation goes through `providers/` and durable `jobs/` with admission from `budget/`: reserve before submit, keep request and result ownership across retries, resume an ambiguous submit by the same operation ID.
- Check status with `pnpm budget` and `pnpm cost:report` (`--project ID`); the cost ledger alone is not admission or billing authority. `brief.budgetUsd: null` does **not** authorise unlimited spending.
- Prefer reuse: approved project media, `pnpm asset:import` for original Codex/Claude outputs, approved stock with licence evidence. Use repo scripts, never ad hoc provider or SDK calls. In a no-spend session, leave generation explicitly pending.
- Harness subscription costs cannot be inferred from media output; local rendering does not imply free external dependencies.

### Decision authority

- Decide yourself: which agent to dispatch, retry versus escalate, minor fixes.
- Ask the user: every required approval gate (except under a policy the user granted in their own words, within its limits: `pnpm film:policy`), before overwriting files, before spending beyond authorised durable budget bounds, on a QA "reshoot". Music and quality are the user's judgement: agents cannot hear, so never claim a track or film sounds good.

## Essential commands

[CLI](scripts/AGENTS.md) · [Local](docs/local-macos.md). [Licences](docs/dependency-licences.md): `pnpm deps:licences --write` / `--check`.

```bash
pnpm bootstrap  # first run: plan, --apply, report and keys (SETUP.md)
pnpm preflight  # environment check
pnpm check  # repo hygiene, Python checks, format, lint, typecheck, tests
pnpm test:fast  # quick unit subset
pnpm studio  # preview
pnpm next --project <id>  # any project: its route's next step and what to read
pnpm film:next --project <id>  # bespoke film: what next
pnpm footage:next --project <id>  # user's own recording: what next
pnpm sfx:synth / sfx:cues  # synth SFX pack; cue sounds from block cues
pnpm render --project <id> [--format vertical] # render
pnpm review:ui --project <id>  # local review
```

Final delivery: [strict local delivery](docs/delivery.md) (`scripts/delivery.ts --action snapshot`, then `--action check`); only a successful check is production-ready.

## Project cleanup

- The repository is the harness, never a project store; keep project material in its git-ignored footprint.
- Use `pnpm project:remove`, `workspace:clean` or `repo:hygiene --clean`; [cleanup](docs/cleanup.md).
- Keep source portable: no home/worktree paths or run logs. `pnpm repo:hygiene --check` gates CI; diagnostics belong in ignored `out/qa/`.
