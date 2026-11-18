import path from "node:path";
import { fail } from "../fal-errors";
import type { FalGuard } from "./index";

const seed = "fal-ai/bytedance/seed/v2/mini";
const video = "nvidia/nemotron-3-5-super/video";
const vision = "nvidia/nemotron-3-5-super/vision";
const trainer = "blackforestlabs/flux-3/klein/base/trainer";

/** Check declared URL formats without fetching remote media or inferring metadata. */
function format(url: string, extensions: string[], warnings: string[]): void {
  const parsed = new URL(url);
  const extension = path.posix.extname(parsed.pathname).toLowerCase();
  if (parsed.protocol === "data:") {
    const mime = url.slice(5, url.indexOf(";") === -1 ? url.indexOf(",") : url.indexOf(";"));
    const allowed: string[] = extensions.map((ext) =>
      ext === ".jpg" || ext === ".jpeg"
        ? "image/jpeg"
        : ext === ".png"
          ? "image/png"
          : ext === ".webp"
            ? "image/webp"
            : ext === ".mp4"
              ? "video/mp4"
              : ext === ".mov"
                ? "video/quicktime"
                : "application/zip",
    );
    if (!allowed.includes(mime)) fail(`Analysis input requires ${extensions.join("/")} media.`);
  } else if (extension && !extensions.includes(extension))
    fail(`Analysis input requires ${extensions.join("/")} media.`);
  else if (!extension)
    warnings.push(`Media format is unknown for ${url}; verify ${extensions.join("/")} before submission.`);
}

export const analysisGuard: FalGuard = {
  id: "analysis-and-training",
  phase: "main",
  match: (info) => [seed, video, vision, trainer].includes(info.endpoint),
  check: (input, ctx, warnings, info) => {
    if (info.endpoint === seed) {
      const images = input.image_urls as string[] | undefined;
      const videos = input.video_urls as string[] | undefined;
      if ((images?.length ?? 0) > 6 || (videos?.length ?? 0) > 3)
        fail("Seed V2 Mini accepts at most 6 images and 3 videos; extra inputs would be ignored.");
      for (const url of images ?? []) format(url, [".jpg", ".jpeg", ".png", ".webp"], warnings);
      for (const url of videos ?? []) format(url, [".mp4", ".mov"], warnings);
      if (videos?.length) warnings.push("Seed V2 Mini video analysis does not comprehend audio.");
      if (input.thinking === "disabled" && input.reasoning_effort != null)
        fail("reasoning_effort requires thinking enabled or auto.");
    }
    if (info.endpoint === video) {
      const url = input.video_url as string;
      format(url, [".mp4"], warnings);
      const media = ctx.media[url];
      if (media?.durationSec !== undefined && media.durationSec > 120)
        fail("Nemotron video accepts at most 2 minutes.");
      if (
        (media?.width ?? 0) > 3840 ||
        (media?.height ?? 0) > 3840 ||
        (media?.width ?? 0) * (media?.height ?? 0) > 3840 * 2160
      )
        fail("Nemotron video exceeds the 3840 per-side or 3840x2160 pixel limit.");
    }
    if (info.endpoint === vision) {
      format(input.image_url as string, [".jpg", ".jpeg", ".png"], warnings);
      warnings.push("Nemotron vision requires RGB JPEG or PNG; verify the source colour mode.");
    }
    if (info.endpoint === trainer) {
      format(input.images_data_url as string, [".zip"], warnings);
      if (typeof input.trigger_phrase !== "string" || !input.trigger_phrase.trim())
        warnings.push(
          "Training ZIP must provide matching .txt captions for every image when trigger_phrase is empty. Verify PNG/JPG/JPEG/WebP archive contents before submission.",
        );
    }
  },
};
