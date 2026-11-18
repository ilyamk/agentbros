import React from "react";
import type { Cue } from "../types";
import { CaptionPages, PreviewFootage } from "./kit";
import { emphasisCues, keywordOf } from "./layout";
import { pageRoles, presetLayout } from "./plan";
import type { CaptionStyleProps } from "./style";

/** Burned captions in any preset's look: pass the preset's props (`CAPTION_PRESETS[id]`) and the spoken words. */
export const StyledCaptions: React.FC<CaptionStyleProps> = (p) => <CaptionPages p={p} />;

export const StyledCaptionsPreview: React.FC<CaptionStyleProps> = (p) => (
  <PreviewFootage tone={p.textColor.toUpperCase() === "#FFFFFF" ? "warm" : "cool"}>
    <StyledCaptions {...p} />
  </PreviewFootage>
);

/** A cue on every word the viewer is pushed towards: marked or listed keywords, and with automatic emphasis each page's key word. */
export const captionCues = (p: CaptionStyleProps, fps = 30): Cue[] => {
  const keys = new Set<object>();
  if (p.emphasis.source === "auto")
    for (const page of presetLayout(p, 1080, 1920).pages)
      pageRoles(p, page.words).forEach((role, index) => role === "key" && keys.add(page.words[index]!));
  return emphasisCues(
    p,
    (word) => keys.has(word) || keywordOf(word, p.keywords, p.language) !== null,
    p.active.box ? "click" : "pop",
    "support",
    fps,
  );
};
