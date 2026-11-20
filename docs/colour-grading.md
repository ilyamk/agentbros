# Colour grading

Last updated: 2026-11-20

Eight local commands, no API keys, no paid calls. They let an agent read a frame the way a colourist does, measure it, grade a video toward a target or a reference, and prove the result with numbers:

- `colour:scopes` measures one clip.
- `colour:compare` compares a clip with a reference.
- `colour:match` solves an editable grade.
- `colour:grade` renders a grade and exports the LUT.
- `colour:shots` checks continuity across shots or clips.
- `colour:track` makes a window follow a moving subject.
- `colour:check` is the validation gate on a rendered grade.
- `colour:looks` tries genre looks on a frame, skin held, as a grid.

Where the pieces live:

| Piece   | Location                                                                   |
| ------- | -------------------------------------------------------------------------- |
| Schemas | `src/types/colour.ts`                                                      |
| Code    | `src/lib/colour/`                                                          |
| Worker  | `scripts/workers/colour.py`, with `colour_maths.py` and `colour_scopes.py` |
| Agent   | [colourist](../.agents/agents/colourist.md)                                |
| Skill   | [colour-grading](../.agents/skills/colour-grading/SKILL.md)                |

Taste stays with the user. The commands report measurements and differences, never that a grade "looks good". The colourist's working knowledge (order of operations, skin as the anchor, separation, the gate's thresholds) is in [colour craft](../.agents/skills/colour-grading/references/colour-craft.md).

## Working space and decoding

