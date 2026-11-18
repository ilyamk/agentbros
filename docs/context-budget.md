# Context budgets and instruction hygiene

These tools run offline, read repository text and local git objects, and never call a provider. Run them from the repository root.

```bash
pnpm context:budget --write
pnpm context:budget --base HEAD --markdown out/context/comment.md
pnpm instructions:lint
pnpm instructions:security --base HEAD
```

`context:budget` emits one JSON result with the report in `metadata`. `--write` also writes `out/context/budget.json`; `--markdown` writes a PR-comment table. `--base <ref>` compares the tracked working tree with a local commit, including rows added or removed. It reads historical text with `git show`, without checking out files, running historical code, creating a worktree or fetching anything.

## What is measured

| Context | Contents |
|---|---|
| Boot, for `claude-code` and `codex` | Root `AGENTS.md`, skill descriptions from `.agents/skills/*/SKILL.md`, leaf-agent descriptions from `.agents/agents/*.md`, literal `instructions` strings in `.mcp.json` |
| Playbook × step | The resolved playbook guide, `read` files and that step's `stepRead` files, route guide (a film type's page), shared film/footage/template step reads, film owner definition and film-type tools that name skills or paths |
| Playbook total | Union of its step files; each file counted once |
| Subagent | Its whole definition file |
| Contributor | `CONTRIBUTING.md`, `contrib/AGENTS.md` and the largest category card, or zero bytes for missing files |

The tool reuses `resolvePlaybook`, `resolveRoute`, `filmRead`, `footageRead` and `templateRead`, rather than maintaining another step list. Per-step totals are independent contexts: summing them counts repeated reads. File lists are deduplicated within a context; missing files are named and contribute zero.

The deterministic estimate is version 1: each ASCII code point contributes one quarter of an estimated token, each non-ASCII code point contributes one token, and the sum is rounded up once for each context. Bytes are UTF-8 bytes. This deliberately uses no tokenizer dependency and is an estimate, not observed model usage. Descriptions are measured as decoded scalar text, including folded/literal YAML descriptions.

The harness rows model the same declared boot payload. Actual harness loading, injected wrappers and server handshake instructions cannot be inferred offline. MCP is therefore explicitly **unknown**, even when literal `.mcp.json` instructions are measurable. `CLAUDE.md` is the import wrapper, not an extra copy of the root instructions.

`film:brief` requires project state and writes dispatch records; the measurement never invokes it (the whole-run simulation below renders briefs on a scratch project instead). Its static step rule files and owner definition are included through the shared route readers. Project artefacts, spine, memory, conditional inputs, critic/fixer variants and the generated brief text are excluded. Subagent briefs are also out of scope without a project. Footage and template measurements cover the shared step-reader keys; workflow routes expose a start row. Alternative routes and runtime choices are excluded.

Both sides of a ref comparison use the current trusted resolvers, with the historical ref supplying its text and playbook data. Historical resolver code is never executed. Changes to resolver code itself need separate review; a zero delta does not prove those changes preserve loading behaviour.

## Whole-run simulation

```bash
pnpm context:budget --simulate                                  # every film and footage playbook, expected rounds
pnpm context:budget --simulate --playbook product-promo --rounds worst --markdown out/context/run.md
```

