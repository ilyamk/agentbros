/**
 * Replica route panels (RFC 0004 WP15, US23): the user's rights answer as written, the shot-for-shot spec with its
 * swaps and rounds and the spec check, and the comparison with the reference at the replica tolerances. Material
 * from `view.replica`; the steps themselves (status, owner, decisions) are on the film panel of their group.
 */
import type { ReplicaMaterial } from "@contract";
import { useI18n } from "@/i18n";
import { formatTime } from "@/lib/format";
import type { Tone } from "@/lib/status";
import { ToneBadge } from "@/components/status";
import type { PanelProps } from "../registry";
import { Block, Docs, Facts, TextList } from "../film/shared";

const RIGHTS_TONE: Record<NonNullable<ReplicaMaterial["rights"]>["status"], Tone> = {
  owned: "done",
  licensed: "done",
  "study-only": "waiting",
};

function NotYet() {
  const { d } = useI18n();
  return <p className="text-sm text-muted-foreground">{d.routes.common.notYet}</p>;
}

export function ReplicaRightsPanel({ view }: PanelProps) {
  const { d, f, locale } = useI18n();
  const t = d.routes.replica;
  const rights = view.replica?.rights;
  return (
    <div className="flex flex-col gap-3">
      {rights ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">{t.statusLabel}</span>
            <ToneBadge tone={RIGHTS_TONE[rights.status]}>{t.status[rights.status]}</ToneBadge>
            <span className="text-xs text-muted-foreground">
              {f(t.askedAt, {
                time: Number.isFinite(Date.parse(rights.askedAt))
                  ? formatTime(rights.askedAt, locale, true)
                  : rights.askedAt,
              })}
            </span>
          </div>
          {rights.status === "study-only" ? (
            <p role="note" className="rounded-md border-s-2 border-status-waiting bg-muted/60 px-3 py-2 text-sm">
              {t.studyOnly}
            </p>
          ) : null}
          <Block title={t.userStatement}>
            <blockquote className="border-s-2 ps-3 text-sm break-words whitespace-pre-wrap" data-user-words="">
              {rights.userStatement}
            </blockquote>
          </Block>
        </>
      ) : (
        <NotYet />
      )}
    </div>
  );
}

function CheckLine({ check }: { check: NonNullable<ReplicaMaterial["check"]> }) {
  const { d } = useI18n();
  const t = d.routes.replica;
  const tone: Tone = !check.ok ? "blocked" : check.passed ? "done" : "waiting";
  const label = !check.ok ? t.checkError : check.passed ? t.checkPassed : t.checkFailed;
  return (
    <Block title={t.check}>
      <div>
        <ToneBadge tone={tone}>{label}</ToneBadge>
      </div>
      {check.message ? <p className="text-sm break-words">{check.message}</p> : null}
      <TextList title={t.remains} items={check.issues} />
    </Block>
  );
}

