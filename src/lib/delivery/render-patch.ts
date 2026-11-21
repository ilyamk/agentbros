import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { constants, copyFileSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { RenderReceiptSchema, type RenderIdentity } from "../../types/delivery";
import { SceneSchema, type Scene } from "../../types/video";
import { hashFile } from "../assets/registry";
import { generationInputHash } from "../jobs/runner";
import type { RenderJob } from "../render-plan";
import { compileTimeline } from "../timeline";
import { compileTimelineIR } from "../timeline-ir/compiler";
import { renderBoundary } from "../timeline-ir/render";

export const PATCH_GOP = 60;
const FPS = 30;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ProofSchema = z
  .object({
    version: z.literal(1),
    snapshot: hash,
    output: hash,
    dependencies: hash,
    scenes: z.record(
      z.string(),
      z.object({ content: hash, start: z.number().int().nonnegative(), end: z.number().int().positive() }),
    ),
  })
  .strict();
type Proof = z.infer<typeof ProofSchema>;
type Range = { start: number; end: number };
type SceneProof = Proof["scenes"];

/** Validate every target and save rollback copies before exposing any of the new files. */
export function publishRenderFiles(scratch: string, rows: { target: string; staged?: string }[], replace = renameSync) {
  const prepared = rows.map((row, index) => {
    const prior = lstatSync(row.target, { throwIfNoEntry: false });
    if (prior && !prior.isFile()) throw new Error("Render publication targets must be regular files");
    const backup = prior ? path.join(scratch, `rollback-${index}`) : undefined;
    if (backup) copyFileSync(row.target, backup, constants.COPYFILE_FICLONE);
    return { ...row, backup };
  });
  const changed: typeof prepared = [];
  try {
    for (const row of prepared) {
      if (row.staged) replace(row.staged, row.target);
      else rmSync(row.target, { force: true });
      changed.push(row);
    }
  } catch (error) {
    for (const row of changed.reverse()) {
      if (row.backup) renameSync(row.backup, row.target);
      else rmSync(row.target, { force: true });
    }
    throw error;
  }
}

/** Only these fields of built-in scene payloads are local to one visual sequence. */
function withoutCopy(scene: Scene, key: string, range: Range, scenes: SceneProof) {
  const { headline, subtext, ...rest } = scene;
  scenes[key] = { ...range, content: generationInputHash({ headline: headline ?? null, subtext: subtext ?? null }) };
  return rest;
}

export function renderPatchDependencies(job: RenderJob, identity: RenderIdentity) {
  const { timeline, scenes: projectScenes, ...globals } = job.props;
  if (globals.talkingHead?.enabled || globals.qaEvidence) return undefined;
  const scenes: SceneProof = Object.create(null) as SceneProof;
  const compiled = timeline && compileTimelineIR(timeline);
  const boundary = (time: Parameters<typeof renderBoundary>[0]) => renderBoundary(time, compiled!.timebase, FPS);
  const spans = new Map(
    compiled?.tracks.flatMap((track) =>
      track.clips.map(
        (clip) =>
          [
            JSON.stringify([track.id, clip.id]),
            {
              start: boundary(clip.start),
              end: boundary(clip.end) + (clip.transition.kind === "fade" ? boundary(clip.transition.duration) : 0),
            },
          ] as const,
      ),
    ),
  );
  const normalisedTimeline = timeline && {
    ...timeline,
    tracks: timeline.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => {
        const key = JSON.stringify([track.id, clip.id]);
        const span = spans.get(key);
        const scene = SceneSchema.safeParse(clip.payload?.scene);
        if (track.kind !== "visual" || !span || !scene.success || scene.data.template) return clip;
        return { ...clip, payload: { ...clip.payload, scene: withoutCopy(scene.data, key, span, scenes) } };
      }),
    })),
  };
  const normalisedScenes = timeline
    ? projectScenes.map(({ headline: _headline, subtext: _subtext, ...scene }) => scene)
    : compileTimeline(projectScenes).entries.map(({ scene, startFrame, durationInFrames }) =>
        scene.template
          ? scene
          : withoutCopy(scene, scene.id, { start: startFrame, end: startFrame + durationInFrames }, scenes),
      );
  const sources = identity.sources.filter(
    (source) => source.path !== `public/projects/${identity.projectId}/project.json` && source.role !== "edit",
  );
  const dependencies = generationInputHash(
    JSON.parse(
      JSON.stringify({
        globals,
        timeline: normalisedTimeline,
        scenes: normalisedScenes,
        sources,
        format: job.format,
        duration: job.durationInFrames,
        composition: job.compositionId,
      }),
    ),
  );
  return { version: 1 as const, snapshot: identity.sourceSnapshotHash, dependencies, scenes };
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function patchRange(base: string, current: Omit<Proof, "output">, duration: number): Range | undefined {
  try {
    const previous = ProofSchema.parse(readJson(`${base}.patch.json`));
    const receipt = RenderReceiptSchema.parse(readJson(`${base}.receipt.json`));
    if (
      previous.dependencies !== current.dependencies ||
      receipt.partial ||
      receipt.evidence !== "renderer" ||
      receipt.sourceSnapshotHash !== previous.snapshot ||
      receipt.outputSha256 !== previous.output ||
      hashFile(base) !== previous.output
    )
      return undefined;
    const changed = Object.entries(current.scenes).filter(
      ([key, value]) => previous.scenes[key]?.content !== value.content,
    );
    if (!changed.length || Object.keys(previous.scenes).length !== Object.keys(current.scenes).length) return undefined;
    for (const [key, span] of Object.entries(current.scenes)) {
      const old = previous.scenes[key];
      if (!old || old.start !== span.start || old.end !== span.end || span.end <= span.start) return undefined;
    }
    const start = Math.floor(Math.min(...changed.map(([, scene]) => scene.start)) / PATCH_GOP) * PATCH_GOP;
    const end = Math.min(
      duration,
      Math.ceil(Math.max(...changed.map(([, scene]) => scene.end)) / PATCH_GOP) * PATCH_GOP,
    );
    return start >= 0 && end > start && end - start < duration ? { start, end } : undefined;
  } catch {
    return undefined;
  }
}