The rows above are independent contexts. `--simulate` (`src/lib/context/simulate.ts`) instead follows one playbook from its start to its last step in chain order and adds up what one orchestrator conversation would hold, then measures each subagent it dispatches as a fresh context. `metadata` holds, per playbook, the step rows (added and cumulative estimated tokens, dispatches), the first step whose cumulative estimate reaches 100k and 200k tokens (where Claude Code's compaction becomes likely), contributors by kind, the ten largest single items and the five largest dispatches. `--write` writes `out/context/simulate.json`; `--markdown` a summary and per-step tables. Campaign playbooks are skipped. `--base` is refused: answers and briefs come from the current code, so a historical side would mix two trees.

What enters the orchestrator, per step:

| Item | Source |
|---|---|
| Boot | The claude-code boot row, then the route's skill body (`creative-studio` or `recording-recut`), the playbook's `AGENTS.md` and two command results (`playbook --match`, the start command) |
| Next answer | The `pnpm next` envelope (route, playbook, command, guide, `next`). The film's first answer is the real `nextAction` on a fresh scratch project made with `scaffoldFilmProject`; later film answers are assembled from the same functions (`withPlaybook`, `filmRead`, `toolsFor`, `renderCommand`, `memoryFields`, `captureFields`) with a placeholder `why`, and a test holds the assembled first answer byte-equal to the real one. Footage answers are `decideNext` on a simulated `FootageState` advanced step by step |
| Reads | Every file in an answer's `read`, counted once per conversation |
| Dispatch | `renderBrief` (`src/lib/film/brief.ts`: the brief `film:brief` would hand out, without its readiness check, files or telemetry): by reference (2026-11-16): the `film:brief` result (the brief's path, summary and `metadata.dispatch`, built by `briefMetadata` in `src/lib/film/brief-handoff.ts`) and the Agent call carrying only `metadata.dispatch`; the subagent reads the brief file once. Then a 2,048-byte report (`--report-bytes`) |
| User gate | The `show` files (tracked text measured, project artefacts estimated) and a 1,024-byte exchange; then `film:approve` |
| Command | 1,024 bytes per command result the orchestrator runs |

Rounds: `expected` passes every loop in one round. `worst` runs `stop.maxRounds`: a critic step dispatches a new critic each round and, after a failed round, the fixer (`fixerInputs`), every lane of its `fixBy` fan-out step, or the owner; a `measure` gate re-dispatches its owner or fixer. User gates are answered once in both; footage routes have no critic loop, so worst equals expected.

A subagent's fresh context is the same boot row (an assumption: root `AGENTS.md` through `CLAUDE.md`, skill and agent descriptions), its definition, the dispatch line and its brief, the tracked files its brief names in the header, goal, inputs and rules sections (a quoted excerpt of a shared reference, such as a team stance or the rubric, sits in its own section and is not a read; the "Full references" link is opened only when the quote is not enough), its route tools' skill files, and estimated project artefacts. `docs/library/catalogue.json` counts as one `library:list` result, because briefs say to search it. Artefact sizes are a table in `simulate.ts` (`ARTEFACT_BYTES`, 2–16 KiB by name, else 4 KiB; media 0), deliberately above the minimal `tests/fixtures/film-chain` files, which the scratch project carries from the first step on so later briefs resolve their tokens. A footage source is 20 minutes: the shorts task reads about 1.5 KiB of transcript a minute. The footage loop runs in the orchestrator, so footage routes show no dispatches; when the `footage-editor` agent runs it instead, the same loop moves into that one subagent's context. The user's memory (`AGENTBROS_MEMORY_ROOT`) is pinned to an empty scratch folder and the playbook root to the measured repository, so results do not depend on the machine.

Weakest points: artefact sizes, report sizes and command results are estimates, not observations; briefs after intake lack approvals, user words, memory, category clichés, proofs and review notes, so they are a floor; agents' own exploration, library and tool output, images and files they write are not modelled; `localSuggestions` depends on the machine and is left out; compaction and caching are not modelled.

## Gates

`tests/context-budget-simulate.test.ts` holds the expected-rounds orchestrator total of product-promo, explainer and shorts-from-long just above their measured values, with the same review rule as step ceilings. `tests/context-budget.test.ts` holds the first step of product-promo, explainer and shorts-from-long, every film intake and every footage setup to ceilings, and the production chain index to 10 KiB; lower a ceiling when its row shrinks. RFC 0001 §4.2 retains the existing byte caps and requires the maintainer's `context-growth-approved` label for any boot growth or a step increase over 2 KiB (2,048 bytes). At a file cap, growth needs an equal cut in that file. The budget report supplies evidence; it does not query labels or claim to grant approval. Existing size tests enforce file caps. [Harness canary probes](context-loading.md), behavioural tests and instruction audits are separate checks.

## Hygiene baseline

`instructions:lint` checks tracked instruction files for duplicate paragraphs, dead commands and local paths/links, explicit skill/agent references, first-party skill and agent descriptions over 600 UTF-8 bytes (vendored skills listed in `.agents/skills/THIRD_PARTY.md` are exempt), and root paragraphs confined to one area. Duplicates use normalised word 8-grams and paragraph Jaccard similarity of at least 0.6, within and across files. Fenced code, tables and short one-line pointers are excluded from duplicate comparisons. Commands and references in code blocks are still checked. Templated paths and globs are skipped because their concrete targets require project data.

Findings have `block` or `warn` severity and stable content-based fingerprints, independent of line numbers. Root placement is a warning heuristic. The command fails on any finding absent from `contrib/instructions-baseline.json`, including new warnings. Existing findings remain visible in the total. `--update-baseline` replaces the baseline with current findings; review its diff. Baseline growth is not automatically forbidden, and no test enforces a shrinking baseline. When fixing findings, regenerate it to remove stale fingerprints.

## Added-line security scan

`instructions:security --base <ref> [--head <ref>]` scans only added lines of protected instruction/configuration, hook, workflow, script and paid-operation library paths. Omitting `--head` includes tracked staged and unstaged changes; untracked files must be added to git before a diff can see them. Findings include the file, new-file line, text and pattern; any finding fails the command. This is a conservative textual review gate, not a shell parser or proof that code is safe.

Patterns cover fetch commands and pipes to shells, unknown `npx` packages, private environment/key/home references, authority overrides, outside URLs and paid commands from the command registry. URLs require exact host matches: subdomains are not implicitly trusted. `contrib/url-allowlist.json` is initially seeded from domains already used in tracked instruction files; that seed records existing use, not an endorsement. Its `npxPackages` list starts empty. The scan reads this allowlist from the **base**, so a change cannot whitelist itself. If the base has no allowlist, all added URLs and `npx` packages require review. Seed updates are reviewed repository changes, never an automatic part of scanning.

Missing instruction paths matched by `.gitignore` are treated as documented generated state. The working-tree reader checks them with `git check-ignore`; other missing paths still fail `instructions:lint`.
