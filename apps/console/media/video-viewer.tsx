/**
 * Video viewer (RFC 0004 D21, US6, §10.2): the native <video> over the range-served render, with our controls —
 * play/pause, scrub by frame, frame stepping, timecode, playback rate, large view and full screen, a frame strip,
 * per-scene strips, render facts with the stale badge (§16), "Open in Remotion Studio", and frame/region comments.
 * No @remotion/player and no composition code: the console plays rendered files only.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { MediaRef } from "@contract";
import { Expand, Maximize, MessageSquarePlus, Pause, Play, StepBack, StepForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { SelectField } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/i18n";
import { isTypingTarget } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import { mediaUrl } from "../../../src/lib/console/urls";
import {
  PLAYBACK_RATES,
  clampFrame,
  clock,
  frameAt,
  frameCount,
  resolveDuration,
  resolveFps,
  stepFrame,
  timeOfFrame,
  timecode,
} from "./frame-math";
import { FrameStrip, SceneStrips } from "./frame-strip";
import { MediaFacts, MediaUnavailable, StaleBadge, mediaLabel } from "./media-facts";
import { containRect, type Region } from "./region";
import { FrameCommentForm, RegionOverlay, useFrameCommentHandler, type FrameCommentHandler } from "./region-comment";
import { OpenInStudio } from "./studio-action";
import { useBox } from "./use-box";
import { useMediaCommands, useMediaState } from "./use-media";
import { SnapshotMedia } from "./snapshot-media";
import { snapshotMode } from "@/lib/snapshot-mode";

export type ViewerVariant = "inline" | "full";

export interface VideoViewerProps {
  project: string;
  media: MediaRef;
  variant?: ViewerVariant;
  /** Scene renders shown as strips under the player; picking a frame plays that scene. */
  scenes?: readonly MediaRef[];
  /** Remotion composition id, for the "Open in Remotion Studio" command. */
  composition?: string;
  /** Receives frame comments; without it (and without a FrameCommentProvider) only the large view offers comments. */
  onFrameComment?: FrameCommentHandler;
  /** Start playing once loaded (the large view opened from a play button). */
  autoPlay?: boolean;
  className?: string;
}

/** Largest picture height per variant, so a 9:16 render keeps its shape instead of letterboxing. */
const MAX_HEIGHT = { inline: "16rem", full: "min(70vh, 48rem)" } as const;

export function pictureSize(media: Pick<MediaRef, "width" | "height">, maxHeight: string) {
  if (!media.width || !media.height) return { aspectRatio: "16 / 9", width: "100%" };
  const ratio = media.width / media.height;
  return {
    aspectRatio: `${media.width} / ${media.height}`,
    width: `min(100%, calc(${maxHeight} * ${ratio.toFixed(4)}))`,
  };
}

export function VideoViewer(props: VideoViewerProps) {
  // A static snapshot carries no media (WP15, D18).
  if (snapshotMode()) return <SnapshotMedia project={props.project} media={props.media} className={props.className} />;
  return <LiveVideoViewer {...props} />;
}