- **Code values.** Every number is a Rec.709 display code value normalised to 0..1, where 0 is black and 1 is nominal white. Scopes label it in 10-bit codes (0..1023) and IRE.
- **Linear light and Lab.** These assume a BT.1886 display: gamma 2.4, D65.
- **Decoding.** Frames decode to planar Y'CbCr at their native code values. The worker converts them with the stream's own matrix and range, so super-whites, sub-blacks and the legal-range check (Y' 16–235, Cb/Cr 16–240) come from the file, not from ffmpeg's defaults.
- **Untagged streams.** These get the HD/SD convention: BT.709 when the frame is at least 1280 wide or more than 576 tall, limited range. Every answer lists such guesses in `assumptions`. A missing tag is itself a common cause of a colour shift between players. Override with `--matrix` and `--range`.
- **Letterbox and pillarbox.** Bars are detected across all sampled frames and excluded from every measurement (`--crop auto`, the default). Use `--crop none` or `--crop x,y,w,h` to change this.
- **Log and HDR.** Log or HDR transfers are reported, not converted. Apply a conversion LUT (`luts[].position: "input"`) before judging such footage.

## Scopes: `colour:scopes`

```bash
pnpm colour:scopes --input footage/shot.mp4 --frames 6 --output pipeline/colour/scopes-shot
```

It writes these files:

| File                                    | Contents                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `sheet.png`                             | The contact sheet to open first                                              |
| `frame.png`                             | The frame, with the active-picture box                                       |
| `false-colour.png`                      | ARRI-style false colour: crushed, 18% grey, skin +1 stop, near clip, clipped |
| `waveform-luma.png`, `waveform-rgb.png` | Waveforms                                                                    |
| `parade.png`                            | RGB parade                                                                   |
| `vectorscope.png`, `vectorscope-2x.png` | Vectorscope with 75% targets and the skin line at 123°                       |
| `histogram.png`                         | Histogram                                                                    |
| `cie.png`                               | CIE 1931 xy chromaticity with Rec.709, P3 and Rec.2020 triangles             |
| `stats.json`                            | The numbers, listed below                                                    |

Scopes accumulate every sampled frame; the frame tiles show the middle one. Use `--at <s>` to measure a single frame.

`stats.json` holds:

| Key                  | Contents                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `luma`               | Black and white points (p0.5/p99.5), mean, median, percentiles, P5–P95 contrast                                  |
| `tonal`              | Shares of shadows, mids and highlights                                                                           |
| `clipping`           | Low, high, sub-black and super-white shares, per channel                                                         |
| `legal`              | Shares outside the limited range                                                                                 |
| `whiteBalance`       | a*/b* of near-neutral pixels, and the cast in words                                                              |
| `zones`              | L*, a*, b*, C* and cast per tonal zone. A zone is each image's own bottom 25%, middle 50% and top 25% by L* rank |
| `saturation`         | C* percentiles and vectorscope radius                                                                            |
| `hueDistributionPct` | Share of colour in each 30° vectorscope sector                                                                   |
| `skin`               | Skin pixels, their vectorscope hue against the skin line, Lab, luma                                              |
| `falseColourPct`     | Share of the frame in each false-colour zone                                                                     |

There is no face detector. Skin is found by a Y'CbCr chroma rule (`method: "skin-chroma-mask"`), which also picks up wood, sand and beige walls. Pass `--skin-region x,y,w,h` (source pixels) to measure a known face.

## Compare: `colour:compare`

```bash
pnpm colour:compare --input generated.mp4 --reference source.mp4 --output pipeline/colour/compare
```

- **Sampling.** Frames are taken at the same relative times in both clips, so clips of different lengths and frame rates line up by position.
- **Output.** `compare.png` shows the scopes side by side, a vectorscope overlay (input cyan, reference orange) and the diagnosis. `comparison.json` holds both statistics records.
- **Zones.** `zones` gives the per-zone ΔL*, Δa*, Δb*, ΔC* and the CIEDE2000 between zone means, plus their mean.
- **Global.** `globalDeltaE2000` compares the mean colours.
- **Paired ΔE.** `paired` is a per-pixel CIEDE2000 on frames resized to one size. It counts as reliable only when the frames show the same picture: luma correlation of at least 0.6, or forced with `--paired`.
- **Diagnosis.** `findings` and `summary` are machine-readable, for example `shadows cooler, mids +green, blacks lifted +2.7 IRE, saturation +32%, skin hue −8 deg`.

The diagnosis thresholds are just-noticeable steps:

| Change                 | Threshold |
| ---------------------- | --------- |
| a*/b*                  | 1.5       |
| L* within a zone       | 2.5       |
| Black or white point   | 2 IRE     |
| Contrast or saturation | 5%        |
| Skin hue               | 3°        |

## Grade file

`grade.json` is declarative and deterministic. The worker evaluates it in this fixed order:

1. `luts[]` at `position: "input"`.
2. `whiteBalance` (`temperature`: +1 is half a stop warmer between red and blue; `tint`: +1 is a quarter stop of magenta) and `exposure` (stops), both in linear light.
3. `offset`.
4. `lift`, `gamma`, `gain`. Resolve-like: `gain·(x + lift·(1−x))` raised to `1/gamma`.
5. `contrast` around a `pivot` (default 0.435).
6. `curves.master`, then `curves.r`, `curves.g`, `curves.b` (monotone cubic through `[x, y]` points).
7. `saturation`, luma-preserving.
8. `secondaries[]`.
9. `luts[]` at `position: "look"`.
10. `softClip` (`high` knee, `low` knee).
11. `luts[]` at `position: "output"`.
12. Clamp to 0..1.

Each RGB value (`offset`, `lift`, `gamma`, `gain`) is one number or `[r, g, b]`.

A secondary keys pixels with an HSL qualifier in vectorscope terms:

- `hue`: centre and width in degrees, plus softness;
- `saturation`: chroma as a fraction of a 100% colour;
- `luma`: Y' range.

Inside the key it can do any of these:

| Field                        | Effect                                                  |
| ---------------------------- | ------------------------------------------------------- |
| `hueShift`                   | Rotates the hue                                         |
| `hueToward: {angle, amount}` | Pulls hue toward an angle, for example skin toward 123° |
| `saturation`                 | Scales chroma                                           |
| `luma`                       | Offsets luma                                            |
| `strength`                   | Mixes the whole correction                              |

```json
{
  "version": 1,
  "whiteBalance": { "temperature": 0.3, "tint": -0.1 },
  "lift": [0.0, -0.01, 0.02],
  "gain": 1.02,
  "contrast": { "amount": 1.08, "pivot": 0.435 },
  "saturation": 0.95,
  "secondaries": [
    {
      "name": "skin protect",
      "qualifier": {
        "hue": { "center": 123, "width": 40, "softness": 15 },
        "saturation": { "min": 0.03, "max": 0.45 }
      },
      "hueToward": { "angle": 123, "amount": 0.5 }
    }
  ],
  "softClip": { "high": 0.92 }
}
```

The output is legal by construction: the grade clamps R'G'B' to 0..1, and it is encoded as limited-range Y'CbCr. `softClip` rolls highlights off rather than clipping them hard.

## Grade and export: `colour:grade`

```bash
pnpm colour:grade --grade grade.json --input in.mp4 --output in-graded.mp4 --export-cube grade.cube
```

- **How it renders.** The grade is baked to a 3D LUT (33³ by default, `--lut-size 17|33|65`). ffmpeg decodes with the stated matrix and range to 16-bit RGB, applies the LUT with tetrahedral interpolation and encodes Rec.709 limited range with explicit `bt709` tags.
- **Codecs.** `--codec h264` (CRF 14) or `--codec prores` (422 HQ).
- **Other streams and stills.** Audio is copied. A `.png` or `.tif` output grades one still.
- **The `.cube` file.** It uses the Resolve and Adobe layout (red fastest, `DOMAIN_MIN/MAX`), so the user can carry on in Resolve: load it on a node, or as an input or output LUT.
- **Importing a LUT.** Name it in `luts[]`, with a path relative to the grade file.
- **Overwrites.** Existing files are refused without `--force`, and the output may never be the input.

A colour-bar round trip through an identity grade measures paired CIEDE2000 below 0.5. Verify the encoded result with `colour:compare`; the sampled metrics are not enough.

## Reference match: `colour:match`

```bash
pnpm colour:match --input generated.mp4 --reference source.mp4 --output pipeline/colour/match.grade.json
pnpm colour:match --input generated.mp4 --reference source.mp4 --per-shot --output pipeline/colour/match
```

A solve works in a colourist's order:

1. **Primary.** Lift, gamma and gain per channel, plus saturation, fitted to the reference's Lab statistics: L* quantiles, a*/b* and chroma per zone, the Y' black floor, and a penalty on blacks crushed below 2 IRE beyond the reference's share. With skin in frame (`--skin match`, the default), the objective also holds the mean skin colour toward the reference's skin, so the primary cannot buy a better zone match by recolouring faces. A master curve is kept when it cuts the error by 10%.
2. **Environment secondary.** Lift/gamma/gain move every hue together and cannot separate a room from a face. A secondary keyed on the dominant non-skin hue rotates it toward the reference's (±45°) and scales its chroma. It is skipped when that hue lies within 50° of skin; `--no-environment` turns it off.
3. **Skin secondary.** Keyed on the input's skin after the primary, it solves hue shift, chroma and luma so skin lands on the reference's skin, or on the source skin with `--skin protect`, with a penalty on spill.
4. **Highlight guard and gate.** A `softClip` is added if clipping rose. The gate (below) runs on the sampled pixels; its verdict and the `stages` list come back with the grade.

Skin is keyed on the source: `--skin-region` and `--reference-skin-region` (x,y,w,h in source pixels) when known, otherwise the Y'CbCr skin chroma rule. `--skin off` is the old single global fit, kept for comparison.

**Per shot.** `--per-shot` is for two videos cut the same way, such as a regenerated or face-swapped edit and its source. The input's cuts are found by thumbnail difference; each shot is solved against the reference at the same relative times. It writes `grades/shot-NN.json` and `timeline.json` for `colour:grade --timeline`, and `match-preview.png` with one row per shot.

`--method paired` fits pixel to pixel (same shot, same times). `--strength 0..1` blends toward identity; secondaries scale with it.

**Withdrawn as proof.** The first stark-promo match lowered mean zone ΔE2000 from 7.0 to 0.7 while, on fixed face regions, skin chroma doubled and b* rose from +6 to +25: one global grade warmed the faces to balance a blue room. Zone ΔE is a diagnostic; the gate is the test.

## Shot continuity: `colour:shots`

```bash
pnpm colour:shots --input edit.mp4 --output pipeline/colour/shots --solve
pnpm colour:shots --inputs a.mp4 b.mp4 c.mp4 --hero 0 --output pipeline/colour/clips
```

- **Finding shots.** With `--input`, cuts are found by colour-histogram distance at 6 fps (`--cut-threshold`); `--inputs a.mp4 b.mp4 …` compares separate clips instead. Each shot is measured on 3 frames inside its middle 80%.
- **The hero.** Every shot is compared with the hero (`--hero N`) or with `--reference`. A shot is flagged when its mean zone CIEDE2000 exceeds `--tolerance` (2.5).
- **Solving.** `--solve` writes `grades/<shot>.json`. For an edit it also writes `timeline.json`, which `colour:grade --timeline` renders shot by shot (trim, LUT, concat; audio copied).

## Windows: dynamic masks

A grade can carry up to eight `windows[]`. Each is a correction on top of the base grade inside a per-frame mask, the way a window works on a serial node in Resolve:

```json
{
  "lift": [0, 0, 0.01],
  "windows": [
    {
      "name": "face",
      "mask": { "kind": "shape", "shape": "ellipse", "track": "face.track.json", "softness": 0.3 },
      "grade": {
        "exposure": 0.3,
        "secondaries": [
          {
            "name": "skin",
            "qualifier": { "hue": { "center": 123, "width": 50 } },
            "hueToward": { "angle": 123, "amount": 0.5 }
          }
        ]
      }
    },
    {
      "name": "person",
      "mask": { "kind": "matte", "path": "matte-person", "feather": 3 },
      "grade": { "saturation": 0.92 },
      "strength": 0.8
    }
  ]
}
```

| Mask                 | Source                                                                                              | Notes                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `shape` with `box`   | A static ellipse or rectangle, normalised `[left, top, width, height]`                              | `softness` is the edge fall-off as a share of the box                                                                                |
| `shape` with `track` | A track file from `colour:track`                                                                    | The window follows the subject and switches off where the track is inactive                                                          |
| `matte`              | A `pnpm matte --kind person` (or `subject`) output folder: `alpha/frame-NNNNN.png` and `matte.json` | Per-pixel subject mask (Apple Vision or BiRefNet); `feather` blurs its edge in pixels; `startFrame` and `fps` come from `matte.json` |

`invert: true` grades everything outside the mask; `strength` mixes the window. Windows render only into video or still outputs: a `.cube` is a single global transform, so `--export-cube` carries the base grade and the windows stay in `grade.json`. A `timeline.json` refuses grades with windows; render such a shot with `--grade`.

### Tracking: `colour:track`

```bash
pnpm colour:track --input clip.mp4 --box 630,40,160,190 --at 1 --output pipeline/colour/face.track.json
```

- Place `--box` (source pixels) on the frame at `--at` seconds; read the coordinates off `frame.png` from `colour:scopes`.
- The tracker is OpenCV normalised cross-correlation with an adaptive template, run forward and backward from the anchor. It is deterministic, unlike OpenCV's learning trackers.
- A track stays inside its shot: cuts are found by thumbnail difference, and frames in other shots are written with `active: false`.
- `track-preview.png` beside the track file shows the box on sampled frames with each match confidence. Check it before rendering.

### How windows render

Each window's grade is baked to its own LUT. Its mask is a gray video (shape windows, written by the worker) or the matte's alpha frames. ffmpeg `maskedmerge` in 16-bit planar RGB places the window result over the base result through the mask; `negate` inverts, `gblur` feathers, `colorchannelmixer` sets strength.

## Gate: `colour:check`

```bash
pnpm colour:check --input graded.mp4 --source ungraded.mp4 --reference source.mp4 --output pipeline/colour/check
```

Run it on the delivery file against the pixel-aligned file it was rendered from. Skin is keyed on the source (`--skin-region` or the chroma rule) and the same pixels are read in the graded file. It writes `check.png` (source with the skin key in magenta, graded, reference, verdicts) and `check.json`.

| Check                                                                   | Warn                           | Fail         |
| ----------------------------------------------------------------------- | ------------------------------ | ------------ |
| Skin chroma against the expected ratio (`--skin-chroma`, default 1)     | ×1.25 or ×0.7                  | ×1.5 or ×0.5 |
| Skin hue change beyond `--hue-allowance` (default 6°)                   | above 0°                       | above 10°    |
| Skin b* gain (yellow drift)                                             | +5                             | +9           |
| Crushed blacks (Y' < 2 IRE) over the source, or the reference if darker | +1 pp                          | +4 pp        |
| Clipping over the source or reference                                   | +0.3 pp                        | +1.5 pp      |
| P90 chroma                                                              | ×1.4                           | ×1.8         |
| Skin against the reference's skin (CIEDE2000)                           | 6                              | 10           |
| Environment hue distance to the reference                               | not 10% closer than the source | —            |
| Secondary spill off skin (match and looks)                              | ΔE 2                           | ΔE 4         |
| Legal luma in the file                                                  | 0.5% outside 16–235            | —            |

With a reference and no explicit policy, the skin allowance is the move the reference asks for plus 6°. `--strict` turns a `fail` into a `VALIDATION` error. A pass means nothing measurable broke; whether the grade is right is the user's call.

## Looks: `colour:looks`

```bash
pnpm colour:looks --list
pnpm colour:looks --input clip.mp4 --at 15.5 --skin-region 300,150,130,140 --output pipeline/colour/looks
pnpm colour:looks --input clip.mp4 --looks teal-orange,warm-print,tech-teal-lowkey --output pipeline/colour/looks --render
```

Twelve starting looks live in `src/lib/colour/looks.ts`, built from the grade model's own controls. They describe genre treatments, never a specific title's LUT:

| Family      | Looks                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------- |
| technical   | clean natural                                                                                      |
| film        | teal and orange, cool thriller, bleach bypass, warm print film, moonlight night, low-key tech teal |
| commercial  | golden hour, high-key commercial, beauty soft                                                      |
| music video | neon music video, faded vintage                                                                    |

Each look carries `intent`, `typicalUse`, `moves` and `risks`, so an agent can explain it and say which brief it fits, and a skin policy (`hold` with a chroma ratio, hue allowance, lightness offset, and `warm` for looks that warm skin on purpose).

For each look the command applies the grade, solves a skin secondary that holds skin to the policy on this footage, and gates the result. Outputs:

- `looks.png`: the source and the looks in a three-column grid, each labelled with its verdict;
- `<look>.png` and `<look>.grade.json`, ready for `colour:grade`;
- `looks.json`: every look's explanation and verdict;
- `<look>.mp4` over the whole input, with `--render`.

The default grid shows the six that differ most: clean natural, teal and orange, warm print film, cool thriller, high-key commercial, neon music video. `--family` picks one family. A look that fails the gate on this material (neon on an already saturated blue frame, say) stays in the grid with its failures named; it is evidence, not a recommendation.

## Determinism and tests

- Every image and number is a pure function of the decoded frames.
- Dither and sampling are seeded, and the fit is a bounded least squares from identity.
- x264 runs with fixed threads and bit-exact flags.
- `tests/colour.test.ts` builds its fixtures with ffmpeg at test time (SMPTE bars, a gradient, a tinted frame); there are no media binaries.
- The worker reuses the locked `vork` uv group (NumPy, SciPy, OpenCV headless). A separate group would re-resolve the shared lock.

## Follow-ups

- Scope panels in the studio console (`apps/console`).
- MCP tools for the eight commands.
- A face detector or person matte as the default skin key for per-shot matching, instead of the chroma rule.
- Temporal checks in the gate: frame-to-frame luma and hue flicker across a render.
- Windows in a `timeline.json` render (today a timeline refuses a grade with windows).
- A face detector with pinned weights for skin regions.
- An ACES or log input transform library.
