import {
  ResourceCandidateSchema,
  ResourceRightsSchema,
  ResourceUsageSchema,
  type ResourceCandidate,
  type ResourceUsage,
  type ResourceRights,
} from "../../types/resources";

export function normalizeLicence(licence: string, url?: string): { code: string; version?: string } {
  const input = `${licence} ${url ?? ""}`.toLowerCase();
  if (/creativecommons\.org\/publicdomain\/zero\/|\bcc0\b|creative commons 0/.test(input))
    return { code: "CC0", version: "1.0" };
  if (/publicdomain\/mark\/|public domain mark|public domain|\bpdm\b/.test(input)) return { code: "PDM" };
  // Creative Commons terms win over a stock site's name appearing in a URL or title.
  const match = input.match(/(?:licenses\/|cc\s+)(by(?:-nc)?(?:-sa|-nd)?)(?:\/|\s+)([0-9.]+)/);
  if (match) return { code: `CC ${match[1].toUpperCase()}`, version: match[2] };
  if (/pexels/.test(input)) return { code: "Pexels" };
  // Image stock licences are recognised from the licence name only, never from a URL that mentions the site.
  const name = licence.trim().toLowerCase();
  if (/^unsplash(?: licen[cs]e)?$/.test(name)) return { code: "Unsplash" };
  if (/^pixabay(?: content)?(?: licen[cs]e)?$/.test(name)) return { code: "Pixabay" };
  return { code: "unknown" };
}
/** Stock licences that allow commercial use and edits without credit, each with its own conditions. */
const STOCK_RESTRICTIONS: Record<string, string[]> = {
  Pexels: ["No implied endorsement", "No standalone resale or stock redistribution"],
  Unsplash: [
    "No implied endorsement",
    "No sale of unaltered copies or stock redistribution",
    "No compiling images to replicate a similar or competing service",
  ],
  Pixabay: [
    "No implied endorsement",
    "No standalone sale or distribution",
    "No commercial use of depicted trademarks, logos or brands for goods or services",
    "No misleading use of recognisable people",
  ],
};
export const isStockLicence = (code: string) => code in STOCK_RESTRICTIONS;
export function rightsFromLicence(input: {
  licence: string;
  licenceUrl?: string;
  title: string;
  author: string;
  sourceUrl: string;
  verifiedAtSource?: boolean;
  checkedAsOf?: string;
}): ResourceRights {
  const normalized = normalizeLicence(input.licence, input.licenceUrl);
  const known = normalized.code !== "unknown",
    cc = normalized.code.startsWith("CC BY");
  return ResourceRightsSchema.parse({
    licence: normalized.code,
    licenceUrl: input.licenceUrl,
    version: normalized.version,
    commercialAllowed: known ? !normalized.code.includes("-NC") : "unknown",
    derivativesAllowed: known ? !normalized.code.includes("-ND") : "unknown",
    // Stock licences (Pexels, Unsplash, Pixabay) do not require credit; the text is kept for credit on request.
    attributionRequired: known ? cc : "unknown",
    shareAlike: normalized.code.includes("-SA"),
    attributionText:
      cc || isStockLicence(normalized.code)
        ? `${input.title} — ${input.author || "unknown author"}. ${input.sourceUrl}. ${normalized.code}${normalized.version ? ` ${normalized.version}` : ""}${input.licenceUrl ? ` (${input.licenceUrl})` : ""}.`
        : "",
    restrictions: STOCK_RESTRICTIONS[normalized.code] ?? [],
    evidenceUrl: input.sourceUrl,
    checkedAsOf: input.checkedAsOf ?? new Date().toISOString(),
    verifiedAtSource: input.verifiedAtSource ?? false,
  });
}
export function evaluateResourceUsage(candidateInput: ResourceCandidate, usageInput: ResourceUsage) {
  const candidate = ResourceCandidateSchema.parse(candidateInput),
    usage = ResourceUsageSchema.parse(usageInput),
    rights = candidate.rights;
  const blockers: string[] = [];
  if (!rights.verifiedAtSource) blockers.push("Licence requires confirmation at the original asset source.");
  if (rights.licence === "unknown") blockers.push("Licence is unknown.");
  if (usage.commercial && rights.commercialAllowed !== true)
    blockers.push("Commercial use is not confirmed/permitted.");
  if (usage.modified && rights.derivativesAllowed !== true) blockers.push("Modified use is not confirmed/permitted.");
  if (rights.shareAlike && usage.modified && !usage.acceptShareAlike)
    blockers.push("Modified use requires acceptance of ShareAlike obligations.");
  if (rights.attributionRequired === true && !candidate.author.trim())
    blockers.push("Required creator attribution is unavailable.");
  if (rights.attributionRequired !== false && !rights.attributionText.trim())
    blockers.push("Required attribution is missing.");
  if (
    rights.allowedPlacements.length &&
    usage.placements.some((placement) => !rights.allowedPlacements.includes(placement))
  )
    blockers.push("Requested placement is outside the licensed platforms.");
  if (isStockLicence(rights.licence) && (usage.endorsement || usage.standaloneResale))
    blockers.push(`${rights.licence} licence forbids this endorsement/standalone resale use.`);
  if (candidate.provider === "nasa" && (usage.advertising || usage.endorsement || usage.standaloneResale))
    blockers.push(
      "NASA catalogue route does not clear advertising, endorsement or standalone resale; obtain asset-specific permission outside this route.",
    );
  if (
    candidate.provider === "nasa" &&
    (!/\bNASA\b/i.test(rights.attributionText) || !rights.attributionText.includes(candidate.sourceUrl))
  )
    blockers.push("NASA source acknowledgement and the original asset page must be retained in credits.");
  // Credit text reaches release credits when the licence requires it or the user asked for credit.
  const credited = rights.attributionRequired === true || usage.credit;
  return {
    allowed: blockers.length === 0,
    blockers,
    attribution: credited ? rights.attributionText : "",
    creditText: rights.attributionText,
  };
}
export function confirmResourceLicence(
  candidateInput: ResourceCandidate,
  evidence: { sourceUrl: string; licence: string; licenceUrl?: string; author?: string; checkedAsOf?: string },
): ResourceCandidate {
  const candidate = ResourceCandidateSchema.parse(candidateInput);
  if (evidence.sourceUrl !== candidate.sourceUrl)
    throw new Error("Licence evidence must identify the original asset page.");
  const author = evidence.author ?? candidate.author;
  const rights = rightsFromLicence({ ...evidence, title: candidate.title, author, verifiedAtSource: true });
  if (candidate.provider === "nasa") {
    rights.attributionRequired = true;
    rights.attributionText = `${rights.attributionText}${rights.attributionText ? " " : ""}NASA source: ${candidate.sourceUrl}. Credit: ${author || "unresolved creator"}.`;
  }
  return ResourceCandidateSchema.parse({
    ...candidate,
    author,
    rights: {
      ...rights,
      allowedPlacements: candidate.rights.allowedPlacements,
      restrictions: candidate.rights.restrictions,
    },
  });
}
export function resourceLicenceReport(
  candidates: ResourceCandidate[],
  usage: ResourceUsage,
): { markdown: string; allowed: boolean; blockers: { id: string; reasons: string[] }[] } {
  const checked = candidates.map((candidate) => ({ candidate, review: evaluateResourceUsage(candidate, usage) }));
  const blockers = checked
    .filter((item) => !item.review.allowed)
    .map((item) => ({ id: item.candidate.id, reasons: item.review.blockers }));
  const credits = checked.map(({ candidate }) => candidate.rights.attributionText).filter(Boolean);
  const markdown = [
    "# Resource licensing report",
    "",
    ...checked.map(
      ({ candidate, review }) =>
        `- ${candidate.id}: ${review.allowed ? "allowed" : "blocked"} — ${candidate.rights.licence}; ${candidate.sourceUrl}${review.blockers.length ? `\n  ${review.blockers.join(" ")}` : ""}`,
    ),
    "",
    "## Credits",
    "",
    ...(credits.length ? credits.map((credit) => `- ${credit}`) : ["No attribution text supplied."]),
  ].join("\n");
  return { markdown, allowed: blockers.length === 0, blockers };
}
