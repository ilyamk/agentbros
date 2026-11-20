---
name: colour-grading
description: Measure, match and grade colour with local scopes, CIEDE2000 comparison, an editable grade.json, Resolve-ready .cube LUTs, shot matching and tracked or matte windows. Use when a generated shot drifts from its source, shots do not match, exposure, white balance or skin is off, or a look or LUT is wanted.
---

# Colour grading

Read [the colour guide](../../../docs/colour-grading.md) for the grade file, the evaluation order and every output. The [colourist](../../agents/colourist.md) agent runs this skill; an orchestrator may run it directly for a quick check. All commands are local and free. Work in `public/projects/<id>/pipeline/colour/` and keep every sheet: the process is evidence.

## Loop

Measure → look → propose → apply → re-measure → compare → report. The numbers prove what moved; the user decides whether it looks right. Never write that a grade looks good.

```bash
pnpm colour:scopes --input footage/shot.mp4 --frames 6 --output pipeline/colour/scopes-shot
pnpm colour:compare --input assets/generated.mp4 --reference footage/source.mp4 --output pipeline/colour/compare-before
```

Open `sheet.png` and `compare.png` yourself, then read `stats.json` and `comparison.json`. `summary` gives the diagnosis in words, for example `shadows cooler, blacks lifted +2.7 IRE, saturation +32%, skin hue −30 deg`.

## Workflows

### 1. Reference or film-look match

The generated clip should look like its source, or a clip like a reference film.

```bash
pnpm colour:match --input assets/generated.mp4 --reference footage/source.mp4 --output pipeline/colour/match.grade.json
pnpm colour:grade --grade pipeline/colour/match.grade.json --input assets/generated.mp4 --output assets/generated-graded.mp4 --export-cube pipeline/colour/match.cube
pnpm colour:compare --input assets/generated-graded.mp4 --reference footage/source.mp4 --output pipeline/colour/compare-after
```

- `--method stats` (default) for different content; `--method paired` only for the same shot at the same times (paired ΔE is trusted at luma correlation ≥ 0.6).
- Read `<name>-match/match-preview.png` before rendering.
- When content differs (white logos, sky, other wardrobe), lower `--strength` or protect with a secondary or window, and say which residual comes from content.

### 2. Shot matching across an edit or clips

```bash
pnpm colour:shots --input edit.mp4 --output pipeline/colour/shots --solve
pnpm colour:grade --timeline pipeline/colour/shots/timeline.json --input edit.mp4 --output edit-graded.mp4
pnpm colour:shots --inputs a.mp4 b.mp4 c.mp4 --hero 0 --output pipeline/colour/clips
```

Pick the hero with the user (`--hero N`) or match to `--reference`. Shots over `--tolerance` (mean zone ΔE2000 2.5) are flagged. Check `shots.png`; a wrong cut means adjusting `--cut-threshold`.

### 3. Technical balance: exposure and white balance

No reference, only a target: neutral greys, black near 0 IRE, white under 100 IRE, mid-grey near 18% (false colour grey zone).

- Read `whiteBalance.cast`, `zones`, `luma` and `falseColourPct` in `stats.json`.
- Write `grade.json` by hand: `whiteBalance.temperature`/`tint` for the cast, `exposure` in stops for level, `lift`/`gain` for black and white points, `contrast` around pivot 0.435.
- Render, re-run `colour:scopes`, and repeat with one change at a time until the neutral a*/b* sit within ±1.5.

### 4. Skin-tone protection

Skin hue sits near the 123° skin line on the vectorscope; `stats.json` `skin` reports the offset.

- Measure a known face with `--skin-region x,y,w,h`; the default chroma mask also picks up wood and sand.
- Global correction: a secondary keyed on hue 123 ± 20, with `hueToward: {angle: 123, amount: 0.3–0.6}`.
- Spatial correction on a moving subject: a window. Track a face with `pnpm colour:track --input clip.mp4 --box x,y,w,h --at 1 --output pipeline/colour/face.track.json` and check `face.track-track/track-preview.png`; or make a person matte with `pnpm matte --input clip.mp4 --kind person --out pipeline/colour/matte-person`. Reference either from `windows[]` in the grade (`mask.kind: "shape"` with `track`, or `"matte"` with `path`).
- Re-measure skin hue after rendering; report degrees before and after.

### 5. Creative look or LUT with legal levels

- A look is a grade the user asked for in words ("warmer shadows, cooler highlights"); map each word to one control and show the scopes before and after. Import a vendor LUT with `luts[]` at `position: "look"` and `strength` below 1 when it overshoots.
- Add `softClip.high` (about 0.92) when highlights clip; the render clamps to legal range by construction, but check `legal` and `clipping` in the re-measured `stats.json`.
- Export with `--export-cube` (33³, or `--lut-size 65` for a final) so the user can carry the look into Resolve.

## Report

Before and after numbers (zone ΔE2000, black and white points in IRE, clipping, legal share, skin hue), the files to open first (`compare-after/compare.png`, `scopes-*/sheet.png`), the grade, the cube, the render, and what remains with its reason.
