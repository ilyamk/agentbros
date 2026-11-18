/**
 * Audio player with a lightweight waveform (RFC 0004 §10.2): the native <audio> element, a <canvas> drawn from PCM
 * decoded with Web Audio (peaks.ts; no wavesurfer), cue markers for the beats and cue sheet panel, and a plain bar
 * when the file is too large or cannot be decoded. Colours come from the theme tokens.
 */
import { useEffect, useRef, useState } from "react";
import type { MediaRef } from "@contract";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { mediaUrl } from "../../../src/lib/console/urls";
import { PLAYBACK_RATES, clock, resolveDuration } from "./frame-math";
import { MediaFacts, MediaUnavailable, mediaLabel } from "./media-facts";
import { loadPeaks, type Peaks } from "./peaks";
import { useBox } from "./use-box";
import { useMediaCommands, useMediaState } from "./use-media";

export interface CueMarker {
  /** Seconds from the start. */
  t: number;
  label?: string;
  /** Emphasis for downbeats, section starts or hits. */
  strong?: boolean;
}

export interface AudioPlayerProps {
  project: string;
  media: MediaRef;
  cues?: readonly CueMarker[];
  /** Decode at most this many bytes for the waveform. */
  maxWaveformBytes?: number;
  className?: string;
}

function token(element: Element, name: string, fallback: string) {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  return value || fallback;
}

/** Draws min/max bars of `peaks` on the canvas at device resolution; played part in the primary colour. */
export function drawWaveform(canvas: HTMLCanvasElement, peaks: Peaks, progress: number, width: number, height: number) {
  const context = canvas.getContext?.("2d");
  if (!context || width <= 0 || height <= 0) return;
  const ratio = globalThis.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const played = token(canvas, "--primary", "#6c5ce7");
  const rest = token(canvas, "--muted-foreground", "#a1a1aa");
  const columns = Math.max(1, Math.floor(width / 2));
  const middle = height / 2;
  for (let column = 0; column < columns; column++) {
    const from = Math.floor((column / columns) * peaks.buckets);
    const to = Math.max(from + 1, Math.floor(((column + 1) / columns) * peaks.buckets));
    let min = 0;
    let max = 0;
    for (let bucket = from; bucket < to; bucket++) {
      min = Math.min(min, peaks.values[bucket * 2] ?? 0);
      max = Math.max(max, peaks.values[bucket * 2 + 1] ?? 0);
    }
    const x = (column / columns) * width;
    context.fillStyle = column / columns < progress ? played : rest;
    const top = middle - Math.max(0.5, max * middle);
    const bottom = middle - Math.min(-0.5, min * middle);
    context.fillRect(x, top, 1.5, bottom - top);
  }
}

export function AudioPlayer({ project, media, cues, maxWaveformBytes, className }: AudioPlayerProps) {
  const { d, f } = useI18n();
  const src = mediaUrl(project, media);
  const audio = useRef<HTMLAudioElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const wave = useRef<HTMLDivElement>(null);
  const state = useMediaState(audio, src);
  const { toggle, seek, setRate } = useMediaCommands(audio);
  const [peaks, setPeaks] = useState<Peaks | undefined>();
  const [noWave, setNoWave] = useState(false);
  const box = useBox(wave);
  const duration = resolveDuration(state.duration, media.durationSec ?? peaks?.durationSec);
  const progress = duration > 0 ? state.time / duration : 0;
  const label = mediaLabel(media);

  useEffect(() => {
    let live = true;
    setPeaks(undefined);
    setNoWave(false);
    void loadPeaks(src, maxWaveformBytes ? { maxBytes: maxWaveformBytes } : undefined).then((result) => {
      if (!live) return;
      if (result.ok) setPeaks(result.peaks);
      else setNoWave(true);
    });
    return () => {
      live = false;
    };
  }, [src, maxWaveformBytes]);

  useEffect(() => {
    if (peaks && canvas.current) drawWaveform(canvas.current, peaks, progress, box.width, box.height);
  }, [peaks, progress, box.width, box.height]);

  if (state.error)
    return (
      <figure data-media-slot="audio" className={cn("flex min-w-0 flex-col gap-1", className)}>
        <audio ref={audio} src={src} preload="metadata" />
        <MediaUnavailable media={media} className="h-16 rounded-lg border" />
        <figcaption className="truncate text-xs font-medium">{label}</figcaption>
      </figure>
    );

  return (
    <figure data-media-slot="audio" className={cn("flex min-w-0 flex-col gap-2", className)}>
      <audio ref={audio} src={src} preload="metadata" />
      <div className="flex items-center gap-2">
        <Button
          size="icon-sm"
          variant="secondary"
          data-hotkey="play"
          aria-label={state.paused ? d.media.play : d.media.pause}
          onClick={toggle}
        >
          {state.paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
        </Button>
        <div ref={wave} className="relative h-14 min-w-0 flex-1 overflow-hidden rounded-md bg-muted/50">
          {peaks ? (
            <canvas
              ref={canvas}
              role="img"
              aria-label={f(d.media.audio.waveform, { label })}
              className="absolute inset-0 size-full"
            />
          ) : (
            <div
              data-waveform-fallback={noWave ? "" : undefined}
              className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-muted-foreground/30"
            >
              <div className="h-full rounded-full bg-primary" style={{ width: `${progress * 100}%` }} />
            </div>
          )}
          {duration > 0
            ? cues?.map((cue, index) => (
                <span
                  key={`${cue.t}-${index}`}
                  data-cue={cue.t}
                  title={f(d.media.audio.cue, { label: cue.label ?? "", time: clock(cue.t) })}
                  className={cn(
                    "pointer-events-none absolute inset-y-0 w-px",
                    cue.strong ? "bg-chart-3" : "bg-foreground/40",
                  )}
                  style={{ left: `${Math.min(100, Math.max(0, (cue.t / duration) * 100))}%` }}
                />
              ))
            : null}
          <input
            type="range"
            min={0}
            max={duration > 0 ? duration : 0}
            step={0.01}
            value={Math.min(state.time, duration)}
            aria-label={d.media.position}
            aria-valuetext={`${clock(state.time)} / ${clock(duration)}`}
            onChange={(event) => seek(Number(event.target.value))}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
          />
        </div>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {clock(state.time)} / {clock(duration)}
        </span>
        <SelectField
          aria-label={d.media.rate}
          size="sm"
          className="w-[4.75rem] shrink-0 px-2 text-xs tabular-nums"
          value={String(state.rate)}
          onValueChange={(value) => setRate(Number(value))}
          options={PLAYBACK_RATES.map((rate) => ({ value: String(rate), label: `${rate}×` }))}
        />
      </div>
      {noWave ? <p className="text-xs text-muted-foreground">{d.media.audio.noWaveform}</p> : null}
      <figcaption className="flex min-w-0 flex-col text-xs">
        <span className="truncate font-medium text-foreground">{label}</span>
        <MediaFacts media={media} durationSec={duration} />
      </figcaption>
    </figure>
  );
}
