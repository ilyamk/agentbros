---
name: reference-preparation
description: Plan, prepare, bind and review the reference inputs of a generated shot (character, location, product and style images, first and last frames, motion, camera and control clips, voice) with refs:plan, refs:derive and refs:pack before any paid request that takes references; then review the result against them.
---

# Reference preparation

Use it when a generated image or video takes inputs besides the prompt, and when a result drifts from its references. Root rules on spend, approvals and real people take precedence. Current behaviour, storage and commands: [reference packs](../../../docs/reference-packs.md). Craft per artefact: the references below.

## When a shot needs a plan

- Every `generated-image` or `generated-video` item in `pipeline/material.json` either has a shot in `pipeline/references.json` or carries `referencePlan: {mode: "none", reason}` because it deliberately uses no inputs. Never use `none`, or `required: false`, to make a gap pass.
- `pnpm refs:profiles --action for --endpoint ENDPOINT` says whether the endpoint is profiled. `profiled: false` means no pack can be built: tell the user, prefer a profiled endpoint for a shot that needs references, and never pass hand-made reference fields as if they were checked.

## Flow

1. **Profile.** Read the profile's slots, roles, limits, dialect, `policies.realFaces` and `guidance` with their evidence tiers. A limit or dialect tagged `unverified` is said to the user as such.
2. **Cards.** `pnpm entity:card --project ID --action coverage --kind KIND --id ENTITY`; fill missing views and fix warned rules (characters, products, locations, style below). The user approves cards; a pack uses only approved revisions.
3. **Requirements.** `pnpm refs:plan --project ID --action draft --shot SHOT --material-item ITEM --intent INTENT --endpoint ENDPOINT --write`, adding `--entity kind:id[@rev]` per card, `--asset role:sha256:HEX` per imported file and `--chain-from SHOT` for a continuation. Read `dropped`, `notes` and `findings`; sharpen each `roleSentence` to say what to take and what to ignore. Then `pnpm refs:plan --project ID --action check` and `--action status`; status names the command that resolves each open input.
4. **Derivatives.** A file outside a slot's limits gets a derivative, never a changed limit: `pnpm refs:derive --project ID --action plan --spec SPEC.json --dry-run`, then `--action run` after the user's material approval. A paid step runs only with `--confirm-spend` after the user saw its quote and said yes. Spend admission hashes the approved `pipeline/material.json`: under an enforcing step guard, editing it after the yes refuses every `refs:derive --action run` (even a free one) until the user approves again, so run derivatives before adding pack bindings. Which ops exist: [derivatives](../../../docs/reference-packs.md#derivatives).
5. **Pack.** Write a `ReferencePackSpec` (`src/types/references.ts`): attachments with `requirementKey`, resolved `assetId`, `slot`, `order`, `roleSentence` and, for element slots, `element`; the prompt's `action`, `invariants` (each card's `fixedSentence`, verbatim), `camera`, `audio`, `preserve`, `otherSubjects`, `avoid`; `params`; `audioPolicy`. `pnpm refs:pack --project ID --action prepare --spec SPEC.json`, then open its board and fill a copy of its `pipeline/reference-packs/<id>/visual-review-template.json` from what you saw.
6. **The user's yes.** Show the board and the compiled prompt. `--action rights` and `--action approve --review REVIEW.json --answer "<the user's words>"` record the user's own statements, never yours or a proxy's. Card approval, pack approval and spend approval are three different answers. Order: material yes, derivatives and packs, then the video items with their `referencePack` bindings, then a second material yes before any `generate:model`.
7. **Request.** `pnpm refs:pack --project ID --action request --id PACK` gives the request with `context.referencePack`; dry-run it with `generate:model` and follow the material spend gate (`model-and-asset-production`). Never edit `pipeline/reference-packs/<id>/request.json`: changed inputs, prompt or params are a new pack id.
8. **Result.** `pnpm refs:pack --project ID --action result-board --id PACK --result FILE`, review the full clip against the attachments ([failure modes](references/failure-modes.md)), record `--action review-result --id PACK --review REVIEW.json`, then `pnpm memory --add` an observation: family, attachment roles and count, verdict, failing dimension. A reshoot is the user's decision.

## Hard rules

- **Never hand-write markers**: no `@Image1`, `@Video1`, `@Audio1`, `@Element1`, "image 2" or tags in prompt fields, `pipeline/material.json`, requests or notes. `refs:pack` compiles them from the profile's dialect ([markers](references/markers.md)); prompt fields name inputs in plain words. Positional slots (start or end frame, motion-control inputs) are never named.
- **Never exceed a profile, never invent a limit.** Limits, durations and counts come from `refs:profiles`; unknown stays unknown. Do not borrow a sibling model's limits or edit profile data to make a file fit.
- **One role per attachment**, one sentence saying what to take; a small coherent set beats filling every slot.
- **Re-inject anchors instead of chaining**: a continuation re-attaches the original identity references (`anchor-reinject`); a last frame alone is never the identity source.
- **Real faces**: a character whose likeness consent is not `not-applicable` never goes to a profile with `realFaces: rejected`, not even to try; unknown consent stops for the user. A voice sample needs documented voice consent unless it is designed or synthetic.
- **Missing stays missing**: never invent an asset, URL, card view or approval; a required input with no source is a question for the user.

## References

Each file is a preparation checklist with sources. Tiers: **[O]** official docs, **[P]** paper, **[3P]** wrapper or practitioner, **[Obs]** observed in this harness, **[U]** unverified; the date is when the claim was last checked against its source. Every model-specific number carries its source, tier and date in the same bullet; the profiles in `src/lib/models/reference-profiles.json` are what the compiler enforces.

- [characters](references/characters.md): identity, angles, wardrobe, expression, several people.
- [locations](references/locations.md): plates per lighting state, reverse angles.
- [products](references/products.md): packshots, labels, logos in post.
- [style](references/style.md): style apart from content.
- [motion-video](references/motion-video.md): motion, performance, camera and source videos.
- [control-signals](references/control-signals.md): depth, pose, edge and mask videos.
- [previs-3d](references/previs-3d.md): Blender blockouts, passes and camera paths.
- [audio](references/audio.md): voice samples, sound and music references.
- [markers](references/markers.md): dialects and what the compiler emits.
- [failure-modes](references/failure-modes.md): what goes wrong and the result review.
