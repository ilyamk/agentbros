import { FRAME_ASPECT } from "../../photo/crop";
import type { ResourceCandidate } from "../../../types/resources";
import { resolutionFit } from "./resolution";
import type { StockColour, StockFilters } from "./types";

export type RankedCandidate = {
  candidate: ResourceCandidate;
  score: number;
  reasons: string[];
  /** Position in its provider's own response (0 = the provider's best match). */
  position: number;
  /** Why the candidate cannot fill the requested frame; it is listed, never silently dropped. */
  blocked?: string;
};

const REFERENCE: Record<Exclude<StockColour, "black_and_white">, [number, number, number]> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  gray: [128, 128, 128],
  yellow: [230, 198, 25],
  orange: [230, 126, 34],
  red: [192, 57, 43],
  purple: [142, 68, 173],
  pink: [232, 67, 147],
  green: [39, 174, 96],
  teal: [22, 160, 133],
  blue: [41, 128, 185],
  brown: [139, 90, 43],
};

const tokens = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 3),
  );

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** 0..1 closeness of a dominant colour to the named colour; black-and-white rewards low saturation. */
export function colourCloseness(hex: string, colour: StockColour): number {
  const [r, g, b] = rgb(hex);
  if (colour === "black_and_white") {
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b);
    return max === 0 ? 1 : 1 - (max - min) / max;
  }
  const [R, G, B] = REFERENCE[colour];
  return 1 - Math.hypot(r - R, g - G, b - B) / Math.hypot(255, 255, 255);
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Deterministic ranking for a frame: resolution against the format and push-in, aspect against the frame,
 * words of the query found in title/tags/description, dominant colour when one was asked for, and the
 * provider's own relevance order (each provider's response order, read from the input order per provider).
 */
export function rankCandidates(
  candidates: readonly ResourceCandidate[],
  query: string,
  filters: Pick<StockFilters, "format" | "zoom" | "color" | "orientation">,
  providerOrder: readonly string[] = [],
): RankedCandidate[] {
  const wanted = tokens(query);
  const seen = new Set<string>();
  const ranked: RankedCandidate[] = [];
  const counts = new Map<string, number>();
  for (const candidate of candidates) counts.set(candidate.provider, (counts.get(candidate.provider) ?? 0) + 1);
  const positions = new Map<string, number>();
  for (const candidate of candidates) {
    const position = positions.get(candidate.provider) ?? 0;
    positions.set(candidate.provider, position + 1);
    if (seen.has(candidate.sourceUrl)) continue;
    seen.add(candidate.sourceUrl);
    const parts: { weight: number; value: number }[] = [];
    const reasons: string[] = [];
    let blocked: string | undefined;
    if (filters.format) {
      const fit = resolutionFit(candidate.media, filters.format, filters.zoom ?? 1);
      if (fit.status === "too-small") {
        blocked = `resolution: needs ${fit.upscale}x enlargement for ${filters.format} at zoom ${filters.zoom ?? 1}`;
        parts.push({ weight: 0.35, value: 0 });
      } else if (fit.status === "ideal") {
        parts.push({ weight: 0.35, value: 1 });
        reasons.push("resolution fills the frame without enlargement");
      } else if (fit.status === "acceptable") {
        parts.push({ weight: 0.35, value: 1 - ((fit.upscale! - 1) / 0.5) * 0.6 });
        reasons.push(`resolution needs ${fit.upscale}x enlargement`);
      } else {
        parts.push({ weight: 0.35, value: 0.5 });
        reasons.push("resolution unknown");
      }
      if (candidate.media.width && candidate.media.height) {
        const ratio = candidate.media.width / candidate.media.height / FRAME_ASPECT[filters.format];
        const value = Math.max(0, 1 - Math.abs(Math.log(ratio)) / Math.log(3));
        parts.push({ weight: 0.25, value });
        if (value > 0.9) reasons.push(`aspect matches ${filters.format}`);
        else if (value < 0.5) reasons.push(`aspect far from ${filters.format}; heavy crop`);
      }
    }
    if (wanted.size) {
      const found = tokens([candidate.title, candidate.tags.join(" "), candidate.details?.description ?? ""].join(" "));
      const matched = [...wanted].filter((word) => found.has(word));
      parts.push({ weight: 0.3, value: matched.length / wanted.size });
      if (matched.length) reasons.push(`matches: ${matched.join(", ")}`);
    }
    if (filters.color && candidate.visual?.dominantColor) {
      const value = colourCloseness(candidate.visual.dominantColor, filters.color);
      parts.push({ weight: 0.1, value });
      reasons.push(`dominant ${candidate.visual.dominantColor} (${Math.round(value * 100)}% ${filters.color})`);
    }
    // The provider already ranked by meaning; its order is a light signal and breaks near-ties.
    parts.push({ weight: 0.05, value: 1 - position / Math.max(1, counts.get(candidate.provider)!) });
    const weight = parts.reduce((sum, part) => sum + part.weight, 0);
    const score = weight ? parts.reduce((sum, part) => sum + part.weight * part.value, 0) / weight : 0;
    ranked.push({ candidate, score: round(score), reasons, position, ...(blocked ? { blocked } : {}) });
  }
  const order = (provider: string) => {
    const index = providerOrder.indexOf(provider);
    return index < 0 ? providerOrder.length : index;
  };
  return ranked.sort(
    (a, b) =>
      Number(Boolean(a.blocked)) - Number(Boolean(b.blocked)) ||
      b.score - a.score ||
      order(a.candidate.provider) - order(b.candidate.provider) ||
      a.position - b.position ||
      a.candidate.id.localeCompare(b.candidate.id),
  );
}
