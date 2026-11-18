# Paper-collage B-roll

Craft notes for editorial halftone paper collage: one spoken line (about 5 s) becomes one visual metaphor that assembles from an empty paper field. The block is `paper-collage-assemble` (`src/motion/library/effects/PaperCollage.tsx`); `Halftone` and `KeylineFilter` from the same file work in any scene. Distilled from gbro-collage-broll ([credits](../../../../design-reference/sources/gbro-collage-broll.md)).

## 1. Compress the line into one metaphor

Before any image exists, write for each line:

- **Meaning**: what the viewer must understand by the end.
- **Feeling**: calm, surprise, urgency, relief, absurd, ironic.
- **Verb**: open, connect, leak, bind, file, light up, compress, fork, assemble.
- **Metaphor in one sentence**: a machine, clock, film, filing cabinet, console, rulebook, funnel, track, chess piece.
- **3–6 key objects**. More pieces weaken the meaning and the assembly.
- **Field colour and accents** (table below).
- **Assembly order**: structure → subject or key card → connector → action → result.

Never put the script's words in the picture. In a batch, let the metaphors tell a sequence (for example, manual waste and lost experience first, then codified rules and a human–machine split). The user approves the metaphors before any still or paid generation; in a batch, only approved items move on.

Example: *Meaning*: experience is spent again every time. *Metaphor*: an editor trims frame by frame around a giant film clock; a full turn yields only a short strip. *Objects*: film clock, editor, scissors, short strip. *Colour*: burnt orange, cream and pale teal accents. *Order*: clock → editor and scissors → film → the short output.

## 2. Look

- A strong, flat, even colour field. Pick it by meaning and keep one design language across a batch, not one colour:

  | Field | Meaning |
  |---|---|
  | Burnt orange, red | time spent, labour, urgency |
  | Mustard yellow | tools, warning, lost experience |
  | Deep green | cognition, taste, a system reset |
  | Deep purple | rules, sediment, long memory |
  | Teal | judgement, collaboration, automation |

- Subjects are black-and-white halftone photographic cut-outs. Coloured cardstock (red, yellow, teal, orange, purple, cream) marks only the cards, buttons, film or rulebooks that carry the meaning; colour serves hierarchy, never decoration.
- Every piece has a crisp cut edge, a thin warm-cream keyline, a soft low-opacity shadow and paper grain.
- Central subject inside the middle 70 %, generous empty field, 3–6 large separable groups rather than confetti.
- Avoid: type, readable letters, numerals, logos, watermarks, UI, subtitles, glossy 3D, photoreal environments, clutter.

## 3. Motion

Assemble from empty: frame 0 is the bare field; pieces slide in, drop onto the table, unfold or unroll, and snap into place on stop-motion timing (on twos). No global fade, no slow zoom, no drift, no camera move, no cuts. The last frame holds the finished picture: it is the thumbnail and the loop frame. A hand that places a piece and withdraws is one piece with `leaveAt`.

## 4. Making the pieces (the layered route)

Generate or source each object **separately** on a plain ground, cut it out, then assemble in the block. Every layer stays editable and timing is exact, which a single generated still animated by a video model cannot give.

1. Image prompt per object (through `scripts/generate-image.ts` and the budget rules in the root `AGENTS.md` ("Paid operations and budget")):

   ```text
   A single [object] as a black-and-white halftone photographic cut-out for an editorial paper collage,
   isolated on a plain flat light-grey ground, whole object in frame, even soft light, visible print dots.
   No text, letters, numerals, logos, watermark, UI or background scenery.
   ```

   Ask for colour only for cardstock props, or skip generation and use the block's cardstock shapes.
2. Cut out: `pnpm matte --input <png> --output public/projects/<id>/assets/images/<name>.png` (free, local; [matte](../../../../docs/matte.md)). Paid `pnpm rmbg` with the same `--input`/`--output` only on the user's approval, after `matte` has failed on that picture.
3. Set each piece's `src`. With `halftone: true` the block prints any photo as dots itself, so a colour source works too.

Fake glyphs on a source image: regenerate that image; never try to hide them in the animation.

## 5. Generated-video route (only when asked)

If the user wants a model to animate a single approved still, use first and last frames through `scripts/generate-video.ts` (image-to-video with `end_image_url`; check `docs/legacy-generation.md` for the model and `src/lib/pricing.ts` for the price, and budget first). The first frame is the empty field (`ffmpeg -f lavfi -i color=c=0x<HEX>:s=1080x1920 -frames:v 1 first.png`); the last is the approved still. Prompt:

```text
Paper-collage stop-motion assembly. Image 1 is the exact empty first frame, Image 2 the exact completed last frame.
One continuous locked-off vertical shot opening on the empty flat [colour] paper field. Assemble piece by piece
with crisp stop-motion timing: [3–6 elements in order: slide in, snap into place, connect, complete the action].
End by holding the supplied composition. Keep the [hex] field, cardstock accents, paper grain, halftone dots,
cream keylines, crisp cut edges and soft shadows. No cuts, camera movement, zoom, morphing, new objects, text,
logos, UI or sound.
```

Weak assembly: fewer elements and an explicit slide-in/snap order. End-frame drift: repeat that Image 2 is the exact last frame and must be held. Rerun only the failed item. Strip any audio track (`-map 0:v:0 -c:v copy -an`).

## 6. QA

- One metaphor, readable at a glance; subject concentrated; no fake text, logos or UI.
- Frame 0 really is the empty field (a sliver at the edge is the most to accept from a model; none from the block).
- Mid-clip shows pieces arriving one by one, not a fade: check a one-frame-per-second strip (`pnpm motion:strip` or `ffmpeg -vf "fps=1,scale=270:-1,tile=5x1"`).
- The last frame matches the approved still or styleframe; place them side by side. A small pose or detail change that keeps the meaning passes.
- A batch shares the texture and varies the field colour.
