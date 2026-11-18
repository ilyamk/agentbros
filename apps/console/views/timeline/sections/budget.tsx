/**
 * Timeline section: budget and liability (RU-B01–B03, the review:ui parity checklist), as review:ui did it
 * (client:579-580): one line per durable job, `id · state · reserved $X · actual $Y`, or `unknown (no receipt)` when no
 * receipt exists; the liability notice; the empty-ledger notice; the summary as JSON (`uninitialized` stays so). Amounts
 * are the service's numbers as written, never rounded. Read-only: no paid, provider, retry or credential controls.
 */
import { useI18n } from "@/i18n";
import type { ReviewBudgetJob } from "../api";
import { TimelineSection, type TimelineSectionProps } from "../section";
import { JsonBlock } from "./review-kit";
import { Disclosure } from "@/components/ui/disclosure";

/** The job line's actual amount: the receipt's `$amount`, else unknown (never zero). */
export function actualText(job: Pick<ReviewBudgetJob, "actualUsd">, t: { actualUnknown: string; actualKnown: string }) {
  return job.actualUsd === null ? t.actualUnknown : t.actualKnown.replace("{amount}", String(job.actualUsd));
}

export function BudgetSection({ state }: TimelineSectionProps) {
  const { d, f } = useI18n();
  const t = d.timeline.budget;
  const { jobs, ...summary } = state.budget;
  return (
    <TimelineSection id="budget" title={t.title} description={t.description}>
      <p id="liability" className="text-sm font-medium">
        {t.liability}
      </p>
      <div>
        <h4 className="text-sm font-medium">{t.jobs}</h4>
        <ul id="costs" className="flex flex-col gap-1 text-sm wrap-anywhere tabular-nums">
          {jobs.map((job) => (
            <li key={job.id} data-job={job.id}>
              {f(t.job, {
                id: job.id,
                state: job.state,
                reserved: String(job.reservedUsd),
                actual: actualText(job, t),
              })}
            </li>
          ))}
          {jobs.length === 0 ? <li>{t.noJobs}</li> : null}
        </ul>
      </div>
      {summary.status === "uninitialized" ? <p className="text-sm text-muted-foreground">{t.uninitialized}</p> : null}
      <Disclosure muted summary={t.summary}>
        <JsonBlock id="budget" value={state.budget} />
      </Disclosure>
      <p className="text-xs text-muted-foreground">{t.noControls}</p>
    </TimelineSection>
  );
}
