import type { GenjutsuMode } from "../../types/model-preparation";
import { loadHiggsfieldRestylePresets } from "../models/hf-restyle-presets";

export const genjutsuEndpoint = (mode: GenjutsuMode): string => `higgsfield/genjutsu/${mode}/v1.0`;
export function genjutsuMode(endpoint: string, provider = "higgsfield"): GenjutsuMode | undefined {
  return provider === "higgsfield"
    ? (["object-swap", "motion-transfer", "restyle"] as const).find((mode) => endpoint === genjutsuEndpoint(mode))
    : undefined;
}
export function preparationProfile(mode: GenjutsuMode) {
  return {
    provider: "higgsfield",
    endpoint: genjutsuEndpoint(mode),
    mode,
    guide: "docs/higgsfield-prompting.md",
    reviewGuide: "docs/agent-vision.md",
    intent:
      mode === "object-swap"
        ? "Replace a selected person, face, outfit or object while preserving the rest of the shot."
        : mode === "motion-transfer"
          ? "Rebuild the scene from approved references while retaining the source movement and camera."
          : "Apply a current style preset while retaining the source motion and composition.",
    requirements: [
      "Imported source video or hf:media checked remote original; explicit segment and audio policy",
      "Approved version-pinned entity image references (optional for restyle)",
      "Unambiguous target, requested change and preserved elements",
      "Measured source, reference review board, source-use rights and explicit user approval",
    ],
    markers: {
      preferred: true,
      video: "@Video1",
      images: "@Image1, @Image2, …",
      evidence:
        "User-tested Genjutsu prompting convention; not a published API token contract. Markers bind one-based attachment order.",
    },
    ...(mode === "restyle" ? { presets: loadHiggsfieldRestylePresets() } : {}),
    nextCommands: [
      `pnpm model:prepare --project PROJECT --action prepare --spec SPEC.json`,
      "pnpm model:prepare --project PROJECT --action check --id PREPARATION",
    ],
  };
}
