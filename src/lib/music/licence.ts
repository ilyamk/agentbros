import { normalizeLicence, rightsFromLicence } from "../resources/rights";
import type { MusicHit } from "./types";

export type TrackLicence = Pick<MusicHit, "licence" | "syncAllowed" | "shareAlike">;

/** Reads only a provider's licence fields, per track. Anything unrecognised stays `unknown`. */
export function classifyTrackLicence(input: {
  licence?: string;
  url?: string;
  title: string;
  creator?: string;
  sourceUrl: string;
  verifiedAt?: string;
}): TrackLicence {
  const text = input.licence ?? "";
  const url = input.url?.startsWith("http") ? input.url : undefined;
  const parsed = normalizeLicence(text, url);
  // Pexels/Unsplash/Pixabay image licences say nothing about music (Pixabay Music stays manual and unverified).
  const normal = ["Pexels", "Unsplash", "Pixabay"].includes(parsed.code)
    ? { code: "unknown", version: undefined }
    : parsed;
  const known = normal.code !== "unknown";
  const code = known ? `${normal.code}${normal.version ? ` ${normal.version}` : ""}` : "unknown";
  const attribution = known
    ? rightsFromLicence({
        licence: text,
        licenceUrl: url,
        title: input.title,
        author: input.creator ?? "",
        sourceUrl: input.sourceUrl,
      }).attributionText
    : "";
  return {
    licence: {
      code,
      ...(url ? { url } : {}),
      commercial: !known ? "unknown" : normal.code.includes("-NC") ? "no" : "yes",
      ...(attribution ? { attribution } : {}),
      ...(input.verifiedAt ? { verifiedAt: input.verifiedAt } : {}),
    },
    syncAllowed: known && !normal.code.includes("-ND"),
    shareAlike: normal.code.includes("-SA"),
  };
}

/** Usable in a commercial film: known, commercial and syncable. */
export const commerciallyUsable = (hit: Pick<MusicHit, "licence" | "syncAllowed">) =>
  hit.licence.commercial === "yes" && hit.syncAllowed;
