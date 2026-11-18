# Playbooks: fields, maturity, coverage and adding one

Last updated: 2026-11-17

The rules an orchestrator follows every time (choose, bind, proceed, the index and coverage tables) are in [playbooks/AGENTS.md](../playbooks/AGENTS.md). This guide is the reference behind them. Schema: `PlaybookSchema` in [playbook.ts](../src/types/playbook.ts). Code: [src/lib/playbooks/](../src/lib/playbooks/).

## Matching

`pnpm playbook --match "<request>"` scores every playbook against the request's words.

- Triggers come in three languages: `en`, `ru` and `zh`. An English or Russian trigger is a lower-case stem: `субтитр` matches `субтитрами`. A request word also meets a near form sharing the trigger's first max(5, length - 2) letters. Words of up to 3 letters match whole.
- Chinese has no spaces, so each Han character is a token and a Chinese trigger matches as an adjacent run of characters: `教程` matches inside `做一个产品使用教程视频`. Latin words inside Chinese (`App`, `logo`) are separate tokens.
- Between two words of a phrase one extra request word may stand: `видео с конференции` meets `видео с нашей конференции`. Chinese characters must be adjacent.
- A trigger scores 1, plus 0.5 for each extra word of a phrase (two Chinese characters count as a word). A trigger lying wholly inside a longer matched one does not count again.
- `triggers.generic` repeats triggers that also describe neighbouring kinds of video (`короткий ролик`, `广告`). Each scores 0.5, and a candidate that matched only generic triggers is never `clear`.
- Variant triggers count toward their playbook's score. The candidate then names the `variant` whose triggers matched most. A variant trigger that repeats a main trigger counts once.
- `strength` is `clear` when the top candidate matched at least one specific trigger and either its score is at least 2 and leads the next candidate by at least 1, or it is the lone candidate with at least 1.5 (one specific phrase such as "logo reveal"). Anything else is `weak`, including a `tie`; `none` means nothing matched.

### Measuring it

`pnpm playbook --eval` scores the matcher on [tests/fixtures/playbooks/match-corpus.json](../tests/fixtures/playbooks/match-corpus.json): first requests written the way users phrase them, in all three languages, each with the playbooks that would be acceptable (an empty list marks a vague request). It reports top-1 (the first candidate is acceptable), clear (bound without asking, correctly), per language, and every miss, worst first: a `wrong-clear` binds the wrong method without a question. `tests/playbooks.test.ts` holds floors on these numbers and allows no `wrong-clear` and no clear match of a vague request. Add a case when a real request goes wrong, before changing triggers.
- `modifiers` and `existingProject` are read before the candidates (see playbooks/AGENTS.md).

## Fields

Besides `triggers`, `notFor`, `route`, `alternatives`, `agents`, `skills`, `library`, `commands`, `read`, `qa` and `benchmarks`:

| Field | What it is for |
|---|---|
| `benchmarks` | Task ids in `bench/suite.json`; every reference is validated by `--check` |
| `stepRead` | Files read only at named steps of the route (film chain steps, `footage:next` steps or template stages), after `read`; `read` is for what every step needs. A file the route already reads at that step (`STEP_RULES`, the step read lists in `src/lib/pipeline/route.ts`) is not repeated |
| `intake` | 3-6 questions for this task, each with `ask` and `why`. A question with no `default` blocks the start; with one, the agent may assume it. Not generic questions every film has (language, budget) unless this task changes them |
| `profiles` | One per platform the task really ships to: `formats`, a `durationSec` band, `loudnessLufs` when the platform states or normalises loudness, `captions` (a caption profile id from `CaptionProfileIdSchema`, legacy aliases included, or `none`) and a one-line `note`. Each number is traceable to a source in the playbook's References |
| `starter` | A known-good starting point: library block ids (docs/library/catalogue.json), a style (`pnpm library:list --styles`, or `STYLE_PROFILES` in src/lib/templates/styles.ts), a template id (src/lib/templates/registry.ts), and a `note` saying why |
| `variants` | Sub-formats that change the method (a podcast inside footage-edit): `id` (unique in the playbook, never another playbook's id), `title`, lower-case `triggers` in English and Russian (and Chinese, optional per variant), and `changes` |
| `optionalSkills` | Third-party skills in `skills-lock.json` that help but are not shipped with every copy (no redistribution grant, so the public export leaves them out). Never also in `skills`, never required: `--check` only asks for a `skills-lock.json` source, and `pnpm playbook --id` reports each with `installed` and its upstream `install` command (`npx skills add <source>`) |
| `reviewedAt` | When the method and its research were last reviewed |
| `evidence` | Accepted real projects: `project` (free text, projects are git-ignored) and `acceptedAt` |

`pnpm playbook --id <id>` returns them resolved, each once, with the route's guide (a film type's page), merged QA, `read`, `stepRead` and tagged lessons; `--full` adds the matching triggers and every step's film-type tools, which `film:next` otherwise hands each step.

