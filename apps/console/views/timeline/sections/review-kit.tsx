/**
 * Small pieces shared by the WP13c review sections (snapshots, assets, budget, visualisations, QA, chapters, audio):
 * rational formatting as review:ui printed it, the file-kind rules of its `preview()` (client:68-82), a JSON block that
 * wraps at 390 px, a stacked label, and the review-file preview (dropdowns are `SelectField` from `components/ui/select`).
 *
 * Previews go through the review file route (`api.fileUrl`, the `state()` allowlist, cookie-authenticated media) rather
 * than the WP6 viewers: those build `/media/<id>/…` URLs, a different allowlist that also refuses `.json` and `.html`
 * reports.
 */
import type { ComponentProps, ReactNode } from "react";
import { Label } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Rational, ReviewApi } from "../api";

/** `num/den` exactly as typed (no reduction, no float). */
export const ratio = (value: Rational) => `${value.num}/${value.den}`;

/** The frame number review:ui printed for a rational (`num / den`, JavaScript's default number text). */
export const frameNumber = (value: Rational) => value.num / value.den;

/** Review packs (`…/review-<uuid>/manifest.json`) open the pack navigator (client:582). */
export const REVIEW_PACK_PATTERN = /\/review-[a-f0-9-]{36}\/manifest\.json$/;
const MEDIA_PATTERN = /\.(png|jpe?g|webp|gif|avif|mp4|webm|mp3|wav|ogg|m4a|aac|flac)$/i;
const VIDEO_PATTERN = /\.(mp4|webm)$/i;
const AUDIO_PATTERN = /\.(mp3|wav|ogg|m4a|aac|flac)$/i;

export type ReviewFileKind = "pack" | "video" | "audio" | "image" | "text";

/** How a report, output or original opens (client:581-608 for reports; 68-82 for the element). */
export function reviewFileKind(file: string): ReviewFileKind {
  if (REVIEW_PACK_PATTERN.test(file)) return "pack";
  if (!MEDIA_PATTERN.test(file)) return "text";
  return mediaElementKind(file);
}

/** The element `preview()` picks by extension: video, audio, else a lazy image. */
export function mediaElementKind(file: string): "video" | "audio" | "image" {
  return VIDEO_PATTERN.test(file) ? "video" : AUDIO_PATTERN.test(file) ? "audio" : "image";
}

/** A label above its control (stacked, so it fits at 390 px). */
export function Field({ htmlFor, label, children }: { htmlFor: string; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

/** Pretty JSON (or a plain string) as text; wraps anywhere so long hashes never widen the page. */
export function JsonBlock({ value, className, ...props }: { value: unknown } & ComponentProps<"pre">) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <pre
      className={cn(
        "max-h-96 min-w-0 overflow-auto rounded-md bg-muted/50 p-3 font-mono text-xs wrap-anywhere whitespace-pre-wrap",
        className,
      )}
      {...props}
    >
      {text}
    </pre>
  );
}

/** A media element for a review file: `<video>`/`<audio>` with controls and `preload=metadata`, or a lazy image. */
export function ReviewMedia({ api, file, label }: { api: ReviewApi; file: string; label?: string }) {
  const src = api.fileUrl(file);
  const kind = mediaElementKind(file);
  if (kind === "video")
    return (
      <video
        data-file={file}
        src={src}
        controls
        preload="metadata"
        aria-label={label ?? file}
        className="max-h-80 max-w-full rounded-md bg-black"
      />
    );
  if (kind === "audio")
    return (
      <audio data-file={file} src={src} controls preload="metadata" aria-label={label ?? file} className="w-full" />
    );
  return (
    <img
      data-file={file}
      src={src}
      loading="lazy"
      alt={label ?? file}
      className="max-h-80 max-w-full rounded-md object-contain"
    />
  );
}
