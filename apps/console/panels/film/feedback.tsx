/**
 * The user's ratings and frame comments outside the gates (RFC 0004 §8, US10, US11, WP9). A rating of a styleframe or
 * reference posts a `rating` decision (the server runs `ref:rate`; a note also becomes a memory preference); a comment
 * pinned to a frame of a render posts a `frame-feedback` decision (the server runs `feedback --frame`, which reopens the
 * build so the fixer answers it next round). Both send the user's words verbatim; with no words, a rating sends the
 * bare score ("4/5"), which the server does not treat as a note. No optimistic update: the view refreshes from disk.
 */
import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import type { DecisionRequest, FrameComment, MediaRef } from "@contract";
import { CircleCheck, CircleX } from "lucide-react";
import { asFailure, isAmbiguous } from "@/api/errors";
import { StarRating } from "@/components/rating";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { FrameCommentProvider, type FrameCommentExtras } from "@/media";
import { useConsoleStore } from "@/store/context";
import { snapshotMode } from "@/lib/snapshot-mode";

/** The rating request for one file: the note when the user wrote one, else the bare score. */
export function ratingRequest(
  media: MediaRef,
  score: number,
  note: string,
  step?: string,
  requestId?: string,
): DecisionRequest {
  return {
    kind: "rating",
    ...(requestId ? { requestId } : {}),
    ...(step ? { step } : {}),
    answer: note.trim() ? note : `${score}/5`,
    ratings: { [media.path]: score },
    ...(media.sha256 ? { expect: media.sha256 } : {}),
  };
}

/** The frame-feedback request for one comment: the comment's words are the answer. */
export function frameFeedbackRequest(comment: FrameComment, requestId?: string, overlay?: string): DecisionRequest {
  return {
    kind: "frame-feedback",
    ...(requestId ? { requestId } : {}),
    answer: comment.text,
    frameComments: [comment],
    // the marks as drawn: the server also keeps the frame with them (`frame:note`, 2026-11-20)
    ...(overlay ? { overlay } : {}),
  };
}

/** A nonce for one submission: a retry of the same submission reuses it, so the server applies it once. */
export const newRequestId = (): string => crypto.randomUUID();

/** Only files inside the project can be rated (`ref:rate --path` is project-relative). */
export const ratable = (media: MediaRef): boolean => (media.root ?? "project") === "project";

type Outcome = { tone: "saved" | "refused" | "failed"; text: string };

export interface RateMediaProps {
  project: string;
  media: MediaRef;
  /** The user's latest rating, from pipeline/ratings.json. */
  current?: number;
  step?: string;
}

/** Stars, an optional note in the user's words and a save button for one styleframe or reference. */
/** Ratings are sent to the server: none on a static snapshot (WP15, D18). */
export function RateMedia(props: RateMediaProps) {
  return snapshotMode() ? null : <LiveRateMedia {...props} />;
}

function LiveRateMedia({ project, media, current, step }: RateMediaProps) {
  const { d, f } = useI18n();
  const t = d.film.rate;
  const store = useConsoleStore();
  const id = useId();
  const name = media.label ?? media.path;
  const [score, setScore] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
  const busy = useRef(false);
  // One id per submission: kept after an uncertain failure so "send again" cannot rate twice.
  const requestId = useRef<string | undefined>(undefined);

  const submit = async () => {
    if (busy.current || score === null) return;
    busy.current = true;
    setSending(true);
    setOutcome(undefined);
    try {
      requestId.current ??= newRequestId();
      const reply = await store.decide(project, ratingRequest(media, score, note, step, requestId.current));
      requestId.current = undefined;
      if (reply.ok) {
        setOutcome({ tone: "saved", text: f(t.saved, { score }) });
        setScore(null);
        setNote("");
      } else {
        const result = reply.decision.result;
        setOutcome({ tone: "refused", text: f(t.refused, { message: result?.message ?? result?.error ?? "" }) });
      }
    } catch (error) {
      const failure = asFailure(error);
      if (!isAmbiguous(failure)) requestId.current = undefined;
      setOutcome({
        tone: "failed",
        text: isAmbiguous(failure)
          ? f(d.submission.uncertain, { message: failure.message })
          : f(t.failed, { message: failure.message }),
      });
    } finally {
      busy.current = false;
      setSending(false);
    }
  };

  return (
    <form
      aria-label={f(t.form, { name })}
      data-rate-media={media.path}
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <span className={current !== undefined ? "text-xs font-medium" : "text-xs text-muted-foreground"}>
        {current !== undefined ? f(d.film.look.rating, { score: current }) : d.film.look.notRated}
      </span>
      <StarRating
        value={score}
        onValueChange={(value) => {
          requestId.current = undefined; // new content, new submission
          setScore(value);
        }}
        disabled={sending}
        label={f(t.stars, { name })}
        valueLabel={(n, max) => f(d.rating.outOf, { n, max })}
      />
      {score !== null ? (
        <>
          <Label htmlFor={`${id}-note`} className="text-xs">
            {t.note}
          </Label>
          <Textarea
            id={`${id}-note`}
            value={note}
            disabled={sending}
            rows={2}
            maxLength={4000}
            onChange={(event) => {
              requestId.current = undefined;
              setNote(event.target.value);
            }}
            className="text-xs"
          />
          <p className="text-xs text-muted-foreground">{t.noteHint}</p>
          <Button type="submit" size="sm" disabled={sending} className="self-start">
            {sending ? t.sending : t.save}
          </Button>
        </>
      ) : null}
      {outcome ? (
        <p
          role={outcome.tone === "saved" ? "status" : "alert"}
          className={`flex items-start gap-1 text-xs ${outcome.tone === "saved" ? "text-status-done" : "text-status-blocked"}`}
        >
          {outcome.tone === "saved" ? (
            <CircleCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <CircleX className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          )}
          <span>{outcome.text}</span>
        </p>
      ) : null}
    </form>
  );
}

/** Frame comments on every video below go to the project as frame feedback; the outcome is a notification. */
/** Frame comments are sent to the server: a static snapshot has no handler, so the viewers offer none (WP15). */
export function FrameFeedbackProvider({ project, children }: { project: string; children: ReactNode }) {
  return snapshotMode() ? (
    <>{children}</>
  ) : (
    <LiveFrameFeedbackProvider project={project}>{children}</LiveFrameFeedbackProvider>
  );
}

function LiveFrameFeedbackProvider({ project, children }: { project: string; children: ReactNode }) {
  const { d, f } = useI18n();
  const t = d.film.frameFeedback;
  const store = useConsoleStore();
  const send = useCallback(
    (comment: FrameComment, extras?: FrameCommentExtras) => {
      void (async () => {
        try {
          const reply = await store.decide(project, frameFeedbackRequest(comment, newRequestId(), extras?.overlay));
          if (reply.ok)
            store.notify({ tone: "success", title: d.notices.applied, text: f(t.sent, { frame: comment.frame }) });
          else {
            const result = reply.decision.result;
            store.notify({
              tone: "error",
              title: d.notices.refused,
              text: f(t.refused, { message: result?.message ?? result?.error ?? "" }),
            });
          }
        } catch (error) {
          const failure = asFailure(error);
          store.notify({
            tone: isAmbiguous(failure) ? "warning" : "error",
            title: d.notices.error,
            text: isAmbiguous(failure)
              ? f(d.submission.uncertain, { message: failure.message })
              : f(t.failed, { message: failure.message }),
          });
        }
      })();
    },
    [store, project, d, f, t],
  );
  return <FrameCommentProvider value={send}>{children}</FrameCommentProvider>;
}
