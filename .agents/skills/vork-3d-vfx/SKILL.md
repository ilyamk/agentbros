---
name: vork-3d-vfx
description: Author local Vork 3D shots, procedural geometry, GPU effects and footage inserts, or exchange scenes and passes with Blender. Use when a shot needs Vork's programmable rendering or GPU computation.
---

# Vork shots

Vork is an optional pinned local renderer. Remotion keeps the timeline, type, audio and delivery. Choose a named capability from the shot's idea, not because another renderer is installed. Read [engine selection](../engine-selection/SKILL.md), then `pnpm vork:setup --action status` and `pnpm vork:recipe --action list`.

## Direct the task

Describe the shot's function, what the viewer must notice, source assets, geometry/material, action, camera/light, effect semantics, duration/FPS/seed and acceptance evidence. A rendered shape is not a substitute for a real product. Keep the actual model, logo and UI when the film shows one.

Create a source revision with `pnpm vork:scene --action init --id product-stage --output <source-dir>`. Its generated task is the strict contract. `pnpm vork:scene --action brief --task <task.json>` supplies the focused implementation prompt. The agent authors ordinary scene JSON, Python and local Slang; Vork is not a text-to-video model. Use `vork help <topic> --all` from the prepared runtime for exact fields; read only the relevant topic.

Check with `pnpm vork:scene --action check --task <task.json>`. Render a few low-resolution frames, open the images, then render a contiguous movement proof. Use a fresh output directory per revision. Only then render final settings with `pnpm vork:render --task <task.json> --output <run-dir> --encode h264`. `std/previs` omits lighting; `std/final` approximates indirect transport. Use `std/path` when optical transport is the point, and measure it.

Read every warning and bridge omission. Success with a dropped effect is not acceptance. More samples cannot repair omitted light paths, missing geometry or a poor shot. Static final frames hold unless the shot specifically intends a fade.

## Routes

- **Geometry, shader and compute shots:** [programming](references/programming.md).
- **Blender scene, geometry return or render passes:** [Blender](references/blender.md).
- **Real footage, camera estimates and holdouts:** [VFX](references/vfx.md).
- **Quality and reproducibility:** `pnpm vork:eval --action run --ids product-stage --output <proof-dir>`; inspect the report and pictures. Three-frame checks do not establish whole-clip stability. Use `vork:eval --mode qualification --action run --input <suite.json> --output <fresh-dir>` for complete clips with bound framing/tracking, isolated repeats and two independent reviews; all phases must pass.

Project sources live in its existing ignored asset footprint. Import a verified encoded video/single PNG with `--project <id> --import`; include the resulting imported references in `build.localAssets`. RGBA sequences and EXR are finishing inputs. Keep their receipt and declare the source files before production assembly; prefer a registered alpha-capable video for a portable plate.

Only measured capabilities may be recommended as qualified. Use the existing independent critic/A-B process; user creative acceptance is separate. Local licences, runtime availability and render quality are separate facts. No implicit cloud, model downloads or new paid generation. Runtime installation is explicit through `vork:setup`; trusted arbitrary code stays off MCP.
