/**
 * Timeline section: assets and entities (RU-AS01–AS05, the review:ui parity checklist), as review:ui did it
 * (client:488-500, 523):
 *
 * - One row per registered asset: `id · kind · origin · licence L · billing S` (S is `provenance.billing.status`).
 *   The hash, media facts and model, returned but never shown before, open under the row (parity plan, dead item 7).
 * - Search: case-insensitive substring over id, origin and licence, with the `n / N assets` count. Kind filter.
 * - Preview original through the review file route (the `state()` allowlist): video, audio or a lazy image.
 * - The entity board: every card's id, kind, name, latest and canonical revision.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select";
import { useI18n } from "@/i18n";
import type { ReviewAsset, ReviewState } from "../api";
import { TimelineSection, type TimelineSectionProps } from "../section";
import { Field, JsonBlock, ReviewMedia } from "./review-kit";
import { Disclosure } from "@/components/ui/disclosure";

export const ASSET_KINDS = ["image", "video", "audio"] as const;

/** `provenance.billing` is an object (`{status, …}`) in the service's projection; older shapes pass through. */
export function billingStatus(asset: Pick<ReviewAsset, "billing">): string {
  const billing = asset.billing as unknown;
  if (billing && typeof billing === "object" && "status" in billing) return String(billing.status);
  return String(billing);
}

export function filterAssets(assets: readonly ReviewAsset[], query: string, kind: string): ReviewAsset[] {
  const q = query.toLowerCase();
  return assets.filter(
    (asset) =>
      (!kind || asset.kind === kind) &&
      [asset.id, asset.origin, asset.rights?.licence].join(" ").toLowerCase().includes(q),
  );
}

export function AssetsSection({ state, api }: TimelineSectionProps) {
  const { d, f } = useI18n();
  const t = d.timeline.assets;
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const items = filterAssets(state.assets, query, kind);

  return (
    <TimelineSection id="assets" title={t.title} description={t.description}>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <Field htmlFor="asset-search" label={t.search}>
          <Input
            id="asset-search"
            type="search"
            value={query}
            placeholder={t.searchPlaceholder}
            onChange={(event) => setQuery(event.target.value)}
          />
        </Field>
        <Field htmlFor="asset-kind" label={t.kind}>
          <SelectField
            id="asset-kind"
            className="sm:w-44"
            value={kind}
            onValueChange={setKind}
            options={[
              { value: "", label: t.kinds.all },
              ...ASSET_KINDS.map((value) => ({ value, label: t.kinds[value] })),
            ]}
          />
        </Field>
      </div>
      <p id="asset-count" aria-live="polite" className="text-sm text-muted-foreground tabular-nums">
        {f(t.count, { shown: items.length, total: state.assets.length })}
      </p>
      <div id="assets" className="flex flex-col divide-y">
        {items.length === 0 && state.assets.length > 0 ? (
          <p className="text-sm text-muted-foreground">{t.noAssets}</p>
        ) : null}
        {items.map((asset) => (
          <AssetRow key={asset.id} asset={asset} api={api} />
        ))}
      </div>
      <Entities entities={state.entities} />
    </TimelineSection>
  );
}

function AssetRow({ asset, api }: { asset: ReviewAsset; api: TimelineSectionProps["api"] }) {
  const { d, f } = useI18n();
  const t = d.timeline.assets;
  const [open, setOpen] = useState(false);
  return (
    <article className="flex min-w-0 flex-col gap-2 py-2 text-sm" data-asset={asset.id}>
      <p className="wrap-anywhere">
        {f(t.row, {
          id: asset.id,
          kind: asset.kind,
          origin: String(asset.origin),
          licence: String(asset.rights?.licence),
          billing: billingStatus(asset),
        })}
      </p>
      <Disclosure muted size="xs" summary={t.details}>
        <JsonBlock value={{ hash: asset.hash, media: asset.media, model: asset.model, rights: asset.rights }} />
      </Disclosure>
      <div>
        <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? t.hidePreview : t.preview}
        </Button>
      </div>
      {open ? <ReviewMedia api={api} file={api.originalPath(asset)} label={asset.id} /> : null}
    </article>
  );
}

function Entities({ entities }: { entities: ReviewState["entities"] }) {
  const { d, f } = useI18n();
  const t = d.timeline.assets;
  return (
    <div>
      <h4 className="text-sm font-medium">{t.entities}</h4>
      <ul id="entities" className="flex flex-col gap-1 text-sm wrap-anywhere">
        {entities.length === 0 ? <li className="text-muted-foreground">{t.noEntities}</li> : null}
        {entities.map((entity) => (
          <li key={`${entity.kind}/${entity.id}`}>
            {f(t.entityRow, {
              kind: entity.kind,
              id: entity.id,
              name: entity.name ?? "",
              latest: entity.latestRevision,
              canonical: entity.canonicalRevision ?? t.noCanonical,
            })}
          </li>
        ))}
      </ul>
    </div>
  );
}
