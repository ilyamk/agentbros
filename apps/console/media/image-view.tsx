/**
 * Images and frame-strip images (RFC 0004 §10.2 asset grid, lightbox): the picture in place, a click opens it large in
 * a dialog. A file that does not load falls back to the kind's icon tile.
 */
import { useState } from "react";
import type { MediaRef } from "@contract";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { mediaUrl } from "../../../src/lib/console/urls";
import { MediaFacts, MediaUnavailable, StaleBadge, mediaLabel } from "./media-facts";

export interface ImageLightboxProps {
  project: string;
  media: MediaRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImageLightbox({ project, media, open, onOpenChange }: ImageLightboxProps) {
  const { d, f } = useI18n();
  const [failed, setFailed] = useState(false);
  const label = mediaLabel(media);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogTitle className="truncate pe-6">{f(d.media.lightbox, { label })}</DialogTitle>
        <DialogDescription asChild>
          <div className="text-xs">
            <MediaFacts media={media} />
          </div>
        </DialogDescription>
        {open ? (
          failed ? (
            <MediaUnavailable media={media} className="aspect-video rounded-lg" />
          ) : (
            <img
              src={mediaUrl(project, media)}
              alt={label}
              decoding="async"
              className="mx-auto max-h-[75vh] w-auto max-w-full rounded-lg object-contain"
              onError={() => setFailed(true)}
            />
          )
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export interface ImageViewProps {
  project: string;
  media: MediaRef;
  variant?: "inline" | "full";
  className?: string;
}

export function ImageView({ project, media, variant = "inline", className }: ImageViewProps) {
  const { d, f } = useI18n();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const label = mediaLabel(media);
  const ratio = media.width && media.height ? `${media.width} / ${media.height}` : undefined;
  return (
    <figure data-media-slot={media.kind} className={cn("relative flex min-w-0 flex-col gap-1", className)}>
      <button
        type="button"
        aria-label={f(d.media.open, { label })}
        onClick={() => setOpen(true)}
        className={cn(
          "relative block w-full overflow-hidden rounded-lg border bg-muted outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60",
          variant === "full" ? "max-h-[70vh]" : "max-h-64",
        )}
        style={ratio ? { aspectRatio: ratio } : undefined}
      >
        {failed ? (
          <MediaUnavailable media={media} className={ratio ? undefined : "aspect-video"} />
        ) : (
          <img
            src={mediaUrl(project, media)}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-full object-contain"
            onError={() => setFailed(true)}
          />
        )}
      </button>
      {media.stale ? <StaleBadge className="pointer-events-none absolute top-1.5 left-1.5" /> : null}
      <figcaption className="flex min-w-0 flex-col text-xs">
        <span className="truncate font-medium text-foreground">{label}</span>
        <MediaFacts media={media} />
      </figcaption>
      <ImageLightbox project={project} media={media} open={open} onOpenChange={setOpen} />
    </figure>
  );
}
