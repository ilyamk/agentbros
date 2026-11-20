import { cutCues } from "./transition-cut-plan";
import type { CaptureProofProps } from "./CaptureProof";
import { captureTiming } from "./scene-plan";
import { defineItem, type LibraryItem } from "../types";
import {
  LibraryReel,
  REEL_FRAMES,
  libraryReelDefaults,
  libraryReelSchema,
  reelFrames,
  reelStarts,
} from "./LibraryReel";
import {
  SceneBentoCollage,
  sceneBentoCollageCues,
  sceneBentoCollageDefaults,
  sceneBentoCollageSchema,
} from "./SceneBentoCollage";
import { SceneEndCard, sceneEndCardCues, sceneEndCardDefaults, sceneEndCardSchema } from "./SceneEndCard";
import {
  SceneFeatureDemo,
  featureDemoFrames,
  sceneFeatureDemoDefaults,
  sceneFeatureDemoSchema,
} from "./SceneFeatureDemo";
import { SceneHookTitle, sceneHookTitleCues, sceneHookTitleDefaults, sceneHookTitleSchema } from "./SceneHookTitle";
import { SceneProductReveal, sceneProductRevealDefaults, sceneProductRevealSchema } from "./SceneProductReveal";
import {
  SceneStatMoment,
  sceneStatMomentCues,
  sceneStatMomentDefaults,
  sceneStatMomentSchema,
} from "./SceneStatMoment";
import {
  CaptionFlashMontage,
  captionFlashMontageCues,
  captionFlashMontageDefaults,
  captionFlashMontageFrames,
  captionFlashMontageSchema,
} from "./CaptionFlashMontage";
import {
  DoublingCounterMontage,
  doublingCounterMontageCues,
  doublingCounterMontageDefaults,
  doublingCounterMontageSchema,
  doublingFrames,
} from "./DoublingCounterMontage";
import { QUAD_SPLIT_FRAMES, QuadSplit, quadSplitCues, quadSplitDefaults, quadSplitSchema } from "./QuadSplit";
import type { Cue } from "../types";

const BASE = "src/motion/library/scenes";
const STYLE_NOTE =
  "Pass `styleId` (styles category) for palette and fonts; `finish={false}` inside a film that is finished once.";

