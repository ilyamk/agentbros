import { fail } from "../fal-errors";
import { arrayField, type FalGuard } from "./index";

/** Nano Banana 2.1 edit limits this guard enforces; reference profiles are checked against them. */
export const NANO_EDIT_LIMITS = { images: 14, inlineContextMaxBytes: 15 * 1024 * 1024 } as const;

export const nanoGuard: FalGuard = {
  id: "nano-banana-2.1",
  match: (info) => info.family === "nano-banana-2.1",
  check: (input, ctx, _warnings, info) => {
    if (info.operation !== "edit") return;
    if (!arrayField(input, "image_urls").length && !input.video_url && !input.pdf_url)
      fail("Nano edit requires image, video or PDF context.");
    if (arrayField(input, "image_urls").length > NANO_EDIT_LIMITS.images)
      fail("Nano edit supports up to 14 reference images.");
    for (const key of ["video_url", "pdf_url"])
      if (
        typeof input[key] === "string" &&
        (ctx.media[input[key] as string]?.bytes ?? 0) > NANO_EDIT_LIMITS.inlineContextMaxBytes
      )
        fail("Nano inline video/PDF context is limited to 15 MB.");
  },
};
