/**
 * Timeline section: prepared visualisations (RU-V01, the review:ui parity checklist). review:ui showed the
 * `vizProjectAdvice` payload as raw JSON or "No prepared visualisations mounted." (client:524). The console keeps the
 * raw payload and lists each scene and check command; `factualTruth` (e.g. `unverified`) always stays visible.
 */
import { CircleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/i18n";
import { TimelineSection, type TimelineSectionProps } from "../section";
import { JsonBlock } from "./review-kit";
import { Disclosure } from "@/components/ui/disclosure";

interface VizAdvice {
  scenes?: { sceneId?: string; revision?: string; recipe?: string; formats?: string[] }[];
  commands?: string[];
  factualTruth?: string;
}

export function VisualisationsSection({ state }: TimelineSectionProps) {
  const { d, f } = useI18n();
  const t = d.timeline.visualisations;
  const advice = state.visualisations as VizAdvice | undefined;
  return (
    <TimelineSection id="visualisations" title={t.title} description={t.description}>
      {advice ? (
        <div className="flex min-w-0 flex-col gap-2 text-sm">
          <p>
            <Badge id="viz-factual-truth" variant="outline" className="gap-1">
              <CircleAlert aria-hidden="true" />
              {f(t.factualTruth, { value: String(advice.factualTruth) })}
            </Badge>
          </p>
          <ul className="flex flex-col gap-1 wrap-anywhere">
            {(advice.scenes ?? []).map((scene) => (
              <li key={`${scene.sceneId}/${scene.revision}`}>
                {f(t.scene, {
                  scene: String(scene.sceneId),
                  recipe: String(scene.recipe),
                  formats: (scene.formats ?? []).join(", "),
                  revision: String(scene.revision).slice(0, 12),
                })}
              </li>
            ))}
          </ul>
          {advice.commands?.length ? (
            <div>
              <h4 className="font-medium">{t.commands}</h4>
              <ul className="flex flex-col gap-1">
                {advice.commands.map((command) => (
                  <li key={command}>
                    <code className="font-mono text-xs wrap-anywhere">{command}</code>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <Disclosure muted summary={t.raw}>
            <JsonBlock id="visualisations" value={advice} />
          </Disclosure>
        </div>
      ) : (
        <p id="visualisations" className="text-sm text-muted-foreground">
          {t.none}
        </p>
      )}
    </TimelineSection>
  );
}
