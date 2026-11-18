import { defineItem, type LibraryItem } from "../types";
import { GrainGradient, grainGradientSchema } from "./GrainGradient";
import { GridFloor, gridFloorSchema } from "./GridFloor";
import { LightRays, lightRaysSchema } from "./LightRays";
import {
  LiquidLight,
  liquidLightCues,
  liquidLightDefaults,
  liquidLightSchema,
  type LiquidLightProps,
} from "./LiquidLight";
import {
  MaterialFill,
  materialFillCues,
  materialFillDefaults,
  materialFillSchema,
  type MaterialFillProps,
} from "./MaterialFill";
import { MeshGradient, meshGradientSchema } from "./MeshGradient";
import {
  WordBackdrop,
  wordBackdropCues,
  wordBackdropDefaults,
  wordBackdropSchema,
  type WordBackdropProps,
} from "./WordBackdrop";
import { PaperFibre, paperFibreSchema } from "./PaperFibre";
import { SpotlightStudioPreview, spotlightStudioSchema } from "./SpotlightStudio";

const formats: LibraryItem["formats"] = ["landscape", "vertical", "square"];

export const items: LibraryItem[] = [
  defineItem({
    id: "mesh-gradient",
    category: "backgrounds",
    title: "Mesh gradient",
    description:
      "Soft colour fields drifting and overlapping on noise, Stripe-style. Use behind headlines and product cards; blend 'normal' on light grounds, 'screen' on dark. Craft rules ban purple or blue mesh on a dark ground unless the brand owns it; prefer a flat ground or a real medium (paper-fibre).",
    tags: ["gradient", "mesh", "stripe", "blobs", "colourful", "soft", "drift", "ground"],
    component: MeshGradient,
    schema: meshGradientSchema,
    defaultProps: {
      base: "#f6efe6",
      colours: ["#ff7a45", "#ffc65c", "#f25c7a", "#2bb3a0"],
      speed: 0.8,
      size: 0.5,
      blend: "normal",
      grain: 0.07,
      seed: "mesh",
    },
    durationInFrames: 120,
    formats,
    inspiredBy: [
      "stripe.com hero mesh gradient (look only)",
      "magicuidesign/magicui backgrounds (idea only)",
      "src/motion/kinetic-math lightBlobs",
    ],
    importPath: "src/motion/library/backgrounds/MeshGradient",
    cues: () => [],
  }),
  defineItem({
    id: "light-rays",
    category: "backgrounds",
    title: "Volumetric light rays",
    description:
      "God rays fanning from a source above the frame, shimmering. A reveal ground for a keynote title or a product entrance. Dust is off by default (decorative particles are banned); turn it on only for a physical, dusty space.",
    tags: ["light rays", "god rays", "volumetric", "beams", "dust", "keynote", "reveal", "dark"],
    component: LightRays,
    schema: lightRaysSchema,
    defaultProps: {
      ground: "#06070b",
      light: "#e6edf9",
      tint: "#9a93e8",
      sourceX: 0.5,
      sourceY: -0.05,
      rays: 22,
      spread: 27,
      intensity: 0.85,
      dust: 0,
      seed: "beam",
    },
    durationInFrames: 120,
    formats,
    inspiredBy: [
      "crepuscular rays through a high window or forest canopy (observed, look only)",
      "theatre follow-spot haze (look only)",
    ],
    importPath: "src/motion/library/backgrounds/LightRays",
    sparing:
      "God rays are the most common marketplace-template ground and no reference uses them. Justified only for a physical, lit space the film is actually set in (a church, a forest, a stage); never behind a title or a product.",
    cues: () => [],
  }),
  defineItem({
    id: "grid-floor",
    category: "backgrounds",
    title: "Perspective grid floor",
    description:
      "A fine perspective grid gliding towards the camera under a glowing horizon. Tech, infrastructure and 'the platform' moments; put type on the horizon.",
    tags: ["grid", "perspective", "floor", "horizon", "glow", "tech", "linear", "infinite", "dark"],
    component: GridFloor,
    schema: gridFloorSchema,
    defaultProps: {
      sky: "#07080e",
      floor: "#090a12",
      line: "#9098ee",
      glow: "#5f62e0",
      horizon: 0.56,
      speed: 0.9,
      lineOpacity: 0.38,
      glowStrength: 0.85,
      seed: "deck",
    },
    durationInFrames: 120,
    formats,
    inspiredBy: ["linear.app launch films (look only)"],
    importPath: "src/motion/library/backgrounds/GridFloor",
    sparing:
      "A glowing perspective grid is a stock tech-template ground. Justified only when the film is literally about a grid, a floor plan or a retro-synth world; never as a default dark ground.",
    cues: () => [],
  }),
  defineItem({
    id: "grain-gradient",
    category: "backgrounds",
    title: "Grain gradient",
    description:
      "Flowing noise mapped through a colour ramp and finished with heavy grain, the 'grainient' look of modern launch pages. Warm, tactile ground for editorial or brand moments.",
    tags: ["grain", "grainient", "noise", "flow", "gradient map", "tactile", "warm", "editorial"],
    component: GrainGradient,
    schema: grainGradientSchema,
    defaultProps: {
      ramp: ["#140b0b", "#3d1d14", "#8a5a1c", "#d39b2a", "#f5e9cc"],
      scale: 1.2,
      speed: 0.7,
      contrast: 1.25,
      grain: 0.42,
      seed: 23,
    },
    durationInFrames: 120,
    formats,
    inspiredBy: [
      "grainy gradient launch-page grounds, the general 'grainient' look (look only)",
      "gradient-map colour grading as in photo editors (technique)",
    ],
    importPath: "src/motion/library/backgrounds/GrainGradient",
    cues: () => [],
  }),
  defineItem({
    id: "spotlight-studio",
    category: "backgrounds",
    title: "Spotlight studio",
    description:
      "A dark seamless studio sweep with one soft key light, a pool on the floor, a contact shadow (0.55) and a reflection under the product. The hero shot for a single object or device. `tint` lights the sweep in a brand colour instead (pale at the top, deep on the floor) and `pullBack` brings the product back from filling the frame to rest (47% in 14 f).",
    tags: [
      "studio",
      "spotlight",
      "product",
      "hero",
      "reflection",
      "dark",
      "keynote",
      "pedestal",
      "brand colour",
      "sweep",
      "pull-back",
    ],
    component: SpotlightStudioPreview,
    schema: spotlightStudioSchema,
    defaultProps: { ground: "#0b0c10", light: "#e8ecff", floor: 0.68, intensity: 1, seed: "studio", demo: true },
    durationInFrames: 120,
    formats,
    inspiredBy: [
      "Apple keynote product reveals (look only)",
      "design-reference/library/cashfree: screen-pulls-back-to-device 5.40-6.20 s (green sweep #A7E4C0 to #053618, frame to 47% in 0.46 s, power3.out)",
    ],
    importPath: "src/motion/library/backgrounds/SpotlightStudio",
    sparing:
      "A product on a spotlit dark pedestal is a stock keynote trope. Justified only when the object itself is the hero and the brand is dark and premium; prefer the product on a light or brand-colour sweep.",
    cues: () => [],
  }),
  defineItem({
    id: "paper-fibre",
    category: "backgrounds",
    title: "Paper fibre",
    description:
      "A real medium instead of a gradient: paper with long fibres and fine tooth under a soft, slowly drifting window light. Editorial, education and calm brand films; put ink-dark type on it.",
    tags: ["paper", "fibre", "texture", "material", "editorial", "warm", "light ground", "tactile"],
    component: PaperFibre,
    schema: paperFibreSchema,
    defaultProps: { paper: "#efe9df", fibre: "#8a7a64", texture: 0.8, lightX: 0.3, lightY: 0.2, falloff: 0.8, seed: 3 },
    durationInFrames: 90,
    formats,
    inspiredBy: [
      "design-reference/craft-rules.md: worlds made from a real medium",
      "whaleyxbt/claude-motion: grain primitives (idea only)",
    ],
    importPath: "src/motion/library/backgrounds/PaperFibre",
    cues: () => [],
  }),
  defineItem<MaterialFillProps>({
    id: "material-fill",
    category: "backgrounds",
    title: "Material fill",
    description:
      "A real material instead of a gradient: brushed metal (seeded streaks over grey with specular bands sweeping across) or a white embossed relief (a seeded maze in light and shadow strokes). Fills the ground, or a rounded tile that grows from a dot at the centre. Use for a product object made tangible, or a quiet premium ground under a wordmark.",
    tags: ["material", "metal", "brushed", "emboss", "relief", "texture", "tile", "premium", "ground", "white"],
    component: MaterialFill,
    schema: materialFillSchema,
    defaultProps: materialFillDefaults,
    durationInFrames: 60,
    formats,
    inspiredBy: [
      "design-reference/library/flame: guide-frame-opens-to-object 1.54-2.04 s (brushed-metal tile from a centre dot, 6% of the width at F46 to 20% by F56) and implode-and-blur 4.92-5.46 s (embossed white maze ground fades in under the last wisp)",
    ],
    importPath: "src/motion/library/backgrounds/MaterialFill",
    cues: materialFillCues,
  }),
  defineItem<WordBackdropProps>({
    id: "word-backdrop",
    category: "backgrounds",
    title: "Word backdrop",
    description:
      "A held word with one faint, always-moving layer behind it: rings expanding from the centre, a grid of tiles lit at seeded random, the word itself at about 200% in low contrast, or a giant blurred numeral counting down on slowing steps and glowing at zero. Use to keep a one-word frame alive without competing with it.",
    tags: ["word", "backdrop", "rings", "tiles", "ghost type", "countdown", "subtle", "hold", "emphasis", "ground"],
    component: WordBackdrop,
    schema: wordBackdropSchema,
    defaultProps: wordBackdropDefaults,
    durationInFrames: 90,
    formats,
    inspiredBy: [
      "design-reference/library/polymarket: field-backdrops 2.10-2.90, 19.37-22.00, 25.40-27.00, 30.10-31.73 s (rings, tile grid lit at random, ghost of the word; 6-12% contrast, always moving)",
      "design-reference/library/foren: countdown-behind-word 33.67-34.53 s (blurred numeral ~0.6 H steps on frames 0, 2, 4, 7, 11 to zero, glows, holds 13 f)",
    ],
    importPath: "src/motion/library/backgrounds/WordBackdrop",
    cues: wordBackdropCues,
  }),
  defineItem<LiquidLightProps>({
    id: "liquid-light",
    category: "backgrounds",
    title: "Liquid light",
    description:
      "A soft light grows from a frame corner in about half a second: a dark core, a glowing rim that bends like light through liquid glass and fringes into colour at its edge. Use as an accent behind a final word or a reveal on a dark ground, from the corner opposite the type.",
    tags: ["light", "glow", "liquid", "refraction", "corner", "accent", "dark", "reveal", "shader"],
    component: LiquidLight,
    schema: liquidLightSchema,
    defaultProps: liquidLightDefaults,
    durationInFrames: 60,
    formats,
    inspiredBy: [
      "design-reference/library/ugc-app: corner-liquid-light 16.50-17.00 s (blue soft shape with a dark core and refractive rim, grows from the bottom-right corner over ~0.57 s; the file ends while it grows, so the rest is ours)",
      "design-reference/library/nexaa: glow-ground-word-fade-up 25.33-27.38 s (soft blue corner glow on white grows over F612-F619 at 24 fps behind the closing line; no rim)",
    ],
    importPath: "src/motion/library/backgrounds/LiquidLight",
    cues: liquidLightCues,
  }),
];
