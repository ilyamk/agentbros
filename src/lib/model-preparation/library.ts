import path from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { assertPathWithin, CliErrorObject } from "../cli";
import { readAssetRegistry } from "../assets/registry";
import { MotionCandidateSchema, type MotionCandidate } from "../../types/model-preparation";
import { immutablePreparationJson, preparationProject } from "./storage";
import { readRemoteMedia } from "../assets/remote-media";

export const motionSources = () => ({
  higgsfield: {
    search: "https://higgsfield.ai/genjutsu-create",
    catalogueApi: "unverified",
    acquisition:
      "hf:media resolves exposed public file links or static page metadata; otherwise use an authorised original URL/export. No automatic Motion Library feed.",
    checkedAt: "2026-11-16",
  },
  tiktok: {
    search: "https://ads.tiktok.com/creative/creativeCenter/trends/video",
    acquisition: "Select a public post, check rights and use media:fetch within an authorised acquisition budget.",
  },
  local: {
    acquisition:
      "Reuse approved imported originals; motion:library records candidates and never grants rights or spends money.",
  },
});
export function addMotionCandidate(projectId: string, input: unknown, rootDir = process.cwd(), now = new Date()) {
  const candidate = MotionCandidateSchema.parse(input),
    project = preparationProject(projectId, rootDir);
  if (Date.parse(candidate.observedAt) > now.getTime() + 60_000)
    throw new CliErrorObject({ code: "VALIDATION", message: "Trend observation cannot be in the future." });
  if (
    candidate.assetId &&
    !readAssetRegistry(projectId, rootDir).assets.some(
      (asset) => asset.id === candidate.assetId && asset.kind === "video",
    )
  )
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Candidate assetId must be an imported video in this project.",
    });
  if (candidate.remoteMedia) {
    const data = readRemoteMedia(projectId, candidate.remoteMedia, rootDir);
    if (
      data.asset.id !== candidate.assetId ||
      data.asset.kind !== "video" ||
      ![data.receipt.sourceUrl, data.receipt.mediaUrl].includes(candidate.sourceUrl)
    )
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Candidate must match its remote video receipt and source URL.",
      });
  }
  const file = path.join(project, "pipeline/motion-library", `${candidate.id}.json`);
  assertPathWithin(project, file);
  immutablePreparationJson(file, candidate);
  return { file, candidate };
}
export function searchMotionCandidates(
  projectId: string,
  options: { query?: string; category?: string; market?: string; maxAgeDays?: number; now?: Date } = {},
  rootDir = process.cwd(),
) {
  const project = preparationProject(projectId, rootDir),
    directory = path.join(project, "pipeline/motion-library");
  assertPathWithin(project, directory);
  const maxAge = options.maxAgeDays ?? 7;
  if (!Number.isFinite(maxAge) || maxAge <= 0)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "max-age-days must be positive." });
  const now = options.now ?? new Date(),
    terms = (options.query ?? "").toLowerCase().split(/\s+/u).filter(Boolean);
  const candidates: MotionCandidate[] = !existsSync(directory)
    ? []
    : readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .map((name) => {
          const file = path.join(directory, name);
          assertPathWithin(project, file);
          return MotionCandidateSchema.parse(JSON.parse(readFileSync(file, "utf8")));
        });
  return candidates
    .map((candidate) => {
      const ageDays = (now.getTime() - Date.parse(candidate.observedAt)) / 86_400_000;
      return {
        ...candidate,
        ageDays,
        fresh: ageDays >= 0 && ageDays <= maxAge,
        acquisitionNext: candidate.assetId
          ? {
              command: "model:prepare",
              sourceAssetId: candidate.assetId,
              ...(candidate.remoteMedia ? { remoteSource: candidate.remoteMedia } : {}),
            }
          : candidate.acquisition === "public-link"
            ? {
                command: "hf:media",
                argv: ["--action", "resolve", "--url", candidate.sourceUrl, "--kind", "video"],
                note: "Resolve exposed original links; inspect acquisition and permissions before preparing.",
              }
            : candidate.acquisition === "public-post"
              ? {
                  command: "media:fetch",
                  argv: ["--project", projectId, "--url", candidate.sourceUrl, "--dry-run"],
                  note: "Inspect supported platform, acquisition budget and original quality; rights remain separate.",
                }
              : {
                  command: null,
                  note:
                    candidate.acquisition === "manual-export"
                      ? "Obtain an authorised original export, asset:import it, then add a new candidate revision."
                      : "Original unavailable; select another candidate or obtain an authorised recording.",
                },
      };
    })
    .filter(
      (candidate) =>
        candidate.fresh &&
        (!options.category || candidate.category === options.category) &&
        (!options.market || candidate.market === options.market) &&
        terms.every((term) =>
          `${candidate.title} ${candidate.category} ${candidate.tags.join(" ")}`.toLowerCase().includes(term),
        ),
    )
    .sort((a, b) => a.ageDays - b.ageDays || a.id.localeCompare(b.id, "en"));
}
