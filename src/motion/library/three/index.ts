import { RenderPlate, renderPlateSchema, renderPlatePreview } from "./RenderPlate";
import { defineItem, type LibraryItem } from "../types";
import { BlenderPlate, blenderPlateCues, blenderPlateSchema, type BlenderPlateProps } from "./BlenderPlate";
import {
  DepthCardFlythrough,
  FAN_DEFAULTS,
  depthCardFlythroughSchema,
  type DepthCardFlythroughProps,
} from "./DepthCardFlythrough";
import { ExtrudedMark, extrudedMarkSchema } from "./ExtrudedMark";
import {
  PointSphere,
  pointSphereCues,
  pointSphereDefaults,
  pointSphereSchema,
  type PointSphereProps,
} from "./PointSphere";
import {
  PrintingSlip,
  printingSlipCues,
  printingSlipDefaults,
  printingSlipSchema,
  type PrintingSlipProps,
} from "./PrintingSlip";
import { ShadedOrb, shadedOrbCues, shadedOrbSchema, type ShadedOrbProps } from "./ShadedOrb";
import { ParticleAssemble, particleAssembleSchema, type ParticleAssembleProps } from "./ParticleAssemble";
import { StudioProductStage, studioProductStageSchema } from "./StudioProductStage";

import { THREE_SHOT_EXPERIMENT } from "../../../lib/experiments/registry";
import { ModelShot, modelShotSchema } from "./ModelShot";
import { InstancedAssembly, assemblySchema } from "./InstancedAssembly";
import { assemblyCues } from "./shot-plan";
import {
  airPath,
  cellAssembly,
  connectorReveal,
  opticalWindow,
  projectorStage,
  releaseBattery,
} from "./shot-techniques";

const reference = "https://github.com/pmndrs/examples/tree/541599ac5ad913de85796403c1c6927ada3b303c/examples";

