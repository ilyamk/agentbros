import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject } from "../cli";
import { readSource, referenceDirectory } from "../reference/library";
import { MUSIC_PATHS, MusicSearchFileSchema, type MusicHit } from "./types";

export type ReferenceStatement = { rights?: "owned" | "licensed"; note?: string; commercial?: boolean };

/** Rights come from source.json or the user's statement; a claim without the user's words is refused. */
export function referenceHit(
  referenceId: string,
  source: { status: "unknown" | "owned" | "licensed" | "study-only"; note?: string; url?: string; durationSec: number },
  statement: ReferenceStatement,
  verifiedAt: string,
): MusicHit {
  if (statement.rights && !statement.note?.trim())
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--rights needs --rights-note with the user's own statement of who holds the rights.",
    });
  const status = statement.rights ?? source.status;
  const note = statement.rights ? statement.note : source.note;
  const cleared = status === "owned" || status === "licensed";
  const commercial: MusicHit["licence"]["commercial"] = !cleared
    ? status === "study-only"
      ? "no"
      : "unknown"
    : status === "owned" || statement.commercial
      ? "yes"
      : "unknown";
  return {
    id: `reference:${referenceId}`,
    route: "reference-track",
    provider: "reference",
    title: `Audio of reference ${referenceId}`,
    ...(source.url ? { sourceUrl: source.url } : {}),
    durationSec: source.durationSec,
    licence: {
      code: status === "unknown" ? "unknown" : `reference-${status}`,
      commercial,
      ...(cleared ? { verifiedAt } : {}),
    },
    acquisition: "local",
    acquisitionNote: cleared
      ? "Rights as recorded; the delivery guard reads them."
      : "Study only: read its rhythm and structure. Embedding is blocked until the user states rights.",
    instrumental: "unknown",
    tags: [],
    sourceVerified: false,
    syncAllowed: cleared,
    shareAlike: false,
    statedRights: { status, ...(note ? { note } : {}), statedBy: statement.rights ? "user" : "source.json" },
  };
}

export function extractReferenceAudio(
  projectDir: string,
  referenceId: string,
  libraryRoot: string,
  statement: ReferenceStatement,
  now = new Date().toISOString(),
) {
  const { source, media } = readSource(referenceDirectory(libraryRoot, referenceId));
  if (!source.probe.hasAudio)
    throw new CliErrorObject({ code: "VALIDATION", message: `Reference ${referenceId} has no audio stream.` });
  const hit = referenceHit(
    referenceId,
    {
      status: source.rights.status,
      note: source.rights.note,
      url: source.origin.url,
      durationSec: source.probe.durationSec,
    },
    statement,
    now,
  );
  const relative = path.join(MUSIC_PATHS.reference, `${referenceId}.wav`),
    target = path.join(projectDir, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  const result = spawnSync(
    "ffmpeg",
    ["-v", "error", "-nostdin", "-y", "-i", media, "-map", "0:a:0", "-vn", "-c:a", "pcm_s16le", target],
    { encoding: "utf8", timeout: 600_000 },
  );
  if (result.status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `Audio extraction failed: ${result.stderr?.slice(-400) ?? "no output"}`,
    });
  const candidate: MusicHit = { ...hit, previewPath: relative };
  const cleared = hit.statedRights?.status === "owned" || hit.statedRights?.status === "licensed";
  const searchFile = path.join(projectDir, "pipeline/music", `search-reference-${referenceId}.json`);
  writeFileSync(
    searchFile,
    `${JSON.stringify(MusicSearchFileSchema.parse({ schemaVersion: 1, kind: "reference", brief: `reference ${referenceId}`, candidates: [candidate] }), null, 2)}\n`,
  );
  return {
    candidate,
    wav: target,
    searchFile,
    delivery: cleared ? ("embedded" as const) : ("study-only" as const),
    embeddingBlocked: !cleared,
  };
}
