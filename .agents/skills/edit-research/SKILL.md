---
name: edit-research
description: Turn films across the reference corpus into reusable editing techniques, promote a move seen in two or more references to a technique card and library block, and calibrate a sensor or critic on degraded copies. Use when a plan needs a move the library lacks or a check's threshold needs evidence.
---

# Edit research

Turns "that cut felt good" into a technique another agent can find by what it does, build from numbers and check against the films it came from. Everything here is local and free; it reads and writes the reference library, never a project's media. Rights: references are study only ([CREDITS.md](../../../CREDITS.md) section 2); take the method, never graphics, music or copy.

Related: [reference-analysis](../reference-analysis/SKILL.md) writes a whole film's layers; [motion-library](../motion-library/SKILL.md) adds blocks; the [reference-analysis guide](../../../docs/reference-analysis.md) holds the corpus, typed-technique and calibration detail.

## 1. Break a film into techniques

A technique is one reusable move with a job, not a shot. Measure first, then look:

```bash
pnpm ref:add --file /abs/path/film.mp4 --id ID --rights study-only
pnpm ref:analyze --id ID
pnpm motion:strip --input design-reference/library/ID/media/FILE --output design-reference/library/ID/visuals/a1/NAME.jpg --start-sec 12.4 --end-sec 13.2 --step 1 --diff
pnpm ref:validate --id ID
```

Strip every move you describe (`--step 1 --diff`, a window near 0.8 s around it); a claim about motion you did not see frame by frame stays out or at low confidence. Each item in `techniques.json` (`ReferenceTechniqueSchema`, `src/types/reference.ts`) gets, beside its spans, route and `requiredPrimitives`, the typed facts the corpus indexes:

| Field | What to write | Evidence |
|---|---|---|
| `function` | One of `hook`, `reveal`, `proof`, `transition`, `emphasis`, `cta`, `breath`: what it does for the viewer, not how it looks | Story beat and position in the film |
| `timing` | `durationSec`; `startOffsetFromCutSec` signed (negative starts before the cut); `onBeat` | Strip frames against `shots.json` cuts and `sync.json` beats |
| `ease` | `name` (`power3.out`, `expo.inOut`, `steps(3)`), `cubicBezier`, `source`, `confidence`; `phases` for exit/entry moves; `truncated` when a cut ends it early | `source: "motion.json"` from a shot's `camera.ease` (never a `suspect` fit); `"strip"` read off a diff strip; `"inferred"` otherwise, confidence ≤ 0.5 |
| `sound` | `kind` (`sfx`, `music-hit`, `music-bed`, `dip`, `voice`, `silence`, `unknown`), `layers`, `note`; `timingBasis` measured when an onset sits on the move, `sourceBasis` usually inferred | `audio.json` onsets, waveform. You cannot hear: never claim what a sound is |
| `typography` | Per role: `entry` ("mask-up 6f"), `alignment` (`left`, `centre`, `right`, `free`, `split-edges`), `size` as a share of frame height | Stills at the landing frame |

A recurring move gets `occurrences`, each with its own span and timing; a transition gets `fromShot`/`toShot`. What the library cannot build is `missing:<name>, what it must do` in `requiredPrimitives`: that is how gaps reach the corpus.

## 2. Search the corpus before inventing

```bash
pnpm ref:corpus
pnpm ref:corpus --playbook product-promo --exclude film-a
pnpm film:targets --corpus --playbook product-promo --project ID
pnpm library:list --query "<what the move does>"
```

`design-reference/library/_corpus.json` (git-ignored; rebuild after any analysis):

- `techniques.byFunction.<function>`: how analysed films do that job, each entry with its reference, spans, timing, ease, ease family and sound. Pick candidates here, then strip the reference span (`motion:strip --vs`) next to yours.
- `metrics`: p10–p90 per pace and sync metric; `film:targets --corpus` takes the p25–p75 as targets.
- `easeFamilies`: what the films actually use (`out:3`, `inOut`, `steps`); prefer a curve the corpus holds over a default.
- `gaps.techniqueNames` (names in more than one reference), `gaps.signatureMoves` and `gaps.missingPrimitives` (most-seen first, single sightings included): the promotion queue, each with `count` and `refs`.
- `privateReferenceIds`: references you may learn from but never name; copy none of these ids into a card, block, note or commit.

