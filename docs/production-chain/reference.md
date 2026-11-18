# Production chain reference

Why the [production chain](../production-chain.md) runs in its order, its commands, state, files and limits: open when a step's answer or a question needs it.

## Why this order

- **Reference numbers before the concept.** Ambition stated as numbers (median shot, cuts per minute, longest still) cannot be argued down later. An idea written first gets a reference picked to flatter it.
- **The category before ideas.** A category scout reads at least eight real examples with category terms only (never the product's name or private details, no downloads, study only) and lists the clichés, what not to take and the white space. The teams then ban the obvious before they write. The step can be skipped with a recorded reason.
- **Strategy before ideas.** One proposition, the audience's moment and the 2-second hook mechanic are agreed with the user first, so ideas are judged against a target rather than against each other's charm.
- **Teams apart, judged blind.** Ideas come from 2 to 4 teams with different stances, who never see each other's work. A creative director who wrote none of them scores the pool with authorship stripped and the order shuffled, on a frozen rubric, and compares the best in both orders; code ranks. Before, one agent invented three ideas and graded its own favourite.
- **Boards before the choice.** The user chooses from the hook and last frames rendered from library blocks, not from three paragraphs.
- **Music before the script and the edit.** The film is cut to the track, so the words are written to its sections and the shots to its frames. A track laid under a finished edit always sounds like one. The motion director plans on `beatGridFromMap` (`src/motion/sync`): every cut, ground swap and hero hit on a downbeat or surge, the picture leading by kind (`edit:snap` applies the leads), the ending stopping hard on the music. `cue-placements.json` puts each library block at its start frame; `sfx:cues` turns the blocks' own `cues(props)` into sounds, which the engineer plays with `<CueSounds>` in drafts and the sound step merges into the mix (`audio:mix --preset social`).
- **Material before the look.** For a type made of outside media, the look is proven on the real footage, captures or cut-outs, and spending and licences are the user's yes before anything is generated.
- **Animatic before the build.** Timing changes cost little in rough shapes and a lot in finished scenes.
- **Measure before the critic.** Numbers are cheap and final. Taste is spent only on a film that already passes them.
- **The critic independent of the maker.** The critic gets the render, the brief, the references and the critic pack, and nothing about how or why it was made. A new critic judges each round, and a score that does not rise for two rounds goes to the user.
- **The human last, and only the human.** A critic's approval is not the user's.

## Commands

| Command | What it does |
|---|---|
| `film:route [--type <t>] [--secondary <t>] [--project <id>]` | The route of a film type: steps, agents, inputs, outputs, tools, reference and QA. Reads only; `--write-doc` regenerates `docs/film-types.md`. |
| `film:init --project <id> --type <t> --product <path>... [--rubric 1\|2] [--playbook <id>]` | Creates the project, with `brief.filmType` when `--type` is given (or the playbook's type when `--playbook` binds one and `--type` is absent; [playbooks](../../playbooks/AGENTS.md)): `brief.renderMode: "bespoke"`, a brief the intake rule refuses until it is filled, the spine and pipeline state, and `pipeline/rubric.json` with the creative rubric version (default 2; `--rubric 1` for a benchmark compared with v1 runs). Refuses an existing project. |
| `film:status --project <id>` | Every step's status, the current step and why, and what is stale. Reads only. |
| `film:show --project <id> --step <id> [--artefact <path>] [--fields a.b,c] [--depth 0-4]` | A bounded digest of a step's inputs and outputs, or of one artefact in the project or `out/<id>/`: JSON shape (strings cut, arrays as length and first item), schema validity, chosen fields; Markdown headings. Reads only. |
| `film:next --project <id>` | The action for the orchestrator now, with what to think about before and check after, and the forbidden moves. Reads only. |
| `film:brief --project <id> --step <id> --role <owner\|critic\|fixer> --team <stance> --variant <v> --note "<user's words>"` | Writes the prompt to `pipeline/briefs/` and returns its path (`metadata.brief`), a one-line `summary` and `metadata.dispatch`, the whole prompt for the new subagent ("You are <agent>. Read and follow <path>…"); `--print` adds the text in `metadata.prompt`. Owner and fixer briefs point to `film:show` for looking inside artefacts. `--role` and `--note` are optional; `--team` is required on `ideas` and `--variant` on `script-variants`; `--role critic` on `idea-review` and `script-review` gives the creative director's brief. Same files, same bytes. `--note` is refused on a critic brief. |
| `film:done --project <id> --step <id> --unchanged-because "<why>"` | The last command of a step: checks the outputs and done rule, then records the hashes of inputs and outputs. `--unchanged-because` is only for a stale step whose result is rightly identical; it goes into the spine. |
| `film:approve --project <id> --step <id> --answer "<user's words>"` | Records the user's approval against the artefact's hash. Also closes a critic gate that has asked the user. Refused unless that step's gate is open. `--proxy benchmark --reason "<why>"` instead of `--answer`: a benchmark stand-in, never the user's (below). |
| `film:rights --project <id> --status <owned\|licensed\|study-only> --answer "<user's words>"` | A replica's rights gate: records the user's answer in `pipeline/replica-rights.json`. Refused on any other type. |
| `creative:pool --project <id> --kind <ideas\|scripts> --seed <s>` | Pools the current round blind; `--seed` is optional. |
| `creative:rank --project <id> --kind <ideas\|scripts> [--rescore-reason <why>]` | Ranks the latest review with the project's rubric version (refusing a review on another) and computes the verdict; a changed judgement after a verdict needs a reason. |
| `creative:pick --project <id> --kind <ideas\|scripts>` | concept.json, or script.json with the runner-up, from the ranked review. |
| `film:targets --corpus [--playbook <id>] --project <id>` | Targets with no reference: the p25 to p75 of every analysed reference's pace and sync ([corpus](../reference-analysis.md#corpus)). |
| `shot:tournament --action prepare\|judge\|status --project <id> --shot <id>` | A hero shot's tournament ([build gates](build-gates.md#shot-tournaments)): `--variants` to prepare, `--results` to judge. |
| `library:usage --record --project <id>` / `--list` | The library blocks each film used, in `memory/usage/`; `plan:check --project` reads them. |
| `concept:boards --project <id> --plan-only` | Renders the boards and contact sheet; `--plan-only` validates without rendering. |

`film:done` is a small addition to the plan. Something has to write down which music decision an audio map was built from, and `film:status` should not write. `film:brief` writes the brief file and, with `--note`, the spine; a fixer brief also counts a round in `pipeline/chain/fixer-rounds.json`.

## How a step's state is derived

| Status | Means |
|---|---|
| `ready` | Inputs are there, nothing produced yet |
| `blocked` | An earlier step feeding this one is not closed, or an input is missing |
| `invalid` | An output is missing, empty or fails its schema. A file's presence is never enough |
| `failing` | Outputs validate, but the done rule does not hold |
| `unsealed` | Valid, but `film:done` has not recorded this version |
| `stale` | It finished, and an input or an upstream step has since changed |
| `awaiting-gate` | Finished; waiting for the user or the critic |
| `done`, `skipped` | Closed. `audio-map` is skipped when the user chooses silence; a step the film type's route switches off (`material` for motion-graphics and explainer, the creative front and more for a replica) is skipped, and inputs only it produces are read as optional |

Staleness is transitive along the inputs. A changed `music-decision.json` makes `audio-map`, `script`, `look`, `beat-sheet` and everything after it stale, even when their own files are unchanged. Steps before it are untouched.

A user gate opens only for an approval event in `pipeline/approvals/<step>.json` with the artefact's current hash, so changing an approved artefact closes its gate. For `intake` and `script`, an `approve` entry in the old pipeline state also counts when it is no older than the artefact, because that entry has no hash. Critiques are bound to the exact render or styleframe sheet by `renderSha256`.

Limits that the commands enforce: three critic rounds, no rising score in two rounds, three fixer rounds on a failing measurement. Other steps' stop rules are in the brief, for the owner to follow.

## Files

Under `public/projects/<id>/pipeline/`: `brief.json`, `product-sources.json`, `product-truth.json`, `film-targets.json`, `strategy.json`, `strategy.md`, `category-scan.json`, `skips/<step>.json`, `stimuli/`, `concepts/<team>.json`, `pools/` (pools and keys), `rounds/<kind>-<n>/` (every round's pool, key and author files, with `round.json` naming its review and judged record), `creative-review/` (with `judged/`), `concept.json`, `concept.md`, `concept-boards.json`, `boards/`, `scripts/<v>.json`, `script-alternative.json`, `music-shortlist.json`, `music-decision.json`, `audio-map.json`, `script.json`, `script-music-map.json`, `material.json`, `design.json`, `look/styleframes.png`, `motion-plan.json`, `cue-sheet.json`, `cue-placements.json`, `sound-cues.json`, `plan-check.json`, `build.json`, `motion-check.json`, `mix-plan.json`, `mix-report.json`, `film-measure.json`, `critique/`, `critic-pack/`, `approvals/`, `chain/` (receipts), `briefs/`, `spine.md`. The master is `audio/master.wav`. Renders are `out/<id>/animatic.mp4` and `out/<id>/film.mp4`.

## Benchmark proxy

The chain's invariant is that nobody approves for the user. A benchmark of the chain itself needs it to advance without one, so an `ask` carries `benchmarkProxy`: `film:approve --project <id> --step <step> --proxy benchmark --reason "<why>"`. The event is recorded with `proxy: "orchestrator-benchmark"`; the step shows `proxied: true` in `film:status`, and every later brief says the decision was not the user's. A proxy on `material` or `narration` advances the chain but never authorises spending (`material-sourced` and `narration-ready` count only the user's yes, so paid items stay pending). At the music step the choice itself is recorded by proxy: `music --action record ... --answer "proxy (benchmark): <why>"`, which `film:next` then approves only as a proxy. A proxy is refused on `human`, and `human` counts only the user's own approval, so `film:status` never reports `acceptedByUser` for a proxied film and `film:next` never reaches `stop`. The delivery service does not read chain approvals at all: delivery keeps its own `manualApproval` evidence. Use the proxy only when the user asked for a benchmark.

## Brief telemetry

Every `film:brief` appends `{step, role, agent, bytes, approxTokens, at}` to `pipeline/briefs/dispatches.jsonl` (`approxTokens` is bytes / 4, an estimate). `film:status` shows the totals under `briefs`, overall and by step. It counts brief text only; what an agent reads on top is not measured.

## What a good orchestrator thinks about

`film:next` prints these per step as `orchestratorChecks`. In short:

| Step | Before | After |
|---|---|---|
| intake | Pass on the user's words, propose no topic | Does anything in the brief come from you? |
| truth | Is there real material? If not, ask | Could you open the source of each working claim? |
| reference | Did the user name a film? Manual targets are their decision | Do the numbers match the film you remember? |
| strategy | Brief approved, numbers exist | Is the proposition one sentence? |
| ideas | Every team at once, never shown another's file | Do not read, rank or trim the ideas |
| idea-review | A new director, nothing added | Hand the notes back as written |
| concept | The review passed, or the user chose to go on | Open the contact sheet: do two hook frames look alike? |
| music | The route is the user's | Have they heard it? Say what the licence blocks |
| audio-map | Is it the cut of the file they chose (`decision.cut`, `music/cue.wav`)? | Open the picture; weak grid trust means pacing by phrases |
| script-variants | Music decided; every variant at once | Do not choose between them |
| script-review | A new director, not the ideas' one | Hand the notes back as written |
| script | The script review passed | Does a claim go beyond the working claims? |
| material | A paid route's bound is the user's | Would each licence survive the actual use? |
| look | Frames from code | Open the sheet: could it be any product? |
| beat-sheet | Grid trust is in the inputs, do not restate it | Where does the film rest, and does the music? |
| animatic | Rough is right | Watch with sound, or say you could not |
| build | Timing changes go back to the animatic | Open two transitions yourself |
| sound | Native-on-platform ships without the track | Which two moments are silent on purpose? |
| measure | Do not argue with a number | A skipped leg is not a pass |
| critic | New agent, add nothing | Hand actions over as written |
| human | Show the film; say what you did not check | Only what the user confirms becomes a lesson |

## Where each mechanic comes from

Ideas only where the licence says so: nothing from those sources was copied.

| Mechanic | Source, licence | Step and owner |
|---|---|---|
| Reference numbers first | onetake, non-commercial: idea only | 3, film targets |
| Three ideas that differ in picture; what carries each boundary | onetake: idea only | 4 concept-director, 9 motion-director |
| Benchmark: what to learn and what not to take; one move only this medium can make | lemo-opuscar, MIT | 4 concept-director |
| Sound is half the film: every action, layers, two silences | lemo-opuscar, MIT | 5, 12 sound-director |
| Audio map and how far to trust the grid | Hyperframes music-to-video, Apache | 6 audio:map, 9 motion-director |
| Music is a given, silence has to be justified | brag, MIT | 5 sound-director |
| Fitting a track to the ending; several tracks to one picture | motion-video-kit, MIT | 12 music:backtime |
| Landing and accelerating out; subject fills 60 to 85% of frame; three transformations | motion-video-kit, MIT | 9 motion-director, plan:check |
| Slideshow risk blocks | OpenMontage, AGPL: idea only | 9 plan:check |
| Independent critic, new each round, checks earlier fixes | motion-video-kit, video-use, MIT | 14 creative-critic |
| Frame by frame on transitions, frozen time, loudness | motion-video-kit, MIT | 13, 14 critic:pack |
| Legibility: fast entrance, then hold | brag, lemo-opuscar, MIT | 9 plan:check |

## The removed template mode

The 16-stage template pipeline (`pipeline:init`, `pipeline:stage`, `pipeline-state.json`) was removed on 2026-11-17. A `project.json` project is on the timeline route (`pnpm next`: render, QA, delivery), and a leftover `pipeline-state.json` is ignored, except an old film's `approve` entries, which still count when no newer than the artefact. The film commands refuse a project that is not bespoke, and `filmFindings` returns nothing for one.

## What this does not establish

The tests walk a fixture project through the chain with hand-placed artefacts, including the teams, pools, reviews, boards and variants. They do not show that any agent's work is good, that the rubric predicts what the user prefers, or that a blind director is free of its own biases; no film has gone through the creative department yet.
