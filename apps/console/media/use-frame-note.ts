/**
 * The default destination of a frame comment (2026-11-20): a `frame-note` decision, on any route. The server runs
 * `frame:note`, which keeps the words and the marks beside the frame drawn with them, and `console:wait` hands both to
 * the agent. Absent on a static snapshot and outside a store (the form then offers the comment as text to copy).
 */
import { useCallback } from "react";
import type { DecisionRequest, FrameComment } from "@contract";
import { asFailure, isAmbiguous } from "@/api/errors";
import { useI18n } from "@/i18n";
import { snapshotMode } from "@/lib/snapshot-mode";
import { useOptionalConsoleStore } from "@/store/context";
import type { FrameCommentExtras, FrameCommentHandler } from "./region-comment";

/** The frame-note request for one comment: its words are the answer; the overlay travels beside it. */
export function frameNoteRequest(comment: FrameComment, requestId: string, overlay?: string): DecisionRequest {
  return {
    kind: "frame-note",
    requestId,
    answer: comment.text,
    frameComments: [comment],
    ...(overlay ? { overlay } : {}),
  };
}

export function useFrameNoteHandler(project: string): FrameCommentHandler | undefined {
  const store = useOptionalConsoleStore();
  const { d, f } = useI18n();
  const t = d.media.comment;
  const send = useCallback(
    (comment: FrameComment, extras?: FrameCommentExtras) => {
      if (!store) return;
      void (async () => {
        try {
          const reply = await store.decide(project, frameNoteRequest(comment, crypto.randomUUID(), extras?.overlay));
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
  return store && !snapshotMode() ? send : undefined;
}
