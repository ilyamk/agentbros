/**
 * The `thumb` variant for grids and lists (assets, home deliveries, card material): a lazily loaded `/thumb` poster,
 * never a <video> element. The play control (`data-hotkey="play"`, FR9 space) opens the large viewer and plays;
 * an image opens the lightbox. Without a server (fixture mode) the poster falls back to the kind's icon tile.
 */
import { useState } from "react";
import type { MediaRef } from "@contract";
import { Play } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { useOpenDocument } from "@/store/context";
import { AudioPlayer, type CueMarker } from "./audio-player";
import { clock } from "./frame-math";
import { ImageLightbox } from "./image-view";
import { MEDIA_ICONS, StaleBadge, mediaLabel } from "./media-facts";
import type { FrameCommentHandler } from "./region-comment";
import { RetryImg } from "./retry-img";
import { frameSrc, posterTime } from "./thumbs";
import { VideoViewer } from "./video-viewer";

export interface MediaThumbProps {
  project: string;
  media: MediaRef;
  cues?: readonly CueMarker[];
  scenes?: readonly MediaRef[];
  composition?: string;
  onFrameComment?: FrameCommentHandler;
  className?: string;
}

export function MediaThumb({ project, media, cues, scenes, composition, onFrameComment, className }: MediaThumbProps) {
  const { d, f } = useI18n();
  const openDocument = useOpenDocument();
  const [open, setOpen] = useState(false);
  const label = mediaLabel(media);
  const Icon = MEDIA_ICONS[media.kind];
  const ratio =
    media.width && media.height ? `${media.width} / ${media.height}` : media.kind === "audio" ? "4 / 1" : "16 / 9";
  const poster =
    media.kind === "video" || media.kind === "image" || media.kind === "strip"
      ? frameSrc(project, media, media.kind === "video" ? posterTime(media.durationSec) : 0, 160)
      : undefined;
  const playable = media.kind === "video" || media.kind === "audio";
  const facts = [
    d.media.kinds[media.kind],
    media.durationSec !== undefined ? clock(media.durationSec) : undefined,
    media.width && media.height ? `${media.width}×${media.height}` : undefined,
  ].filter(Boolean);

  const tile = (
    <>
      {poster ? (
        <RetryImg
          src={poster}
          className="absolute inset-0 size-full object-cover"
          fallback={<Icon className="size-6" aria-hidden="true" />}
        />
      ) : (
        <Icon className="size-6" aria-hidden="true" />
      )}
      {playable ? (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-9 items-center justify-center rounded-full bg-black/60 text-white">
            <Play className="size-4" aria-hidden="true" />
          </span>
        </span>
      ) : null}
    </>
  );
  const tileClass =
    "relative flex max-h-40 w-full items-center justify-center overflow-hidden rounded-lg border bg-muted text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60";

  return (
    <figure
      data-media-slot={media.kind}
      data-variant="thumb"
      className={cn("relative flex w-full min-w-0 flex-col gap-1", className)}
    >
      <button
        type="button"
        className={tileClass}
        style={{ aspectRatio: ratio }}
        aria-label={f(d.media.open, { label })}
        data-hotkey={playable ? "play" : undefined}
        onClick={() => (media.kind === "document" ? openDocument({ project, media }) : setOpen(true))}
      >
        {tile}
      </button>
      {/* outside the button: its visible text would otherwise have to be part of the button's name */}
      {media.stale ? <StaleBadge className="pointer-events-none absolute top-1.5 left-1.5" /> : null}
      <figcaption className="flex min-w-0 flex-col text-xs">
        <span className="truncate font-medium text-foreground">{label}</span>
        <span className="truncate text-muted-foreground">{facts.join(" · ")}</span>
      </figcaption>

      {media.kind === "image" || media.kind === "strip" ? (
        <ImageLightbox project={project} media={media} open={open} onOpenChange={setOpen} />
      ) : playable ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className={media.kind === "video" ? "max-w-5xl" : "max-w-2xl"}>
            <DialogTitle className="truncate pe-6">{f(d.media.lightbox, { label })}</DialogTitle>
            <DialogDescription className="sr-only">{d.media.keys}</DialogDescription>
            {open ? (
              media.kind === "video" ? (
                <VideoViewer
                  project={project}
                  media={media}
                  variant="full"
                  scenes={scenes}
                  composition={composition}
                  onFrameComment={onFrameComment}
                  autoPlay
                />
              ) : (
                <AudioPlayer project={project} media={media} cues={cues} />
              )
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}
    </figure>
  );
}
