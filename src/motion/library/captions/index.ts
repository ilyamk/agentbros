import type React from "react";
import type { z } from "zod";
import { defineItem, type LibraryItem } from "../types";
import { captionCues, StyledCaptions, StyledCaptionsPreview } from "./Captions";
import { SAMPLE_EN, SAMPLE_RU } from "./sample";
import {
  CAPTION_PRESETS,
  captionStyleSchema,
  LEGACY_CAPTION_PROFILES,
  resolveCaptionProps,
  type CaptionPresetId,
  type CaptionStyleProps,
  type LegacyCaptionProfileId,
} from "./style";

const DURATION = 150;
const FORMATS = ["vertical", "square", "landscape"] as const;
const SHARED_DOC =
  "Pages from TranscriptSchema words (`wordsFromTranscript`) or a words.json (`wordsFromAlignment`), never across a speaker change or sentence end, inside the platform safe zone; no blurred scrim, legibility comes from the preset's outline, shadow or box.";

type Entry = { title: string; description: string; tags: string[]; inspiredBy: string[]; sample?: "ru" };

const ENTRIES: Record<CaptionPresetId, Entry> = {
  "outline-pop": {
    title: "Outline pop",
    description:
      "White heavy caps (Montserrat Black) with a thick round-jointed black outline and a hard drop; the spoken word turns green and pops with overshoot. 3 words a page. Loud talking heads, hooks, sales.",
    tags: [
      "captions",
      "subtitles",
      "uppercase",
      "outline",
      "stroke",
      "pop",
      "active-word",
      "shorts",
      "reels",
      "tiktok",
      "loud",
    ],
    inspiredBy: [
      "TikTok and Reels creator captions: heavy caps, thick outline, coloured active word (method only)",
      "remotion: template-tiktok Page.tsx stroke-behind-fill recipe (licence unverified, method only)",
    ],
  },
  "italic-shadow": {
    title: "Yellow italic, hard shadow",
    description:
      "Condensed italic caps, all in warm yellow, on a hard black drop shadow; each word pops in as it is spoken. 4 words a page. Business and podcast clips.",
    tags: [
      "captions",
      "subtitles",
      "uppercase",
      "italic",
      "condensed",
      "yellow",
      "shadow",
      "pop",
      "per-word",
      "podcast",
    ],
    inspiredBy: ["Short-form business podcast captions: yellow condensed italic with hard shadow (method only)"],
  },
  "keyword-colour": {
    title: "Key-word colour",
    description:
      "White heavy italic caps on a hard shadow; the page's key word (marked, listed, a number, or its longest content word) in yellow and slightly larger; words rise in as spoken. Emoji over listed keywords.",
    tags: ["captions", "subtitles", "uppercase", "italic", "keyword", "emphasis", "accent", "shadow", "rise", "emoji"],
    inspiredBy: ["Shorts creator captions with one coloured key word per line (method only)"],
  },
  "word-box": {
    title: "Sliding word box",
    description:
      "Sentence-case heavy sans with a thin outline; a solid accent box glides behind the spoken word. Explainers and product shorts over busy footage.",
    tags: ["captions", "subtitles", "box", "pill", "highlight", "active-word", "slide", "explainer", "product"],
    inspiredBy: ["CapCut and Submagic active-word box captions (method only)"],
    sample: "ru",
  },
  "line-box": {
    title: "Line label box",
    description:
      "Dark sentence-case grotesk on a solid white rounded box per line, like the platforms' own text labels; the page rises in. Calm, clean, reads over anything.",
    tags: ["captions", "subtitles", "box", "label", "solid", "sentence-case", "calm", "rise", "instagram"],
    inspiredBy: ["Instagram and TikTok native text labels with a solid box per line (method only)"],
  },
  "chunky-stack": {
    title: "Chunky stack",
    description:
      "Chunky rounded caps (Rubik Black) in pale pink, one word per line, centred on the speaker; each word bounces in as spoken. Lifestyle and creator reels.",
    tags: ["captions", "subtitles", "rounded", "chunky", "stack", "pink", "bounce", "lifestyle", "reels"],
    inspiredBy: ["Lifestyle reel captions: chunky rounded caps stacked over the speaker (method only)"],
  },
  "editorial-mix": {
    title: "Editorial mixed scale",
    description:
      "Sizes by importance: tiny connective words, one huge key word in mint, one serif italic word in yellow, staggered lines; each word blurs in as spoken. Premium explainers and founder talks.",
    tags: ["captions", "subtitles", "editorial", "mixed-scale", "serif", "italic", "hierarchy", "blur-in", "premium"],
    inspiredBy: ["Editorial mixed-scale caption layouts (user's reference grid of 15, method only)"],
  },
  "clean-sentence": {
    title: "Clean sentence",
    description:
      'Quiet sentence-case Inter with a thin dark outline; up to 6 words, each brightening from dim to white as spoken. `active.fill: "switch"` (`cleanSentenceSwitchPreset`) instead shows the page in white and switches each word to the accent in one frame as it is spoken, where it stays. Calm interviews, tutorials, long talk.',
    tags: [
      "captions",
      "subtitles",
      "minimal",
      "clean",
      "sentence-case",
      "calm",
      "interview",
      "tutorial",
      "karaoke",
      "colour fill",
      "switch",
    ],
    inspiredBy: [
      "Minimal broadcast-style subtitles with word-by-word fill (method only)",
      "abdulah 34.0-36.5 s: 4-5 white serif words a line, each turning accent in one frame as spoken (steps(1))",
    ],
  },
  "single-punch": {
    title: "Single-word punch",
    description:
      "One huge condensed word at a time, slammed in from scale; key words yellow. Hooks, fast cuts, the first two seconds.",
    tags: ["captions", "subtitles", "single-word", "one-word", "huge", "condensed", "slam", "hook", "fast"],
    inspiredBy: ["One-word-at-a-time hook captions (method only)"],
  },
  typewriter: {
    title: "Typewriter",
    description:
      "Monospaced words typed on as they are spoken, with a yellow block cursor, on a black box that grows with each line. Tech, coding and story beats.",
    tags: ["captions", "subtitles", "typewriter", "mono", "cursor", "type-on", "box", "tech"],
    inspiredBy: ["Typewriter caption effect with cursor (method only)"],
  },
};