## Maturity

- `draft`: the method is incomplete; its Done when section says what is missing. The match hint tells the user so.
- `ready`: complete and checked. It has `reviewedAt`, at least 3 intake questions and at least 1 profile (`readinessProblems`, enforced by `--check`), and no placeholder section.
- `proven`: a project made under it was accepted by the user and is recorded in `evidence`. Only the orchestrator sets it, after the user accepts.

A `reviewedAt` older than 180 days is a warning (never an error) in `--check` and `--id`: recheck the platform rules and References, then update the date.

A `ready` playbook with empty `benchmarks` produces a warning in `pnpm playbook --check`; `pnpm playbook --check --strict-benchmarks` makes it an error. `contrib:scout` already lists missing benchmark tasks as opportunities, including drafts. Add a task to the suite and name its id in the playbook to close the gap.

## Coverage

[coverage.ts](../src/lib/playbooks/coverage.ts) says which playbook owns each film type, template recipe and workflow scenario, and which footage goals pick which playbook. An owner may be marked `pending` while its playbook is being written; once the round ends every owner exists. `GENERAL` lists the commands that serve every playbook (environment, preview, render, delivery, budget, the film chain's machinery and the pipeline check, the shared recipe renderer, the modifiers' commands), each with a reason; `NON_PRODUCTION_SECTIONS` excludes development and legacy commands.

`tests/playbooks-coverage.test.ts` holds every production command and library category to an owner: a playbook that names it (`commands`, `library`, `starter`, `read` or `stepRead` holding the command's guide, or `pnpm <alias>` / a backticked name in its AGENTS.md; a category counts only through `library` and the blocks' categories) or a `GENERAL` reason. A new command or block category with neither fails the suite.

`pnpm playbook --uses <name>` is the reverse lookup: for a command alias, library block or category, skill, agent, caption profile, style or template it returns what the name is (`kinds`), each playbook naming it with where (JSON paths, `AGENTS.md:<lines>`), and its `GENERAL` reason if any. A plain word ("render", "data") counts in prose only as `pnpm <word>` or in backticks.

An unbound project's next-step answers carry `playbookSuggest`: the owners of its film type (`pipeline/brief.json`), footage goals (`pipeline/footage-goals.json`) or recipe (`pipeline/recipe.json`), limited for a film or footage project to playbooks with a route of its kind, and the `--use` command.

## Adding or changing a playbook

1. `playbooks/<id>/` with `playbook.json` (`id` is the folder) and `AGENTS.md` (at most 12 KiB, a `Last updated` line, a first line saying when to choose it and which neighbour otherwise).
2. `AGENTS.md` sections in order: `## Start`, `## What good looks like`, `## Method`, `## Tools`, `## Anti-patterns`, `## References`, `## Done when`. Every Method rule names the command, block, skill or agent that carries it out; guides, film-type tools and QA lines are linked, not copied.
3. `playbook.json`: lower-case `triggers` in English, Russian and Chinese (prefer phrases to bare generic words; list a broad one in `generic`); `notFor` names each neighbour; `qa` adds only lines the film type lacks; every `pnpm` command in `route.start` and `alternatives` is a real alias.
4. Add its owners to coverage.ts when it owns a film type, recipe or workflow.
5. `pnpm playbook --check` (every agent, skill, block, category, command, read path, workflow, recipe, neighbour, caption profile, style, template, and variant resolves), then `pnpm playbook --write-doc` (index and coverage tables).
6. `tests/fixtures/playbooks/match-corpus.json`: requests for the new playbook in all three languages, plus neighbours' requests it must not steal; `pnpm playbook --eval` must not lose top-1 or gain a `wrong-clear`.

## In next-step answers

A bound project's step answer (`next`, `film:next`, `footage:next`, `pipeline:check`) also carries `memory`: at most seven of the user's entries for this playbook, step and platform (`memoryHint` says how to open one; invalid memory files are skipped with one `memoryWarning`). At a user gate, a choice, a recorded revision or a finished delivery it also carries `capture` (`moment`, `hint`, `commands`): ready-to-fill `pnpm memory` templates, never pre-filled, filled only with the user's own words. film:brief gives owner and fixer prompts the same list, plus up to three of the user's lessons on steps that read creative-lessons.md (strategy, ideas, script-variants); a creative director's review brief gets only up to three of the user's lessons, a critic's nothing.

## Lessons

Lessons come from two sources. The harness's curated, generalised lessons are in [creative-lessons.md](../design-reference/creative-lessons.md); an entry about one kind of video carries `- **Playbook:** <id>`. A user's own confirmed lessons live in their local memory (`pnpm memory --add --type lesson --playbook <id>`). `pnpm playbook --id <id>` lists both, each with `source` (`harness` or `memory`, with its memory id), title and date. A personal lesson becomes a harness lesson only through an approved, generalised proposal ([creative-postmortem](../.agents/skills/creative-postmortem/SKILL.md)).
