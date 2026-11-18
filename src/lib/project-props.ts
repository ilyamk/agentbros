import { z } from "zod";
import { AudioMasterSchema } from "../types/audio-master";
import { TimelineIRSchema } from "../types/timeline";
import { CaptionStyleSelectionSchema } from "../types/caption-style";
import { VideoSchema, TalkingHeadConfigSchema, type ProjectConfig, type VideoFormat } from "../types/video";

/** Browser-safe canonical props: no filesystem access or omitted talking-head fields. */
export const ProjectVideoSchema = VideoSchema.extend({
  talkingHead: TalkingHeadConfigSchema.optional(),
  audioMaster: AudioMasterSchema.optional(),
  captionsEnabled: z.boolean().optional(),
  /** Render option: burned caption profile, over the timeline's `captionStyle`; absent means the timeline's or karaoke. */
  captionStyle: CaptionStyleSelectionSchema.optional(),
  qaEvidence: z.boolean().optional(),
  timeline: TimelineIRSchema.optional(),
  timelineAssets: z
    .record(
      z.string(),
      z.object({
        source: z.string(),
        kind: z.enum(["image", "video", "audio"]),
        durationSec: z.number().nonnegative().optional(),
        hasAudio: z.boolean().optional(),
      }),
    )
    .optional(),
});
export type ProjectVideoProps = ReturnType<typeof ProjectVideoSchema.parse>;

export function projectToVideoProps(
  project: ProjectConfig,
  projectId: string,
  format: VideoFormat,
  voiceoverEnabled: boolean,
): ProjectVideoProps {
  return ProjectVideoSchema.parse({
    projectId,
    format,
    productName: project.productName,
    tagline: project.tagline,
    accentColor: project.colors.accent,
    bgColor: project.colors.background,
    textColor: project.colors.text,
    scenes: project.scenes.map((scene) => ({
      ...scene,
      durationInFrames: scene.durationInFrames ?? 120,
    })),
    voiceoverEnabled,
    musicVolume: project.musicVolume,
    talkingHead: project.talkingHead,
  });
}

export const PROJECT_COMPOSITION_IDS: Record<VideoFormat, string> = {
  vertical: "ProjectVertical",
  square: "ProjectSquare",
  landscape: "ProjectLandscape",
};
