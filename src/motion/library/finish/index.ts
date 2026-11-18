import { defineItem, type LibraryItem } from "../types";
import { FilmFinishPreview, filmFinishSchema } from "./FilmFinish";
import { FlarePulsePreview, flarePulseSchema } from "./FlarePulse";
import { MotionBlurPreview, motionBlurSchema } from "./MotionBlur";
import {
  CHROMA_EDGE_FRAMES,
  ChromaEdgePreview,
  chromaEdgeCues,
  chromaEdgeDefaults,
  chromaEdgeSchema,
} from "./ChromaEdge";
import { TEXTURE_OVERLAY_FRAMES, TextureOverlayPreview, textureOverlaySchema } from "./TextureOverlay";

export const items: LibraryItem[] = [
  defineItem({
    id: "film-finish",
    category: "finish",
    title: "Film finish",
    description:
      'Wrap a whole film once: by default only a fine frame-seeded grain (0.04), near-invisible, that keeps flat grounds from banding. Vignette, colour fringes, bloom, light leak and drift are opt-in and stock-looking: no reference uses them. Keep Audio and video outside it when aberration is on. `preset` names a finished look: "clean" (grain 0.02, vignette 0.08), "filmic" (grain 0.05, vignette 0.18, slow drift, faint bloom) or "tactile" (grain 0.07, paper texture, vignette 0.12); explicit props override it.',
    tags: [
      "grain",
      "vignette",
      "bloom",
      "chromatic aberration",
      "light leak",
      "camera drift",
      "cinematic",
      "wrapper",
      "polish",
    ],
    component: FilmFinishPreview,
    schema: filmFinishSchema,
    defaultProps: {
      preset: "none",
      grain: 0.04,
      vignette: 0,
      bloom: 0,
      bloomThreshold: 0.7,
      aberration: 0,
      lightLeak: 0,
      lightLeakColour: "#ffb36b",
      drift: 0,
      seed: "finish",
      demo: true,
      headline: "Ship faster.",
    },
    durationInFrames: 120,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "whaleyxbt/claude-motion: grain primitives (idea only)",
      "remotion: packages/light-leaks, packages/noise (idea only)",
      "src/motion/fx.tsx FilmGrain (reused)",
    ],
    importPath: "src/motion/library/finish/FilmFinish",
    usage:
      'import { FilmFinish } from "src/motion/library/finish/FilmFinish"; wrap the whole scene: <FilmFinish>{scene}</FilmFinish>. Defaults are grain 0.04 and nothing else; raise vignette, aberration or bloom only with a reason in the brief. For a whole look pass `preset="clean" | "filmic" | "tactile"` (src/motion/library/finish/presets.ts; explicit props win). Keep <Audio>/<Video> outside.',
    cues: () => [],
  }),
  defineItem({
    id: "flare-pulse",
    category: "finish",
    title: "Anamorphic flare pulse",
    description:
      "An anamorphic lens flare that flashes on beat frames: hot core, long horizontal streak, ghosts across the axis. `angle` tips the streak (a diagonal lens streak), `thickness` blooms it and `intensity` keyframes drive it per frame instead of beats, so it can recede with a subject (`lensStreakPreset(at)`: full on arrival, half 6 frames later, expo.out). Banned by the craft rules unless the brand already uses flares (gaming, sci-fi, music); never as decoration.",
    tags: ["lens flare", "anamorphic", "streak", "glow", "pulse", "beat", "music", "light", "lens streak", "diagonal"],
    component: FlarePulsePreview,
    schema: flarePulseSchema,
    defaultProps: { x: 0.3, y: 0.32, hits: [15, 45, 75], decay: 16, colour: "#7fb2ff", idle: 0.35, streak: 0.9 },
    durationInFrames: 90,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "J.J. Abrams-style anamorphic streaks (look only)",
      "src/motion/kinetic-math hitsDecay (reused)",
      "design-reference/library/nowakdesign glint-square-pull-back 3.93-4.30 s (diagonal streak with bloom on a square receding 22% to 10% of height in about 6 frames, expo.out; the streak fades with it)",
    ],
    importPath: "src/motion/library/finish/FlarePulse",
    usage:
      'import { FlarePulse, lensStreakPreset } from "src/motion/library/finish/FlarePulse"; <FlarePulse x={0.5} y={0.45} colour={token} {...lensStreakPreset(arrival)} /> over the receding subject, or hits={[...]} for beat flashes.',
    sparing:
      "Anamorphic flares are stock After Effects decoration and no reference uses one. Justified only when the brand world already has flares (gaming, sci-fi, music video); then on hero beats only, never as idle glow.",
    cues: (props) => {
      const { hits, intensity = [] } = props as { hits: number[]; intensity?: { at: number; value: number }[] };
      const peak = intensity.reduce<{ at: number; value: number } | undefined>(
        (best, key) => (!best || key.value > best.value ? key : best),
        undefined,
      );
      return intensity.length
        ? peak
          ? [{ frame: peak.at, kind: "hit", sfx: "glass", weight: "support", label: "streak peak" }]
          : []
        : hits.map((frame) => ({ frame, kind: "hit", sfx: "impact", weight: "support", label: "flare flash" }));
    },
  }),
  defineItem({
    id: "motion-blur",
    category: "finish",
    title: "Motion blur",
    description:
      "Directional smear for fast moves, peak held to the craft rules (10 px text, 18 px full frame) and only along the move. 'velocity' mode is one cheap pass; 'shutter' mode is true sub-frame blur from @remotion/motion-blur. Pass the shot's flat ground as `ground` (or `opaque` when the children paint one): shutter samples are then averaged exactly, so an opaque ground keeps its colour on blurred frames.",
    tags: ["motion blur", "whip", "smear", "shutter", "fast move", "speed"],
    component: MotionBlurPreview,
    schema: motionBlurSchema,
    defaultProps: { text: "Ship faster", peak: 10, background: "#f4f3ef", ink: "#111111" },
    durationInFrames: 75,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "remotion: packages/motion-blur (CameraMotionBlur, via src/motion/fx Shutter)",
      "design-reference/craft-rules.md: motion blur peaks",
    ],
    importPath: "src/motion/library/finish/MotionBlur",
    cues: () => [
      { frame: 6, kind: "reveal", sfx: "whoosh", weight: "support", label: "enters at full smear" },
      { frame: 20, kind: "land", weight: "hero" },
      { frame: 58, kind: "exit", sfx: "whoosh", weight: "support" },
    ],
  }),
  defineItem({
    id: "texture-overlay",
    category: "finish",
    title: "Texture overlay",
    description:
      "A material over the whole frame, drawn procedurally per frame with no image files: paper fibre and tooth, an offset halftone dot screen with uneven ink, or CRT scan lines with a slow rolling band. Use it when the film is about print, paper, collage or a screen, at low opacity; FilmFinish's tactile preset adds the paper one.",
    tags: [
      "texture",
      "paper",
      "halftone",
      "print",
      "scan lines",
      "crt",
      "tactile",
      "material",
      "overlay",
      "zine",
      "editorial",
    ],
    component: TextureOverlayPreview,
    schema: textureOverlaySchema,
    defaultProps: {
      kind: "paper",
      opacity: 0.4,
      blendMode: "multiply",
      scale: 1,
      cadence: 0,
      ink: "",
      seed: "texture",
      cycle: true,
    },
    durationInFrames: TEXTURE_OVERLAY_FRAMES,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "src/motion/library/backgrounds/PaperFibre (fibre filter reused)",
      "offset print halftone and CRT scan lines (common practice, idea only)",
    ],
    importPath: "src/motion/library/finish/TextureOverlay",
    usage:
      'import { TextureOverlay } from "src/motion/library/finish/TextureOverlay"; put <TextureOverlay kind="halftone" opacity={0.22} /> above the scene, or <FilmFinish texture="paper" textureOpacity={0.4}> / preset="tactile". Paper stays still (cadence 0); cadence 2 boils it on film time.',
    cues: () => [],
  }),
  defineItem({
    id: "chroma-edge",
    category: "finish",
    title: "Chroma edge split",
    description:
      "A subtle red/blue split on the frame's edges that flares on hits (or with the speed of a whip) and decays to clean within a few frames; the centre stays sharp. For an impact or a signal glitch that has a story reason, not as a look.",
    tags: ["chromatic aberration", "rgb split", "glitch", "hit", "impact", "edge", "velocity", "fringe"],
    component: ChromaEdgePreview,
    schema: chromaEdgeSchema,
    defaultProps: chromaEdgeDefaults,
    durationInFrames: CHROMA_EDGE_FRAMES,
    formats: ["landscape", "vertical", "square"],
    inspiredBy: [
      "src/motion/library/finish/FilmFinish aberration filter (reused)",
      "src/motion/kinetic-math hitsDecay (reused)",
    ],
    importPath: "src/motion/library/finish/ChromaEdge",
    usage:
      'import { ChromaEdge, chromaOffset } from "src/motion/library/finish/ChromaEdge"; <ChromaEdge hits={[hit]} peak={6}>{scene}</ChromaEdge>, or velocity={velocity(track, frame)} on a whip. Renders the children twice: keep <Audio>/<Video> outside.',
    sparing:
      "RGB split is a stock glitch device. Justified on a real impact, a signal or broken-screen story beat, or a whip it rides on, at 4 to 9 px and gone at rest; never idle on every shot.",
    cues: (props) => chromaEdgeCues(props as Parameters<typeof chromaEdgeCues>[0]),
  }),
];
