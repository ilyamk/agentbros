# Craft rules

Numbers for motion-director and motion-engineer. The film-level bar (idea, sound first, 4× shot variety, carriers across cuts, the signature move, the blacklist) is in [creative-standards.md](creative-standards.md) and is not repeated here. Sources and reasons for each number: [library-sources.md](library-sources.md). Frames assume 30 fps; multiply by 2 at 60.

## Eases by role

| Role | Curve | Duration |
|---|---|---|
| Arrival, reveal | `Easing.bezier(0.16, 1, 0.3, 1)` | 0.4–0.8 s (12–24 f) |
| Exit | `Easing.bezier(0.6, 0, 0.9, 0.35)` | 50–60% of its entrance |
| State to state, camera, colour flood | `Easing.bezier(0.65, 0, 0.35, 1)` | 0.4–0.7 s |
| Zoom through, accelerating exit | ease-in (`bezier(0.6, 0, 0.9, 0.35)`) | 0.3–0.4 s |
| Value that lands (meter, slider) | `Easing.bezier(0.55, 0, 0.2, 1.12)` | 0.6–1.0 s |
| Fast move (whip, carry, punch) | arrival curve plus motion blur | 0.3–0.6 s |
| Linear | only rotation, progress, constant drift, grain | — |

- Never give two different roles the same curve and duration in one shot.
- Scale duration by distance: 100 px 1.0×, 300 px 1.5×, full frame 1.8–2.0×.
- Use springs for physical objects and UI; use bezier for type and camera. Opacity and colour never bounce.
- Springs (`damping/stiffness/mass`): settle 14/140/0.8; heavy panel 18/200/1; snap to a step 12/190/0.75; pop 10/215/0.7; elastic 8/200 for one hero moment per film.
- Overshoot by material: rigid and glass 0%, paper 3–5%, fluid 5%, rubber 15–25%. A premium style has 0% on type.

## Choreography

- One hero move per shot. Secondary moves travel 50–70% as far and start 3–6 f later. Everything else holds.
- Start the next element when the previous one is 30–50% done. Never fully sequential, never all at once.
- Stagger: letters 1 f, words 2–4 f, list items 1–3 f, chips 6–8 f. The whole stagger lasts ≤ 0.6 s.
- A landed title or UI state is dead still until it leaves. Put ambient life only in the ground, the grain and the world.
- No breathing, floating or pulsing on titles and UI. No slow creeping scale on a title. No click rings, and no bounce on UI chrome.
- If the film feels busy, remove a third of the motion and keep the moves that lead the eye.

## Motion blur

- Wrap every move faster than about 30 px/frame in `HtmlInCanvasMotionBlur` (`@remotion/motion-blur`, shutter 180, samples 8).
- Peak smear at the fastest frame: 6–12 px on text-sized elements, 15–20 px full frame. Smear a horizontal move horizontally only.
- Whip: 4–9 f. The arriving element lands blurred and sharpens in 4 f.

## Type

- Type is bimodal, never in between. When type is the shot, a hero word or line fills 50–95% of the frame width (`type-hero-word`, `type-word-pulse`, `type-sentence-build`). When footage, UI or product is the shot, a caption line spans about 10% of the width (under 12%), small and centred, out of the subject's way. Nothing between: a 25–35% headline, or a kicker, headline and subline stack, is the template look. The 28 px floor below still holds.
- Display tracking −0.02em at ≥ 100 px, line height 1.0. Mono caps labels at +0.2em are decoration only and never carry meaning.
- Nothing meant to be read under 28 px at 1080 (2.6% of the short side). Cut words, never shrink.
- ≤ 6 words a title line, one line on screen at a time. Kinetic type 3–7 words per scene.
- Hold to read: 0.5 s + 0.3 s a word. The final line ≥ 2 s. A one- or two-word chapter line may hold 0.4 s.
- Vary entrances within a film. Pick from: per-word blur 6 → 0 px over 4 f, 2 f apart, no translate; per-word grey to ink, 2–3 f apart; whole-line blur 8 → 0 over 4–6 f; per letter for a name, 3 f apart, opacity 0.3 → 1; behind the subject; one word slot-rolling at 3 f a roll.
- Exit text with blur-out and fade over 4–8 f, or with the scene's move.
- Accent colour on one word per line, and only where it carries meaning.

