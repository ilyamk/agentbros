import { currentPriceMatrix, loadPriceScenarios, matrixPriceLabel } from "./price-matrix";
import type { PriceMatrix } from "../../types/price-matrix";
import { closeSync, existsSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CliErrorObject } from "../cli";
import { modelStats } from "./model-slots-project";
import { ModelClassSchema, ModelSlotsFileSchema, type ModelSlotsFile } from "../../types/model-slots";
import { planningChoicePrice } from "./model-choice-price";
import { ProviderIdSchema, TRUST_ORDER } from "../../types/fal-catalog";
import { checkModelSlots, slotCatalogs, slotModelPrice, type SlotPrices, type SlotCatalogs } from "./model-slots";
import { loadModelSlots, modelSlotsPath } from "./model-slots-loader";

export const SlotEditSchema = z
  .object({
    slot: z.string().min(1),
    action: z.enum(["add", "promote", "retire", "move", "review-by", "evidence-acceptance"]),
    endpoint: z.string().optional(),
    provider: ProviderIdSchema.optional(),
    class: ModelClassSchema.optional(),
    order: z.number().int().positive().optional(),
    why: z.string().min(1).optional(),
    evidenceOwner: z.string().min(1).optional(),
    acceptUnverified: z.string().min(1).optional(),
    reviewBy: z.iso.date().optional(),
  })
  .strict();