const shotItems = [
  defineItem({
    id: "product-model-stage",
    category: "three",
    title: "Product model stage",
    description:
      "Frame a local GLB on a lit studio stage with a measured turntable, useful when the viewer needs to read the shape from more than one angle.",
    tags: ["product", "GLB", "framing", "orbit", "hero", "studio"],
    formats: ["landscape", "vertical"],
    component: ModelShot,
    schema: modelShotSchema,
    defaultProps: projectorStage,
    durationInFrames: projectorStage.durationInFrames,
    durationForProps: (props) => props.durationInFrames,
    importPath: "src/motion/library/three/ModelShot",
    inspiredBy: [reference + "/bounds-and-makedefault (MIT, technique study)"],
    shotTechnique: {
      id: "product-model-stage",
      functions: ["reveal", "proof", "hook"],
      experiment: THREE_SHOT_EXPERIMENT,
    },
    cues: () => [],
  }),
  defineItem({
    id: "camera-path-reveal",
    category: "three",
    title: "Camera path reveal",
    description:
      "Follow a timed 3D camera path from the full object to a part. Let the camera settle before a label or a demonstration starts.",
    tags: ["product", "camera", "3D", "dolly", "path", "connector", "reveal"],
    formats: ["landscape", "vertical"],
    component: ModelShot,
    schema: modelShotSchema,
    defaultProps: connectorReveal,
    durationInFrames: connectorReveal.durationInFrames,
    durationForProps: (props) => props.durationInFrames,
    importPath: "src/motion/library/three/ModelShot",
    inspiredBy: [reference + "/motionpathcontrols (MIT, technique study)"],
    shotTechnique: {
      id: "camera-path-reveal",
      functions: ["reveal", "emphasis", "transition"],
      experiment: THREE_SHOT_EXPERIMENT,
    },
    cues: ({ camera }) => (camera ? [{ frame: camera.endFrame, kind: "stop", label: "camera settles" }] : []),
  }),
  defineItem({
    id: "gltf-clip-cue",
    category: "three",
    title: "GLB clip on a cue",
    description:
      "Play an existing named GLB animation on exact shot frames. Use to show a mechanism opening, locking or assembling in time with an explanation.",
    tags: ["mechanism", "GLB", "rig", "animation", "clip", "demonstration"],
    formats: ["landscape", "vertical"],
    component: ModelShot,
    schema: modelShotSchema,
    defaultProps: releaseBattery,
    durationInFrames: releaseBattery.durationInFrames,
    durationForProps: (props) => props.durationInFrames,
    importPath: "src/motion/library/three/ModelShot",
    inspiredBy: [reference + "/gltf-animations-re-used (MIT, technique study)"],
    shotTechnique: { id: "gltf-clip-cue", functions: ["proof", "reveal"], experiment: THREE_SHOT_EXPERIMENT },
    cues: ({ clip }) =>
      clip
        ? [
            { frame: clip.startFrame, kind: "click", sfx: "click" },
            { frame: clip.endFrame, kind: "stop" },
          ]
        : [],
  }),
  defineItem({
    id: "technical-part-outline",
    category: "three",
    title: "Technical part outline",
    description:
      "Show the edges of one visible model part at a time to direct the eye through a technical explanation or teardown.",
    tags: ["part", "GLB", "outline", "edges", "geometry", "teardown", "technical"],
    formats: ["landscape", "vertical"],
    component: ModelShot,
    schema: modelShotSchema,
    defaultProps: airPath,
    durationInFrames: airPath.durationInFrames,
    durationForProps: (props) => props.durationInFrames,
    importPath: "src/motion/library/three/ModelShot",
    inspiredBy: [reference + "/edgesgeometry (MIT, technique study)"],
    shotTechnique: {
      id: "technical-part-outline",
      functions: ["emphasis", "proof"],
      experiment: THREE_SHOT_EXPERIMENT,
    },
    cues: ({ highlights }) =>
      highlights?.map(({ node, startFrame }) => ({ frame: startFrame, kind: "reveal", label: node })) ?? [],
  }),
  defineItem({
    id: "frosted-product-window",
    category: "three",
    title: "Frosted product window",
    description:
      "Reveal a product behind a moving translucent slab. Use the frosted silhouette as a clue and keep labels outside of the glass.",
    tags: ["glass", "frosted", "transmission", "material", "product", "reveal"],
    formats: ["landscape", "vertical"],
    component: ModelShot,
    schema: modelShotSchema,
    defaultProps: opticalWindow,
    durationInFrames: opticalWindow.durationInFrames,
    durationForProps: (props) => props.durationInFrames,
    importPath: "src/motion/library/three/ModelShot",
    inspiredBy: [reference + "/frosted-glass (MIT, technique study)"],
    shotTechnique: { id: "frosted-product-window", functions: ["reveal", "hook"], experiment: THREE_SHOT_EXPERIMENT },
    cues: ({ glass }) => (glass ? [{ frame: glass.endFrame, kind: "reveal", sfx: "glass" }] : []),
  }),
  defineItem({
    id: "instanced-assembly",
    category: "three",
    title: "Instanced assembly",
    description:
      "Assemble exact counts into spatial groups. Use when layout shows what goes together or how a modular system is built.",
    tags: ["assembly", "data", "modules", "instancing", "groups", "units", "count", "reveal"],
    formats: ["landscape", "vertical"],
    component: InstancedAssembly,
    schema: assemblySchema,
    defaultProps: cellAssembly,
    durationInFrames: cellAssembly.durationInFrames,
    durationForProps: (props) => props.durationInFrames,
    importPath: "src/motion/library/three/InstancedAssembly",
    inspiredBy: [reference + "/hi-key-bubbles (MIT, technique study)"],
    shotTechnique: {
      id: "instanced-assembly",
      functions: ["proof", "reveal", "emphasis"],
      experiment: THREE_SHOT_EXPERIMENT,
    },
    cues: (props) =>
      assemblyCues(props).map((frame, index) => ({ frame, kind: "land", sfx: "click", label: `group ${index + 1}` })),
  }),
];

