import path from "node:path";
import { lstatSync, openSync, constants, closeSync, fstatSync, unlinkSync } from "node:fs";
import {
  RhythmAnalysisRequestSchema,
  RhythmEvidenceSchema,
  RHYTHM_PARAMETERS,
  RhythmClockSchema,
} from "../../types/rhythm-evidence";
import { RhythmReadContext, rhythmDigest } from "./rhythm-files";
import { RhythmPublisher } from "./rhythm-publisher";
import {
  createRhythmArtifactStage,
  RhythmArtifactStageCreationError,
  type RhythmArtifactStage,
  type TrustedRhythmArtifactStageFactory,
} from "./rhythm-artifact-stage";
import {
  createRhythmMetadataService,
  type TrustedRhythmMetadataService,
  type RhythmArtifactRole,
} from "./rhythm-artifact-metadata";
import { rhythmFaultText } from "./rhythm-faults";
import {
  createRhythmWorkspace,
  RhythmWorkspaceCreationError,
  type RhythmWorkspace,
  type TrustedRhythmWorkspaceFactory,
} from "./rhythm-workspace";
import { resolveRhythmTool, runRhythmTool, type RhythmProcessBounds } from "./rhythm-process";
import { validateRhythmClock } from "./rhythm-clock";
import { analyzeRhythmPcm } from "./rhythm-kernel";
import {
  selectedRhythmAsset,
  currentRhythmImplementations,
  rhythmArtifactKey,
  readRhythmEvidence,
  type TrustedRhythmRuntime,
} from "./rhythm-evidence";
const MiB = 1024 * 1024;
const defaults = {
  wholeMs: 90000,
  probeMs: 15000,
  decodeMs: 60000,
  stallMs: 10000,
  metadataBytes: 4 * MiB,
  sharedMetadataBytes: 8 * MiB,
  stderrBytes: 256 * 1024,
  sourceBytes: 64 * MiB,
  pcmBytes: 19200000,
  artifactBytes: 64 * MiB,
};
function integer(value: unknown, label: string) {
  if (typeof value !== "string" && typeof value !== "number") throw Error(`Rhythm missing ${label}`);
  if (!/^(0|[1-9]\d*)$/.test(String(value))) throw Error(`Rhythm invalid ${label}`);
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw Error(`Rhythm unsafe ${label}`);
  return n;
}
function noPriming(value: any) {
  for (const key of ["initial_padding", "trailing_padding", "codec_delay", "skip_samples", "discard_padding"])
    if (value[key] !== undefined && integer(value[key], key) !== 0)
      throw Error("Rhythm codec priming/padding unsupported");
  if (value.side_data_list !== undefined && (!Array.isArray(value.side_data_list) || value.side_data_list.length))
    throw Error("Rhythm codec side-data unsupported");
}
/** Full actual stream/frame metadata parser; never guesses terminal from container duration. */
export function parseRhythmProbe(streamsInput: unknown, framesInput: unknown) {
  const streams = (streamsInput as any)?.streams,
    frames = (framesInput as any)?.frames;
  if (
    !Array.isArray(streams) ||
    streams.length !== 1 ||
    !Array.isArray(frames) ||
    !frames.length ||
    frames.length > 30000
  )
    throw Error("Rhythm one audio stream/finite frames required");
  const stream = streams[0];
  if (stream.codec_type !== "audio") throw Error("Rhythm audio only");
  noPriming(stream);
  if (stream.start_pts !== undefined && integer(stream.start_pts, "start_pts") !== 0)
    throw Error("Rhythm zero stream origin required");
  const timebase = /^([1-9]\d*)\/([1-9]\d*)$/.exec(stream.time_base ?? "");
  if (!timebase) throw Error("Rhythm missing stream timebase");
  const clock = RhythmClockSchema.parse({
    version: 1,
    codec: stream.codec_name,
    sampleRate: integer(stream.sample_rate, "sample_rate"),
    channels: integer(stream.channels, "channels"),
    timebase: { num: integer(timebase[1], "timebase numerator"), den: integer(timebase[2], "timebase denominator") },
    terminalTick: integer(stream.duration_ts, "duration_ts"),
    frames: frames.map((frame: any) => {
      if (
        frame.media_type !== "audio" ||
        integer(frame.stream_index, "stream_index") !== integer(stream.index, "stream index")
      )
        throw Error("Rhythm unknown frame stream");
      noPriming(frame);
      const pts = integer(frame.pts, "frame pts");
      if (frame.best_effort_timestamp !== undefined && integer(frame.best_effort_timestamp, "best effort pts") !== pts)
        throw Error("Rhythm contradictory frame timestamps");
      return { pts, nbSamples: integer(frame.nb_samples, "nb_samples") };
    }),
  });
  return { clock, summary: validateRhythmClock(clock) };
}
/** Internal preparation entrypoint. No CLI/provider route and no caller-selected installed executable. */
type TrustedPreparationHost = {
  artifactStage?: TrustedRhythmArtifactStageFactory;
  metadata?: (budget: RhythmReadContext["budget"]) => TrustedRhythmMetadataService;
  workspace?: TrustedRhythmWorkspaceFactory;
  resolve: (name: "ffmpeg" | "ffprobe") => string;
  run: (
    name: "ffmpeg" | "ffprobe",
    file: string,
    argv: string[],
    bounds: RhythmProcessBounds,
  ) => Promise<{ stdout: Buffer; stderrBytes: number }>;
};
const installedHost: TrustedPreparationHost = {
  metadata: createRhythmMetadataService,
  resolve: resolveRhythmTool,
  run: (_name, file, args, bounds) => runRhythmTool(file, args, bounds),
};
export function prepareRhythmEvidence(root: string, input: unknown, options: { signal?: AbortSignal } = {}) {
  return prepareWithHost(root, input, options, installedHost);
}
/** Explicit trusted test dependency only; never connected to a request/CLI/MCP selector. */
export function prepareRhythmEvidenceForTrustedTests(
  root: string,
  input: unknown,
  host: TrustedPreparationHost,
  options: { signal?: AbortSignal } = {},
) {
  return prepareWithHost(root, input, options, host);
}
async function prepareWithHost(
  root: string,
  input: unknown,
  { signal }: { signal?: AbortSignal },
  host: TrustedPreparationHost,
) {
  const request = RhythmAnalysisRequestSchema.parse(input),
    limits = { ...defaults, ...request.limits },
    started = Date.now(),
    context = new RhythmReadContext(root),
    project = `public/projects/${request.projectId}/`,
    publisher = new RhythmPublisher(context, request.projectId, limits.artifactBytes);
  let stage: RhythmArtifactStage | undefined,
    stageReservation: (() => void) | undefined,
    stageRetired = true;
  let lock: string | undefined,
    lockIdentity: { dev: number; ino: number } | undefined,
    metadata = 0,
    primaryFailed = false,
    primaryFailure: unknown,
    workspace: RhythmWorkspace | undefined,
    retireReservation: (() => void) | undefined,
    result: ReturnType<typeof readRhythmEvidence> | undefined,
    resultFile: string | undefined,
    resultSha: string | undefined,
    resultRuntime: TrustedRhythmRuntime | undefined;
  const deadline = () => {
    if (signal?.aborted || Date.now() - started >= limits.wholeMs)
      throw Error("Rhythm whole preparation deadline/cancelled");
    return limits.wholeMs - (Date.now() - started);
  };
  try {
    const config = context.json(project + "project.json", 8 * MiB);
    if (!config.value || typeof config.value !== "object" || Array.isArray(config.value))
      throw Error("Rhythm project config object required");
    const registry = context.json(project + "pipeline/asset-registry.json", 4 * MiB),
      asset = selectedRhythmAsset(registry.value, request.projectId, request.assetId);
    if (asset.hash !== request.assetSha256) throw Error("Rhythm selected asset SHA mismatch");
    const initialImplementations = currentRhythmImplementations(context.budget);
    const original = context.read("public/" + asset.files.original, limits.sourceBytes);
    if (original.pin.sha256 !== request.assetSha256 || original.pin.bytes !== asset.files.bytes)
      throw Error("Rhythm original bytes/registry changed");
    const installed = { ffmpeg: host.resolve("ffmpeg"), ffprobe: host.resolve("ffprobe") },
      toolContexts = Object.values(installed).map((file) => new RhythmReadContext(path.dirname(file), context.budget)),
      toolPins = {
        ffmpeg: toolContexts[0].read(path.basename(installed.ffmpeg), 128 * MiB).pin,
        ffprobe: toolContexts[1].read(path.basename(installed.ffprobe), 128 * MiB).pin,
      };
    const service = host.metadata
      ? host.metadata(context.budget)
      : {
          identity: {
            version: "darwin-owned-generated-fd-v1" as const,
            sha256: rhythmDigest("explicit trusted test metadata DATA only, no syscall"),
          },
          assertUnchanged: () => {},
          initialize: async (input: Parameters<TrustedRhythmMetadataService["initialize"]>[0]) => {
            input.budget.charge(input.bytes * 2);
          },
        };
    const checkLease = () => {
      if (!lock || !lockIdentity) throw Error("Rhythm own preparation lease unavailable");
      const current = lstatSync(lock);
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.dev !== lockIdentity.dev ||
        current.ino !== lockIdentity.ino
      )
        throw Error("Rhythm preparation lease changed; refusing operation");
    };
    const unchanged = () => {
      checkLease();
      context.assertUnchanged();
      workspace?.assertUnchanged();
      stage?.assertUnchanged();
      service.assertUnchanged();
      for (const c of toolContexts) c.assertUnchanged();
    };
    const invoke = async (name: "ffmpeg" | "ffprobe", args: string[], kind: "probe" | "decode") => {
      deadline();
      unchanged();
      const remaining = limits.sharedMetadataBytes - metadata;
      if (remaining < 1) throw Error("Rhythm shared metadata bound");
      const result = await host.run(name, installed[name], args, {
        timeoutMs: Math.min(deadline(), kind === "decode" ? limits.decodeMs : limits.probeMs),
        stallMs: limits.stallMs,
        stdoutBytes: kind === "decode" ? limits.pcmBytes : Math.min(limits.metadataBytes, remaining),
        stderrBytes: Math.min(limits.stderrBytes, remaining),
        signal,
      });
      deadline();
      unchanged();
      metadata += result.stderrBytes + (kind === "probe" ? result.stdout.length : 0);
      if (metadata > limits.sharedMetadataBytes) throw Error("Rhythm shared metadata bound");
      return result.stdout;
    };
    publisher.directory(`.cache/rhythm-evidence/${request.projectId}`);
    const privateBase = `.cache/rhythm-evidence/${request.projectId}/`;
    const lockCandidate = context.prepareCreation(privateBase + ".preparation-lock");
    const fd = openSync(
      lockCandidate,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    lockIdentity = fstatSync(fd);
    lock = lockCandidate;
    closeSync(fd);
    context.enrollCreated(privateBase + ".preparation-lock");
    retireReservation = publisher.reserveTransient(original.bytes.length);
    const extension = asset.files.original.split(".").at(-1) as "wav" | "flac";
    workspace = (host.workspace ?? createRhythmWorkspace)(original.bytes, extension, context.budget);
    const source = workspace.source;
    unchanged();
    deadline();
    const versions = {
      ffmpeg: (await invoke("ffmpeg", ["-version"], "probe")).toString("utf8").split("\n")[0],
      ffprobe: (await invoke("ffprobe", ["-version"], "probe")).toString("utf8").split("\n")[0],
    };
    const runtime: TrustedRhythmRuntime = {
        ...(host === installedHost ? {} : { artifactMetadata: service.identity }),
        ffmpeg: { file: installed.ffmpeg, version: versions.ffmpeg },
        ffprobe: { file: installed.ffprobe, version: versions.ffprobe },
      },
      runtimeData = {
        artifactMetadata: service.identity,
        ffmpeg: { version: versions.ffmpeg, sha256: toolPins.ffmpeg.sha256 },
        ffprobe: { version: versions.ffprobe, sha256: toolPins.ffprobe.sha256 },
      };
    const streamBytes = await invoke(
        "ffprobe",
        ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-of", "json", "-f", extension, source],
        "probe",
      ),
      frameBytes = await invoke(
        "ffprobe",
        [
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-select_streams",
          "a:0",
          "-show_frames",
          "-of",
          "json",
          "-f",
          extension,
          source,
        ],
        "probe",
      );
    const parsed = parseRhythmProbe(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(streamBytes)),
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frameBytes)),
    );
    if (
      asset.media.codec !== parsed.summary.codec ||
      asset.media.sampleRate !== parsed.summary.sampleRate ||
      asset.media.channels !== parsed.summary.channels
    )
      throw Error("Rhythm physical stream differs from registered metadata");
    const pcm = await invoke(
      "ffmpeg",
      [
        "-v",
        "error",
        "-nostdin",
        "-threads",
        "1",
        "-protocol_whitelist",
        "file,pipe",
        "-f",
        extension,
        "-i",
        source,
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "f32le",
        "pipe:1",
      ],
      "decode",
    );
    if (pcm.length !== parsed.summary.analysisSamples * 4) throw Error("Rhythm decoded PCM physical extent differs");
    const analysis = analyzeRhythmPcm(pcm, parsed.summary.analysisSamples / 16000, request.assetSha256),
      implementations = currentRhythmImplementations(context.budget);
    if (rhythmDigest(implementations) !== rhythmDigest(initialImplementations))
      throw Error("Rhythm preparation source implementation changed");
    const base = {
        version: 1 as const,
        contract: "source-rhythm-evidence-v1" as const,
        request,
        original: original.pin,
        selectedAssetDigest: rhythmDigest(asset),
        parameters: RHYTHM_PARAMETERS,
        runtime: runtimeData,
        implementations,
        clock: parsed.summary,
        analysis: analysis.report,
        onsets: analysis.onsetSamples.map((sample, index) => ({ id: `onset-${index}`, sample })),
        generatedAt: new Date().toISOString(),
        state: "candidate" as const,
        reviewRequired: true as const,
        automaticCuts: false as const,
        calibratedBeatTruth: false as const,
        apiCalls: 0 as const,
      },
      key = rhythmArtifactKey(base),
      finalRoot = privateBase + key + "/";
    // Complete GENERATED bytes are initialized privately; no persistent artifact pin exists yet.
    stageReservation = publisher.reserveTransient(0, 1);
    stageRetired = false;
    stage = (host.artifactStage ?? createRhythmArtifactStage)(context.budget);
    const generated = (role: RhythmArtifactRole, bytes: Buffer) => {
      deadline();
      unchanged();
      const pin = publisher.stageWrite(stage!, role, bytes);
      return { ...pin, path: finalRoot + role };
    };
    const finalSnapshot = generated(("original." + extension) as RhythmArtifactRole, original.bytes),
      clockPin = generated("clock.json", Buffer.from(JSON.stringify(parsed.clock))),
      pcmPin = generated("pcm.f32", pcm),
      initialConfig = generated("initial-config.json", config.bytes),
      initialRegistry = generated("initial-registry.json", registry.bytes);
    const commit = generated(
        "commit.json",
        Buffer.from(
          JSON.stringify({
            version: 1,
            key,
            originalSha256: finalSnapshot.sha256,
            clockSha256: clockPin.sha256,
            pcmSha256: pcmPin.sha256,
          }),
        ),
      ),
      payload = {
        ...base,
        initialPins: [initialConfig, initialRegistry],
        artifacts: { clock: clockPin, pcm: pcmPin, originalSnapshot: finalSnapshot, commit },
      },
      evidence = RhythmEvidenceSchema.parse({ ...payload, sha256: rhythmDigest(payload) });
    const evidenceFile = `pipeline/rhythm/${key}.evidence.json`,
      reportPin = generated("evidence-staged.json", Buffer.from(JSON.stringify(evidence))),
      roles = [
        "original." + extension,
        "clock.json",
        "pcm.f32",
        "initial-config.json",
        "initial-registry.json",
        "commit.json",
        "evidence-staged.json",
      ] as RhythmArtifactRole[];
    let metadataCalls = 0;
    for (const role of roles) {
      deadline();
      unchanged();
      if (++metadataCalls > 8) throw Error("Rhythm generated metadata call bound");
      const remaining = limits.sharedMetadataBytes - metadata,
        stdoutBytes = Math.min(16384, Math.floor(remaining / 2)),
        stderrBytes = Math.min(65536, limits.stderrBytes, remaining - stdoutBytes);
      if (stdoutBytes < 1 || stderrBytes < 1) throw Error("Rhythm shared generated metadata bound");
      await stage.initialize(role, service, {
        timeoutMs: Math.min(deadline(), 3000),
        stallMs: Math.min(limits.stallMs, 3000),
        stdoutBytes,
        stderrBytes,
        signal,
      });
      metadata += stdoutBytes + stderrBytes;
      if (metadata > limits.sharedMetadataBytes) throw Error("Rhythm shared generated metadata reservation bound");
      deadline();
      unchanged();
    }
    publisher.exclusiveDirectory(finalRoot.slice(0, -1));
    publisher.directory(project + "pipeline/rhythm");
    for (const role of roles) {
      deadline();
      unchanged();
      const relative = role === "evidence-staged.json" ? project + evidenceFile : finalRoot + role;
      publisher.install(
        relative,
        stage,
        role,
        checkLease,
        role === "evidence-staged.json" ? { publicEvidence: true } : undefined,
      );
    }
    // Controlled unlink/link metadata operations end BEFORE FIRST persistent artifact capture.
    stage.cleanup(checkLease);
    publisher.retireStage(stage);
    stageReservation();
    stageRetired = true;
    stage = undefined;
    unchanged();
    deadline();
    result = readRhythmEvidence(
      context.root,
      request.projectId,
      evidenceFile,
      reportPin.sha256,
      runtime,
      context.budget,
    );
    unchanged();
    deadline();
    resultFile = evidenceFile;
    resultSha = reportPin.sha256;
    resultRuntime = runtime;
  } catch (error) {
    primaryFailed = true;
    primaryFailure = error;
  }
  // Independent cleanup attempts must not replace the first analysis/publication fault.
  const cleanupErrors: string[] = [];
  let transientRetired = !retireReservation;
  const cleanup = (label: string, attempt: () => void) => {
    try {
      attempt();
    } catch (error) {
      cleanupErrors.push(`${label}: ${rhythmFaultText(error)}`);
    }
  };
  if (workspace)
    cleanup("workspace cleanup", () => {
      workspace!.cleanup();
      retireReservation?.();
      transientRetired = true;
    });
  else if (
    retireReservation &&
    primaryFailure instanceof RhythmWorkspaceCreationError &&
    primaryFailure.retirementConfirmed
  )
    cleanup("workspace reservation retirement", () => {
      retireReservation!();
      transientRetired = true;
    });
  if (stage)
    cleanup("generated stage cleanup", () => {
      stage!.cleanup(() => {
        if (!lock || !lockIdentity) throw Error("Rhythm stage cleanup lease unavailable");
        const current = lstatSync(lock);
        if (
          !current.isFile() ||
          current.isSymbolicLink() ||
          current.dev !== lockIdentity.dev ||
          current.ino !== lockIdentity.ino
        )
          throw Error("Rhythm generated stage cleanup lease changed");
      });
      publisher.retireStage(stage!);
      stageReservation?.();
      stageRetired = true;
    });
  else if (
    stageReservation &&
    primaryFailure instanceof RhythmArtifactStageCreationError &&
    primaryFailure.retirementConfirmed
  )
    cleanup("generated stage reservation retirement", () => {
      stageReservation!();
      stageRetired = true;
    });
  if (!publisher.publicationOccurred) cleanup("owned cleanup", () => publisher.cleanup());
  if (lock)
    cleanup("lease cleanup", () => {
      const stat = lstatSync(lock!);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== lockIdentity?.dev || stat.ino !== lockIdentity.ino)
        throw Error("Rhythm preparation lease changed; refusing removal");
      if (!transientRetired || !stageRetired)
        throw Error(
          "Rhythm own preparation lease retained: transient retirement unconfirmed; manual reconciliation required",
        );
      unlinkSync(lock!);
    });
  if (primaryFailed || cleanupErrors.length) {
    const uncertainty = publisher.publicationOccurred
      ? "; immutable output publication occurred, verify pinned output before retry"
      : publisher.installationOccurred
        ? "; generated immutable cache installation occurred, manual reconciliation before retry"
        : "";
    if (!cleanupErrors.length && !uncertainty) throw primaryFailure;
    throw Error(
      `${primaryFailed ? rhythmFaultText(primaryFailure) : cleanupErrors.shift()}${cleanupErrors.length ? "; " + cleanupErrors.join("; ") : ""}${uncertainty}`,
      { cause: primaryFailure },
    );
  }
  if (!result || !resultFile || !resultSha || !resultRuntime) throw Error("Rhythm preparation missing result");
  return { evidence: result, file: resultFile, sha256: resultSha, runtime: resultRuntime, cacheHit: false };
}
