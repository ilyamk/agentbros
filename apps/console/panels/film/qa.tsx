/**
 * QA and delivery (RFC 0004 §5.2, US13): renders per format, the QA findings with their frame evidence, and the strict
 * delivery check per format. Taste is not judged here: QA is technical (the qa-reviewer's role).
 */
import type { Finding, MediaRef, ProjectView } from "@contract";
import { useI18n } from "@/i18n";
import { useNow } from "@/lib/clock";
import { formatRelative } from "@/lib/format";
import { ToneBadge } from "@/components/status";
import type { PanelProps } from "../registry";
import { buildFindings, criticFindings, FindingList } from "./build";
import { Block, GroupDecisions, MediaGrid, StepFacts } from "./shared";
import { FrameFeedbackProvider } from "./feedback";

/** Findings that are neither the build's checks nor the critic's: QA, editorial and delivery. */
export function qaFindings(view: ProjectView): Finding[] {
  const elsewhere = new Set([...buildFindings(view), ...criticFindings(view)].map((finding) => finding.id));
  return view.qa.findings.filter((finding) => !elsewhere.has(finding.id));
}

/** Final renders: the latest render, then other video renders that are not scene renders. */
export function finalRenders(view: ProjectView): MediaRef[] {
  const out: MediaRef[] = [];
  const seen = new Set<string>();
  for (const media of [view.media.latestRender, ...(view.media.renders ?? [])]) {
    if (!media || media.kind !== "video" || seen.has(media.path)) continue;
    if (/(^|\/)scenes?\//.test(media.path)) continue;
    seen.add(media.path);
    out.push(media);
  }
  return out;
}

export function QaPanel({ view }: PanelProps) {
  const { d, f, locale } = useI18n();
  const now = useNow();
  const t = d.film.qa;
  const delivery = view.qa.delivery;
  const findings = qaFindings(view);
  const renders = finalRenders(view);
  return (
    <div className="flex flex-col gap-4">
      <StepFacts view={view} group="qa" />
      <Block title={t.delivery}>
        {delivery ? (
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <ToneBadge tone={delivery.ok ? "done" : "blocked"}>{delivery.ok ? t.passed : t.failed}</ToneBadge>
              <span className="text-muted-foreground">
                {f(t.checkedAt, { time: formatRelative(delivery.checkedAt, now, locale) })}
              </span>
            </div>
            {delivery.formats?.length ? (
              <ul aria-label={t.renders} className="flex flex-wrap gap-2">
                {delivery.formats.map((format) => (
                  <li key={format.format} className="flex items-center gap-1.5">
                    <span className="font-medium">{format.format}</span>
                    <ToneBadge tone={format.ok ? "done" : "blocked"}>{format.ok ? t.passed : t.failed}</ToneBadge>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t.notChecked}</p>
        )}
      </Block>
      {renders.length ? (
        <FrameFeedbackProvider project={view.project.id}>
          <Block title={t.renders}>
            <MediaGrid project={view.project.id} media={renders} variant="inline" label={t.renders} />
          </Block>
        </FrameFeedbackProvider>
      ) : null}
      <Block title={t.findings}>
        {findings.length ? (
          <FindingList view={view} findings={findings} />
        ) : (
          <p className="text-sm text-muted-foreground">{t.noFindings}</p>
        )}
      </Block>
      <GroupDecisions view={view} group="qa" />
    </div>
  );
}
