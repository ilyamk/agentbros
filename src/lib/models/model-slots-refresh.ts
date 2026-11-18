import type { FalCatalogEntry } from "../../types/fal-catalog";
import { ModelSlotsFileSchema, type ModelSlotCandidate, type ModelSlotsFile } from "../../types/model-slots";
import { planningChoicePrice } from "./model-choice-price";
import { slotModelPrice, type SlotCatalogs, type SlotPrices } from "./model-slots";

/** Keep the vendor, family and entire variant path; only the first version may change. */
export function endpointVersion(endpoint: string): { family: string; version: number[] } | null {
  const slash = endpoint.indexOf("/");
  if (slash < 0) return null;
  const model = endpoint.slice(slash + 1);
  const match = /(^|[-/.])(v?)(\d+(?:[.-]\d+)*)(?=$|[-/])/.exec(model);
  if (!match) return null;
  const start = slash + 1 + match.index + match[1]!.length + match[2]!.length;
  return {
    family: endpoint.slice(0, start) + "{version}" + endpoint.slice(start + match[3]!.length),
    version: match[3]!.split(/[.-]/).map(Number),
  };
}
export function isEndpointSuccessor(predecessor: string, endpoint: string): boolean {
  const a = endpointVersion(predecessor),
    b = endpointVersion(endpoint);
  if (!a || !b || a.family !== b.family) return false;
  for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
    const difference = (b.version[i] ?? 0) - (a.version[i] ?? 0);
    if (difference) return difference > 0;
  }
  return false;
}
export type SlotProposal = {
  kind: "successor" | "gone" | "retiring" | "price-drift" | "stale" | "unmapped-category";
  slot?: string;
  provider?: string;
  endpoint?: string;
  message: string;
};
export type FreshnessCatalogs = SlotCatalogs & { mappedCategories?: readonly string[] };
/** Pure proposal calculation: supplied prices only, no catalogue/price/file loads. */
export function proposeSlotChanges(slots: ModelSlotsFile, catalogs: FreshnessCatalogs, prices: SlotPrices, now: Date) {
  const table = ModelSlotsFileSchema.parse(slots),
    date = now.toISOString().slice(0, 10),
    proposals: SlotProposal[] = [];
  let changed = false;
  for (const slot of table.slots) {
    let slotChanged = false;
    if (slot.reviewBy < date)
      proposals.push({ kind: "stale", slot: slot.id, message: `reviewBy ${slot.reviewBy} has passed` });
    const ordered = [...slot.candidates].sort((a, b) => a.order - b.order);
    const amount = (candidate: ModelSlotCandidate) => {
      const entry = catalogs[candidate.provider]?.get(candidate.endpoint);
      const price = entry && slotModelPrice(entry, slot.reference ?? {}, prices, now);
      return price && planningChoicePrice(price)
        ? price.usd
        : candidate.referenceEstimate?.per === "second"
          ? slot.reference?.durationSec === undefined
            ? null
            : candidate.referenceEstimate.usd * slot.reference.durationSec
          : candidate.referenceEstimate
            ? candidate.referenceEstimate.usd *
              (candidate.referenceEstimate.per === "image" ? (slot.reference?.images ?? 1) : 1)
            : null;
    };
    const hero = ordered.find(
      (c) => c.status === "active" && c.class === "hero" && catalogs[c.provider]?.get(c.endpoint)?.status === "active",
    );
    const heroUsd = hero && amount(hero);
    for (const candidate of ordered) {
      const successors = [...(catalogs[candidate.provider]?.values() ?? [])]
        .filter((row) => row.status === "active" && isEndpointSuccessor(candidate.endpoint, row.endpoint))
        .sort((a, b) =>
          isEndpointSuccessor(a.endpoint, b.endpoint)
            ? -1
            : isEndpointSuccessor(b.endpoint, a.endpoint)
              ? 1
              : a.endpoint.localeCompare(b.endpoint),
        );
      let after = candidate;
      for (const successor of successors) {
        if (slot.candidates.some((c) => c.provider === candidate.provider && c.endpoint === successor.endpoint))
          continue;
        const note = `successor of ${candidate.endpoint} detected ${date}`;
        for (const other of slot.candidates) if (other.order > after.order) other.order++;
        const proposed: ModelSlotCandidate = {
          provider: candidate.provider,
          endpoint: successor.endpoint,
          class: candidate.class,
          order: after.order + 1,
          status: "candidate",
          why: note,
          evidence: [{ kind: "docs", source: note, url: catalogueUrl(successor, candidate.provider), date }],
          addedAt: date,
        };
        slot.candidates.push(proposed);
        after = proposed;
        changed = true;
        slotChanged = true;
        proposals.push({
          kind: "successor",
          slot: slot.id,
          provider: candidate.provider,
          endpoint: successor.endpoint,
          message: note,
        });
      }
    }
    for (const candidate of slot.candidates) {
      const entry = catalogs[candidate.provider]?.get(candidate.endpoint);
      const label = { slot: slot.id, provider: candidate.provider, endpoint: candidate.endpoint };
      if (candidate.status !== "retired" && entry?.status === "gone") {
        candidate.status = "retired";
        const note = `Catalogue gone detected ${date}`;
        candidate.notes = candidate.notes ? `${candidate.notes}; ${note}` : note;
        proposals.push({ kind: "gone", ...label, message: note });
        changed = true;
        slotChanged = true;
      } else if (candidate.status !== "retired" && (entry?.retiresAt || entry?.status === "deprecated")) {
        proposals.push({
          kind: "retiring",
          ...label,
          message: `Catalogue deprecated/retiring${entry.retiresAt ? ` at ${entry.retiresAt}` : ""}; review required`,
        });
      }
      if (candidate.status !== "retired" && ["budget", "draft"].includes(candidate.class)) {
        const usd = amount(candidate);
        if (usd != null && heroUsd != null && usd > heroUsd)
          proposals.push({
            kind: "price-drift",
            ...label,
            message: `${candidate.class} $${usd} exceeds hero $${heroUsd} at reference setting ${JSON.stringify(slot.reference ?? {})}`,
          });
      }
    }
    if (slotChanged) slot.candidates.sort((a, b) => a.order - b.order);
  }
  const mapped = new Set([...table.slots.flatMap((slot) => slot.categories), ...(catalogs.mappedCategories ?? [])]);
  const categories = new Set(
    [...(catalogs.fal?.values() ?? []), ...(catalogs.higgsfield?.values() ?? [])]
      .filter((entry) => entry.status === "active")
      .map((entry) => entry.category),
  );
  for (const category of [...categories].sort())
    if (!mapped.has(category))
      proposals.push({
        kind: "unmapped-category",
        message: `Catalogue category ${category} has no use-case/slot mapping`,
      });
  if (changed) table.updatedAt = date;
  return { table: ModelSlotsFileSchema.parse(table), proposals, changed };
}
function catalogueUrl(entry: FalCatalogEntry, provider: string): string {
  return (
    entry.docsUrl ??
    entry.schema?.source ??
    (provider === "fal" ? `https://fal.ai/models/${entry.endpoint}` : "https://platform.higgsfield.ai/")
  );
}
