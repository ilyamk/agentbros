import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { EarshotRequestSchema, EarshotSegmentSchema } from "../../types/earshot";
import { assertPathWithin, CliErrorObject, ensureFfmpeg, ensureFfprobe } from "../cli";
import { inspectAsset } from "../assets/inspect";
import { importAsset, hashFile } from "../assets/registry";
import { immutableWrite, digest } from "../jobs/model-artifacts";
import { claimOperationWork } from "../jobs/work-lease";
import { regularInput, projectOutput, jsonHash } from "../elevenlabs/files";
import { earshotStatus, runEarshotWorker, EARSHOT_SHA, EARSHOT_CLAP_SHA } from "./earshot-runtime";
import { analyzeAudio } from "./analysis";
import type { LibrarySound } from "./cue-sounds";

type Options = { rootDir?: string; scopeRoot?: string; engineRoot?: string; projectId?: string; output?: string };
const CONTAINED_FORMATS = "aac,aiff,amr,asf,avi,caf,flac,matroska,mov,mp3,mpeg,mpegts,ogg,wav,webm";
const ANALYSIS_PREPROCESSING = "ffmpeg-contained-pcm16-stereo-48k-clock-v3";
const NOTICE =
  "Model similarities and artifact sensors are advisory. The user judges sound, music and creative quality.";

export function decodeEarshotInput(input: ReturnType<typeof regularInput>, directory: string, start = 0, end?: number) {
  ensureFfmpeg();
  ensureFfprobe();
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-format_whitelist",
      CONTAINED_FORMATS,
      "-show_format",
      "-of",
      "json",
      input.file,
    ],
    { timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
  );
  if (probe.error || probe.status !== 0)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message:
        "Earshot requires a supported self-contained media container; playlists and external segment references are not accepted",
    });
  const media = inspectAsset(input.file);
  if (!media.media.hasAudio) throw Error("Input has no audio stream");
  const duration = media.media.durationSec!,
    stop = end ?? duration;
  if (start >= stop || stop > duration + 0.05 || stop - start > 600)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Analyse at most 600 seconds; supply a valid start/end range for a longer recording",
    });
  const key = jsonHash({ source: input.sha256, start, end: stop, preprocessing: ANALYSIS_PREPROCESSING });
  const cache = path.join(directory, "cache/studio-analysis");
  assertPathWithin(directory, cache);
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const file = path.join(cache, `${key}.wav`),
    receipt = `${file}.json`;
  const current = () => {
    try {
      return (
        existsSync(file) &&
        lstatSync(file).isFile() &&
        !lstatSync(file).isSymbolicLink() &&
        JSON.parse(readFileSync(receipt, "utf8")).sha256 === hashFile(file)
      );
    } catch {
      return false;
    }
  };
  if (!current()) {
    const release = claimOperationWork({ file: path.join(cache, "state.json") }, key);
    if (!release)
      throw new CliErrorObject({
        code: "STAGE_INCOMPLETE",
        message: "Another worker is decoding this source; resume after it finishes",
      });
    const temporary = path.join(cache, `${key}.tmp.wav`);
    try {
      if (!current()) {
        const result = spawnSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-nostdin",
            "-y",
            "-protocol_whitelist",
            "file,pipe",
            "-copyts",
            "-start_at_zero",
            "-format_whitelist",
            CONTAINED_FORMATS,
            "-i",
            input.file,
            "-ss",
            String(start),
            "-t",
            String(stop - start),
            "-map",
            "0:a:0",
            "-vn",
            "-af",
            "aresample=async=1:first_pts=0",
            "-c:a",
            "pcm_s16le",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-f",
            "wav",
            temporary,
          ],
          { encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
        );
        if (result.error || result.status !== 0)
          throw new CliErrorObject({
            code: "FFMPEG_FAILED",
            message: "Safe local PCM decoding failed; network media protocols are forbidden",
          });
        if (hashFile(input.file) !== input.sha256) throw Error("Source changed during analysis decoding");
        renameSync(temporary, file);
        writeFileSync(
          receipt,
          JSON.stringify({ sha256: hashFile(file), sourceSha256: input.sha256, start, end: stop }),
        );
        const rows = readdirSync(cache)
          .filter((name) => /^[a-f0-9]{64}\.wav$/.test(name))
          .map((name) => ({ file: path.join(cache, name), stat: lstatSync(path.join(cache, name)) }))
          .filter((row) => row.stat.isFile())
          .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
        let bytes = rows.reduce((sum, row) => sum + row.stat.size, 0),
          count = rows.length;
        for (const row of rows)
          if (row.file !== file && (bytes > 1024 ** 3 || count > 32)) {
            rmSync(row.file);
            rmSync(`${row.file}.json`, { force: true });
            bytes -= row.stat.size;
            count--;
          }
      }
    } finally {
      rmSync(temporary, { force: true });
      release();
    }
  }
  return { file, startSec: start, endSec: stop, sourceDurationSec: duration };
}

