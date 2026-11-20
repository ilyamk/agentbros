/**
 * Frame comments (RFC 0004 US11; marks 2026-11-20). On the paused frame a click puts a point (an arrow points at it), a
 * drag a box; each mark gets its words, drawn beside it. The form adds the comment for the agent; the frame and an area
 * can also be typed as numbers (the keyboard path). The viewer emits a contract `FrameComment` with the marks and the
 * overlay PNG drawn from them; with no handler the comment is shown as text to copy for the agent, never dropped.
 */
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { MAX_FRAME_MARKS, type FrameComment, type MediaRef } from "@contract";
import { CircleDot, Square, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { Input, Label, Textarea } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { commentWords, contractMarks, drawMarks, isBox, markFromGesture, type DraftMark } from "./marks";
import { buildFrameComment, frameCommentText, regionStyle, type Region } from "./region";
import { useCopy } from "./studio-action";

/** What the viewer adds to a comment: the marks drawn as the user saw them (a transparent PNG, base64). */
export interface FrameCommentExtras {
  overlay?: string;
}

export type FrameCommentHandler = (comment: FrameComment, extras?: FrameCommentExtras) => void;

const FrameCommentContext = createContext<FrameCommentHandler | undefined>(undefined);

/** Gives every media slot below a handler for frame comments (a verdict card, the feedback panel). */
export const FrameCommentProvider = FrameCommentContext.Provider;

export function useFrameCommentHandler(own?: FrameCommentHandler): FrameCommentHandler | undefined {
  const inherited = useContext(FrameCommentContext);
  return own ?? inherited;
}

export interface RegionOverlayProps {
  region?: Region;
  className?: string;
  style?: CSSProperties;
}

/** Shows the typed region over the picture (the caller positions it over the letterboxed content). */
export function RegionOverlay({ region, className, style }: RegionOverlayProps) {
  if (!region) return null;
  return (
    <div aria-hidden="true" className={cn("pointer-events-none absolute", className)} style={style}>
      <div
        data-region-rect
        className="absolute border-2 border-dashed border-primary bg-primary/10"
        style={regionStyle(region)}
      />
    </div>
  );
}

export interface MarkOverlayProps {
  /** A click or a drag made a mark. */
  onAdd: (mark: DraftMark) => void;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * Sits exactly over the picture and turns a click into a point and a drag into a box (normalised to the picture).
 * Pointer only, hidden from assistive technology: the form's numeric fields are the accessible path.
 */
export function MarkOverlay({ onAdd, disabled, className, style }: MarkOverlayProps) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<DraftMark | undefined>();
  const box = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    start.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDraft(undefined);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const mark = markFromGesture(start.current, { x: event.clientX, y: event.clientY }, box(event.currentTarget));
    setDraft(mark && isBox(mark) ? mark : undefined);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const mark = markFromGesture(start.current, { x: event.clientX, y: event.clientY }, box(event.currentTarget));
    start.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setDraft(undefined);
    if (mark) onAdd(mark);
  };
  return (
    <div
      aria-hidden="true"
      data-mark-overlay
      data-region-overlay
      className={cn("absolute touch-none", disabled ? "pointer-events-none" : "cursor-crosshair", className)}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        start.current = null;
        setDraft(undefined);
      }}
    >
      {draft ? (
        <div
          data-mark-draft
          className="absolute border-2 border-dashed border-destructive"
          style={regionStyle({ x: draft.x, y: draft.y, w: draft.w!, h: draft.h! })}
        />
      ) : null}
    </div>
  );
}

const inJsdom = () => typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent);

/**
 * The marks drawn over the picture by the same code that draws the overlay the agent receives: a canvas at the
 * video's size, scaled by CSS onto the picture.
 */
export function MarksCanvas({
  marks,
  width,
  height,
  style,
}: {
  marks: readonly DraftMark[];
  width: number;
  height: number;
  style?: CSSProperties;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element || inJsdom()) return;
    const ctx = element.getContext("2d");
    if (ctx) drawMarks(ctx, marks, width, height);
  }, [marks, width, height]);
  if (!marks.length) return null;
  return (
    <canvas
      ref={canvas}
      aria-hidden="true"
      data-marks-canvas
      width={width}
      height={height}
      className="pointer-events-none absolute"
      style={style}
    />
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
  /** `mm:ss:ff` timecode of a frame. */
  timecodeOf: (frame: number) => string;
  /** `mm:ss.mmm` of a frame's start. */
  timeOf?: (frame: number) => string;
  marks?: DraftMark[];
  onMarksChange?: (marks: DraftMark[]) => void;
  /** The playhead left the frame the marks are on. */
  away?: boolean;
  onBack?: () => void;
  /** Draws the overlay of the marks for the agent (the viewer knows the video's size). */
  overlayOf?: (marks: readonly DraftMark[]) => string | undefined;
  /** Where the comment goes; without it the form offers the comment as text to copy. */
  onComment?: FrameCommentHandler;
  /** After a comment went to the handler: its frame, for the timeline's markers. */
  onSent?: (frame: number) => void;
  /** The submit button's words (default: add the comment). */
  submitLabel?: string;
  onClose: () => void;
  className?: string;
}

