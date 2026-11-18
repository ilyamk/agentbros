/**
 * Footage panel: the recut plan (A15). The proposed cuts on the source's timeline by kind (silence, filler, false
 * start, leading and trailing silence), the duration before and after, the cut list with the words around each cut,
 * the source with cut markers over its waveform, and the edit hash with its approval state. The approval itself is
 * given on the pinned decision card (`recut:plan --approve`, console only).
 */
import type { FootageMaterial, MediaRef } from "@contract";
import { CircleCheck, CircleDashed, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n } from "@/i18n";
import { shortHash } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AudioPlayer } from "@/media/audio-player";
import { MediaSlot } from "@/media";
import type { PanelProps } from "../registry";
import { Block, Facts } from "../film/shared";
import { FootageStepHeader, NothingYet } from "./shared";
import { material, secClock } from "./steps";

type Plan = NonNullable<FootageMaterial["plan"]>;
type Cut = Plan["cuts"][number];

/** Colour per cut kind (always paired with the kind's name in text). */
export const CUT_COLOURS: Record<Cut["kind"], string> = {
  pause: "bg-chart-1",
  filler: "bg-chart-2",
  retake: "bg-chart-3",
  head: "bg-chart-5",
  tail: "bg-chart-5",
};

/** Source length: the plan's own, else the recording's, else the last cut's end. */
export function planLength(plan: Plan, sourceSec?: number): number {
  return (
    plan.sourceSec ??
    sourceSec ??
    Math.max(0, ...plan.cuts.map((cut) => cut.endSec), ...plan.keep.map((span) => span.endSec))
  );
}

/** Seconds removed and kept, from the plan's own numbers or from its cuts. */
export function planTiming(plan: Plan, length: number): { before: number; after: number; removed: number } {
  const removed = plan.removedSec ?? plan.cuts.reduce((sum, cut) => sum + Math.max(0, cut.endSec - cut.startSec), 0);
  return { before: length, after: plan.outputSec ?? Math.max(0, length - removed), removed };
}

