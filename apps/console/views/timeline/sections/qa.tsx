/**
 * Timeline section: QA evidence and outputs (RU-Q01–Q05, the review:ui parity checklist), as review:ui did it
 * (client:531, 581-608):
 *
 * - The pin notice with the current timeline hash.
 * - One button per report (evidence runs, QA and editorial QA files, asset board, animatic) and per output
 *   (`@out/…` renders and screenshots), exactly the files `state()` allows.
 * - A review pack manifest opens the pack navigator (`review-pack` route): source, status, warnings, the source
 *   freshness (returned, never shown before), page, original-frame and crop previews inside the pack folder, and the
 *   truncation notice.
 * - A media file previews as video, audio or a lazy image; any other file is fetched with the token header and shown
 *   as text, so HTML reports are never executed. A failure reaches the status line ("Cannot open report").
 */
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { TimelineSection, type TimelineSectionProps } from "../section";
import { JsonBlock, ReviewMedia, reviewFileKind } from "./review-kit";

/** The `review-pack` reply fields the navigator reads (`inspectReviewPack` plus `sourceFreshness`). */
export interface ReviewPackView {
  source: { kind: string; sha256: string; path?: string };
  status: string;
  warnings: string[];
  pages: { kind: string; path: string; frameIds: string[] }[];
  frames: { id: string; timeSec: number; reasons: string[]; path: string; crops: { path: string }[] }[];
  truncated: boolean;
  sourceFreshness?: string;
}

type Opened =
  | { kind: "media"; file: string }
  | { kind: "text"; file: string; text: string }
  | { kind: "pack"; file: string; pack: ReviewPackView; preview?: string };

const fileButton =
  "h-auto max-w-full justify-start py-1.5 text-start font-mono text-xs wrap-anywhere whitespace-normal";

export function QaSection({ state, api, controller }: TimelineSectionProps) {
  const { d, f } = useI18n();
  const t = d.timeline.qa;
  const [opened, setOpened] = useState<Opened>();

  const open = (file: string) =>
    void controller.run(async () => {
      const kind = reviewFileKind(file);
      if (kind === "pack") setOpened({ kind, file, pack: (await api.reviewPack(file)) as unknown as ReviewPackView });
      else if (kind === "text") setOpened({ kind, file, text: await api.reportText(file) });
      else setOpened({ kind: "media", file });
    });

  const list = (files: string[], empty: string, heading: string) => (
    <div className="flex min-w-0 flex-col gap-1">
      <h4 className="text-sm font-medium">{heading}</h4>
      {files.length === 0 ? <p className="text-sm text-muted-foreground">{empty}</p> : null}
      <ul className="flex min-w-0 flex-col gap-1">
        {files.map((file) => (
          <li key={file} className="min-w-0">
            <Button
              variant="outline"
              size="sm"
              className={cn(fileButton, opened?.file === file && "border-primary")}
              aria-pressed={opened?.file === file}
              onClick={() => open(file)}
            >
              {file}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <TimelineSection id="qa" title={t.title} description={t.description}>
      <p id="qa-pin" className="text-sm wrap-anywhere">
        {f(t.pin, { hash: String(state.timelineHash) })}
      </p>
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div id="reports" className="flex min-w-0 flex-col gap-3">
          {list(state.reports, t.noReports, t.reports)}
          {list(state.outputs, t.noOutputs, t.outputs)}
        </div>
        <div id="report" aria-live="polite" className="flex min-w-0 flex-col gap-2">
          {opened ? (
            <>
              <p className="text-xs wrap-anywhere text-muted-foreground">{f(t.opened, { file: opened.file })}</p>
              {opened.kind === "media" ? <ReviewMedia key={opened.file} api={api} file={opened.file} /> : null}
              {opened.kind === "text" ? <JsonBlock value={opened.text} /> : null}
              {opened.kind === "pack" ? (
                <PackNavigator
                  file={opened.file}
                  pack={opened.pack}
                  preview={opened.preview}
                  api={api}
                  onPreview={(preview) => setOpened({ ...opened, preview })}
                />
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </TimelineSection>
  );
}

function PackNavigator({
  file,
  pack,
  preview,
  api,
  onPreview,
}: {
  file: string;
  pack: ReviewPackView;
  preview?: string;
  api: TimelineSectionProps["api"];
  onPreview: (file: string) => void;
}) {
  const { d, f } = useI18n();
  const t = d.timeline.qa;
  const parent = file.slice(0, file.lastIndexOf("/") + 1);
  const show = (path: string) => onPreview(parent + path);
  return (
    <div className="flex min-w-0 flex-col gap-2 text-sm" data-testid="review-pack">
      <div aria-label={t.packPreview} className="min-w-0">
        {preview ? <ReviewMedia key={preview} api={api} file={preview} /> : null}
      </div>
      <p className="wrap-anywhere">
        {f(t.packSource, { kind: pack.source.kind, sha256: pack.source.sha256, status: pack.status })}
      </p>
      {pack.sourceFreshness ? (
        <p>
          <Badge variant={pack.sourceFreshness === "verified" ? "secondary" : "outline"}>
            {f(t.freshness, { value: pack.sourceFreshness })}
          </Badge>
        </p>
      ) : null}
      {pack.warnings.map((warning) => (
        <p key={warning} role="note" className="text-amber-700 dark:text-amber-400">
          {warning}
        </p>
      ))}
      <div className="flex flex-wrap gap-1">
        {pack.pages.map((page) => (
          <Button key={page.path} size="sm" variant="outline" className={fileButton} onClick={() => show(page.path)}>
            {f(t.page, { kind: page.kind, frames: page.frameIds.join(", ") })}
          </Button>
        ))}
      </div>
      {pack.frames.map((frame) => (
        <div key={frame.id} className="flex min-w-0 flex-col gap-1 border-t pt-2">
          <p className="wrap-anywhere">
            {f(t.frame, { id: frame.id, time: frame.timeSec.toFixed(3), reasons: frame.reasons.join("; ") })}
          </p>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="outline" className={fileButton} onClick={() => show(frame.path)}>
              {f(t.original, { id: frame.id })}
            </Button>
            {frame.crops.map((crop, index) => (
              <Button
                key={crop.path}
                size="sm"
                variant="outline"
                className={fileButton}
                onClick={() => show(crop.path)}
              >
                {f(t.crop, { id: frame.id, n: index + 1 })}
              </Button>
            ))}
          </div>
        </div>
      ))}
      {pack.truncated ? <p>{t.truncated}</p> : null}
    </div>
  );
}
