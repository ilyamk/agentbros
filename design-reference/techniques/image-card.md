---
id: image-card
name: Image card on paper, a second card stacked behind
intent: "Function emphasis: an archive photo set as an object on paper, with the spoken word beside it, reads as evidence rather than as footage."
route: remotion
timing: "abdulah (30 fps): one photo card about 0.25 W x 0.45 H at x 0.56-0.81 on #F8F6F2, the spoken verb set small in serif; at F177 a second card stacks behind it, rotated about 3 degrees and offset, on a cut"
curve: none (cut on); the photo inside keeps photo-move's even zoom
demo: src/motion/library/camera/PhotoMove.tsx
sources: ["design-reference/library/abdulah/techniques.json", "src/motion/library/camera/PhotoMove.tsx"]
status: draft
---

**What it does.** The photo becomes a card with a 1 px edge on an off-white paper ground, its Ken Burns move running inside the card; a second card can cut on behind it at a small rotation, like a stack of prints. Library block `photo-move` with `frame: "card"` (`card`, `paper`, `edge`, `caption`, `secondAt`, `secondSrc`, `secondRotate`, `secondOffset`); geometry in `imageCardRect` and `secondCardPose` (`src/motion/library/camera/camera-plan.ts`).

**When it fits.** Documentary or explainer beats about the past, people, places; a narrated list of photos; a calm counterweight after loud type.

**When it does not.** Product shots (use a device or the real UI); a full-bleed emotional photo, which loses force as a small card.

**Timing.** abdulah 5.43-6.87 s at 30 fps (visuals/a1/card-build.jpg F163-F182): the card cuts on with the word; the second card cuts on at F177, about 0.47 s later, about 3 degrees. Ours: card defaults to x 0.56, y 0.275, 0.25 x 0.45 on landscape (centred, taller on vertical and square), second card at `secondAt` rotated 3 degrees and offset 7% right and 5% up of the card. Side by side with abdulah 5.43-6.10 s (`motion:strip --vs`, `secondAt` 14) the card's size and place in the right third, the paper ground and the second card's small rotation behind it match; abdulah sets its word on the card, ours under it.

**Read.** `src/motion/library/camera/PhotoMove.tsx`, `src/motion/library/camera/camera-plan.ts`, `tests/motion-blocks-gap-scenes.test.ts`.

**Pitfalls.** Rests on one reference. The second card shows its photo's end crop and does not move. Keep the caption to one or two words; the card is small.
