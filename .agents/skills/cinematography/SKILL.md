---
name: cinematography
description: Plan a shot's framing, light, lens, camera motion and continuity for generated video or a recording.
---

# Cinematography

Read the approved brief, relevant project artefacts and `AGENTS.md` first. Use this skill when its decision is needed; do not invoke every craft skill for a simple edit. Keep leaf-agent work at depth one. Existing approval and no-spend instructions take precedence.

## Decision and output

Produce `shot-spec` in `pipeline/craft/cinematography.json` (or the owning stage artefact when its schema already covers these fields): subject/action, shot scale, geography, eye-line, screen direction, camera/light, movement purpose, timing, audio and invariant details. Distinguish observed facts, artistic choices and unresolved assumptions. Preserve approved source/version pins.

Express the decision in the owning brief/script/design/storyboard artefact before generating assets. For a generated shot the spec also names its reference inputs: the key frame it starts (and lands) on, any camera or motion reference clip, and whether a previs pass is needed (a Blender blockout rendered with `refs:derive` `blender-pass`) because the move or geography must hold exactly; the material step plans them ([reference-preparation](../reference-preparation/SKILL.md)). Tools and generation permissions come from the creative-studio router.

## Worked decisions

- A macro insert proves the product’s texture, followed by a wide shot locating the same object.
- A slow push-in accompanies a change of conviction and ends before the key line.

Failure to avoid: A camera orbit reveals a logo from the back while the approved shot requires a front label.

## 3D shots

For a Blender shot the same decisions become code: the shot's function (hook, reveal, proof, cta) picks the rig role (hero 85 mm, reveal 50 mm, detail 100 mm, establishing 35 mm), the move (push-in, crane, orbit, dolly, rack focus, a band-limited handheld) and the light mood (soft-product, high-key, low-key, rim-hero, golden-hour, neon-night, overcast) in `scripts/blender/kit/`. Table and vocabulary: the blender-3d skill and its [directing](../blender-3d/references/directing.md) reference. The camera moves for a reason you can name and more slowly than the subject.

## Alternatives and review

A locked shot is often stronger for charts and demonstrations. Lens words express visual intent to models; do not promise physically exact optics.

Review: Does every decision serve the brief? Is there concrete evidence for technical/factual claims? Are timing, continuity, rights and cost assumptions explicit? Can another agent reproduce or revise the decision from the recorded artefact? Use [evaluation briefs](../creative-studio/references/evaluation.md) for review; heuristic scores do not prove audience response.
