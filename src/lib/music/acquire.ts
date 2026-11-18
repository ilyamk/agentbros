import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { MusicShortlistSchema } from "../../types/film";
import { ResourceCandidateSchema, ResourceProviderIdSchema } from "../../types/resources";
import { importAsset } from "../assets/registry";
import { CliErrorObject } from "../cli";
import { evaluateResourceUsage, rightsFromLicence } from "../resources/rights";
import type { MusicHttp } from "./http";
import { classifyTrackLicence } from "./licence";
import { recheckLicence, type Credentials } from "./providers";
import { freesoundSourceId } from "../resources/openverse";
import { findMusicCandidate } from "./rights-guard";
import { MUSIC_PATHS, type MusicHit } from "./types";

export type AcquireOptions = {
  projectId: string;
  rootDir?: string;
  candidateId: string;
  commercial: boolean;
  acceptShareAlike?: boolean;
  sourceFile?: string;
  /** The exact licence page a person checked for this track. */
  confirmLicenceUrl?: string;
  http: MusicHttp;
  credentials: Credentials;
  /** Also copy the original to music/stock-<id>.<ext>, the project's music folder. */
  musicFile?: boolean;
};

/** The registry may keep an MP3 with cover art in another container; the music folder gets the audio stream as MP3. */
function writeMusicFile(source: string, target: string) {
  if (path.extname(source).toLowerCase() === ".mp3") return copyFileSync(source, target);
  const run = (codec: string[]) =>
    spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", source, "-map", "0:a:0", ...codec, target], {
      encoding: "utf8",
      timeout: 300_000,
    });
  if (run(["-c:a", "copy"]).status === 0) return;
  const encoded = run(["-c:a", "libmp3lame", "-q:a", "0"]);
  if (encoded.status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `Could not write the music file: ${encoded.stderr.trim().slice(-300)}`,
    });
}

/** music/stock-<provider>-<id>: short, stable and safe as a file name. */
export const stockFileName = (id: string, extension: string) =>
  `stock-${id
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 60)}${extension}`;

const CreditsSchema = z.object({
  schemaVersion: z.literal(1),
  credits: z.array(
    z.object({
      candidateId: z.string(),
      title: z.string(),
      creator: z.string().optional(),
      licence: z.string(),
      sourceUrl: z.string().optional(),
      text: z.string(),
    }),
  ),
});

function resourceCandidate(hit: MusicHit, verified: boolean) {
  const sourceUrl = hit.sourceUrl;
  if (!sourceUrl)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${hit.id} has no source page, so its licence has no evidence.`,
    });
  return ResourceCandidateSchema.parse({
    id: hit.id,
    provider: ResourceProviderIdSchema.parse(hit.provider),
    kind: "audio",
    title: hit.title,
    sourceUrl,
    author: hit.creator ?? "",
    acquisition: hit.acquisition === "direct" ? "original-source" : "manual",
    media: hit.durationSec ? { durationSec: hit.durationSec } : {},
    tags: hit.tags,
    rights: rightsFromLicence({
      licence: hit.licence.code,
      licenceUrl: hit.licence.url,
      title: hit.title,
      author: hit.creator ?? "",
      sourceUrl,
      verifiedAtSource: verified,
    }),
    cost: { status: "free" },
  });
}

function writeCredit(projectDir: string, hit: MusicHit, text: string): string {
  const target = path.join(projectDir, MUSIC_PATHS.credits);
  const current = existsSync(target)
    ? CreditsSchema.parse(JSON.parse(readFileSync(target, "utf8")))
    : { schemaVersion: 1 as const, credits: [] };
  const credits = [
    ...current.credits.filter((item) => item.candidateId !== hit.id),
    {
      candidateId: hit.id,
      title: hit.title,
      ...(hit.creator ? { creator: hit.creator } : {}),
      licence: hit.licence.code,
      ...(hit.sourceUrl ? { sourceUrl: hit.sourceUrl } : {}),
      text,
    },
  ];
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify({ schemaVersion: 1, credits }, null, 2)}\n`);
  return target;
}

/** The re-read licence and the original belong wherever the candidate is listed, because the guard reads them there. */
function updateStored(projectDir: string, hit: MusicHit, originalPath: string) {
  const update = <T extends { id: string }>(items: T[]) =>
    items.map((item) => (item.id === hit.id ? { ...item, licence: hit.licence, originalPath } : item));
  const shortlistPath = path.join(projectDir, MUSIC_PATHS.shortlist);
  if (existsSync(shortlistPath)) {
    const shortlist = MusicShortlistSchema.parse(JSON.parse(readFileSync(shortlistPath, "utf8")));
    writeFileSync(
      shortlistPath,
      `${JSON.stringify({ ...shortlist, candidates: update(shortlist.candidates) }, null, 2)}\n`,
    );
  }
  const directory = path.join(projectDir, "pipeline/music");
  for (const name of readdirSync(directory).filter((item) => /^search-.*\.json$/.test(item))) {
    const file = path.join(directory, name);
    const raw = JSON.parse(readFileSync(file, "utf8")) as { candidates?: { id: string }[] };
    if (raw.candidates?.some((item) => item.id === hit.id))
      writeFileSync(file, `${JSON.stringify({ ...raw, candidates: update(raw.candidates) }, null, 2)}\n`);
  }
}

