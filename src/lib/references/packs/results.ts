/**
 * refs:pack --action result-board | review-result (RFC 0003 §10.3), generalised from model-preparation results:
 * results/<outputSha256>/{result.json, board.html, result-N.png, review-template.json, review.json}.
 */
import path from "node:path";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { assertPathWithin, CliErrorObject, ensureFfmpeg } from "../../cli";
import { hashFile, readAssetRegistry } from "../../assets/registry";
import { inspectAsset } from "../../assets/inspect";
import { preparationProject } from "../../model-preparation/storage";
import { runPreparationFfmpeg } from "../../model-preparation/prepare";
import { probeVideo } from "../../vision/media";
import { PackResultReviewSchema, type Modality, type PackResultReview } from "../../../types/references";
import { verifyPackSpeech } from "./speech";
import { profileByFamily } from "../profiles";
import { relativeSrc, resultBoard } from "./board";
import { packCharacterLinks } from "./consent";
import { immutablePackJson, immutablePackText, packFile, readPack } from "./storage";
import { packProducedOutput } from "./outputs";

const foreignResult = (id: string) =>
  `This result is not in pack ${id}'s outputs.json: generate:model did not publish it from this pack's request.`;

const invalid = (message: string) => new CliErrorObject({ code: "VALIDATION", message });
const HASH = /^[a-f0-9]{64}$/;
const packSpeechLines = (spec: ReturnType<typeof readPack>["spec"]) => [
  ...(spec.nativeSpeech ?? []),
  ...spec.attachments.flatMap(({ speech }) => (speech?.kind === "performed-lines" ? speech.lines : [])),
];

export type PackResultRecord = {
  schemaVersion: 1;
  packSha256: string;
  outputSha256: string;
  /** Relative to the workspace root. */
  path: string;
  bytes: number;
  contentType: string;
  kind: "image" | "video" | "audio";
  assetId?: string;
};

function resultFile(projectId: string, file: string, rootDir: string): string {
  const resolved = path.resolve(rootDir, file);
  if (!existsSync(resolved) || !statSync(resolved).isFile())
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `Result not found: ${file}` });
  const real = realpathSync(resolved);
  // A result is a project asset or the project's renderer output, never another project or an arbitrary file.
  const roots = [preparationProject(projectId, rootDir), path.resolve(rootDir, "out", projectId)];
  const inside = roots.some((root) => {
    try {
      assertPathWithin(existsSync(root) ? realpathSync(root) : root, real);
      return true;
    } catch {
      return false;
    }
  });
  if (!inside)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `A pack result must be inside public/projects/${projectId}/ or out/${projectId}/.`,
    });
  return real;
}