export function ReplicaSpecPanel({ view }: PanelProps) {
  const { d, f, p } = useI18n();
  const t = d.routes.replica;
  const spec = view.replica?.spec;
  const check = view.replica?.check;
  return (
    <div className="flex flex-col gap-4">
      {spec ? (
        <>
          <Facts
            label={d.routes.titles.replicaSpec}
            rows={[
              [t.reference, spec.reference],
              [t.fps, String(spec.fps)],
              [t.format, spec.format],
              [t.shots, p(t.shotsCount, spec.shots.length)],
            ]}
          />
          <Block title={t.shots}>
            <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={t.shots}>
              <table className="w-full min-w-[36rem] text-left text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1 pe-2 font-medium">{t.shot}</th>
                    <th className="py-1 pe-2 font-medium">{t.referenceShot}</th>
                    <th className="py-1 pe-2 font-medium">{t.frames}</th>
                    <th className="py-1 pe-2 font-medium">{t.content}</th>
                    <th className="py-1 pe-2 font-medium">{t.camera}</th>
                    <th className="py-1 pe-2 font-medium">{t.confidence}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {spec.shots.map((shot) => (
                    <tr key={shot.id} className="align-top">
                      <td className="py-1.5 pe-2 font-mono text-xs">{shot.id}</td>
                      <td className="py-1.5 pe-2 font-mono text-xs">{shot.referenceShot}</td>
                      <td className="py-1.5 pe-2 tabular-nums">
                        {shot.startFrame}–{shot.startFrame + shot.durationFrames}
                      </td>
                      <td className="py-1.5 pe-2 break-words">
                        {shot.content}
                        {shot.blocks.length ? (
                          <span className="block text-xs text-muted-foreground">
                            {t.blocks}: {shot.blocks.join(", ")}
                          </span>
                        ) : null}
                        {shot.unreachable ? (
                          <span className="block text-xs text-status-waiting">
                            {t.unreachable}: {shot.unreachable}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-1.5 pe-2">{[shot.transitionIn, shot.camera].filter(Boolean).join(" · ")}</td>
                      <td className="py-1.5 pe-2">{shot.confidence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Block>
          {spec.swaps.length ? (
            <Block title={t.swaps}>
              <ul className="flex flex-col gap-2 text-sm">
                {spec.swaps.map((swap, index) => (
                  <li key={index} className="rounded-md bg-muted/60 px-3 py-2 break-words">
                    <p className="font-medium">{f(t.swap, { what: swap.what, from: swap.from, to: swap.to })}</p>
                    <p className="text-muted-foreground">{swap.why}</p>
                    {swap.shots?.length ? (
                      <p className="text-xs text-muted-foreground">
                        {f(t.swapShots, { shots: swap.shots.join(", ") })}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Block>
          ) : null}
          {spec.rounds.length ? (
            <Block title={t.rounds}>
              <ul className="flex flex-col gap-2">
                {spec.rounds.map((round) => (
                  <li key={round.round} className="rounded-md border px-3 py-2">
                    <p className="text-sm font-medium">{f(t.round, { n: round.round })}</p>
                    <div className="grid gap-2 md:grid-cols-2">
                      <TextList title={t.fixed} items={round.fixed} />
                      <TextList title={t.remains} items={round.remains} />
                    </div>
                  </li>
                ))}
              </ul>
            </Block>
          ) : null}
          <Docs project={view.project.id} docs={spec.doc ? [spec.doc] : undefined} />
        </>
      ) : (
        <NotYet />
      )}
      {check ? <CheckLine check={check} /> : null}
    </div>
  );
}

export function ReplicaComparePanel({ view }: PanelProps) {
  const { d } = useI18n();
  const t = d.routes.replica;
  const compare = view.replica?.compare;
  return (
    <div className="flex flex-col gap-3">
      {compare ? (
        <Block title={t.compare}>
          {!compare.ok ? (
            <div className="flex flex-col gap-1">
              <ToneBadge tone="blocked">{t.compareError}</ToneBadge>
              {compare.message ? <p className="text-sm break-words">{compare.message}</p> : null}
            </div>
          ) : (
            <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={t.compare}>
              <table className="w-full min-w-[28rem] text-left text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1 pe-2 font-medium">{t.measure}</th>
                    <th className="py-1 pe-2 font-medium">{t.held}</th>
                    <th className="py-1 pe-2 font-medium">{t.failed}</th>
                    <th className="py-1 pe-2 font-medium">{t.notMeasured}</th>
                    <th className="py-1 pe-2 font-medium">{t.exempt}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {compare.measures.map((row) => (
                    <tr key={row.measure} data-failed={row.failed > 0 ? "" : undefined}>
                      <td className="py-1.5 pe-2">
                        <ToneBadge tone={row.failed > 0 ? "blocked" : "done"}>{row.measure}</ToneBadge>
                      </td>
                      <td className="py-1.5 pe-2 tabular-nums">{row.held}</td>
                      <td className="py-1.5 pe-2 tabular-nums">{row.failed}</td>
                      <td className="py-1.5 pe-2 tabular-nums">{row.notMeasured}</td>
                      <td className="py-1.5 pe-2 tabular-nums">{row.exempt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Block>
      ) : (
        <NotYet />
      )}
    </div>
  );
}
