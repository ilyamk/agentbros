/**
 * Frame and region comments (RFC 0004 US11): drag a rectangle over the paused picture, or type the frame and region
 * as numbers (the keyboard path), write the words, and the viewer emits a contract `FrameComment`. With no handler
 * (WP9/WP10 post them) the comment is shown as one line to copy for the agent, never silently dropped.
 */
import {
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { FrameComment, MediaRef } from "@contract";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { buildFrameComment, frameCommentText, regionFromDrag, regionStyle, type Region } from "./region";
import { useCopy } from "./studio-action";

export type FrameCommentHandler = (comment: FrameComment) => void;

const FrameCommentContext = createContext<FrameCommentHandler | undefined>(undefined);

/** Gives every media slot below a handler for frame comments (a verdict card, the feedback panel). */
export const FrameCommentProvider = FrameCommentContext.Provider;

export function useFrameCommentHandler(own?: FrameCommentHandler): FrameCommentHandler | undefined {
  const inherited = useContext(FrameCommentContext);
  return own ?? inherited;
}

export interface RegionOverlayProps {
  region?: Region;
  onChange: (region: Region | undefined) => void;
  /** Accepts drags only when true; otherwise only shows the region. */
  drawing: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * Sits exactly over the picture (the caller positions it over the letterboxed content) and turns a pointer drag into
 * a normalised region. Pointer only, hidden from assistive technology: the numeric form is the accessible path.
 */
export function RegionOverlay({ region, onChange, drawing, className, style }: RegionOverlayProps) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<Region | undefined>();
  const box = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drawing || event.button !== 0) return;
    event.preventDefault();
    start.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDraft(undefined);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    setDraft(regionFromDrag(start.current, { x: event.clientX, y: event.clientY }, box(event.currentTarget)));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const next = regionFromDrag(start.current, { x: event.clientX, y: event.clientY }, box(event.currentTarget));
    start.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setDraft(undefined);
    onChange(next);
  };
  const shown = draft ?? region;
  return (
    <div
      aria-hidden="true"
      data-region-overlay
      className={cn("absolute touch-none", drawing ? "cursor-crosshair" : "pointer-events-none", className)}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        start.current = null;
        setDraft(undefined);
      }}
    >
      {drawing ? <div className="absolute inset-0 ring-2 ring-primary/70 ring-inset" /> : null}
      {shown ? (
        <div
          data-region-rect
          className="absolute border-2 border-primary bg-primary/15 shadow-[0_0_0_1px_rgb(0_0_0/0.6)]"
          style={regionStyle(shown)}
        />
      ) : null}
    </div>
  );
}

export interface FrameCommentFormProps {
  media: MediaRef;
  frame: number;
  /** Last frame of the media. */
  lastFrame: number;
  region?: Region;
  onFrameChange: (frame: number) => void;
  onRegionChange: (region: Region | undefined) => void;
  timecodeOf: (frame: number) => string;
  /** Where the comment goes; without it the form offers the comment as text to copy. */
  onComment?: FrameCommentHandler;
  onClose: () => void;
}

const FIELDS = ["x", "y", "w", "h"] as const;

