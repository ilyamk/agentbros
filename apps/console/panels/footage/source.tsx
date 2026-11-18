/** Footage panels: the recording (source check) and its transcript (speakers, words with times, glued words). */
import type { FootageMaterial } from "@contract";
import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n, type Dictionary } from "@/i18n";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { MediaSlot } from "@/media";
import type { PanelProps } from "../registry";
import { Block, Facts } from "../film/shared";
import { FootageStepHeader, NothingYet } from "./shared";
import { material, secClock } from "./steps";

function sourceRows(source: NonNullable<FootageMaterial["source"]>, d: Dictionary): [string, ReactNode][] {
  const rows: [string, ReactNode][] = [
    [d.footage.source.file, <code className="font-mono text-xs break-all">{source.file}</code>],
  ];
  if (source.durationSec !== undefined)
    rows.push([d.footage.source.duration, formatDuration(source.durationSec * 1000, d.units)]);
  if (source.width && source.height) rows.push([d.footage.source.size, `${source.width}×${source.height}`]);
  if (source.fps) rows.push([d.footage.source.fps, source.fps]);
  return rows;
}

export function SourcePanel({ view }: PanelProps) {
  const { d } = useI18n();
  const source = material(view).source;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <FootageStepHeader view={view} group="source" />
      {source ? (
        <>
          {source.media ? (
            <MediaSlot project={view.project.id} media={source.media} variant="inline" />
          ) : (
            <p className="text-sm text-muted-foreground">{d.footage.source.outside}</p>
          )}
          <Facts rows={sourceRows(source, d)} />
          {source.problems.length ? (
            <Block title={d.footage.source.problems}>
              <ul className="flex flex-col gap-1 text-sm">
                {source.problems.map((problem, index) => (
                  <li key={index} className="flex items-start gap-2 break-words">
                    <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-stale" />
                    {problem}
                  </li>
                ))}
              </ul>
            </Block>
          ) : null}
        </>
      ) : (
        <NothingYet />
      )}
    </div>
  );
}

function Words({ transcript }: { transcript: NonNullable<FootageMaterial["transcript"]> }) {
  const { d } = useI18n();
  let speaker: string | undefined;
  return (
    <p
      lang={transcript.language === "und" ? undefined : transcript.language}
      className="max-h-72 overflow-y-auto rounded-lg border px-3 py-2 text-sm leading-7"
    >
      {transcript.words.map((word, index) => {
        const turn = word.speaker !== undefined && word.speaker !== speaker && transcript.speakers.length > 1;
        speaker = word.speaker ?? speaker;
        return (
          <span key={index}>
            {turn ? (
              <span className="me-1 rounded bg-muted px-1 font-mono text-xs text-muted-foreground">{word.speaker}</span>
            ) : null}
            <span
              title={`${secClock(word.start)}–${secClock(word.end)}${word.kind === "filler" ? ` · ${d.footage.transcript.filler}` : ""}`}
              className={cn(
                word.kind === "filler" && "underline decoration-chart-3 decoration-2 underline-offset-4",
                word.kind === "event" && "text-muted-foreground",
              )}
            >
              {word.kind === "event" ? `[${word.text}]` : word.text}
            </span>{" "}
          </span>
        );
      })}
    </p>
  );
}

export function TranscriptPanel({ view }: PanelProps) {
  const { d, f, p } = useI18n();
  const transcript = material(view).transcript;
  const yes = (value: boolean) => (value ? d.footage.transcript.yes : d.footage.transcript.no);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <FootageStepHeader view={view} group="transcript" />
      {transcript ? (
        <>
          <Facts
            rows={[
              [d.footage.transcript.engine, `${transcript.provider} · ${transcript.model}`],
              [d.footage.transcript.language, transcript.language],
              [d.footage.transcript.verbatim, yes(transcript.verbatim)],
              [d.footage.transcript.diarized, yes(transcript.diarized)],
            ]}
          />
          {transcript.speakers.length ? (
            <Block title={d.footage.transcript.speakers}>
              <ul className="flex flex-wrap gap-2 text-sm">
                {transcript.speakers.map((speaker) => (
                  <li key={speaker.id} className="rounded-md bg-muted/60 px-2 py-1">
                    {f(d.footage.transcript.speakerWords, {
                      speaker: speaker.label ?? speaker.id,
                      words: p(d.footage.transcript.words, speaker.words),
                    })}
                  </li>
                ))}
              </ul>
            </Block>
          ) : null}
          <Block title={d.footage.transcript.excerpt}>
            {transcript.truncated ? (
              <p className="text-xs text-muted-foreground">
                {f(d.footage.transcript.excerptHint, { shown: transcript.words.length, total: transcript.wordCount })}
              </p>
            ) : null}
            <Words transcript={transcript} />
          </Block>
          {transcript.glued.length ? (
            <Block title={d.footage.transcript.glued}>
              <p className="text-xs text-muted-foreground">{d.footage.transcript.gluedHint}</p>
              <ul className="flex flex-col gap-1 text-sm">
                {transcript.glued.map((word, index) => (
                  <li key={index} className="break-words">
                    <span className="font-mono text-xs text-muted-foreground">{secClock(word.atSec)}</span>{" "}
                    <span className="font-medium">{word.text}</span> · {word.why}
                  </li>
                ))}
              </ul>
            </Block>
          ) : null}
        </>
      ) : (
        <NothingYet />
      )}
    </div>
  );
}
