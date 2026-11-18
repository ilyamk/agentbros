import { fail, isObject } from "../fal-errors";
import type { FalGuard } from "./index";

export const syncLipsyncV3Guard: FalGuard = {
  id: "sync-lipsync-v3",
  phase: "main",
  match: (info) => info.endpoint === "fal-ai/sync-lipsync/v3",
  check: (input) => {
    if (!isObject(input.options)) return;
    const options = input.options;
    if (typeof options.sync_mode === "string") input.sync_mode = options.sync_mode;
    const speaker = options.active_speaker_detection;
    if (!isObject(speaker)) return;
    const hasCoordinates = speaker.coordinates != null;
    const hasFrame = speaker.frame_number != null;
    if (hasCoordinates !== hasFrame)
      fail("Sync v3: manual speaker coordinates and frame_number must be supplied together.");
    if (
      Array.isArray(speaker.bounding_boxes) &&
      speaker.bounding_boxes.some((box) => box !== null && (!Array.isArray(box) || box.length !== 4))
    ) {
      fail("Sync v3: each non-null bounding box must contain [x1, y1, x2, y2].");
    }
  },
};
