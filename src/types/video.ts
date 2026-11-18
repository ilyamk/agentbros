import { z } from "zod";
import { ChartQuantitySchema, ChartPointValueBindingSchema } from "./chart-quantity";
import { TemplateInstanceSchema } from "./templates";
import { zColor } from "@remotion/zod-types";

// --- Format configs ---

/** 9:16 vertical (Reels / Shorts / TikTok) */
export const VERTICAL_CONFIG = {
  width: 1080,
  height: 1920,
  fps: 30,
} as const;

/** 1:1 square (Feed posts) */
export const SQUARE_CONFIG = {
  width: 1080,
  height: 1080,
  fps: 30,
} as const;

/** 16:9 landscape (YouTube, talking-head split-screen) */
export const LANDSCAPE_CONFIG = {
  width: 1920,
  height: 1080,
  fps: 30,
} as const;

export type VideoFormat = "vertical" | "square" | "landscape";

export const FORMAT_CONFIGS: Record<
  VideoFormat,
  { width: number; height: number; fps: number; maxDurationSec: number }
> = {
  vertical: { ...VERTICAL_CONFIG, maxDurationSec: 60 },
  square: { ...SQUARE_CONFIG, maxDurationSec: 60 },
  landscape: { ...LANDSCAPE_CONFIG, maxDurationSec: 60 },
};

// --- Talking-head split-screen schema ---

export const TalkingHeadConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Path under public/ to the presenter video, e.g. "projects/X/talking-head/full.mp4" */
  presenterVideo: z.string(),
  /** Peach border colour around the presenter panel */
  borderColor: z.string().default("#F4B89C"),
  borderRadius: z.number().default(28),
  /** Gap in px between the left visual panel and the right presenter panel */
  panelGap: z.number().default(24),
  outerPadding: z.number().default(40),
  /** Right panel width as a fraction of total canvas width (0.2–0.5) */
  rightPanelWidthFraction: z.number().min(0.2).max(0.5).default(0.32),
  /**
   * Where the presenter's voice comes from:
   *   "elevenlabs" — per-scene MP3s in voiceover/{sceneId}.mp3 (default)
   *   "embedded"   — audio is baked into presenterVideo (Seedance native audio)
   *
   * When `embedded`, the talking-head Remotion composition does not mount the
   * per-scene `<Audio>` layer and does not mute the presenter `<Video>`.
   *
   * Mutual exclusion: when `embedded`, voice-producer skips ElevenLabs TTS
   * for every presenter beat. Layering an additional voiceover on top of a
   * Seedance-generated audio track is always a bug.
   */
  audioSource: z.enum(["elevenlabs", "embedded"]).default("elevenlabs"),
  /**
   * Project-wide canvas mood for the LEFT panel. Every left-panel kind
   * renders against this base — eliminates the scene-to-scene flicker that
   * happens when a dark aiImage cuts to a white-canvas chart.
   *   "light" — off-white (#F8F8F4) base; sketches/charts in dark accent
   *   "dark"  — near-black (#0E1116) base; sketches/charts in light accent
   *
   * Set once by design-director from `design.palette.mood`. Storyboarder
   * may NOT change it scene-to-scene.
   */
  leftPanelCanvas: z.enum(["light", "dark"]).default("light"),
  /**
   * Per-format `objectPosition` for the presenter <Video> cover-crop.
   *
   * 9:16 source presenter footage (Seedance / recorded) typically frames
   * the face in the upper third of the frame. When that source is
   * squeezed into a 1:1 vertical-layout panel, a default `center center`
   * cover crop trims the hairline. These overrides bias the crop:
   *
   *   - vertical / square: default `"50% 30%"` (face-aware bias upward)
   *   - landscape:         default `"50% 50%"` (centred — full source aspect)
   *
   * Override per-project from design-director when the source frames
   * differently. The TalkingHeadVideo component reads this and applies
   * the appropriate value based on the current canvas dimensions.
   */
  presenterCrop: z
    .object({
      vertical: z.string().optional(),
      square: z.string().optional(),
      landscape: z.string().optional(),
    })
    .optional(),
  captionStyle: z
    .object({
      activeColor: z.string().default("#FFE600"),
      inactiveColor: z.string().default("#FFFFFF"),
      strokeColor: z.string().default("#000000"),
      strokeWidth: z.number().default(8),
      fontSize: z.number().default(56),
      wordsInView: z.number().default(3),
    })
    .default({
      activeColor: "#FFE600",
      inactiveColor: "#FFFFFF",
      strokeColor: "#000000",
      strokeWidth: 8,
      fontSize: 56,
      wordsInView: 3,
    }),
});

export type TalkingHeadConfig = z.infer<typeof TalkingHeadConfigSchema>;

