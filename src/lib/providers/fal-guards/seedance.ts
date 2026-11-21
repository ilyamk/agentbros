import { FalOperationError, fail } from "../fal-errors";
import { arrayField, type FalGuard } from "./index";

const MIB = 1024 * 1024;
/** Seedance 2.5 reference-to-video limits this guard enforces; reference profiles are checked against them. */
export const SEEDANCE_25_REFERENCE_LIMITS = {
  images: 30,
  videos: 10,
  audio: 10,
  total: 50,
  imageMaxBytes: 30 * MIB,
  videoMaxBytes: 200 * MIB,
  audioMaxBytes: 15 * MIB,
  minDurationSec: 1.8,
  maxDurationSec: 30.2,
  combinedMaxDurationSec: 30.2,
  videoMinEdge: 300,
  videoMaxEdge: 6000,
  videoFps: [24, 60],
  videoAspect: [0.4, 2.5],
} as const;
const L = SEEDANCE_25_REFERENCE_LIMITS;
/** Drafts can be completed for 14 days by their original caller (fal schemas of 2026-11-21). */
export const SEEDANCE_25_DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export const seedanceGuard: FalGuard = {
  id: "seedance-2.5",
  match: (info) => info.family === "seedance-2.5",
  check: (input, ctx, warnings, info) => {
    if (info.operation === "complete") {
      if (!ctx.draft || !ctx.callerId) fail("Draft completion requires original caller and creation metadata.");
      if (ctx.draft.id !== input.draft_id || ctx.draft.callerId !== ctx.callerId)
        fail("Draft completion requires its original caller and matching draft ID.");
      const age = Date.parse(ctx.now ?? new Date().toISOString()) - Date.parse(ctx.draft.createdAt);
      if (age < 0 || age >= SEEDANCE_25_DRAFT_TTL_MS)
        throw new FalOperationError("DRAFT_EXPIRED", "Seedance draft completion must occur within 14 days.");
    }
    // Publication and inspection are proven for MP4 only; the 2026-11-21 schemas also offer MOV.
    if (input.output_format !== undefined && input.output_format !== "mp4")
      fail("Seedance output_format must be mp4; MOV output is not yet supported by publication.");
    // "auto" lets the model pick reference, editing or extension, so the billed mode is unknown before submit.
    if (input.task === "auto") fail("Seedance task must be explicit (reference, editing or extension), not auto.");
    if (input.draft === true) {
      // US endpoints accept drafts since 2026-11-21, but only the global completion endpoint is routed here.
      if (info.endpoint.includes("/us/")) fail("Seedance drafts are supported on the global endpoints only.");
      input.resolution = "480p";
      warnings.push("Draft resolution normalized to 480p; completion requires its original caller within 14 days.");
    }
    if (info.operation === "reference-to-video") {
      const images = arrayField(input, "image_urls"),
        videos = arrayField(input, "video_urls"),
        audio = arrayField(input, "audio_urls");
      if (
        images.length > L.images ||
        videos.length > L.videos ||
        audio.length > L.audio ||
        images.length + videos.length + audio.length > L.total
      )
        fail("Seedance reference count exceeds modality/total limits.");
      if (!images.length && !videos.length && !audio.length) fail("Reference-to-video requires reference media.");
      if (["editing", "extension"].includes(String(input.task)) && !videos.length)
        fail("Editing/extension requires a reference video.");
      if (["editing", "extension"].includes(String(input.task))) input.aspect_ratio = "auto";
      if (input.task === "editing") input.duration = "auto";
      for (const [urls, maxBytes, kind] of [
        [images, L.imageMaxBytes, "image"],
        [videos, L.videoMaxBytes, "video"],
        [audio, L.audioMaxBytes, "audio"],
      ] as const) {
        let durationSum = 0;
        for (const url of urls) {
          const media = ctx.media[String(url)];
          if (!media) continue;
          if (media.bytes !== undefined && media.bytes > maxBytes)
            fail(`Seedance ${kind} reference exceeds size limit.`);
          if (kind !== "image" && media.durationSec !== undefined) {
            if (media.durationSec < L.minDurationSec || media.durationSec > L.maxDurationSec)
              fail("Seedance reference duration must be 1.8–30.2 seconds.");
            durationSum += media.durationSec;
          }
          if (kind === "video") {
            if (
              (media.width && (media.width < L.videoMinEdge || media.width > L.videoMaxEdge)) ||
              (media.height && (media.height < L.videoMinEdge || media.height > L.videoMaxEdge)) ||
              (media.fps && (media.fps < L.videoFps[0] || media.fps > L.videoFps[1]))
            )
              fail("Seedance reference dimensions/FPS exceed bounds.");
            if (
              media.width &&
              media.height &&
              (media.width / media.height < L.videoAspect[0] || media.width / media.height > L.videoAspect[1])
            )
              fail("Seedance reference aspect ratio exceeds bounds.");
          }
        }
        if (durationSum > L.combinedMaxDurationSec + 1e-8)
          fail(`Seedance combined ${kind} duration exceeds 30.2 seconds.`);
      }
    }
  },
};
