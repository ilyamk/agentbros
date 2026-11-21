---
name: engine-selection
description: Choose Remotion, Hyperframes, three.js, Blender, Vork, generated video or real footage for a shot. Use when a shot could be made more than one way, before building it.
---

# Engine selection

Decide per shot, from what the shot must show. Remotion stays the main engine: it owns the timeline, captions, audio and delivery, and every other route ends as an imported clip inside it.

## Decide from the shot

Prepared data charts and diagrams use `viz:list` and `viz:prepare` before scene code. SVG is the 2D route; bounded spatial recipes use Three.js or the trusted Blender adapter. Compound groups and fixed-side ports use the reviewed ELK adapter. Choose Three for browser animatics and Blender for a material/light pass; both consume the same immutable plan and frame states. See [visualisations](../../../docs/visualisations.md).

Take the first row that fits.

| The shot needs | Use | Why |
|---|---|---|
| Something real: a person, a place, a product in use, proof | Real footage (skill `recording-guide`, or `resource-discovery` for stock) | Nothing generated counts as evidence |
| Bringing an existing still that carries text, labels or an infographic to life | Remotion, by layers: a clean plate plus one sprite or SVG per component, animated with library blocks | Generated video redraws every pixel, so lettering melts and motion is either lost or traded away; use it only for an ambient plate under masked text |
| A believable scene that cannot be filmed, and exact detail does not matter | Generated video (skill `model-and-asset-production`) | Paid, not repeatable, and text in frame is unreliable. Needs budget approval |
| Photoreal materials and light, simulation, or ready-made 3D models; a hero device shot; a 3D character that must perform (anticipation, squash, a look, a blink) | Blender (skill `blender-3d`: write the shot intent first, then direct it with the craft kit in `scripts/blender/kit/`; device shots from the templates, played by library block `blender-plate`) | Offline ray tracing, physics, depth of field and motion blur that a browser does not do. Costs render minutes ([photoreal 3D](../../../docs/photoreal-3d.md)) |
| Programmable GPU instance fields, authored optical transport or a qualified Vork effect | Vork (`vork-3d-vfx`); explicit Blender bridge when source staging is already in Blender | Import a receipt-bound plate; use measured recipe capabilities and inspect every warning |
| Simple 3D driven by data or the voiceover: an orbit, an extruded logo, a quick or many-variant device shot | three.js through `@remotion/three` (`studio-product-stage` loads the same phone and laptop models) | Stays frame-driven and editable inside the composition |
| Text, data or interface that follows props, captions or the voiceover, or anything you will revise | Remotion | Same source of truth as the rest of the video |
| Text splitting, SVG morph or line draw, path travel, long orchestrated staggers | Remotion with GSAP (`useGsapTimeline` via `src/motion/gsap.ts`; library category `kinetic`) | Seeked from the frame, so it stays on the timeline with captions and audio, and renders the same in any order |
| A shader transition or a ready-made effect whose look matters more than its parameters | Hyperframes | Fourteen named shaders and a large catalogue; building one in Remotion costs more than the clip is worth |
| A self-contained kinetic title that a catalogue block already almost does | Hyperframes, if the block survives the checks below | Otherwise write it in Remotion |

If two rows fit, take the one nearer Remotion. An imported clip cannot follow a later script change without being rendered again.

For generated meshes, project GLB loading and the Blender handoff, read [generated 3D](references/generated-3d.md); use the [3D shot guide](../../../docs/drei-techniques.md) for eligible project techniques.

The in-repo `capture:html` route is a different thing. It is a bounded trusted capture of a pinned subset, limited to 100 frames per batch; see `pnpm capture:html --help`. The route here runs HeyGen's own external CLI.

## Hyperframes route

The tool lives outside the repository, pinned to 0.9.7. If it is missing, the render script returns an `unavailable` error with the install step and installs nothing.

Install with `--ignore-scripts`. Keep the project outside the repository too, because `init` writes its own `AGENTS.md` and `CLAUDE.md` into it. Set `registry` in the project's `hyperframes.json` to `https://raw.githubusercontent.com/heygen-com/hyperframes/8c799ebd1b673dc2a61a06b0ba4e283c1b42b2f4/registry`, because the default follows the `main` branch and `add` would not be repeatable.

Run `init` and `add` with the same contained settings the script uses. Without them the CLI writes to the real home directory, sends telemetry and can update itself:

