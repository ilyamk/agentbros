import React from "react";
import type { CaptionStyleSelection } from "../types/caption-style";
import { TemplateInstanceSchema } from "../types/templates";
import { shiftWords, type TimelineCaptionWord } from "../lib/captions/profiles";
import { PhraseCaption } from "../templates/registry/PhraseCaption";
import { BilingualCaption } from "../templates/registry/BilingualCaption";
import { captionBlocks } from "../motion/library/captions";
import { resolveCaptionProps } from "../motion/library/captions/style";

/**
 * Every non-karaoke caption profile for one timeline clip. `words` are output seconds; `startOffsetSec` is the clip's
 * first output second. Karaoke stays in TimelineComposition so existing renders are untouched.
 */
export const TimelineCaptions: React.FC<{
  style: CaptionStyleSelection;
  words: TimelineCaptionWord[];
  startOffsetSec: number;
  inline: boolean;
}> = ({ style, words, startOffsetSec, inline }) => {
  const options = style.options ?? {};
  if (style.profile === "phrase" || style.profile === "keyword") {
    const local = shiftWords(words, startOffsetSec).map(({ text, start, end, emphasis }) => ({
      text,
      start,
      end,
      ...(emphasis ? { emphasis } : {}),
    }));
    if (!local.length) return null;
    const instance = TemplateInstanceSchema.parse({
      id: `caption.${style.profile}`,
      version: 1,
      props: {
        maxWords: style.profile === "phrase" ? 6 : 3,
        ...("maxWords" in options ? { maxWords: options.maxWords } : {}),
        ...("activeColor" in options ? { activeColor: options.activeColor } : {}),
        words: local,
      },
    }) as Extract<ReturnType<typeof TemplateInstanceSchema.parse>, { id: "caption.phrase" | "caption.keyword" }>;
    return (
      <div style={{ color: typeof options.textColor === "string" ? options.textColor : "#FFFFFF" }}>
        <PhraseCaption props={instance.props} keyword={style.profile === "keyword"} />
      </div>
    );
  }
  if (style.profile === "bilingual") {
    const local = shiftWords(words, startOffsetSec);
    if (!local.length) return null;
    const missing = local.find((word) => !word.translation?.trim());
    if (missing)
      throw new Error(`Bilingual captions need a supplied translation on every caption; "${missing.text}" has none`);
    const instance = TemplateInstanceSchema.parse({
      id: "caption.bilingual",
      version: 1,
      props: {
        sourceLanguage: style.sourceLanguage,
        translationLanguage: style.translationLanguage,
        cues: local.map(({ text, start, end, translation }) => ({ text, start, end, translation })),
      },
    }) as Extract<ReturnType<typeof TemplateInstanceSchema.parse>, { id: "caption.bilingual" }>;
    const colour = (key: string, fallback: string) =>
      typeof options[key] === "string" ? (options[key] as string) : fallback;
    return (
      <BilingualCaption
        props={instance.props}
        backgroundColor={colour("backgroundColor", "#000000")}
        textColor={colour("textColor", "#FFFFFF")}
      />
    );
  }
  if (style.profile === "karaoke") throw new Error("Karaoke captions render in TimelineComposition");
  const block = captionBlocks[style.profile];
  const props = block.schema.parse({
    ...resolveCaptionProps(style.profile, options),
    words: words.map(({ translation: _translation, ...word }) => word),
    startOffsetSec,
    placement: inline ? "inline" : "safe-zone",
  });
  const Component = block.component as React.FC<Record<string, unknown>>;
  return <Component {...(props as Record<string, unknown>)} />;
};
