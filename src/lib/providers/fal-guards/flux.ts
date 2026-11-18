import { fail } from "../fal-errors";
import { arrayField, type FalGuard } from "./index";

/** FLUX edit limits this guard enforces; reference profiles are checked against them. */
export const FLUX_EDIT_LIMITS = { minImages: 1 } as const;

export const fluxGuard: FalGuard = {
  id: "flux-2",
  match: (info) => info.family === "flux-2" || info.family === "flux-2-gallery",
  check: (input, _ctx, _warnings, info) => {
    if (
      info.operation === "edit" &&
      info.inputSchema.properties?.image_urls &&
      arrayField(input, "image_urls").length < FLUX_EDIT_LIMITS.minImages
    )
      fail("FLUX edit requires at least one reference image.");
  },
};