export async function earshot(raw: unknown, options: Options = {}) {
  const request = EarshotRequestSchema.parse(raw),
    root = path.resolve(options.rootDir ?? process.cwd());
  const status = earshotStatus(options.engineRoot, request.action === "find");
  if (!status.available)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${status.reason}. ${status.fix}`,
      details: { fix: status.fix, available: false },
    });
  if (request.action === "list")
    return {
      outputs: [],
      metadata: {
        ...runEarshotWorker(request, options.engineRoot),
        engine: "earshot",
        packageSha: EARSHOT_SHA,
        notice: NOTICE,
      },
    };
  if (request.action === "render") {
    if (!options.projectId || !options.output)
      throw Error("Earshot rendering requires project and a new project-local output");
    const target = projectOutput(root, options.projectId, options.output);
    if (path.extname(target.file) !== ".wav") throw Error("Earshot bank output must use .wav");
    const inputHash = jsonHash({ request, identityHash: status.identityHash });
    const receiptFile = `${target.file}.take.json`;
    if (existsSync(receiptFile)) {
      const saved = JSON.parse(readFileSync(receiptFile, "utf8"));
      if (saved.inputHash !== inputHash || !existsSync(target.file) || hashFile(target.file) !== saved.sha256)
        throw Error("Existing Earshot take differs from its immutable input/bytes");
      return {
        outputs: [target.file, receiptFile],
        metadata: { state: "published", take: saved, replay: true, notice: NOTICE },
      };
    }
    const directory = mkdtempSync(path.join(tmpdir(), "earshot-take-"));
    try {
      const output = path.join(directory, "take.wav");
      const { cueKind, alignTo, ...renderRequest } = request;
      const result = runEarshotWorker({ ...renderRequest, output }, options.engineRoot);
      const media = inspectAsset(output);
      if (media.kind !== "audio" || !media.media.hasAudio) throw Error("Earshot produced no valid audio");
      const meta = z
        .object({
          onset_s: z.number().nonnegative(),
          peak_s: z.number().nonnegative(),
          end_s: z.number().nonnegative(),
          dur_s: z.number().positive(),
          seed: z.number().int(),
        })
        .passthrough()
        .parse(result.meta);
      if (
        meta.onset_s > meta.end_s ||
        meta.peak_s > meta.dur_s ||
        Math.abs(meta.dur_s - media.media.durationSec!) > 0.05
      )
        throw Error("Earshot measured timing does not match its audio");
      const bytes = readFileSync(output);
      const source = result.source as { license?: string; url?: string; author?: string } | undefined;
      const imported = importAsset({
        rootDir: root,
        projectId: options.projectId,
        sourceFile: output,
        provenance: {
          origin: "provider",
          tool: `earshot:${request.sound}`,
          model: EARSHOT_SHA,
          billing: { status: "unknown" },
        },
        rights: source
          ? {
              licence: source.license ?? "unknown",
              sourceUrl: source.url,
              attribution: source.author,
              commercialAllowed: "unknown",
            }
          : { licence: "Procedural synthesis; Earshot code MIT", commercialAllowed: true, attributionRequired: false },
      });
      const take = {
        version: 1,
        inputHash,
        provider: "earshot",
        packageSha: EARSHOT_SHA,
        bankVersion: result.bankVersion,
        request,
        ...(cueKind ? { cueKind } : {}),
        sha256: digest(bytes),
        assetId: imported.asset.id,
        src: imported.asset.files.original,
        alignSec: alignTo === "onset" ? meta.onset_s : alignTo === "end" ? meta.end_s : meta.peak_s,
        onsetSec: meta.onset_s,
        peakSec: meta.peak_s,
        endSec: meta.end_s,
        generatorLicence: "MIT",
        source: result.source ?? null,
        measured: meta,
        independentMeasurements: analyzeAudio(output),
        notice: NOTICE,
      };
      immutableWrite(target.file, bytes);
      immutableWrite(receiptFile, `${JSON.stringify(take, null, 2)}\n`);
      return { outputs: [target.file, receiptFile], metadata: { state: "published", take, notice: NOTICE } };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const input = regularInput(root, request.input, options.scopeRoot ?? root);
  const decoded = decodeEarshotInput(
    input,
    status.directory,
    request.action === "find" ? request.start : 0,
    request.action === "find" ? request.end : undefined,
  );
  const workerRequest =
    request.action === "find"
      ? { action: "find", input: decoded.file, query: request.query, top: request.top, kind: request.kind }
      : { action: "check", input: decoded.file };
  const result = runEarshotWorker(workerRequest, options.engineRoot);
  if (hashFile(input.file) !== input.sha256) throw Error("Original audio changed during analysis");
  const segments =
    request.action === "find"
      ? z
          .array(EarshotSegmentSchema)
          .max(request.top)
          .parse(result.segments)
          .map((segment) => {
            if (segment.end > decoded.endSec - decoded.startSec + 0.05) throw Error("Segment exceeds its source range");
            return { ...segment, start: segment.start + decoded.startSec, end: segment.end + decoded.startSec };
          })
      : undefined;
  const metadata = {
    preprocessing: ANALYSIS_PREPROCESSING,
    engine: "earshot",
    packageSha: EARSHOT_SHA,
    ...(request.action === "find"
      ? { modelRevision: EARSHOT_CLAP_SHA }
      : { independentMeasurements: analyzeAudio(input.file) }),
    identityHash: status.identityHash,
    source: { file: path.relative(root, input.file), sha256: input.sha256, durationSec: decoded.sourceDurationSec },
    analysedRange: { startSec: decoded.startSec, endSec: decoded.endSec },
    ...(segments ? { segments, query: request.action === "find" ? request.query : undefined } : {}),
    result,
    notice: NOTICE,
    advisory: true,
  };
  const outputs: string[] = [];
  if (options.output) {
    if (!options.projectId) throw Error("Saving Earshot evidence requires its project");
    const target = projectOutput(root, options.projectId, options.output);
    immutableWrite(target.file, `${JSON.stringify(metadata, null, 2)}\n`);
    outputs.push(target.file);
  }
  return { outputs, metadata };
}

/** Existing cue planning owns placement, gain and budgets; generated takes are measured library inputs. */
export function earshotLibrarySounds(files: string[], projectId: string, root = process.cwd()): LibrarySound[] {
  const kinds = z.enum(["sub-drop", "hit", "riser", "whoosh", "click", "tick", "pop", "glass", "chime"]);
  return files.map((file) => {
    const record = regularInput(root, file, root, 4 * 1024 * 1024);
    const take = z
      .object({
        provider: z.literal("earshot"),
        cueKind: kinds,
        src: z.string(),
        sha256: z.string(),
        alignSec: z.number().nonnegative(),
        onsetSec: z.number().nonnegative(),
        peakSec: z.number().nonnegative(),
        endSec: z.number().nonnegative(),
        measured: z.object({ dur_s: z.number().positive() }).passthrough(),
        independentMeasurements: z.object({ integratedLufs: z.number().nullable() }).passthrough(),
      })
      .passthrough()
      .parse(JSON.parse(readFileSync(record.file, "utf8")));
    const source = regularInput(root, path.join("public", take.src));
    assertPathWithin(path.join(root, "public/projects", projectId), source.file);
    if (source.sha256 !== take.sha256 || take.alignSec > take.measured.dur_s || take.endSec > take.measured.dur_s)
      throw Error("Earshot take changed or has invalid measured timing");
    return {
      kind: take.cueKind === "hit" ? "impact" : take.cueKind,
      file: take.src,
      durationSec: take.measured.dur_s,
      alignSec: take.alignSec,
      onsetSec: take.onsetSec,
      peakSec: take.peakSec,
      tailSec: Math.max(0, take.endSec - take.peakSec),
      dynamics: take.cueKind === "riser" ? "swell" : take.cueKind === "whoosh" ? "sweep" : "impulse",
      integratedLufs: take.independentMeasurements.integratedLufs,
    };
  });
}
