# Recut plan: Recut of talk.mp4

Proposal only. Nothing is approved until a person watches the whole source and the cuts below, then adds `review.approvedEditHash` to `public/projects/talk/pipeline/footage/talk/recut-request.json`.

- Transcript: `public/projects/talk/pipeline/footage/talk/transcript.json` (en); source `public/projects/talk/assets/footage/talk.mp4`
- Duration: 1.00s → 0.70s (0.30s removed)
- Cuts: 4 (1 filler, 1 retake, 0 pause, plus head/tail trims)
- Evidence used: transcript, VAD speech mask
- Edit hash to approve: `5f0c1d2e3a4b59687a8b9cadbecfd0e1f2a3b4c5d6e7f8091a2b3c4d5e6f7081`

To reject a cut, run `pnpm recut:plan` again with `--reject C3,C7` (ids stay stable). Reordering, speed changes and new words are never proposed.

## Proposed cuts

- [ ] **C1** head · 00:00.000–00:00.100 (frames 0–3, 0.10s)
  - [leading silence] so um today…
  - leading silence before the first word
  - Evidence: VAD silence 0.00–0.10
- [ ] **C2** filler · 00:00.300–00:00.400 (frames 9–12, 0.10s)
  - …so ~~um~~ today we…
  - marked filler in a verbatim transcript
  - Evidence: transcript kind=filler
- [ ] **C3** retake · 00:00.600–00:00.700 (frames 18–21, 0.10s)
  - …cut ~~the~~ the recording…
  - repeated word: a false start
  - Evidence: repeated token
- [ ] **C4** tail · 00:00.900–00:01.000 (frames 27–30, 0.10s)
  - …the recording [trailing silence]
  - trailing silence after the last word
  - Evidence: VAD silence

## Protected statements (never cut inside)

- negation · frames 12–18: "we never cut"

## Considered and not proposed

None.
