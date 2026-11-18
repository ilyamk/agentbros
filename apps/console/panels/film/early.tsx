/**
 * Panels of the steps before any media exists (RFC 0004 §5.2): brief and strategy, discovery and truth, the beat sheet.
 * Their material comes from `view.film` (WP10b): the brief and strategy excerpts and fields, the category scan's
 * clichés and white space with the product's claims by status, and the motion plan's shots with the cue sheet over the
 * music's waveform. Agent text is shown as written; a section the view does not carry says so.
 */
import type { FilmDiscovery } from "@contract";
import { useI18n } from "@/i18n";
import { formatUsd } from "@/lib/format";
import { ToneBadge } from "@/components/status";
import { MediaSlot, type CueMarker } from "@/media";
import type { Tone } from "@/lib/status";
import type { PanelProps } from "../registry";
import { Block, Docs, Excerpt, Facts, GroupDecisions, NotInView, StepFacts, TextList } from "./shared";

export function BriefPanel({ view }: PanelProps) {
  const { d, locale } = useI18n();
  const t = d.film.brief;
  const { project, autonomy } = view;
  const brief = view.film?.brief;
  const strategy = brief?.strategy;
  const none = <span className="text-muted-foreground">{t.noValue}</span>;
  const mode = autonomy.mode === "autonomous" ? d.autonomy.autonomous : d.autonomy.interactive;
  return (
    <div className="flex flex-col gap-4">
      <Facts
        label={d.film.titles.brief}
        rows={[
          [t.title, project.title ?? project.id],
          [t.filmType, project.filmType ?? none],
          [t.playbook, project.playbook ?? none],
          [t.formats, project.formats?.length ? project.formats.join(", ") : none],
          [t.autonomy, autonomy.finalReviewOnly ? `${mode} · ${d.autonomy.finalReviewOnly}` : mode],
          [t.ceiling, autonomy.ceilingUsd !== undefined ? formatUsd(autonomy.ceilingUsd, locale) : none],
        ]}
      />
      {strategy ? (
        <Block title={t.strategy}>
          <p className="text-base font-medium break-words" data-proposition="">
            {strategy.proposition}
          </p>
          <Facts
            label={t.strategy}
            rows={[
              ...(strategy.audience ? ([[t.audience, strategy.audience.who]] as [string, string][]) : []),
              ...(strategy.audience ? ([[t.moment, strategy.audience.moment]] as [string, string][]) : []),
              ...(strategy.hook ? ([[t.hook, strategy.hook.mechanic]] as [string, string][]) : []),
              ...(strategy.hook ? ([[t.firstTwoSeconds, strategy.hook.firstTwoSeconds]] as [string, string][]) : []),
              ...(strategy.platform ? ([[t.platform, strategy.platform]] as [string, string][]) : []),
              ...(strategy.tone.length ? ([[t.tone, strategy.tone.join(", ")]] as [string, string][]) : []),
              ...(strategy.language ? ([[t.language, strategy.language]] as [string, string][]) : []),
            ]}
          />
          <div className="grid gap-3 md:grid-cols-3">
            <TextList title={t.mandatories} items={strategy.mandatories} />
            <TextList title={t.forbidden} items={strategy.forbidden} />
            <TextList title={t.successCriteria} items={strategy.successCriteria} />
          </div>
        </Block>
      ) : null}
      <Excerpt title={t.brief} text={brief?.excerpt} />
      <Excerpt title={t.strategyPage} text={brief?.strategyExcerpt} />
      <Docs
        project={project.id}
        docs={[brief?.doc, brief?.strategyDoc].filter((doc): doc is NonNullable<typeof doc> => doc !== undefined)}
      />
      <StepFacts view={view} group="brief" />
      <GroupDecisions view={view} group="brief" />
    </div>
  );
}

export const CLAIM_TONE: Record<FilmDiscovery["claims"][number]["status"], Tone> = {
  working: "done",
  "in-development": "current",
  horizon: "upcoming",
  unverified: "waiting",
};

