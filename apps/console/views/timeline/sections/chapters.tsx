/**
 * Timeline section: chapters (RU-C01–C05, the review:ui parity checklist), the port of review:ui's
 * `createChapterReview` (chapter-client.ts):
 *
 * - Inspect sends `manifestSha256: null` and fills the chapter select (`title · start–end` rationals); choosing a
 *   chapter re-inspects bound to the manifest SHA of the previous reply ("Chapter manifest changed; refresh
 *   inspection" when it moved).
 * - A late reply is dropped unless the epoch, revision, timeline hash and format are all unchanged; every state display
 *   and every format change invalidates (no automatic inspection).
 * - Errors, a 409 included, stay in the chapter status and disable the select; they never refresh the page (the old
 *   client did not route chapters through `run()`).
 * - Read-only: inspection never renders, writes caches or approves delivery.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select";
import { useI18n } from "@/i18n";
import type { Rational } from "../api";
import { TimelineSection, type TimelineSectionProps } from "../section";
import { Field, JsonBlock, ratio } from "./review-kit";

export const CHAPTER_FORMATS = ["landscape", "vertical", "square"] as const;
export type ChapterFormat = (typeof CHAPTER_FORMATS)[number];

/** The `chapter-inspection` reply fields the section reads. */
export interface ChapterInspection {
  status: "absent" | "ready";
  revision: number;
  timelineHash: string;
  manifestSha256: string | null;
  journalSha256?: string;
  manifestRevision?: number;
  format: ChapterFormat;
  chapters: { id: string; title: string; start: Rational; end: Rational; revision?: number }[];
  selected?: { id: string; [key: string]: unknown };
}

type View =
  | { phase: "idle"; invalidated: boolean }
  | { phase: "inspecting"; chapters: ChapterInspection["chapters"]; selectedId?: string }
  | { phase: "done"; result: ChapterInspection; format: ChapterFormat }
  | { phase: "error"; message: string; chapters: ChapterInspection["chapters"]; selectedId?: string };

export function ChaptersSection({ api, controller }: TimelineSectionProps) {
  const { d, f } = useI18n();
  const t = d.timeline.chapters;
  const [format, setFormat] = useState<ChapterFormat>("landscape");
  const [view, setView] = useState<View>({ phase: "idle", invalidated: false });
  const epoch = useRef(0);
  const manifest = useRef<string | null>(null);
  const formatNow = useRef(format);

  useEffect(
    () =>
      controller.onDisplay(() => {
        epoch.current++;
        manifest.current = null;
        setView({ phase: "idle", invalidated: true });
      }),
    [controller],
  );

  const chapters = view.phase === "idle" ? [] : view.phase === "done" ? view.result.chapters : view.chapters;
  const selectedId =
    view.phase === "done" ? view.result.selected?.id : view.phase === "idle" ? undefined : view.selectedId;
  const selectDisabled = view.phase !== "done" || view.result.status === "absent";

  async function inspect(chapterId?: string) {
    const state = controller.getSnapshot().state;
    if (!state || state.revision === null || state.timelineHash === null) {
      setView({ phase: "error", message: t.needsTimeline, chapters: [] });
      return;
    }
    const current = ++epoch.current;
    const { revision, timelineHash } = state;
    const requested = formatNow.current;
    setView({ phase: "inspecting", chapters, selectedId: chapterId ?? selectedId });
    try {
      const result = (await api.chapterInspection({
        expectedRevision: revision,
        timelineHash,
        manifestSha256: chapterId === undefined ? null : manifest.current,
        format: requested,
        ...(chapterId === undefined ? {} : { chapterId }),
      })) as unknown as ChapterInspection;
      const now = controller.getSnapshot().state;
      if (
        current !== epoch.current ||
        now?.revision !== revision ||
        now.timelineHash !== timelineHash ||
        formatNow.current !== requested
      )
        return;
      manifest.current = result.manifestSha256;
      setView({ phase: "done", result, format: requested });
    } catch (error) {
      if (current !== epoch.current) return;
      setView({
        phase: "error",
        message: error instanceof Error ? error.message : String(error),
        chapters,
        selectedId: chapterId ?? selectedId,
      });
    }
  }

  const status =
    view.phase === "idle"
      ? view.invalidated
        ? t.invalidated
        : t.notInspected
      : view.phase === "inspecting"
        ? t.inspecting
        : view.phase === "error"
          ? view.message
          : view.result.status === "absent"
            ? t.absent
            : f(t.ready, {
                revision: view.result.revision,
                sha: String(view.result.manifestSha256),
                format: view.format,
              });

  return (
    <TimelineSection id="chapters" title={t.title} description={t.description}>
      <div className="grid gap-2 sm:grid-cols-[auto_1fr] sm:items-end">
        <Field htmlFor="chapter-format" label={t.format}>
          <SelectField
            id="chapter-format"
            className="sm:w-44"
            value={format}
            options={CHAPTER_FORMATS.map((value) => ({ value, label: t.formats[value] }))}
            onValueChange={(value) => {
              const next = value as ChapterFormat;
              formatNow.current = next;
              setFormat(next);
              epoch.current++;
              manifest.current = null;
              setView({ phase: "idle", invalidated: true });
            }}
          />
        </Field>
        <div>
          <Button id="chapter-refresh" variant="outline" onClick={() => void inspect()}>
            {t.inspect}
          </Button>
        </div>
      </div>
      <Field htmlFor="chapter-selection" label={t.chapter}>
        <SelectField
          id="chapter-selection"
          disabled={selectDisabled}
          value={selectedId ?? ""}
          onValueChange={(value) => void inspect(value)}
          options={chapters.map((chapter) => ({
            value: chapter.id,
            label: f(t.option, { title: chapter.title, start: ratio(chapter.start), end: ratio(chapter.end) }),
          }))}
        />
      </Field>
      <p
        id="chapter-status"
        role="status"
        className={view.phase === "error" ? "text-sm wrap-anywhere text-destructive" : "text-sm wrap-anywhere"}
      >
        {status}
      </p>
      {view.phase === "done" && view.result.status === "ready" ? (
        <p className="text-xs wrap-anywhere text-muted-foreground">
          {f(t.readyMeta, {
            journal: String(view.result.journalSha256),
            manifestRevision: String(view.result.manifestRevision),
          })}
        </p>
      ) : null}
      {view.phase === "done" ? (
        <JsonBlock id="chapter-inspection" value={view.result.selected ?? t.noChapters} />
      ) : (
        <pre id="chapter-inspection" hidden />
      )}
      <p className="text-xs text-muted-foreground">{t.candidate}</p>
    </TimelineSection>
  );
}