// --- Left panel (visual panel) schemas ---

export const LeftPanelKindSchema = z.enum([
  "chart",
  "sketch",
  "screenshot",
  "tweet",
  "meme",
  "aiImage",
  "archival",
  "text",
]);

export type LeftPanelKind = z.infer<typeof LeftPanelKindSchema>;

/** Opt-in chart semantics; legacy labels remain freeform and unverified. */
export const ChartYearDomainSchema = z
  .object({
    kind: z.literal("year-v1"),
    year: z.number().int().min(1).max(9999),
  })
  .strict();
export const ChartDomainLabelBindingSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("domain-label-v1"),
    expectedDomain: ChartYearDomainSchema,
  })
  .strict();
const ChartPointSchema = z.object({
  label: z.string().optional(),
  value: z.number(),
  domain: ChartYearDomainSchema.optional(),
});

export const LeftPanelSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("chart"),
    caption: z.string().optional(),
    entrance: z.enum(["fade", "scale", "clip"]).default("fade"),
    chartType: z.enum(["line", "area", "bar"]).default("line"),
    /** Optional chart title shown above the plot — keep ≤ 6 words */
    title: z.string().optional(),
    /** Optional unit label appended after axis values (e.g. "%", "$") */
    yUnit: z.string().optional(),
    /** Explicit measurement for single-data shorthand; ignored when nonempty series wins. */
    quantity: ChartQuantitySchema.optional(),
    /** Optional y-axis title (vertical, left side) */
    yAxisLabel: z.string().optional(),
    /** Optional x-axis title (centred, below) */
    xAxisLabel: z.string().optional(),
    /**
     * Single-series shorthand. Either provide `data` (single series) or `series` (multi-series).
     * `series` takes precedence when both are set.
     */
    data: z.array(ChartPointSchema).optional(),
    /** Multi-series chart — first series is the "hero" line drawn in `color`, rest are dimmed. */
    series: z
      .array(
        z.object({
          label: z.string(),
          /** Per-series colour. If omitted, the hero series uses `color`, others get muted greys. */
          color: z.string().optional(),
          /** Mark this as the hero series for callout / accent treatment. Default false except first series. */
          isHero: z.boolean().optional(),
          data: z.array(ChartPointSchema),
          quantity: ChartQuantitySchema.optional(),
        }),
      )
      .optional(),
    /** Hero callout — large emphasised number revealed at the chart's climax. */
    callout: z
      .object({
        /** Big number to display (e.g. "+95%", "8×", "−40%") */
        value: z.string(),
        /** Optional supporting label below the number */
        label: z.string().optional(),
        /** Index in the hero series whose data point the callout anchors to. Defaults to last point. */
        anchorIndex: z.number().int().optional(),
        binding: ChartPointValueBindingSchema.optional(),
      })
      .optional(),
    /** Annotations on specific data points — vertical labels with leader lines */
    annotations: z
      .array(
        z.object({
          /** Series index (default 0, independent of isHero) */
          seriesIndex: z.number().int().default(0).optional(),
          dataIndex: z.number().int(),
          text: z.string(),
          binding: ChartDomainLabelBindingSchema.optional(),
        }),
      )
      .optional(),
    /** Hero series colour (also single-series fallback). Default: design accent. */
    color: z.string().default("#F7931A"),
    /** Optional x-axis labels — overrides series.data[].label when present. */
    axisLabels: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("sketch"),
    caption: z.string().optional(),
    entrance: z.enum(["fade", "scale", "clip"]).default("fade"),
    /** Normalised 0–1 coordinates for each point of the drawn path */
    points: z.array(z.tuple([z.number(), z.number()])),
    color: z.string().default("#7A1B1B"),
    jitter: z.number().default(2),
  }),
  z.object({
    kind: z.literal("screenshot"),
    caption: z.string().optional(),
    entrance: z.enum(["fade", "scale", "clip"]).default("fade"),
    imageUrl: z.string(),
    kenBurns: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("tweet"),
    caption: z.string().optional(),
    entrance: z.enum(["fade", "scale", "clip"]).default("fade"),
    author: z.string(),
    handle: z.string(),
    avatarUrl: z.string().optional(),
    text: z.string(),
    verified: z.boolean().default(false),
    darkMode: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("meme"),
    caption: z.string().optional(),
    entrance: z.enum(["fade", "scale", "clip"]).default("fade"),
    imageUrl: z.string(),
    bounce: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("aiImage"),
    caption: z.string().optional(),
    entrance: z.enum(["fade", "scale", "clip"]).default("fade"),
    imageUrl: z.string(),
    kenBurns: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("archival"),
    caption: z.string().optional(),
    entrance: z.enum(["fade", "scale", "clip"]).default("fade"),
    videoUrl: z.string(),
    /** Start offset in seconds into the source video */
    startFrom: z.number().default(0),
  }),
  z.object({
    kind: z.literal("text"),
    caption: z.string().optional(),
    entrance: z.enum(["fade", "scale", "clip"]).default("fade"),
    text: z.string(),
    align: z.enum(["left", "center", "right"]).default("center"),
    size: z.enum(["headline", "bigTitle", "hero"]).default("bigTitle"),
  }),
]);

