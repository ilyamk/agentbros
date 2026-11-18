/**
 * Animatic and build, critic and fixer (RFC 0004 §5.2, §5.3, US6): the latest animatic and scene renders, frame strips,
 * the checks per scene (motion:check findings with their frame), and the critic's rounds and scores. Rendered files
 * only (D21): the media slot plays them.
 */
import type { FilmCriticRound, Finding, MediaRef, ProjectView, StepRow } from "@contract";
import { Clapperboard } from "lucide-react";
import { useI18n } from "@/i18n";
import { EmptyState } from "@/components/empty-state";
import { ToneBadge } from "@/components/status";
import type { Tone } from "@/lib/status";
import type { PanelProps } from "../registry";
import { Compare, MediaSlot } from "@/media";
import { FrameFeedbackProvider } from "./feedback";
import { isSoundClaim } from "@/lib/sound-claims";
import { AgentView, Block, GroupDecisions, MediaGrid, NotInView, StepFacts } from "./shared";
import { FILM_GROUPS } from "./steps";

const inGroup = (ids: readonly string[], step: string | undefined) => step !== undefined && ids.includes(step);

/** Findings of the build: its steps' findings and every motion:check finding. */
export function buildFindings(view: ProjectView): Finding[] {
  return view.qa.findings.filter(
    (finding) => inGroup(FILM_GROUPS.build, finding.step) || finding.source === "motion:check",
  );
}

/** Findings of the critic and measure steps. */
export function criticFindings(view: ProjectView): Finding[] {
  return view.qa.findings.filter(
    (finding) => inGroup(FILM_GROUPS.critic, finding.step) && finding.source !== "motion:check",
  );
}

export function buildMedia(view: ProjectView): { renders: MediaRef[]; strips: MediaRef[] } {
  const seen = new Set<string>();
  const key = (media: MediaRef) => `${media.root ?? "project"}:${media.path}`;
  for (const media of [view.media.animatic, view.media.latestRender]) if (media) seen.add(key(media));
  const renders: MediaRef[] = [];
  const strips: MediaRef[] = [];
  for (const media of view.media.renders ?? []) {
    if (seen.has(key(media))) continue;
    seen.add(key(media));
    (media.kind === "strip" ? strips : renders).push(media);
  }
  return { renders, strips };
}

export const SEVERITY_TONE: Record<Finding["severity"], Tone> = {
  info: "upcoming",
  warning: "waiting",
  error: "blocked",
};

