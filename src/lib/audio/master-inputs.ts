import path from "node:path";
import { generationInputHash } from "../jobs/runner";
import { LocalAudioMixSchema, AudioMasterInputsSchema, type AudioMasterInputs } from "../../types/audio-master";
import type { TimelineIR } from "../../types/timeline";
import { localPublicSource, localInputHash } from "./local-input";

/** Independent of project/render planning: consume already resolved mixer inputs. */
export function captureAudioMasterInputs(
  projectId: string,
  rawPlan: unknown,
  timeline: TimelineIR,
  rootDir: string,
  embeddedPresenter = false,
): AudioMasterInputs {
  if (timeline.projectId !== projectId) throw new Error("Audio master project binding mismatch");
  const plan = LocalAudioMixSchema.parse(rawPlan);
  const sources = new Map<string, string>();
  const tracks = plan.tracks.map((track) => {
    const source = localPublicSource(track.source, rootDir);
    const sha256 = localInputHash(path.join(rootDir, "public", source));
    if (sources.has(source) && sources.get(source) !== sha256) throw new Error("Audio source changed during capture");
    sources.set(source, sha256);
    return { ...track, source };
  });
  const exactTracks = timeline.tracks
    .filter(
      (track) =>
        ["voiceover", "music", "sfx"].includes(track.kind) || (track.kind === "presenter" && embeddedPresenter),
    )
    .map((track) => ({
      id: track.id,
      kind: track.kind,
      clips: track.clips
        .filter((clip) => clip.payload?.speechMuted !== true)
        .map((clip) => ({
          id: clip.id,
          assetId: clip.assetId,
          start: clip.start,
          source: { start: clip.source.start, end: clip.source.end, timebase: clip.source.timebase },
          rate: clip.rate,
        })),
    }));
  const pinned = [...sources].sort(([a], [b]) => a.localeCompare(b)).map(([source, sha256]) => ({ source, sha256 }));
  const base = {
    version: 1 as const,
    mode: "project-timeline" as const,
    projectId,
    algorithm: "local-audio-v1" as const,
    sources: pinned,
  };
  return AudioMasterInputsSchema.parse({
    ...base,
    inputHash: generationInputHash({
      ...base,
      plan: { ...plan, tracks },
      exactTimeline: { timebase: timeline.timebase, tracks: exactTracks },
    }),
  });
}
export function assertAudioMasterInputs(expected: AudioMasterInputs, actual: AudioMasterInputs) {
  const a = AudioMasterInputsSchema.parse(expected),
    b = AudioMasterInputsSchema.parse(actual);
  if (generationInputHash(a) !== generationInputHash(b))
    throw new Error(
      "Project-generated audio master inputs changed; explicitly create a fresh audio master before rendering",
    );
}
