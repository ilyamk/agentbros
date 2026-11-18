import { palettes } from "../design-tokens";
import type { StyleProfileId } from "../../types/templates";
export const STYLE_PROFILES: Record<
  StyleProfileId,
  {
    id: StyleProfileId;
    purpose: string;
    colors: (typeof palettes)[keyof typeof palettes];
    entrance: "fade" | "scale";
    caption: "caption.karaoke" | "caption.phrase" | "caption.keyword";
    editorialRule: string;
    optIn: true;
  }
> = {
  "education-worked-example": {
    id: "education-worked-example",
    purpose: "Reason through two or three steps, hold the conclusion",
    colors: palettes.minimalLight,
    entrance: "fade",
    caption: "caption.phrase",
    editorialRule:
      "Use scene.worked-example; verify each step; hold until spoken reasoning and reading finish. Split excess copy instead of shrinking.",
    optIn: true,
  },
  "product-walkthrough": {
    id: "product-walkthrough",
    purpose: "Readable supplied product evidence with action and outcome",
    colors: palettes.minimalLight,
    entrance: "fade",
    caption: "caption.phrase",
    editorialRule:
      "Use scene.product-walkthrough; preserve original UI; show an observed outcome, not an invented benefit. Review UI legibility in every format.",
    optIn: true,
  },
  "editorial-evidence": {
    id: "editorial-evidence",
    purpose: "Source-backed statement and explicitly separate interpretation",
    colors: palettes.darkTech,
    entrance: "fade",
    caption: "caption.phrase",
    editorialRule:
      "Use scene.editorial-evidence; preserve quotation context and source locator; sourceLabel is not source verification. Hold for reading.",
    optIn: true,
  },
  "minimal-product": {
    id: "minimal-product",
    purpose: "One product benefit with visible evidence",
    colors: palettes.minimalLight,
    entrance: "fade",
    caption: "caption.phrase",
    editorialRule: "Hold readable UI; cut when the user action changes",
    optIn: true,
  },
  "ugc-direct": {
    id: "ugc-direct",
    purpose: "Personal hook, demonstration and offer",
    colors: palettes.coralPop,
    entrance: "scale",
    caption: "caption.karaoke",
    editorialRule: "Speak plainly; prove the claim before CTA",
    optIn: true,
  },
  "educational-editorial": {
    id: "educational-editorial",
    purpose: "Explain, work an example, recap",
    colors: palettes.minimalLight,
    entrance: "fade",
    caption: "caption.phrase",
    editorialRule: "Hold diagrams while reasoning; leave time to read labels",
    optIn: true,
  },
  documentary: {
    id: "documentary",
    purpose: "Context and evidence with sourced archival coverage",
    colors: palettes.darkTech,
    entrance: "fade",
    caption: "caption.phrase",
    editorialRule: "Separate verified facts from interpretation; motivate each cut",
    optIn: true,
  },
  "music-led": {
    id: "music-led",
    purpose: "Beat-planned typography and visual motifs",
    colors: palettes.neonGradient,
    entrance: "scale",
    caption: "caption.keyword",
    editorialRule: "Use a planned beat map; do not imply automatic BPM detection",
    optIn: true,
  },
};
