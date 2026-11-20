/**
 * Video viewer (RFC 0004 D21, US6, §10.2): the native <video> over the range-served render, with our controls —
 * play/pause, scrub by frame, frame stepping, timecode, playback rate, large view and full screen, a frame strip,
 * per-scene strips, render facts with the stale badge (§16), "Open in Remotion Studio", and frame/region comments.
 * No @remotion/player and no composition code: the console plays rendered files only.
 */
import { useEffect, useId, useRef, useState } from "react";
import { MAX_FRAME_MARKS, type MediaRef } from "@contract";
import { Expand, Maximize, MessageSquarePlus, Pause, Play, StepBack, StepForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
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
  frameAt,
  frameClock,
  frameCount,
  resolveDuration,
  resolveFps,
  stepFrame,
  timeOfFrame,
  timecode,
} from "./frame-math";
import { FrameStrip, SceneStrips } from "./frame-strip";
import { overlayBase64, type DraftMark } from "./marks";
import { Timeline } from "./timeline";
import { useFrameNoteHandler } from "./use-frame-note";
import { MediaFacts, MediaUnavailable, StaleBadge, mediaLabel } from "./media-facts";
import { containRect, type Region } from "./region";
import {
  FrameCommentForm,
  MarkOverlay,
  MarksCanvas,
  RegionOverlay,
  useFrameCommentHandler,
  type FrameCommentHandler,
} from "./region-comment";
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

/** What the player's keys read from a keyboard event, React's or the dialog's own. */
type PlayerKey = Pick<
  KeyboardEvent,
  "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey" | "defaultPrevented" | "target" | "preventDefault"
