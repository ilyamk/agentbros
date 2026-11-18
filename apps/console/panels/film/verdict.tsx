/**
 * The final verdict (RFC 0004 D24, US16, A13): an overall score from 1 to 10 (required), optional scores on the frozen
 * rubric axes, "what worked" and "what did not", optional frame comments, and the user's words. One POST decisions
 * request carries `verdict` and `frameComments` (VerdictSchema, FrameCommentSchema); the server applies
 * `film:approve --step human`, memory and feedback. No critic score or agent opinion is shown or prefilled here: a
 * critic's approval is never the user's (chain step `human`).
 *
 * Frame comments come from a pluggable input (`frameCommentInput`): the media viewer (WP6) can pass a component that
 * picks a frame or region on the render; the fallback takes a render, a frame number and a text.
 */
import { useEffect, useId, useMemo, useRef, useState, type ComponentType } from "react";
import {
  FrameCommentSchema,
  VerdictSchema,
  type DecisionRequest,
  type FrameComment,
  type MediaRef,
  type ProjectView,
  type Verdict,
} from "@contract";
import { CircleCheck, CircleX, Lightbulb, RotateCw, Trash2 } from "lucide-react";
import { IDEA_AXES, SCRIPT_AXES } from "../../../../src/lib/film/creative-rubric";
import { useI18n, type Dictionary } from "@/i18n";
import { useConsoleStore } from "@/store/context";
import { asFailure, isAmbiguous } from "@/api/errors";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select";
import { Disclosure } from "@/components/ui/disclosure";
import { MediaSlot, VideoViewer } from "@/media";
import type { PanelProps } from "../registry";
import { finalRenders } from "./qa";
import { StepFacts } from "./shared";
import { groupDecisions } from "./steps";
import { snapshotMode } from "@/lib/snapshot-mode";

/** The frozen rubric's axes (src/lib/film/creative-rubric.ts): the idea axes, then the script axes not already named. */
export const VERDICT_AXES: readonly string[] = [...new Set<string>([...IDEA_AXES, ...SCRIPT_AXES])];

/** The axes the form offers: the project's frozen rubric from the view (WP10b), else the current rubric's. */
export function verdictAxesOf(view: ProjectView): readonly string[] {
  return view.film?.human?.rubric.axes ?? VERDICT_AXES;
}

export interface FrameCommentInputProps {
  project: string;
  /** Renders the user may comment on, the film first. */
  media: MediaRef[];
  disabled?: boolean;
  onAdd: (comment: FrameComment) => void;
}

export interface VerdictFormProps {
  view: ProjectView;
  /** A frame picker from the media viewer (WP6); the numeric fallback otherwise. */
  frameCommentInput?: ComponentType<FrameCommentInputProps>;
}

type Phase = "idle" | "sending" | "uncertain" | "checking" | "recorded";
type Outcome = { tone: "refused" | "failed" | "uncertain"; message: string };

const axisName = (d: Dictionary, axis: string) => (d.film.verdict.axisNames as Record<string, string>)[axis] ?? axis;

