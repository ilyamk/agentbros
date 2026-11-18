import type { FalCategory, InputMedia, OutputKind, FalCurationEntry } from "../../types/fal-catalog";

type Role = FalCurationEntry["roles"][number];
export type FalTaskConcept = {
  id: string;
  /** Alternatives are unordered token sets; * marks an explicit prefix stem. */
  anyOf?: readonly string[];
  /** Every group must match at least one alternative. */
  allOf?: readonly (readonly string[])[];
  noneOf?: readonly string[];
  /** Applied once against all phrase matches, before generic suppression. */
  suppressedBy?: readonly string[];
  /** Generic media requests yield to specialist concepts; modifiers never choose media. */
  generic?: boolean;
  categories: FalCategory[];
  inputs?: InputMedia[];
  outputs?: OutputKind[];
  roles?: Role[];
  hints?: string[];
  /** Require capability words even when a broad curated role overlaps. */
  requireHints?: boolean;
};

/** Deliberately small, deterministic suffix stemmer, shared by concepts and lexical discovery. */
// Directional API labels stay atomic: text-to-speech and speech-to-text are different tasks.
const taskText = (text: string) =>
  text
    .toLowerCase()
    .replaceAll("ё", "е")
    .replaceAll(
      /\b(text|speech|image|audio|video|3d)[\s-]+to[\s-]+(text|speech|image|audio|video|3d|json)\b/gu,
      "$1to$2",
    );
const taskWords = (text: string) =>
  taskText(text)
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
export function normaliseTaskTokens(text: string): string[] {
  return [
    ...new Set(
      taskWords(text).map((token) => {
        if (/^[а-я]+$/u.test(token) && token.length > 4)
          return token.replace(
            /(?:иями|ями|ами|ого|ему|ому|ыми|ими|ение|ения|ить|ать|ять|ешь|ете|ют|ут|ет|ит|ый|ий|ой|ая|ое|ые|ие|ую|юю|ов|ев|ам|ям|ах|ях|ы|и|а|я|у|ю|е|о|ь)$/u,
            "",
          );
        if (/^[a-z]+$/u.test(token) && token.length > 4) return token.replace(/(?:ing|ed|s)$/u, "");
        return token;
      }),
    ),
  ];
}
const video = ["video", "видео", "ролик*", "клип*", "film", "movie"];
const image = ["image", "photo", "picture", "фото", "изображ*", "картин*"];
const audio = ["audio", "аудио", "sound", "звук*", "speech", "реч*", "голос*"];
const edit = ["edit", "редакт*", "отредакт*", "измен*"];
const textJson = [
  "text to json",
  "текст json",
  "extract data text",
  "извле* данн* текст",
  "структурир* текст",
  "structure text",
];
const imageJson = [
  "image to json",
  "фото json",
  "изображ* json",
  "extract data image",
  "extract data photo",
  "извле* данн* изображ*",
  "извле* данн* фото",
  "структурир* изображ*",
  "structure image",
];

