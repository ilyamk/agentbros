/**
 * Generations (2026-11-20): every paid model job of the project as a card, newest first: endpoint, state, the
 * provider's error as written, reserved and settled money (a reservation never reads as free), elapsed time, the prompt
 * and references, and once published the result in the media slot's player (frame strip, stepping). Above them the
 * latest model preparation: its prompt, references, board samples, approval and rights. Read-only: it shows
 * `view.generations` and never acts.
 */
import type { Generation, ModelPreparationView } from "@contract";
import { Clock, FileText, Sparkles, TriangleAlert } from "lucide-react";
import { plural, useI18n } from "@/i18n";
import { useNow } from "@/lib/clock";
import { formatDuration, formatTime, formatUsd } from "@/lib/format";
import { MediaSlot } from "@/media";
import { EmptyState } from "@/components/empty-state";
import { ToneBadge } from "@/components/status";
import { Disclosure } from "@/components/ui/disclosure";
import type { PanelProps } from "../registry";
import { JOB_TONE } from "./money";

/** States the provider is still working in (the elapsed time keeps counting). */
export const ACTIVE_STATES = new Set<Generation["state"]>([
  "reserved",
  "submitting",
  "queued",
  "running",
  "result-ready",
  "downloading",
]);

export const activeGenerations = (jobs: readonly Generation[] = []) =>
  jobs.filter((job) => ACTIVE_STATES.has(job.state)).length;

function elapsedMs(job: Generation, now: number): number | undefined {
  const start = job.submittedAt ?? job.createdAt;
  if (!start) return undefined;
  const end = job.finishedAt ? Date.parse(job.finishedAt) : ACTIVE_STATES.has(job.state) ? now : undefined;
  return end === undefined ? undefined : Math.max(0, end - Date.parse(start));
}

function MoneyLine({ job }: { job: Generation }) {
  const { d, f, locale } = useI18n();
  const usd = (value: number) => formatUsd(value, locale);
  const parts: string[] = [];
  if (job.costUsd !== undefined) parts.push(f(d.generations.settled, { amount: usd(job.costUsd) }));
  if (job.reservedUsd > 0)
    parts.push(
      f(
        job.state === "published" || job.state === "validated"
          ? d.generations.reservedUnsettled
          : d.generations.reserved,
        {
          amount: usd(job.reservedUsd),
        },
      ),
    );
  if (job.noCharge) parts.push(d.generations.noCharge);
  if (!job.priceKnown && job.costUsd === undefined) parts.push(d.generations.priceUnknown);
  else if (job.quotedUsd !== undefined && job.costUsd === undefined)
    parts.push(f(d.generations.quoted, { amount: usd(job.quotedUsd) }));
  return <span className="tabular-nums">{parts.join(" · ")}</span>;
}

function GenerationCard({ job, project }: { job: Generation; project: string }) {
  const { d, f, locale } = useI18n();
  const now = useNow();
  const elapsed = elapsedMs(job, now);
  const active = ACTIVE_STATES.has(job.state);
  const published = job.state === "published" || job.state === "validated";
  return (
    <li>
      <article
        aria-label={f(d.generations.job, { id: job.id })}
        data-generation={job.id}
        data-state={job.state}
        className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 text-sm"
      >
        <header className="flex flex-wrap items-center gap-2">
          <ToneBadge tone={JOB_TONE[job.state]}>{d.generations.state[job.state]}</ToneBadge>
          <span className="min-w-0 font-medium break-all">{job.endpoint ?? job.provider}</span>
          {job.resolution ? <span className="text-xs text-muted-foreground">{job.resolution}</span> : null}
          {elapsed !== undefined ? (
            <span className="ms-auto inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
              <Clock className="size-3.5" aria-hidden="true" />
              {active
                ? f(d.generations.elapsedRunning, { time: formatDuration(elapsed, d.units) })
                : formatDuration(elapsed, d.units)}
            </span>
          ) : null}
        </header>
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <MoneyLine job={job} />
          {job.submittedAt ? <span>{formatTime(job.submittedAt, locale, true)}</span> : null}
          {job.preparation ? <span>{f(d.generations.preparationOf, { id: job.preparation })}</span> : null}
          <code className="font-mono break-all">{job.id}</code>
        </p>
        {job.error ? (
          <div role="note" className="flex items-start gap-2 rounded-md border border-status-blocked/40 p-2">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-status-blocked" aria-hidden="true" />
            <p className="min-w-0 break-words">
              <span className="font-medium">{d.generations.error}: </span>
              {job.error}
            </p>
          </div>
        ) : null}
        {job.output ? (
          <section aria-label={d.generations.output} className="flex min-w-0 flex-col gap-1">
            <MediaSlot project={project} media={job.output} variant="inline" />
          </section>
        ) : published && job.outputPath ? (
          <p className="text-xs text-muted-foreground">{f(d.generations.outputMissing, { path: job.outputPath })}</p>
        ) : active && job.outputPath ? (
          <p className="text-xs text-muted-foreground">{f(d.generations.outputPending, { path: job.outputPath })}</p>
        ) : job.state === "failed" ? (
          <p className="text-xs text-muted-foreground">{d.generations.noOutput}</p>
        ) : null}
        {job.prompt ? (
          <Disclosure summary={d.generations.prompt} muted>
            <p className="mt-1 break-words whitespace-pre-wrap">{job.prompt}</p>
          </Disclosure>
        ) : null}
        {job.references?.length ? (
          <Disclosure summary={`${d.generations.references} (${job.references.length})`} muted>
            <ul className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2">
              {job.references.map((ref) => (
                <li key={ref.path}>
                  <MediaSlot project={project} media={ref} variant="thumb" />
                </li>
              ))}
            </ul>
          </Disclosure>
        ) : null}
      </article>
    </li>
  );
}

