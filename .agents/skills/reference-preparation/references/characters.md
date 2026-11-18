# Characters: identity, angles, wardrobe

Tiers and dates: [legend](../SKILL.md#references). Profile limits: `pnpm refs:profiles --action show --family F`.

## Prepare

- One locked master image of the character, then clearly different views: front, a three-quarter or profile, a face close-up; back and full body when the shot shows them.
- Even, soft light and a neutral, plain background on every turnaround view; clear facial geometry (no hair or hands across the face).
- Empty hands on the turnaround. Props go on their own object card.
- One outfit per card revision. A new costume is a forked card (`outfit:*` view or a new revision), never a mixed sheet.
- A `fixedSentence` on the card: the verbatim invariants (face, build, hair, wardrobe colours, silhouette) that every prompt for this character repeats.
- Several characters in one shot: build the group key frame first with an image model, approve it, then animate it as a first frame.

## Specs and limits (model-specific)

- Distinct beats many: near-duplicate angles cause view-dependent collapse (the model locks onto one angle and snaps between them); Mv²ID trains on references at least 45° apart — [P] [arXiv 2603.21299](https://www.alphaxiv.org/overview/2603.21299), checked 2026-11-17.
- Kling binds up to 4 images per character (front, side, back, detail) so the model does not infer unseen areas; even light and clear facial geometry are essential — [O] [Kling subject binding](https://home.kling.ai/blog/kling-3-subject-binding-character-consistency), checked 2026-11-17.
- Kling elements on fal: a frontal image plus 1–3 reference images per element, up to 4 elements; with a video input, images plus elements are at most 4 — [3P] [fal Kling O3 reference-to-video API](https://fal.ai/models/fal-ai/kling-video/o3/pro/reference-to-video/api), checked 2026-11-17.
- A Kling element from video: the fal schema takes one video element of 3–10 s — [3P] [fal Kling O3 reference-to-video API](https://fal.ai/models/fal-ai/kling-video/o3/pro/reference-to-video/api), checked 2026-11-17; Kling describes it as a 3–8 s single-character video — [O] [Kling subject binding](https://home.kling.ai/blog/kling-3-subject-binding-character-consistency), checked 2026-11-17. Prepare 3–8 s to satisfy both.
- Gemini Omni: at most 3 images per character, 2 characters, 6 images in total — [O] [AI Studio Omni](https://aistudio.google.com/docs/omni), checked 2026-11-17.
- The Nano Banana 2.1 edit profile takes up to 14 images — [3P] [fal Nano Banana 2.1 edit API](https://fal.ai/models/google/nano-banana-2.1/edit/api), checked 2026-11-17. Resemblance for up to 5 people is stated for Nano Banana Pro (official, RFC 0003 §3.1) and is [U] for 2.1, so plan group shots as if it were not.
- More frames help identity only up to a point: HeyGen's TAVR ablation shows identity rising from 12 to 48 frames while lip-sync stays flat — [P] [HeyGen TAVR](https://www.heygen.com/research/tavr), checked 2026-11-17.
- Kling Motion Control: the face element carries the face only; clothing, hair, makeup and props come from the character image or the prompt. It binds one element and animates the largest person — [O] [Kling Motion Control guide](https://kling.ai/quickstart/motion-control-user-guide), checked 2026-11-17.
- Runway Act-Two drives a single character ([O], RFC 0003 §3.1; no source link recorded). No Runway profile exists in this harness, so it cannot be packed.

## Real faces

- Seedance 2.x rejects real human faces in references ([3P], RFC 0003 §3.1, no source link recorded); both Seedance profiles record `realFaces: rejected`, checked 2026-11-17.
- Gemini Omni blocks some recognisable people, and minors in the EEA, UK and Switzerland — [O] [AI Studio Omni](https://aistudio.google.com/docs/omni), checked 2026-11-17.
- In this harness: a card whose `likenessConsent` is not `not-applicable` is refused by `refs:pack` on a `rejected` profile; unknown consent stops for the user (`src/lib/references/packs/consent.ts`).

## In our system

| Need | Card view role | Requirement role | Derivative |
|---|---|---|---|
| Face and build | `front`, `three-quarter-left`/`-right`, `profile-left`/`-right`, `face-closeup`, `back`, `full-body` | `identity` | `cutout` then `flatten` for a busy background; `scale` with `fit: pad` for an edge limit |
| Costume | `outfit:<id>` | `wardrobe` | as above |
| Expression | `expression:<id>` | `expression` | `crop` to the face |
| Hands, detail | `hands` | `identity` or `prop` | `crop` |

- Declare `facts` per view: `yawDeg`, `background`, `lighting`, `outfitId`, `handsEmpty`, `containsOtherPeople`. Undeclared facts show as `unknown` in coverage; never guess them.
- `refs:plan` draft picks the front first, then one view per angle group, and gives every character a second angle before any gets a third, within the profile's slots.
- Element slots (`elements`, `element-references`) take a frontal image plus references of the same character; the compiler builds the element object.

## Failure modes

- Near-duplicate angles: view snapping. Fix: replace a duplicate with a view at a clearly different yaw.
- A scene background in an identity view: the background and light leak into every shot. Fix: `cutout` and `flatten` derivative, or a new turnaround.
- Props in hand on the turnaround: the prop appears in every shot.
- Expecting a face element to carry clothes: wardrobe changes between shots. Fix: state wardrobe in the character image and the `fixedSentence`.
- A strong style in the identity view: identity and style entangle (see [style](style.md)).
