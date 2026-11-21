import { defineItem, type LibraryItem } from "../types";
import {
  ACCELERATE_INTO_CUT_FRAMES,
  AccelerateIntoCutPreview,
  accelerateCues,
  accelerateIntoCutDefaults,
  accelerateIntoCutSchema,
} from "./AccelerateIntoCut";
import {
  FRAME_TO_OBJECT_FRAMES,
  FrameToObjectPreview,
  frameToObjectCues,
  frameToObjectDefaults,
  frameToObjectSchema,
} from "./FrameToObject";
import { CAUSED_MORPH_FRAMES, CausedMorphPreview, causedMorphSchema } from "./CausedMorph";
import { COLOUR_FLOOD_FRAMES, ColourFloodPreview, colourFloodSchema } from "./ColourFlood";
import { demoCutCue } from "./demo";
import { MATCH_CUT_FRAMES, MatchCutPreview, matchCutCues, matchCutDefaults, matchCutSchema } from "./MatchCut";
import { GROUND_SWAP_FRAMES, GroundSwapPreview, groundSwapCues, groundSwapSchema } from "./GroundSwap";
import {
  NOISE_MATTE_WIPE_FRAMES,
  NoiseMatteWipePreview,
  noiseMattePhases,
  noiseMatteWipeDefaults,
  noiseMatteWipeSchema,
  type NoiseMatteWipeProps,
} from "./NoiseMatteWipe";
import {
  PIXEL_RESOLVE_FRAMES,
  PixelResolvePreview,
  pixelResolveDefaults,
  pixelResolveSchema,
  type PixelResolveProps,
} from "./PixelResolve";
import { LIGHT_BURN_FRAMES, LightBurnPreview, lightBurnPeak, lightBurnSchema, type LightBurnProps } from "./LightBurn";
import { SHARED_CARRY_FRAMES, SharedCarryPreview, sharedCarryLand, sharedCarrySchema } from "./SharedCarry";
import {
  SLICE_PANELS_FRAMES,
  SlicePanelsPreview,
  slicePanelsPeak,
  slicePanelsSchema,
  type SlicePanelsProps,
} from "./SlicePanels";
import {
  SPEED_RAMP_FLURRY_FRAMES,
  SpeedRampFlurry,
  speedRampFlurryCues,
  speedRampFlurryDefaults,
  speedRampFlurrySchema,
} from "./SpeedRampFlurry";
import { WHIP_PAN_FRAMES, WHIP_PAN_PEAK, WhipPanPreview, whipPanSchema } from "./WhipPan";
import { ZOOM_THROUGH_FRAMES, ZOOM_THROUGH_PEAK, ZoomThroughPreview, zoomThroughSchema } from "./ZoomThrough";

import { PageTurnPreview, pageTurnCues, pageTurnDefaults, pageTurnSchema } from "./PageTurn";