function PreparationCard({ preparation, project }: { preparation: ModelPreparationView; project: string }) {
  const { d, f, locale } = useI18n();
  return (
    <section
      aria-label={d.generations.preparation}
      data-preparation={preparation.id}
      className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 text-sm"
    >
      <header className="flex flex-wrap items-center gap-2">
        <Sparkles className="size-4 text-muted-foreground" aria-hidden="true" />
        <h3 className="font-medium">{d.generations.preparation}</h3>
        <code className="font-mono text-xs">{preparation.id}</code>
        <ToneBadge tone={preparation.approval ? "done" : "waiting"}>
          {preparation.approval ? d.generations.approved : d.generations.notApproved}
        </ToneBadge>
        {preparation.count > 1 ? (
          <span className="ms-auto text-xs text-muted-foreground">
            {plural(d.generations.preparationCount, preparation.count, locale)}
          </span>
        ) : null}
      </header>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {preparation.endpoint ? <span className="break-all">{preparation.endpoint}</span> : null}
        {preparation.mode ? <span>{preparation.mode}</span> : null}
        {preparation.resolution ? <span>{preparation.resolution}</span> : null}
        {preparation.createdAt ? <span>{formatTime(preparation.createdAt, locale, true)}</span> : null}
      </p>
      {preparation.approval?.userStatement ? (
        <p className="break-words">{f(d.generations.approvedWords, { words: preparation.approval.userStatement })}</p>
      ) : null}
      {preparation.rights ? (
        <p className="break-words text-muted-foreground">
          {preparation.rights.userStatement
            ? f(d.generations.rightsWords, {
                status: preparation.rights.status,
                words: preparation.rights.userStatement,
              })
            : f(d.generations.rights, { status: preparation.rights.status })}
        </p>
      ) : null}
      {preparation.prompt ? (
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <FileText className="size-3.5" aria-hidden="true" />
            {d.generations.prompt}
          </p>
          <p className="max-h-48 overflow-y-auto rounded-md bg-muted px-3 py-2 break-words whitespace-pre-wrap">
            {preparation.prompt}
          </p>
        </div>
      ) : null}
      {preparation.references.length || preparation.source ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">{d.generations.references}</p>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2">
            {preparation.source ? (
              <li key={preparation.source.path}>
                <MediaSlot project={project} media={preparation.source} variant="thumb" />
              </li>
            ) : null}
            {preparation.references.map((ref) => (
              <li key={ref.path}>
                <MediaSlot project={project} media={ref} variant="thumb" />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {preparation.board.length ? (
        <Disclosure summary={`${d.generations.board} (${preparation.board.length})`} muted>
          <ul className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2">
            {preparation.board.map((ref) => (
              <li key={ref.path}>
                <MediaSlot project={project} media={ref} variant="thumb" />
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </section>
  );
}

export function GenerationsPanel({ view }: PanelProps) {
  const { d } = useI18n();
  const generations = view.generations;
  const project = view.project.id;
  if (!generations || (!generations.jobs.length && !generations.preparation))
    return <EmptyState compact icon={<Sparkles />} title={d.generations.empty} description={d.generations.emptyHint} />;
  return (
    <div className="flex flex-col gap-4">
      {generations.templateOnly ? <p className="text-sm text-muted-foreground">{d.generations.templateOnly}</p> : null}
      {generations.jobs.length ? (
        <section aria-label={d.generations.jobs} className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{d.generations.jobs}</h3>
          <ul className="flex flex-col gap-3">
            {generations.jobs.map((job) => (
              <GenerationCard key={job.id} job={job} project={project} />
            ))}
          </ul>
        </section>
      ) : null}
      {generations.preparation ? <PreparationCard preparation={generations.preparation} project={project} /> : null}
    </div>
  );
}
