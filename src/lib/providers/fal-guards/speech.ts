import path from "node:path";
import { fail } from "../fal-errors";
import type { FalGuard } from "./index";

/** Description-only limits and override semantics of the verified speech endpoints. */
export const speechGuard: FalGuard = {
  id: "speech",
  phase: "main",
  match: (info) =>
    [
      "fal-ai/elevenlabs/speech-to-text/scribe-v2",
      "fal-ai/wizper",
      "elevenlabs/tts/eleven-v4",
      "fal-ai/qwen-3-tts/text-to-speech/1.7b",
      "nvidia/nemotron-3-nano-omni/audio",
      "resemble-ai/chatterboxhd/speech-to-speech",
    ].includes(info.endpoint),
  check: (input, ctx, warnings, info) => {
    if (info.endpoint === "fal-ai/elevenlabs/speech-to-text/scribe-v2" && Array.isArray(input.keyterms)) {
      if (input.keyterms.some((term) => typeof term === "string" && term.length > 50))
        fail("Scribe keyterms must be at most 50 characters each.");
      if (input.keyterms.length)
        warnings.push("Scribe keyterms add a 30% premium; the base price alone does not bound this request.");
    }
    if (info.endpoint === "nvidia/nemotron-3-nano-omni/audio") {
      const url = String(input.audio_url);
      if ((ctx.media[url]?.durationSec ?? 0) > 50 * 60) fail("Nemotron audio must be at most 50 minutes.");
      const extension = (() => {
        try {
          return path.posix.extname(new URL(url).pathname).slice(1).toLowerCase();
        } catch {
          return undefined;
        }
      })();
      if (
        url.startsWith("data:")
          ? !/^data:audio\/(?:wav|mpeg|mp3);/i.test(url)
          : extension && !["wav", "mp3"].includes(extension)
      )
        fail("Nemotron audio requires wav or mp3.");
      warnings.push("Nemotron requires an English prompt; review prompt language before submitting.");
    }
    if (info.endpoint === "fal-ai/qwen-3-tts/text-to-speech/1.7b" && input.speaker_voice_embedding_file_url) {
      if (input.voice) warnings.push("Speaker embedding overrides the Qwen predefined voice.");
      if (input.prompt) warnings.push("Qwen ignores the style prompt when a speaker embedding is provided.");
    }
    if (info.endpoint === "elevenlabs/tts/eleven-v4" && input.timestamps)
      warnings.push(
        "Timestamp schema is unstructured and described as character timing; only explicitly labelled word rows can supply caption alignment.",
      );
    if (info.endpoint === "resemble-ai/chatterboxhd/speech-to-speech") {
      if (input.target_voice_audio_url && input.target_voice)
        warnings.push("target_voice_audio_url overrides target_voice.");
      if (!input.target_voice_audio_url && !input.target_voice)
        warnings.push("No target voice supplied; provider chooses the target voice.");
    }
  },
};
