import { z } from "zod";
import { HtmlTimingSchema, flattenHtmlTiming } from "./html-timing";
export const HtmlCaptureSchema = z
  .object({
    timing: HtmlTimingSchema.optional(),
    playerRuntime: z
      .object({
        runtimeAsset: z.string().min(1),
        gsapAsset: z.string().min(1),
        mediaProfile: z.literal("native-local-media-v1").optional(),
        compositionProfile: z
          .enum(["static-local-tree-v1", "static-local-instances-v1", "static-local-instances-v2"])
          .optional(),
        normalization: z.literal("decoded-source-proxy-v1").optional(),
      })
      .strict()
      .optional(),
    encode: z.enum(["png", "mp4"]).default("png"),
    protocol: z
      .enum(["avc-frame", "hyperframes-seek", "hyperframes-frame-adapter", "hyperframes-player"])
      .default("avc-frame"),
    htmlFile: z.string().min(1),
    assetRoot: z.string().min(1),
    assets: z
      .array(z.string().min(1))
      .max(128)
      .default([])
      .refine((v) => new Set(v).size === v.length, "Duplicate asset paths"),
    width: z.number().int().min(16).max(1920),
    height: z.number().int().min(16).max(1920),
    fps: z.number().int().min(1).max(60).default(30),
    frames: z
      .array(z.number().int().min(0).max(36000))
      .min(1)
      .max(100)
      .refine((v) => new Set(v).size === v.length, "Duplicate frames"),
    timeoutMs: z.number().int().min(1000).max(120000).default(30000),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.protocol === "hyperframes-player") {
      if (
        !v.playerRuntime ||
        !v.assets.includes(v.playerRuntime.runtimeAsset) ||
        !v.assets.includes(v.playerRuntime.gsapAsset)
      )
        ctx.addIssue({
          code: "custom",
          message: "Full player requires explicit allowlisted pinned runtime and GSAP snapshots",
        });
      if (v.playerRuntime?.compositionProfile && !v.playerRuntime.mediaProfile)
        ctx.addIssue({ code: "custom", message: "Static tree requires explicit native local media profile" });
      if (v.playerRuntime?.normalization && !v.playerRuntime.mediaProfile)
        ctx.addIssue({ code: "custom", message: "Normalization requires explicit native media profile" });
      if (v.timing) ctx.addIssue({ code: "custom", message: "AVC timing cannot mix with native player semantics" });
    } else if (v.playerRuntime)
      ctx.addIssue({ code: "custom", message: "playerRuntime requires hyperframes-player protocol" });
    if (v.timing) {
      try {
        flattenHtmlTiming(v.timing, v.fps);
      } catch (e) {
        ctx.addIssue({ code: "custom", message: String(e) });
      }
      if (v.timing.nodes.some((n) => n.audioAsset) && v.encode !== "mp4")
        ctx.addIssue({ code: "custom", message: "Audio timing requires MP4" });
      if (v.timing.nodes.some((n) => n.audioAsset && !v.assets.includes(n.audioAsset)))
        ctx.addIssue({ code: "custom", message: "Audio must be allowlisted" });
    }
    if (v.encode === "mp4" && (v.frames.some((f, i) => f !== i) || v.width % 2 || v.height % 2))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "MP4 requires even dimensions and complete ordered frames 0..N-1",
      });
  });
export type HtmlCaptureRequest = z.infer<typeof HtmlCaptureSchema>;
export type HtmlWorkerRequest = HtmlCaptureRequest & {
  directory: string;
  ownershipToken: string;
  assetMap: Record<string, { path: string; sha256: string; mime: string }>;
  html: string;
};

/** Explicit standalone bridge matching upstream FrameAdapter; not __player runtime. */
export interface HtmlFrameAdapter {
  id: string;
  init?: (context: {
    compositionId: string;
    fps: number;
    width: number;
    height: number;
    rootElement?: HTMLElement;
  }) => Promise<void> | void;
  getDurationFrames: () => number;
  seekFrame: (frame: number) => Promise<void> | void;
  destroy?: () => Promise<void> | void;
}