export function FrameCommentForm({
  media,
  frame,
  lastFrame,
  region,
  onFrameChange,
  onRegionChange,
  timecodeOf,
  onComment,
  onClose,
}: FrameCommentFormProps) {
  const { d, f } = useI18n();
  const id = useId();
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<keyof typeof d.media.comment.problems | undefined>();
  const [done, setDone] = useState<FrameComment | undefined>();
  // numeric region fields keep what the person types until it parses
  const [fields, setFields] = useState<Record<(typeof FIELDS)[number], string>>({ x: "", y: "", w: "", h: "" });
  const [fieldsFor, setFieldsFor] = useState<Region | undefined>();
  const { state: copyState, copy } = useCopy();
  if (region !== fieldsFor) {
    setFieldsFor(region);
    setFields(
      region
        ? { x: String(region.x), y: String(region.y), w: String(region.w), h: String(region.h) }
        : { x: "", y: "", w: "", h: "" },
    );
  }

  const setField = (key: (typeof FIELDS)[number], value: string) => {
    const next = { ...fields, [key]: value };
    setFields(next);
    const numbers = FIELDS.map((name) => Number(next[name]));
    if (FIELDS.every((name) => next[name].trim() !== "") && numbers.every(Number.isFinite)) {
      const [x, y, w, h] = numbers as [number, number, number, number];
      const candidate = { x, y, w, h };
      setFieldsFor(candidate);
      onRegionChange(candidate);
    }
  };

  const submit = () => {
    const typedRegion = FIELDS.some((name) => fields[name].trim() !== "");
    if (typedRegion && !region) {
      setProblem("region");
      return;
    }
    if (frame > lastFrame) {
      setProblem("frame");
      return;
    }
    const result = buildFrameComment({ media, frame, region, text });
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setProblem(undefined);
    setDone(result.comment);
    onComment?.(result.comment);
    if (onComment) {
      setText("");
      onRegionChange(undefined);
    }
  };

  const problemId = `${id}-problem`;
  return (
    <form
      data-frame-comment-form
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-3 rounded-lg border bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h4 id={`${id}-title`} className="text-sm font-semibold">
        {f(d.media.comment.title, { frame })}{" "}
        <span className="font-mono text-muted-foreground">{timecodeOf(frame)}</span>
      </h4>
      <p className="text-xs text-muted-foreground">{d.media.comment.drawHint}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-24 flex-col gap-1">
          <Label htmlFor={`${id}-frame`} className="text-xs">
            {d.media.comment.frame}
          </Label>
          <Input
            id={`${id}-frame`}
            type="number"
            inputMode="numeric"
            min={0}
            max={lastFrame}
            step={1}
            value={frame}
            aria-invalid={problem === "frame" || undefined}
            aria-describedby={problem === "frame" ? problemId : undefined}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isInteger(value) && value >= 0) onFrameChange(value);
            }}
          />
        </div>
        <fieldset className="flex min-w-0 flex-col gap-1">
          <legend className="mb-1 text-xs font-medium">{d.media.comment.region}</legend>
          <div className="flex flex-wrap items-end gap-2">
            {FIELDS.map((name) => (
              <div key={name} className="flex w-20 flex-col gap-1">
                <Label htmlFor={`${id}-${name}`} className="text-xs text-muted-foreground">
                  {d.media.comment[name]}
                </Label>
                <Input
                  id={`${id}-${name}`}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={1}
                  step={0.01}
                  value={fields[name]}
                  aria-invalid={problem === "region" || undefined}
                  aria-describedby={problem === "region" ? problemId : undefined}
                  onChange={(event) => setField(name, event.target.value)}
                />
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              disabled={!region && FIELDS.every((name) => !fields[name])}
              onClick={() => {
                setFields({ x: "", y: "", w: "", h: "" });
                onRegionChange(undefined);
              }}
            >
              {d.media.comment.clearRegion}
            </Button>
          </div>
        </fieldset>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-text`} className="text-xs">
          {d.media.comment.text}
        </Label>
        <Textarea
          id={`${id}-text`}
          value={text}
          maxLength={4000}
          aria-invalid={problem === "text" || undefined}
          aria-describedby={problem === "text" ? problemId : undefined}
          onChange={(event) => setText(event.target.value)}
        />
      </div>
      {problem ? (
        <p id={problemId} role="alert" className="text-xs text-destructive">
          {d.media.comment.problems[problem]}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm">
          {d.media.comment.send}
        </Button>
        <Button variant="outline" size="sm" onClick={onClose}>
          {d.media.comment.cancel}
        </Button>
      </div>
      <div role="status" className="text-xs">
        {done && onComment ? f(d.media.comment.added, { frame: done.frame }) : null}
      </div>
      {done && !onComment ? (
        <div className="flex flex-col gap-1.5 text-xs" data-frame-comment={JSON.stringify(done)}>
          <p className="text-muted-foreground">{d.media.comment.copyHint}</p>
          <pre className="overflow-x-auto rounded-sm bg-muted px-2 py-1 font-mono whitespace-pre-wrap">
            {frameCommentText(done, timecodeOf(done.frame))}
          </pre>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copy(frameCommentText(done, timecodeOf(done.frame)))}
            >
              {d.app.copy}
            </Button>
            <span className="text-muted-foreground">
              {copyState === "copied" ? d.media.studio.copied : copyState === "failed" ? d.media.studio.copyFailed : ""}
            </span>
          </div>
        </div>
      ) : null}
    </form>
  );
}