>;

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
  // A slot's own handler or a provider's; the large view sends a frame note to the agent otherwise (2026-11-20).
  const explicit = useFrameCommentHandler(onFrameComment);
  const note = useFrameNoteHandler(project);
  const handler = explicit ?? (variant === "full" ? note : undefined);
  const canComment = variant === "full" || explicit !== undefined;
  const [commenting, setCommenting] = useState(false);
  const [region, setRegion] = useState<Region | undefined>();
  const [marks, setMarks] = useState<DraftMark[]>([]);
  const [noted, setNoted] = useState<number[]>([]);
  const [commentFrame, setCommentFrame] = useState(0);
  const [large, setLarge] = useState(false);
  const box = useBox(stage);
  const label = mediaLabel(current);
  const away = commenting && marks.length > 0 && frame !== commentFrame;

  // follow the playhead while the form is open and nothing is marked yet; marks hold their frame
  useEffect(() => {
    if (commenting && !marks.length) setCommentFrame(frame);
  }, [commenting, frame, marks.length]);

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

  const onKeyDown = (event: PlayerKey) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (isTypingTarget(target) || target.matches?.("input, select")) return;
    const onButton = target.matches?.("button, a, summary");
    // The editor's keys only in the large view: on the canvas J and K belong to the card shortcuts (FR9).
    const editor = variant === "full";
    if (!editor && /^[jklcJKLC,.]$/.test(event.key)) return;
    switch (event.key) {
      case " ":
        if (onButton) return; // the focused button's own click
        toggle();
        break;
      // An editor's transport (2026-11-20): K stops, L plays and speeds up, J steps back one second.
      case "k":
      case "K":
        pause();
        break;
      case "l":
      case "L": {
        if (state.paused) {
          setRate(1);
          toggle();
        } else setRate(PLAYBACK_RATES.find((rate) => rate > state.rate) ?? state.rate);
        break;
      }
      case "j":
      case "J":
        step(-Math.round(fps));
        break;
      case "ArrowLeft":
      case ",":
        step(event.shiftKey ? -Math.round(fps) : -1);
        break;
      case "ArrowRight":
      case ".":
        step(event.shiftKey ? Math.round(fps) : 1);
        break;
      case "c":
      case "C":
        if (!canComment || commenting) return;
        startComment();
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

  // In the large view a key pressed anywhere in the dialog (its frame, its title, after a closed form) drives this
  // player; the dialog's text fields keep theirs (2026-11-20).
  const keys = useRef(onKeyDown);
  useEffect(() => {
    keys.current = onKeyDown;
  });
  useEffect(() => {
    if (variant !== "full") return;
    const dialog = root.current?.closest('[role="dialog"]');
    if (!dialog) return;
    const listener = (event: Event) => {
      if (root.current?.contains(event.target as Node)) return;
      keys.current(event as KeyboardEvent);
    };
    dialog.addEventListener("keydown", listener);
    return () => dialog.removeEventListener("keydown", listener);
  }, [variant]);

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
  const pictureW = state.videoWidth ?? current.width ?? 1280;
  const pictureH = state.videoHeight ?? current.height ?? 720;
  const closeComment = () => {
    setCommenting(false);
    setRegion(undefined);
    setMarks([]);
    // the form's button that closed it goes away: the keys stay on the player
    video.current?.focus({ preventScroll: true });
  };
  const form = commenting ? (
    <FrameCommentForm
      media={current}
      frame={commentFrame}
      lastFrame={frames - 1}
      region={region}
      onRegionChange={setRegion}
      marks={marks}
      onMarksChange={setMarks}
      away={away}
      onBack={() => goToFrame(commentFrame)}
      onFrameChange={(value) => {
        setCommentFrame(value);
        if (value <= frames - 1) goToFrame(value);
      }}
      timecodeOf={(value) => timecode(value, fps)}
      timeOf={(value) => frameClock(value, fps)}
      overlayOf={(drawn) => overlayBase64(drawn, pictureW, pictureH)}
      onComment={handler}
      submitLabel={explicit ? undefined : d.media.comment.sendAgent}
      onSent={(value) => setNoted((list) => (list.includes(value) ? list : [...list, value]))}
      onClose={closeComment}
      className={variant === "full" ? "lg:sticky lg:top-0 lg:self-start" : undefined}
    />
  ) : null;
  return (
    <figure
      ref={root}
      data-media-slot="video"
      data-variant={variant}
      // The figure takes its container's surface; only full screen gives it its own (2026-11-20).
      className={cn(
        "grid min-w-0 gap-4 [&:fullscreen]:bg-background [&:fullscreen]:p-4",
        variant === "full" && commenting && "lg:grid-cols-[minmax(0,1fr)_22rem]",
        className,
      )}
      // Only keys from this figure: the large view's dialog is a portal whose events bubble through here.
      onKeyDown={(event) => {
        if (event.currentTarget.contains(event.target as Node)) onKeyDown(event);
      }}
      // A click on the picture, the timeline or a mark keeps the keys on the player (not on the page).
      onPointerDownCapture={(event) => {
        const target = event.target as HTMLElement;
        if (!target.closest("input, textarea, select, button, a, summary, [contenteditable]"))
          video.current?.focus({ preventScroll: true });
      }}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <div
          ref={stage}
          className="relative mx-auto overflow-hidden border bg-black"
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
          {commenting ? (
            <>
              <RegionOverlay region={region} style={overlayStyle} />
              {away ? null : <MarksCanvas marks={marks} width={pictureW} height={pictureH} style={overlayStyle} />}
              <MarkOverlay
                disabled={away || marks.length >= MAX_FRAME_MARKS}
                style={overlayStyle}
                onAdd={(mark) => {
                  pause();
                  // The first mark pins the frame the player is on now: a seek just asked for (a key, the
                  // timeline) is already the element's time before its `seeked` reaches the state.
                  if (!marks.length) {
                    const live = video.current?.currentTime;
                    setCommentFrame(
                      clampFrame(frameAt(Number.isFinite(live) ? live! : state.time, fps), duration, fps),
                    );
                  }
                  setMarks((list) => (list.length >= MAX_FRAME_MARKS ? list : [...list, mark]));
                }}
              />
            </>
          ) : null}
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
              // the large view gives the scrubber its own row above the transport, as an editor does
              className={variant === "full" ? "order-first h-6 basis-full" : "h-8 min-w-24 flex-1"}
              thumb={{
                "aria-label": d.media.position,
                "aria-valuetext": f(d.media.positionValue, { frame, total: frames, time: timeText }),
                "data-scrub": "",
              }}
            />
            <output
              className={cn(
                "min-w-0 font-mono text-xs text-muted-foreground tabular-nums",
                variant === "full" && "ms-1 me-auto",
              )}
              data-frame={frame}
              aria-live="off"
            >
              <span className="text-foreground">{frameClock(frame, fps)}</span> ·{" "}
              {f(d.media.frame, { frame, total: frames })}
              {variant === "full" ? ` · TC ${timeText}` : null}
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
                onClick={() => (commenting ? closeComment() : startComment())}
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

        {state.error || duration <= 0 ? null : variant === "full" ? (
          <Timeline
            project={project}
            media={current}
            durationSec={duration}
            fps={fps}
            frames={frames}
            time={state.time}
            noted={noted}
            onSeekFrame={(value) => {
              pause();
              goToFrame(value);
            }}
          />
        ) : (
          <FrameStrip
            project={project}
            media={current}
            durationSec={duration}
            time={state.time}
            count={8}
            frameWidth={80}
            onSeek={(t) => {
              pause();
              seek(t);
            }}
          />
        )}

        {variant === "full" && !state.error ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-key-hints>
            {d.media.keyHints.map((hint) => (
              <span key={hint.label} className="inline-flex items-center gap-1">
                {hint.keys.map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
                {hint.label}
              </span>
            ))}
          </p>
        ) : null}

        {variant === "full" ? null : form}

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
      </div>

      {variant === "full" ? form : null}

      {variant === "inline" ? (
        <Dialog open={large} onOpenChange={setLarge}>
          <DialogContent
            className="max-w-7xl"
            // The player takes focus on open, so its keys work at once.
            onOpenAutoFocus={(event) => {
              const player = (event.target as HTMLElement | null)?.querySelector?.("video");
              if (!player) return;
              event.preventDefault();
              player.focus({ preventScroll: true });
            }}
          >
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
