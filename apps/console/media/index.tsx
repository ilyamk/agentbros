/**
 * Media slot: the one place the console shows a file (RFC 0004 D21, WP6). It picks the viewer for the media kind and
 * variant: `thumb` is a lazy poster that opens the large viewer, `inline` and `full` are the players (video with frame
 * strip, stepping and frame comments; audio with waveform and cues; images with a lightbox). Rendered files only: no
 * @remotion/player and no composition code.
 *
 * Contract kept from WP4: `MediaSlotProps` (project, media, variant, className) and `mediaHref`; the play control
 * carries `data-hotkey="play"` so the space shortcut (FR9) reaches it from the focused card. Optional props below add
 * cue markers, scene strips, the composition id and the frame-comment handler (also given by FrameCommentProvider).
 */
import type { MediaRef } from "@contract";
import { mediaUrl } from "../../../src/lib/console/urls";
import { AudioPlayer, type CueMarker } from "./audio-player";
import { ImageView } from "./image-view";
import { MediaThumb } from "./media-thumb";
import { SnapshotMedia } from "./snapshot-media";
import { snapshotMode } from "@/lib/snapshot-mode";
import type { FrameCommentHandler } from "./region-comment";
import { VideoViewer } from "./video-viewer";

export interface MediaSlotProps {
  /** Project the path is relative to. */
  project: string;
  media: MediaRef;
  /** `inline` in a card or panel, `thumb` in grids and lists, `full` for a viewer page. */
  variant?: "inline" | "thumb" | "full";
  className?: string;
  /** Audio: cue markers (beats, cue sheet) over the waveform. */
  cues?: readonly CueMarker[];
  /** Video: scene renders shown as per-scene strips. */
  scenes?: readonly MediaRef[];
  /** Video: Remotion composition id for "Open in Remotion Studio". */
  composition?: string;
  /** Video: receives frame/region comments (overrides a FrameCommentProvider). */
  onFrameComment?: FrameCommentHandler;
}

/**
 * URL of a project file on the console server: `/media/<id>/<path>`, and `/media/<id>/@out/<path>` for a render under
 * `out/<id>/` (`root: "out"`). The shape is the server's own (src/lib/console/urls.ts, part of the bundle hash).
 */
export function mediaHref(project: string, media: MediaRef): string {
  return mediaUrl(project, media);
}

export function MediaSlot({
  project,
  media,
  variant = "inline",
  className,
  cues,
  scenes,
  composition,
  onFrameComment,
}: MediaSlotProps) {
  // A static snapshot has no media and no server: a note with the local path instead (WP15, D18).
  if (snapshotMode()) return <SnapshotMedia project={project} media={media} className={className} />;
  if (variant === "thumb" || media.kind === "document")
    return (
      <MediaThumb
        project={project}
        media={media}
        cues={cues}
        scenes={scenes}
        composition={composition}
        onFrameComment={onFrameComment}
        className={className}
      />
    );
  switch (media.kind) {
    case "video":
      return (
        <VideoViewer
          project={project}
          media={media}
          variant={variant}
          scenes={scenes}
          composition={composition}
          onFrameComment={onFrameComment}
          className={className}
        />
      );
    case "audio":
      return <AudioPlayer project={project} media={media} cues={cues} className={className} />;
    default:
      return <ImageView project={project} media={media} variant={variant} className={className} />;
  }
}

export { AudioPlayer, drawWaveform, type AudioPlayerProps, type CueMarker } from "./audio-player";
export { Compare, type CompareMode, type CompareProps } from "./compare";
export { FrameStrip, SceneStrips, type FrameStripProps, type SceneStripsProps } from "./frame-strip";
export { ImageLightbox, ImageView, type ImageLightboxProps, type ImageViewProps } from "./image-view";
export { MediaFacts, StaleBadge } from "./media-facts";
export { MediaThumb, type MediaThumbProps } from "./media-thumb";
export {
  FrameCommentForm,
  FrameCommentProvider,
  MarkOverlay,
  RegionOverlay,
  useFrameCommentHandler,
  type FrameCommentExtras,
  type FrameCommentHandler,
} from "./region-comment";
export { buildFrameComment, clampRegion, containRect, regionFromDrag, type Region } from "./region";
export { OpenInStudio, STUDIO_COMMAND } from "./studio-action";
export { VideoViewer, type VideoViewerProps } from "./video-viewer";
