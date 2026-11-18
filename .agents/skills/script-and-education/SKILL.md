---
name: script-and-education
description: Write a video's spoken script and on-screen words, and accurate lessons with source-backed claims and language-aware timing. Bespoke film scripts come from the script-writer agent.
---

# Script and education

In a bespoke film the words come after the concept and the music: use [script-writer](../../agents/script-writer.md), which ties each line to a section of the audio map. There, on-screen words are limited by reading time and not by speech rate (Russian: 1.0 s settled for one or two words; from three words, 0.375 s per word; the floor `plan:check` enforces), the hook comes from the chosen idea's opening frame, and voice is added only when the brief needs it. The rest of this skill is for spoken scripts and lessons.

For a concrete local lesson with supplied media, evidence and narration timings, follow [workflow direction](references/workflow.md), [education workflow](../../../docs/workflows/education.md) and `pnpm video:workflow --scenario education --request REQUEST.json`. Plan first; keep source claims and caveats in their spoken scenes and recap. Render chapters and inspect the worked example before delivery; never manufacture a fact review or call generation under a no-spend instruction.

Read the approved brief, relevant project artefacts and `AGENTS.md` first. Use this skill when its decision is needed; do not invoke every craft skill for a simple edit. Keep leaf-agent work at depth one. Existing approval and no-spend instructions take precedence.

For diagnostics on the six audited existing EN/RU AI/TTS inputs, read the [fixed corpus route](../recording-recut/references/analysis-and-broll.md#fixed-existing-corpus-diagnostics). Preserve intended-script discrepancies and both clock refusals; the four accepted estimated proposals still require listening and timing review. Intended generation text supplies neither human ground truth nor approved captions.

## Decision and output

Produce `script-claim-map` in `pipeline/craft/script-and-education.json` (or the owning stage artefact when its schema already covers these fields): verbatim spoken text, on-screen text, source-backed claims, definitions, worked example, counterexample, estimated cadence and uncertainties. Distinguish observed facts, artistic choices and unresolved assumptions. Preserve approved source/version pins.

Express the decision in the owning brief/script/design/storyboard artefact before generating assets. Tools and generation permissions come from the creative-studio router.

## Worked decisions

- Explain compound interest with one named principal, rate and time interval before generalising.
- A Russian 10-second calm spoken beat contains about 23 words, then actual recording/alignment determines timing. The same 10 s on screen holds far fewer: reading is slower than listening.

Failure to avoid: A chart with invented data is presented as scientific evidence.

Before using a percentage as proof, distinguish return from population share and state the measurement period, subject, basis and method. Connect the on-screen point to the existing owning claim's pinned source and exact normalized record using the local quantity/source contract. Matching source bytes and authored declarations do not establish the study's truth or the spoken claim's meaning. For a derived short, retained quantity metadata without a remapped current bridge remains pending; inspect its active timeline and seek the required factual review.

Check the authored chart with `pnpm chart:inspect --project ID`; after editing use `pnpm chart:inspect --project ID --timeline`. Follow the [source/record route](../../../docs/chart-evidence.md) and retain missing-source uncertainty in the lesson and review artefacts. Never manufacture a normalized record as evidence for an unsupported real statistic.

## Alternatives and review

Use a stated illustrative dataset when real data are unavailable; label assumptions. Remove detail or extend the hold rather than speeding speech until it is unintelligible.

Review: Does every decision serve the brief? Is there concrete evidence for technical/factual claims? Are timing, continuity, rights and cost assumptions explicit? Can another agent reproduce or revise the decision from the recorded artefact? Use [evaluation briefs](../creative-studio/references/evaluation.md) for review; heuristic scores do not prove audience response.

For a concrete supplied-input scenario, read only the relevant [worked production decision](../creative-studio/references/worked-production-decisions.md): it records evidence, a rejected alternative and a targeted repair without manufacturing creative acceptance.
