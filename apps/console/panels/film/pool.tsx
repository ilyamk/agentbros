/**
 * Creative pools (RFC 0004 §5.2, US9): ideas and idea review, script variants and script review. The pool is shown
 * blind: candidates under their anonymous pool ids (I1, S2), in id order, with no author, team, variant letter or
 * writing order. Each carries its text and its per-axis rubric scores; the pairwise results, the top three and the
 * arguments against them are the creative director's and code's ranking, labelled as the agent's view. `chosen` comes
 * only after the user's step closed. A choice goes through the generic decision card (D10).
 */
import type { FilmPool, ProjectView } from "@contract";
import { Layers } from "lucide-react";
import { useI18n, type Dictionary } from "@/i18n";
import { isKnownOption } from "@/lib/phrases";
import { EmptyState } from "@/components/empty-state";
import { ToneBadge } from "@/components/status";
import type { PanelProps } from "../registry";
import { AgentView, Block, Docs, GroupDecisions, MediaGrid, StepFacts, decisionMedia } from "./shared";
import { groupDecisions, type FilmGroup } from "./steps";

/** Candidate labels: the non-generic options of the group's choice decisions, sorted so order carries no ranking. */
export function poolCandidates(view: ProjectView, group: FilmGroup): { id: string; label: string }[] {
  const out = new Map<string, string>();
  for (const decision of groupDecisions(view, group))
    if (decision.kind === "choice")
      for (const option of decision.options ?? []) if (!isKnownOption(option.id)) out.set(option.id, option.label);
  return [...out]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }));
}

/** The pool of the group from the view's film material. */
export function poolOf(view: ProjectView, group: FilmGroup): FilmPool | undefined {
  return group === "ideas" ? view.film?.ideas : group === "script" ? view.film?.scripts : undefined;
}

/** Pool size for the summary: the pool's items, else candidates, else the decision's documents. */
export function poolSize(view: ProjectView, group: FilmGroup): number {
  return poolOf(view, group)?.items.length || poolCandidates(view, group).length || decisionMedia(view, group).length;
}

const axisName = (d: Dictionary, axis: string) => (d.film.verdict.axisNames as Record<string, string>)[axis] ?? axis;