export function DiscoveryPanel({ view }: PanelProps) {
  const { d, f } = useI18n();
  const t = d.film.discovery;
  const discovery = view.film?.discovery;
  const statuses = Object.keys(CLAIM_TONE) as (keyof typeof CLAIM_TONE)[];
  return (
    <div className="flex flex-col gap-4">
      <StepFacts view={view} group="discovery" />
      {discovery ? (
        <>
          {discovery.category ? (
            <p className="text-sm">
              <span className="text-muted-foreground">{t.category}: </span>
              <span className="font-medium">{discovery.category}</span>
            </p>
          ) : null}
          <div className="grid gap-4 lg:grid-cols-2">
            {discovery.cliches.length ? (
              <Block title={t.cliches}>
                <ul className="flex flex-col gap-1.5 text-sm" data-cliches="">
                  {discovery.cliches.map((item, index) => (
                    <li key={index} className="rounded-md bg-muted/60 px-2 py-1.5 break-words">
                      <span className="font-medium">{item.cliche}</span>
                      {item.description ? <span className="block">{item.description}</span> : null}
                      {item.seenIn ? (
                        <span className="block text-xs text-muted-foreground">
                          {f(t.seenIn, { where: item.seenIn })}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Block>
            ) : null}
            <div className="flex flex-col gap-4">
              <TextList title={t.whiteSpace} items={discovery.whiteSpace} />
              <TextList title={t.learn} items={discovery.learn} />
            </div>
          </div>
          {discovery.claims.length ? (
            <Block title={t.claims}>
              <div className="grid gap-3 md:grid-cols-2" data-claims="">
                {statuses.map((status) => {
                  const claims = discovery.claims.filter((claim) => claim.status === status);
                  if (!claims.length) return null;
                  return (
                    <section key={status} aria-label={t.status[status]} className="flex flex-col gap-1.5">
                      <ToneBadge tone={CLAIM_TONE[status]}>{t.status[status]}</ToneBadge>
                      <ul className="list-disc ps-5 text-sm">
                        {claims.map((claim, index) => (
                          <li key={index} className="break-words">
                            {claim.text}
                          </li>
                        ))}
                      </ul>
                    </section>
                  );
                })}
              </div>
              {discovery.publicRule ? (
                <p className="text-sm">
                  <span className="text-muted-foreground">{t.publicRule}: </span>
                  {discovery.publicRule}
                </p>
              ) : null}
            </Block>
          ) : null}
          <Docs project={view.project.id} docs={discovery.docs} />
        </>
      ) : (
        <NotInView />
      )}
      <GroupDecisions view={view} group="discovery" />
    </div>
  );
}

/** Cue markers for the waveform: the music's clock; hits, drops and downbeats are emphasised. */
export function cueMarkers(view: PanelProps["view"]): CueMarker[] {
  const beats = view.film?.beats;
  if (!beats) return [];
  return beats.cues.map((cue) => ({
    t: cue.trackSec,
    label: `${cue.id} · ${cue.kind}`,
    strong: cue.kind === "hit" || cue.kind === "drop" || cue.snap === "downbeat",
  }));
}

const seconds = (frames: number, fps: number) => (Math.round((frames / fps) * 10) / 10).toString();

export function BeatsPanel({ view }: PanelProps) {
  const { d, f } = useI18n();
  const t = d.film.beats;
  const composition = view.media.composition;
  const beats = view.film?.beats;
  return (
    <div className="flex flex-col gap-4">
      <StepFacts view={view} group="beats" />
      {composition ? (
        <Facts
          label={t.composition}
          rows={[
            [t.composition, composition.id],
            [t.length, f(t.frames, { frames: composition.durationInFrames, fps: composition.fps })],
            [t.sizeLabel, f(t.size, { width: composition.width, height: composition.height })],
          ]}
        />
      ) : null}
      {beats ? (
        <>
          {beats.track ? (
            <Block title={t.track}>
              <MediaSlot project={view.project.id} media={beats.track} variant="inline" cues={cueMarkers(view)} />
            </Block>
          ) : null}
          {beats.shots.length ? (
            <Block title={t.shots}>
              <div
                tabIndex={0}
                role="region"
                aria-label={t.shots}
                className="overflow-x-auto rounded-lg border focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <table className="w-full min-w-[32rem] text-sm" data-shots="">
                  <caption className="sr-only">{t.shots}</caption>
                  <thead className="bg-muted/50 text-xs text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-2 py-1.5 text-start font-medium">
                        {t.shot}
                      </th>
                      <th scope="col" className="px-2 py-1.5 text-start font-medium">
                        {t.time}
                      </th>
                      <th scope="col" className="px-2 py-1.5 text-start font-medium">
                        {t.intent}
                      </th>
                      <th scope="col" className="px-2 py-1.5 text-start font-medium">
                        {t.transition}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {beats.shots.map((shot) => (
                      <tr key={shot.id} data-shot={shot.id}>
                        <th scope="row" className="px-2 py-1.5 text-start font-medium break-all">
                          {shot.id}
                          {shot.subject ? (
                            <span className="block text-xs font-normal text-muted-foreground">{shot.subject}</span>
                          ) : null}
                        </th>
                        <td className="px-2 py-1.5 whitespace-nowrap tabular-nums">
                          {f(t.seconds, {
                            from: seconds(shot.startFrame, beats.fps),
                            to: seconds(shot.startFrame + shot.durationFrames, beats.fps),
                          })}
                        </td>
                        <td className="px-2 py-1.5 break-words">{shot.intent}</td>
                        <td className="px-2 py-1.5 break-words">{shot.transitionToNext ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Block>
          ) : null}
          {beats.cues.length ? (
            <Block title={t.cues}>
              <ul className="flex flex-wrap gap-1.5 text-xs" data-cues="">
                {beats.cues.map((cue) => (
                  <li key={cue.id} className="rounded-md bg-muted/60 px-2 py-1 tabular-nums">
                    <span className="font-medium">{cue.id}</span>{" "}
                    {f(t.cue, { kind: cue.kind, sec: cue.sec, frame: cue.frame })}
                    {cue.shotId ? <span className="text-muted-foreground"> · {cue.shotId}</span> : null}
                  </li>
                ))}
              </ul>
            </Block>
          ) : null}
        </>
      ) : (
        <NotInView />
      )}
      <GroupDecisions view={view} group="beats" />
    </div>
  );
}
