/**
 * A/B compare (RFC 0004 §10.2): compare cards (two endings, two takes) and the critic's before/after frames. Side by
 * side shows two full players; the wipe stacks B over A, clipped at a slider (`clip-path` through the style prop), with
 * one set of controls driving both and B following A's clock.
 */
import { useEffect, useId, useRef, useState } from "react";
import type { MediaRef } from "@contract";
import { Pause, Play, StepBack, StepForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { mediaUrl } from "../../../src/lib/console/urls";
import {
  clampFrame,
  frameAt,
  frameCount,
  resolveDuration,
  resolveFps,
  stepFrame,
  timeOfFrame,
  timecode,
} from "./frame-math";
import { ImageView } from "./image-view";
import { MediaUnavailable, mediaLabel } from "./media-facts";
import type { FrameCommentHandler } from "./region-comment";
import { useMediaCommands, useMediaState } from "./use-media";
import { VideoViewer, pictureSize } from "./video-viewer";
import { SnapshotMedia } from "./snapshot-media";
import { snapshotMode } from "@/lib/snapshot-mode";

export type CompareMode = "side" | "wipe";

export interface CompareProps {
  project: string;
  a: MediaRef;
  b: MediaRef;
  /** Initial mode (default side by side). */
  defaultMode?: CompareMode;
  onFrameComment?: FrameCommentHandler;
  className?: string;
}

const isVisual = (media: MediaRef) => media.kind === "video" || media.kind === "image" || media.kind === "strip";

export function Compare(props: CompareProps) {
  if (snapshotMode())
    return (
      <div className={cn("grid gap-2 sm:grid-cols-2", props.className)}>
        <SnapshotMedia project={props.project} media={props.a} />
        <SnapshotMedia project={props.project} media={props.b} />
      </div>
    );
  return <LiveCompare {...props} />;
}

function LiveCompare({ project, a, b, defaultMode = "side", onFrameComment, className }: CompareProps) {
  const { d, f } = useI18n();
  const [mode, setMode] = useState<CompareMode>(defaultMode);
  const wipeable = isVisual(a) && isVisual(b) && (a.kind === "video") === (b.kind === "video");
  const shown = wipeable ? mode : "side";
  return (
    <section
      data-compare={shown}
      aria-label={f(d.media.compare.title, { a: mediaLabel(a), b: mediaLabel(b) })}
      className={cn("flex min-w-0 flex-col gap-2", className)}
    >
      {wipeable ? (
        <div
          className="flex gap-1"
          role="group"
          aria-label={f(d.media.compare.title, { a: mediaLabel(a), b: mediaLabel(b) })}
        >
          {(["side", "wipe"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={shown === value ? "secondary" : "ghost"}
              aria-pressed={shown === value}
              onClick={() => setMode(value)}
            >
              {d.media.compare[value]}
            </Button>
          ))}
        </div>
      ) : null}
      {shown === "side" ? (
        <div className="grid grid-cols-2 gap-3">
          {[a, b].map((media) =>
            media.kind === "video" ? (
              <VideoViewer
                key={`${media.root ?? "project"}:${media.path}`}
                project={project}
                media={media}
                onFrameComment={onFrameComment}
              />
            ) : (
              <ImageView key={`${media.root ?? "project"}:${media.path}`} project={project} media={media} />
            ),
          )}
        </div>
      ) : (
        <Wipe project={project} a={a} b={b} />
      )}
    </section>
  );
}

function Wipe({ project, a, b }: { project: string; a: MediaRef; b: MediaRef }) {
  const { d, f } = useI18n();
  const id = useId();
  const [position, setPosition] = useState(50);
  const video = a.kind === "video";
  const aRef = useRef<HTMLVideoElement>(null);
  const bRef = useRef<HTMLVideoElement>(null);
  const srcA = mediaUrl(project, a);
  const srcB = mediaUrl(project, b);
  const state = useMediaState(aRef, srcA);
  const stateB = useMediaState(bRef, srcB);
  const commandsA = useMediaCommands(aRef);
  const commandsB = useMediaCommands(bRef);
  const toggleB = commandsB.toggle;
  const { fps } = resolveFps(a.fps);
  const duration = resolveDuration(state.duration, a.durationSec);
  const frames = frameCount(duration, fps);
  const frame = clampFrame(frameAt(state.time, fps), duration, fps);

  // B follows A: same play state, within a frame of A's time
  useEffect(() => {
    const other = bRef.current;
    if (!video || !other) return;
    if (Math.abs(other.currentTime - state.time) > 1 / fps) other.currentTime = state.time;
    if (state.paused !== other.paused) toggleB();
  }, [video, state.time, state.paused, fps, toggleB]);

  const seek = (t: number) => {
    commandsA.seek(t);
    commandsB.seek(t);
  };
  const step = (delta: number) => {
    commandsA.pause();
    commandsB.pause();
    seek(timeOfFrame(stepFrame(state.time, delta, duration, fps), fps));
  };
  const layer = "absolute inset-0 size-full object-contain";
  const failed = state.error || stateB.error;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-wipe>
      <div className="relative mx-auto overflow-hidden border bg-black" style={pictureSize(a, "min(60vh, 32rem)")}>
        {failed ? (
          <MediaUnavailable media={state.error ? a : b} />
        ) : video ? (
          <>
            <video ref={aRef} src={srcA} preload="metadata" playsInline aria-label={mediaLabel(a)} className={layer} />
            <video
              ref={bRef}
              src={srcB}
              preload="metadata"
              playsInline
              muted
              aria-label={mediaLabel(b)}
              className={layer}
              style={{ clipPath: `inset(0 0 0 ${position}%)` }}
            />
          </>
        ) : (
          <>
            <img src={srcA} alt={mediaLabel(a)} className={layer} />
            <img src={srcB} alt={mediaLabel(b)} className={layer} style={{ clipPath: `inset(0 0 0 ${position}%)` }} />
          </>
        )}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white shadow"
          style={{ left: `${position}%` }}
        />
        <span className="absolute top-1.5 left-1.5 rounded-sm bg-black/70 px-1 text-[0.7rem] text-white">
          {mediaLabel(a)}
        </span>
        <span className="absolute top-1.5 right-1.5 rounded-sm bg-black/70 px-1 text-[0.7rem] text-white">
          {mediaLabel(b)}
        </span>
      </div>
      <Slider
        min={0}
        max={100}
        step={1}
        value={position}
        onValueChange={setPosition}
        thumb={{
          id: `${id}-wipe`,
          "aria-label": d.media.compare.wipePosition,
          "aria-valuetext": `${position}%`,
          "data-wipe-position": "",
        }}
      />
      {video && !failed ? (
        <div className="flex flex-wrap items-center gap-1">
          <Button
            size="icon-sm"
            variant="secondary"
            data-hotkey="play"
            aria-label={state.paused ? d.media.play : d.media.pause}
            onClick={commandsA.toggle}
          >
            {state.paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label={d.media.previousFrame} onClick={() => step(-1)}>
            <StepBack aria-hidden="true" />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label={d.media.nextFrame} onClick={() => step(1)}>
            <StepForward aria-hidden="true" />
          </Button>
          <Slider
            min={0}
            max={Math.max(frames - 1, 1)}
            disabled={frames <= 1}
            step={1}
            value={frame}
            onValueChange={(value) => seek(timeOfFrame(value, fps))}
            className="h-8 min-w-24 flex-1"
            thumb={{
              "aria-label": d.media.position,
              "aria-valuetext": f(d.media.positionValue, { frame, total: frames, time: timecode(frame, fps) }),
            }}
          />
          <output className="font-mono text-xs text-muted-foreground tabular-nums">{timecode(frame, fps)}</output>
        </div>
      ) : null}
    </div>
  );
}
