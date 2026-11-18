import path from "node:path";
import {
  existsSync,
  realpathSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  openSync,
  closeSync,
  unlinkSync,
  fsyncSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { RecordingEditRequestSchema } from "../../types/workflow-recording-edit";
import { ProjectConfigSchema } from "../../types/video";
import { assertProjectId, planProjectRender } from "../render-plan";
import { hashFile, importAsset } from "../assets/registry";
import { TimelineEditStore } from "../timeline-ir/store";
import { compileTimelineIR } from "../timeline-ir/compiler";
import {
  probeRecordingTiming,
  hashRecordingNormalizationMapping,
  hashRecordingTimingSummary,
} from "./recording-timing";
import { decodeMasterPcm, hashJoinPlan, planRecordingJoins, renderJoinedSpeech, writePcmWav } from "./recording-joins";
import type { TimelineIR, TimelineClip } from "../../types/timeline";
const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const r = (num: number) => ({
  num,
  den: 1,
});
function contained(base: string, file: string) {
  const relative = path.relative(base, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Recording path escapes trusted scope");
}
function safeAncestors(root: string, file: string) {
  contained(root, file);
  let at = file;
  while (at !== root) {
    if (existsSync(at) && lstatSync(at).isSymbolicLink())
      throw new Error("Workflow output cannot use symlink directories");
    at = path.dirname(at);
  }
}
function probeSource(file: string) {
  const probe = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30000,
    }),
  );
  const videos = probe.streams.filter((s: any) => s.codec_type === "video"),
    audios = probe.streams.filter((s: any) => s.codec_type === "audio");
  if (videos.length !== 1 || audios.length !== 1)
    throw new Error("Recording requires exactly one video and one authentic audio stream");
  if (videos[0].avg_frame_rate !== "30/1" || videos[0].r_frame_rate !== "30/1")
    throw new Error("Only 30fps CFR accepted; explicitly normalize rational/VFR recording first");
  if (
    !Number.isFinite(Number(videos[0].start_time)) ||
    !Number.isFinite(Number(audios[0].start_time)) ||
    Math.abs(Number(videos[0].start_time)) > 1 / 48000 ||
    Math.abs(Number(audios[0].start_time)) > 1 / 48000
  )
    throw new Error("Recording audio/video must share a zero start; normalize offsets explicitly");
  const frames = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_frames",
        "-show_entries",
        "frame=best_effort_timestamp_time",
        "-of",
        "json",
        file,
      ],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 120000,
      },
    ),
  ).frames;
  if (!frames.length || frames.length > 54000) throw new Error("Recording requires 1–54000 decoded frames");
  for (let i = 0; i < frames.length; i++)
    if (
      !Number.isFinite(Number(frames[i].best_effort_timestamp_time)) ||
      Math.abs(Number(frames[i].best_effort_timestamp_time) - i / 30) > 0.00002
    )
      throw new Error("Variable-frame-rate or discontinuous recording rejected; normalize explicitly");
  if (
    !Number.isFinite(Number(videos[0].duration)) ||
    Number(videos[0].duration) <= 0 ||
    !Number.isFinite(Number(audios[0].duration)) ||
    Number(audios[0].duration) < frames.length / 30 - 1 / 30
  )
    throw new Error("Authentic audio does not cover full recording");
  return {
    frames: frames.length,
    width: videos[0].width,
    height: videos[0].height,
  };
}
/** One CLI line stays small: per-frame boundaries and per-word mappings become counts; the full record is in `recording-edit.json` after create. */
export function compactRecordingEditMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const timing = metadata.sourceTiming as Record<string, unknown> | undefined;
  const mapping = metadata.mapping as { words?: unknown[] }[] | undefined;
  return {
    ...metadata,
    ...(timing
      ? {
          sourceTiming: {
            ...timing,
            boundaries: undefined,
            boundaryCount: Array.isArray(timing.boundaries) ? timing.boundaries.length : undefined,
          },
        }
      : {}),
    ...(mapping ? { mapping: mapping.map(({ words, ...span }) => ({ ...span, wordCount: words?.length ?? 0 })) } : {}),
    details:
      metadata.dryRun === false
        ? `public/projects/${String(metadata.projectId)}/pipeline/recording-edit.json`
        : "full source boundaries and word mapping are written to pipeline/recording-edit.json on create",
  };
}
/** Local-only materialization. A review declaration is evidence supplied by a human, never an inferred approval. */
export async function runRecordingEditWorkflow(
  raw: unknown,
  options: {
    action: "plan" | "create";
    rootDir?: string;
    scopeRoot?: string;
  },
): Promise<{
  outputs: string[];
  metadata: Record<string, unknown>;
}> {
  const request = RecordingEditRequestSchema.parse(raw);
  assertProjectId(request.projectId);
  if (new Set(request.formats).size !== request.formats.length) throw new Error("Duplicate output formats");
  const root = realpathSync(options.rootDir ?? process.cwd());
  const source = realpathSync(path.resolve(root, request.source.file));
  if (options.scopeRoot) contained(realpathSync(options.scopeRoot), source);
  if (!lstatSync(source).isFile() || hashFile(source) !== request.source.sha256)
    throw new Error("Recording checksum mismatch or nonregular source");
  const timing = "normalization" in request.source ? probeRecordingTiming(source, request.source) : undefined;
  const media = timing ?? probeSource(source);
  const sourceWords = request.transcript.words;
  const ids = new Set<string>();
  for (let i = 0; i < sourceWords.length; i++) {
    const word = sourceWords[i];
    if (
      ids.has(word.id) ||
      word.startFrame >= word.endFrame ||
      word.endFrame > media.frames ||
      (i > 0 && word.startFrame < sourceWords[i - 1].endFrame)
    )
      throw new Error("Transcript words must be unique, ordered nonoverlapping source-frame intervals");
    ids.add(word.id);
  }
  const sourceKeeps = request.keepSpans;
  const keepIds = new Set<string>();
  for (let i = 0; i < sourceKeeps.length; i++) {
    const keep = sourceKeeps[i];
    if (
      keepIds.has(keep.id) ||
      keep.startFrame >= keep.endFrame ||
      keep.endFrame > media.frames ||
      (i > 0 && keep.startFrame < sourceKeeps[i - 1].endFrame)
    )
      throw new Error("Keep spans must be chronological, unique and nonoverlapping");
    keepIds.add(keep.id);
    for (const word of sourceWords)
      if (
        word.startFrame < keep.endFrame &&
        word.endFrame > keep.startFrame &&
        (word.startFrame < keep.startFrame || word.endFrame > keep.endFrame)
      )
        throw new Error(`Edit cuts through spoken word: ${word.id}`);
  }
  const removed: {
    startFrame: number;
    endFrame: number;
  }[] = [];
  let cursor = 0;
  for (const keep of sourceKeeps) {
    if (cursor < keep.startFrame)
      removed.push({
        startFrame: cursor,
        endFrame: keep.startFrame,
      });
    cursor = keep.endFrame;
  }
  if (cursor < media.frames)
    removed.push({
      startFrame: cursor,
      endFrame: media.frames,
    });
  if (
    JSON.stringify(removed) !==
    JSON.stringify(
      request.cuts.map(({ startFrame, endFrame }) => ({
        startFrame,
        endFrame,
      })),
    )
  )
    throw new Error("Explicit reviewed cuts must exactly cover complement of keep spans");
  for (const span of request.protectedSpans) {
    if (span.startFrame >= span.endFrame || span.endFrame > media.frames)
      throw new Error("Invalid protected statement interval");
    const retained = sourceKeeps.some((k) => k.startFrame < span.endFrame && k.endFrame > span.startFrame);
    if (
      retained
        ? !sourceKeeps.some((k) => k.startFrame <= span.startFrame && k.endFrame >= span.endFrame)
        : !request.cuts.some((c) => c.startFrame <= span.startFrame && c.endFrame >= span.endFrame)
    )
      throw new Error(`Edit discards or splits protected ${span.kind}: ${span.reason}`);
  }
  const markers = /^(не|нет|нельзя|если|кроме|без|но|однако|not|never|no|unless|except|however|if)$/i;
  for (const word of sourceWords)
    if (
      markers.test(word.text.replace(/[.,!?;:]/g, "")) &&
      !request.protectedSpans.some((p) => p.startFrame <= word.startFrame && p.endFrame >= word.endFrame)
    )
      throw new Error(`Declare protected negation/caveat/context for: ${word.text}`);
  if (timing)
    for (const word of sourceWords) {
      const retained = sourceKeeps.some((keep) => word.startFrame >= keep.startFrame && word.endFrame <= keep.endFrame);
      if (retained && timing.seconds[word.endFrame] > timing.authenticContentDurationSec + timing.clockToleranceSec)
        throw new Error(
          `Retained word exceeds authentic audio content: ${word.id}; move the boundary or supply a complete recording`,
        );
    }
  const { review: _, source: sourceRequest, ...edit } = request;
  const normalizationMapping = timing
    ? (() => {
        let decoded = 0;
        const masterToDecodedFrame = Array.from({ length: timing.masterFrameCount }, (_, masterFrame) => {
          while (decoded + 1 < timing.frames && timing.masterFrames[decoded + 1] <= masterFrame) decoded++;
          return decoded;
        });
        const uniqueDecoded = new Set(masterToDecodedFrame).size;
        return {
          sourceBoundaries: timing.seconds.map((sourceSec, sourceFrame) => ({
            sourceFrame,
            sourceSec,
            masterFrame: timing.masterFrames[sourceFrame],
          })),
          masterToDecodedFrame,
          masterFrameCount: timing.masterFrameCount,
          droppedDecodedFrames: timing.frames - uniqueDecoded,
          repeatedMasterFrames: timing.masterFrameCount - uniqueDecoded,
        };
      })()
    : undefined;
  const mappingHash = normalizationMapping ? hashRecordingNormalizationMapping(normalizationMapping) : undefined;
  const timingSummary = timing
    ? {
        originalDurationSec: timing.durationSec,
        outputDurationSec: timing.masterFrameCount / 30,
        authenticAudioDurationSec: timing.audioDurationSec,
        decodedAudioDurationSec: timing.decodedAudioDurationSec,
        authenticContentDurationSec: timing.authenticContentDurationSec,
        clockToleranceSec: timing.clockToleranceSec,
        boundaryMaxErrorSec: timing.seconds.reduce(
          (max, sec, i) => Math.max(max, Math.abs(timing.masterFrames[i] / 30 - sec)),
          0,
        ),
      }
    : undefined;
  const timingSummaryHash = timingSummary ? hashRecordingTimingSummary(timingSummary) : undefined;
  const boundary = (frame: number) => (timing ? timing.masterFrames[frame] : frame);
  const words = sourceWords.map((w) => ({ ...w, startFrame: boundary(w.startFrame), endFrame: boundary(w.endFrame) }));
  const keeps = sourceKeeps.map((k) => ({
    ...k,
    startFrame: timing ? Math.floor(timing.seconds[k.startFrame] * 30 + 1e-9) : k.startFrame,
    endFrame: timing ? Math.ceil(timing.seconds[k.endFrame] * 30 - 1e-9) : k.endFrame,
  }));
  const masterFrameCount = timing?.masterFrameCount ?? media.frames;
  const joinPlan =
    request.version === 3
      ? (() => {
          const tone = request.joins.roomTone;
          if (tone && (tone.startFrame >= tone.endFrame || tone.endFrame > media.frames))
            throw new Error("Invalid room tone interval");
          const roomTone = tone
            ? {
                startFrame: timing ? Math.floor(timing.seconds[tone.startFrame] * 30 + 1e-9) : tone.startFrame,
                endFrame: timing ? Math.ceil(timing.seconds[tone.endFrame] * 30 - 1e-9) : tone.endFrame,
                gainDb: tone.gainDb,
              }
            : null;
          return planRecordingJoins({
            pcm: decodeMasterPcm(source, masterFrameCount, !!timing),
            keeps,
            words,
            policy: request.joins,
            roomTone,
          });
        })()
      : undefined;
  const identity = {
    ...edit,
    source: {
      sha256: sourceRequest.sha256,
      version: sourceRequest.version,
      fps: sourceRequest.fps,
      ...("normalization" in sourceRequest
        ? {
            normalization: sourceRequest.normalization,
            timingHash: timing!.timingHash,
            normalizerVersion: timing!.normalizerVersion,
            mappingHash,
            timingSummaryHash,
          }
        : {}),
      rights: sourceRequest.rights ?? {},
    },
    sourceFrameCount: media.frames,
    ...(joinPlan ? { joinPlanHash: hashJoinPlan(joinPlan) } : {}),
  };
  if (request.revision === 1 && request.previousEdit) throw new Error("Initial revision cannot declare previous edit");
  if (request.revision > 1) {
    if (!request.previousEdit) throw new Error("Revised recut requires persisted previous edit");
    assertProjectId(request.previousEdit.projectId);
    const previousFile = path.join(
      root,
      "public/projects",
      request.previousEdit.projectId,
      "pipeline/recording-edit.json",
    );
    safeAncestors(root, previousFile);
    const previous = JSON.parse(readFileSync(previousFile, "utf8"));
    if (
      previous.editHash !== request.previousEdit.editHash ||
      previous.request.revision + 1 !== request.revision ||
      previous.request.source.sha256 !== request.source.sha256 ||
      previous.request.source.version !== request.source.version
    )
      throw new Error("Previous edit lineage/source/version mismatch");
  }
  const editHash = hash(identity);
  const reviewed = !!request.review && request.review.approvedEditHash === editHash;
  if (request.review && !reviewed) throw new Error("Review hash is stale: source, transcript, context or edit changed");
  if (timing)
    for (let i = 0; i < keeps.length; i++) {
      const keep = keeps[i],
        originalKeep = sourceKeeps[i];
      if (i && keep.startFrame < keeps[i - 1].endFrame)
        throw new Error("Outward keep normalization overlaps: merge adjacent keeps or move keep boundary into silence");
      for (const word of sourceWords) {
        const selected = word.startFrame >= originalKeep.startFrame && word.endFrame <= originalKeep.endFrame;
        if (
          !selected &&
          timing.seconds[word.startFrame] < keep.endFrame / 30 - 1e-9 &&
          timing.seconds[word.endFrame] > keep.startFrame / 30 + 1e-9
        )
          throw new Error("Move keep boundary into silence: outward normalization would include excluded spoken word");
      }
      for (const span of request.protectedSpans) {
        const selected = span.startFrame >= originalKeep.startFrame && span.endFrame <= originalKeep.endFrame;
        if (
          !selected &&
          timing.seconds[span.startFrame] < keep.endFrame / 30 - 1e-9 &&
          timing.seconds[span.endFrame] > keep.startFrame / 30 + 1e-9
        )
          throw new Error(
            "Move keep boundary into silence: outward normalization would include excluded protected context",
          );
      }
    }
  for (const word of words)
    if (word.startFrame >= word.endFrame) throw new Error(`Word collapses under 30fps normalization: ${word.id}`);
  for (const keep of keeps)
    if (keep.startFrame >= keep.endFrame) throw new Error(`Keep span collapses under 30fps normalization: ${keep.id}`);
  const mapping = keeps.map((keep, i) => ({
    id: keep.id,
    sourceStartFrame: keep.startFrame,
    sourceEndFrame: keep.endFrame,
    outputStartFrame: keeps.slice(0, i).reduce((n, k) => n + k.endFrame - k.startFrame, 0),
    words: words.filter((w) => w.startFrame >= keep.startFrame && w.endFrame <= keep.endFrame),
    reason: keep.reason,
    ...(timing
      ? {
          originalStartFrame: sourceKeeps[i].startFrame,
          originalEndFrame: sourceKeeps[i].endFrame,
          originalStartSec: timing.seconds[sourceKeeps[i].startFrame],
          originalEndSec: timing.seconds[sourceKeeps[i].endFrame],
        }
      : {}),
  }));
  const durationInFrames = keeps.reduce((n, k) => n + k.endFrame - k.startFrame, 0);
  const metadata = {
    workflow: "recording-edit",
    projectId: request.projectId,
    editHash,
    sourceHash: request.source.sha256,
    sourceVersion: request.source.version,
    ...(timing
      ? {
          sourceTiming: {
            decodedFrameCount: timing.frames,
            durationSec: timing.durationSec,
            timingHash: timing.timingHash,
            nominalRate: timing.nominalRate,
            variableFrameRate: timing.variableFrameRate,
            masterFrameCount,
            boundaries: normalizationMapping!.sourceBoundaries,
            mappingHash,
            timingSummary,
            timingSummaryHash,
          },
          normalization: "normalization" in request.source ? request.source.normalization : undefined,
        }
      : {}),
    durationInFrames,
    mapping,
    ...(joinPlan ? { joins: joinPlan } : {}),
    reviewStatus: reviewed ? "human-declared" : "needs-review",
    nextAction: reviewed
      ? "create-and-review-local-render"
      : "review-whole-original-and-proposal; supply review.approvedEditHash",
    profile: "recording-only",
    warnings: [
      "No automatic meaning, rights or creative approval.",
      "Music and generated voice intentionally absent; one authentic speech track.",
      ...(joinPlan
        ? [
            "Speech joins are equal-power crossfades of the authentic audio; listen to every join before approving delivery.",
          ]
        : []),
      ...(timing
        ? [
            "Source audio/video endpoints may differ by at most one frame; ceil normalization may add less than one frame. Terminal audio pad/trim is bounded to two frames (66.7ms), and cannot replace any retained supplied word.",
          ]
        : []),
    ],
  };
  const projects = path.join(root, "public/projects"),
    final = path.join(projects, request.projectId);
  safeAncestors(root, final);
  if (options.action === "create" && existsSync(final))
    throw new Error("Output project already exists; use a new project ID for revised recut");
  if (options.action === "plan")
    return {
      outputs: [],
      metadata: {
        ...metadata,
        dryRun: true,
      },
    };
  if (!reviewed) throw new Error("Create requires explicit human review bound to editHash");
  const staging = path.join(root, ".cache", `recording-edit-${randomUUID()}`);
  safeAncestors(root, staging);
  mkdirSync(projects, {
    recursive: true,
  });
  const lock = final + ".recording-create.lock";
  const fd = openSync(lock, "wx", 0o600);
  const stagedProject = path.join(staging, "public/projects", request.projectId);
  try {
    if (existsSync(final)) throw new Error("Output project already exists");
    mkdirSync(path.join(stagedProject, "pipeline"), {
      recursive: true,
    });
    const config = ProjectConfigSchema.parse({
      name: request.name,
      productName: request.name,
      formats: request.formats,
      colors: {
        accent: "#FFE600",
        background: "#111111",
        text: "#FFFFFF",
      },
      musicVolume: 0,
      scenes: keeps.map((k) => ({
        id: k.id,
        text: words
          .filter((w) => w.startFrame >= k.startFrame && w.endFrame <= k.endFrame)
          .map((w) => w.text)
          .join(" "),
        visualType: "title",
        headline: "",
        durationInFrames: k.endFrame - k.startFrame,
        transitionToNext: "cut",
      })),
    });
    writeFileSync(path.join(stagedProject, "project.json"), JSON.stringify(config, null, 2));
    const original = importAsset({
      projectId: request.projectId,
      sourceFile: source,
      rootDir: staging,
      provenance: {
        origin: "manual",
        tool: "supplied-recording",
        model: "none",
      },
      rights: request.source.rights,
    });
    if (original.asset.hash !== request.source.sha256) throw new Error("Source changed during import");
    const importedSource = path.join(staging, "public", original.asset.files.original);
    const audioFile = path.join(staging, "authentic-audio.wav");
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-xerror",
        "-i",
        importedSource,
        "-map",
        "0:a:0",
        "-vn",
        "-t",
        String(masterFrameCount / 30),
        ...(timing ? ["-af", `aresample=48000,apad,atrim=end_sample=${masterFrameCount * 1600}`] : []),
        "-ar",
        "48000",
        "-ac",
        "2",
        "-c:a",
        "pcm_s16le",
        audioFile,
      ],
      {
        timeout: 120000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    if (hashFile(source) !== request.source.sha256 || hashFile(importedSource) !== request.source.sha256)
      throw new Error("Source changed during extraction");
    if (timing) {
      const expectedBytes = masterFrameCount * 1600 * 2 * 2;
      const pcmProbe = JSON.parse(
        execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", audioFile], {
          encoding: "utf8",
          timeout: 30000,
          maxBuffer: 65536,
        }),
      );
      const pcmStream = pcmProbe.streams[0];
      if (
        pcmProbe.streams.length !== 1 ||
        pcmStream.codec_name !== "pcm_s16le" ||
        Number(pcmStream.sample_rate) !== 48000 ||
        pcmStream.channels !== 2 ||
        Number(pcmStream.duration_ts) * 4 !== expectedBytes
      )
        throw new Error("Authentic PCM does not match normalized master sample count");
    }
    const audio = importAsset({
      projectId: request.projectId,
      sourceFile: audioFile,
      rootDir: staging,
      provenance: {
        origin: "manual",
        tool: "ffmpeg-original-audio-extract",
        model: "none",
        referenceAssetIds: [original.asset.id],
      },
      rights: request.source.rights,
    });
    const joined = joinPlan
      ? (() => {
          const pcm = decodeMasterPcm(audioFile, masterFrameCount, !!timing);
          const replanned = planRecordingJoins({
            pcm,
            keeps,
            words,
            policy: joinPlan.policy,
            roomTone: joinPlan.roomTone,
          });
          if (hashJoinPlan(replanned) !== hashJoinPlan(joinPlan))
            throw new Error("Join plan changed between review and extraction");
          const joinedFile = path.join(staging, "joined-speech.wav");
          writePcmWav(joinedFile, renderJoinedSpeech(pcm, keeps, joinPlan));
          return importAsset({
            projectId: request.projectId,
            sourceFile: joinedFile,
            rootDir: staging,
            provenance: {
              origin: "manual",
              tool: "recording-join-crossfade",
              model: "none",
              referenceAssetIds: [audio.asset.id],
            },
            rights: request.source.rights,
          });
        })()
      : undefined;
    let picture = original;
    if (timing) {
      const normalizedFile = path.join(staging, "normalized-picture.mp4");
      execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-xerror",
          "-i",
          importedSource,
          "-map",
          "0:v:0",
          "-an",
          "-vf",
          `fps=fps=30:start_time=0:round=near,pad=ceil(iw/2)*2:ceil(ih/2)*2,tpad=stop_mode=clone:stop_duration=0.034,trim=end_frame=${masterFrameCount},setpts=N/(30*TB)`,
          "-frames:v",
          String(masterFrameCount),
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-crf",
          "18",
          "-pix_fmt",
          "yuv420p",
          "-fps_mode",
          "cfr",
          normalizedFile,
        ],
        { timeout: 600000, maxBuffer: 2 * 1024 * 1024 },
      );
      const normalizedProbe = JSON.parse(
        execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-of", "json", normalizedFile], {
          encoding: "utf8",
          timeout: 120000,
          maxBuffer: 2 * 1024 * 1024,
        }),
      );
      const stream = normalizedProbe.streams[0];
      if (
        normalizedProbe.streams.length !== 1 ||
        stream.codec_type !== "video" ||
        stream.avg_frame_rate !== "30/1" ||
        Number(stream.nb_read_frames) !== masterFrameCount
      )
        throw new Error("Normalized picture does not match planned frame count");
      picture = importAsset({
        projectId: request.projectId,
        sourceFile: normalizedFile,
        rootDir: staging,
        provenance: {
          origin: "manual",
          tool: "ffmpeg-reviewed-recording-normalization",
          model: "none",
          referenceAssetIds: [original.asset.id],
        },
        rights: request.source.rights,
      });
      if (hashFile(importedSource) !== request.source.sha256 || hashFile(source) !== request.source.sha256)
        throw new Error("Source changed during normalization");
    }
    const makeClip = (keep: (typeof keeps)[number], i: number, assetId: string, captions = false): TimelineClip => ({
      id: keep.id,
      assetId,
      start: r(mapping[i].outputStartFrame),
      source: {
        start: r(keep.startFrame),
        end: r(keep.endFrame),
        timebase: r(30),
      },
      rate: r(1),
      transition: {
        kind: "cut",
      },
      captions: captions
        ? mapping[i].words.map((w) => ({
            id: w.id,
            text: w.text,
            start: r(w.startFrame),
            end: r(w.endFrame),
            ...(w.speaker ? { speaker: w.speaker } : {}),
          }))
        : [],
      payload: {
        volume: 1,
        sourceHash: request.source.sha256,
        editHash,
      },
    });
    const punch = (clip: TimelineClip, i: number): TimelineClip =>
      joinPlan?.policy.punchIn && i % 2 === 1
        ? { ...clip, payload: { ...clip.payload, transform: { scale: joinPlan.policy.punchIn.scale } } }
        : clip;
    const speech = (clip: TimelineClip, i: number): TimelineClip =>
      joined
        ? {
            ...clip,
            assetId: joined.asset.id,
            source: {
              start: r(mapping[i].outputStartFrame),
              end: r(mapping[i].outputStartFrame + keeps[i].endFrame - keeps[i].startFrame),
              timebase: r(30),
            },
            payload: { ...clip.payload, joinedSpeech: true },
          }
        : clip;
    const timeline: TimelineIR = {
      version: 1,
      projectId: request.projectId,
      timebase: r(30),
      tracks: [
        {
          id: "recording-picture",
          kind: "visual",
          clips: keeps.map((k, i) => punch(makeClip(k, i, picture.asset.id), i)),
        },
        {
          id: "authentic-speech",
          kind: "voiceover",
          clips: keeps.map((k, i) => speech(makeClip(k, i, audio.asset.id), i)),
        },
        {
          id: "recording-captions",
          kind: "captions",
          clips: keeps.map((k, i) => makeClip(k, i, "caption:inline", true)),
        },
      ],
    };
    const store = new TimelineEditStore(path.join(stagedProject, "pipeline/timeline-edit.json"));
    store.initialize(timeline);
    compileTimelineIR(timeline);
    const write = (file: string, value: unknown) =>
      writeFileSync(path.join(stagedProject, "pipeline", file), JSON.stringify(value, null, 2) + "\n");
    write("recording-edit.json", {
      version: request.version,
      request,
      identity,
      editHash,
      reviewEvidence: request.review,
      mapping,
      sourceAssetId: original.asset.id,
      ...(timing
        ? {
            normalizedVideoAssetId: picture.asset.id,
            normalizedVideoHash: picture.asset.hash,
            normalization: {
              normalizerVersion: timing.normalizerVersion,
              coordinateSystem: "decoded-original-frame-boundaries",
              ...normalizationMapping,
              ...timingSummary,
              mappingHash,
              timingSummaryHash,
              policy: "normalization" in request.source ? request.source.normalization : undefined,
              timingHash: timing.timingHash,
              originalDurationSec: timing.durationSec,
              masterFrameCount,
              outputDurationSec: masterFrameCount / 30,
              boundaryMaxErrorSec: timing.seconds.reduce(
                (max, sec, i) => Math.max(max, Math.abs(timing.masterFrames[i] / 30 - sec)),
                0,
              ),
              authenticAudioDurationSec: timing.audioDurationSec,
              decodedAudioDurationSec: timing.decodedAudioDurationSec,
              authenticContentDurationSec: timing.authenticContentDurationSec,
              originalAudioVideoEndpointGapSec: timing.durationSec - timing.decodedAudioDurationSec,
              masterCeilExtensionSec: masterFrameCount / 30 - timing.durationSec,
              tailAudioAdjustmentSec: masterFrameCount / 30 - timing.decodedAudioDurationSec,
              terminalAdjustmentLimitSec: 2 / 30,
              originalImmutable: true,
              speechSpeedChanged: false,
            },
          }
        : {}),
      audioAssetId: audio.asset.id,
      audioHash: audio.asset.hash,
      ...(joined
        ? {
            joins: {
              plan: joinPlan,
              joinPlanHash: hashJoinPlan(joinPlan!),
              joinedAudioAssetId: joined.asset.id,
              joinedAudioHash: joined.asset.hash,
            },
          }
        : {}),
      extraction: {
        sampleRate: 48000,
        samplesPerFrame: 1600,
        channelCount: 2,
        originalAudioRetained: true,
        normalization: timing
          ? "Preserve-clock PCM extraction; at most two-frame terminal pad/trim; no retained word replaced by padding, no speech speed or gain changes"
          : "PCM extraction only; no generated speech or gain changes",
      },
      technicalOnly: true,
      humanRenderReviewRequired: true,
    });
    write("recording-edit-original-timeline.json", {
      ...timeline,
      ...(timing
        ? {
            sourceCoordinates: "normalized-30fps-master",
            decodedOriginalSourceAssetId: original.asset.id,
            decodedOriginalTimingHash: timing.timingHash,
          }
        : {}),
      tracks: timeline.tracks.map((t) => ({
        ...t,
        clips: [
          {
            ...t.clips[0],
            ...(joined && t.id === "authentic-speech"
              ? { assetId: audio.asset.id, payload: { volume: 1, sourceHash: request.source.sha256, editHash } }
              : {}),
            id: "uncut-original",
            start: r(0),
            source: {
              start: r(0),
              end: r(masterFrameCount),
              timebase: r(30),
            },
            captions:
              t.kind === "captions"
                ? words.map((w) => ({
                    id: w.id,
                    text: w.text,
                    start: r(w.startFrame),
                    end: r(w.endFrame),
                    ...(w.speaker ? { speaker: w.speaker } : {}),
                  }))
                : [],
          },
        ],
      })),
    });
    write("recording-edit-transcript.json", request.transcript);
    write("workflow-render.json", {
      version: 1,
      workflow: "recording-edit",
      projectId: request.projectId,
      timelineRequired: true,
    });
    for (const format of request.formats)
      planProjectRender(request.projectId, format, staging, {
        timeline: true,
      });
    if (hashFile(source) !== request.source.sha256) throw new Error("Source changed before publication");
    safeAncestors(root, final);
    if (existsSync(final)) throw new Error("Output project appeared during create");
    const syncTree = (directory: string) => {
      for (const entry of readdirSync(directory, {
        withFileTypes: true,
      })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) syncTree(file);
        else {
          const handle = openSync(file, "r");
          try {
            fsyncSync(handle);
          } finally {
            closeSync(handle);
          }
        }
      }
      const handle = openSync(directory, "r");
      try {
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
    };
    syncTree(stagedProject);
    renameSync(stagedProject, final);
    const directory = openSync(projects, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    return {
      outputs: [
        path.join(final, "project.json"),
        path.join(final, "pipeline/timeline-edit.json"),
        path.join(final, "pipeline/recording-edit.json"),
      ],
      metadata: {
        ...metadata,
        dryRun: false,
        timelineRevision: 0,
        humanRenderReviewRequired: true,
      },
    };
  } finally {
    closeSync(fd);
    unlinkSync(lock);
    rmSync(staging, {
      recursive: true,
      force: true,
    });
  }
}
