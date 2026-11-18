/** Building blocks the film panels share: the group's steps, its pending decisions, media grids and fact lists. */
import type { ReactNode } from "react";
import type { Decision, MediaRef, ProjectView, StepRow } from "@contract";
import { ArrowUp, FileQuestion } from "lucide-react";
import { useI18n } from "@/i18n";
import { formatDuration } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { StepStatusBadge, ToneBadge } from "@/components/status";
import { MediaSlot } from "@/media";
import { cn } from "@/lib/utils";
import { groupDecisions, groupSteps, type FilmGroup } from "./steps";
import { Disclosure } from "@/components/ui/disclosure";

/** The group's steps: status, owner, duration and the chain's reasons. */
export function StepFacts({ view, group }: { view: ProjectView; group: FilmGroup }) {
  return <StepRows view={view} steps={groupSteps(view, group)} />;
}

/** Steps of any route: status, owner, duration and the reasons (film and footage panels). */
export function StepRows({ view, steps }: { view: ProjectView; steps: readonly StepRow[] }) {
  const { d, f } = useI18n();
  if (!steps.length) return null;
  return (
    <ul aria-label={d.film.common.steps} className="flex flex-col gap-1.5 text-sm">
      {steps.map((step) => (
        <li key={step.id} className="flex flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <StepStatusBadge status={step.status} current={step.id === view.current?.step} />
            <span className="font-medium">{step.title}</span>
            {step.owner ? (
              <span className="text-muted-foreground">{f(d.canvas.owner, { owner: step.owner })}</span>
            ) : null}
            {step.durationMs !== undefined ? (
              <span className="text-muted-foreground">
                {f(d.canvas.duration, { time: formatDuration(step.durationMs, d.units) })}
              </span>
            ) : null}
            {step.critic ? (
              <span className="text-muted-foreground">
                {step.critic.score !== undefined
                  ? f(d.canvas.criticScore, { round: step.critic.round, score: step.critic.score })
                  : f(d.canvas.critic, { round: step.critic.round })}
              </span>
            ) : null}
          </div>
          {step.reasons.length ? (
            <ul className="list-disc ps-5 text-muted-foreground">
              {step.reasons.map((reason, index) => (
                <li key={index} className="break-words">
                  {reason}
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Moves focus to the pinned decision card of the canvas's "Waiting for you" (WP4's DecisionCard). */
export function focusDecision(decisionId: string): boolean {
  const card = document.querySelector<HTMLElement>(`[data-card="decision"][data-decision="${decisionId}"]`);
  if (!card) return false;
  card.scrollIntoView?.({ block: "center" });
  card.focus();
  return true;
}

/**
 * The group's pending decisions. The decision itself is made on the generic decision card pinned under "Waiting for
 * you" (one card per decision, so a decision is never answered from two places): the panel names it and moves focus
 * to it. The current step's panel sits right under that card, so the material and the card stay side by side.
 */
export function GroupDecisions({ view, group }: { view: ProjectView; group: FilmGroup }) {
  return <DecisionRefs decisions={groupDecisions(view, group)} goTo={group !== "human"} />;
}

/** Pending decisions of any route, each pointing to its pinned card (film and footage panels). */
export function DecisionRefs({ decisions, goTo = true }: { decisions: readonly Decision[]; goTo?: boolean }) {
  const { d } = useI18n();
  if (!decisions.length) return null;
  return (
    <section aria-label={d.film.common.yourDecision} className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{d.film.common.yourDecision}</h3>
      <ul className="flex flex-col gap-2">
        {decisions.map((decision) => (
          <li
            key={decision.id}
            data-decision-ref={decision.id}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-status-waiting/50 bg-card px-3 py-2 text-sm"
          >
            <ToneBadge tone="waiting">{d.decision.kinds[decision.kind]}</ToneBadge>
            <span className="min-w-0 flex-1 font-medium break-words">{decision.title}</span>
            {decision.kind === "verdict" || !goTo ? null : (
              <Button size="sm" variant="outline" onClick={() => focusDecision(decision.id)}>
                <ArrowUp aria-hidden="true" />
                {d.film.common.goToDecision}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{d.film.common.pinnedHint}</p>
    </section>
  );
}

/** Media of a project in a responsive grid. */
export function MediaGrid({
  project,
  media,
  variant = "thumb",
  label,
  className,
}: {
  project: string;
  media: readonly MediaRef[];
  variant?: "inline" | "thumb";
  label?: string;
  className?: string;
}) {
  if (!media.length) return null;
  return (
    <ul
      aria-label={label}
      className={cn(
        "grid gap-2",
        variant === "thumb"
          ? "grid-cols-[repeat(auto-fill,minmax(9rem,1fr))]"
          : "grid-cols-[repeat(auto-fill,minmax(14rem,1fr))]",
        className,
      )}
    >
      {media.map((item) => (
        <li key={`${item.root ?? "project"}:${item.path}`} className="min-w-0">
          <MediaSlot project={project} media={item} variant={variant} composition={item.composition} />
        </li>
      ))}
    </ul>
  );
}

/** A heading and its content; nothing when the content is empty. */
export function Block({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-2", className)}>
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** Label/value pairs. */
export function Facts({ rows, label }: { rows: [string, ReactNode][]; label?: string }) {
  return (
    <dl aria-label={label} className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2 text-sm">
      {rows.map(([name, value]) => (
        <div key={name} className="min-w-0 rounded-md bg-muted/60 px-2 py-1.5">
          <dt className="text-xs text-muted-foreground">{name}</dt>
          <dd className="font-medium break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The step's own material is not in the read model yet (RFC 0004 §6.2): say so instead of guessing. */
export function NotInView() {
  const { d } = useI18n();
  return (
    <EmptyState
      compact
      icon={<FileQuestion />}
      title={d.film.common.notInView}
      description={d.film.common.notInViewHint}
    />
  );
}

/** Media of the group's pending decisions (the material the user is asked about). */
export function decisionMedia(view: ProjectView, group: FilmGroup, kinds?: readonly MediaRef["kind"][]): MediaRef[] {
  const seen = new Set<string>();
  const out: MediaRef[] = [];
  for (const decision of groupDecisions(view, group))
    for (const media of decision.media ?? []) {
      const key = `${media.root ?? "project"}:${media.path}`;
      if (seen.has(key) || (kinds && !kinds.includes(media.kind))) continue;
      seen.add(key);
      out.push(media);
    }
  return out;
}

/** A document excerpt as written (never translated), folded under a summary line. */
export function Excerpt({ title, text }: { title: string; text: string | undefined }) {
  const { d } = useI18n();
  if (!text) return null;
  return (
    <Disclosure
      variant="card"
      summary={
        <>
          {title} <span className="font-normal text-muted-foreground">· {d.film.common.readMore}</span>
        </>
      }
    >
      <p className="max-h-80 overflow-y-auto text-sm break-words whitespace-pre-wrap">{text}</p>
    </Disclosure>
  );
}

/** A plain list of agent-written lines under a heading; nothing when empty. */
export function TextList({ title, items }: { title: string; items: readonly string[] | undefined }) {
  if (!items?.length) return null;
  return (
    <Block title={title}>
      <ul className="list-disc ps-5 text-sm">
        {items.map((item, index) => (
          <li key={index} className="break-words">
            {item}
          </li>
        ))}
      </ul>
    </Block>
  );
}

/** The step's documents (the files behind the material), opened full screen from their thumbnails. */
export function Docs({ project, docs }: { project: string; docs: readonly MediaRef[] | undefined }) {
  const { d } = useI18n();
  if (!docs?.length) return null;
  return (
    <Block title={d.film.common.documents}>
      <MediaGrid project={project} media={docs} label={d.film.common.documents} />
    </Block>
  );
}

/** A label that marks agent-written judgement as the agent's view (§5.4), never the user's decision. */
export function AgentView({ children }: { children: ReactNode }) {
  const { d } = useI18n();
  return (
    <aside
      aria-label={d.film.common.agentViewShort}
      className="flex flex-col gap-1 rounded-lg border-s-2 border-status-current/60 bg-muted/50 px-3 py-2 text-sm"
    >
      <p className="text-xs font-medium text-muted-foreground">{d.film.common.agentViewShort}</p>
      {children}
    </aside>
  );
}