/** Records the result, samples frames and writes the side-by-side board and a review template. Spend none. */
export function packResultBoard(projectId: string, id: string, result: string, rootDir = process.cwd()) {
  const pack = readPack(projectId, id, rootDir);
  const file = resultFile(projectId, result, rootDir);
  const outputSha256 = hashFile(file);
  const produced = packProducedOutput(projectId, { id, sha256: pack.packSha256 }, outputSha256, rootDir);
  const inspected = inspectAsset(file);
  const directory = packFile(projectId, id, `results/${outputSha256}`, rootDir);
  const recordFile = path.join(directory, "result.json");
  const asset = readAssetRegistry(projectId, rootDir).assets.find((row) => row.hash === outputSha256);
  const record: PackResultRecord = existsSync(recordFile)
    ? (JSON.parse(readFileSync(recordFile, "utf8")) as PackResultRecord)
    : {
        schemaVersion: 1,
        packSha256: pack.packSha256,
        outputSha256,
        path: path.relative(path.resolve(rootDir), file).split(path.sep).join("/"),
        bytes: statSync(file).size,
        contentType: inspected.mime,
        kind: inspected.kind,
        ...(asset ? { assetId: asset.id } : {}),
      };
  if (record.packSha256 !== pack.packSha256 || record.outputSha256 !== outputSha256)
    throw invalid("The stored result record belongs to another pack revision.");
  immutablePackJson(recordFile, record, "Result record");
  const video = inspected.kind === "video" ? probeVideo(file) : undefined;
  const frames: string[] = [];
  if (inspected.kind !== "audio") {
    ensureFfmpeg();
    const times = video
      ? [0, 0.5, 0.9].map((f) => Math.max(0, Math.min(video.durationSec - 1 / video.fps, video.durationSec * f)))
      : [undefined];
    times.forEach((seconds, index) => {
      const frame = path.join(directory, `result-${index + 1}.png`);
      if (!existsSync(frame))
        runPreparationFfmpeg([
          ...(seconds !== undefined ? ["-ss", String(seconds)] : []),
          "-i",
          file,
          "-frames:v",
          "1",
          "-vf",
          "scale=480:480:force_original_aspect_ratio=decrease",
          "-threads",
          "1",
          frame,
        ]);
      frames.push(frame);
    });
  }
  const byKey = new Map(pack.spec.attachments.map((a) => [a.requirementKey, a]));
  const board = resultBoard({
    id,
    packSha256: pack.packSha256,
    outputSha256,
    result: {
      src: relativeSrc(directory, file),
      contentType: inspected.mime,
      facts: [
        inspected.media.width && inspected.media.height ? `${inspected.media.width}×${inspected.media.height}` : "",
        video ? `${video.durationSec.toFixed(3)} s · ${Number(video.fps.toFixed(3))} fps` : "",
        inspected.mime,
      ]
        .filter(Boolean)
        .join(" · "),
    },
    frames: frames.map((frame) => path.basename(frame)),
    attachments: pack.receipt.attachments.map((a) => {
      const source = byKey.get(a.requirementKey)!;
      return { ...a, slot: source.slot, order: source.order, roleSentence: source.roleSentence };
    }),
    compiledPrompt: pack.receipt.compiledPrompt,
    boardDir: directory,
    publicDir: path.resolve(rootDir, "public"),
  });
  const boardFile = path.join(directory, "board.html");
  immutablePackText(boardFile, board, "Result board");
  const templateFile = path.join(directory, "review-template.json");
  const lines = packSpeechLines(pack.spec);
  immutablePackJson(templateFile, {
    schemaVersion: 1,
    packSha256: pack.packSha256,
    outputSha256,
    reviewer: "FILL",
    evidence: "FILL after reviewing the whole result next to the attachments",
    identity: "FILL pass|fail|not-applicable",
    wardrobe: "FILL pass|fail|not-applicable",
    preserved: "FILL pass|fail",
    otherSubjects: "FILL pass|fail|not-applicable",
    motion: "FILL pass|fail|not-applicable",
    naturalness: "FILL pass|fail",
    promptFit: "FILL pass|fail",
    temporalConsistency: "FILL pass|fail",
    audio: "FILL pass|fail|replace-in-edit",
    ...(lines.length
      ? {
          speech: lines.map(({ lineId }) => ({
            lineId,
            words: "FILL pass|fail",
            speaker: "FILL pass|fail",
            sync: "FILL pass|fail|not-applicable",
            evidence: "FILL after reviewing the speech",
          })),
        }
      : {}),
    verdict: "FILL pass|repair|reshoot",
  });
  return {
    packSha256: pack.packSha256,
    outputSha256,
    result: record,
    board: boardFile,
    frames,
    reviewTemplate: templateFile,
    ...(video ? { measurements: video } : {}),
    producedByPack: produced,
    warnings: produced ? [] : [foreignResult(id)],
  };
}

/**
 * Records results/<outputSha256>/review.json. The schema refuses a pass with a failed dimension; here: the review is
 * for this pack and these exact result bytes (result-board ran and the file is unchanged), a character attachment
 * needs an identity verdict, the result is in the pack's outputs.json (or explicitly allowed as foreign), declared other subjects need a verdict, replace-in-edit audio needs that audio policy,
 * and identity similarity names attachment hashes. Immutable per output.
 */