function PoolItems({ pool }: { pool: FilmPool }) {
  const { d, f } = useI18n();
  const t = d.film.pool;
  return (
    <ul aria-label={d.film.pool.candidates} className="grid gap-2 md:grid-cols-2">
      {pool.items.map((item) => (
        <li
          key={item.id}
          data-candidate={item.id}
          aria-label={f(t.item, { id: item.id })}
          className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md border px-1.5 py-0.5 font-mono text-xs font-semibold">{item.id}</span>
            {item.title ? <span className="min-w-0 flex-1 text-sm font-medium break-words">{item.title}</span> : null}
            {pool.chosen === item.id ? <ToneBadge tone="done">{t.chosen}</ToneBadge> : null}
          </div>
          {item.text ? <p className="text-sm break-words whitespace-pre-wrap">{item.text}</p> : null}
          {item.scores ? (
            <>
              <dl className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-1 text-xs" data-scores="">
                {pool.axes
                  .filter((axis) => item.scores?.[axis] !== undefined)
                  .map((axis) => (
                    <div
                      key={axis}
                      aria-label={f(t.scoreOf, { axis: axisName(d, axis), score: item.scores![axis]! })}
                      className="flex justify-between gap-2 rounded bg-muted/60 px-1.5 py-0.5"
                    >
                      <dt className="truncate text-muted-foreground">{axisName(d, axis)}</dt>
                      <dd className="font-medium tabular-nums">{item.scores![axis]}</dd>
                    </div>
                  ))}
              </dl>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {item.mean !== undefined ? (
                  <span className="font-medium tabular-nums">{f(t.mean, { mean: item.mean })}</span>
                ) : null}
                {item.passes !== undefined ? (
                  <ToneBadge tone={item.passes ? "done" : "waiting"}>{item.passes ? t.passes : t.below}</ToneBadge>
                ) : null}
                {item.overruns ? <ToneBadge tone="waiting">{t.overruns}</ToneBadge> : null}
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{t.notScored}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

function PoolJudgement({ pool }: { pool: FilmPool }) {
  const { d, f } = useI18n();
  const t = d.film.pool;
  if (!pool.top.length && !pool.pairs.length) return null;
  const titleOf = (id: string) => pool.items.find((item) => item.id === id)?.title;
  return (
    <AgentView>
      {pool.verdict ? <p className="font-medium">{t.verdict[pool.verdict]}</p> : null}
      {pool.top.length ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">{t.top}</p>
          <ol className="list-decimal ps-5" data-top="">
            {pool.top.map((id) => (
              <li key={id} className="break-words">
                <span className="font-mono font-semibold">{id}</span>
                {titleOf(id) ? ` · ${titleOf(id)}` : ""}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {pool.against.length ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">{t.against}</p>
          <ul className="list-disc ps-5">
            {pool.against.map((entry) => (
              <li key={entry.id} className="break-words">
                <span className="font-mono font-semibold">{entry.id}</span>: {entry.argument}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {pool.pairs.length ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">{t.pairwise}</p>
          <ul className="flex flex-wrap gap-1.5 text-xs" data-pairs="">
            {pool.pairs.map((pair) => (
              <li key={`${pair.a}|${pair.b}`} className="rounded bg-card px-1.5 py-0.5 font-mono">
                {pair.agreed && pair.winner
                  ? f(t.pairWon, { winner: pair.winner, loser: pair.winner === pair.a ? pair.b : pair.a })
                  : f(t.pairSplit, { a: pair.a, b: pair.b })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </AgentView>
  );
}

function PoolPanel({ view, group }: PanelProps & { group: FilmGroup }) {
  const { d, f } = useI18n();
  const pool = poolOf(view, group);
  const candidates = poolCandidates(view, group);
  const media = [...decisionMedia(view, group)].sort((a, b) =>
    (a.label ?? a.path).localeCompare(b.label ?? b.path, "en", { numeric: true }),
  );
  const fallback = !pool && (candidates.length > 0 || media.length > 0);
  return (
    <div className="flex flex-col gap-4">
      <StepFacts view={view} group={group} />
      {pool ? (
        <Block title={`${d.film.pool.candidates} · ${f(d.film.pool.round, { round: pool.round })}`}>
          <p className="text-xs text-muted-foreground">{d.film.pool.blind}</p>
          <PoolItems pool={pool} />
          <PoolJudgement pool={pool} />
          <MediaGrid project={view.project.id} media={media} label={d.film.common.files} />
          <Docs project={view.project.id} docs={pool.docs} />
        </Block>
      ) : fallback ? (
        <Block title={d.film.pool.candidates}>
          <p className="text-xs text-muted-foreground">{d.film.pool.blind}</p>
          {candidates.length ? (
            <ul aria-label={d.film.pool.candidates} className="flex flex-wrap gap-2">
              {candidates.map((candidate) => (
                <li
                  key={candidate.id}
                  data-candidate={candidate.id}
                  className="rounded-md border bg-card px-2.5 py-1 text-sm font-medium"
                >
                  {candidate.label}
                </li>
              ))}
            </ul>
          ) : null}
          <MediaGrid project={view.project.id} media={media} label={d.film.common.files} />
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{d.film.pool.scores}: </span>
            {d.film.pool.scoresMissing}
          </p>
        </Block>
      ) : groupDecisions(view, group).length ? null : (
        <EmptyState compact icon={<Layers />} title={d.film.pool.empty} description={d.film.pool.emptyHint} />
      )}
      <GroupDecisions view={view} group={group} />
    </div>
  );
}

export const IdeasPanel = ({ view }: PanelProps) => <PoolPanel view={view} group="ideas" />;
export const ScriptPanel = ({ view }: PanelProps) => <PoolPanel view={view} group="script" />;