export const items: LibraryItem[] = [
  defineItem({
    id: "scene-hook-title",
    category: "scenes",
    title: "Hook title scene",
    description:
      "A complete opening: a small lead sentence with accent words builds on the light ground, then hero words hit one per hard cut at hero scale (about 80% of the width), each on a swapped ground (accent, ink), with no glow, spring or kicker. The last word can shrink out of a blur on `exitAt` to cause the next cut. Use for the first 2–3 s.",
    tags: ["scene", "hook", "opening", "hero word", "ground swap", "hard cut", "light ground", "title"],
    component: SceneHookTitle,
    schema: sceneHookTitleSchema,
    defaultProps: sceneHookTitleDefaults,
    durationInFrames: 90,
    formats: ["landscape", "vertical", "square"],
    importPath: `${BASE}/SceneHookTitle`,
    usage: `<SceneHookTitle {...sceneHookTitleDefaults} styleId="paper-signal" lead="Sentence with [accent] words." words={["Hero", "words."]} cuts={[downbeat1, downbeat2]} exitAt={-1} />. ${STYLE_NOTE}`,
    cues: (props) => sceneHookTitleCues(props as Parameters<typeof sceneHookTitleCues>[0]),
  }),
  defineItem({
    id: "scene-product-reveal",
    category: "scenes",
    title: "Product reveal scene",
    description:
      "The 3D product (phone or card, turntable and dolly) on a light studio sweep set to one side, with the headline beside it at title scale and one small caption; no kicker or glow. Use for the name reveal or a product hero beat.",
    tags: ["scene", "product", "reveal", "3d", "studio", "hero", "launch", "template"],
    component: SceneProductReveal,
    schema: sceneProductRevealSchema,
    defaultProps: sceneProductRevealDefaults,
    durationInFrames: 120,
    formats: ["landscape", "vertical"],
    importPath: `${BASE}/SceneProductReveal`,
    usage: `<SceneProductReveal {...sceneProductRevealDefaults} styleId="paper-signal" headline="..." screenImage="images/app.png" />. ${STYLE_NOTE}`,
    cues: (props) =>
      [
        {
          frame: (props as { textAt?: number }).textAt ?? 20,
          kind: "reveal",
          sfx: "whoosh",
          weight: "hero",
          label: "headline",
        },
      ] as Cue[],
  }),
  defineItem({
    id: "scene-feature-demo",
    category: "scenes",
    title: "Feature demo scene",
    description:
      "The product dashboard assembles on the light ground, a hard ground-swap cut lands on an action card, and a cursor click on `clickAt` floods the button into the accent ground. Use for the proof beat; the click causes the next cut. Vertical cuts to result notifications. Pass capture for a real before/after screen pair, a tracked control and a result reading hold.",
    tags: ["scene", "demo", "dashboard", "cursor", "click", "proof", "saas", "template"],
    component: SceneFeatureDemo,
    schema: sceneFeatureDemoSchema,
    defaultProps: sceneFeatureDemoDefaults,
    durationInFrames: featureDemoFrames(sceneFeatureDemoDefaults),
    durationForProps: featureDemoFrames,
    formats: ["landscape", "vertical"],
    importPath: `${BASE}/SceneFeatureDemo`,
    usage: `<SceneFeatureDemo {...sceneFeatureDemoDefaults} styleId="paper-signal" />; length is featureDemoFrames(props). ${STYLE_NOTE}`,
    cues: (props) => {
      const demo = props as Parameters<typeof SceneFeatureDemo>[0];
      if (demo.capture)
        return [
          {
            frame: captureTiming(featureDemoFrames(demo), Boolean(demo.capture.landscape.control)).click,
            kind: "click",
            sfx: "click",
            weight: "hero",
            label: "control changes state",
          },
        ] as Cue[];
      const { dashboardFrames, clickAt } = props as { dashboardFrames: number; clickAt: number };
      // The action shot starts after the dashboard minus the 9-frame seam; the ground-swap cut is its first frame.
      const action = dashboardFrames - 9;
      return [
        { frame: action, kind: "cut", sfx: "tick", weight: "support", label: "ground-swap cut to the action card" },
        { frame: action + clickAt, kind: "click", sfx: "click", weight: "hero", label: "cursor click" },
      ] as Cue[];
    },
  }),
  defineItem({
    id: "scene-stat-moment",
    category: "scenes",
    title: "Stat moment scene",
    description:
      "The payoff number: a lead sentence with accent numbers builds on the light ground, then a hard cut on `beat` swaps to the accent ground with the number at hero scale (front-loaded race, then rest) and one small caption. No odometer, chip or sparkline. Put `beat` on a downbeat or surge.",
    tags: ["scene", "stat", "number", "payoff", "beat", "hero number", "ground swap", "proof"],
    component: SceneStatMoment,
    schema: sceneStatMomentSchema,
    defaultProps: sceneStatMomentDefaults,
    durationInFrames: 90,
    formats: ["landscape", "vertical", "square"],
    importPath: `${BASE}/SceneStatMoment`,
    usage: `<SceneStatMoment {...sceneStatMomentDefaults} styleId="paper-signal" lead="... [accent] ..." value={80} beat={beatFrame} />. ${STYLE_NOTE}`,
    cues: (props) => sceneStatMomentCues(props as Parameters<typeof sceneStatMomentCues>[0]),
  }),
  defineItem({
    id: "scene-end-card",
    category: "scenes",
    title: "End card scene",
    description:
      'A restrained close: the flat brand mark cuts in on the film\'s ground, the wordmark slides out from behind it, one small line appears, and the last frame holds with no fade so the music can stop dead on it. No chrome, rays or flare. `wordmarkEntry: "type"` (`sceneEndCardTypedPreset`) types the wordmark a letter every 3 frames instead, each letter arriving in a tint run that settles to ink while the lockup recentres. Use to close a film.',
    tags: [
      "scene",
      "end card",
      "logo",
      "lockup",
      "cta",
      "brand",
      "close",
      "hard stop",
      "restrained",
      "typed wordmark",
      "arrival tint",
    ],
    component: SceneEndCard,
    schema: sceneEndCardSchema,
    defaultProps: sceneEndCardDefaults,
    durationInFrames: 75,
    formats: ["landscape", "vertical", "square"],
    importPath: `${BASE}/SceneEndCard`,
    inspiredBy: [
      "design-reference/library/motionfly: t17-end-card-typed-wordmark 26.23-27.27 s (F787-F818: the wordmark types beside the settled mark a letter about every 3 frames, each letter tinted and settling to ink, the lockup recentring as it grows; the tint run of t01, lilac, raspberry, teal to ink in 5 frames; wordmarkEntry type)",
    ],
    usage: `<SceneEndCard {...sceneEndCardDefaults} styleId="paper-signal" paths={[markPath]} wordmark="Brand" cta="brand.com" durationInFrames={shotLength} />; end the music on its "stop" cue. ${STYLE_NOTE}`,
    cues: (props) => sceneEndCardCues(props as Parameters<typeof sceneEndCardCues>[0], 75),
  }),
  defineItem({
    id: "scene-bento-collage",
    category: "scenes",
    title: "Bento collage scene",
    description:
      "A brand board: seven tiles (hero word on the accent, stats, UI chips, photos via `src`, an ink tile) land one by one in a bento of mixed spans, accelerating, on the light ground; then the camera pushes into the hero tile until it fills the frame and becomes the next shot's ground. `heroSnap` instead starts the hero full bleed, snaps it in one frame to a centred card (about 63% of the width) on the ink ground and cuts the other tiles on around it every 1-2 frames, no tween. Use for a 'what it is' overview or a launch summary.",
    tags: [
      "scene",
      "bento",
      "collage",
      "brand board",
      "grid",
      "tiles",
      "overview",
      "light ground",
      "caused",
      "hero snap",
      "full bleed to card",
    ],
    component: SceneBentoCollage,
    schema: sceneBentoCollageSchema,
    defaultProps: sceneBentoCollageDefaults,
    durationInFrames: 90,
    formats: ["landscape", "vertical"],
    inspiredBy: [
      "design-reference/reference-gap-matrix.md: cashfree 8–18 s and 33–35 s brand board",
      "design-reference/library/cashfree: bento-assemble-around-hero 16.10-18.63 s (a full-frame photo snaps in one frame to a card about 63% wide on black; tiles land around it every 1-2 frames with no tween, tall panels from both edges last; heroSnap mode)",
    ],
    importPath: `${BASE}/SceneBentoCollage`,
    usage: `<SceneBentoCollage {...sceneBentoCollageDefaults} styleId="paper-signal" tiles={[...7 tiles]} pushAt={-1} />; cut to the next shot on its ground at pushAt + 16. Hero snap: heroSnap={snapFrame} (heroShare 0.63, snapSteps [2, 1, 2, 1, 2, 1]) with a photo tile as \`hero\`. ${STYLE_NOTE}`,
    cues: (props) => sceneBentoCollageCues(props as Parameters<typeof sceneBentoCollageCues>[0]),
  }),
  defineItem({
    id: "caption-over-flash-montage",
    category: "scenes",
    title: "Caption over a flash montage",
    description:
      "One caption holds in place while a run of plates hard-cuts under it on a frame cadence (by default a lead plate, five flashes of 4/4/4/3/4 frames and a 37-frame landing), each plate with its own grade (none, mono, negative, duotone, halftone); one word of the caption can swap per plate, its last words complete on the landing, and it can leave mid-run. Plates are images, clips, any layer passed as children, or procedural stand-ins. For a list of places, uses or proofs said in one line. `flashSafe` (on) keeps it within six cuts a second (WCAG 2.3.1) whatever the plates. Aligned burst: give each plate a `focus` box (a highlighted phrase, an eye) and the montage `focusAt`/`focusSize`/`focusGrow`, and every plate is placed so that box sits on one frame point at one size, optionally growing across the run.",
    tags: [
      "montage",
      "flash",
      "caption",
      "hard cut",
      "cadence",
      "stutter",
      "places",
      "proof",
      "fixed caption",
      "rhythm",
      "aligned burst",
      "highlight lock",
      "feature aligned",
    ],
    component: CaptionFlashMontage,
    schema: captionFlashMontageSchema,
    defaultProps: captionFlashMontageDefaults,
    durationInFrames: captionFlashMontageFrames(captionFlashMontageDefaults),
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "design-reference/library/flex t11-flash-montage-continuous-caption (4/4/4/3/4 then 37 frames; the place name swaps, the sentence completes on the last flash)",
      "design-reference/library/airform flash-montage-under-continuous-caption (9-frame lead, ten 4-frame plates, a 6-frame plate; caption leaves mid-run)",
      "design-reference/library/nowakdesign caption-anchor-footage-stutter (3-6-frame shots, each with its own grade)",
      "design-reference/library/cashfree caption-anchor-over-footage-stutter",
      "design-reference/library/ugc-app highlight-lock 2.10-2.90 s (pages 2-4 frames each, each scaled and moved so its highlighted phrase hits one target box; focus mode)",
      "design-reference/library/palmier two-frame-burst 33.88-36.64 s at 25 fps (2-frame stills, the eye at frame centre growing steadily to a pupil about 30% of the width; focusGrow)",
    ],
    importPath: `${BASE}/CaptionFlashMontage`,
    usage: `<CaptionFlashMontage {...captionFlashMontageDefaults} plates={[{ src: "projects/<id>/assets/p1.mp4", plate: "horizon", palette: [...], grade: "none", word: "Lisbon" }, ...]} holds={FLEX_MONTAGE_HOLDS} caption="Work from {word} this week.">{[layerForPlate0, layerForPlate1]}</CaptionFlashMontage> (children, one per plate, win over src: any layer or block); cadences FLEX_MONTAGE_HOLDS, AIRFORM_MONTAGE_HOLDS, NOWAK_STUTTER_HOLDS from src/motion/library/effects/flash-plan. Aligned burst: plates[i].focus = the feature's box in that plate, focusAt={{ x: 0.5, y: 0.5 }} focusSize={0.12} focusGrow={2.5} (focusSizeAt, focusTransform in scenes/scene-plan). ${STYLE_NOTE}`,
    cues: (props) => captionFlashMontageCues(props as Parameters<typeof captionFlashMontageCues>[0]),
  }),
  defineItem({
    id: "doubling-counter-montage",
    category: "scenes",
    title: "Doubling counter montage",
    description:
      "A fixed layout (a query line on top, a counter beside the subject at eye height, a plural label, a name card) while subjects cut in with holds that shrink from about 1.5 s to a few frames and every cut doubles the counter, the subject arriving 2 frames before a 4-frame odometer roll. For scale that grows faster than the eye can follow: users, people, files. `flashSafe` (on) stops the accelerando at six cuts a second; off plays the measured holds down to 1 frame.",
    tags: [
      "montage",
      "counter",
      "doubling",
      "accelerando",
      "odometer",
      "scale",
      "people",
      "subject swap",
      "social proof",
      "growth",
    ],
    component: DoublingCounterMontage,
    schema: doublingCounterMontageSchema,
    defaultProps: doublingCounterMontageDefaults,
    durationInFrames: doublingFrames(doublingCounterMontageDefaults),
    formats: ["landscape", "vertical"],
    inspiredBy: [
      "design-reference/library/gojiberry doubling-counter-montage (1 to 524 288 over 20 shots; holds 1.47 s down to 0.03 s; the face cut 1-3 frames before a 4-5-frame roll)",
      "design-reference/library/abdulah t16-image-flurry-12fps (accelerating image flurry)",
    ],
    importPath: `${BASE}/DoublingCounterMontage`,
    usage: `<DoublingCounterMontage {...doublingCounterMontageDefaults} subjects={[{ src: "projects/<id>/assets/s01.jpg", name: "Ada", detail: "Lisbon" }, ...]} label="teams" query="..." />; holds from accelerandoHolds(first, floor, count) in src/motion/library/effects/flash-plan. ${STYLE_NOTE}`,
    cues: (props) => doublingCounterMontageCues(props as Parameters<typeof doublingCounterMontageCues>[0]),
  }),
  defineItem({
    id: "quad-split",
    category: "scenes",
    title: "Quad split of four films",
    description:
      "Four films play at once in a gutterless 2x2 grid, each cell its own timeline and ground, cut on a plan that keeps them reading as four: never more than two changes within 0.1 s, coinciding changes on opposite corners one frame apart, one cell resting about 1.9 s through the busiest stretch. Use as a hook that shows range (four uses, four customers, four features) in the first second.",
    tags: ["quad", "split screen", "grid", "2x2", "four films", "hook", "range", "multi-cam", "stagger", "cut planner"],
    component: QuadSplit,
    schema: quadSplitSchema,
    defaultProps: quadSplitDefaults,
    durationInFrames: QUAD_SPLIT_FRAMES,
    formats: ["landscape"],
    inspiredBy: [
      "design-reference/library/ace: t01-quad-split-four-films 0-11.62 s (four 50% x 50% cells, no gutter, every cell mid-motion in the first second, each hero at 45-55% of its cell)",
      "design-reference/library/ace: t02-diagonal-paired-stagger 5.02-10.08 s (16 changes, median gap 0.517 s, never more than two within 0.1 s, coinciding changes on diagonals 1 frame apart at 60 fps)",
      "design-reference/library/ace: t14-still-cell-rest 5.70-7.60 s (one cell holds 1.9 s while the others change four times)",
    ],
    importPath: `${BASE}/QuadSplit`,
    usage: `const plan = planQuadCuts(cutsPerCell, { fps }) (scene-plan); <QuadSplit {...quadSplitDefaults} cuts={cutsPerCell}>{[tl, tr, bl, br]}</QuadSplit>: each child renders at full frame size and is scaled into its cell; read a cell's shot with quadShotAt(plan[cell], frame). ${STYLE_NOTE}`,
    cues: (props) => quadSplitCues(props as Parameters<typeof quadSplitCues>[0]),
  }),
  defineItem({
    id: "library-reel",
    category: "scenes",
    title: "Library showcase reel",
    description:
      "A 21 s launch film made only from library blocks: hook, product reveal, feature demo, stat and end card, joined by caused zoom-through, whip, light-burn and slice transitions, with varied shot lengths and one FilmFinish. A capture with the ground-swap-cut and caused-morph performance plays both matched transitions in a 10.8 s alternative cut.",
    tags: ["reel", "showcase", "film", "launch", "transitions", "template", "example"],
    component: LibraryReel,
    schema: libraryReelSchema,
    defaultProps: libraryReelDefaults,
    durationInFrames: REEL_FRAMES,
    durationForProps: (props) => reelFrames(props.capture as CaptureProofProps | undefined),
    formats: ["landscape", "vertical"],
    importPath: `${BASE}/LibraryReel`,
    usage:
      '<LibraryReel {...libraryReelDefaults} styleId="keynote-dark" beats={beatFrames(bpm)} />; use reelFrames(props.capture) and reelStarts(props.capture) for the selected edit.',
    cues: (props) =>
      (props.capture as CaptureProofProps | undefined)?.performance
        ? cutCues
        : reelStarts(Boolean(props.capture))
            .slice(1)
            .map((frame): Cue => ({ frame, kind: "cut", sfx: "whoosh", weight: "support", label: "shot" })),
  }),
];
