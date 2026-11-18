export const BATCH_SPEECH_MODELS = ["eleven_multilingual_v2", "eleven_v3", "eleven_v4", "eleven_flash_v2_5"] as const;
export const DIALOGUE_MODELS = ["eleven_v3", "eleven_v4"] as const;
export const STS_MODELS = ["eleven_multilingual_sts_v2", "eleven_english_sts_v2"] as const;
export const SPEECH_OUTPUTS = ["mp3_44100_128", "mp3_44100_192", "wav_44100"] as const;
export const MAX_DIALOGUE_CHARACTERS = 2_000;
export const MAX_DIALOGUE_VOICES = 10;
export const MAX_VOICE_CHANGE_SECONDS = 300;

const standard = ["stability", "similarity_boost", "style", "speed", "use_speaker_boost"] as const;
const expressive = ["stability", "similarity_boost", "clone_strength"] as const;
const languagesV2 = "en ja zh de hi fr ko pt it es id nl tr fil pl sv bg ro ar cs el fi hr ms sk da ta uk ru".split(
  " ",
);
const languagesV4 =
  "af am ar hy as ast az be bn bs bg my yue ca ceb hr cs da nl en et fil fi fr ff gl ka de el gu ha he hi hu is id it ja jv kam kn kk ko ky lo lv ln lt lg lb mk ms ml mt zh mi mr mn ne no oc or ps fa pl pt pa ro ru sr sn sd sk sl so ckb es sw sv tg ta te th tr uk ur uz vi cy wo zu".split(
    " ",
  );

export const BATCH_SPEECH_PROFILES = {
  eleven_multilingual_v2: {
    limit: 10_000,
    settings: standard,
    audioTags: false,
    continuity: true,
    languages: languagesV2,
  },
  eleven_v3: { limit: 5_000, settings: standard, audioTags: true, continuity: false, languages: null },
  eleven_v4: { limit: 10_000, settings: expressive, audioTags: true, continuity: true, languages: languagesV4 },
  eleven_flash_v2_5: {
    limit: 40_000,
    settings: standard,
    audioTags: false,
    continuity: true,
    languages: [...languagesV2, "hu", "no", "vi"],
  },
} as const;

export const DIALOGUE_SETTINGS = ["stability", "similarity", "clone_strength"] as const;
export const SPEECH_SOURCES = [
  "https://elevenlabs.io/docs/overview/models",
  "https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps",
  "https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert-with-timestamps",
  "https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tdd",
] as const;

export const providerLanguage = (value: string) => value.split("-")[0]!;
export const supportsVoiceChangeLanguage = (model: (typeof STS_MODELS)[number], value: string) =>
  (model === "eleven_english_sts_v2" ? ["en"] : languagesV2).includes(providerLanguage(value));
