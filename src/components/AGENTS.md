# Components — Agent Rules

Last updated: 2026-11-18

Compositions and scene components. The Remotion-only animation and media rules in the [root AGENTS.md](../../AGENTS.md) apply, and `pnpm lint` enforces them here.

## Compositions

| File | Role |
|------|------|
| `GenericProject.tsx` | Canonical renderer for `project.json`, registered in `src/Root.tsx` as `ProjectVertical`, `ProjectSquare`, `ProjectLandscape`; retained `TalkingHeadDemo` delegates to the same landscape renderer (`src/lib/project-props.ts`) |
| `TimelineComposition.tsx`, `TimelineOverlays.tsx` | Renders edited timelines; burned captions follow the timeline's `captionStyle` (karaoke when absent); `overlays` draw library blocks below or above the captions |
| `TimelineCaptions.tsx` | Every non-karaoke caption profile for one timeline clip: `phrase`, `keyword`, `bilingual` templates and the `captions` library blocks ([caption delivery](../../docs/caption-delivery.md)) |
| `TalkingHeadComposition.tsx`, `TalkingHeadScene.tsx` | Talking-head format ([src/templates/AGENTS.md](../templates/AGENTS.md)) |
| `PromoVideo.tsx` | Older scene-list composition behind `Vertical`, `Square` and named legacy compositions |
| `QAEvidenceProbe.tsx` | Render probe for QA evidence |

New projects use the generic compositions. Do not add a per-project composition to `Root.tsx` unless the project needs custom code.

The timeline renderer silences a presenter segment marked `speechMuted` by a reviewed speech replacement. The replacement plays on the voiceover track.

`src/lib/timeline.ts` fades 12 frames between scenes unless a scene sets `transitionToNext: "cut"` or `transitionDurationFrames`. Most existing scene components and `RegisteredTemplate` fade out over their last 9 frames, the final scene included. That is current behaviour rather than a rule: new scenes choose their exit, and the final frame does not fade unless the script intends it.

Some scene components pick their format with `height > width ? "vertical" : "square"`, so they treat landscape as square. Handle landscape explicitly when adding or reusing one for that format.

---

## Quick edits

A one-off edit, re-render (`pnpm render --project <id> --format <format>`) or asset swap is done directly, without a pipeline (root [AGENTS.md](../../AGENTS.md), "Start here"). A new film goes through the `creative-studio` skill. New per-project code goes in the git-ignored `src/projects/{id}/`, not in this directory. The older six-phase manual procedure is archived in manual quick production record.

Existing scenes: `TitleScene`, `FeatureScene`, `ProductScene`, `PhoneShowcaseScene`, `StockPhotoScene`, `StockVideoScene`, `CTAScene`.

## QA checklist

After a quick edit, check every changed scene in every format:
- [ ] Text within the per-format safe zones (`spacing` tokens)
- [ ] Headlines contrast background; hierarchy reads at playback size
- [ ] Animations read as intended: check anything under 3 frames or over 45 frames
- [ ] Final frame holds as thumbnail and loop frame, unless the script intends a fade
- [ ] Phone fills 60-85% of frame
- [ ] Background serves the idea and keeps text contrast
- [ ] One message per scene, single focus
- [ ] Audio synced — voiceover starts when scene appears

Fix immediately. Re-check. Repeat until polished.
