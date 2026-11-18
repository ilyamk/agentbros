import { AssetPlanSchema } from "../../types/pipeline";
import { compileTimelineIR } from "../timeline-ir/compiler";
import { numeric, compare } from "../timeline-ir/rational";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ProjectConfigSchema, FORMAT_CONFIGS } from "../../types/video";
import { assertProjectId, planProjectRender, validatePublicAsset } from "../render-plan";
import { compileTimeline } from "../timeline";
import { analyzeAudio, mediaProbe } from "../audio/analysis";
import type { TimelineIR, TimelineClip } from "../../types/timeline";

/** Separate recording captions share the same immutable source, edit and source/output clock. */
export function sourceBoundCaptionPeers(timeline: TimelineIR, speech: TimelineClip): TimelineClip[] {
  const sourceHash = speech.payload?.sourceHash,
    editHash = speech.payload?.editHash;
  if (
    typeof sourceHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(sourceHash) ||
    typeof editHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(editHash)
  )
    return [];
  const offset = (clip: TimelineClip) =>
    numeric(clip.start) / numeric(timeline.timebase) -
    numeric(clip.source.start) / numeric(clip.source.timebase) / numeric(clip.rate);
  return timeline.tracks
    .filter((track) => track.kind === "captions")
    .flatMap((track) => track.clips)
    .filter(
      (clip) =>
        clip.payload?.sourceHash === sourceHash &&
        clip.payload?.editHash === editHash &&
        compare(clip.source.timebase, speech.source.timebase) === 0 &&
        compare(clip.rate, speech.rate) === 0 &&
        Math.abs(offset(clip) - offset(speech)) < 1e-8 &&
        compare(clip.source.start, speech.source.end) < 0 &&
        compare(clip.source.end, speech.source.start) > 0,
    );
}
export type EditorialFinding = {
  severity: "error" | "warning";
  code: string;
  message: string;
  sceneId?: string;
};
export type RetimingSuggestion = {
  sceneId: string;
  currentFrames: number;
  minimumFrames: number;
  reason: string;
  automatic: false;
};
const read = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined);
export function inspectEditorialProject(
  projectId: string,
  {
    rootDir = process.cwd(),
    renderFile,
    format = "landscape",
    editedTimeline = false,
  }: {
    rootDir?: string;
    renderFile?: string;
    format?: "landscape" | "vertical" | "square";
    editedTimeline?: boolean;
  } = {},
) {
  assertProjectId(projectId);
  const directory = path.resolve(rootDir, "public/projects", projectId),
    raw = read(path.join(directory, "project.json"));
  if (!raw) throw new Error("Project configuration missing");
  const project = ProjectConfigSchema.parse(raw),
    timeline = compileTimeline(project.scenes, {
      talkingHead: project.talkingHead?.enabled === true,
    });
  const brief = read(path.join(directory, "pipeline/brief.json")) as
    { voiceoverEnabled?: boolean; qualityTier?: string } | undefined;
  const narrationExpected = brief?.voiceoverEnabled ?? raw.voiceoverEnabled !== false;
  const embedded = project.talkingHead?.enabled && project.talkingHead.audioSource === "embedded";
  const findings: EditorialFinding[] = [],
    suggestions: RetimingSuggestion[] = [];
  const error = (code: string, message: string, sceneId?: string) =>
    findings.push({ severity: "error", code, message, sceneId });
  const assetPlan = read(path.join(directory, "pipeline/asset-plan.json"));
  if (assetPlan)
    for (const spec of AssetPlanSchema.parse(assetPlan).assets) {
      if (spec.status === "skipped") continue;
      if (spec.status !== "done") error("ASSET_STATUS_INCOMPLETE", `Planned asset ${spec.id} is ${spec.status}`);
      try {
        validatePublicAsset(`projects/${projectId}/${spec.targetPath}`, rootDir);
      } catch (problem) {
        error("PLANNED_ASSET_MISSING", problem instanceof Error ? problem.message : String(problem));
      }
    }
  if (embedded && !editedTimeline && project.talkingHead) {
    const presenter = path.resolve(rootDir, "public", project.talkingHead.presenterVideo);
    if (existsSync(presenter)) {
      const probe = mediaProbe(presenter);
      if (!probe.streams.some((stream) => stream.codec_type === "audio"))
        error("EMBEDDED_AUDIO_MISSING", "Native presenter has no embedded audio stream");
      if (timeline.entries.some((entry) => entry.sourceEndFrame / 30 > Number(probe.format.duration) + 0.02))
        error("PRESENTER_SOURCE_BOUNDS", "Presenter intervals exceed source duration");
    }
  }
  let expectedDurationSec = timeline.durationInFrames / 30;
  try {
    const job = planProjectRender(projectId, format, rootDir, {
      timeline: editedTimeline,
    }).jobs[0];
    expectedDurationSec = job.durationInFrames / 30;
    if (job.props.timeline) {
      const snapshot = compileTimelineIR(job.props.timeline);
      const speechTracks = snapshot.tracks.filter(
        (track) => track.kind === "voiceover" || (track.kind === "presenter" && embedded),
      );
      if (narrationExpected && !speechTracks.some((track) => track.clips.length))
        error("SPEECH_MISSING", "Timeline has no required narration track");
      for (const track of speechTracks)
        for (const clip of track.clips) {
          const asset = job.props.timelineAssets?.[clip.assetId];
          if (!asset) {
            error("SPEECH_SOURCE_MISSING", `Unresolved ${clip.id}`);
            continue;
          }
          if (!/^https?:\/\//.test(asset.source)) {
            const probe = mediaProbe(path.resolve(rootDir, "public", asset.source));
            if (!probe.streams.some((stream) => stream.codec_type === "audio"))
              error("SPEECH_SOURCE_SILENT", `No audio stream for ${clip.id}`);
            if (numeric(clip.source.end) / numeric(clip.source.timebase) > Number(probe.format.duration) + 0.02)
              error("SPEECH_SOURCE_BOUNDS", `Source interval exceeds ${clip.id}`);
          }
          const original = job.props.timeline.tracks
            .find((item) => item.id === track.id)
            ?.clips.find((item) => item.id === clip.id);
          const peerWords = original
            ? sourceBoundCaptionPeers(job.props.timeline, original).flatMap((peer) =>
                peer.captions.filter(
                  (word) => compare(word.end, peer.source.start) > 0 && compare(word.start, peer.source.end) < 0,
                ),
              )
            : [];
          const hasPeerWords = peerWords.some(
            (word) =>
              word.text.trim() && compare(word.end, clip.source.start) > 0 && compare(word.start, clip.source.end) < 0,
          );
          if (narrationExpected && !clip.captions.length && !hasPeerWords)
            error("CAPTIONS_MISSING", `Timeline captions missing for ${clip.id}`, clip.id);
          for (const word of [...(original?.captions ?? []), ...peerWords])
            if (
              (compare(word.start, clip.source.end) < 0 && compare(word.end, clip.source.end) > 0) ||
              (compare(word.start, clip.source.start) < 0 && compare(word.end, clip.source.start) > 0)
            )
              error("SPEECH_WORD_CUT", `Source boundary cuts the word "${word.text}"`, clip.id);
        }
    }
  } catch (problem) {
    error("MEDIA_INCOMPLETE", problem instanceof Error ? problem.message : String(problem));
  }
  for (const entry of editedTimeline ? [] : timeline.entries) {
    const scene = entry.scene,
      base = path.join(directory, "voiceover", scene.id);
    const audio = base + ".mp3";
    if (narrationExpected && !embedded && !existsSync(audio))
      error("SPEECH_MISSING", `Narration missing for ${scene.id}`, scene.id);
    if (!embedded && existsSync(audio)) {
      const duration = Number(mediaProbe(audio).format.duration),
        available =
          (project.talkingHead?.enabled ? entry.durationInFrames : entry.durationInFrames - entry.transitionFrames) /
          30;
      if (duration > available + 1 / 30) {
        error(
          "SPEECH_TRUNCATED",
          `${scene.id}: ${duration.toFixed(3)}s speech exceeds ${available.toFixed(3)}s ownership`,
          scene.id,
        );
        suggestions.push({
          sceneId: scene.id,
          currentFrames: entry.durationInFrames,
          minimumFrames: Math.ceil((duration + 0.2) * 30) + entry.transitionFrames,
          reason:
            "Extend scene and downstream track positions to preserve complete speech; never accelerate or cut automatically",
          automatic: false,
        });
      }
    }
    const wordFile = [base + ".words.edited.json", base + ".words.json"].find(existsSync);
    if (narrationExpected && !wordFile) error("CAPTIONS_MISSING", `Word alignment missing for ${scene.id}`, scene.id);
    if (wordFile) {
      const words = read(wordFile) as {
        audioSource?: string;
        words?: { text: string; start: number; end: number }[];
      };
      if (embedded && words.audioSource === "elevenlabs")
        error("CAPTION_SOURCE_MISMATCH", "Embedded narration cannot use TTS-aligned captions", scene.id);
      if (!Array.isArray(words.words) || !words.words.length) error("CAPTIONS_EMPTY", "Empty word alignment", scene.id);
      let end = 0;
      for (const word of words.words ?? []) {
        if (
          !word.text ||
          !Number.isFinite(word.start) ||
          !Number.isFinite(word.end) ||
          word.start < 0 ||
          word.end <= word.start ||
          word.start < end - 0.001
        )
          error("CAPTION_TIMING_INVALID", "Word timings must be ordered, finite and non-overlapping", scene.id);
        end = word.end;
      }
      const owned =
        (project.talkingHead?.enabled ? entry.durationInFrames : entry.durationInFrames - entry.transitionFrames) / 30;
      if (end > owned + 1 / 30) error("CAPTIONS_TRUNCATED", "Caption end exceeds owned speech interval", scene.id);
    }
  }
  let renderAnalysis: ReturnType<typeof analyzeAudio> | undefined;
  if (renderFile) {
    if (!existsSync(renderFile)) error("RENDER_MISSING", "Render output is missing");
    else {
      const meta = mediaProbe(renderFile),
        video = meta.streams.find((s) => s.codec_type === "video"),
        expected = FORMAT_CONFIGS[format];
      if (!video) error("VIDEO_STREAM_MISSING", "Render has no video stream");
      else if (video.width !== expected.width || video.height !== expected.height)
        error("RESOLUTION_MISMATCH", `Expected ${expected.width}x${expected.height}`);
      if (video) {
        const [num, den] = String(video.avg_frame_rate ?? "0/1")
          .split("/")
          .map(Number);
        if (!Number.isFinite(num / den) || Math.abs(num / den - 30) > 0.001)
          error("FPS_MISMATCH", "Render must have 30fps timebase");
      }
      if (Math.abs(Number(meta.format.duration) - expectedDurationSec) > 1 / 30 + 0.02)
        error("RENDER_DURATION_MISMATCH", "Render duration does not match compiled ownership");
      renderAnalysis = analyzeAudio(renderFile);
      if (narrationExpected && (!renderAnalysis.present || renderAnalysis.integratedLufs === null))
        error("RENDER_AUDIO_MISSING", "Required render narration is absent or entirely silent");
      if (renderAnalysis.truePeakDb !== null && renderAnalysis.truePeakDb > -0.5)
        error("TRUE_PEAK_OVERLOAD", "Render true peak exceeds -0.5 dBTP");
      if (
        renderAnalysis.integratedLufs !== null &&
        (renderAnalysis.integratedLufs < -22 || renderAnalysis.integratedLufs > -10)
      )
        findings.push({
          severity: "warning",
          code: "LOUDNESS_OUTSIDE_TARGET",
          message: `Measured ${renderAnalysis.integratedLufs} LUFS; normalize explicitly to the delivery target`,
        });
    }
  }
  return {
    version: 1,
    projectId,
    status: findings.some((f) => f.severity === "error") ? "failed" : "passed",
    findings,
    suggestions,
    renderAnalysis,
    apiCalls: 0,
  };
}
