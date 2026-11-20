# Film engine — Agent Rules

Last updated: 2026-11-20

Engine changes: routes, briefs and gates. Follow [the chain](../../../docs/production-chain.md) and `pnpm film:next`.

Console strategy edits call `sealStep` to validate the changed artefacts and record their hashes for a fresh user review.

## Start here

```bash
pnpm film:route --type motion-graphics   # a type's steps, agents and tools
pnpm film:status --project <id>          # chain state of a project
pnpm exec tsx --test tests/film-studio.test.ts tests/film-routes.test.ts
```

## Map

| File | Role |
|---|---|
| `chain.ts` | `FILM_CHAIN`: every step's owner, inputs, outputs, commands, gate, done rule and forbidden moves; `ARTEFACT_SCHEMAS` (schema per artefact), `COMMAND_SCRIPTS` (alias to script), `STEP_RULES` (rule files each brief lists), `chainProblems()` |
| `routes.ts` | `FILM_ROUTES`: per film type, which steps run, where material comes from, tools per step; `routeDocs()` generates [film types](../../../docs/film-types.md) and per-type pages |
| `brief.ts` | `buildBrief()`: the prompt `film:brief` hands an owner, critic or fixer, with only the files that step needs; dispatch log and token totals; local-tool hints and checked `--local-evidence` survive owner/fixer prompts; critics refuse evidence |
| `brief-handoff.ts`, `excerpt.ts` | `briefMetadata` gives path, summary and dispatch for briefs and context simulation. `--print` adds text. Excerpts select the needed heading up to `EXCERPT_CAP` and link the full file. Missing headings fail. |
| `show.ts` | `film:show`: bounded read-only digest of a step's inputs and outputs or one artefact (JSON shape, schema validity, `--fields` dot paths; Markdown headings); refuses paths outside the project and `out/<id>/` |
| `state.ts` | Derives each step's status from files and hashes; `nextAction()` for `film:next` (`read`, `playbook`: `src/lib/pipeline/route.ts`), `sealStep`, `skipStep`, `approveStep`, `filmFindings()` |
| `studio.ts`, `creative-rubric.ts`, `stimuli.ts`, `spine.ts` | Creative department: team pools, blind scoring on a frozen rubric, stimuli, the project spine |
| `bench.ts` | Creative benchmark outside the chain ([creative benchmark](../../../docs/creative-benchmark.md)) |
| `plan-check.ts`, `measure.ts`, `targets.ts`, `readings.ts`, `evidence.ts`, `tension.ts`, `stats.ts`, `cut-sound.ts` | `plan:check`, `film:targets`, `film:measure`: what a plan, a reference and a render measure; `targetsFromCorpus` sets targets from the reference corpus (`source: "corpus"`, p10 / 1.5 to p90 × 1.5 as the gate, p25 and p75 kept as the aim, no still or climax limits); `cut-sound.ts` is the `cut-sound-coverage` leg |
| `tournament.ts` | `shot:tournament`: a hero shot's variants rendered, sensed, placed against the corpus for the shot's `function`, judged blind in both orders; `heroTournamentProblems` is the build's `tournament-decided` |
| `critic-pack.ts`, `music-cut.ts` | `critic:pack` sheets; the music decision's excerpt |
| `project.ts`, `inputs.ts`, `cli.ts`, `studio-cli.ts` | New project files, flag defaults, CLI refusals |
| `versions.ts` | render, measure, done keep `out/<id>/versions/<sha>.mp4` (clone/copy, no hardlink) and an index. Best: measure pass, top `critiqueTotal`, newest. Approvals and delivery read `film.mp4`. `film:versions --prune` (2026-11-17) plans (`--apply` deletes) all but newest `--keep` (5), best, current and shas approvals, receipts or delivery name |

## Slop signatures