Invent only when no entry of the right function fits the idea, and say so in the plan.

## 3. Promote a recurring technique

A technique seen in **two or more references** (`gaps.techniqueNames` or `signatureMoves` with `count ≥ 2`) earns a card; one sighting stays in its reference.

1. **Card**: `design-reference/techniques/<id>.md`, front-matter by `TechniqueCardSchema` (`src/types/creative.ts`): `id` (file name), `name`, `intent`, `route`, `timing`, optional `curve`, `primitive`, `demo`, `sources` (a JSON array of existing files: each reference's `techniques.json` or `edit.json`, then the block), `status: draft` until a lab composition demonstrates it (`demonstrated`) or two or more references' `techniques.json` link a technique with spans to it by `techniqueCardId`, each cited in `sources` (`confirmed`; an occurrence that differs in a detail is named as such in **Timing.**). Flat `key: value`; JSON-quote any value with a colon. Body sections: **What it does.**, **When it fits.**, **When it does not.**, **Timing.** (the measured numbers from every reference), **Read.**, **Pitfalls.** (e.g. pulldown repeats read as holds). A `remotion` card's `primitive` names must be exports of `src/motion/*.ts`. `tests/technique-cards.test.ts` checks all of it.
2. **Block**: follow the [library contract](../../../src/motion/library/AGENTS.md#adding-an-item): one frame-driven component with a zod schema and defaults that look right alone; transitions take `seamFrame`; `inspiredBy` cites each reference with its span and measured numbers (`design-reference/library/<ref>: <technique> 4.73-5.13 s (...)`). Then `pnpm library:catalogue`, `pnpm library:preview --id <id>` (open the sheet), and name the block in the playbooks it serves.
3. **Credits**: add the block to each reference's "Analysed for" cell in [CREDITS.md](../../../CREDITS.md) section 2. A private reference is never named in a tracked file: use its alias or leave it out. Cards and `inspiredBy` describe a film's copy (role, word count, case) and quote at most four of its words.
4. Back-link: set `techniqueCardId` on the techniques the card came from, and replace their `missing:` primitive with `block:<id>`; rerun `ref:corpus` so the gap closes.

## 4. Calibrate a sensor or critic

A threshold or a critic earns a gate only when it tells a professional segment from a copy made worse on purpose.

```bash
pnpm ref:degrade --id ID --auto 4
pnpm ref:degrade --id ID --start-sec 12 --end-sec 15 --kinds stutter,desync
pnpm judge:calibrate
pnpm judge:calibrate --sensors none --critic-pack --batches 12
pnpm judge:calibrate --sensors none --critic-results <results-0.json>,<results-1.json>,...
```

- `ref:degrade` writes labelled variants per 2–4 s segment (`linear-motion`, `stutter`, `uniform-cuts`, `desync`, `no-sfx`, `flat-grade`) under `out/qa/calibration/<id>/`, each with a manifest and hashes. Use segments from at least two references.
- `judge:calibrate` reads every manifest; `report.json` gives per sensor and kind `n`, `accuracy`, `falseAlarms` on control kinds, `failures`, and `eligibleGates`: accuracy ≥ 0.85 on n ≥ 6 pairs. A critic pair counts only when both orders name the original.
- For a critic: one fresh `creative-critic` per batch, confined to its `batch-<k>.json` and `batch-<k>/`; never one critic two batches (a batch never repeats an original, and a pair's two orders are in different batches). The answer key sits outside. A critic that can search `out/qa/calibration/` can unblind itself.
- A new sensor: add it to `SENSORS` in `src/lib/reference/calibrate.ts` with the direction that is worse and the kinds it should catch, then calibrate.
- Eligibility is evidence, not the change: a gate moves in `film:measure` or `plan:check` by a reviewed commit, and a threshold marked `// provisional: recalibrated from ref:corpus` is replaced by the corpus number it names.

## Done means

- Every described move has an opened strip; typed fields carry `basis` or `source` and an honest `confidence`; `ref:validate` passes.
- `ref:corpus` rebuilt; a promoted technique has a card, a block, `inspiredBy`, a CREDITS cell and passing technique-card and library tests; `pnpm ref:contribute --all` passes ([contributing references](../../../docs/contributing-references.md)).
- A calibration claim cites `report.json` numbers, never "the sensor works".
