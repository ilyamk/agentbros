/**
 * Frame strip (RFC 0004 §10.2, A3): `count` frames across the duration from the server's `/thumb` endpoint, loaded
 * lazily (`loading="lazy"`; quantized URLs share the browser cache). A click seeks; the marker shows the position.
 * A frame that fails to load (no server in fixture mode, ffmpeg missing) leaves its cell as a plain tile.
 */
import type { MediaRef } from "@contract";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { clock } from "./frame-math";
import { RetryImg } from "./retry-img";
import { frameSrc, stripTimes } from "./thumbs";

export interface FrameStripProps {
  project: string;
  media: MediaRef;
  durationSec: number;
  /** Current position in seconds; draws the marker when given. */
  time?: number;
  /** Number of frames (default 8). */
  count?: number;
  /** CSS width of one frame, for the thumbnail size (default 120). */
  frameWidth?: number;
  onSeek?: (t: number) => void;
  className?: string;
}

export function FrameStrip({
  project,
  media,
  durationSec,
  time,
  count = 8,
  frameWidth = 120,
  onSeek,
  className,
}: FrameStripProps) {
  const { d, f } = useI18n();
  const times = stripTimes(durationSec, count);
  if (!times.length) return null;
  const label = media.label ?? media.path.split("/").at(-1) ?? media.path;
  const ratio = media.width && media.height ? `${media.width} / ${media.height}` : "16 / 9";
  const slice = durationSec / times.length;
  return (
    <div className={cn("relative", className)} data-frame-strip>
      <ul aria-label={f(d.media.strip, { label })} className="flex w-full gap-0.5 overflow-hidden rounded-md">
        {times.map((t, index) => {
          const src = frameSrc(project, media, t, frameWidth);
          const start = index * slice;
          const current = time !== undefined && time >= start && time < start + slice;
          return (
            <li key={src} className="min-w-0 flex-1">
              <button
                type="button"
                aria-label={f(d.media.stripFrame, { time: clock(t) })}
                aria-current={current ? "true" : undefined}
                data-strip-time={t}
                disabled={!onSeek}
                onClick={() => onSeek?.(t)}
                className={cn(
                  "block w-full overflow-hidden bg-muted outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60 disabled:cursor-default",
                  current && "ring-2 ring-primary ring-inset",
                )}
                style={{ aspectRatio: ratio }}
              >
                <RetryImg src={src} className="size-full object-cover" />
              </button>
            </li>
          );
        })}
      </ul>
      {time !== undefined && durationSec > 0 ? (
        <span
          aria-hidden="true"
          data-strip-marker
          className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-primary"
          style={{ left: `${Math.min(100, Math.max(0, (time / durationSec) * 100))}%` }}
        />
      ) : null}
    </div>
  );
}

export interface SceneStripsProps {
  project: string;
  /** Scene renders in order (MediaRef kind `video`). */
  scenes: readonly MediaRef[];
  /** The scene shown in the viewer, by path. */
  active?: string;
  /** A frame of a scene was picked: the viewer switches to it at `t`. */
  onSelect?: (scene: MediaRef, t: number) => void;
  count?: number;
  className?: string;
}

/** One strip per scene render (§5.3 wireframe), labelled with the scene and its duration. */
export function SceneStrips({ project, scenes, active, onSelect, count = 6, className }: SceneStripsProps) {
  const { d } = useI18n();
  const videos = scenes.filter((scene) => scene.kind === "video" && (scene.durationSec ?? 0) > 0);
  if (!videos.length) return null;
  return (
    <section aria-label={d.media.scenes} className={cn("flex flex-col gap-2", className)}>
      <h4 className="text-xs font-medium text-muted-foreground">{d.media.scenes}</h4>
      {videos.map((scene) => (
        <div key={`${scene.root ?? "project"}:${scene.path}`} className="flex flex-col gap-1">
          <p className={cn("truncate text-xs", scene.path === active ? "font-semibold text-foreground" : "")}>
            {scene.label ?? scene.path}
            <span className="text-muted-foreground"> · {clock(scene.durationSec ?? 0)}</span>
          </p>
          <FrameStrip
            project={project}
            media={scene}
            durationSec={scene.durationSec ?? 0}
            count={count}
            frameWidth={80}
            onSeek={onSelect ? (t) => onSelect(scene, t) : undefined}
          />
        </div>
      ))}
    </section>
  );
}