## Frame and depth

- The hero fills ≥ 40% of the frame's height or width. Never a small card in a large field.
- Build 3–4 planes in a feature frame: ground, world detail, subject, and an optional foreground occluder. Camera parallax about 0.3× / 0.6× / 1.0× / 1.4×. (Proposed, unsourced: test it.)
- Show real UI at 1.6–2× its real size, cropped to what the beat uses, with text ≥ 26 px after the push. Never a floating window on a void, never UI tilted in 3D.
- Make placeholders monochrome: ink at 72% (subject), 45% (support), 18% (media fill), 8% (recessed tray), plus a hairline.
- Something new every 2–4 s. With music, a new layout every bar.
- Keep the 90% action-safe and 80% title-safe areas. On 9:16, keep text out of the top 168 px and below 1330 px.
- Frame 0 is the thumbnail: never black, never a logo alone.

## Light, colour and finish

- Grain: frame-seeded, 0.06–0.09 opacity, overlay blend, reseeded every 2 f.
- Vignette: transparent to 55%, then up to `rgba(0,0,0,.55)` at the edge. For a cinematic look, 6% darkening at the corners.
- Never a full-frame linear gradient on a dark ground, because it bands in H.264. Use a solid plus a local radial light.
- Atmosphere accents at 15–25% opacity (5% disappears in compression). The focal element is at full saturation.
- Write "premium" as a material with numbers: 2% grain, a contact shadow at 0.55 opacity, chrome roughness 0.05.
- Write "cinematic" as warm key upper left, cool rim behind, 6% vignette.
- 3D: warm key, cool rim, dark environment with 2–3 soft strips. Turn the environment, not the object. Always a contact shadow.
- Banned unless the brand uses it: glow, bloom, lens flares, orbs, decorative particles, purple or blue mesh gradients, glass cards, dark void with floating UI, cream paper with serif and mono caps labels, three cards in a row, a docked logo.
- Shadows sized for video: a web 1 px border or 6% shadow vanishes. Proposed, unsourced: ≥ 2 px lines, and shadows at ≥ 20% opacity with blur ≥ 24 px.

## Transitions

Use 3–5 kinds per film, each caused by something on screen. A hard cut is caused when it lands on a downbeat or surge with a ground swap or a hero hit; uncaused hard cuts are ≤ 1/3 of the seams between beats. Worlds never crossfade into each other.

| Kind | Build |
|---|---|
| Zoom through | track to the object with blur (18 f), then scale it ~8% → 250% of the frame in 10 f, strong ease-in. Its fill becomes the next frame. |
| Object becomes world | a card grows past the frame in 20 f in-out while its radius shrinks; surroundings blur 15 px and fade over 9 f |
| Morph | one container widens into the next (~110 → 880 px in 6 f) with horizontal blur 12 → 0 |
| Carry across | the result scales 1 → 0.6 with blur peaking at 6 px and lands inside the next scene as it builds |
| Colour flood | the hero stays; the ground changes colour in 12 f, in-out |
| Iris | a circle clip opens from the clicked point in 5 f |
| Dip cut | darken the outgoing frame 40% for 3 f, then hard cut |
| Blur swap | out: fade with 8 px blur over 4–6 f; in: blur → 0 over 4 f; the ground never cuts |

Cut at a move's fastest frame, with the same direction and speed on both sides. Mirror the eases across the seam (ease-in out, ease-out in).

## Rhythm and sound sync