function LiveVideoViewer({
  project,
  media,
  variant = "inline",
  scenes,
  composition,
  onFrameComment,
  autoPlay = false,
  className,
}: VideoViewerProps) {
  const { d, f } = useI18n();
  const id = useId();
  const [current, setCurrent] = useState<MediaRef>(media);
  const [pendingSeek, setPendingSeek] = useState<number | undefined>();
  const [shownFor, setShownFor] = useState(media);
  if (media !== shownFor) {
    setShownFor(media);
    setCurrent(media);
  }
  const src = mediaUrl(project, current);
  const video = useRef<HTMLVideoElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  const state = useMediaState(video, src);
  const { toggle, seek, setRate, pause } = useMediaCommands(video);
  const { fps, assumed } = resolveFps(current.fps);
  const duration = resolveDuration(state.duration, current.durationSec);
  const frames = frameCount(duration, fps);
  const frame = clampFrame(frameAt(state.time, fps), duration, fps);
  const handler = useFrameCommentHandler(onFrameComment);
  const canComment = variant === "full" || handler !== undefined;
  const [commenting, setCommenting] = useState(false);
  const [region, setRegion] = useState<Region | undefined>();
  const [commentFrame, setCommentFrame] = useState(0);
  const [large, setLarge] = useState(false);
  const box = useBox(stage);
  const label = mediaLabel(current);

  // follow the playhead while the form is open; typing a frame seeks there
  useEffect(() => {
    if (commenting) setCommentFrame(frame);
  }, [commenting, frame]);

  // a scene picked from its strip: seek once its metadata is in
  useEffect(() => {
    const element = video.current;
    if (pendingSeek === undefined || !element) return;
    const apply = () => {
      seek(pendingSeek);
      setPendingSeek(undefined);
    };
    if (element.readyState >= 1) apply();
    else element.addEventListener("loadedmetadata", apply, { once: true });
    return () => element.removeEventListener("loadedmetadata", apply);
  }, [pendingSeek, seek, src]);

  const autoPlayed = useRef(false);
  useEffect(() => {
    if (!autoPlay || !state.ready || autoPlayed.current) return;
    autoPlayed.current = true;
    toggle();
  }, [autoPlay, state.ready, toggle]);

  const goToFrame = (target: number) => seek(timeOfFrame(clampFrame(target, duration, fps), fps));
  const step = (delta: number) => {
    pause();
    seek(timeOfFrame(stepFrame(state.time, delta, duration, fps), fps));
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (isTypingTarget(target) || target.matches?.("input, select")) return;
    const onButton = target.matches?.("button, a, summary");
    switch (event.key) {
      case " ":
        if (onButton) return; // the focused button's own click
        toggle();
        break;
      case "ArrowLeft":
        step(event.shiftKey ? -Math.round(fps) : -1);
        break;
      case "ArrowRight":
        step(event.shiftKey ? Math.round(fps) : 1);
        break;
      case "Home":
        goToFrame(0);
        break;
      case "End":
        goToFrame(frames - 1);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const startComment = () => {
    pause();
    setCommentFrame(frame);
    setCommenting(true);
  };

  const picture = containRect(
    { left: 0, top: 0, width: box.width, height: box.height },
    state.videoWidth ?? current.width,
    state.videoHeight ?? current.height,
  );
  const overlayStyle =
    box.width > 0 && box.height > 0
      ? {
          left: `${(picture.left / box.width) * 100}%`,
          top: `${(picture.top / box.height) * 100}%`,
          width: `${(picture.width / box.width) * 100}%`,
          height: `${(picture.height / box.height) * 100}%`,
        }
      : { inset: 0 };

  const fullscreen = () => {
    const element = root.current;
    if (element && document.fullscreenEnabled) void element.requestFullscreen?.().catch(() => {});
  };

  const timeText = timecode(frame, fps);
  return (
    <figure
      ref={root}
      data-media-slot="video"
      data-variant={variant}
      className={cn("flex min-w-0 flex-col gap-2 bg-background", className)}
      onKeyDown={onKeyDown}
    >
      <div
        ref={stage}
        className="relative mx-auto overflow-hidden rounded-lg border bg-black"
        style={pictureSize(current, MAX_HEIGHT[variant])}
      >
        {state.error && <MediaUnavailable media={current} />}
        <video
          ref={video}
          key={src}
          src={src}
          hidden={state.error}
          preload="metadata"
          playsInline
          tabIndex={0}
          aria-label={f(d.media.viewer, { label })}
          aria-describedby={`${id}-keys`}
          className="size-full object-contain outline-none focus-visible:ring-[3px] focus-visible:ring-ring/60"
          onClick={() => {
            if (!commenting) toggle();
          }}
        />
        {commenting ? <RegionOverlay drawing region={region} onChange={setRegion} style={overlayStyle} /> : null}
        {current.stale ? <StaleBadge className="absolute top-1.5 left-1.5" /> : null}
      </div>
      <p id={`${id}-keys`} className="sr-only">
        {d.media.keys}
      </p>

      {state.error ? null : (
        <div className="flex flex-wrap items-center gap-1" data-video-controls>
          <Button
            size="icon-sm"
            variant="secondary"
            data-hotkey="play"
            aria-label={state.paused ? d.media.play : d.media.pause}
            onClick={toggle}
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
            onValueChange={goToFrame}
            className="h-8 min-w-24 flex-1"
            thumb={{
              "aria-label": d.media.position,
              "aria-valuetext": f(d.media.positionValue, { frame, total: frames, time: timeText }),
              "data-scrub": "",
            }}
          />
          <output
            className="min-w-0 font-mono text-xs text-muted-foreground tabular-nums"
            data-frame={frame}
            aria-live="off"
          >
            {timeText} · {f(d.media.frame, { frame, total: frames })}
            {assumed ? ` · ${f(d.media.fpsAssumed, { fps })}` : null}
          </output>
          <SelectField
            aria-label={d.media.rate}
            size="sm"
            className="w-[4.75rem] shrink-0 px-2 text-xs tabular-nums"
            value={String(state.rate)}
            onValueChange={(value) => setRate(Number(value))}
            options={PLAYBACK_RATES.map((rate) => ({ value: String(rate), label: `${rate}×` }))}
          />
          {canComment ? (
            <Button
              size="sm"
              variant={commenting ? "secondary" : "ghost"}
              aria-pressed={commenting}
              onClick={() => (commenting ? setCommenting(false) : startComment())}
            >
              <MessageSquarePlus aria-hidden="true" />
              {d.media.comment.start}
            </Button>
          ) : null}
          {variant === "inline" ? (
            <Button size="icon-sm" variant="ghost" aria-label={d.media.fullView} onClick={() => setLarge(true)}>
              <Expand aria-hidden="true" />
            </Button>
          ) : (
            <Button size="icon-sm" variant="ghost" aria-label={d.media.fullScreen} onClick={fullscreen}>
              <Maximize aria-hidden="true" />
            </Button>
          )}
        </div>
      )}

      {state.error || duration <= 0 ? null : (
        <FrameStrip
          project={project}
          media={current}
          durationSec={duration}
          time={state.time}
          count={variant === "full" ? 12 : 8}
          frameWidth={variant === "full" ? 120 : 80}
          onSeek={(t) => {
            pause();
            seek(t);
          }}
        />
      )}

      {commenting ? (
        <FrameCommentForm
          media={current}
          frame={commentFrame}
          lastFrame={frames - 1}
          region={region}
          onRegionChange={setRegion}
          onFrameChange={(value) => {
            setCommentFrame(value);
            if (value <= frames - 1) goToFrame(value);
          }}
          timecodeOf={(value) => timecode(value, fps)}
          onComment={handler}
          onClose={() => {
            setCommenting(false);
            setRegion(undefined);
          }}
        />
      ) : null}

      {scenes?.length ? (
        <SceneStrips
          project={project}
          scenes={scenes}
          active={current.path}
          onSelect={(scene, t) => {
            setCurrent(scene);
            setPendingSeek(t);
          }}
        />
      ) : null}

      <figcaption className="flex min-w-0 flex-col gap-1 text-xs">
        <span className="truncate font-medium text-foreground">{label}</span>
        <MediaFacts media={current} durationSec={duration} />
        {variant === "full" || current.stale ? <OpenInStudio project={project} composition={composition} /> : null}
      </figcaption>

      {variant === "inline" ? (
        <Dialog open={large} onOpenChange={setLarge}>
          <DialogContent className="max-w-5xl">
            <DialogTitle className="truncate pe-6">{f(d.media.lightbox, { label })}</DialogTitle>
            <DialogDescription className="sr-only">{d.media.keys}</DialogDescription>
            {large ? (
              <VideoViewer
                project={project}
                media={current}
                variant="full"
                scenes={scenes}
                composition={composition}
                onFrameComment={onFrameComment}
              />
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}
    </figure>
  );
}