function media(command: "ffmpeg" | "ffprobe", args: string[]) {
  const result = spawnSync(command, ["-v", "error", ...args], {
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error)
    throw new Error(result.error?.message ?? (result.stderr.trim() || `${command} exited ${result.status}`));
  return result.stdout;
}

const execute = promisify(execFile);
async function videoFrames(file: string) {
  const { stdout } = await execute(
    "ffmpeg",
    [
      "-v",
      "error",
      "-xerror",
      "-threads",
      "3",
      "-i",
      file,
      "-map",
      "0:v:0",
      "-fps_mode",
      "passthrough",
      "-f",
      "framehash",
      "-",
    ],
    { encoding: "utf8", timeout: 180_000, maxBuffer: 32 * 1024 * 1024 },
  );
  return stdout
    .split("\n")
    .filter((line) => /^\d/.test(line))
    .map((line) => {
      const [, , pts, duration, , digest] = line.split(",").map((part) => part.trim());
      return { pts, duration, digest };
    });
}

function audioFingerprint(file: string) {
  const streams = JSON.parse(
    media("ffprobe", [
      "-select_streams",
      "a",
      "-show_entries",
      "stream=codec_name,sample_rate,channels,start_time,duration",
      "-of",
      "json",
      file,
    ]),
  ) as { streams: unknown[] };
  return (
    JSON.stringify(streams.streams) +
    (streams.streams.length ? media("ffmpeg", ["-i", file, "-map", "0:a", "-c", "copy", "-f", "streamhash", "-"]) : "")
  );
}

function videoSpecification(file: string) {
  return media("ffprobe", [
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,width,height,pix_fmt,sample_aspect_ratio,avg_frame_rate,color_range,color_space,color_transfer,color_primaries,start_time,duration",
    "-of",
    "json",
    file,
  ]);
}

/** Fail closed if the encoder's GOP, colour headers or timestamps do not support a lossless splice. */
export async function assemblePatch(base: string, patch: string, range: Range, duration: number, output: string) {
  const dir = path.dirname(output);
  const boundaries = [range.start, range.end].filter((frame) => frame > 0 && frame < duration);
  media("ffmpeg", [
    "-xerror",
    "-i",
    base,
    "-map",
    "0:v:0",
    "-c",
    "copy",
    "-f",
    "segment",
    "-segment_frames",
    boundaries.join(","),
    "-reset_timestamps",
    "1",
    path.join(dir, "base-%d.mp4"),
  ]);
  const list = [
    ...(range.start ? ["base-0.mp4"] : []),
    path.basename(patch),
    ...(range.end < duration ? [`base-${range.start ? 2 : 1}.mp4`] : []),
  ];
  const concat = list.map((file) => `file '${file}'`).join("\n") + "\n";
  const manifest = path.join(dir, "splice.ffconcat");
  writeFileSync(manifest, concat, { flag: "wx" });
  media("ffmpeg", [
    "-xerror",
    "-f",
    "concat",
    "-safe",
    "1",
    "-i",
    manifest,
    "-i",
    base,
    "-map",
    "0:v:0",
    "-map",
    "1:a?",
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    output,
  ]);
  const frames = await Promise.allSettled([base, patch, output].map(videoFrames));
  const [baseFrames, patchFrames, assembled] = frames.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
  if (!baseFrames || !patchFrames || !assembled) throw new Error("Incomplete splice verification");
  const expected = [...baseFrames.slice(0, range.start), ...patchFrames, ...baseFrames.slice(range.end)];
  if (
    baseFrames.length !== duration ||
    patchFrames.length !== range.end - range.start ||
    assembled.length !== duration ||
    expected.some(
      (frame, index) =>
        frame.digest !== assembled[index]!.digest ||
        baseFrames[index]!.pts !== assembled[index]!.pts ||
        baseFrames[index]!.duration !== assembled[index]!.duration,
    ) ||
    videoSpecification(base) !== videoSpecification(output) ||
    audioFingerprint(base) !== audioFingerprint(output)
  )
    throw new Error("The splice changed unchanged frames, audio or duration");
}