export function FindingList({ view, findings }: { view: ProjectView; findings: Finding[] }) {
  const { d, f } = useI18n();
  return (
    <ul className="flex flex-col gap-2">
      {findings.map((finding) => (
        <li key={finding.id} data-finding={finding.id} className="flex flex-col gap-2 rounded-lg border bg-card p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <ToneBadge tone={SEVERITY_TONE[finding.severity]}>{d.film.qa.severity[finding.severity]}</ToneBadge>
            <span className="font-mono text-xs text-muted-foreground">{finding.source}</span>
            {finding.format ? <span className="text-xs text-muted-foreground">{finding.format}</span> : null}
            {finding.frame !== undefined ? (
              <span className="text-xs text-muted-foreground">{f(d.film.build.frame, { frame: finding.frame })}</span>
            ) : null}
          </div>
          <p className="text-sm break-words">{finding.message}</p>
          {finding.evidence?.length ? (
            <MediaGrid project={view.project.id} media={finding.evidence} label={d.film.qa.evidence} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** The film critic's rounds in one line: "round 1 · 21 → round 2 · 28" (§5.3). */
function CriticTrail({ view }: { view: ProjectView }) {
  const { d, f } = useI18n();
  const rounds = materialRounds(view).filter((round) => round.step === "critic");
  if (!rounds.length) return null;
  return (
    <p className="text-sm" data-critic-trail="">
      {rounds
        .map((round) =>
          round.total !== undefined
            ? f(d.canvas.criticScore, { round: round.round, score: round.total })
            : f(d.canvas.critic, { round: round.round }),
        )
        .join(" → ")}
    </p>
  );
}

export function BuildPanel({ view }: PanelProps) {
  const { d } = useI18n();
  const { animatic, latestRender } = view.media;
  const { renders, strips } = buildMedia(view);
  const findings = buildFindings(view);
  const lead = [animatic, latestRender].filter((media): media is MediaRef => media !== undefined);
  return (
    <FrameFeedbackProvider project={view.project.id}>
      <div className="flex flex-col gap-4">
        <StepFacts view={view} group="build" />
        {lead.length || renders.length || strips.length ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {animatic ? (
              <Block title={d.film.build.animatic}>
                <MediaGrid project={view.project.id} media={[animatic]} variant="inline" />
              </Block>
            ) : null}
            {latestRender ? (
              <Block title={d.film.build.latest}>
                <MediaGrid project={view.project.id} media={[latestRender]} variant="inline" />
              </Block>
            ) : null}
            {renders.length ? (
              <Block title={d.film.build.renders}>
                <MediaGrid project={view.project.id} media={renders} label={d.film.build.renders} />
              </Block>
            ) : null}
            {strips.length ? (
              <Block title={d.film.build.strips}>
                <MediaGrid project={view.project.id} media={strips} variant="inline" label={d.film.build.strips} />
              </Block>
            ) : null}
          </div>
        ) : (
          <EmptyState compact icon={<Clapperboard />} title={d.film.build.empty} description={d.film.build.emptyHint} />
        )}
        <CriticTrail view={view} />
        <Block title={d.film.build.checks}>
          {findings.length ? (
            <FindingList view={view} findings={findings} />
          ) : (
            <p className="text-sm text-muted-foreground">{d.film.build.noChecks}</p>
          )}
        </Block>
        <GroupDecisions view={view} group="build" />
      </div>
    </FrameFeedbackProvider>
  );
}

/** Steps with a critic loop, in chain order: the build (critic rounds during the build) and the critic group. */
export function criticRounds(view: ProjectView): StepRow[] {
  const ids: readonly string[] = [...FILM_GROUPS.build, ...FILM_GROUPS.critic];
  return view.steps.filter((step) => ids.includes(step.id) && step.critic !== undefined);
}

/** The film material's critic rounds, oldest first per step. */
export function materialRounds(view: ProjectView): FilmCriticRound[] {
  return view.film?.critic?.rounds ?? [];
}

const VERDICT_TONE: Record<FilmCriticRound["verdict"], Tone> = {
  "approve-for-human": "done",
  revise: "waiting",
  "rethink-idea": "blocked",
};

const mediaKey = (media: MediaRef) => `${media.root ?? "project"}:${media.path}`;

/**
 * Before and after of two rounds of one step: their phone sheets, else their first frames taken at the same time. Only
 * like with like, and never one file with itself (a critic of live styleframes reads the same file every round).
 */
export function beforeAfter(before: FilmCriticRound, after: FilmCriticRound): [MediaRef, MediaRef] | undefined {
  let pair: [MediaRef, MediaRef] | undefined;
  if (before.sheet && after.sheet) pair = [before.sheet, after.sheet];
  else if (!before.sheet && !after.sheet && before.frames[0] && after.frames[0]) {
    const [a, b] = [before.frames[0], after.frames[0]];
    if (a.timeSec === b.timeSec) pair = [a.media, b.media];
  }
  return pair && mediaKey(pair[0]) !== mediaKey(pair[1]) ? pair : undefined;
}

function CriticRoundCard({
  view,
  round,
  before,
}: {
  view: ProjectView;
  round: FilmCriticRound;
  before?: FilmCriticRound;
}) {
  const { d, f } = useI18n();
  const t = d.film.critic;
  const stepName = (t.steps as Record<string, string>)[round.step] ?? round.step;
  const axis = (name: string) => (t.axisNames as Record<string, string>)[name] ?? name;
  const fixes = round.fixes.filter((fix) => !isSoundClaim(fix));
  const pair = before ? beforeAfter(before, round) : undefined;
  return (
    <li
      data-critic-round={`${round.step}-${round.round}`}
      className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-3"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">{f(t.roundOf, { step: stepName, round: round.round })}</span>
        <ToneBadge tone={VERDICT_TONE[round.verdict]}>{t.verdicts[round.verdict]}</ToneBadge>
        {round.total !== undefined ? <span className="tabular-nums">{f(t.total, { total: round.total })}</span> : null}
      </div>
      <dl className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-1 text-xs">
        {Object.entries(round.scores).map(([name, score]) => (
          <div key={name} className="flex justify-between gap-2 rounded bg-muted/60 px-1.5 py-0.5">
            <dt className="truncate text-muted-foreground">{axis(name)}</dt>
            <dd className="font-medium tabular-nums">{score}</dd>
          </div>
        ))}
      </dl>
      <AgentView>
        <p className="text-xs text-muted-foreground">{t.fixes}</p>
        {fixes.length ? (
          <ol className="list-decimal ps-5" data-fixes="">
            {fixes.map((fix, index) => (
              <li key={index} className="break-words">
                {fix}
              </li>
            ))}
          </ol>
        ) : (
          <p>{t.noFixes}</p>
        )}
      </AgentView>
      {pair && before ? (
        <Block title={f(t.beforeAfter, { before: before.round, after: round.round })}>
          <Compare project={view.project.id} a={pair[0]} b={pair[1]} />
        </Block>
      ) : null}
      {round.frames.length ? (
        <Block title={t.frames}>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-2">
            {round.frames.map((frame) => (
              <li key={frame.media.path} className="flex min-w-0 flex-col gap-1">
                <MediaSlot project={view.project.id} media={frame.media} variant="thumb" />
                {frame.note && !isSoundClaim(frame.note) ? (
                  <span className="text-xs break-words text-muted-foreground">{frame.note}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </Block>
      ) : null}
    </li>
  );
}

/** Rounds with the previous round of the same step beside each (for before/after). */
function withBefore(rounds: FilmCriticRound[]) {
  return rounds.map((round, index) => ({
    round,
    before: [...rounds.slice(0, index)].reverse().find((other) => other.step === round.step),
  }));
}

export function CriticPanel({ view }: PanelProps) {
  const { d, f } = useI18n();
  const rounds = criticRounds(view);
  const material = materialRounds(view);
  const findings = criticFindings(view);
  return (
    <FrameFeedbackProvider project={view.project.id}>
      <div className="flex flex-col gap-4">
        <StepFacts view={view} group="critic" />
        {material.length ? (
          <Block title={d.film.critic.rounds}>
            <ul className="flex flex-col gap-3">
              {withBefore(material)
                .reverse()
                .map(({ round, before }) => (
                  <CriticRoundCard key={`${round.step}-${round.round}`} view={view} round={round} before={before} />
                ))}
            </ul>
          </Block>
        ) : rounds.length ? (
          <Block title={d.film.build.critic}>
            <ul className="flex flex-col gap-1 text-sm">
              {rounds.map(({ id, title, critic }) =>
                critic ? (
                  <li key={id} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{title}</span>
                    <span>{f(d.film.critic.round, { round: critic.round })}</span>
                    {critic.score !== undefined ? (
                      <span className="tabular-nums">{f(d.film.critic.score, { score: critic.score })}</span>
                    ) : null}
                    {critic.action ? (
                      <span className="text-muted-foreground">{d.film.critic.actions[critic.action]}</span>
                    ) : null}
                  </li>
                ) : null,
              )}
            </ul>
          </Block>
        ) : null}
        {findings.length ? (
          <Block title={d.film.critic.findings}>
            <FindingList view={view} findings={findings} />
          </Block>
        ) : null}
        {material.length ? null : rounds.length || findings.length ? (
          <p className="text-xs text-muted-foreground">{d.film.critic.fixesMissing}</p>
        ) : (
          <NotInView />
        )}
        <GroupDecisions view={view} group="critic" />
      </div>
    </FrameFeedbackProvider>
  );
}