export const FAL_TASK_MAP: readonly FalTaskConcept[] = [
  {
    id: "reference-to-video",
    anyOf: ["reference to video", "reference video", "видео по референсу"],
    categories: ["image-to-video", "video-to-video"],
    inputs: ["image"],
    outputs: ["video"],
    roles: ["reference"],
    hints: ["reference-to-video"],
    requireHints: true,
  },
  {
    id: "character-swap",
    suppressedBy: ["motion-transfer"],
    anyOf: ["character swap", "face swap", "замен* лиц*"],
    categories: ["video-to-video"],
    inputs: ["video", "image"],
    outputs: ["video"],
    roles: ["character-swap", "edit"],
    hints: ["object-swap", "character-swap", "video-edit", "edit-video"],
  },
  {
    id: "motion-transfer",
    anyOf: [
      "motion transfer",
      "transfer motion",
      "перенос движен*",
      "перенеси движен*",
      "перенести движен*",
      "rebuild scene",
      "перестро* сцен*",
    ],
    categories: ["video-to-video"],
    inputs: ["video", "image"],
    outputs: ["video"],
    roles: ["motion-transfer"],
    hints: ["motion-transfer", "motion-control"],
  },
  {
    id: "character-in-video",
    suppressedBy: ["motion-transfer"],
    allOf: [
      ["replace", "swap", "insert", "put", "встав*", "замен*"],
      ["person", "character", "геро*", "персонаж*", "человек*"],
      video,
    ],
    categories: ["video-to-video"],
    inputs: ["video", "image"],
    outputs: ["video"],
    roles: ["character-swap", "edit"],
    hints: ["object-swap", "character-swap", "video-edit", "edit-video"],
  },
  {
    id: "restyle",
    anyOf: ["restyle", "рестайл*", "стилиз* видео", "стиль видео"],
    categories: ["video-to-video"],
    inputs: ["video"],
    outputs: ["video"],
    roles: ["restyle"],
    hints: ["restyle"],
  },
  {
    id: "object-swap",
    allOf: [
      ["swap", "replace", "замен*"],
      ["object", "объект*", "предмет*"],
    ],
    categories: ["video-to-video"],
    inputs: ["video", "image"],
    outputs: ["video"],
    roles: ["edit", "reference"],
    hints: ["object-swap"],
  },
  {
    id: "influencer",
    anyOf: ["influencer", "инфлюенсер*", "инфлуенсер*", "influenser", "persona photo", "персонаж* фото"],
    categories: ["text-to-image"],
    outputs: ["image"],
    roles: ["character"],
    hints: ["soul", "influencer"],
  },
  {
    id: "ad-image",
    anyOf: [
      "ad creative",
      "product shot",
      "marketing image",
      "реклам* изображ*",
      "реклам* креатив*",
      "предметн* фото",
      "предметн* съемк*",
    ],
    categories: ["text-to-image", "image-to-image"],
    outputs: ["image"],
    roles: ["ads"],
    hints: ["marketing-studio", "ads-studio"],
  },
  {
    id: "cinematic",
    anyOf: ["cinematic", "кинематограф*"],
    categories: ["text-to-video", "image-to-video"],
    outputs: ["video"],
    roles: ["cinematic"],
    hints: ["cinema", "seedance", "kling"],
  },
  {
    id: "animate-photo",
    anyOf: [
      "ожив* фото",
      "аним* фото",
      "animate photo",
      "image to video",
      "animate image",
      "видео из фото",
      "video from photo",
      "video from image",
    ],
    suppressedBy: ["upscale", "denoise", "cutout", "background-replace", "frame-interpolation", "describe-video"],
    categories: ["image-to-video"],
    inputs: ["image"],
    outputs: ["video"],
    roles: ["reference"],
  },
  {
    id: "inpaint",
    anyOf: ["inpaint*", "закрас*", "замен* часть"],
    categories: ["image-to-image"],
    inputs: ["image"],
    outputs: ["image"],
    roles: ["inpaint"],
    hints: ["inpaint"],
  },
  {
    id: "outpaint",
    anyOf: ["outpaint*", "расшир* кадр", "дорис* кра*", "extend image", "expand image"],
    categories: ["image-to-image"],
    inputs: ["image"],
    outputs: ["image"],
    roles: ["outpaint"],
    hints: ["outpaint", "expand"],
  },
  {
    id: "denoise",
    anyOf: [
      "denoise",
      "убра* шум",
      "убери шум",
      "удал* шум",
      "очист* звук",
      "clean audio",
      "remove noise",
      "speech enhancement",
    ],
    categories: ["audio-to-audio", "video-to-video", "image-to-image"],
    hints: ["deepfilternet", "denoise", "speech-enhancement", "clean-audio"],
  },
  {
    id: "stem-separation",
    anyOf: ["stem", "stems", "stem separation", "раздел* дорож*", "отдел* вокал", "separate vocal", "isolate vocal"],
    categories: ["audio-to-audio"],
    inputs: ["audio"],
    outputs: ["audio"],
    roles: ["analysis"],
    hints: ["demucs", "separate", "stem"],
  },
  {
    id: "voice-change",
    anyOf: [
      "voice change",
      "voice changer",
      "voice conversion",
      "speech to speech",
      "измен* голос",
      "замен* голос",
      "конверс* голос",
      "смен* голос",
    ],
    categories: ["audio-to-audio", "speech-to-speech"],
    inputs: ["audio"],
    outputs: ["audio"],
    roles: ["voice"],
    hints: ["voice-changer", "speech-to-speech", "chatterbox"],
  },
  {
    id: "voice-clone",
    anyOf: ["voice clone", "clone voice", "voice cloning", "клонир* голос*"],
    categories: ["audio-to-audio", "text-to-speech"],
    inputs: ["audio"],
    outputs: ["audio"],
    roles: ["voice"],
    hints: ["clone", "cloning"],
    requireHints: true,
  },
  {
    id: "character-consistency",
    allOf: [
      ["character", "персонаж*", "геро*"],
      ["consistent", "consistency", "same character", "всех сцен*", "один* сцен*"],
    ],
    categories: ["text-to-image", "image-to-image"],
    outputs: ["image"],
    roles: ["character"],
    hints: ["character", "consistent", "soul"],
  },
  {
    id: "avatar",
    anyOf: ["avatar", "аватар*", "talking head", "говорящ* голов*", "presenter", "презентер*", "ведущ*"],
    categories: ["audio-to-video", "image-to-video", "text-to-video"],
    outputs: ["video"],
    roles: ["avatar"],
    hints: ["avatar", "talking-head", "echomimic", "heygen"],
  },
  {
    id: "try-on",
    anyOf: ["try on", "tryon", "vton", "пример* одежд*", "виртуальн* пример*"],
    categories: ["image-to-image"],
    inputs: ["image"],
    outputs: ["image"],
    hints: ["try-on", "tryon", "vton", "vto"],
  },
  {
    id: "text-render",
    anyOf: [
      "логотип*",
      "logo",
      "typograph*",
      "типограф*",
      "текст картин*",
      "текст изображ*",
      "poster text",
      "text render",
    ],
    categories: ["text-to-image", "image-to-image"],
    outputs: ["image"],
    roles: ["text-render"],
    hints: ["gpt-image", "ideogram", "qwen-image", "typograph"],
  },
  {
    id: "frame-interpolation",
    anyOf: [
      "интерполяц* кадр*",
      "frame interpolation",
      "slow motion",
      "slow-mo",
      "замедл*",
      "плавн*",
      "больше кадр*",
      "60 fps",
      "fps",
    ],
    categories: ["video-to-video", "image-to-image"],
    roles: ["frame-interpolation"],
    hints: ["interpol", "rife", "film", "slow-mo", "slow motion"],
  },
  {
    id: "3d-texture",
    anyOf: ["texturing", "текстур* модел*", "retexture", "texture 3d"],
    categories: ["3d-to-3d"],
    outputs: ["model3d"],
    roles: ["mesh"],
    hints: ["retexture", "texture"],
    requireHints: true,
  },
  {
    id: "3d-edit",
    anyOf: ["retopolog*", "ретополог*", "rigging", "риггинг*", "3d to 3d"],
    noneOf: ["texturing", "текстур* модел*", "retexture", "texture 3d"],
    categories: ["3d-to-3d"],
    outputs: ["model3d"],
    roles: ["mesh"],
    hints: ["topology", "rigging", "retexture", "texture", "part"],
  },
  {
    id: "world",
    anyOf: ["3d мир", "world", "environment", "сцен* прогул*"],
    categories: ["worlds"],
    roles: ["world"],
    hints: ["world", "h3-max", "eden-live"],
  },
  {
    id: "structured-data",
    anyOf: ["извле* данн*", "структурир*", "json", "extract data", "structured data"],
    noneOf: [...textJson, ...imageJson],
    categories: ["text-to-json", "image-to-json", "json"],
    outputs: ["json"],
    roles: ["analysis"],
  },
  { id: "text-json", anyOf: textJson, categories: ["text-to-json"], outputs: ["json"], roles: ["analysis"] },
  {
    id: "image-json",
    anyOf: imageJson,
    categories: ["image-to-json"],
    inputs: ["image"],
    outputs: ["json"],
    roles: ["analysis"],
  },
  {
    id: "rewrite",
    anyOf: ["rewrite", "перепиш*", "перепис*", "translate text", "перев* текст", "translation text", "text to text"],
    categories: ["text-to-text", "llm"],
    outputs: ["text"],
    roles: ["analysis"],
  },
  {
    id: "transcript",
    anyOf: ["субтитр*", "транскри*", "transcrib*", "transcript*", "speech to text", "stt", "captions", "subtitles"],
    categories: ["speech-to-text", "audio-to-text"],
    inputs: ["audio"],
    outputs: ["text", "json"],
    roles: ["transcript"],
  },
  {
    id: "cutout",
    allOf: [
      ["убра*", "убери", "удал*", "remove", "cutout"],
      ["фон", "background", "cutout"],
    ],
    categories: ["image-to-image", "video-to-video"],
    roles: ["cutout"],
    hints: ["background", "cutout", "birefnet", "rmbg", "rembg"],
  },
  {
    id: "background-replace",
    allOf: [
      ["replace", "change", "замен*", "смен*"],
      ["background", "фон"],
    ],
    categories: ["image-to-image", "video-to-video"],
    roles: ["edit"],
    hints: ["replace-background", "background/replace", "background-change", "edit-video", "video-edit", "/edit"],
    requireHints: true,
  },
  {
    id: "upscale",
    anyOf: ["апскейл*", "upscal*", "super resolution"],
    categories: ["image-to-image", "video-to-video"],
    roles: ["upscale"],
    hints: ["upscal", "aura-sr", "super-resolution", "super resolution"],
  },
  {
    id: "lipsync",
    anyOf: ["липсинк*", "lipsync", "lip sync"],
    categories: ["audio-to-video", "video-to-video"],
    inputs: ["audio"],
    outputs: ["video"],
    roles: ["lipsync"],
    hints: ["lipsync", "lip-sync", "lip sync", "latentsync"],
  },
  {
    id: "music",
    suppressedBy: ["stem-separation", "denoise", "voice-change"],
    anyOf: ["музык*", "music", "soundtrack", "саундтрек*"],
    noneOf: ["stem", "stems"],
    categories: ["text-to-audio"],
    outputs: ["audio"],
    roles: ["music"],
    hints: ["music", "song", "soundtrack", "lyria", "ace-step"],
  },
  {
    id: "sfx",
    anyOf: ["звуков* эффект*", "sfx", "sound effect", "foley", "фоли"],
    categories: ["text-to-audio", "video-to-audio"],
    outputs: ["audio"],
    roles: ["sfx", "foley"],
  },
  {
    id: "describe-video",
    allOf: [["описать", "опиши", "описывай", "описан* кадр*", "describe", "analyse", "analyze"], video],
    categories: ["video-to-text", "vision"],
    inputs: ["video"],
    outputs: ["text", "json"],
    roles: ["analysis"],
  },
  {
    id: "vision",
    anyOf: ["vision", "image caption", "describe image", "описа* изображ*"],
    categories: ["video-to-text", "vision", "image-to-text"],
    outputs: ["text", "json"],
    roles: ["analysis"],
  },
  {
    id: "llm",
    anyOf: ["llm", "языков* модел*", "language model"],
    categories: ["llm"],
    outputs: ["text", "json"],
    roles: ["analysis"],
  },
  { id: "training", anyOf: ["обуч*", "тренир*", "train*"], categories: ["training"], roles: ["training"] },
  { id: "workflow", anyOf: ["workflow", "pick image index", "выбра* изображ* индекс*"], categories: ["workflow"] },
  {
    id: "image-edit",
    generic: true,
    allOf: [edit, image],
    categories: ["image-to-image"],
    inputs: ["image"],
    outputs: ["image"],
    roles: ["edit"],
  },
  {
    id: "video-edit",
    generic: true,
    allOf: [edit, video],
    categories: ["video-to-video"],
    inputs: ["video"],
    outputs: ["video"],
    roles: ["edit"],
  },
  {
    id: "voiceover",
    generic: true,
    anyOf: ["озвуч*", "голос*", "voiceover", "text to speech", "tts", "dub", "дубляж*"],
    categories: ["text-to-speech"],
    outputs: ["audio"],
    roles: ["voice"],
  },
  {
    id: "mesh",
    generic: true,
    anyOf: ["3d", "mesh", "image to 3d", "text to 3d"],
    categories: ["image-to-3d", "text-to-3d"],
    outputs: ["model3d"],
    roles: ["mesh"],
  },
  {
    id: "text-to-video",
    generic: true,
    anyOf: [...video, "text to video"],
    categories: ["text-to-video"],
    outputs: ["video"],
  },
  {
    id: "text-to-image",
    generic: true,
    anyOf: ["text to image", "созда* картин*", "созда* изображ*", "generate image", "generate picture"],
    categories: ["text-to-image"],
    outputs: ["image"],
  },
  { id: "hero", anyOf: ["hero", "лучш* качеств*", "best quality"], categories: [], roles: ["hero"] },
  { id: "fast-draft", anyOf: ["черновик*", "быстр*", "draft", "fast"], categories: [], roles: ["fast-draft"] },
  { id: "budget", anyOf: ["дешев*", "дешево", "budget", "cheap"], categories: [], roles: ["budget"] },
];

