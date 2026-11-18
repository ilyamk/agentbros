---
id: arrival-tint
name: Arrival tint, corner dots and fade groups on a building sentence
intent: "Function hook or reveal: each new word is marked as new by colour for a few frames, so the eye finds it without motion, and the line's frame or its final layout keeps the read calm."
route: remotion
timing: "motionfly: a word whole about every 10 frames, three tints on successive frames, ink about 5 frames after it appeared; dots spread over 5-8 frames, power2.out. ugc-app: yellow cools to white in about 9 frames. postiz: word groups fade in place over 3 frames, 6 apart, 4-6% push"
curve: steps for the tints, linear settle; power2.out for the dots; linear fades
primitive: arrivalTint, settleTrack, mixHex
demo: src/motion/library/typography/SentenceBuild.tsx
sources: ["design-reference/library/motionfly/techniques.json", "design-reference/library/ugc-app/techniques.json", "design-reference/library/postiz/techniques.json", "src/motion/text-modes.ts", "src/motion/library/typography/SentenceBuild.tsx", "src/motion/library/scenes/SceneEndCard.tsx"]
status: draft
---

**What it does.** Modes of block `type-sentence-build`. `tint`: each word shows a run of colours, one a frame from its reveal, then settles linearly to its own ink (`sentenceBuildTintPreset`: lilac, raspberry, teal, ink in 5; `sentenceBuildCoolingPreset`: one yellow cooling to white in 9). `cornerDots`: four small dots outside the line's corners spread to its new width over 6 frames after each word. Fixed layout `fadeFrames`: the block is laid out at its final size from the start and each word, or each group of words sharing a frame in `frames`, fades in place, under a slow `push` (`sentenceBuildFadeGroupsPreset`).

**When it fits.** A promise line or hook built word by word on a flat ground where a plain cut-on would feel flat; a stat line whose new words must be found at once; a title card that must not reflow while it builds.

**When it does not.** Captions over footage: use a caption preset. Long sentences: the tint on every word becomes a flicker. Corner dots read as a selection box, so they suit product and design films, not narrative ones.

**Timing.** motionfly 0-2 s (30 fps): words appear at F0, F9, F19, F29, F40; each pale lilac (#B873B3), raspberry (#B73A69) on the next frame, then teal (#0A7F6F), and ink #030303 about 5 frames after it appeared (F9-F14); the dots spread over 5-8 frames (difference 0.96 to 0.31 over F14-F18). ugc-app 6.9-13.1 s: a new word yellow on arrival and white about 9 frames later while the line recentres (curve not readable). motionfly t17 26.23-27.27 s: the wordmark letters type about every 3 frames (F787-F818), each tinted on arrival and ink about 5 frames later, the lockup recentring. postiz 3.7-4.1 s: an empty frame, the first group at about 30% then full by the third frame, the second group 6 frames later, no movement; a 4-6% push under the card.

**Read.** `src/motion/library/typography/SentenceBuild.tsx`, `src/motion/text-modes.ts` (`arrivalTint`, `settleTrack`), `tests/motion-blocks-gap-typography.test.ts`.

**Pitfalls.** Tints are mixed in sRGB hex; a named or rgba colour switches instead of blending. The corner dots frame the flow layout only, around the widest revealed line and the whole block's height. motionfly also tints status rows (t11, `ui-ai-chat` `rowTint`) and wordmark letters (t17, `scene-end-card` `wordmarkEntry: "type"` with `tint`, `sceneEndCardTypedPreset`): both call the same `arrivalTint`. Per letter, the run of three tints at 3 frames a letter overlaps three letters in colour at once; that is motionfly's look, but on a long wordmark drop to one tint.
