import { ProjectConfigSchema } from "../../types/video";
import type { TimelineIR, TimelineClip } from "../../types/timeline";
import { compileTimeline } from "../timeline";
import { fraction } from "./rational";
import { validateTimeline } from "./compiler";

/** Import only: keep the entire authored document so extension fields survive. */
export function adaptLegacyProject(raw: Record<string, unknown>, projectId: string): TimelineIR {
  const project = ProjectConfigSchema.parse(raw),
    fps = 30;
  const timeline = compileTimeline(project.scenes, {
    fps,
    talkingHead: project.talkingHead?.enabled === true,
  });
  const timebase = fraction(fps),
    tracks: TimelineIR["tracks"] = [];
  const makeClip = (
    id: string,
    assetId: string,
    start: number,
    sourceStart: number,
    sourceEnd: number,
  ): TimelineClip => ({
    id,
    assetId,
    start: fraction(start),
    source: {
      start: fraction(sourceStart),
      end: fraction(sourceEnd),
      timebase,
    },
    rate: fraction(1),
    transition: { kind: "cut" },
    captions: [],
  });
  const rawScenes = raw.scenes as Record<string, unknown>[];
  tracks.push({
    id: "visual",
    kind: "visual",
    clips: timeline.entries.map((entry, index) => {
      const ownedDuration = timeline.entries[index + 1]
        ? timeline.entries[index + 1].startFrame - entry.startFrame
        : timeline.durationInFrames - entry.startFrame;
      const clip = makeClip(entry.scene.id, `scene:${entry.scene.id}`, entry.startFrame, 0, ownedDuration);
      clip.payload = { scene: structuredClone(rawScenes[index]) };
      if (entry.transitionFrames)
        clip.transition = {
          kind: "fade",
          duration: fraction(entry.transitionFrames),
        };
      return clip;
    }),
  });
  if (project.talkingHead?.enabled) {
    tracks.push({
      id: "presenter",
      kind: "presenter",
      clips: timeline.entries.map((entry) =>
        makeClip(
          entry.scene.id,
          project.talkingHead!.presenterVideo,
          entry.startFrame,
          entry.sourceStartFrame,
          entry.sourceEndFrame,
        ),
      ),
    });
  }
  if (raw.voiceoverEnabled !== false && project.talkingHead?.audioSource !== "embedded") {
    tracks.push({
      id: "voiceover",
      kind: "voiceover",
      clips: timeline.entries.map((entry, index) =>
        makeClip(
          entry.scene.id,
          `projects/${projectId}/voiceover/${entry.scene.id}.mp3`,
          entry.startFrame,
          0,
          timeline.entries[index + 1]
            ? timeline.entries[index + 1].startFrame - entry.startFrame
            : timeline.durationInFrames - entry.startFrame,
        ),
      ),
    });
  }
  if (project.musicVolume > 0)
    tracks.push({
      id: "music",
      kind: "music",
      clips: [
        {
          ...makeClip("background", `projects/${projectId}/music/bg.mp3`, 0, 0, timeline.durationInFrames),
          payload: { volume: project.musicVolume, loop: true },
        },
      ],
    });
  return validateTimeline({
    version: 1,
    projectId,
    timebase,
    tracks,
    legacyProject: structuredClone(raw),
  });
}

/** Unknown future versions fail explicitly instead of silently losing fields. */
export function migrateTimeline(raw: unknown, projectId?: string): TimelineIR {
  if (!raw || typeof raw !== "object") throw new Error("Timeline document must be an object");
  const value = raw as Record<string, unknown>;
  if (value.version === 1) return validateTimeline(value);
  if (value.version === undefined && Array.isArray(value.scenes) && projectId)
    return adaptLegacyProject(value, projectId);
  throw new Error(`Unsupported timeline version: ${String(value.version)}; explicit migration required`);
}