/** The verdict as sent: only scored axes, no empty texts. Throws nothing; validation is the caller's. */
export function buildVerdict(input: {
  score: number | null;
  axes: Record<string, number | undefined>;
  worked: string;
  didNot: string;
}): Partial<Verdict> {
  const axes = Object.fromEntries(
    Object.entries(input.axes).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
  return {
    ...(input.score !== null ? { score: input.score } : {}),
    ...(Object.keys(axes).length ? { axes } : {}),
    ...(input.worked.trim() ? { worked: input.worked.trim() } : {}),
    ...(input.didNot.trim() ? { didNot: input.didNot.trim() } : {}),
  };
}

export function VerdictForm({ view, frameCommentInput: CommentInput = FrameCommentFallback }: VerdictFormProps) {
  const { d, f } = useI18n();
  const t = d.film.verdict;
  const store = useConsoleStore();
  const id = useId();
  const pending = groupDecisions(view, "human")[0];
  const film = view.media.latestRender;
  const renders = useMemo(() => finalRenders(view), [view]);
  const axesList = verdictAxesOf(view);
  const rubric = view.film?.human?.rubric;
  // A frame picker on the player itself (WP6) shows the film: no second player above it.
  const onPlayer = CommentInput !== FrameCommentFallback && renders.length > 0;
  const [score, setScore] = useState<number | null>(null);
  const [axes, setAxes] = useState<Record<string, number | undefined>>({});
  const [worked, setWorked] = useState("");
  const [didNot, setDidNot] = useState("");
  const [comments, setComments] = useState<FrameComment[]>([]);
  const [words, setWords] = useState(t.phrase);
  const [edited, setEdited] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [outcome, setOutcome] = useState<Outcome>();
  const [hint, setHint] = useState<{ field: "score" | "words" | "form"; text: string }>();
  const sending = useRef(false);
  const scoreGroup = useRef<HTMLFieldSetElement>(null);
  const wordsRef = useRef<HTMLTextAreaElement>(null);
  const locked = phase !== "idle";

  // The prefilled words follow the score until the user writes their own (D10).
  useEffect(() => {
    if (!edited) setWords(score === null ? t.phrase : f(t.phraseScore, { score }));
  }, [score, edited, t, f]);

  const submit = async () => {
    if (sending.current || locked) return;
    if (score === null) {
      setHint({ field: "score", text: t.scoreRequired });
      scoreGroup.current?.querySelector("input")?.focus();
      return;
    }
    if (!words.trim()) {
      setHint({ field: "words", text: t.emptyWords });
      wordsRef.current?.focus();
      return;
    }
    const verdict = VerdictSchema.safeParse(buildVerdict({ score, axes, worked, didNot }));
    if (!verdict.success) {
      setHint({ field: "form", text: f(t.invalid, { message: verdict.error.issues[0]?.message ?? "" }) });
      return;
    }
    setHint(undefined);
    const request: DecisionRequest = {
      ...(pending ? { decisionId: pending.id } : {}),
      kind: "verdict",
      step: "human",
      answer: words,
      ...(pending?.expect ? { expect: pending.expect } : {}),
      verdict: verdict.data,
      ...(comments.length ? { frameComments: comments } : {}),
    };
    sending.current = true;
    setPhase("sending");
    setOutcome(undefined);
    try {
      const reply = await store.decide(view.project.id, request);
      if (reply.ok) {
        setPhase("recorded");
        store.notify({ tone: "success", title: d.notices.applied, text: t.recorded });
      } else {
        const result = reply.decision.result;
        setOutcome({ tone: "refused", message: f(t.refused, { message: result?.message ?? result?.error ?? "" }) });
        setPhase("idle");
      }
    } catch (error) {
      const failure = asFailure(error);
      if (isAmbiguous(failure)) {
        setOutcome({ tone: "uncertain", message: f(d.submission.uncertain, { message: failure.message }) });
        setPhase("uncertain");
      } else {
        setOutcome({ tone: "failed", message: f(t.failed, { message: failure.message }) });
        setPhase("idle");
      }
    } finally {
      sending.current = false;
    }
  };

  /** After an ambiguous failure: reload the view; if the pending verdict left it, it was recorded. */
  const check = async () => {
    setPhase("checking");
    await store.loadView(view.project.id).catch(() => undefined);
    const latest = store.getState().views[view.project.id]?.data;
    const stillWaiting = pending && latest ? latest.waiting.some((item) => item.id === pending.id) : true;
    if (pending && !stillWaiting) {
      setOutcome(undefined);
      setPhase("recorded");
      return;
    }
    // Without a pending decision the view cannot tell whether a new verdict arrived: keep the uncertain warning (check
    // History before sending again), rather than inviting a second verdict.
    if (pending) setOutcome({ tone: "failed", message: d.submission.notApplied });
    setPhase("idle");
  };

  if (phase === "recorded")
    return (
      <div role="status" className="flex flex-col gap-2 rounded-lg border border-status-done/50 bg-card p-4 text-sm">
        <p className="flex items-center gap-2 font-medium">
          <CircleCheck className="size-4 text-status-done" aria-hidden="true" />
          {t.recorded}
        </p>
        <p className="flex items-start gap-2 text-muted-foreground">
          <Lightbulb className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{t.postmortem}</span>
        </p>
      </div>
    );

  return (
    <form
      aria-labelledby={`${id}-title`}
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 id={`${id}-title`} className="sr-only">
        {d.film.titles.human}
      </h3>
      <p className="text-sm">{t.intro}</p>
      {onPlayer ? (
        <section aria-label={t.film}>
          <CommentInput
            project={view.project.id}
            media={renders}
            disabled={locked}
            onAdd={(comment) => {
              const parsed = FrameCommentSchema.safeParse(comment);
              if (parsed.success) setComments((list) => (list.length < 64 ? [...list, parsed.data] : list));
            }}
          />
        </section>
      ) : null}
      {onPlayer ? null : film ? (
        <section aria-label={t.film} className="max-w-xl">
          <MediaSlot project={view.project.id} media={film} variant="inline" composition={film.composition} />
        </section>
      ) : (
        <p className="text-sm text-status-waiting">{t.noRender}</p>
      )}

      <fieldset
        ref={scoreGroup}
        disabled={locked}
        aria-describedby={hint?.field === "score" ? `${id}-score-hint` : undefined}
        aria-invalid={hint?.field === "score" ? true : undefined}
        className="flex flex-col gap-2"
      >
        <legend className="mb-2 text-sm font-medium">{t.score}</legend>
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: 10 }, (_, index) => index + 1).map((value) => (
            <label
              key={value}
              className={cn(
                "flex size-9 cursor-pointer items-center justify-center rounded-md border text-sm font-medium tabular-nums transition-colors duration-150 has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50",
                score === value ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted",
              )}
            >
              <input
                type="radio"
                name={`${id}-score`}
                value={value}
                checked={score === value}
                onChange={() => {
                  setScore(value);
                  if (hint?.field === "score") setHint(undefined);
                }}
                aria-label={f(t.scoreValue, { n: value })}
                className="sr-only"
              />
              <span aria-hidden="true">{value}</span>
            </label>
          ))}
        </div>
        {hint?.field === "score" ? (
          <p id={`${id}-score-hint`} className="text-xs text-status-blocked">
            {hint.text}
          </p>
        ) : null}
      </fieldset>

      <Disclosure
        variant="card"
        summary={
          <>
            {t.axes}
            {rubric ? (
              <span className="font-normal text-muted-foreground"> · {f(t.rubric, { version: rubric.version })}</span>
            ) : null}
          </>
        }
        contentClassName="mt-1"
      >
        <p className="text-xs text-muted-foreground">{t.axesHint}</p>
        <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
          {axesList.map((axis) => (
            <div key={axis} className="flex flex-col gap-1">
              <Label htmlFor={`${id}-axis-${axis}`}>{axisName(d, axis)}</Label>
              <SelectField
                id={`${id}-axis-${axis}`}
                data={{ "data-axis": axis }}
                disabled={locked}
                value={String(axes[axis] ?? "")}
                onValueChange={(value) => setAxes({ ...axes, [axis]: value ? Number(value) : undefined })}
                options={[
                  { value: "", label: t.axisNone },
                  ...Array.from({ length: 10 }, (_, index) => ({ value: String(index + 1), label: index + 1 })),
                ]}
              />
            </div>
          ))}
        </div>
      </Disclosure>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-worked`}>{t.worked}</Label>
          <Textarea
            id={`${id}-worked`}
            rows={3}
            maxLength={4000}
            disabled={locked}
            value={worked}
            onChange={(event) => setWorked(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-didnot`}>{t.didNot}</Label>
          <Textarea
            id={`${id}-didnot`}
            rows={3}
            maxLength={4000}
            disabled={locked}
            value={didNot}
            onChange={(event) => setDidNot(event.target.value)}
          />
        </div>
      </div>

      <section aria-labelledby={`${id}-comments`} className="flex flex-col gap-2">
        <h4 id={`${id}-comments`} className="text-sm font-medium">
          {t.frameComments}
        </h4>
        {comments.length ? (
          <ul className="flex flex-col gap-1.5">
            {comments.map((comment, index) => (
              <li
                key={`${comment.media.path}:${comment.frame}:${index}`}
                className="flex items-start gap-2 rounded-md bg-muted/60 px-2 py-1.5 text-sm"
              >
                <span className="min-w-0 flex-1 break-words">
                  <span className="block text-xs text-muted-foreground">
                    {f(t.commentOn, { frame: comment.frame, label: comment.media.label ?? comment.media.path })}
                  </span>
                  {comment.text}
                </span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={locked}
                  aria-label={f(t.removeComment, { frame: comment.frame })}
                  onClick={() => setComments(comments.filter((_, other) => other !== index))}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {renders.length && !onPlayer ? (
          <CommentInput
            project={view.project.id}
            media={renders}
            disabled={locked}
            onAdd={(comment) => {
              const parsed = FrameCommentSchema.safeParse(comment);
              if (parsed.success && comments.length < 64) setComments([...comments, parsed.data]);
            }}
          />
        ) : null}
      </section>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-words`}>{t.words}</Label>
        <Textarea
          ref={wordsRef}
          id={`${id}-words`}
          rows={2}
          disabled={locked}
          value={words}
          aria-describedby={`${id}-words-hint`}
          aria-invalid={hint?.field === "words" ? true : undefined}
          onChange={(event) => {
            setWords(event.target.value);
            setEdited(true);
            if (hint?.field === "words") setHint(undefined);
          }}
        />
        <p
          id={`${id}-words-hint`}
          className={cn("text-xs", hint?.field === "words" ? "text-status-blocked" : "text-muted-foreground")}
        >
          {hint?.field === "words" ? hint.text : t.wordsHint}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={locked} data-verdict-submit="">
          {phase === "sending" ? t.sending : t.submit}
        </Button>
        {phase === "uncertain" ? (
          <Button type="button" variant="outline" onClick={() => void check()}>
            <RotateCw aria-hidden="true" />
            {d.submission.check}
          </Button>
        ) : null}
      </div>
      <p role="status" aria-live="polite" className="text-sm empty:hidden">
        {phase === "checking" ? d.submission.checking : null}
        {hint?.field === "form" ? <span className="text-status-blocked">{hint.text}</span> : null}
        {outcome ? (
          <span className="flex items-start gap-1.5">
            <CircleX
              className={cn(
                "mt-0.5 size-4 shrink-0",
                outcome.tone === "uncertain" ? "text-status-waiting" : "text-status-blocked",
              )}
              aria-hidden="true"
            />
            <span className="break-words">{outcome.message}</span>
          </span>
        ) : null}
      </p>
    </form>
  );
}

/** Highest frame index of a render when its length is known. */
export function lastFrame(media: MediaRef): number | undefined {
  if (media.durationSec === undefined || media.fps === undefined) return undefined;
  return Math.max(0, Math.round(media.durationSec * media.fps) - 1);
}

/** The fallback frame comment input: a render, a whole frame number and the text. */
export function FrameCommentFallback({ media, disabled, onAdd }: FrameCommentInputProps) {
  const { d, f } = useI18n();
  const t = d.film.verdict;
  const id = useId();
  const [path, setPath] = useState(media[0]?.path ?? "");
  const [frame, setFrame] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState(false);
  const selected = media.find((item) => item.path === path) ?? media[0];
  const max = selected ? lastFrame(selected) : undefined;

  const add = () => {
    const value = Number(frame);
    const valid =
      selected !== undefined &&
      frame.trim() !== "" &&
      Number.isInteger(value) &&
      value >= 0 &&
      (max === undefined || value <= max) &&
      text.trim() !== "";
    if (!valid || !selected) {
      setError(true);
      return;
    }
    setError(false);
    onAdd({ media: selected, frame: value, text: text.trim() });
    setFrame("");
    setText("");
  };

  return (
    <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[minmax(0,12rem)_6rem_minmax(0,1fr)_auto] sm:items-end">
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={`${id}-media`}>{t.render}</Label>
        <SelectField
          id={`${id}-media`}
          disabled={disabled}
          value={selected?.path ?? ""}
          onValueChange={setPath}
          options={media.map((item) => ({ value: item.path, label: item.label ?? item.path }))}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-frame`}>{t.frame}</Label>
        <Input
          id={`${id}-frame`}
          inputMode="numeric"
          disabled={disabled}
          value={frame}
          aria-describedby={`${id}-frame-hint`}
          aria-invalid={error ? true : undefined}
          onChange={(event) => setFrame(event.target.value)}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={`${id}-text`}>{t.comment}</Label>
        <Input
          id={`${id}-text`}
          disabled={disabled}
          value={text}
          maxLength={4000}
          aria-invalid={error ? true : undefined}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
      </div>
      <Button type="button" variant="outline" disabled={disabled} onClick={add}>
        {t.addComment}
      </Button>
      <p
        id={`${id}-frame-hint`}
        className={cn("text-xs sm:col-span-4", error ? "text-status-blocked" : "text-muted-foreground")}
      >
        {error ? t.commentInvalid : max !== undefined ? f(t.frameHint, { max }) : t.frameHintOpen}
      </p>
    </div>
  );
}

/**
 * The media viewer's frame picker (WP6) as the verdict's frame-comment input: the film's own player, with a render
 * chooser when there are several; a frame or region comment from the player is added to the verdict.
 */
export function PlayerFrameCommentInput({ project, media, disabled, onAdd }: FrameCommentInputProps) {
  const { d } = useI18n();
  const t = d.film.verdict;
  const id = useId();
  const [path, setPath] = useState(media[0]?.path ?? "");
  const selected = media.find((item) => item.path === path) ?? media[0];
  if (!selected) return null;
  return (
    <div className="flex max-w-xl flex-col gap-2" data-frame-comment-input="player">
      {media.length > 1 ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-render`}>{t.render}</Label>
          <SelectField
            id={`${id}-render`}
            disabled={disabled}
            value={selected.path}
            onValueChange={setPath}
            options={media.map((item) => ({ value: item.path, label: item.label ?? item.path }))}
          />
        </div>
      ) : null}
      <VideoViewer
        project={project}
        media={selected}
        variant="inline"
        composition={selected.composition}
        onFrameComment={disabled ? undefined : onAdd}
      />
    </div>
  );
}

let frameCommentInput: ComponentType<FrameCommentInputProps> | undefined;

/**
 * Lets the media viewer (WP6) supply the frame picker the verdict panel uses, without editing this module:
 * `setVerdictFrameCommentInput(FramePicker)` once at boot; `undefined` restores the numeric fallback.
 */
export function setVerdictFrameCommentInput(component: ComponentType<FrameCommentInputProps> | undefined): void {
  frameCommentInput = component;
}

export function VerdictPanel({ view }: PanelProps) {
  const { d } = useI18n();
  return (
    <div className="flex flex-col gap-4">
      <StepFacts view={view} group="human" />
      {groupDecisions(view, "human").length ? (
        <p className="text-sm font-medium text-status-waiting">
          <span className="text-foreground">{d.film.verdict.waitingPhrase}</span>
        </p>
      ) : null}
      {/* The verdict is given only on the live console (WP15: a snapshot is read-only). */}
      {snapshotMode() ? (
        <p className="text-sm text-muted-foreground">{d.snapshot.readOnly}</p>
      ) : (
        <VerdictForm view={view} frameCommentInput={frameCommentInput} />
      )}
    </div>
  );
}