function matchesPhrase(tokens: readonly string[], phrase: string): boolean {
  return taskText(phrase)
    .split(/\s+/u)
    .every((word) =>
      word.endsWith("*")
        ? tokens.some((token) => token.startsWith(word.slice(0, -1)))
        : normaliseTaskTokens(word).every((stem) => tokens.includes(stem)),
    );
}
export function matchesTaskConcept(tokens: readonly string[], rule: FalTaskConcept): boolean {
  return (
    (!rule.anyOf || rule.anyOf.some((phrase) => matchesPhrase(tokens, phrase))) &&
    (!rule.allOf || rule.allOf.every((group) => group.some((phrase) => matchesPhrase(tokens, phrase)))) &&
    !rule.noneOf?.some((phrase) => matchesPhrase(tokens, phrase))
  );
}
export function suggestTaskConcepts(task: string) {
  const tokens = [...normaliseTaskTokens(task), ...taskWords(task)];
  return FAL_TASK_MAP.filter((rule) => rule.categories.length)
    .map((rule) => ({
      concept: rule.id,
      categories: rule.categories,
      overlap: Math.max(
        0,
        ...[...(rule.anyOf ?? []), ...(rule.allOf?.flat() ?? [])].map(
          (phrase) => phrase.split(/\s+/u).filter((word) => matchesPhrase(tokens, word)).length,
        ),
      ),
    }))
    .sort((a, b) => b.overlap - a.overlap || a.concept.localeCompare(b.concept, "en"))
    .slice(0, 3)
    .map(({ concept, categories }) => ({ concept, categories }));
}
export function parseFalTask(task = "", conceptIds?: readonly string[]) {
  const text = task.toLowerCase().replaceAll("ё", "е"),
    tokens = [...normaliseTaskTokens(text), ...taskWords(text)];
  const phraseMatches = FAL_TASK_MAP.filter((rule) =>
    conceptIds ? conceptIds.includes(rule.id) : matchesTaskConcept(tokens, rule),
  );
  const preservesBackground =
    /\b(?:preserve|keep|retain)\s+(?:(?:the|original|same|existing)\s+){0,3}background\b|\bbackground\s+(?:unchanged|intact)\b|(?:сохран[а-я]*|остав[а-я]*)\s+(?:(?:исходн[а-я]*|прежн[а-я]*)\s+)?фон[а-я]*|не\s+мен[а-я]*\s+фон[а-я]*|фон[а-я]*\s+без\s+измен[а-я]*/u.test(
      text,
    );
  const matched = phraseMatches.filter(
    (rule) =>
      !(preservesBackground && ["background-replace", "cutout"].includes(rule.id)) &&
      !rule.suppressedBy?.some((id) => phraseMatches.some((other) => other.id === id)),
  );
  const specialists = matched.filter((rule) => rule.categories.length && !rule.generic);
  const generic = matched.filter((rule) => rule.generic);
  // Any specialist suppresses generic video/image generation. Modifiers never suppress it.
  const selected = [
    ...(specialists.length
      ? specialists
      : generic.some((rule) => rule.id !== "text-to-video")
        ? generic.filter((rule) => rule.id !== "text-to-video")
        : generic),
    ...matched.filter((rule) => !rule.categories.length),
  ];
  const named = (phrases: string[]) => phrases.some((phrase) => matchesPhrase(tokens, phrase));
  const namedMedium = (medium: InputMedia, phrases: string[]) =>
    named(phrases) || tokens.some((token) => token.startsWith(`${medium}to`) || token.endsWith(`to${medium}`));
  const hasVideo = namedMedium("video", video),
    hasImage = namedMedium("image", image),
    hasAudio = namedMedium("audio", audio);
  // Audio cleanup keeps its named track; visual utilities prefer video over images.
  const rules: FalTaskConcept[] = selected.map((rule) => {
    if (["upscale", "cutout", "background-replace", "denoise", "frame-interpolation"].includes(rule.id)) {
      const medium =
        rule.id === "denoise" && hasAudio
          ? "audio"
          : hasVideo
            ? "video"
            : hasImage
              ? "image"
              : rule.id === "denoise"
                ? "audio"
                : "image";
      if (rule.id === "frame-interpolation" && !hasVideo && !hasImage) return rule;
      return {
        ...rule,
        categories: [medium === "video" ? "video-to-video" : medium === "audio" ? "audio-to-audio" : "image-to-image"],
        inputs: [medium],
        outputs: [medium],
      };
    }
    return rule;
  });
  const unique = <T>(values: T[]) => [...new Set(values)];
  const duration = text.match(/(\d+(?:[.,]\d+)?)\s*(?:сек\S*|seconds?\b|secs?\b|s\b)/u);
  const aspect =
    text.match(/\b(\d+\s*:\s*\d+)\b/u)?.[1]?.replaceAll(/\s/g, "") ??
    (/вертикаль|vertical/u.test(text) ? "9:16" : undefined);
  return {
    matched: rules.some((rule) => rule.categories.length > 0),
    concepts: rules.map((rule) => rule.id),
    categories: unique(rules.flatMap((rule) => rule.categories)),
    inputs: unique([
      ...rules.flatMap((rule) => rule.inputs ?? []),
      ...(rules.some((rule) => rule.id === "mesh") &&
      tokens.some((token) => ["фото", "photo", "image", "imageto3d"].includes(token))
        ? ["image" as const]
        : []),
    ]),
    outputs: unique(rules.flatMap((rule) => rule.outputs ?? [])),
    roles: unique(rules.flatMap((rule) => rule.roles ?? [])),
    hints: unique(rules.flatMap((rule) => rule.hints ?? [])),
    requireHints: rules.some((rule) => rule.requireHints),
    excludedHints: rules.some((rule) => rule.id === "rewrite") && !named(["lyrics", "song", "песн*"]) ? ["lyrics"] : [],
    durationSec: duration ? Number(duration[1]!.replace(",", ".")) : undefined,
    aspect,
    resolution: text.match(/\b(\d{3,4}p)\b/u)?.[1],
  };
}
