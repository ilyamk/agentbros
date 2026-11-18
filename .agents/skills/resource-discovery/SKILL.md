---
name: resource-discovery
description: Find stock footage, images, effects, fonts, SFX and music candidates with provenance, licence evidence and originals kept.
---

# Resource discovery

Read the approved brief, relevant project artefacts and `AGENTS.md` first. Use this skill when its decision is needed; do not invoke every craft skill for a simple edit. Keep leaf-agent work at depth one. Existing approval and no-spend instructions take precedence.

## How to look

Search from the idea and the film's shape, not from the product category. A resource is right when you can say what it does at a moment in the film; if you can only say it looks nice, you are picking a clip and writing a reason afterwards. Never choose a topic or an idea because an asset already exists. Describe what you need in physical words first: instrument, tempo, material, weight, distance, light. Then search, with two or three different angles, because a search's first page shows what is popular with its index and nothing about your film. Prefer the real thing: real product, real interface, a real recording over a simulated one.

Music is not yours to pick. The route and the track are the user's, chosen by ear, and a shortlist is its own job for [sound-director](../../agents/sound-director.md):

| Need | Command |
|---|---|
| Music routes, to put to the user word for word | `pnpm music --action options --project ID` |
| Stock with its licence per track | `pnpm music --action search --project ID --route free-stock --query "Q" --commercial` |
| Stock measured against a tempo and shape | add `--bpm 140 --duration 16 --drop-at 4 --ending hard --analyse`; sources in `design-reference/music-sources.md` |
| Charts, for a sound added on the platform; never embedded | `pnpm music --action trending --project ID --market us` |
| The candidates to hear, each with an audio map | `pnpm music --action shortlist --project ID --from A.json --top 3` |
| The original, with licence evidence | `pnpm music --action acquire --project ID --candidate ID` |
| Sound effects by material, CC0 packs cached once | `pnpm sfx:library --action find --query "soft wood thud" --limit 5` |

For Blender models, materials, HDRIs and node assets, check `pnpm blender:arsenal status` and local `blender:assets` search first. A missing capability follows the [arsenal growth process](../blender-3d/references/arsenal.md): built-in first, rejected/proposed candidates, evidence, consented trial and owner approval.

## Decision and output

Produce `resource-candidates` in `pipeline/craft/resource-discovery.json` (or the owning stage artefact when its schema already covers these fields): provider/id, source URL, preview vs original, match reason, quality, licence evidence/date, commercial status, attribution and acquisition receipt. Distinguish observed facts, artistic choices and unresolved assumptions. Preserve approved source/version pins.

Use `pnpm exec tsx scripts/resources.ts --help`. Search/inspect before acquire; produce the licensing report for the final asset set. Use [freemium routes](references/freemium-routes.md) for task routing, stock photos and video (Unsplash, Pexels, Pixabay), NASA metadata and honest Kenney/ambientCG/Rive manual originals.

## Worked decisions

- Choose a CC0 effect with the original source and record the licence rather than trusting its filename.
- Keep a TikTok native music selection as a platform-specific manual delivery step.

Failure to avoid: Download popular music from an arbitrary video and mark it cleared for YouTube advertising.

## Alternatives and review

Unknown rights block commercial release until evidence is supplied. A search hit, API key or paid subscription alone does not establish rights for every usage.

Carry advertising, endorsement and standalone resale intentions into the [strict delivery request](../../../docs/delivery.md) as `usage` flags. A pinned product-ad marker enforces advertising even when omitted by the caller. Preserve the acquisition provider/receipt and original-page credits; identifiable NASA/Pexels/Unsplash/Pixabay imported assets retain route restrictions after receipt loss. Stock licences need no credit; the receipt keeps the creator, and `--credit` on acquire (or `--action credits --project ID --all`) puts it in release credits when the user or a placement asks. Named human exceptions need the exact used checksum, every placement and explicit coverage for each effective special use. Inspect manifest `reviewEvidence.resourceUse` and its context SHA; these records document declared use and supplied evidence, without establishing legal permission.

Review: Does every decision serve the brief? Is there concrete evidence for technical/factual claims? Are timing, continuity, rights and cost assumptions explicit? Can another agent reproduce or revise the decision from the recorded artefact? Use [evaluation briefs](../creative-studio/references/evaluation.md) for review; heuristic scores do not prove audience response.

For supplied public post or track links, use `pnpm media:fetch --project ID --url URL`; inspect `--doctor` and `--capabilities`, retain provenance and unknown rights, and follow [media acquisition](../../../docs/media-fetch.md).

## Icons and logos

For a visual metaphor, brand mark or wordmark, read [project icon resources](../../../docs/icon-resources.md). Check `pnpm resources:icon-profile --project ID --action show`, search/inspect before acquire, and preserve the returned usage IDs and public paths. Use the existing icon-visual block; keep one family per project. Brand rights remain separate from the library licence.

## Expanded Openverse discovery

Read [audio integrations](../../../docs/audio-integrations.md) for category, length, source, image ratio/size and intersecting commercial/modification filters. Retain original source metadata, author, licence evidence and separate thumbnail/audio preview. Inspect before acquisition. Openverse is an index: Freesound originals require its native API/OAuth, Jamendo follows the music commercial policy, unknown originals stay manual. Reconfirm changed rights/credit metadata; a preview cannot become a licensed original by renaming it.


For a video remix without a source, inspect `pnpm motion:library --action sources`; research fresh candidates for the intended market/category and record each immutable dated candidate with `--action add`. Search the project shortlist with `--action search`; optional metrics must be observed, never inferred. Reuse authorised originals first; `media:fetch` plans acquisition of supported public posts with its own quota/budget. No supported public Higgsfield Motion Library feed/download contract is established. A permitted original export can be imported; a preview or a popular post is not a licence. Keep unavailable originals pending and offer licensed stock or a recorded performance without calling it a proven trend. Source selection does not authorise likeness processing or soundtrack reuse. [Genjutsu recipe](../../../docs/higgsfield-prompting.md#prepared-genjutsu-workflow).


A supplied Higgsfield card or direct original link uses `hf:media --action resolve` and `--action acquire`; a missing original remains pending. It reads exposed static metadata, never private catalogue APIs or browser sessions. Record `acquisition: "public-link"`; after acquisition, a new motion candidate can carry its assetId and remoteMedia receipt binding. The imported original supports local review; its checked URL can be reused without uploading when no transformation is needed. [Checked remote originals](../../../docs/higgsfield.md#public-content-links-and-checked-remote-originals).
