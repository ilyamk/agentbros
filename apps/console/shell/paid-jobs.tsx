/**
 * Stop's paid-job list (RFC 0004 D12, §8, A9): every in-flight paid job with its reservation; the user cancels one at
 * a time, each after its own confirmation with prefilled words, through `POST …/jobs/:id/cancel` (`job:cancel`). A job
 * the provider cannot cancel now shows why and has no cancel button; the server's outcome is shown as it is
 * (`requested` is not `cancelled`), never faked.
 */
import { useId, useState } from "react";
import type { JobCancelResponse, JobSummary, ProjectView } from "@contract";
import { Ban, Coins } from "lucide-react";
import { useI18n } from "@/i18n";
import { useConsoleStore } from "@/store/context";
import { asFailure } from "@/api/errors";
import { formatUsd } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";

/** Job states a stop lists (src/lib/jobs/cancel.ts IN_FLIGHT_STATES). */
export const IN_FLIGHT = new Set<JobSummary["state"]>([
  "planned",
  "reserved",
  "submitting",
  "queued",
  "running",
  "unknown",
]);

export const inFlightJobs = (view: Pick<ProjectView, "money">): JobSummary[] =>
  view.money.jobs.filter((job) => IN_FLIGHT.has(job.state));

/**
 * The jobs to list: the stop's reply first (it may be newer than the view), each shown with the view's current copy
 * when the view has it, so a cancelled job stays listed with its new state; then in-flight jobs the reply lacked.
 */
export function listedJobs(view: Pick<ProjectView, "money">, fromStop: readonly JobSummary[] = []): JobSummary[] {
  const current = new Map(view.money.jobs.map((job) => [job.id, job]));
  const seen = new Set<string>();
  const out: JobSummary[] = [];
  for (const job of [...fromStop, ...inFlightJobs(view)]) {
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    out.push(current.get(job.id) ?? job);
  }
  return out;
}

export interface StopListing {
  jobs?: readonly JobSummary[];
  /** `metadata.runningJobsError` of console:control: the list could not be read. */
  error?: string;
  /** `metadata.runningJobsOmitted`: ids too long to list. */
  omitted?: number;
}

export function PaidJobs({ view, listing = {} }: { view: ProjectView; listing?: StopListing }) {
  const { d, f, p } = useI18n();
  const t = d.control.jobs;
  const jobs = listedJobs(view, listing.jobs);
  return (
    <section aria-label={t.title} className="flex min-w-0 flex-col gap-2" data-paid-jobs>
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Coins className="size-4 text-muted-foreground" aria-hidden="true" />
        {t.title}
      </h3>
      <p className="text-xs text-muted-foreground">{t.intro}</p>
      {listing.error ? (
        <p role="alert" className="text-sm text-status-blocked">
          {f(t.listError, { message: listing.error })}
        </p>
      ) : null}
      {jobs.length ? (
        <ul className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto">
          {jobs.map((job) => (
            <JobRow key={job.id} project={view.project.id} job={job} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t.none}</p>
      )}
      {listing.omitted ? <p className="text-xs text-muted-foreground">{p(t.omitted, listing.omitted)}</p> : null}
    </section>
  );
}

function JobRow({ project, job }: { project: string; job: JobSummary }) {
  const { d, f, locale } = useI18n();
  const t = d.control.jobs;
  const store = useConsoleStore();
  const id = useId();
  const [confirming, setConfirming] = useState(false);
  const [words, setWords] = useState(() => f(t.phrase, { job: job.id }));
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ tone: "ok" | "error"; text: string }>();
  const amount = job.reservedUsd !== undefined ? formatUsd(job.reservedUsd, locale) : t.unknownPrice;
  const open = IN_FLIGHT.has(job.state);

  const cancel = async () => {
    if (!words.trim()) {
      setOutcome({ tone: "error", text: d.decision.emptyWords });
      return;
    }
    setBusy(true);
    setOutcome(undefined);
    try {
      const reply = await store.cancelJob(project, job.id, { answer: words });
      const message = reply.message ?? reply.result?.message ?? "";
      const kind: JobCancelResponse["outcome"] = reply.outcome;
      const text = kind ? f(t.outcomes[kind], { message }) : f(t.failed, { message });
      setOutcome({ tone: reply.ok && (kind === "cancelled" || kind === "requested") ? "ok" : "error", text });
      setConfirming(false);
    } catch (failure) {
      setOutcome({ tone: "error", text: f(t.failed, { message: asFailure(failure).message }) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex min-w-0 flex-col gap-1.5 rounded-md border p-2" data-job={job.id} data-job-state={job.state}>
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="min-w-0 font-mono text-xs break-all">{job.id}</span>
        <span className="text-sm font-medium tabular-nums">{f(t.reserved, { amount })}</span>
      </div>
      <p className="min-w-0 text-xs break-words text-muted-foreground">
        {[job.provider, job.endpoint, job.step, f(t.state, { state: job.state })].filter(Boolean).join(" · ")}
      </p>
      {!open ? null : job.cancellable === true ? (
        confirming ? (
          <div
            role="group"
            aria-label={f(t.confirmTitle, { job: job.id })}
            className="flex flex-col gap-2 border-t pt-2"
            data-job-confirm
          >
            <p className="text-sm font-medium">{f(t.confirmTitle, { job: job.id })}</p>
            <p className="text-xs text-muted-foreground">{f(t.confirmBody, { amount })}</p>
            <label htmlFor={`${id}-words`} className="text-xs font-medium">
              {d.decision.yourWords}
            </label>
            <Textarea
              id={`${id}-words`}
              rows={2}
              value={words}
              disabled={busy}
              onChange={(event) => setWords(event.target.value)}
            />
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setConfirming(false)} disabled={busy}>
                {t.keep}
              </Button>
              <Button size="sm" variant="destructive" onClick={() => void cancel()} disabled={busy}>
                {busy ? d.decision.sending : t.confirm}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            aria-label={f(t.cancelLabel, { job: job.id })}
            onClick={() => setConfirming(true)}
          >
            <Ban aria-hidden="true" />
            {t.cancel}
          </Button>
        )
      ) : (
        <p className="text-xs text-muted-foreground" data-job-not-cancellable>
          {job.cancellable === false
            ? f(t.notCancellable, { reason: job.cancelReason ?? job.provider })
            : t.unknownSupport}
        </p>
      )}
      {outcome ? (
        <p role="status" className={outcome.tone === "ok" ? "text-sm" : "text-sm text-status-blocked"}>
          {outcome.text}
        </p>
      ) : null}
    </li>
  );
}
