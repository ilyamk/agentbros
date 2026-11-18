/**
 * Campaign canvas panel (RFC 0004 WP15, US23): the campaign's members at a glance — production state, rendered
 * variants, pilot holds and the review draft — from `view.campaign`. The review itself (videos, choices, notes) is the
 * campaign view on the Timeline page (WP13e), linked here rather than duplicated.
 */
import { useI18n } from "@/i18n";
import { projectHref } from "@/lib/router";
import { shortHash } from "@/lib/format";
import { snapshotMode } from "@/lib/snapshot-mode";
import { ToneBadge } from "@/components/status";
import type { PanelProps } from "../registry";
import { Block, Facts } from "../film/shared";

export function CampaignSummaryPanel({ view }: PanelProps) {
  const { d, p } = useI18n();
  const t = d.routes.campaign;
  const campaign = view.campaign;
  if (!campaign) return <p className="text-sm text-muted-foreground">{d.routes.common.notYet}</p>;
  const outputs = campaign.members.reduce((sum, member) => sum + member.outputs, 0);
  const held = campaign.members.filter((member) => member.heldForPilot).length;
  return (
    <div className="flex flex-col gap-4">
      <Facts
        label={d.routes.titles.campaign}
        rows={[
          [t.campaign, campaign.campaignId],
          [t.plan, shortHash(campaign.planHash)],
          [t.revision, String(campaign.reviewRevision)],
          [t.member, p(t.members, campaign.members.length)],
          [t.outputs, String(outputs)],
          [t.held, String(held)],
        ]}
      />
      <Block title={p(t.members, campaign.members.length)}>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={t.member}>
          <table className="w-full min-w-[32rem] text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-1 pe-2 font-medium">{t.member}</th>
                <th className="py-1 pe-2 font-medium">{t.language}</th>
                <th className="py-1 pe-2 font-medium">{t.tasks}</th>
                <th className="py-1 pe-2 font-medium">{t.outputs}</th>
                <th className="py-1 pe-2 font-medium">{t.choice}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {campaign.members.map((member) => (
                <tr key={member.id} className="align-top">
                  <td className="py-1.5 pe-2">
                    <span className="font-mono text-xs">{member.id}</span>
                    {member.productId ? (
                      <span className="block text-xs text-muted-foreground">
                        {t.product}: {member.productId}
                      </span>
                    ) : null}
                    {member.heldForPilot ? <ToneBadge tone="paused">{t.held}</ToneBadge> : null}
                    {member.excluded ? <ToneBadge tone="skipped">{t.excluded}</ToneBadge> : null}
                  </td>
                  <td className="py-1.5 pe-2">{member.language}</td>
                  <td className="py-1.5 pe-2">
                    {member.tasks.map((task) => `${task.state} ${task.count}`).join(" · ")}
                  </td>
                  <td className="py-1.5 pe-2 tabular-nums">{member.outputs}</td>
                  <td className="py-1.5 pe-2">
                    {member.choice ?? <span className="text-muted-foreground">{t.noChoice}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Block>
      {snapshotMode() ? null : (
        <a
          href={projectHref(view.project.id, "timeline")}
          className="self-start text-sm font-medium underline underline-offset-4 hover:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {t.review}
        </a>
      )}
    </div>
  );
}
