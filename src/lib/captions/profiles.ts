import { CaptionStyleSelectionSchema, type CaptionStyleSelection } from "../../types/caption-style";
import type { Rational } from "../../types/timeline";
import { numeric } from "../timeline-ir/rational";
import type { CaptionWord } from "./pages";

export const DEFAULT_CAPTION_STYLE: CaptionStyleSelection = { profile: "karaoke" };

/** A render option (`props.captionStyle`) wins over the timeline's `captionStyle`; neither means karaoke. */
export const resolveCaptionStyle = (props: {
  captionStyle?: unknown;
  timeline?: { captionStyle?: unknown };
}): CaptionStyleSelection =>
  CaptionStyleSelectionSchema.parse(props.captionStyle ?? props.timeline?.captionStyle ?? DEFAULT_CAPTION_STYLE);

export type TimelineCaptionWord = CaptionWord & { translation?: string };

type CompiledCaption = { text: string; start: Rational; end: Rational; emphasis?: boolean; [key: string]: unknown };

/** Compiled clip captions in output seconds; `event` words and zero-length remnants of trims are dropped. */
export const timelineCaptionWords = (captions: readonly CompiledCaption[], timebase: Rational): TimelineCaptionWord[] =>
  captions.flatMap((caption) => {
    const start = numeric(caption.start) / numeric(timebase);
    const end = numeric(caption.end) / numeric(timebase);
    const kind =
      caption.kind === "word" || caption.kind === "filler" || caption.kind === "event" ? caption.kind : undefined;
    if (kind === "event" || !(end > start) || !caption.text.trim()) return [];
    return [
      {
        text: caption.text.trim(),
        start,
        end,
        ...(caption.emphasis ? { emphasis: true } : {}),
        ...(kind ? { kind } : {}),
        ...(typeof caption.emoji === "string" ? { emoji: caption.emoji } : {}),
        ...(typeof caption.speaker === "string" && caption.speaker ? { speaker: caption.speaker } : {}),
        ...(typeof caption.translation === "string" ? { translation: caption.translation } : {}),
      },
    ];
  });

/** Words moved onto a clip's own clock (its first frame is 0 s), as the template profiles expect. */
export const shiftWords = <W extends { start: number; end: number }>(words: readonly W[], offsetSec: number): W[] =>
  words
    .map((word) => ({ ...word, start: Math.max(0, word.start - offsetSec), end: word.end - offsetSec }))
    .filter((word) => word.end > word.start);