const defaults = (id: CaptionPresetId): CaptionStyleProps => {
  const sample = ENTRIES[id].sample === "ru";
  return captionStyleSchema.parse({
    ...CAPTION_PRESETS[id],
    words: sample ? SAMPLE_RU : SAMPLE_EN,
    language: sample ? "ru" : "en",
    keywords: id === "keyword-colour" ? [{ word: "fix", emoji: "🔧" }] : [],
  });
};

type CaptionBlock = { component: React.FC<never>; schema: z.ZodType; defaultProps: Record<string, unknown> };

/**
 * Caption blocks a timeline can select by `captionStyle.profile`: every preset, and the four profiles saved before the
 * presets, drawn by their closest preset (`LEGACY_CAPTION_PROFILES`).
 */
export const captionBlocks = Object.fromEntries(
  [
    ...(Object.keys(CAPTION_PRESETS) as CaptionPresetId[]),
    ...(Object.keys(LEGACY_CAPTION_PROFILES) as LegacyCaptionProfileId[]),
  ].map((id) => [
    id,
    {
      component: StyledCaptions as React.FC<never>,
      schema: captionStyleSchema as z.ZodType,
      defaultProps: resolveCaptionProps(id),
    },
  ]),
) as Record<CaptionPresetId | LegacyCaptionProfileId, CaptionBlock>;
export type CaptionBlockId = keyof typeof captionBlocks;

export const items: LibraryItem[] = (Object.keys(CAPTION_PRESETS) as CaptionPresetId[]).map((id) =>
  defineItem({
    id: `caption-${id}`,
    category: "captions",
    title: ENTRIES[id].title,
    description: `${ENTRIES[id].description} ${SHARED_DOC}`,
    tags: ENTRIES[id].tags,
    component: StyledCaptionsPreview,
    schema: captionStyleSchema,
    defaultProps: defaults(id),
    durationInFrames: DURATION,
    formats: [...FORMATS],
    inspiredBy: [
      ...ENTRIES[id].inspiredBy,
      "remotion: @remotion/captions createTikTokStyleCaptions (MIT, used as a dependency)",
    ],
    importPath: "src/motion/library/captions/Captions",
    usage: `<StyledCaptions {...CAPTION_PRESETS["${id}"]} words={wordsFromTranscript(transcript)} startOffsetSec={clipStartSec} /> (or the timeline: {"type":"caption-style","style":{"profile":"${id}"}})`,
    cues: (p) => captionCues(p),
  }),
);
