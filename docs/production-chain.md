# Production chain

How a bespoke film is made. For a person, and for an orchestrator starting cold. The chain is code, in `src/lib/film/chain.ts`; this page is its index, and each step's `film:next` answer lists in `read` the section files that step needs ([below](#what-to-read-at-each-step)).

An orchestrator does not write briefs. It runs a loop:

```
film:next  ->  do what it says  ->  film:next ...
```

The first decision is the film's **type** (`brief.filmType`: motion-graphics, ui-demo, footage, ai-video, talking-head, explainer, collage, replica, plus an optional `secondaryFilmType`). It picks the route in `src/lib/film/routes.ts`: which steps run, where the material comes from, each step's tools, how the reference is used and what QA looks at hardest. `pnpm film:init --project <id> --type <t>`; `pnpm film:route --type <t>` prints the route; [film types](film-types.md) is the generated table. A brief with no type is routed as motion-graphics and `film:next` says so. When the job is to cut the user's own footage or recordings, `film:init` points to the `footage-editor` agent and `pnpm footage:next --project <id>` ([footage editing](footage-editing.md)) instead.

`film:next` answers with one of four actions: `dispatch` an agent with the prompt from `film:brief` (several at once in `dispatches[]` when concept teams or script variants write in parallel), `run` a script, `ask` the user a question with the file to show, or `stop`. Each answer also names the step's `orchestratorChecks` and `forbidden` moves; a bound film's answer carries `memory` and, at an `ask` or the `stop` of a closed chain, `capture` ([in next-step answers](playbooks.md#in-next-step-answers)). `film:brief` lists memory in owner and fixer briefs, never in a critic's or director's, which judge independently.

The orchestrator's only addition to a brief is the user's own words, through `--note`, which go into the project's spine.

## The chain

```
 1 intake           brief-collector    brief                              [user]
 2 truth            concept-director   product truth
 3 reference        reference-analyst  film targets
 4 strategy         strategist         audience, proposition, hook        [user]
 5 discovery        category-scout     category scan: examples, clichés   (skippable: film:done --skip)
 6 ideas            concept-director   2-4 teams, 4-6 ideas each, apart   (one brief per --team)
 7 idea-review      script, then       blind pool; rubric v2, both orders [creative-director; back to the teams below the threshold]
                    creative-director
 8 concept          creative-director  top three with boards              [user]
 9 music            sound-director     shortlist, then the choice         [user, by ear]
10 audio-map        script             audio map and picture
11 script-variants  script-writer      variants a, b, c                   (one brief per --variant)
12 script-review    script, then       blind pool; script rubric          [creative-director; back to the writers below the threshold]
                    creative-director
13 script           script             winner, runner-up beside it        [user]
14 narration        narrator-director  voice, takes, words, durations     [user]  (types with a voice)
15 material         asset-planner      media, provenance, licence         [user]  (types with outside media)
16 look             design-director    styleframes from real code         [critic]
17 beat-sheet       motion-director    plan on the grid, cues             [plan:check]
18 animatic         motion-engineer    animatic with music                [user]
19 build            motion-engineer    scenes, strips                     [motion:check]
20 sound            sound-director     SFX on block cues, mix             [loudness]
21 measure          script             render, compare with targets       [film:measure]
22 critic           creative-critic    verdict; fixer; 3 rounds           [critic]
23 human            the user           verdict, lessons                   [user]
```

Nobody approves for the user, except a [benchmark proxy](production-chain/reference.md#benchmark-proxy) or, within its limits, a policy the user granted ([autonomy](production-chain/autonomy.md)).

## What to read at each step

| Steps | Section | Holds |
|---|---|---|
| strategy to script | [creative department](production-chain/creative-department.md) | Strategy, teams, blind pools, reviews, threshold, boards, script variants, rubric versions, learning |
| narration | [narration](production-chain/narration.md) | Voice, takes, spend, timings |
| material | [material](production-chain/material.md) | Prepared remix material, reference requirements and their approvals |
| beat-sheet, animatic, build, measure | [build gates](production-chain/build-gates.md) | Slop signatures, which blocks, hero-shot tournaments, sameness gates |
| measure, critic | [measure and critic](production-chain/measure-and-critic.md) | The critic pack, sync metric v2 |
| human | [feedback](production-chain/feedback.md) | `pnpm feedback`: the user's changes reopen their steps |
| rights, replica steps | [replica route](production-chain/replica.md) | The `replica` type's steps and gates |
| any, on demand | [reference](production-chain/reference.md) | Why this order, commands, step states, files, benchmark proxy, telemetry, the per-step checks table, sources, the removed template mode, limits |

## The replica route

Type `replica`, an exact copy only when the user asks for one: [replica route](production-chain/replica.md).

## Shot tournaments

Hero shots are chosen by blind tournament at the build: [build gates](production-chain/build-gates.md#shot-tournaments).

## The promo profile (films of 45 s or less)

Start with `pnpm film:init --project <id> --profile promo`, or set `profile: "promo"` in brief.json (default `"full"`). The steps and gates stay; the cost and the gates on numbers change. In code: plan:check findings `shot-length`, `shot-count`, `shot-variety` and film:measure legs `shot-length-median`, `shot-length-variety`, `cuts-per-minute`, `still-share`, `longest-still` (`REFERENCE_PLAN_DIMENSIONS`, `REFERENCE_MEASURE_LEGS` in `src/lib/film/state.ts`), plan:check's `signature-element` and the build's `tournament-decided` do not block; they appear as `advisories` in `film:status` and `film:next`. Every other failure still blocks. Points 1 and 3 below are orchestrator guidance.

1. **One dispatch for intake and truth.** concept-director gets both briefs in one prompt and writes both outputs. The strategy, the concept teams and the blind review run as in the full profile; the user approves the strategy and the concept.
2. **Music by ear.** The user picks the track (human checkpoint).
3. **Pilot shot instead of an animatic.** motion-engineer builds one 3–6 s hero moment at final quality from library blocks inside `FilmFinish`, rendered to the animatic path. The orchestrator shows the user the MP4 (about 10 s at most) before the full build (human checkpoint).
4. **Build, sound, measure, critic, human.** Reference-number failures are advisories: tell the user, do not add shots to pass. Technical legs (render hash, audio, loudness, true peak, `flash-risk`) and craft findings (carries, holds, reading time) still gate.

Human checkpoints (strategy, concept, music, script, pilot, final) are never auto-approved. "Do it yourself until the final" lets the orchestrator skip waiting on non-human steps, not the checkpoints. Only a proxy or the user's policy may pass them (above).

## Briefs are minimal

`film:brief` lists only what a step needs (`STEP_RULES` in `src/lib/film/chain.ts`): build, animatic and fixer get `design-reference/craft-rules.md` and the motion library; strategy and script variants get creative-standards and creative-lessons; the concept teams also get the spine; the concept presentation gets the library; the critic gets the render, the brief, the targets and its pack; the creative director gets the pool, the strategy, the brief, the truth, the targets, the rubric and the lessons. Agents read nothing else.

## Commands

Every film command with its flags: [reference](production-chain/reference.md#commands). Per step: [lease](step-lease.md).