export function reviewPackResult(
  projectId: string,
  id: string,
  input: unknown,
  rootDir = process.cwd(),
  options: { allowForeignResult?: boolean } = {},
) {
  const pack = readPack(projectId, id, rootDir);
  verifyPackSpeech(projectId, pack.spec, rootDir);
  const parsed = PackResultReviewSchema.safeParse(input);
  if (!parsed.success)
    throw invalid(
      `Result review is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  const review: PackResultReview = parsed.data;
  if (review.packSha256 !== pack.packSha256) throw invalid("The result review refers to another pack hash.");
  if (!HASH.test(review.outputSha256)) throw invalid("Invalid output hash.");
  const recordFile = packFile(projectId, id, `results/${review.outputSha256}/result.json`, rootDir);
  if (!existsSync(recordFile))
    throw new CliErrorObject({
      code: "STAGE_INCOMPLETE",
      message: `Run refs:pack --action result-board --id ${id} --result FILE for this output first.`,
    });
  const record = JSON.parse(readFileSync(recordFile, "utf8")) as PackResultRecord;
  const file = resultFile(projectId, record.path, rootDir);
  if (record.packSha256 !== pack.packSha256 || hashFile(file) !== review.outputSha256)
    throw invalid("The reviewed result bytes changed since the result board.");
  // A result review is evidence about this pack only when this pack produced the result (RFC 0003 §6.5, WP6).
  const produced = packProducedOutput(projectId, { id, sha256: pack.packSha256 }, review.outputSha256, rootDir);
  if (!produced && !options.allowForeignResult)
    throw invalid(`${foreignResult(id)} Pass --allow-foreign-result only for a result made from this pack elsewhere.`);
  const profile = profileByFamily(pack.spec.profileFamily);
  const modalities: Record<string, Modality> = Object.fromEntries(
    pack.spec.attachments.map((a) => [
      a.requirementKey,
      profile?.slots.find((slot) => slot.id === a.slot)?.modality ?? "image",
    ]),
  );
  const registry = readAssetRegistry(projectId, rootDir).assets;
  const characters = packCharacterLinks(projectId, pack.spec, modalities, registry, rootDir);
  if (
    [...characters.values()].some((links) => links.some((l) => l.as === "likeness")) &&
    review.identity === "not-applicable"
  )
    throw invalid("The pack shows a character; review identity (pass or fail), not not-applicable.");
  if (pack.spec.prompt.otherSubjects.length && review.otherSubjects === "not-applicable")
    throw invalid("The pack declares other subjects; review them (pass or fail).");
  if (review.audio === "replace-in-edit" && pack.spec.audioPolicy !== "replace-in-edit")
    throw invalid("Audio replace-in-edit differs from the pack's audio policy.");
  const lineIds = packSpeechLines(pack.spec)
    .map((line) => line.lineId)
    .sort();
  if (JSON.stringify(lineIds) !== JSON.stringify((review.speech ?? []).map((line) => line.lineId).sort()))
    throw invalid("Review the words, speaker and sync of every bound speech line exactly once.");
  if (lineIds.length && review.verdict === "pass") {
    if (pack.spec.audioPolicy !== "replace-in-edit" && !inspectAsset(file).media.hasAudio)
      throw invalid("A result owning the shot's speech must contain audible media");
    if (profile?.speechInput === "drive" && review.speech?.some((line) => line.sync !== "pass"))
      throw invalid("Every audio-driven line needs a passing lip-sync review");
  }
  const attachmentHashes = new Set(pack.receipt.attachments.map((a) => a.media.sha256));
  if (review.identitySimilarity?.some((row) => !attachmentHashes.has(row.attachmentSha256)))
    throw invalid("Identity similarity must name attachment hashes of this pack.");
  const reviewFile = packFile(projectId, id, `results/${review.outputSha256}/review.json`, rootDir);
  immutablePackJson(reviewFile, review, "Result review");
  return {
    file: reviewFile,
    review,
    producedByPack: produced,
    nextAction:
      review.verdict === "reshoot"
        ? "Ask the user before a new paid attempt (reshoot)."
        : review.verdict === "repair"
          ? "Repair (a derivative, a new pack revision or an edit) and review the new result."
          : "Continue with the edit and delivery checks.",
  };
}
