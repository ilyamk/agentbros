# Earshot in the production flow

Last updated: 2026-11-17

How the optional Earshot engine ([contracts](audio-integrations.md#optional-earshot-engine)) feeds the film chain, the critic and the recut.

Where an agent chooses sound blind, it now compares measured candidates and keeps
the evidence. Every Earshot reading stays advisory: nothing blocks on what Earshot
says until `edit-research` calibrates the audit. Without a prepared runtime every
step below still works and says so.

**Hero sounds from candidates (`sfx:audition`, sound step).** For each cue-sheet
cue that decides a sound and plays as hero (`soundCueWeight`: its `weight`, else a
layered cue or a reveal/hit), it gathers up to three sounds of the kind from each
source: Earshot takes passed with `--earshot-takes` (render one or two seeded takes
per hero kind first), the measured library (`sfx-index.json`) and the synth pack.
Each candidate gets its sha256, measured timing, independent loudness (ffmpeg EBU
R128) and, when `earshot-bank` is prepared, Earshot's model-free `check` (clicks,
clipping, edge, DC, ring, truncated tail, rising glide, stacked hits), saved once
per bytes as `pipeline/audio-review/<sha256>.json`. The rule (`AUDITION_CRITERIA`,
written into the file): excluded when it would start before the film, is silent
(true peak < −60 dBTP), clips (> 0 dBTP) or carries a `silent|clipping|edge|dc`
warning; score = fit to the room around the cue × audit factor (−0.15 per warning,
−0.03 per note, floor 0.2; 1 without Earshot); ties go Earshot take > library >
synth, then sha256; a sound that repeats the previous same-kind hero cue yields to
one within 0.1. It writes `pipeline/sfx-selection.json` (`SfxSelectionSchema`).

```sh
pnpm sfx:audition --project demo --earshot-takes public/projects/demo/sfx/whoosh.wav.take.json
pnpm sfx:cues --placements … --cue-sheet public/projects/demo/pipeline/cue-sheet.json --selection public/projects/demo/pipeline/sfx-selection.json …
```

`sfx:cues --selection` places each chosen sound on its cue (refusing a file whose
bytes changed since the audition); budgets, gaps, layers and gain stay the
planner's. The sound step's done check `hero-sounds-selected` (advisory in promo)
asks that every hero sound cue of the current cue sheet was auditioned and that the
sound placed on it is the selected one, by sha256. One candidate only is advisory.

**Measured leads.** film:measure's `cut-sound-coverage` reads `sound-cues.json`
(`--sound-cues`, default with `--project`): a cue's lead is how early the placed
file's attack starts, `(cueFrame − startFrame)/fps − onsetSec`; the 0.6 s whoosh
and 4 s riser constants remain only for cues without a placed sound.

**Evidence.** film:measure's `sfx-evidence` leg (warn at most) lists placed SFX
files with and without a saved audit and what the audit flagged; it is skipped when
no audit exists and never runs Earshot. `critic:pack --project` attaches every saved
audit of the render's or a placed sound's bytes as `audio-reviews.json`.

**The reference's sound (`sfx:map`, earshot-find).** One `find --kind event` per cue
family with fixed queries (`SFX_MAP_QUERIES`), strong and plausible results only, an
overlap given to the higher z, summarised as per-family counts, events per minute
and the longest event-free gaps, bound to the source hash. The reference step
writes `<reference>/sfx-map.json`; `critic:pack --reference` puts its density beside
the placed sounds in `sound.json` (`sfxDensity`). Music hits can read as impacts and
quiet sounds can be missed: compare densities, never treat a count as a verdict.

```sh
pnpm sfx:map --input <reference video> --output <library>/<reference-id>/sfx-map.json
```

**Room tone in a recut.** `recut:plan --room-tone-span START:END` uses a chosen span
(for example a reviewed `sfx:find-segment --kind texture --query "quiet room tone"`
candidate) after the same tests as the automatic quietest span: at least 300 ms,
inside the recording, no detected speech, no transcript word. The energy pick stays
the default and the user still approves the plan.
