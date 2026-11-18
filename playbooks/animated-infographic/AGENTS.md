# Animated infographic loop playbook

Last updated: 2026-11-17

An existing still (infographic, diagram, poster) becomes a short seamless loop for a README, docs page or post. Draft: the method comes from one project (the CONTRIBUTING header) and has not yet delivered.

## Start

`pnpm film:init --project <id> --type motion-graphics --playbook animated-infographic --product <path>`, then `pnpm next --project <id>`. Before anything is built, agree the motion list with the user: each component, what it does, and when.

## What good looks like

- The picture tells its own story in motion: a token travels the route, gates light in turn, props react. Light and glow alone are not an animation.
- Every label is the source's, exact and sharp, in every frame.
- The seam is invisible: the last frame equals the first.
- The file fits where it is shown (README GIF under 10 MB).

## Method

1. **Component list.** From the still and its prompt, name each component with its box and its motion (idle loop plus story beat). Example: [contributing map spec](../../docs/readme/contributing-map.md).
2. **Engine.** By [engine-selection](../../.agents/skills/engine-selection/SKILL.md): a still with text is built in Remotion by layers. Generated video is only an ambient plate under masked text, and only with the user's approval of the exact prompt and motion list.
3. **Layers.** Regenerate a clean plate and one transparent sprite per component with the same prompt and box, or trace flat parts (routes, frames, arches) to SVG. `pnpm matte` can cut a component from the flat still when regeneration is not possible.
4. **Motion.** Library blocks first (`pnpm library:list`): `kinetic-path-travel` for a token on a route, `parallax-rig` for depth, `flare-pulse` for flashes. Frame-driven only; stepped values for bulbs.
5. **Check.** `pnpm motion:still` and `motion:strip` per beat; `pnpm motion:check` (loop seam, dead frames); `pnpm film:measure --render <file>` confirms motion is spread over the frame, not one corner.
6. **Ship.** ffmpeg `palettegen`/`paletteuse` at the agreed width and fps; keep the MP4 beside it.

## Tools

`film:init`, `next`, `library:list`, `matte`, `motion:still`, `motion:strip`, `motion:check`, `film:measure`, `delivery`. Skills: `engine-selection`, `motion-library`, `motion-and-typography`.

## Anti-patterns

- Image-to-video on a text-heavy still with a prompt that freezes everything but light: the result is static and the request is lost.
- Paying for generation before the user has seen the prompt and the motion list.
- Declaring done from a contact sheet: it shows stability, not motion. Measure.

## References

- [Contributing map spec](../../docs/readme/contributing-map.md): components, boxes and per-component motion.
- [README visuals prompts](../../docs/readme/PROMPTS.md).

## Done when

Draft until: one loop is delivered and accepted by the user through this method; intake and QA items are reviewed against that project; a benchmark task exists.
