/**
 * What every media item tells about itself (RFC 0004 §16, renders lag behind code): duration, render time, the source
 * hash it was rendered from, and a "stale" badge (colour and icon) when the composition changed since.
 */
import type { MediaRef } from "@contract";
import { FileText, Film, Image as ImageIcon, Music, Rows3 } from "lucide-react";
import { useI18n } from "@/i18n";
import { formatTime, shortHash } from "@/lib/format";
import { TONE_ICON } from "@/lib/status";
import { cn } from "@/lib/utils";
import { clock } from "./frame-math";

export const MEDIA_ICONS = { video: Film, image: ImageIcon, audio: Music, strip: Rows3, document: FileText } as const;

export const mediaLabel = (media: MediaRef) => media.label ?? media.path.split("/").at(-1) ?? media.path;

export function StaleBadge({ className }: { className?: string }) {
  const { d } = useI18n();
  const Icon = TONE_ICON.stale;
  return (
    <span
      data-stale
      title={d.media.staleHint}
      className={cn(
        "inline-flex items-center gap-1 rounded-sm border border-status-stale/60 bg-card px-1 text-[0.7rem] text-foreground",
        className,
      )}
    >
      <Icon className="size-3 text-status-stale" aria-hidden="true" />
      {d.media.stale}
      <span className="sr-only">: {d.media.staleHint}</span>
    </span>
  );
}

export function MediaFacts({ media, durationSec }: { media: MediaRef; durationSec?: number }) {
  const { d, f, locale } = useI18n();
  const duration = durationSec ?? media.durationSec;
  const facts = [
    duration !== undefined && duration > 0 ? f(d.media.duration, { duration: clock(duration) }) : undefined,
    media.width && media.height ? `${media.width}×${media.height}` : undefined,
    media.fps ? `${media.fps} fps` : undefined,
    media.renderedAt ? f(d.media.renderedAt, { time: formatTime(media.renderedAt, locale, true) }) : undefined,
  ].filter(Boolean);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground">
      {facts.length ? <span>{facts.join(" · ")}</span> : null}
      {media.sourceHash ? (
        <span title={media.sourceHash} className="font-mono">
          {f(d.media.sourceHash, { hash: shortHash(media.sourceHash) })}
        </span>
      ) : null}
      {media.stale ? <span className="text-foreground">{d.media.staleHint}</span> : null}
    </span>
  );
}

/** The tile shown when a file cannot be loaded (fixture mode has no server; a render may not exist yet). */
export function MediaUnavailable({ media, className }: { media: MediaRef; className?: string }) {
  const { d, f } = useI18n();
  const Icon = MEDIA_ICONS[media.kind];
  return (
    <div
      data-media-unavailable
      className={cn("flex size-full items-center justify-center bg-muted text-muted-foreground", className)}
      title={f(d.media.unavailable, { label: mediaLabel(media) })}
    >
      <Icon className="size-6" aria-hidden="true" />
      <span className="sr-only">{f(d.media.unavailable, { label: mediaLabel(media) })}</span>
    </div>
  );
}
