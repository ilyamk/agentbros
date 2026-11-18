---
name: harness-asset-import
description: Import original image/media outputs from Codex or Claude without re-generation or invented billing.
---

# Harness asset import

Read the approved brief, relevant project artefacts and `AGENTS.md` first. Use this skill when its decision is needed; do not invoke every craft skill for a simple edit. Keep leaf-agent work at depth one. Existing approval and no-spend instructions take precedence.

## Decision and output

Produce `asset-import-receipt` in `pipeline/craft/harness-asset-import.json` (or the owning stage artefact when its schema already covers these fields): original local source, harness/tool/model when known, prompt/reference lineage, dimensions, checksum, usage rights and billing known/unknown. Distinguish observed facts, artistic choices and unresolved assumptions. Preserve approved source/version pins.

Run `pnpm asset:import --help`. Supply original file and sidecar provenance/rights. Inspect `pnpm asset:board --help` before approving references.

## Worked decisions

- Import the harness image’s original output file into the project and use its immutable asset ID in a character card.
- Import a creator’s product packshot with explicit provenance and keep its alpha channel.

Failure to avoid: Take a screenshot of an inline generated image and label it the original paid API output.

## Alternatives and review

Subscription generation can avoid an additional fal POST, but its monetary cost is unknown unless a real receipt exists. Never label subscription assets as universally free.

Review: Does every decision serve the brief? Is there concrete evidence for technical/factual claims? Are timing, continuity, rights and cost assumptions explicit? Can another agent reproduce or revise the decision from the recorded artefact? Use [evaluation briefs](../creative-studio/references/evaluation.md) for review; heuristic scores do not prove audience response.

## Portable runtime handoff

Read [runtime procedure](../../../docs/harness-assets.md) when planning a harness generation rather than importing an already supplied file. Use `scripts/harness-assets.ts --action capabilities` with current observed/supplied hashed evidence; missing runtime is unavailable. Persist `request` before the authorised host-tool call and import its original with the exact request hash. The CLI plans/records only; it never calls generation or a paid fallback. Distinguish requested model from actual tool/model identity. Preserve `awaiting-import` when an original file is absent. Candidate imports and fixture evidence do not grant human creative approval, consent, rights or subscription entitlement.
