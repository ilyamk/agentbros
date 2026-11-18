---
name: reference-to-video
description: Make a film in the style of a reference video for the user's own idea or product. Use when the user gives a reference file or link, YouTube or X, plus a task, and wants the same craft with new content.
---

# Reference to video

The film takes the reference's method and none of its content. The bespoke [production chain](../../../docs/production-chain.md) runs it; this page says where the reference enters and what may cross over. To copy a given film as exactly as possible, on the user's explicit request, use [reference replica](../reference-replica/SKILL.md) instead.

## Flow

1. **Decompose.** `pnpm ref:add --file <film> --id <id> --rights study-only` or `--url <link>`, then `pnpm ref:analyze --id <id>`, then the `reference-analyst` agent writes the judged layers and blueprint. Read [reference analysis](../reference-analysis/SKILL.md). If the user's reference is already in `design-reference/library/<id>`, reuse it.
2. **Start the chain.** A reference is a modifier on the playbook for the task ([playbooks](../../../playbooks/AGENTS.md)): `pnpm playbook --match "<request>"`, then its start, e.g. `pnpm film:init --project <project> --type <type> --playbook <pb> --product <material>`. The brief names the reference and what not to take from it. From here use `film:next` as in [creative studio](../creative-studio/SKILL.md).
3. **Numbers.** The `reference` step writes film targets. They hold the film to the reference's pace and stillness through `plan:check` and `film:measure`.
4. **Idea.** `concept-director` writes three ideas for the user's product that use what the reference teaches. A blueprint's slots are a starting structure, not a form to fill: if the idea needs another shape, say why.
5. **Music.** The user chooses (see below). `audio:map` reads the chosen track; `edit:snap --suggest` starts the cuts from it.
6. **Production and judging** as in the chain. The critic gets the reference beside the film. `pnpm ref:compare --id <id> --render <film>` shows the differences.

## What crosses over

| Take | Never take |
|---|---|
| Rhythm: shot lengths, bursts, stops, how it uses silence | Their brand, logo, colours as a set, typefaces |
| Mechanisms: how a transition carries, how type behaves, how a frame is layered | Their graphics, footage, shots, composition frame for frame |
| How sound relates to picture | Their music, unless the user states their rights |
| Structure of attention: hook device, where the turn is | Their copy, numbers, claims |

**Not the reference again.** Before delivery, set the film beside the reference on six axes: structure, opening, signature shot, camera path, score shape, ending. At least four must differ; rethink the ones that match (lemo-opuscar DIRECTOR.md §11, MIT).

A recreation made to learn stays private and is never published. Transferring a mechanism to the user's content is the product's purpose.

## Music from the reference

The music step always asks the user. If they want the reference's track, `music --action from-reference --reference <id>` extracts it as study-only, and embedding stays blocked. Only their own statement of rights (`--rights owned|licensed --rights-note "<their words>"`) opens delivery. Otherwise offer: free stock near its dynamics, a trending track added on the platform, or generation by estimate with consent.

To stay near the reference's feel without its music, compare its audio map with the candidates': `pnpm audio:map --input <reference-film> --output <map.json>`.

## When a mechanism is out of reach

Record it in `techniques.json` as `unreachable` with the best equivalent, tell the user, and don't fake it. Where React can't do it, consider Blender (ask first, see [blender-3d](../blender-3d/SKILL.md)), real footage, or generated material by estimate.