```bash
HOME=~/.cache/agentbros/hyperframes/home HYPERFRAMES_NO_UPDATE_CHECK=1 HYPERFRAMES_NO_TELEMETRY=1 HYPERFRAMES_SKIP_SKILLS=1 \
  ~/.cache/agentbros/hyperframes/tool/node_modules/.bin/hyperframes add BLOCK --dir PROJECT --no-clipboard --json
```

Then render, check and import:

```bash
pnpm exec tsx scripts/hyperframes-render.ts --project-dir PROJECT --output CLIP.mp4 --block BLOCK --licence SPDX --source PINNED_URL
pnpm exec tsx scripts/motion-strip.ts --input CLIP.mp4 --output STRIP.png --step 2
pnpm asset:import --project ID --input CLIP.mp4 --metadata CLIP.mp4.provenance.json
```

Open the strip and look at it. The script writes the provenance sidecar beside the clip, and refuses `--block` without `--licence` and `--source` because licences differ per item.

Before accepting a block, check these:

- **It is a usable part, not a catalogue card.** `domain-warp-dissolve` is a 1920x1080 demo with a caption panel and "SCENE A" labels. For a portrait shader transition, call the `@hyperframes/shader-transitions` package from your own scenes instead.
- **Read its source for the fitting logic.** Blocks are copied into the project and meant to be edited. `per-word-rise` sizes text by character count, which gave about 50px Cyrillic on a 1080px frame until the rule was replaced. `kinetic-center-build` never wraps, so the same phrase ran as one tiny line, and its inner clip stayed 2 seconds long inside a 4-second host.
- **Set a font with Cyrillic, then look at it.** Name it through the block's font variable and declare it. Strict lint, the script's default, refuses only an undeclared family. A declared webfont that fails to load still rendered in a serif with `ok: true`, so the strip is the real check. Files in `assets/` cannot fail that way.
- **Vendor what it loads.** Blocks fetch GSAP and fonts from CDNs at render time. With the network denied, those renders fail. With GSAP, the shader bundle and the fonts in `assets/`, the same render passed and matched byte for byte.
- **Use `--no-strict` only for the vendored shader bundle.** The linter scans it and rejects its own `Date.now()` and `requestAnimationFrame`, although the render still matched the unvendored one byte for byte. Strictness off means an undeclared font is no longer refused.

## What the trial showed

Hyperframes 0.9.7 on an M1 Max, 1080x1920 at 30 fps, while the machine was heavily loaded (load average 25 to 100). Treat the times as rough.

| Check | Result |
|---|---|
| Cyrillic | Correct glyphs in `per-word-rise` and through the shader, using Unbounded |
| Two renders, same machine and tool | Identical files, for both clips |
| Chrome for Testing 152 against Chromium 157 | Identical files for the shader clip |
| Render time | 3s clip in 7 to 18s; 20s clip in 36s, about 1.8s per video second |
| Import | `asset:import` accepted the clip and carried provenance; frames 14 and 60 showed the matching moments under a Remotion overlay |

Not tested: audio, alpha output, `--docker`, clips over 20 seconds, machines other than this one, and all but two of the 456 catalogue items.

## Licence

Check per item, before use:

- **Tool:** Apache-2.0, from `LICENSE` at tag v0.9.7 (commit `8c799ebd`). The npm package ships no licence file, so the repository is the evidence.
- **Registry items:** read the item's `registry-item.json` and its file header. An item with no `license` field falls under the root licence; one that declares its own keeps it. `kinetic-center-build` is MIT, ported from Remocn. `CREDITS.md` lists seven 3D items with separately licensed parts, some of unconfirmed origin. Avoid those until checked.
- **Shader package:** `@hyperframes/shader-transitions` has no licence field or file of its own, so Apache-2.0 comes from the repository root. Its global bundle embeds html2canvas 1.4.1, which is MIT; a vendored copy carries that notice.
- **GSAP:** every block read in the trial loads it. GSAP, plugins included, is free for commercial use under Webflow's Standard "No Charge" licence (not open source). The owner decided on 2026-11-16 that this project's use (agents writing frame-driven GSAP code for films) is permitted. The licence's one restriction still applies: no use in no-code visual animation builders that compete with Webflow without Webflow's written consent ([NOTICE.md](../../../NOTICE.md)).
- **Fonts:** check each one. Unbounded is SIL OFL 1.1.

## What would change this

- **Move more shots to Hyperframes:** if the showcase review finds its blocks stronger than `src/motion`, and portrait Cyrillic stops needing a patch per block.
- **Drop the route:** if a pinned version stops rendering, if the GSAP terms rule out the intended use, or if repeat renders stop matching.
- **Never make it the main engine** while captions, audio mix, review and delivery live in Remotion. A clip here has none of them.