export type SlotEdit = z.infer<typeof SlotEditSchema>;
export function editModelSlot(
  input: SlotEdit,
  options: { file?: string; catalogs?: SlotCatalogs; now?: Date; root?: string } = {},
): ModelSlotsFile {
  const edit = SlotEditSchema.parse(input),
    file = options.file ?? modelSlotsPath(),
    catalogs = options.catalogs ?? slotCatalogs();
  const lock = `${file}.lock`,
    temporary = `${file}.${randomUUID()}.tmp`;
  let fd: number;
  try {
    fd = openSync(lock, "wx");
  } catch {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Slot table is locked; retry after the other edit finishes.",
    });
  }
  try {
    const slots = loadModelSlots(file),
      slot = slots.slots.find((s) => s.id === edit.slot);
    const fail = (message: string): never => {
      throw new CliErrorObject({ code: "VALIDATION", message });
    };
    if (!slot) return fail(`Unknown slot: ${edit.slot}`);
    const date = (options.now ?? new Date()).toISOString().slice(0, 10);
    if (edit.action === "review-by") slot.reviewBy = edit.reviewBy ?? fail("--review-by DATE is required");
    else {
      const provider = edit.provider ?? fail("--provider is required"),
        endpoint = edit.endpoint ?? fail("Endpoint is required");
      const entry = catalogs[provider]?.get(endpoint);
      if (!entry || entry.status === "gone") return fail("Refusing missing or gone endpoint");
      const existing = slot.candidates.find((c) => c.provider === provider && c.endpoint === endpoint);
      if (edit.action === "add") {
        if (existing) return fail("Candidate already exists; use promote or move");
        slot.candidates.push({
          provider,
          endpoint,
          class: edit.class ?? fail("--class is required"),
          order: edit.order ?? Math.max(0, ...slot.candidates.map((c) => c.order)) + 1,
          status: "active",
          why: edit.why ?? fail("--why is required"),
          evidence: [
            {
              kind: "owner",
              text: edit.evidenceOwner ?? fail("--evidence-owner is required"),
              source: "owner via models:slot",
              date,
            },
          ],
          addedAt: date,
        });
      } else {
        if (!existing) return fail("Candidate is not in the slot");
        if (edit.action === "evidence-acceptance") {
          const row = modelStats(slots, { all: true, root: options.root }).find(
            (row) => row.slot === slot.id && row.provider === provider && row.endpoint === endpoint,
          );
          if (!row || (!row.accepted && !row.rejected)) return fail("No first-pass verdicts for this slot/endpoint");
          const evidence = {
            kind: "acceptance" as const,
            accepted: row.accepted,
            generations: row.accepted + row.rejected,
            source: "Local first recorded verdict per operation; generations counts judged operations only",
            date,
          };
          existing.evidence = [
            ...existing.evidence.filter(
              (item) => item.kind !== "acceptance" || item.source !== evidence.source || item.date !== date,
            ),
            evidence,
          ];
        }
        if (edit.action === "promote") {
          if (existing.status !== "candidate") return fail("Only proposed candidates can be promoted");
          if (
            TRUST_ORDER[entry.tier] < TRUST_ORDER.verified &&
            !existing.evidence.some((e) => e.kind === "owner") &&
            !existing.unverifiedAccepted &&
            !edit.acceptUnverified
          )
            return fail("Promotion needs verified tier, owner evidence or --accept-unverified REASON");
          if (TRUST_ORDER[entry.tier] < TRUST_ORDER.verified && edit.acceptUnverified && !existing.unverifiedAccepted)
            existing.unverifiedAccepted = { reason: edit.acceptUnverified, at: date };
          existing.status = "active";
          if (edit.class) existing.class = edit.class;
        }
        if (edit.action === "retire") existing.status = "retired";
        if (edit.action === "move") existing.order = edit.order ?? fail("--order is required");
      }
    }
    slots.updatedAt = date;
    ModelSlotsFileSchema.parse(slots);
    // Existing unrelated errors must not prevent repairing one slot incrementally.
    const before = new Set(checkModelSlots(loadModelSlots(file), catalogs, undefined, options.now).errors);
    const errors = checkModelSlots(slots, catalogs, undefined, options.now).errors.filter(
      (error) => !before.has(error),
    );
    if (errors.length) return fail(errors.join("; "));
    writeFileSync(temporary, `${JSON.stringify(slots, null, 2)}\n`, { flag: "wx" });
    renameSync(temporary, file);
    return slots;
  } finally {
    closeSync(fd);
    unlinkSync(lock);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
export function renderModelSlotsDoc(
  file: ModelSlotsFile,
  options: { catalogs?: SlotCatalogs; prices?: SlotPrices; now?: Date; matrix?: PriceMatrix } = {},
): string {
  const catalogs = options.catalogs ?? slotCatalogs();
  const matrix = options.matrix ?? currentPriceMatrix(file, catalogs, options.now ?? new Date(), options.prices);
  const scenarios = loadPriceScenarios();
  const lines = [
    "# Model task slots",
    "",
    "Generated by `pnpm models:slots --write-doc`; edit the JSON with `models:slot`.",
    "",
    `Table updated: ${file.updatedAt}. Prices are planning evidence; the generation dry-run quote is authoritative.`,
    "",
    "Each slot supplies its own reference setting. Empty slots use catalogue fallback until candidates are curated.",
    "",
  ];
  lines.push(
    "Price matrix: $ exact; ≈ approximate; ~ typ historical average per call; ≥ catalogue floor; ? unknown. Source and observation dates follow each table. Historical averages are not quotes and never scale to seconds/characters. Audio columns use the tariff audio switch where supported; other endpoints retain their variant pricing.",
    "",
  );
  for (const slot of file.slots) {
    lines.push(
      `## ${slot.id} — ${slot.title}`,
      "",
      slot.description,
      "",
      `Reference setting: ${JSON.stringify(slot.reference ?? {})}.`,
      "",
      `Concepts: ${slot.concepts.join(", ") || "explicit slot only"}. Categories: ${slot.categories.join(", ")}. Review by: ${slot.reviewBy}.`,
      "",
      "| Order | Provider / endpoint | Class | Status | Reference estimate | Evidence dates | Why |",
      "|---|---|---|---|---|---|---|",
    );
    for (const c of [...slot.candidates].sort((a, b) => a.order - b.order)) {
      const estimate = c.referenceEstimate;
      const entry = catalogs[c.provider]?.get(c.endpoint);
      const price = entry && slotModelPrice(entry, slot.reference ?? {}, options.prices, options.now);
      const reference =
        price && planningChoicePrice(price)
          ? `${price.kind}: ${price.label}; ${price.asOf}; ${price.evidenceKind}`
          : estimate && (estimate.per !== "second" || slot.reference?.durationSec !== undefined)
            ? `Approximate $${estimate.usd * (estimate.per === "second" ? (slot.reference?.durationSec ?? 1) : estimate.per === "image" ? (slot.reference?.images ?? 1) : 1)} at reference setting; ${estimate.setting}; ${estimate.observedAsOf}; ${estimate.source}`
            : "Unknown; obtain a dry-run quote";
      lines.push(
        `| ${c.order} | ${c.provider} / ${c.endpoint} | ${c.class}${c.alsoClasses?.length ? ` (+${c.alsoClasses.join(", ")})` : ""} | ${c.status} | ${cell(reference)} | ${c.evidence.map((e) => `${e.kind}: ${"date" in e ? e.date : e.observedAt}`).join("; ")} | ${cell(c.why)} |`,
      );
    }
    if (!slot.candidates.length) lines.push("| — | No candidates yet | — | — | — | — | S3 curation pending | ");
    lines.push("");
    const ids = scenarios.slots[slot.id] ?? [];
    lines.push(
      "Price comparison matrix:",
      "",
      `| Provider / endpoint | ${ids.join(" | ")} | Typical / call |`,
      `|---|${ids.map(() => "---|").join("")}---|`,
    );
    const rows = matrix.rows.filter((row) => row.slot === slot.id);
    for (const row of rows)
      lines.push(
        `| ${row.provider} / ${row.endpoint} | ${ids.map((id) => matrixPriceLabel(row.scenarioPrices[id]!)).join(" | ")} | ${row.perCallTypicalUsd === null ? "?" : `~$${row.perCallTypicalUsd} typ (${row.perCallObservedAsOf})`} |`,
      );
    lines.push("", "Sources and observation dates:", "");
    for (const row of rows) {
      const sources = [
        ...new Set(
          Object.values(row.scenarioPrices).map((cell) => `${cell.source} (${cell.observedAsOf ?? "undated"})`),
        ),
      ];
      lines.push(`- ${row.provider} / ${row.endpoint}: ${sources.map(cell).join("; ")}.`);
    }
    lines.push("");
  }
  lines.push(`Catalogue-only concepts: ${file.catalogueOnlyConcepts.join(", ") || "none"}.`, "");
  if (file.slots.some((s) => s.candidates.some((c) => c.evidence.some((e) => e.kind === "arena"))))
    lines.push("Arena rankings attributed to [Artificial Analysis](https://artificialanalysis.ai/).", "");
  return lines.join("\n");
}

/** Compare under the same lock as owner edits, so refresh cannot overwrite a concurrent edit. */
export function writeModelSlotRefresh(before: ModelSlotsFile, next: ModelSlotsFile, file = modelSlotsPath()): void {
  const lock = `${file}.lock`,
    temporary = `${file}.${randomUUID()}.tmp`;
  let fd: number;
  try {
    fd = openSync(lock, "wx");
  } catch {
    throw new CliErrorObject({ code: "VALIDATION", message: "Slot table is locked" });
  }
  try {
    if (JSON.stringify(loadModelSlots(file)) !== JSON.stringify(before))
      throw new CliErrorObject({ code: "VALIDATION", message: "Slot table changed during refresh; rerun proposals" });
    writeFileSync(temporary, `${JSON.stringify(ModelSlotsFileSchema.parse(next), null, 2)}\n`, { flag: "wx" });
    renameSync(temporary, file);
  } finally {
    closeSync(fd);
    unlinkSync(lock);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
