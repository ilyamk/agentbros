import { FAL_MUSIC_MODELS } from "../fal-music";
import { fail } from "../fal-errors";
import type { FalGuard } from "./index";

/** Cross-field capabilities documented by the endpoint schemas; CLI policy stays in its builder. */
export const musicGuard: FalGuard = {
  id: "music",
  phase: "main",
  match: ({ endpoint }) => Object.hasOwn(FAL_MUSIC_MODELS, endpoint),
  check(input, _ctx, _warnings, { endpoint }) {
    if (endpoint === "fal-ai/elevenlabs/music") {
      const prompt = typeof input.prompt === "string" && input.prompt.length > 0;
      if (!prompt && (input.music_length_ms != null || input.force_instrumental === true))
        fail("music_length_ms and force_instrumental can only be used with prompt.");
    }
    if (
      endpoint === "fal-ai/minimax-music/v2.6" &&
      input.is_instrumental !== true &&
      input.lyrics_optimizer !== true &&
      !(typeof input.lyrics === "string" && input.lyrics.trim())
    )
      fail("Lyrics are required when is_instrumental is false unless lyrics_optimizer generates them.");
  },
};