const FIELDS = ["x", "y", "w", "h"] as const;
type Problem = "text" | "frame" | "region" | "marks" | "markText";

export function FrameCommentForm({
  media,
  frame,
  lastFrame,
  region,
  onFrameChange,
  onRegionChange,
  timecodeOf,
  timeOf,
  marks = [],
  onMarksChange,
  away,
  onBack,
  overlayOf,
  onComment,
  onSent,
  submitLabel,
  onClose,
  className,
}: FrameCommentFormProps) {
  const { d, f } = useI18n();
  const t = d.media.comment;
  const id = useId();
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<Problem | undefined>();
  const [done, setDone] = useState<FrameComment | undefined>();
  // numeric region fields keep what the person types until it parses
  const [fields, setFields] = useState<Record<(typeof FIELDS)[number], string>>({ x: "", y: "", w: "", h: "" });
  const [fieldsFor, setFieldsFor] = useState<Region | undefined>();
  const { state: copyState, copy } = useCopy();
  const markInputs = useRef<(HTMLInputElement | null)[]>([]);
  const [focusMark, setFocusMark] = useState<number | undefined>();
  const [seenMarks, setSeenMarks] = useState(marks.length);
  if (marks.length !== seenMarks) {
    // a new mark: its words come next
    if (marks.length > seenMarks) setFocusMark(marks.length - 1);
    setSeenMarks(marks.length);
  }
  useEffect(() => {
    if (focusMark === undefined) return;
    markInputs.current[focusMark]?.focus();
    setFocusMark(undefined);
  }, [focusMark]);
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

  const setMark = (index: number, words: string) =>
    onMarksChange?.(marks.map((mark, at) => (at === index ? { ...mark, text: words } : mark)));

  const submit = () => {
    const typedRegion = FIELDS.some((name) => fields[name].trim() !== "");
    if (typedRegion && !region) return setProblem("region");
    if (frame > lastFrame) return setProblem("frame");
    if (marks.some((mark) => !mark.text.trim())) return setProblem("markText");
    const result = buildFrameComment({
      media,
      frame,
      region,
      marks: contractMarks(marks),
      text: commentWords(text, marks),
    });
    if (!result.ok) return setProblem(result.problem);
    setProblem(undefined);
    setDone(result.comment);
    if (!onComment) return;
    onComment(result.comment, marks.length ? { overlay: overlayOf?.(marks) } : undefined);
    onSent?.(result.comment.frame);
    setText("");
    onRegionChange(undefined);
    onMarksChange?.([]);
  };

  const problemId = `${id}-problem`;
  const full = marks.length >= MAX_FRAME_MARKS;
  return (
    <form
      data-frame-comment-form
      aria-labelledby={`${id}-title`}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className={cn("min-w-0", className)}
    >
      <Card className="gap-3 py-3 text-sm">
        <CardHeader className="flex flex-col gap-1 px-3">
          <h4 id={`${id}-title`} className="flex flex-wrap items-baseline gap-x-2 font-semibold">
            {f(t.title, { frame })}
            <span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">
              {timeOf ? `${timeOf(frame)} · ` : ""}TC {timecodeOf(frame)}
            </span>
          </h4>
          <p className="text-xs text-muted-foreground">{t.drawHint}</p>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-3 px-3">
          {away ? (
            <div role="status" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{f(t.away, { frame })}</span>
              {onBack ? (
                <Button type="button" size="sm" variant="outline" onClick={onBack}>
                  <Undo2 aria-hidden="true" />
                  {f(t.back, { frame })}
                </Button>
              ) : null}
            </div>
          ) : null}
          {marks.length ? (
            <ol aria-label={t.marks} className="flex flex-col gap-2" data-marks-list>
              {marks.map((mark, index) => (
                <li key={index} className="flex items-center gap-2" data-mark={index + 1}>
                  <span
                    aria-hidden="true"
                    className="flex size-5 shrink-0 items-center justify-center rounded-full bg-destructive text-xs font-semibold text-white"
                  >
                    {index + 1}
                  </span>
                  {isBox(mark) ? (
                    <Square className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  ) : (
                    <CircleDot className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  )}
                  <Input
                    ref={(element) => {
                      markInputs.current[index] = element;
                    }}
                    aria-label={f(isBox(mark) ? t.boxText : t.pointText, { n: index + 1 })}
                    placeholder={t.markPlaceholder}
                    value={mark.text}
                    maxLength={300}
                    aria-invalid={(problem === "markText" && !mark.text.trim()) || undefined}
                    aria-describedby={problem === "markText" ? problemId : undefined}
                    onChange={(event) => setMark(index, event.target.value)}
                    className="h-8 min-w-0 flex-1"
                  />
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={f(t.removeMark, { n: index + 1 })}
                    onClick={() => onMarksChange?.(marks.filter((_, at) => at !== index))}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-muted-foreground" data-marks-empty>
              {t.noMarks}
            </p>
          )}
          {full ? <p className="text-xs text-muted-foreground">{f(t.marksFull, { n: MAX_FRAME_MARKS })}</p> : null}
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-text`} className="text-xs">
              {t.text}
            </Label>
            <Textarea
              id={`${id}-text`}
              value={text}
              maxLength={4000}
              placeholder={marks.length ? t.textOptional : undefined}
              aria-invalid={problem === "text" || undefined}
              aria-describedby={problem === "text" ? problemId : undefined}
              onChange={(event) => setText(event.target.value)}
            />
          </div>
          <div className="flex w-28 flex-col gap-1">
            <Label htmlFor={`${id}-frame`} className="text-xs">
              {t.frame}
            </Label>
            <Input
              id={`${id}-frame`}
              type="number"
              inputMode="numeric"
              min={0}
              max={lastFrame}
              step={1}
              value={frame}
              className="h-8"
              aria-invalid={problem === "frame" || undefined}
              aria-describedby={problem === "frame" ? problemId : undefined}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isInteger(value) && value >= 0) onFrameChange(value);
              }}
            />
          </div>
          <Disclosure summary={t.region} size="xs" muted>
            <fieldset className="mt-2 flex min-w-0 flex-wrap items-end gap-2">
              <legend className="sr-only">{t.region}</legend>
              {FIELDS.map((name) => (
                <div key={name} className="flex w-20 flex-col gap-1">
                  <Label htmlFor={`${id}-${name}`} className="text-xs text-muted-foreground">
                    {t[name]}
                  </Label>
                  <Input
                    id={`${id}-${name}`}
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={1}
                    step={0.01}
                    value={fields[name]}
                    className="h-8"
                    aria-invalid={problem === "region" || undefined}
                    aria-describedby={problem === "region" ? problemId : undefined}
                    onChange={(event) => setField(name, event.target.value)}
                  />
                </div>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!region && FIELDS.every((name) => !fields[name])}
                onClick={() => {
                  setFields({ x: "", y: "", w: "", h: "" });
                  onRegionChange(undefined);
                }}
              >
                {t.clearRegion}
              </Button>
            </fieldset>
          </Disclosure>
          {problem ? (
            <p id={problemId} role="alert" className="text-xs text-destructive">
              {t.problems[problem]}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm">
              {onComment ? (submitLabel ?? t.send) : t.make}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              {t.cancel}
            </Button>
          </div>
          <div role="status" className="text-xs empty:hidden">
            {done && onComment ? f(t.added, { frame: done.frame }) : null}
          </div>
          {done && !onComment ? (
            <div className="flex flex-col gap-1.5 text-xs" data-frame-comment={JSON.stringify(done)}>
              <p className="text-muted-foreground">{t.copyHint}</p>
              <pre className="overflow-x-auto rounded-sm bg-muted px-2 py-1 font-mono whitespace-pre-wrap">
                {frameCommentText(done, timecodeOf(done.frame))}
              </pre>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void copy(frameCommentText(done, timecodeOf(done.frame)))}
                >
                  {d.app.copy}
                </Button>
                <span className="text-muted-foreground">
                  {copyState === "copied"
                    ? d.media.studio.copied
                    : copyState === "failed"
                      ? d.media.studio.copyFailed
                      : ""}
                </span>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </form>
  );
}