/** Re-reads the licence, refuses what the use does not allow, then imports through the asset registry. */
export async function acquireMusic(options: AcquireOptions) {
  const rootDir = options.rootDir ?? process.cwd();
  const projectDir = path.resolve(rootDir, "public/projects", options.projectId);
  const stored = findMusicCandidate(projectDir, options.candidateId);
  if (!stored)
    throw new CliErrorObject({
      code: "FILE_NOT_FOUND",
      message: `Candidate ${options.candidateId} is in no pipeline/music/search-*.json file. Run music --action search or trending first.`,
    });
  if (stored.route === "trending-native")
    throw new CliErrorObject({
      code: "VALIDATION",
      message:
        "A trending track is never acquired or embedded. Cut to its preview and let the user add the sound on the platform.",
    });
  if (stored.route === "reference-track")
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "A reference track is extracted with music --action from-reference, not acquired.",
    });

  const check = await recheckLicence(options.http, stored, options.credentials);
  if (check.verified && stored.licence.code !== "unknown" && check.licence.licence.code !== stored.licence.code)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Licence changed at the source: search said ${stored.licence.code}, the source now says ${check.licence.licence.code}. Review this track before acquiring.`,
      details: { source: stored.sourceUrl },
    });
  let current = check.verified ? check.licence : undefined;
  if (options.confirmLicenceUrl && (!current || current.licence.commercial === "unknown")) {
    current = classifyTrackLicence({
      url: options.confirmLicenceUrl,
      title: stored.title,
      creator: stored.creator,
      sourceUrl: stored.sourceUrl ?? "",
      verifiedAt: options.http.now(),
    });
    if (current.licence.code === "unknown")
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `--confirm-licence-url is not a licence this project recognises: ${options.confirmLicenceUrl}`,
      });
  }
  if (!current)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Licence not confirmed at source: ${check.verified ? "" : check.reason}`,
      details: { source: stored.sourceUrl },
    });
  const hit: MusicHit = { ...stored, ...current };

  const usage = { commercial: options.commercial, modified: true, acceptShareAlike: options.acceptShareAlike ?? false };
  const resource = resourceCandidate(hit, true);
  const review = evaluateResourceUsage(resource, usage);
  const blockers = [
    ...review.blockers,
    ...(options.commercial && hit.licence.commercial !== "yes"
      ? [`Commercial use is ${hit.licence.commercial} for this route.`]
      : []),
  ];
  if (blockers.length)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Acquisition blocked: ${blockers.join(" ")}`,
      details: { blockers, source: stored.sourceUrl },
    });

  const headers: Record<string, string> = {};
  let url = hit.originalUrl;
  const freesoundId =
    hit.provider === "freesound"
      ? hit.id.split(":")[1]
      : hit.provider === "openverse" && hit.origin === "freesound" && hit.sourceUrl
        ? freesoundSourceId(hit.sourceUrl)
        : undefined;
  if (!options.sourceFile && freesoundId && options.credentials.freesoundOAuth) {
    url = `https://freesound.org/apiv2/sounds/${freesoundId}/download/`;
    headers.Authorization = `Bearer ${options.credentials.freesoundOAuth}`;
  }
  if (!options.sourceFile && !url)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message:
        `No automatic download for this track. ${hit.acquisitionNote ?? ""} Page: ${hit.sourceUrl ?? "none"}`.trim(),
      details: { source: hit.sourceUrl },
    });

  let temporary: string | undefined,
    sourceFile = options.sourceFile;
  try {
    if (!sourceFile) {
      temporary = mkdtempSync(path.join(tmpdir(), "music-acquire-"));
      sourceFile = path.join(temporary, path.basename(new URL(url!).pathname) || "track");
      writeFileSync(sourceFile, await options.http.bytes(url!, { headers, maxBytes: 250 * 1024 * 1024 }));
    }
    const imported = importAsset({
      projectId: options.projectId,
      sourceFile,
      rootDir,
      provenance: {
        origin: "stock",
        tool: `music:${hit.provider}:${hit.id}`,
        originalFilename: hit.title,
        billing: { status: "unknown" },
      },
      rights: {
        licence: hit.licence.code,
        commercialAllowed: resource.rights.commercialAllowed,
        attributionRequired: resource.rights.attributionRequired,
        attribution: resource.rights.attributionText,
        sourceUrl: hit.sourceUrl,
        checkedAsOf: options.http.now(),
      },
    });
    const originalPath = imported.asset.files.original;
    const receiptPath = path.join(
      projectDir,
      MUSIC_PATHS.receipts,
      `${createHash("sha256").update(hit.id).digest("hex").slice(0, 16)}.json`,
    );
    mkdirSync(path.dirname(receiptPath), { recursive: true });
    writeFileSync(
      receiptPath,
      `${JSON.stringify({ candidate: hit, usage, acquiredAt: options.http.now(), assetId: imported.asset.id, file: originalPath, manualFile: Boolean(options.sourceFile), confirmedBy: options.confirmLicenceUrl ?? "source API" }, null, 2)}\n`,
    );
    const creditText =
      resource.rights.attributionText ||
      `${hit.title}${hit.creator ? ` by ${hit.creator}` : ""}. ${hit.licence.code}. No attribution required. ${hit.sourceUrl ?? ""}`.trim();
    const credits = writeCredit(projectDir, hit, creditText);
    const relative = path.relative(projectDir, path.join(rootDir, "public", originalPath));
    updateStored(projectDir, hit, relative);
    let musicFile: string | undefined;
    if (options.musicFile) {
      musicFile = path.join("music", stockFileName(hit.id, ".mp3"));
      mkdirSync(path.join(projectDir, "music"), { recursive: true });
      writeMusicFile(path.join(projectDir, relative), path.join(projectDir, musicFile));
    }
    return {
      ...(musicFile ? { musicFile } : {}),
      originalPath: relative,
      assetId: imported.asset.id,
      duplicate: imported.duplicate,
      receiptPath,
      credits,
      creditText,
      licence: hit.licence,
    };
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