- Plan on the music's frames: `beatGridFromMap(map, { fps, offsetSec })` (`src/motion/sync`). Every structural moment (cut, ground swap, hero hit) sits on a downbeat or a surge; beats only inside a burst. Picture leads by kind (`leadFrame`, defaults: cut and transition 1 f, hit 1 f, reveal, stop and sfx 0); `edit:snap` applies them. Never type a frame number.
- The end stops hard on the music: the last cut or the mark lands on a hard-stop or the final downbeat, and the track ends there (`music:backtime`). No fade-out unless the music fades.
- Sound comes from the same frames: blocks' `cues(props)` through `sfx:cues` and `<CueSounds>`; the master is mixed with `audio:mix --preset social`.
- Audio-reactive motion (`audio:curves`, a block's `react` prop) is the one exception to "no pulsing on titles", and only where the music is the subject: a drop, a beat-led opener, a ground that moves with the bass. Scale pulses ≤ 3%, brightness ≤ ±6%, one reactive element per shot, never on UI or a title that should read still. Constant pumping all film long is a template, not a rhythm.

- Montage shots 4–24 f. A demo holds one framing 7–10 s while the UI acts. Average shots 1.8–3 s, with motion inside them.
- Hold 0.3–0.75 s before the payoff. The payoff plays at normal speed.
- A move that lands on a hit starts 40–190 ms (1–6 f) before it. A reaction starts 0–45 ms after. The hit frame itself is a set, not an ease.
- Any one treatment goes stale after about 6 s: change the treatment or hold, never slow the tweens.
- Count-ups take 1.2–1.6 s, then hold, landing on a downbeat.
- With no track yet, beat frames come from `fallbackGrid` (`round(i × fps × 60 / BPM)` from the beat index, never a rounded beat added repeatedly); with a track, only from `beatGridFromMap`.

## Block choice

Library first (`pnpm library:list`); these decide which block.

- Items with `sparing` (flares, light rays, light burn, slice panels, grid floor, spotlight studio) never by default. Use one only when the idea names what it does, and say why in the plan.
- Light grounds are a choice, not a default dark void. A ground swap on the cut (`ground-swap-cut`, `type-word-pulse`) is a cut device: the ground changes on the same frame as the type, on a downbeat.
- A product's interface is the real one, 90–100% identical ([real-ui](../docs/real-ui.md)): the real page or app recorded (`capture:app`, computer use, the local repo with test data), or a pixel-faithful replica of a platform built from a dated reference screenshot. Read it at reading scale with `ui-camera-read`. Generic `ui-*` blocks are for interfaces that belong to no named product; a grey box is an animatic, never a finished shot.
- Type builds use the GSAP kinetic blocks (`--category kinetic`) or `type-sentence-build`; hand-written per-letter tweens are a defect.
- A hero product shot is a Blender plate (`blender-plate`, the `blender-3d` skill); three.js stages are for abstract or diagrammatic 3D.
- Effects (`--category effects`: ripple-drain, film damage, CRT tape, collage) only when the idea calls for that material or carry; never as polish.
- A change of state happens in place (`caused-morph`) before a cut is chosen; `speed-ramp-flurry` once, at the acceleration.

## Structure (shares of the film)

Measured on a launch film of about 35 s. The 15 s and 60 s columns are extrapolated.

| Beat | Share | 15 s | 30 s | 60 s |
|---|---|---|---|---|
| Hook: the need, or the feature already working | 8% | 1.2 s | 2.4 s | 5 s |
| Tension: the old way failing on screen | 12% | merge into hook | 3.6 s | 7 s |
| Reveal: the name, 20–30% in | 8% | 1.2 s | 2.4 s | 5 s |
| Proof: 3–6 verbs in the real UI | 40% | 2 verbs, 6 s | 4 verbs, 12 s | 6 verbs, 24 s |
| Payoff: the biggest moment, once, 60–80% in | 20% | 3 s | 6 s | 12 s |
| Claim: one line | 8% | merge into end | 2.4 s | 4 s |
| End card: mark performed, CTA held | 8% | 2 s | 2.4 s | 3 s |

## Before you call a shot done

- Look at a sheet 0.3 s after each beat, a strip −0.2/+0.2 s across each cut, and a 360 px phone sheet.
- Flag any stretch over 3 s with nothing changing, any line shown for less than its reading hold, and any text under the floor.
- Write each note as one line, `t · where · problem → change · what stays`, ranked P0/P1/P2. Never give a score.
- List every banned default the frames show and add it to the film's BANNED line.
