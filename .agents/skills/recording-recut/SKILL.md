---
name: recording-recut
description: Edit the user's own recording via `pnpm footage:next`, transcribing only with `transcribe` or `speech:local`. Use for "cut my video", "remove silences", "remove pauses", "remove fillers / ums", "tighten my talk", "transcribe my video", "add subtitles to my recording", "make shorts from my video", "I have two cameras" or "make it vertical".
---

# Recording recut

The craft of the cut (pace by destination, what not to cut, captions, shorts that stand alone) is in the [footage-edit](../../../playbooks/footage-edit/AGENTS.md) and [shorts-from-long](../../../playbooks/shorts-from-long/AGENTS.md) playbooks. Start from `pnpm footage:next --project <id> --playbook footage-edit` ([footage editing](../../../docs/footage-editing.md)): it runs the steps below in order and prints each command. For "cut my video", silences, fillers, false starts or subtitles on a user's recording: get a `TranscriptSchema` file (`transcribe` or `speech:local`, verbatim so fillers are marked), then run `pnpm recut:plan --transcript pipeline/transcript.json --project-id NEW_ID` (add `--speech-mask pipeline/speech-mask.json` from `speech:local` when it exists, `--punch-in 1.12` to soften jump cuts, `--room-tone` (or `--room-tone-span S:E`) for noisy rooms). Show the user `recut-plan.md`: every cut with the words around it, protected statements and what was left alone. Rerun with `--reject C3,C7 --force` for cuts they refuse. The user approves the printed edit hash; only then add `review` and create with `video:workflow`. Captions come from the same transcript on the recut timeline. Rules and defaults: [recording edit guide](../../../docs/workflows/recording-edit.md).

`footage:next` emits `pnpm video:workflow --scenario recording-edit` for plan and create ([local workflow](references/local-workflow.md)). Answers carry `console.url`: open it once beside the chat; at a gate in Claude Code, background `pnpm console:wait --project <id>`, not polling, unless `hooks.claude` is `installed`. Consent and review permissions still apply.
For candidate discovery or a cutaway over existing speech, read [offline analysis and B-roll](references/analysis-and-broll.md). It routes the installed local tools through evidence checks and reversible application; ASR segments and ranked hits do not supply word-level alignment or semantic approval.

To choose shorts from a long recording, follow [shorts selection](references/shorts-selection.md): `shorts:prepare`, your evidence-quoted candidates, `shorts:rank`, human approval, then `shorts-series`.

The whole order for a user's footage (transcript, shots, recut, captions, shorts, `multicam:sync`/`multicam:angles` for several cameras, `reframe:track` for vertical) is in [footage editing](../../../docs/footage-editing.md); the `footage-editor` agent runs it by repeating `pnpm footage:next --project <source>`. A title behind the speaker: `pnpm matte --kind person` over the clip's frame range (`--engine onnx`: steadier edge, slower), then the `subject-occlusion` block ([matte](../../../docs/matte.md)). `speech:local` marks no fillers: removing "ums" needs `transcribe` (Scribe, paid, on the user's approval).

Read the approved brief, relevant project artefacts and `AGENTS.md` first. Use this skill when its decision is needed; do not invoke every craft skill for a simple edit. Keep leaf-agent work at depth one. Existing approval and no-spend instructions take precedence.

`transcribe` also supports `--provider fal --endpoint <id>` within the budgeted recording route; see [speech endpoints](../../../docs/fal-catalogue.md#verified-endpoints). Preserve estimated timing flags; fal output does not establish verbatim filler coverage.

## Decision and output

Produce `recut-proposal` in `pipeline/craft/recording-recut.json` (or the owning stage artefact when its schema already covers these fields): source checksum, transcript span, keep/delete ranges, reason, surrounding context, protected spans, revision and before/after review. Distinguish observed facts, artistic choices and unresolved assumptions. Preserve approved source/version pins.

Express the decision in the owning brief/script/design/storyboard artefact before generating assets. Tools and generation permissions come from the creative-studio router.

## Worked decisions

- Remove a repeated false start while retaining the complete corrected sentence.
- Cover a natural jump cut with B-roll that illustrates the adjacent spoken claim.

Failure to avoid: Remove a negation or caveat because silence detection ranks the pause as dead time.

## Alternatives and review

Silence or lexical ranking proposes candidates; it does not authorize semantic deletion. Preserve attribution, qualifications and user-locked spans.

Review: Does every decision serve the brief? Is there concrete evidence for technical/factual claims? Are timing, continuity, rights and cost assumptions explicit? Can another agent reproduce or revise the decision from the recorded artefact? Use [evaluation briefs](../creative-studio/references/evaluation.md) for review; heuristic scores do not prove audience response.

For a concrete supplied-input scenario, read only the relevant [worked production decision](../creative-studio/references/worked-production-decisions.md): it records evidence, a rejected alternative and a targeted repair without manufacturing creative acceptance.

## Optional derived audio and dubbing

For cleaning, conversion, dubbing or sound-event search, see [audio integrations](../../../docs/audio-integrations.md). Keep the original and review the new take's alignment. Dubbing's source-timed VTT describes the original clock. For a line edit, see [speech replacement](../../../docs/elevenlabs-speech.md#replace-a-line-in-an-edit). Follow the plan, spending and human review gates.
