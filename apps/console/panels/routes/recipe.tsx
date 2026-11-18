/**
 * Recipe route panel (RFC 0004 WP15): a `video:recipe` draft — the recipe, topic and formats, each beat's purpose,
 * headline, script and visual (placeholders flagged), the draft's open findings and its animatic page. Material from
 * `view.recipe`; render, QA and delivery follow the timeline steps on the step rail.
 */
import { useI18n } from "@/i18n";
import { formatDuration } from "@/lib/format";
import { ToneBadge } from "@/components/status";
import { MediaSlot } from "@/media";
import type { PanelProps } from "../registry";
import { Block, Docs, Facts, TextList } from "../film/shared";

const FPS = 30;

export function RecipePanel({ view }: PanelProps) {
  const { d, f } = useI18n();
  const t = d.routes.recipe;
  const recipe = view.recipe;
  if (!recipe) return <p className="text-sm text-muted-foreground">{d.routes.common.notYet}</p>;
  return (
    <div className="flex flex-col gap-4">
      <Facts
        label={d.routes.titles.recipe}
        rows={[
          [t.recipe, recipe.recipeId],
          [t.topic, recipe.topic],
          [t.formats, recipe.formats.join(", ")],
          ...(recipe.durationInFrames
            ? ([[t.duration, formatDuration((recipe.durationInFrames / FPS) * 1000, d.units)]] as [string, string][])
            : []),
          [
            t.readiness,
            <ToneBadge key="ready" tone={recipe.productionReady ? "done" : "waiting"}>
              {recipe.productionReady ? t.ready : t.draft}
            </ToneBadge>,
          ],
        ]}
      />
      <Block title={t.beats}>
        <ol className="grid gap-3 md:grid-cols-2">
          {recipe.beats.map((beat, index) => (
            <li key={beat.id} className="flex min-w-0 flex-col gap-2 rounded-lg border p-3" data-beat={beat.id}>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-xs text-muted-foreground tabular-nums">{index + 1}</span>
                <span className="font-mono text-xs">{beat.id}</span>
                {beat.durationInFrames ? (
                  <span className="text-xs text-muted-foreground">{f(t.frames, { n: beat.durationInFrames })}</span>
                ) : null}
                {beat.transitionToNext ? (
                  <span className="text-xs text-muted-foreground">
                    · {t.transition}: {beat.transitionToNext}
                  </span>
                ) : null}
              </div>
              {beat.purpose ? <p className="text-sm text-muted-foreground">{beat.purpose}</p> : null}
              {beat.headline ? <p className="font-medium break-words">{beat.headline}</p> : null}
              <p className="text-sm break-words whitespace-pre-wrap">
                {beat.text ?? <span className="text-muted-foreground">{t.noScript}</span>}
              </p>
              {beat.visual ? <MediaSlot project={view.project.id} media={beat.visual} variant="thumb" /> : null}
              {beat.placeholder ? <ToneBadge tone="waiting">{t.placeholder}</ToneBadge> : null}
            </li>
          ))}
        </ol>
      </Block>
      <TextList title={t.findings} items={recipe.findings} />
      {recipe.nextAction ? (
        <Block title={t.next}>
          <p className="text-sm break-words">{recipe.nextAction}</p>
        </Block>
      ) : null}
      <Docs project={view.project.id} docs={recipe.animatic ? [recipe.animatic] : undefined} />
    </div>
  );
}
