---
name: world-and-entity-bible
description: Create and reuse versioned character, object, location, style and scene cards with approved references.
---

# World and entity bible

Read the approved brief, relevant project artefacts and `AGENTS.md` first. Use this skill when its decision is needed; do not invoke every craft skill for a simple edit. Keep leaf-agent work at depth one. Existing approval and no-spend instructions take precedence.

## Decision and output

Produce `entity-card` in `pipeline/craft/world-and-entity-bible.json` (or the owning stage artefact when its schema already covers these fields): kind/id/revision, appearance invariants, forbidden changes, reference roles, linked asset IDs, relationships and approval evidence. Distinguish observed facts, artistic choices and unresolved assumptions. Preserve approved source/version pins.

Run `pnpm entity:card --help` and `pnpm asset:board --help`; use immutable revisions and pinned approved refs. `pipeline/entity-bindings.json` resolves refs for canonical render plans.

Tag every card reference with a view role from the fixed vocabulary (`front`, `three-quarter-left`, `profile-right`, `face-closeup`, `packshot-front`, `plate-wide`, `style-board`, `expression:*`, `outfit:*`, `custom:*`) and declare what you know in `facts` (`yawDeg`, `background`, `lighting`, `outfitId`, `handsEmpty`, `containsOtherPeople`); leave unknown facts absent rather than guessing. Store the verbatim invariant sentence once as `fixedSentence`, and a character's imported voice clips as `voice.sampleAssetIds`.

Run `pnpm entity:card --project ID --action coverage --kind KIND --id ENTITY` before approval and fill missing views or fix warned rules: distinct angles at least 45° apart, neutral background and even light, one outfit per card, empty hands on turnarounds, empty plates, no subject in style references. Coverage is advisory; `unknown` findings mean undeclared facts. Fork a card for a new costume or lighting state ([vocabulary and rules](../../../docs/entity-workflow.md#coverage-and-view-roles)). Cards are what `refs:plan` draws a shot's identity, product, location, style and voice inputs from; what each view must look like: [reference-preparation](../reference-preparation/SKILL.md).

## Worked decisions

- Pin a character’s face, costume and voice references to one approved revision for every episode.
- Fork a location for a night scene while preserving its geography and canonical daytime card.

Failure to avoid: Overwrite a canonical portrait after a generator changes facial identity.

## Alternatives and review

A candidate can be explored freely; publishing a canonical reference requires actual explicit approval. A declared actor field is not authentication or likeness/voice consent.

Review: Does every decision serve the brief? Is there concrete evidence for technical/factual claims? Are timing, continuity, rights and cost assumptions explicit? Can another agent reproduce or revise the decision from the recorded artefact? Use [evaluation briefs](../creative-studio/references/evaluation.md) for review; heuristic scores do not prove audience response.


For Genjutsu, a card is metadata and its selected role images are the actual model attachments. Reuse approved revisions; choose consistent clear views suited to the source framing and turns, without assuming every task needs a full angle sheet. Record documented likeness consent or not-applicable for a fictional identity. `model:prepare` pins roles and image order, measures inputs and creates a board; inspect it and the source before completing the visual-review template. Do not claim that sharpness, pixel count or card approval proves identity fidelity. Markers are compiled by `model:prepare` from the exact prepared attachments, never written by hand ([prompting recipe](../../../docs/higgsfield-prompting.md#prepared-genjutsu-workflow)).