export const items: LibraryItem[] = [
  ...shotItems,
  defineItem<BlenderPlateProps>({
    id: "blender-plate",
    category: "three",
    title: "Blender photoreal plate",
    description:
      "Plays a photoreal Blender render (alpha PNG sequence or video) of a real device on a studio sweep, with the headline composited beside it and, optionally, live UI pinned to the screen corners from camera.json. Use for hero product beats; render the plate first with scripts/blender shot templates (docs/photoreal-3d.md). Also plays the non-device shots: the glass dome world and the plush character (`assets:sync --id plates:glass-dome`, `plates:plush-character`).",
    tags: ["product", "hero", "phone", "laptop", "photoreal", "blender", "turntable", "screen", "device", "launch"],
    component: BlenderPlate,
    schema: blenderPlateSchema,
    defaultProps: {
      src: "shared/3d/plates/hero-turntable.mp4",
      firstFrame: 1,
      frameCount: 60,
      fit: "cover",
      background: "#050506",
      headline: "Every payout, settled.",
      subline: "In minutes, not days.",
      textColour: "#f5f5f7",
      textSide: "left",
      textAt: 34,
    },
    durationInFrames: 90,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "Apple product films: device turntables on a black sweep",
      "design-reference/photoreal-3d-pipeline.md",
    ],
    importPath: "src/motion/library/three/BlenderPlate",
    cues: blenderPlateCues,
  }),
  defineItem({
    id: "render-plate",
    category: "three",
    title: "External render plate",
    description:
      "A full-frame external Vork or Blender render, keeping RGBA and source-frame timing. The default is an offline vector preview, not a rendered product.",
    tags: ["vork", "render", "plate", "alpha", "external", "3d"],
    component: RenderPlate,
    schema: renderPlateSchema,
    defaultProps: {
      plate: { src: renderPlatePreview, firstFrame: 0, frameCount: 90, fit: "contain" },
      sourceFps: 30,
      background: "#0b141b",
    },
    formats: ["landscape", "square", "vertical"],
    durationInFrames: 90,
    importPath: "src/motion/library/three/RenderPlate",
    cues: () => [],
  }),
  defineItem({
    id: "studio-product-stage",
    category: "three",
    title: "Studio product stage",
    description:
      'A real phone or laptop model (or a flat card) on a dark studio sweep, lit by a studio HDRI: reflections, rim light, contact shadow, a slow turntable and dolly-in, rendered live in three.js. Use for quick, data-driven or many-variant device shots; for the hero beat render a blender-plate instead. Pass a screen image or let it draw a clean procedural screen. `layout: "array"` lays copies flat in an isometric grid, each with its own screen, and trucks across them: the app on every device; `plate` plays its Blender render (scripts/blender/device_array.py) instead.',
    tags: [
      "product",
      "hero",
      "phone",
      "laptop",
      "card",
      "studio",
      "turntable",
      "dolly",
      "reflections",
      "launch",
      "glb",
      "array",
      "isometric",
      "grid",
    ],
    component: StudioProductStage,
    schema: studioProductStageSchema,
    defaultProps: {
      screenImage: "",
      shape: "phone",
      headline: "Every frame, on purpose.",
      subline: "Motion that knows where it is going.",
      bodyColour: "#9a9ca3",
      accent: "#7aa2ff",
      background: "#1a1b22",
      orbitDegrees: 70,
      hdri: "studio",
    },
    durationInFrames: 120,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "remotion: packages/template-three Phone (MIT, idea only)",
      "pmndrs/drei Lightformer + ContactShadows docs (MIT, idea only)",
      "Apple product launch turntables",
      "design-reference/library/cashfree: device-carousel 23.43-27.03 s (isometric array of phones on white, each showing the app, camera trucks right 0.25 W and down 0.14 H, sine.inOut)",
    ],
    importPath: "src/motion/library/three/StudioProductStage",
    cues: () => [{ frame: 0, kind: "reveal", sfx: "whoosh", weight: "support", label: "device rises" }],
  }),
  defineItem({
    id: "extruded-mark",
    category: "three",
    title: "Extruded mark reveal",
    description:
      "An SVG logo mark extruded with a bevel into chrome, gold, graphite or glass; it swings into place and a softbox sweeps across its reflections, then an optional wordmark settles below. Use for a logo sting or a brand close.",
    tags: ["logo", "brand", "extrude", "chrome", "gold", "glass", "reveal", "sting", "end card"],
    component: ExtrudedMark,
    schema: extrudedMarkSchema,
    defaultProps: {
      paths: ["M50 6 L94 84 L72 84 L50 44 L28 84 L6 84 Z", "M50 58 L59 72 L50 86 L41 72 Z"],
      viewBox: 100,
      finish: "chrome",
      depth: 0.16,
      wordmark: "Apex",
      background: "#1a1c24",
      accent: "#6f8cff",
    },
    durationInFrames: 120,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "three.js examples: SVGLoader + ExtrudeGeometry (MIT, idea only)",
      "pmndrs/drei Lightformer docs (MIT, idea only)",
      "Apple and Linear logo stings",
    ],
    importPath: "src/motion/library/three/ExtrudedMark",
    cues: () => [
      { frame: 22, kind: "land", sfx: "impact", weight: "hero", label: "mark settles" },
      { frame: 52, kind: "reveal", sfx: "whoosh", weight: "support", label: "wordmark" },
    ],
  }),
  defineItem({
    id: "particle-assemble",
    category: "three",
    title: "Particle word assembly",
    description:
      "A seeded galaxy of glowing points swirls in depth and condenses into a word, then a light wave runs across the letters. Use for a name, a number or a one-word idea arriving out of noise.",
    tags: ["particles", "word", "assemble", "galaxy", "chaos to order", "glow", "reveal", "points"],
    component: ParticleAssemble,
    schema: particleAssembleSchema,
    defaultProps: {
      word: "SIGNAL",
      count: 22000,
      colourA: "#7aa2ff",
      colourB: "#f3c6ff",
      background: "#0c0e18",
      seed: "signal",
      landFrame: 80,
    },
    durationInFrames: 120,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "whaleyxbt/claude-motion particle sims (idea only)",
      "three.js points + canvas text sampling (common technique)",
    ],
    importPath: "src/motion/library/three/ParticleAssemble",
    cues: (p: ParticleAssembleProps) => [
      { frame: p.landFrame, kind: "land", sfx: "chime", weight: "hero", label: "word forms" },
    ],
  }),
  defineItem({
    id: "depth-card-flythrough",
    category: "three",
    title: "Depth card fly-through",
    description:
      'Cards hang in real depth and the camera flies past them to land square on the last one, with fog falling off into the distance. Use to show a set of features, screens or steps as one continuous move. `mode: "fan"` instead fans a dozen copies of the first card about one corner like a deck (sine.inOut, each copy a little later): many of one thing; `plate` plays its brushed-metal Blender render (scripts/blender/card_fan.py) instead.',
    tags: ["cards", "fly-through", "depth", "fog", "features", "camera move", "gallery", "3d", "fan", "deck", "stack"],
    component: DepthCardFlythrough,
    schema: depthCardFlythroughSchema,
    defaultProps: {
      cards: [
        { title: "Capture", label: "Step", image: "", colour: "#ff7a59" },
        { title: "Arrange", label: "Step", image: "", colour: "#ffc857" },
        { title: "Direct", label: "Step", image: "", colour: "#59d1ff" },
        { title: "Render", label: "Step", image: "", colour: "#9b7bff" },
        { title: "Ship it.", label: "Result", image: "", colour: "#7aa2ff" },
      ],
      spacing: 3.2,
      background: "#14151c",
    },
    durationInFrames: 150,
    formats: ["landscape", "vertical"],
    inspiredBy: [
      "Linear feature fly-throughs",
      "design-reference/library/flex: t06-metal-object-fan-orbit 8.67-13.43 s (a dozen copies fanned like a deck over ~53 f, F327-F380, sine.inOut inferred)",
    ],
    importPath: "src/motion/library/three/DepthCardFlythrough",
    cues: (p: DepthCardFlythroughProps) => {
      if (p.mode === "fan") {
        const fan = { ...FAN_DEFAULTS, ...p.fan };
        return [
          {
            frame: Math.min(fan.at + fan.frames, p.durationInFrames ?? 150),
            kind: "land" as const,
            sfx: "whoosh" as const,
            weight: "hero" as const,
            label: "fan open",
          },
        ];
      }
      const end = (p.durationInFrames ?? 150) - 12;
      return [{ frame: end, kind: "land", sfx: "none", weight: "hero", label: "lands on the last card" }];
    },
  }),
  defineItem<ShadedOrbProps>({
    id: "shaded-orb",
    category: "three",
    title: "Shaded orb",
    description:
      "A drawn sphere that needs no 3D: `glossy` grows a shiny orb that shifts colour, opens two eyes and floods with a second colour from the bottom (a character in 0.6 s), or sits between two words as a word itself and carries a mark; `iridescent` brings a seeded field of rainbow-banded spheres in from the edges around a clear centre and can implode it into a blur. Use for a friendly mascot beat, an object that becomes part of a sentence, or a burst of colour around a line. `plate` plays the coated, lit Blender orb (scripts/blender/glossy_orb.py, same timing) instead of the drawing.",
    tags: ["sphere", "orb", "character", "glossy", "iridescent", "bubble", "inline", "mascot", "burst", "reveal"],
    component: ShadedOrb,
    schema: shadedOrbSchema,
    defaultProps: {
      mode: "glossy",
      ground: "#f4f4f2",
      at: 6,
      size: 0.4,
      colour: "#86f2d9",
      shiftTo: "#5fe3f4",
      flood: "#38d98f",
      eyes: true,
      mark: "",
      before: "",
      after: "",
      textColour: "#111214",
    },
    durationInFrames: 60,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "design-reference/library/ace: t05-dots-to-character-morph 2.45-3.40 s (blob to 40% of the cell in 0.37 s, cyan shift, eyes in 0.1 s, mint flood bottom-up in 0.08 s)",
      "design-reference/library/cashfree: orb-match-cut 2.20-2.47 s and orb-grows-to-ground 3.70-4.30 s (glossy orb inline between two words, carrying the mark)",
      "design-reference/library/flame: collapse-to-point-burst 3.25-3.75 s (spheres 5-30% of the width enter from the edges in 5 f, centre clear) and implode-and-blur 4.92-5.46 s (ring in 5 f, circ.out, chromatic blur)",
      "design-reference/library/muse: t03 and t16 (the dome's thin-film rim as an iridescent sphere)",
    ],
    importPath: "src/motion/library/three/ShadedOrb",
    usage:
      '<ShadedOrb mode="glossy" ... /> for a scene, or <GlossyOrb size colour eyes flood mark /> / <IridescentSphere size hue tilt depth /> inline, driven by orbState and spherePose from three-plan.ts',
    cues: shadedOrbCues,
  }),
  defineItem<PointSphereProps>({
    id: "point-sphere",
    category: "three",
    title: "Point sphere",
    description:
      "A sphere drawn from seeded short strokes or dots that pulls out from close, turns slowly and carries a two-colour tint that drifts; optional procedural land makes a dotted globe, a thin ring frames it, and a stat line fades in word by word over it. Use behind a reach or scale claim (countries, users, cities) on a flat brand ground.",
    tags: ["sphere", "globe", "points", "strokes", "particles", "world", "reach", "stat", "pull-out", "rotate"],
    component: PointSphere,
    schema: pointSphereSchema,
    defaultProps: pointSphereDefaults,
    durationInFrames: 75,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "design-reference/library/flex: t12-stat-over-particle-sphere 25.73-28.20 s (short curved strokes, pull-out 0.83 s circ.out, number at +5 f, noun at +14 f)",
      "design-reference/library/flame: flank-words-at-frame-sides 8.05-9.84 s (dotted globe in a thin circle, expo.out pull-out, pink to blue drift, slow turn)",
    ],
    importPath: "src/motion/library/three/PointSphere",
    cues: pointSphereCues,
  }),
  defineItem<PrintingSlipProps>({
    id: "printing-slip",
    category: "three",
    title: "Printing slip",
    description:
      "A paper slip with a torn edge unrolls from a curl on a dark ground while its rows print one after another, the sheet tilting and drifting back under a slow sheen. Use for a list that should feel physical and earned: a receipt, a prize table, an order, a payout. `plate` plays the Blender slip (scripts/blender/printing_slip.py: real paper bend, torn edge, moving light) instead of the three.js sheet.",
    tags: ["receipt", "paper", "slip", "list", "print", "curl", "unroll", "3d", "proof", "rows"],
    component: PrintingSlip,
    schema: printingSlipSchema,
    defaultProps: printingSlipDefaults,
    durationInFrames: 60,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "design-reference/library/polymarket: printing-slip 22.00-23.83 s (curled sheet with a torn edge on black, rows about every 2 f, unroll 0.97 s power3.out, tilts and drifts back with a slow sheen)",
    ],
    importPath: "src/motion/library/three/PrintingSlip",
    cues: printingSlipCues,
  }),
];
