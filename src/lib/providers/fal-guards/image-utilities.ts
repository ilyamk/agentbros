import { fail } from "../fal-errors";
import type { FalGuard } from "./index";

export const imageUtilitiesGuard: FalGuard = {
  id: "image-utilities",
  phase: "main",
  match: (info) => info.endpoint === "fal-ai/birefnet/v2",
  check: (input) => {
    if (input.operating_resolution === "2304x2304" && input.model !== "General Use (Dynamic)") {
      fail("BiRefNet v2: 2304x2304 requires the General Use (Dynamic) model.");
    }
  },
};