Method: [build gates](../../../docs/production-chain/build-gates.md#slop-signatures), [slop catalogue](../../../design-reference/slop-catalogue.md). plan:check `SLOP_PLAN_DIMENSIONS` (`curve-linear`, `text-hold-long`, `entry-hierarchy`) stay out of the risk mean (`checkPlan`, state.ts's promo recompute). film:measure `motion-spread` (evidence `spread`) and `fast-motion-sharp` (evidence `sharpness`, step `sharpnessStep(fps)`) ceilings rise to the reference's `measuredFrom` share plus 0.1, warn until `judge:calibrate` makes them eligible; evidence lacking a field is measured again. Thresholds say `// calibrated on N references, <date>` or `// provisional` ([calibration](../../../design-reference/calibration.md)). Build's motion:check gets `--safe-zone {format}` (token `format`).

## Tournaments and repetition

Method: [build gates](../../../docs/production-chain/build-gates.md#shot-tournaments).

- A plan shot may carry `function` (the corpus's: hook, reveal, proof, transition, emphasis, cta, breath) and `weight` (`hero` or `support`); the plan may carry `signature` {description, shotIds, whyFromIdea}. All optional: old plans parse.
- `pipeline/tournament/<shot>.json` (`ShotTournamentSchema`, `src/types/tournament.ts`). Labels A-C follow a seed hashed from project, shot and each variant's composition, props hash and render hash: same inputs, same labels, packets and decision. Packets in `out/<id>/tournament/<shot>/` name labels only.
- A variant failing motion:check (`--allow` takes intended exceptions as motion:check does; its sensor row names the failing counters and counts) or a blocking shot leg (`flash-risk`; `motion-spread` and `fast-motion-sharp` only warn) is excluded; one survivor wins alone, none leaves the shot undecided. The rest are ranked by agreed pairwise wins (`agreedPairs`: both orders, same winner), then corpus distance, then label. `judge` refuses another seed, a missing order or a packet judged twice.
- Corpus distance uses only bands in the measured unit: duration and cut offset from the function's techniques, energy, spread and sharp share only from same-named corpus metrics. The rest are listed `unavailable`, never guessed.
- `tournament-decided` (build): each hero shot is decided and its winner is what build.json mounts (`composition`, or `shots.<id>` {composition, props}, props compared by hash now). Advisory in promo. A fresh critic judges the packets, never the maker. A decision becomes a memory `observation` (function and winning `--techniques` name), no project scope, so the same win in another film counts as a sighting.
- plan:check `signature-element` (bespoke films but replicas; advisory in promo) and `cross-film-repetition` (hero blocks and props hashes against the last two other films in `memory/usage`, written by `library:usage` and by film:done on build) are `FILM_GATE_DIMENSIONS`: they block by failing and stay out of the risk mean.

## Rules

- The chain is data: change steps in `FILM_CHAIN` (read by `film:next`, `film:brief`), not in an agent or skill.
- Only the user's own words approve (`film:approve --answer`). Approvals are bound to the hashes of the step's outputs; a changed artefact reopens the gate.
- Delivery of a bespoke film (no `project.json`) goes through `src/lib/delivery/bespoke.ts`: film:render publishes delivery's receipt for a full render of build.json's composition to `out/<id>/film.mp4`; delivery needs `manualApproval`, never chain approvals ([delivery](../../../docs/delivery.md), "Bespoke films").
- `--proxy benchmark` advances a benchmark run; never the user's approval (`userApprovalEvents` drops it), refused on `human` (`PROXY_REFUSED`), never authorises spending.
- `film:init --playbook <id>` binds the project (`--by user` when the user named it); it accepts a playbook with a film route or film alternative and, without `--type`, takes that route's `filmType` and `secondaryFilmType` (main route first); an explicit `--type` wins with a warning.
- A project's rubric version is recorded by `film:init` in `pipeline/rubric.json`; projects without it are scored on v1. Rubrics are frozen: a new one is a new version.
- Every cut, transition and hero cue is decided (sound or silence with a reason): plan:check `cut-sound-decided` blocks undecided cues and unmatched plan boundaries (unjudged without a cue sheet); the chain passes plan and cue sheet to `sfx:cues` (not on silence: `decidedPlan`); film:measure `cut-sound-coverage` warns on a decided sound with no render onset (`measureRender`, shared with film:render; leads measured from sound-cues.json; advisory until calibrated).
- Earshot (2026-11-17): sound runs `sfx:audition` (sfx-selection.json, token `sfxSelection` for `sfx:cues --selection`); done check `hero-sounds-selected`, advisory in promo; measure leg `sfx-evidence` warns at most ([audio](../audio/AGENTS.md)).
- `docs/film-types.md` and `docs/film-types/` are generated: never hand-edit.

## Briefs by reference (2026-11-16)

- `film:brief` returns `metadata.brief` (the file) and `metadata.dispatch` (the subagent's whole prompt); the orchestrator never pastes the brief.
- Owner and fixer briefs point to `pnpm film:show`; critic, director and fan-out author briefs do not (blind judging and writing).

## Change checklist

- Route or film type: `routes.ts` (a new type also goes into `FilmTypeSchema` in `src/types/pipeline.ts`), run `pnpm film:route --write-doc`, then `tests/film-routes.test.ts`.
- Step, gate or artefact: `chain.ts` (and the schema in `src/types/`), the owning agent in `.agents/agents/`, [production chain](../../../docs/production-chain.md) (index and section); run `tests/film-studio.test.ts` and `tests/film-chain.test.ts`.
- New command: a `COMMAND_SCRIPTS` entry and the matching `package.json` alias.
- Rubric or studio: `tests/creative-{rubric,bench,stimuli}.test.ts`. Measurements: `tests/film-{sensors,replica,music-cut}.test.ts`.
- `test:fast` skips `film-chain` and `film-sensors`: run them by name.

## See also

[Types](../../types/AGENTS.md), [src/lib](../AGENTS.md), [agents index](../../../.agents/agents/README.md), [creative-studio skill](../../../.agents/skills/creative-studio/SKILL.md).

Notes:
- Music spend (2026-11-19): generated takes spend under `paidWhen: budget-ceiling`.
- Speech (2026-11-20): paid takes need direction approval. Local directions can select a portable voice; `narration:check` binds its takes and words. AI material binds approved lines to packs. [Narration](../../../docs/production-chain/narration.md)
- Visualisation: prepared shot bindings are checked by plan:check and plan-passed; `viz:mount` never overwrites custom builds. Build records declare `localAssets` for native assets (`[]` for unused drafts); delivery binds their inputs and receipts. `vork` shots bind `renderTask` and receipt-bound plates.
- Prepared remix (2026-11-15): material briefs read Genjutsu; check `modelPreparation` pins after plan approval; `film:rights --preparation ID` records source use ([recipe](../../../docs/higgsfield-prompting.md#prepared-genjutsu-workflow)). Critic packs: source-bound `reviewPack`; missing evidence is not approval.
- Campaigns (2026-11-16): approveStep checks expected hashes and idempotent decision IDs. `renderBrief` = `buildBrief`'s text without readiness, files or telemetry (for `--simulate`).
- Project lint (2026-11-16): `project-lint-clean` on animatic and build lints `src/projects/<id>` and the build entry's directory, memoised per file state; a sealed animatic does not reopen.
- Feedback (2026-11-16): `pnpm feedback` ([chain](../../../docs/production-chain/feedback.md); `src/lib/feedback/`, `src/types/feedback.ts`). `FEEDBACK_STEPS` carry the optional tracked input `FEEDBACK_OPEN(step)`; targets are agent-owned, never judges, fan-out only as a pool's authors (`tests/feedback.test.ts`). `sealStep` settles the open file outside the receipt; a repeated aspect asks.
- Pool reopen (2026-11-17): a stale `ideas`/`script-variants` dispatches every lane; the first `film:brief` records `rounds/<kind>-reopens.json` with the quotes, also from records routed `UPSTREAM_QUOTED` (never in the director brief); limits count from `roundsStart`. `approveStep` refuses placeholder answers (`cli/user-words.ts`).
- Autonomy (2026-11-17): `autonomy.ts` (allowlist; replica-spec `swaps`), `decisions.ts` (`pipeline/decisions.jsonl`), `guard.ts` (`pipeline/guard.jsonl`, `present-best` stop); `user-policy` approvals need a standing ledger decision; `PROXY_REFUSED` adds rights; interactive answers pinned by `tests/film-autonomy-snapshot.test.ts` ([autonomy](../../../docs/production-chain/autonomy.md)). Guard: interactive 60 rounds/12 h, autonomous 30/4. `spend` decisions (`spendUsd`) authorise spend (`spendApprovalEvents`).