export const items: LibraryItem[] = [
  defineItem({
    id: "page-turn",
    category: "transitions",
    title: "Paper turns into the next shot",
    description:
      "A diagonal paper fold lifts from the right edge and passes through the frame, progressively exposing the next plate. Use when a real page, catalogue or paper collage motivates the cut.",
    tags: ["paper", "editorial", "fold", "page", "reveal", "collage"],
    component: PageTurnPreview,
    schema: pageTurnSchema,
    defaultProps: pageTurnDefaults,
    durationInFrames: 96,
    formats: ["vertical", "landscape", "square"],
    inspiredBy: [
      "DesignBookmark Motion: Page flip (method only)",
      "Kokonut UI: Page Flip, paper shading and continuity (method only)",
    ],
    importPath: "src/motion/library/transitions/PageTurn",
    usage: "<PageTurn {...pageTurnDefaults} from={<FirstPage />} to={<SecondPage />} />",
    cues: pageTurnCues,
    sparing: "Use when turning a physical or graphic page is part of the idea.",
  }),
  defineItem({
    id: "ground-swap-cut",
    category: "transitions",
    title: "Ground-swap cut",
    description:
      "Hard cuts that swap the whole ground (paper, accent, ink) with a hero word or a new shot on each, no flash, ring or fade: the references' main cut device. Use `<GroundSwap cuts grounds>{(shot) => ...}</GroundSwap>` for a run of shots, or `groundSwap()` with `cutTiming(4..6)` inside a TransitionSeries; put the cuts on downbeats.",
    tags: ["hard cut", "ground swap", "colour", "hero word", "beat", "rhythm", "light ground", "default"],
    component: GroundSwapPreview,
    schema: groundSwapSchema,
    defaultProps: {
      words: ["Search [250M+] people and [26M+] companies", "80%", "faster", "Ship."],
      cuts: [0, 30, 48, 64],
      grounds: [
        { ground: "#F4F3EF", ink: "#141414", accent: "#F2541B" },
        { ground: "#F2541B", ink: "#FFFFFF" },
        { ground: "#141414", ink: "#F4F3EF" },
        { ground: "#F4F3EF", ink: "#141414" },
      ],
      kick: 0.035,
    },
    durationInFrames: GROUND_SWAP_FRAMES,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "design-reference/reference-gap-matrix.md: firecrawl 4.00 s ground swap, ref-service-explainer black/red/white",
    ],
    importPath: "src/motion/library/transitions/GroundSwap",
    usage:
      'import { GroundSwap, groundSwap, groundSwapCues, HeroWord, AccentLine, GROUND_SWAP_PEAK } from "src/motion/library/transitions/GroundSwap"',
    cues: (props) => groundSwapCues((props as { cuts: number[] }).cuts),
  }),
  defineItem({
    id: "caused-morph",
    category: "transitions",
    title: "Caused morph",
    description:
      "An element of the outgoing shot becomes the next shot's ground: a card or key grows into the frame (`rect`), chart bars level, widen and flood upwards (`bars`), a small orb grows past the corners on circ.in (`orb`, about 8 frames), or a button grows slow-then-fast on sine.in until its sheen is the new frame's top edge (`pill`, about 24 frames); the cut lands before it fills, on the new ground. Import `causedMorph({ mode, source | bars, fill, colour, curve, sheen })` from src/motion/library/transitions/CausedMorph with `cutTiming(8..24)`; `colour` is the next shot's ground, and `<GroundRim sheen>` on the next shot carries the pill's top highlight. `sheenFrom: \"edges\"` (`edgeSheenPreset`, power2.in) lights the growing button with a band from each side while its label shrinks. `mode: \"window\"` (`windowPreset`, `cutTiming(15)`): the button's fill drains top-down to white, the disc drifts to its place, and the next scene's own disc (a portrait) rises into it as into a window; author the next scene with that disc at `windowX`, `windowY`, `windowSize`.",
    tags: [
      "morph",
      "caused",
      "element to ground",
      "bars",
      "flood",
      "card",
      "continuity",
      "light ground",
      "orb",
      "pill",
      "button",
      "cta",
      "end card",
      "window",
      "portrait",
      "drain",
      "sheen",
    ],
    component: CausedMorphPreview,
    schema: causedMorphSchema,
    defaultProps: { mode: "bars", colour: "#2F4BFF", peakAt: 0.82, transitionFrames: 24 },
    durationInFrames: CAUSED_MORPH_FRAMES,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "design-reference/reference-gap-matrix.md: polymarket 3.4 s bars to flood, muse 19.8 s button to ground",
      "design-reference/library/flame: element-grows-to-ground 17.1-18.35 s, button 48% to full bleed on sine.in, its top sheen the end card's rim (pill mode)",
      "design-reference/library/cashfree: element-grows-to-ground 3.7-4.3 s, orb 10% to past the edges in 8 frames on circ.in (orb mode)",
      "design-reference/library/muse: t13 circle-carry-chain 19.63-20.17 s (the send button's blue drains to white top-down in 5 frames, the disc drifts to centre in 5, the character rises into it as into a window in 5, about 0.34 wide; power2.inOut) (window mode)",
      "design-reference/library/polymarket: button-swallow 12.63-13.20 s (the button grows on power2.in for 0.57 s, lightened by a band from each edge, its label scaling down; hard cut before it fills) (sheenFrom edges)",
    ],
    importPath: "src/motion/library/transitions/CausedMorph",
    usage:
      'import { causedMorph, CAUSED_MORPH_PEAK } from "src/motion/library/transitions/CausedMorph"; <TransitionSeries.Transition presentation={causedMorph({ mode: "rect", source, fill: "#fff", colour: nextGround })} timing={cutTiming(20)} />',
    cues: (props) =>
      demoCutCue(
        CAUSED_MORPH_FRAMES,
        (props as { transitionFrames: number }).transitionFrames,
        (props as { peakAt: number }).peakAt,
        "whoosh",
        "morph lands on the new ground",
        (props as { seamFrame?: number }).seamFrame,
      ),
  }),
  defineItem({
    id: "speed-ramp-flurry",
    category: "transitions",
    title: "Speed-ramp flurry",
    description:
      "A 2–4-frame flurry of screens, posts and headlines in different faces and grounds, with one phrase locked on the same spot under a marker, accelerating and then stopping dead on the last item. Use `<SpeedRampFlurry items holds at marker anchorY />` from src/motion/library/transitions/SpeedRampFlurry to show that something is everywhere; lock the stop to a hit.",
    tags: ["flurry", "speed ramp", "montage", "highlight", "lock", "fast cuts", "ugc", "social proof"],
    component: SpeedRampFlurry,
    schema: speedRampFlurrySchema,
    defaultProps: speedRampFlurryDefaults,
    durationInFrames: SPEED_RAMP_FLURRY_FRAMES,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: ["design-reference/reference-gap-matrix.md: ugc-app 2.1–2.9 s highlight lock, palmier 2-frame burst"],
    importPath: "src/motion/library/transitions/SpeedRampFlurry",
    cues: (props) => speedRampFlurryCues(props as Parameters<typeof speedRampFlurryCues>[0]),
  }),
  defineItem({
    id: "zoom-through",
    category: "transitions",
    title: "Zoom through",
    description:
      "The camera flies into one point of the outgoing scene (blur and a ghost streak build with speed) and the next scene replaces it at the push's peak (no blurred crossfade) and lands out of the same depth. Import `zoomThrough({ source })` (a frame-pixel rect of the object that causes the move) or `zoomThrough({ originX, originY })` from src/motion/library/transitions/ZoomThrough as a TransitionSeries presentation with `cutTiming(14..20)`; aim the origin at the element the eye holds.",
    tags: ["zoom", "push", "fly-through", "energy", "reveal", "launch"],
    component: ZoomThroughPreview,
    schema: zoomThroughSchema,
    defaultProps: { originX: 0.86, originY: 0.62, depth: 7, maxBlur: 18, trail: 0, transitionFrames: 18 },
    durationInFrames: ZOOM_THROUGH_FRAMES,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "remotion: packages/transitions cross-zoom and zoom-blur (gl-transitions, MIT; idea and blur peak only)",
    ],
    importPath: "src/motion/library/transitions/ZoomThrough",
    cues: (props) =>
      demoCutCue(
        ZOOM_THROUGH_FRAMES,
        (props as { transitionFrames: number }).transitionFrames,
        ZOOM_THROUGH_PEAK,
        "whoosh",
        "swap at the push\u2019s peak",
        (props as { seamFrame?: number }).seamFrame,
      ),
  }),
  defineItem({
    id: "whip-pan",
    category: "transitions",
    title: "Whip pan",
    description:
      "Both scenes travel as one strip with a directional blur matched to speed on every frame: the classic fast camera whip. Import `whipPan({ direction, maxBlur: 20 })` and `cutTiming(8..10)` from src/motion/library/transitions/WhipPan (re-exported from src/motion/transitions); never give it an eased timing.",
    tags: ["whip", "pan", "fast", "motion blur", "energetic", "cut"],
    component: WhipPanPreview,
    schema: whipPanSchema,
    defaultProps: { direction: "left", transitionFrames: 9, shutter: 0.15, maxBlur: 20 },
    durationInFrames: WHIP_PAN_FRAMES,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: ["src/motion/transitions.tsx whipPan", "remotion-dev/skills transitions rules (idea only)"],
    importPath: "src/motion/library/transitions/WhipPan",
    cues: (props) =>
      demoCutCue(
        WHIP_PAN_FRAMES,
        (props as { transitionFrames: number }).transitionFrames,
        WHIP_PAN_PEAK,
        "whoosh",
        "whip centre",
        (props as { seamFrame?: number }).seamFrame,
      ),
  }),
  defineItem({
    id: "slice-panels",
    category: "transitions",
    title: "Slice panels",
    description:
      'The next scene slides in as staggered panels, each with a soft leading shadow, while the outgoing scene sinks and darkens beneath: an editorial, structured reveal. Import `slicePanels({ count, direction })` from src/motion/library/transitions/SlicePanels with `cutTiming(16..24)`. `sheetCoverPreset` (`count: 1`, `motion: "clip"`, `curve: "power3.out"`, `reach`) is a single flat sheet of the next ground rising from an edge, fast then a long tail, which may stop short of full before the cut: the next element can start drawing on it before it finishes.',
    tags: ["slice", "panels", "stagger", "wipe", "editorial", "structured", "sheet", "rising sheet", "cover"],
    component: SlicePanelsPreview,
    schema: slicePanelsSchema,
    defaultProps: { count: 5, direction: "up", spread: 0.38, shade: 0.55, transitionFrames: 22 },
    durationInFrames: SLICE_PANELS_FRAMES,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "hyperframes: registry transition blocks, staggered blinds (idea only)",
      "remotion: packages/transitions slide and wipe (idea only)",
      "design-reference/library/flex: t02-rising-sheet-wipe 1.67-2.50 s and 14.80-16.23 s (one flat sheet of the next ground rises over a still plate: 6% to 55% of the height F52-F56, 72% F59, 86% F64, full F74, power3.out; the next element starts drawing on it before it is full; sheetCoverPreset)",
    ],
    importPath: "src/motion/library/transitions/SlicePanels",
    sparing:
      "Staggered slices are a stock After Effects pack device and none of the ten references uses one. Justified only for an editorial or magazine look whose layout is already in columns; never as a generic scene change. The single rising sheet (sheetCoverPreset) is not a stock pack device: one reference uses it twice, as a change of ground.",
    cues: (props) => {
      const p = props as SlicePanelsProps;
      return demoCutCue(
        SLICE_PANELS_FRAMES,
        p.transitionFrames,
        slicePanelsPeak(p),
        "whoosh",
        p.count === 1 ? "sheet crosses half the frame" : "middle panel lands",
        p.seamFrame,
      );
    },
  }),
  defineItem({
    id: "light-burn",
    category: "transitions",
    title: "Light burn",
    description:
      'A front of warm light sweeps across the frame and is cut, at its peak, to the next scene, which decays out of the flash: a film-burn flash cut for a drop. Import `lightBurn({ core, halo })` from src/motion/library/transitions/LightBurn with `cutTiming(12..20)`; land the peak on the hit. `shape: "leak"` (`leakFlashPreset`, `cutTiming(2..4)`) hides a change of graded plates behind one to three stepped frames of overexposure with a coloured radial leak, the new plate on the frame after the brightest; `shape: "edges"` (`edgeBloomPreset`, `cutTiming(10)`) brightens the frame from the edges inward like an overexposed vignette onto a light ground, on power2.out.',
    tags: [
      "flash",
      "light leak",
      "burn",
      "warm",
      "reveal",
      "drop",
      "leak",
      "overexposure",
      "bloom",
      "vignette",
      "edges",
    ],
    component: LightBurnPreview,
    schema: lightBurnSchema,
    defaultProps: { core: "#FFF4E2", halo: "#FF8A3D", fromX: 0.15, intensity: 0.9, transitionFrames: 16 },
    durationInFrames: LIGHT_BURN_FRAMES,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "remotion: packages/transitions film-burn (gl-transitions, MIT; idea only)",
      "design-reference/library/abdulah: t03-light-leak-flash-cut, seven times 6.83-45.40 s (1-3 frames of flash between graded plates: an overexposed warm frame, then a green-white leak; the new plate starts on the frame after the brightest; steps(1)) (leak shape)",
      "design-reference/library/flex: t13-radial-bloom-dissolve-device-rise 28.07-28.40 s (dark green brightens from the edges inward, the centre last, to off-white in 10 frames F842-F851, power2.out, on the beat) (edges shape)",
    ],
    importPath: "src/motion/library/transitions/LightBurn",
    sparing:
      "The sweep is the most recognisable stock-template transition and no reference uses it. Justified only on a single drop in a music or film-look piece whose world has real light; never between product or UI shots. The leak (a manifesto edit over archive) and the edge bloom (onto a light ground) are the forms the references use.",
    cues: (props) => {
      const { shape, transitionFrames, seamFrame } = props as LightBurnProps;
      return demoCutCue(
        LIGHT_BURN_FRAMES,
        transitionFrames,
        lightBurnPeak(shape ?? "sweep", transitionFrames),
        "impact",
        shape === "leak"
          ? "new plate after the brightest frame"
          : shape === "edges"
            ? "bloom half closed"
            : "cut at full burn",
        seamFrame,
      );
    },
  }),
  defineItem({
    id: "noise-matte-wipe",
    category: "transitions",
    title: "Noise matte wipe",
    description:
      'An organic soft front (smoke, cloud, ink) crosses the frame from a corner or an edge and opens the next scene behind it (`mode: "reveal"`), optionally with a coloured fringe on the front; or a soft cloud cover rises over the old scene, holds full for 2-3 frames and parts from the centre onto the new one (`mode: "cover"`). Import `noiseMatteWipe({ mode, origin, curve, feather, roughness, fringe })` from src/motion/library/transitions/NoiseMatteWipe with `cutTiming(10..20)` (`noiseMatteAcePreset` for an even smoke front, linear over 13 frames); for a move between a light and a dark world, or into an atmospheric plate.',
    tags: ["wipe", "smoke", "cloud", "ink", "matte", "organic", "soft edge", "noise", "atmosphere", "reveal", "cover"],
    component: NoiseMatteWipePreview,
    schema: noiseMatteWipeSchema,
    defaultProps: noiseMatteWipeDefaults,
    durationInFrames: NOISE_MATTE_WIPE_FRAMES,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "design-reference/library/ace: t06-smoke-wipe-to-dark 7.63-7.93 s (dark smoke from the bottom-right corner covers the frame in 18 frames at 60 fps; by covered share an even front with a soft tail, 0.25 dark after 2 frames at 30 fps, 0.94 after 8, noiseMatteAcePreset linear over 13; the next scene's orb appears before it finishes)",
      "design-reference/library/flex: t07-organic-matte-reveal 13.40-13.77 s (cloud-shaped soft matte from the right in 11 frames, power1.inOut, on the beat, with a slight chromatic fringe)",
      "design-reference/library/muse: t02 cloud-cover descent 2.23-2.83 s (cloud rises over the type, fills the frame 2-3 frames, parts onto the next shot; power2.inOut)",
    ],
    importPath: "src/motion/library/transitions/NoiseMatteWipe",
    usage:
      'import { noiseMatteWipe, noiseMattePhases } from "src/motion/library/transitions/NoiseMatteWipe"; <TransitionSeries.Transition presentation={noiseMatteWipe({ origin: "right", curve: "power1.inOut", fringe: "#7BE0FF" })} timing={cutTiming(11)} />. seamFrame = transition start + round(noiseMattePhases(mode, hold, curve).cut * frames).',
    cues: (props) => {
      const { mode, hold, curve, transitionFrames, seamFrame } = props as NoiseMatteWipeProps;
      return demoCutCue(
        NOISE_MATTE_WIPE_FRAMES,
        transitionFrames,
        noiseMattePhases(mode, hold, curve).cut,
        "whoosh",
        mode === "cover" ? "scenes swap under the full cover" : "front crosses the middle",
        seamFrame,
      );
    },
  }),
  defineItem({
    id: "pixel-resolve",
    category: "transitions",
    title: "Pixel resolve",
    description:
      'The next scene arrives as coarse square pixels. `mode: "mosaic"`: three overexposed frames replace the old scene, then the new one resolves from big blocks to full detail in about 10 frames, halving the block size on power2.out. `mode: "ring"`: a ring of grid-snapped squares grows from a point on sine.out with the new scene inside it, the ring\'s cells fading into it behind the front. Import `pixelResolve({ mode, ... })` from src/motion/library/transitions/PixelResolve with `cutTiming(13)` (mosaic) or `cutTiming(20)` (ring); for a digital, screen-made world, a reveal of a site or an end card.',
    tags: ["pixel", "mosaic", "pixelate", "resolve", "ring", "grid", "digital", "flash", "reveal", "end card", "logo"],
    component: PixelResolvePreview,
    schema: pixelResolveSchema,
    defaultProps: pixelResolveDefaults,
    durationInFrames: PIXEL_RESOLVE_FRAMES,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "design-reference/library/cashfree: bloom-cut-into-screen 4.90-5.33 s (three overexposed mint-white frames F148-F150, then the next shot resolves from coarse blocks over F151-F160, power2.out, stepped)",
      "design-reference/library/gojiberry: mosaic-ring-reveal 18.5-19.2 s (from the mark a ring of coarse square pixels grows outward over about 0.7 s, sine.out, leaving a warm peach gradient behind it)",
    ],
    importPath: "src/motion/library/transitions/PixelResolve",
    usage:
      'import { pixelResolve } from "src/motion/library/transitions/PixelResolve"; <TransitionSeries.Transition presentation={pixelResolve({ mode: "mosaic", flashFrames: 3 })} timing={cutTiming(13)} />. The cut is perceived on the seam\'s first frame: seamFrame = the transition\'s start.',
    cues: (props) => {
      const { mode, transitionFrames, seamFrame } = props as PixelResolveProps;
      return demoCutCue(
        PIXEL_RESOLVE_FRAMES,
        transitionFrames,
        0,
        mode === "ring" ? "whoosh" : "impact",
        mode === "ring" ? "ring starts" : "flash replaces the frame",
        seamFrame,
      );
    },
  }),
  defineItem({
    id: "shared-element-carry",
    category: "transitions",
    title: "Shared-element carry",
    description:
      "One element leaves its place in scene A, travels on the camera ease with directional motion blur and lands in its place in scene B, which builds around it; the element never cuts. Use `<SharedCarry at frames from to before after carry={(rect, scale) => ...} />` from src/motion/library/transitions/SharedCarry (rects in frame pixels; keep both scenes on one ground).",
    tags: ["carry", "shared element", "morph", "continuity", "caused", "ui", "product"],
    component: SharedCarryPreview,
    schema: sharedCarrySchema,
    defaultProps: { frames: 18, maxBlur: 10, headline: "Ship in hours.", caption: "Median deploy time, last 90 days" },
    durationInFrames: SHARED_CARRY_FRAMES,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "design-reference/craft-rules.md carry across and blur swap",
      "src/motion/layout-morph.tsx morphRect",
      "Material shared-element transitions (idea only)",
    ],
    importPath: "src/motion/library/transitions/SharedCarry",
    cues: (props) => {
      const { frames, seamFrame } = props as { frames: number; seamFrame?: number };
      return seamFrame === undefined
        ? [
            {
              frame: sharedCarryLand(38, frames),
              kind: "land",
              sfx: "click",
              weight: "hero",
              label: "carried element lands",
            },
          ]
        : [{ frame: seamFrame, kind: "cut", sfx: "click", weight: "hero", label: "carried element lands" }];
    },
  }),
  defineItem({
    id: "colour-flood",
    category: "transitions",
    title: "Colour flood",
    description:
      "The accent colour floods out of one element and is hard-cut to the next scene, on that colour, before it fills the frame: never a flat dead frame. Import `colourFlood({ source: { x, y, width, height }, colour })` from src/motion/library/transitions/ColourFlood with `cutTiming(14..20)`; `colour` must be the next scene's ground.",
    tags: ["colour", "flood", "accent", "caused", "reveal", "brand"],
    component: ColourFloodPreview,
    schema: colourFloodSchema,
    defaultProps: { colour: "#2F4BFF", floodShare: 0.8, transitionFrames: 18 },
    durationInFrames: COLOUR_FLOOD_FRAMES,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "design-reference/craft-rules.md colour flood",
      "src/motion/transitions.tsx shapeWipe exponential growth",
    ],
    importPath: "src/motion/library/transitions/ColourFlood",
    cues: (props) =>
      demoCutCue(
        COLOUR_FLOOD_FRAMES,
        (props as { transitionFrames: number }).transitionFrames,
        (props as { floodShare: number }).floodShare,
        "whoosh",
        "cut before the flood fills",
        (props as { seamFrame?: number }).seamFrame,
      ),
  }),
  defineItem({
    id: "match-cut",
    category: "transitions",
    title: "Match cut",
    description:
      "A 0-frame cut where one shape becomes another: the old shot pushes in on its subject (a record light, a sun, a button), the cut lands on `seamFrame` with the new shot's subject at the same place and size, and the new shot pulls back to reveal what that shape is now. Use when two things share a silhouette and the idea links them; nothing is cross-faded.",
    tags: ["match cut", "shape match", "continuity", "hard cut", "graphic match", "push", "meaning", "seam"],
    component: MatchCutPreview,
    schema: matchCutSchema,
    defaultProps: matchCutDefaults,
    durationInFrames: MATCH_CUT_FRAMES,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "src/motion/transitions.tsx MatchCut (promoted)",
      "graphic match cut, film editing convention (idea only)",
    ],
    importPath: "src/motion/library/transitions/MatchCut",
    usage:
      'import { MatchCutMove, matchCutPose } from "src/motion/library/transitions/MatchCut"; <MatchCutMove seamFrame={48} from={{ x, y, size }} to={{ x, y, size }} approach={16} settle={18} push={2.6} before={<ShotA />} after={<ShotB />} />. Anchors are shares of the frame (size of the shorter side); author both shots so the subjects sit exactly at from and to.',
    cues: (props) => matchCutCues(props as Parameters<typeof matchCutCues>[0]),
  }),
  defineItem({
    id: "accelerate-into-cut",
    category: "transitions",
    title: "Accelerate into cut",
    description:
      "The old shot pushes (or drifts up or left) faster every frame on circ.in and hard-cuts at its peak speed; the new shot carries on in the same direction at that speed and halves it each frame, so the cut hides inside the motion and reads as one camera arriving. Use between two shots of one world (wide to close-up, panel to panel on a white interface), where a still cut would read as a jump; for a shape that matches across the cut use match-cut instead.",
    tags: ["accelerate", "push", "drift", "hard cut", "momentum", "continuity", "seam", "ui", "close-up", "camera"],
    component: AccelerateIntoCutPreview,
    schema: accelerateIntoCutSchema,
    defaultProps: accelerateIntoCutDefaults,
    durationInFrames: ACCELERATE_INTO_CUT_FRAMES,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "design-reference/library/muse: accelerate-into-cut 4.73-5.13 s (push speeds up over the last 4 frames; after the cut the speed halves: 34, 17, 7.7)",
      "design-reference/library/nexaa: accelerate-into-cut, seen five times 10.9-21.8 s (circ.in drift, 0.40 s, into a cut; the next shot settles in 4-6 frames)",
      "design-reference/library/ace: tilt-fly-match-cut 4.45-5.03 s (acceleration builds speed into the cut)",
    ],
    importPath: "src/motion/library/transitions/AccelerateIntoCut",
    usage:
      'import { AccelerateIntoCut, accelerateState, accelerateCues } from "src/motion/library/transitions/AccelerateIntoCut"; <AccelerateIntoCut seamFrame={44} approach={12} amount={0.42} decay={0.5} move="push" originX={0.78} originY={0.58} ground="#F3F2EE" before={<Wide />} after={<CloseUp />} />. Aim the origin at the element the eye holds; drive your own layers with accelerateState(frame, timing).',
    cues: (props) => accelerateCues(props as Parameters<typeof accelerateCues>[0]),
  }),
  defineItem({
    id: "frame-to-object",
    category: "transitions",
    title: "Frame shrinks to object",
    description:
      'The whole frame gains a thin border and shrinks at its own aspect ratio (power2.inOut, about 19 frames, to 0.4; or power3.out over about 32 frames, 90% done in 14, to 0.47 onto a monitor) into a slab inside a new scene, its content fading as a sheen crosses it; optionally the slab narrows into a button whose label types, turns edge-on and opens as the object. Use when what the viewer was reading turns out to be the product or the call to action. `mode: "matte"` (`<MatteCollapse>`, `matteCollapsePreset`): on a hard cut a soft-edged black rounded matte covers about 92% x 85% of the new plate and collapses in 12 frames on power3.out into one of its elements (an underline, a selection), handing over on its last frame.',
    tags: [
      "shrink",
      "frame to object",
      "pull back",
      "slab",
      "button",
      "monitor",
      "product",
      "reveal",
      "continuity",
      "cta",
      "matte",
      "collapse",
      "underline",
    ],
    component: FrameToObjectPreview,
    schema: frameToObjectSchema,
    defaultProps: frameToObjectDefaults,
    durationInFrames: FRAME_TO_OBJECT_FRAMES,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "design-reference/library/flex: frame-shrinks-to-product-object 5.43-8.4 s (frame to 0.6 then 0.4 of width in 19 frames, power2.inOut; slab to button; edge-on turn; opens as the object)",
      "design-reference/library/cashfree: frame-shrinks-to-product-object 4.93-6.17 s (pull back onto a monitor screen at about 0.47 scale, power3.out, 90% in 0.46 s)",
      "src/motion/layout-morph.tsx GrowToScene (run in reverse, idea)",
      "design-reference/library/motionfly: t02-card-collapses-to-underline 2.00-2.40 s (hard cut to a plate under a soft-edged black card about 92% x 85%; it shrinks over 12 frames toward (0.45, 0.43), frame differences 41, 33, 24, 16, 11, 6, 3, 1.7, into the dock's white underline) (matte mode)",
    ],
    importPath: "src/motion/library/transitions/FrameToObject",
    usage:
      'import { FrameToObject, MatteCollapse, matteRect, shrinkRect, frameToObjectCues } from "src/motion/library/transitions/FrameToObject"; <FrameToObject at={22} frames={19} toScale={0.4} ease="power2.inOut" toX={0.5} toY={0.5} ground="#F7F3EF" fill="#1F4D37" contentKeep={0.2} housing="slab" then="button-flip" label="Open an account" object={<Card />}>{fullFrameShot}</FrameToObject>. Matte: <MatteCollapse at={0} frames={12} ease="power3.out" from={{ width: 0.92, height: 0.85 }} target={underlineRectShares} fill="#0B0B0D" landColour="#FFFFFF" soft={24} around={<Dock />}>{plate}</MatteCollapse>',
    cues: (props) => {
      const p = props as Parameters<typeof frameToObjectCues>[0] & { mode?: "frame" | "matte" };
      return frameToObjectCues(p.mode === "matte" ? { ...p, then: "hold" } : p);
    },
  }),
];
