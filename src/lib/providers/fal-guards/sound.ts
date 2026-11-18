import { fail } from "../fal-errors";
import type { FalGuard } from "./index";

/** Sound-only routes; music has a separate allow-list and guard. */
export const FAL_SFX_ENDPOINTS = {
  "elevenlabs/sound-effects/v3": { promptField: "text", durationField: "duration_seconds", video: false },
  "fal-ai/stable-audio-3/small/sfx/text-to-audio": { promptField: "prompt", durationField: "duration", video: false },
  "mirelo-ai/sfx2.0/video-to-audio": { promptField: "text_prompt", durationField: "duration", video: true },
} as const;

export const soundGuard: FalGuard = {
  id: "sound",
  phase: "main",
  match: ({ endpoint }) =>
    Object.hasOwn(FAL_SFX_ENDPOINTS, endpoint) ||
    ["fal-ai/demucs", "fal-ai/deepfilternet3", "fal-ai/elevenlabs/voice-changer"].includes(endpoint),
  check(input, ctx, _warnings, { endpoint }) {
    if (endpoint === "mirelo-ai/sfx2.0/video-to-audio") {
      const video = String(input.video_url);
      if (video.startsWith("data:")) {
        if (!/^data:video\/[\w.+-]+;base64,[A-Za-z0-9+/]*={0,2}$/.test(video))
          fail("Foley input must be a base64 video data URI.");
        if (Buffer.byteLength(video.slice(video.indexOf(",") + 1), "base64") > 8 * 1024 * 1024)
          fail("Mirelo inline video exceeds 8 MB.");
      }
      if ((ctx.media[video]?.durationSec ?? 1) < 1) fail("Mirelo input video must be at least 1 second.");
      const bitrate = input.upload_audio_bitrate_kbps;
      const format = input.upload_audio_format ?? "wav";
      if (bitrate != null) {
        if (format === "wav" || format === "flac") fail("Mirelo bitrate is refused for lossless output.");
        if (format === "aac" && Number(bitrate) > 256) fail("Mirelo AAC bitrate must not exceed 256 kbps.");
        if (
          format === "mp3" &&
          ![32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320].includes(Number(bitrate))
        )
          fail("Mirelo MP3 bitrate must be a supported constant rate.");
      }
    }
    if (endpoint === "fal-ai/demucs" && (input.model ?? "htdemucs_6s") !== "htdemucs_6s") {
      if (Array.isArray(input.stems) && input.stems.some((stem) => stem === "guitar" || stem === "piano"))
        fail("Guitar and piano stems require htdemucs_6s.");
    }
    if (
      endpoint === "fal-ai/elevenlabs/voice-changer" &&
      input.model_id === "eleven_english_sts_v2" &&
      ctx.speechLanguage &&
      !/^en(?:-|$)/i.test(ctx.speechLanguage)
    )
      fail("English voice changer supports English only; use the multilingual model for other languages.");
  },
};