/** The cut's words: `~~removed~~` from the plan is shown struck through. */
function CutWords({ text }: { text: string }) {
  const parts = text.split(/(~~[^~]+~~)/g);
  return (
    <span className="break-words">
      {parts.map((part, index) =>
        part.startsWith("~~") && part.endsWith("~~") ? (
          <del key={index} className="text-status-blocked decoration-2">
            {part.slice(2, -2)}
          </del>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </span>
  );
}

/** The source as one bar: kept spans muted, each cut in its kind's colour; then the result's length beside it. */
function CutTimeline({ plan, length }: { plan: Plan; length: number }) {
  const { d, f, p } = useI18n();
  const timing = planTiming(plan, length);
  const pct = (sec: number) => `${Math.min(100, Math.max(0, (sec / length) * 100))}%`;
  const width = (start: number, end: number) => `${Math.max(0.3, ((end - start) / length) * 100)}%`;
  const label = f(d.footage.plan.timing, {
    before: secClock(timing.before),
    after: secClock(timing.after),
    removed: secClock(timing.removed),
  });
  const kinds = [...new Set(plan.cuts.map((cut) => cut.kind))];
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <div className="grid grid-cols-[4.5rem_1fr] items-center gap-x-2 gap-y-1.5 text-xs">
        <span className="text-muted-foreground">{d.footage.plan.before}</span>
        <div
          role="img"
          aria-label={`${d.footage.plan.timeline}: ${p(d.footage.plan.cuts, plan.cuts.length)}, ${label}`}
          data-cut-timeline=""
          className="relative h-6 overflow-hidden rounded-md bg-muted"
        >
          {plan.keep.map((span, index) => (
            <span
              key={`k${index}`}
              className="absolute inset-y-1 bg-muted-foreground/25"
              style={{ left: pct(span.startSec), width: width(span.startSec, span.endSec) }}
            />
          ))}
          {plan.cuts.map((cut) => (
            <span
              key={cut.id}
              data-cut={cut.id}
              title={f(d.footage.plan.cutAt, {
                id: cut.id,
                kind: d.footage.plan.kinds[cut.kind],
                start: secClock(cut.startSec),
                end: secClock(cut.endSec),
              })}
              className={cn("absolute inset-y-0", CUT_COLOURS[cut.kind])}
              style={{ left: pct(cut.startSec), width: width(cut.startSec, cut.endSec) }}
            />
          ))}
        </div>
        <span className="text-muted-foreground">{d.footage.plan.after}</span>
        <div className="h-6 overflow-hidden rounded-md bg-muted">
          <div
            data-after-bar=""
            className="h-full rounded-md bg-muted-foreground/40"
            style={{ width: pct(timing.after) }}
          />
        </div>
      </div>
      <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-medium">{label}</span>
        {kinds.map((kind) => (
          <span key={kind} className="inline-flex items-center gap-1">
            <span aria-hidden="true" className={cn("size-2.5 rounded-sm", CUT_COLOURS[kind])} />
            {d.footage.plan.kinds[kind]} · {plan.cuts.filter((cut) => cut.kind === kind).length}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

function CutList({ cuts }: { cuts: readonly Cut[] }) {
  const { d } = useI18n();
  if (!cuts.length) return <p className="text-sm text-muted-foreground">{d.footage.plan.noCuts}</p>;
  return (
    <ol
      tabIndex={0}
      aria-label={d.footage.plan.cutList}
      className="flex max-h-96 flex-col gap-1.5 overflow-y-auto rounded-md pe-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {cuts.map((cut) => (
        <li key={cut.id} data-cut-row={cut.id} className="flex min-w-0 flex-col gap-0.5 rounded-md border px-2 py-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-semibold">{cut.id}</span>
            <span className="inline-flex items-center gap-1 text-xs">
              <span aria-hidden="true" className={cn("size-2.5 rounded-sm", CUT_COLOURS[cut.kind])} />
              {d.footage.plan.kinds[cut.kind]}
            </span>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {secClock(cut.startSec)}–{secClock(cut.endSec)} (−{secClock(cut.endSec - cut.startSec)})
            </span>
          </div>
          {cut.text ? <CutWords text={cut.text} /> : null}
          {cut.reason ? <span className="text-xs text-muted-foreground break-words">{cut.reason}</span> : null}
        </li>
      ))}
    </ol>
  );
}

function Approval({ plan }: { plan: Plan }) {
  const { d } = useI18n();
  let state: ReactNode;
  if (plan.editHash && plan.approvedEditHash === plan.editHash)
    state = (
      <span className="inline-flex items-center gap-1 [&>svg]:text-status-done">
        <CircleCheck aria-hidden="true" className="size-4" />
        {d.footage.plan.approved}
      </span>
    );
  else if (plan.approvedEditHash)
    state = (
      <span className="inline-flex items-center gap-1 [&>svg]:text-status-stale">
        <TriangleAlert aria-hidden="true" className="size-4" />
        {d.footage.plan.approvedStale}
      </span>
    );
  else
    state = (
      <span className="inline-flex items-center gap-1 [&>svg]:text-status-waiting">
        <CircleDashed aria-hidden="true" className="size-4" />
        {d.footage.plan.notApproved}
      </span>
    );
  return (
    <Facts
      rows={[
        [d.footage.plan.recutProject, <code className="font-mono text-xs">{plan.recutProject}</code>],
        [
          d.footage.plan.editHash,
          plan.editHash ? (
            <code className="font-mono text-xs" title={plan.editHash}>
              {shortHash(plan.editHash)}
            </code>
          ) : (
            "—"
          ),
        ],
        [d.footage.plan.approved, state],
      ]}
    />
  );
}

export function PlanPanel({ view }: PanelProps) {
  const { d, p } = useI18n();
  const { plan, source } = material(view);
  if (!plan)
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <FootageStepHeader view={view} group="plan" />
        <NothingYet />
      </div>
    );
  const length = planLength(plan, source?.durationSec);
  const audio: MediaRef | undefined = source?.media ? { ...source.media, kind: "audio" } : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <FootageStepHeader view={view} group="plan" />
      <Approval plan={plan} />
      {length > 0 ? <CutTimeline plan={plan} length={length} /> : null}
      {audio ? (
        <Block title={d.footage.plan.listen}>
          <AudioPlayer
            project={view.project.id}
            media={audio}
            cues={plan.cuts.map((cut) => ({ t: cut.startSec, label: cut.id, strong: cut.kind === "retake" }))}
          />
          <p className="text-xs text-muted-foreground">{d.footage.plan.listenHint}</p>
        </Block>
      ) : null}
      <Block title={p(d.footage.plan.cuts, plan.cuts.length)}>
        <CutList cuts={plan.cuts} />
        {plan.protectedCount ? (
          <p className="text-xs text-muted-foreground">{p(d.footage.plan.protected, plan.protectedCount)}</p>
        ) : null}
      </Block>
      {plan.doc ? (
        <Block title={d.footage.plan.fullPlan}>
          <MediaSlot project={view.project.id} media={plan.doc} variant="thumb" />
        </Block>
      ) : null}
      {plan.editHash && plan.approvedEditHash !== plan.editHash ? (
        <p className="text-xs text-muted-foreground">{d.footage.plan.approveHint}</p>
      ) : null}
    </div>
  );
}
