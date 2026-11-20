# Colour craft: how colourists think

Working knowledge behind the colour commands, written so an agent can reason about a grade instead of tuning numbers until a metric is satisfied. Sources are general professional practice: the order of operations taught in grading courses and in DaVinci Resolve's documentation, and the ITU-R BT.709 and BT.1886 standards. No title-specific LUTs or recipes are reproduced.

## Order of operations

1. **Technical balance per shot.** Black point, white point, exposure and a neutral grey axis. Nothing creative happens until each shot is balanced on its own.
2. **Shot matching.** Make the shots of one scene read as one place and time. Skin and the key light's colour match first, then the environment.
3. **The look.** One creative treatment over the matched scene: contrast shape, the colour of shadows and highlights, the saturation budget, separation.
4. **Secondaries.** Qualified corrections for what the look broke: skin, skies, product colours, a distracting object.
5. **Windows.** Spatial corrections: relight a face, darken an edge, guide the eye. Tracked or matted, never static over moving content.
6. **Finish.** Highlight roll-off, legal levels, then a check on the delivery file.

Each later stage assumes the earlier ones held. A look on unbalanced shots multiplies the imbalance.

## Skin is the anchor

- **The skin line.** On a vectorscope, healthy skin of every ethnicity sits near one hue, about 123° in this tool's convention. Skin varies mostly in lightness and chroma, not hue. Viewers forgive a teal room; they do not forgive a green or orange face.
- **Memory colours.** Skin, sky, grass and familiar brand colours have expected hues. Moving them reads as wrong before it reads as style.
- **Skin follows the light, within limits.** In a low-key, teal-lit scene skin is darker, desaturated and slightly cool, as in the stark-promo original (skin L* about 25, chroma about 7%). A grade may move skin with the scene's light but must not invent a colour the light does not explain.
- **Measure skin on fixed pixels.** Key skin on the source (a region, a track or a matte) and read the same pixels after grading. A key recomputed on the graded frame catches whatever the grade turned skin-coloured, and hides what it did to the face.

## Separation

A cinematic image separates subject from background through contrast in luminance, hue and saturation:

- **Complementary.** Warm skin against a cool world (teal and orange), or the reverse.
- **Saturation.** A muted world around a richer subject, or the reverse.
- **Luminance.** A brighter key on the face than on the room (low-key lighting), and dense blacks.

Lift, gamma and gain move every hue together, so they cannot create hue separation. Separation needs secondaries: the environment keyed and rotated, skin keyed and held.

## Why a statistical match fails, and what replaces it

Matching a frame's statistics (zone means, quantiles) to a reference is underdetermined. Many grades reach the same means, including one that warms the face while the background stays blue. That is what happened in the first stark-promo match: zone ΔE fell from 7.0 to 0.7 while skin chroma doubled and turned yellow. The rules that replace it:

- **Match per shot.** A film is graded shot by shot. Pooling a warm interior and a cyan close-up averages two looks into one that fits neither.
- **Put skin in the objective.** The primary is fitted with a skin term toward the reference skin, or toward the source skin when the reference has none.
- **Separate with secondaries.** An environment secondary rotates the dominant non-skin hue toward the reference's. A skin secondary lands skin on its target.
- **Validate on the delivery file.** Run the gate (`colour:check`) on skin chroma, hue and yellow drift, crushed blacks, clipping, saturation and legal range. Zone ΔE alone is never proof.

## Without a reference

The technical pass comes first: neutral greys (a*/b* of near-neutrals within ±1.5), black near 0–2 IRE, specular white under 100 IRE, mid-grey near 40 IRE, skin on the line. Then pick a look for the film's intent: what the audience should feel, the genre, the platform. `colour:looks` shows candidates on the actual frame with skin held, and each has its intent, typical use and risks. The agent explains which look fits the brief and why; the user chooses.

## Looks as families

| Family            | Typical moves                                                                   | Watch for                            |
| ----------------- | ------------------------------------------------------------------------------- | ------------------------------------ |
| Technical / clean | Neutral axis, mild S-curve, roll-off                                            | Shows every mismatch between shots   |
| Film              | Shaped contrast, coloured shadows/highlights, restrained saturation, separation | Skin hue drift, crushed blacks       |
| Commercial        | Brighter, cleaner, product colours accurate, skin flattering                    | Clipped whites, video-like flatness  |
| Music video       | Bold hue splits, high saturation, crushed toe                                   | Illegal chroma, compression blocking |

## Validation thresholds (the gate)

| Check                                   | Warn                | Fail         | Why                                          |
| --------------------------------------- | ------------------- | ------------ | -------------------------------------------- |
| Skin chroma vs the look's policy        | ×1.25 or ×0.7       | ×1.5 or ×0.5 | Orange or grey faces                         |
| Skin hue beyond the allowance           | > 0°                | > 10°        | Off the skin line                            |
| Skin b* gain                            | +5                  | +9           | Yellow skin, the stark-promo v1 failure      |
| Crushed blacks over source or reference | +1 pp               | +4 pp        | Lost shadow detail                           |
| Clipping over source or reference       | +0.3 pp             | +1.5 pp      | Lost highlights                              |
| P90 chroma over source or reference     | ×1.4                | ×1.8         | Garish colour, illegal chroma after encoding |
| Secondary spill off skin                | ΔE 2                | ΔE 4         | A key that recolours the set                 |
| Skin vs reference skin                  | ΔE 6                | ΔE 10        | Did not match the reference's faces          |
| Legal luma in the file                  | 0.5% outside 16–235 | —            | Broadcast and platform limits                |

A pass means none of these broke. It does not mean the grade is good; that is the user's judgement.
