# Narration

The narration step of the [production chain](../production-chain.md): the voice, directed from the approved script, made, measured and aligned before the beat sheet, so the plan is timed to the voice that will be heard. Owner `narrator-director`; code: `chain.ts`, done check `narration-ready` in `state.ts`, `src/lib/film/narration.ts`, `src/types/narration.ts`.

## Which films

Routes with a `narration` line (`routes.ts`): `explainer`, `ui-demo`, `ai-video`, and hybrids with one of them. Not `talking-head`: its voice is the presenter's recorded takes (material). Skippable: a script with `voiceoverEnabled: false` is skipped with `film:done --skip "<reason>"`. Narrator takes are made only here, never at sound.

## Two approvals, as on material

1. **Direction.** The owner writes `pipeline/narrator-direction.json` (`NarrationDirectionSchema`: what `generate:voiceover --directed` reads, plus `route`, `voiceWhy`, `maxCostUsd`, a bound per take, so beats × it at most) and `pipeline/narration.md`, quoting paid takes with `--dry-run`. The user approves voice, direction and bound. Directed text keeps the script's words.
2. **Takes.** On the paid route the done check then fails with "make the takes" and the step returns to its owner, whose lease now allows spending (only on the user's own yes to the current direction; never a proxy's). `generate:voiceover --directed --take <take> --max-cost-usd <bound>` reserves budget and keeps durable operations, then `narration:check`. The user listens and approves the takes.
3. **Retakes.** Takes are immutable (the provider never overwrites one). After a rejection the owner revises the direction and raises its `take`: take n > 1 is `voiceover/<beat>.take-<n>.mp3`, `narration.json` records the active `take`, and the revised direction is approved before it is paid for. A take whose receipt voices another direction's text is refused by `narration:check`.

Prefer v4 for new expressive directions. Give each audible cue a character
offset and a short instruction, or use `directedText` with inline brackets.
Before paying, the command checks the approved words and numbers. The
selected voice and its approved calibration are separate from the performance
direction. See [audio integrations](../audio-integrations.md#elevenlabs).

## Routes

| `route` | Takes | Receipt | Word timings | Spend |
|---|---|---|---|---|
| `elevenlabs` | `voiceover/<beat>.mp3`; a pinned `voiceRef`, or `eleven_v4` / `eleven_flash_v2_5` | `<take>.mp3.take.json` | `voiceover/<beat>.words.json` | after the yes, within the bound and budget |
| `local` | `voiceover:local --output <dir>/pipeline/narration-local.json` (draft) | the result's `.receipt.json` | Portable voice writes matched `.words.json` sidecars; Apple takes use `speech:local` | none |
| `existing` | takes already in `voiceover/` | as `elevenlabs` | as `elevenlabs` | none |

No authorised bound and no local voice: leave the step pending; never invent takes or timings.

For portable narration, put `"localVoice": {"engine":"portable","voice":"supertonic:0"}` in the direction. Prepare once with `pnpm voiceover:local --engine portable --prepare`, then use the ordinary project command. It takes words from the script, checks the readback and binds each take and its word sidecar to the result receipt. Review a readback mismatch before using an independently checked transcript or making a retake. Apple remains the default on macOS for a direction with no engine selection. See [portable voice](../speech.md#portable-narration).

## narration:check

`pnpm narration:check --project <id> [--local-result <file>]`, free: checks each spoken beat's take, receipt and words, measures takes with ffprobe, writes `voiceover/<beat>.words.edited.json` (fillers out, emphasis from `emphasisWords`; the shape `KaraokeCaptions` reads) and `pipeline/narration.json` (per beat file, sha256, `durationSec`, receipt, words, captions, default `startSec`). The done check reads that file without ffprobe: current direction, files present, takes unchanged.

## Downstream

`narration.json` is an optional input of beat-sheet, animatic, build and sound; a changed take reopens them. Voice feedback (`aspect: voice`) routes here, or to sound without a narration step.
