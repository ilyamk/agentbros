---
name: colour-grading
description: Colour grading, shot matching and skin-safe looks, gated.
---

# Colour grading

Read [colour craft](references/colour-craft.md) first: order of operations, skin as the anchor, separation, and why a statistical match alone fails. The [colour guide](../../../docs/colour-grading.md) has every command and the grade file. The [colourist](../../agents/colourist.md) agent runs this skill. All commands are local and free. Work in `public/projects/<id>/pipeline/colour/` and keep every sheet: the process is evidence.

## Loop

Measure → look → propose → apply → re-measure → gate → report. The gate (`colour:check`) proves nothing broke; the user decides whether it looks right. Never write that a grade looks good, and never present zone ΔE alone as proof of a match.

```bash
pnpm colour:scopes --input footage/shot.mp4 --frames 6 --output pipeline/colour/scopes-shot
pnpm colour:compare --input assets/generated.mp4 --reference footage/source.mp4 --output pipeline/colour/compare-before
```

Open `sheet.png` and `compare.png` yourself. Measure skin on a fixed face box (`--skin-region x,y,w,h`), not on the chroma rule alone: the rule re-keys after a grade and can hide what happened to the face.

## Workflows

### 1. Reference match, an edit cut the same way (generated or face-swapped vs its source)

```bash
pnpm colour:match --input assets/generated.mp4 --reference footage/source.mp4 --per-shot --output pipeline/colour/match
pnpm colour:grade --timeline pipeline/colour/match/timeline.json --input assets/generated.mp4 --output assets/generated-graded.mp4
pnpm colour:check --input assets/generated-graded.mp4 --source assets/generated.mp4 --reference footage/source.mp4 --output pipeline/colour/check
```

- `--per-shot` cuts the input, solves one grade per shot against the reference at the same times, and writes `<dir>/timeline.json`.
- Each solve fits the primary with skin held toward the reference's skin, adds an environment secondary (the dominant non-skin hue toward the reference's) and a skin secondary, then gates the result. `stages` in the answer says what each did.
- Read every shot's gate in the answer, then the rendered file's `colour:check`.

### 2. Reference or film-look match, one shot or a still

```bash
pnpm colour:match --input assets/generated.mp4 --reference footage/source.mp4 --skin-region 610,100,110,90 --reference-skin-region 530,170,95,70 --output pipeline/colour/match.grade.json
```

- `--skin match` (default) matches skin to the reference's skin; `--skin protect` holds the source skin (different person, wardrobe or light); `--skin off` is the old global fit, kept only for comparison.
- Read `<name>-match/match-preview.png` and the gate before rendering.

### 3. Shot continuity inside one edit

```bash
pnpm colour:shots --input edit.mp4 --output pipeline/colour/shots --solve
pnpm colour:shots --inputs a.mp4 b.mp4 c.mp4 --hero 0 --output pipeline/colour/clips
```

Pick the hero with the user. Shots over `--tolerance` are flagged.

### 4. Technical balance and the look, without a reference

1. Balance: neutral a*/b* within ±1.5, blacks 0–2 IRE, whites under 100 IRE, skin on the line ([colour craft](references/colour-craft.md#without-a-reference)). Write the grade file by hand, one control at a time, and re-measure.
2. Show looks on the real frame with skin held:

```bash
pnpm colour:looks --list
pnpm colour:looks --input assets/clip.mp4 --at 15.5 --skin-region 300,150,130,140 --output pipeline/colour/looks
pnpm colour:looks --input assets/clip.mp4 --family film --output pipeline/colour/looks-film --render
```

- `looks.png` is the grid: source first, then each look with its gate verdict. `<out>/looks.json` gives each look's intent, typical use, moves, skin policy and risks.
- Explain the differences in the user's terms: what each look does, where it is used and how each fits the brief, and name the gate's warnings. Recommend by fit to the brief, never by taste; the user picks.
- The chosen look's `<look>.grade.json` renders with `colour:grade`. Its skin secondary was solved on this footage, so re-run `colour:looks` for other footage.

### 5. Skin protection and windows

- Global: a secondary keyed on the skin hue with `hueToward` the skin line; `colour:match` and `colour:looks` solve one themselves.
- Spatial, on a moving subject: a tracked window (`pnpm colour:track --input clip.mp4 --box x,y,w,h --at 1 --output pipeline/colour/face.track.json`) or a person matte (`pnpm matte --input clip.mp4 --kind person --out pipeline/colour/matte-person`), referenced from `windows[]`. Check the track preview and the mask first.

## Gate

`colour:check` compares the delivery file with its pixel-aligned source (skin keyed on the source) and, optionally, the reference. Pass `--skin-chroma` and `--hue-allowance` for a look's policy, and `--strict` to fail the command on a failed gate. A `fail` blocks delivery until fixed or until the user accepts it in their own words. Thresholds: [colour craft](references/colour-craft.md#validation-thresholds-the-gate).

## Report

Per shot: the gate verdict with its failed and warned checks, skin L*/chroma/b* before and after on a fixed face region, environment hue distance to the reference, crushed and clipped share. Name the files to open first (`check.png`, `looks.png`, a side-by-side), the grade, the render, and what remains with its reason.