export type LeftPanel = z.infer<typeof LeftPanelSchema>;

// --- Scene schema ---

export const SceneSchema = z.object({
  id: z.string(),
  text: z.string(), // Voiceover text for TTS
  visualType: z.enum(["title", "feature", "testimonial", "cta", "product", "showcase", "video", "photo"]),
  headline: z.string().optional(),
  subtext: z.string().optional(),
  imageUrl: z.string().optional(),
  template: TemplateInstanceSchema.optional(),
  durationInFrames: z.number().int().positive().optional(),
  /** Left visual panel for talking-head split-screen layout (landscape format) */
  leftPanel: LeftPanelSchema.optional(),
  /** Start offset in seconds into the presenter video for this scene */
  presenterStartSec: z.number().nonnegative().optional(),
  /** End offset in seconds into the presenter video for this scene */
  presenterEndSec: z.number().nonnegative().optional(),
  /**
   * Transition to the NEXT scene. Default is `fade` (12-frame crossfade
   * via `<TransitionSeries>`). `cut` produces a hard cut (no transition).
   * `crossfade` is an alias for `fade`.
   */
  transitionToNext: z.enum(["fade", "cut", "crossfade"]).optional(),
  /** Override the default 12-frame transition duration. */
  transitionDurationFrames: z.number().int().positive().optional(),
});

export type Scene = z.infer<typeof SceneSchema>;

// --- Video props schema ---

export const VideoSchema = z.object({
  projectId: z.string(),
  format: z.enum(["vertical", "square", "landscape"]),
  productName: z.string(),
  tagline: z.string(),
  accentColor: zColor(),
  bgColor: zColor(),
  textColor: zColor(),
  scenes: z.array(SceneSchema),
  voiceoverEnabled: z.boolean(),
  musicVolume: z.number().min(0).max(1),
});

export type VideoProps = z.infer<typeof VideoSchema>;

// --- TalkingHead composition props schema ---

/** VideoSchema extended with the required talkingHead config block */
export const TalkingHeadCompositionSchema = VideoSchema.extend({
  talkingHead: TalkingHeadConfigSchema,
});

export type TalkingHeadCompositionSchemaType = z.infer<typeof TalkingHeadCompositionSchema>;

// --- Project config schema (project.json) ---

export const ProjectConfigSchema = z.object({
  name: z.string(),
  formats: z.array(z.enum(["vertical", "square", "landscape"])).default(["vertical", "square"]),
  productName: z.string(),
  tagline: z.string().default(""),
  colors: z.object({
    accent: z.string().default("#6C5CE7"),
    background: z.string().default("#0F0F0F"),
    text: z.string().default("#FFFFFF"),
  }),
  voice: z.string().default("rachel"),
  musicPrompt: z.string().default("Modern upbeat electronic background music, energetic and positive, 30 seconds"),
  musicVolume: z.number().min(0).max(1).default(0.15),
  scenes: z.array(SceneSchema),
  /** Talking-head split-screen configuration (landscape format only) */
  talkingHead: TalkingHeadConfigSchema.optional(),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

// --- Default scenes (used for demo project) ---

export const DEFAULT_SCENES: Scene[] = [
  {
    id: "hook",
    text: "Are you tired of spending hours creating social media content?",
    visualType: "title",
    headline: "Stop Wasting Time",
    subtext: "There's a better way",
  },
  {
    id: "problem",
    text: "Creating professional videos for every platform is expensive and time-consuming.",
    visualType: "feature",
    headline: "The Problem",
    subtext: "Manual video creation doesn't scale",
  },
  {
    id: "solution",
    text: "Introducing our Agent Bros. Pictures. Generate stunning vertical videos in seconds.",
    visualType: "product",
    headline: "Agent Bros. Pictures",
    subtext: "One click. Every platform.",
  },
  {
    id: "features",
    text: "AI voiceovers, background music, smooth animations, and automatic formatting for every platform.",
    visualType: "feature",
    headline: "Powered by AI",
    subtext: "ElevenLabs voice • Smart layouts • Auto-export",
  },
  {
    id: "cta",
    text: "Start creating professional videos today. Try it free.",
    visualType: "cta",
    headline: "Get Started Free",
    subtext: "No credit card required",
  },
];
