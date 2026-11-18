import { currentPriceMatrix, loadPriceScenarios, priceFromScenarios } from "./price-matrix";
import type { PriceMatrix } from "../../types/price-matrix";
import { z } from "zod";
import {
  FalCategorySchema,
  InputMediaSchema,
  ModelCapabilitySchema,
  FieldPatternSchema,
  OutputKindSchema,
  ProviderIdSchema,
  TRUST_ORDER,
  providerOf,
  type FalCatalogEntry,
  type ModelChoicePrice,
} from "../../types/fal-catalog";
import {
  ModelClassSchema,
  ModelReferenceSettingSchema,
  ModelSlotsFileSchema,
  ModelPreferencesSchema,
  type ModelClass,
  type ModelSlot,
  type ModelSlotCandidate,
  type ModelSlotsFile,
  type ModelPreferences,
  type ModelUseCasesFile,
} from "../../types/model-slots";
import { loadProviderCatalog } from "./fal-catalog";
import { FAL_TASK_MAP, parseFalTask, normaliseTaskTokens } from "./fal-task-map";
import {
  modelChoicePrice,
  exactChoicePrice,
  planningChoicePrice,
  type ModelPriceParameters,
} from "./model-choice-price";
import { checkModelConstraints, checkModelPrice } from "./model-constraints";
import { equivalentPrices, sameModelParameters, MODEL_EQUIVALENTS } from "./models-compare";
import { findFalEndpointResult } from "./fal-find";
import { loadModelSlots, loadModelUseCases } from "./model-slots-loader";
export { loadModelSlots, modelSlotsPath, MODEL_SLOTS_FILE } from "./model-slots-loader";

export type SlotCatalogs = Partial<Record<"fal" | "higgsfield", ReadonlyMap<string, FalCatalogEntry>>>;
export type SlotPrices =
  | ReadonlyMap<string, ModelChoicePrice>
  | ((entry: FalCatalogEntry, parameters: ModelPriceParameters) => ModelChoicePrice);
export type PickDependencies = {
  slots?: ModelSlotsFile;
  useCases?: ModelUseCasesFile;
  catalogs?: SlotCatalogs;
  prices?: SlotPrices;
  now?: Date;
  preferences?: ModelPreferences;
  priceMatrix?: PriceMatrix;
  qualityTier?: "fast" | "balanced" | "quality";
};
export const ModelPickQuerySchema = z
  .object({
    slot: z.string().min(1).optional(),
    useCase: z.string().min(1).optional(),
    task: z.string().min(1).max(500).optional(),
    class: ModelClassSchema.optional(),
    provider: z.enum(["fal", "higgsfield", "any"]).default("any"),
    model: z.string().min(1).optional(),
    project: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(128)
      .optional(),
    ...ModelReferenceSettingSchema.shape,
    maxUsd: z.number().finite().nonnegative().optional(),
    allowUnknownPrice: z.boolean().default(false),
    inputs: z.array(InputMediaSchema).optional(),
    capabilities: z.array(ModelCapabilitySchema).optional(),
    anyCapabilities: z.array(ModelCapabilitySchema).optional(),
    field: FieldPatternSchema.optional(),
    outputs: z.array(OutputKindSchema).optional(),
    categories: z.array(FalCategorySchema).optional(),
  })
  .strict()
  .refine((q) => Boolean(q.slot || q.task || q.useCase), "Supply --slot, --use-case or --task")
  .refine(
    (q) => [q.slot, q.task, q.useCase].filter(Boolean).length === 1,
    "Supply only one of --slot, --use-case and --task",
  );
export type ModelPickQuery = z.input<typeof ModelPickQuerySchema>;
const classes: ModelClass[] = ["hero", "balanced", "budget", "draft"];
export function classFallbackOrder(requested: ModelClass): ModelClass[] {
  const index = classes.indexOf(requested);
  return [...classes.slice(index), ...classes.slice(0, index).reverse()];
}
const key = (row: { provider?: "fal" | "higgsfield"; endpoint: string }) => `${providerOf(row)}:${row.endpoint}`;
export function slotCatalogs(): SlotCatalogs {
  return { fal: loadProviderCatalog("fal"), higgsfield: loadProviderCatalog("higgsfield") };
}
export function slotModelPrice(
  entry: FalCatalogEntry,
  parameters: ModelPriceParameters,
  prices?: SlotPrices,
  now?: Date,
): ModelChoicePrice {
  if (typeof prices === "function") return prices(entry, parameters);
  if (prices)
    return (
      prices.get(key(entry)) ?? {
        kind: "unknown",
        label: "Unknown price",
        usd: null,
        unitPrice: null,
        unit: null,
        asOf: null,
        evidenceKind: "none",
        basis: null,
      }
    );
  return modelChoicePrice(entry, parameters, { now });
}
/** Specificity: media/category fit, then the narrower concept/category mapping, then id. */
export function resolveTaskSlot(
  task: string,
  file: ModelSlotsFile,
  inputs?: ModelPickQuery["inputs"],
  useCases = loadModelUseCases(),
  useCaseId?: string,
) {
  const parsed = parseFalTask(task);
  const media = inputs ?? parsed.inputs;
  const exact = file.slots.find((slot) => slot.id === task);
  const tokens = new Set(normaliseTaskTokens(task));
  const cases = useCaseId
    ? useCases.useCases.filter((row) => row.id === useCaseId)
    : useCases.useCases
        .flatMap((row) => {
          const scores = [...row.phrasings.ru, ...row.phrasings.en]
            .map((phrase) => normaliseTaskTokens(phrase))
            .filter((words) => words.every((word) => tokens.has(word)))
            .map((words) => words.length);
          return scores.length ? [{ ...row, score: Math.max(...scores) }] : [];
        })
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const useCase = cases[0];
  const preferred = useCase?.slots.flatMap((id) => file.slots.filter((slot) => slot.id === id)) ?? [];
  const matches = exact
    ? [exact]
    : file.slots.filter(
        (slot) =>
          slot.concepts.some((id) => parsed.concepts.includes(id)) &&
          slot.categories.some((category) => parsed.categories.includes(category)),
      );
  const score = (slot: ModelSlot) =>
    (slot.inputs?.filter((input) => media.includes(input)).length ?? 0) * 100 -
    (slot.inputs?.filter((input) => !media.includes(input)).length ?? 0) * 100 +
    slot.categories.filter((category) => parsed.categories.includes(category)).length * 10 -
    slot.concepts.length -
    slot.categories.length;
  matches.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
  const ranked = exact ? matches : useCase ? preferred : useCaseId ? [] : matches;
  return {
    matched: ranked.length > 0,
    slot: ranked[0],
    alternativesSlots: ranked.slice(1).map((s) => s.id),
    concepts: parsed.concepts,
    useCase: useCase?.id ?? null,
  };
}
export function checkModelSlots(
  slots: ModelSlotsFile,
  catalogs: SlotCatalogs = slotCatalogs(),
  prices?: SlotPrices,
  now = new Date(),
): { errors: string[]; warnings: string[] } {
  const result = ModelSlotsFileSchema.safeParse(slots);
  if (!result.success)
    return { errors: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`), warnings: [] };
  const errors: string[] = [],
    warnings: string[] = [];
  const file = result.data;
  const mapped = new Set(file.slots.flatMap((s) => s.concepts));
  const known = new Set(FAL_TASK_MAP.filter((c) => c.categories.length).map((c) => c.id));
  for (const concept of known)
    if (!mapped.has(concept) && !file.catalogueOnlyConcepts.includes(concept))
      errors.push(`Unmapped production concept: ${concept}`);
  for (const concept of [...mapped, ...file.catalogueOnlyConcepts])
    if (!known.has(concept)) errors.push(`Unknown production concept: ${concept}`);
  for (const concept of file.catalogueOnlyConcepts)
    if (mapped.has(concept)) errors.push(`Concept is mapped and catalogue-only: ${concept}`);
  for (const slot of file.slots) {
    if (slot.reviewBy < now.toISOString().slice(0, 10)) warnings.push(`${slot.id}: overdue reviewBy ${slot.reviewBy}`);
    if (!slot.candidates.length) warnings.push(`${slot.id}: slot has no candidates`);
    else if (!slot.candidates.some((c) => c.class === "hero" && c.status === "active"))
      errors.push(`${slot.id}: needs at least one active hero`);
    for (const candidate of slot.candidates) {
      if (candidate.status === "retired") continue;
      const label = `${slot.id}/${key(candidate)}`,
        entry = catalogs[candidate.provider]?.get(candidate.endpoint);
      if (!entry || entry.status === "gone") {
        errors.push(`${label}: endpoint missing or gone`);
        continue;
      }
      if (entry.status !== "active") errors.push(`${label}: endpoint is ${entry.status}`);
      if (!entry.schema) (candidate.status === "active" ? errors : warnings).push(`${label}: schema missing`);
      if (entry.retiresAt) warnings.push(`${label}: retiring ${entry.retiresAt}`);
      if (candidate.status === "active" && !candidate.evidence.length)
        errors.push(`${label}: active candidate needs evidence`);
      // A per-image estimate cannot price video or audio output (frames/duration would be ignored).
      if (candidate.referenceEstimate?.per === "image" && !slot.outputs.includes("image"))
        errors.push(`${label}: per-image referenceEstimate on a non-image slot`);
      if (candidate.status === "active" && TRUST_ORDER[entry.tier] < TRUST_ORDER.verified) {
        if (!candidate.evidence.some((e) => e.kind === "owner") && !candidate.unverifiedAccepted)
          errors.push(`${label}: tier below verified without owner evidence or unverifiedAccepted`);
        else warnings.push(`${label}: active with tier ${entry.tier} (unverified contract)`);
      }
    }
    const reference = slot.reference ?? {};
    const amount = (candidate: ModelSlotCandidate) => {
      const entry = catalogs[candidate.provider]?.get(candidate.endpoint);
      const price = entry && slotModelPrice(entry, reference, prices, now);
      return price && planningChoicePrice(price)
        ? price.usd
        : candidate.referenceEstimate?.per === "second"
          ? reference.durationSec === undefined
            ? undefined
            : candidate.referenceEstimate.usd * reference.durationSec
          : candidate.referenceEstimate?.per === "image"
            ? candidate.referenceEstimate.usd * (reference.images ?? 1)
            : candidate.referenceEstimate?.usd;
    };
    const hero = slot.candidates
      .filter((c) => c.status === "active" && c.class === "hero")
      .sort((a, b) => a.order - b.order)[0];
    const heroUsd = hero && amount(hero);
    for (const budget of slot.candidates.filter((c) => c.status === "active" && c.class === "budget")) {
      const usd = amount(budget);
      if (usd != null && heroUsd != null && usd > heroUsd)
        warnings.push(
          `${slot.id}/${key(budget)}: budget candidate pricier than hero at reference setting (${JSON.stringify(reference)})`,
        );
    }
  }
  return { errors, warnings };
}

/** Planning only: never submits jobs, reserves budget or reads credentials. */
export function pickModel(query: ModelPickQuery, deps: PickDependencies = {}) {
  const q = ModelPickQuerySchema.parse(query),
    file = deps.slots ?? loadModelSlots(),
    catalogs = deps.catalogs ?? slotCatalogs();
  const preferences = deps.preferences && ModelPreferencesSchema.parse(deps.preferences);
  const resolved = q.slot
    ? {
        matched: file.slots.some((s) => s.id === q.slot),
        slot: file.slots.find((s) => s.id === q.slot),
        alternativesSlots: [] as string[],
        concepts: [] as string[],
        useCase: null,
      }
    : resolveTaskSlot(q.task ?? "", file, q.inputs, deps.useCases ?? loadModelUseCases(), q.useCase);
  const slot = resolved.slot;
  const requestedClass =
    q.class ??
    preferences?.defaultClass ??
    (deps.qualityTier === "fast" ? "budget" : deps.qualityTier === "balanced" ? "balanced" : "hero");
  const task = parseFalTask(q.task);
  const explicit = {
    generateAudio: q.generateAudio,
    durationSec: q.durationSec ?? task.durationSec,
    resolution: q.resolution ?? task.resolution,
    aspect: q.aspect ?? task.aspect,
    images: q.images,
    megapixels: q.megapixels,
    inputCharacters: q.inputCharacters,
    inputAudioSec: q.inputAudioSec,
    inputVideoDurationSec: q.inputVideoDurationSec,
    inputMegapixels: q.inputMegapixels,
  };
  const referenceFields = Object.keys(slot?.reference ?? {}).filter(
    (field) => explicit[field as keyof typeof explicit] === undefined,
  );
  const parameters: ModelPriceParameters = {
    ...slot?.reference,
    ...Object.fromEntries(Object.entries(explicit).filter(([, value]) => value !== undefined)),
  };
  const now = deps.now ?? new Date();
  const scenarios = loadPriceScenarios();
  const matrix =
    deps.priceMatrix ?? currentPriceMatrix({ ...file, slots: slot ? [slot] : [] }, catalogs, now, deps.prices);
  const checks = {
    categories: q.categories ?? slot?.categories ?? task.categories,
    inputs: q.inputs ?? (q.task ? task.inputs : slot?.inputs) ?? [],
    outputs: q.outputs ?? slot?.outputs ?? task.outputs,
    capabilities: q.capabilities ?? [],
    anyCapabilities: q.anyCapabilities ?? [],
    field: q.field,
    // Only the caller's own input lengths are checked against stated limits, never a slot's reference.
    inputAudioSec: q.inputAudioSec,
    inputVideoSec: q.inputVideoDurationSec,
    durationSec: explicit.durationSec,
    aspect: explicit.aspect,
    resolution: explicit.resolution,
    minTier: "verified" as const,
    includeRetiring: false,
    includeSchemaless: false,
  };
  const providers = q.provider === "any" ? (["fal", "higgsfield"] as const) : [q.provider];
  const order = classFallbackOrder(requestedClass);
  const pinKeys = new Set(preferences?.pins.filter((p) => p.slot === slot?.id).map(key));
  const candidates = [...(slot?.candidates ?? [])];
  for (const pin of preferences?.pins.filter((p) => p.slot === slot?.id) ?? []) {
    if (!candidates.some((c) => key(c) === key(pin)))
      candidates.push({
        ...pin,
        class: requestedClass,
        status: "active",
        order: 1,
        why: pin.reason,
        evidence: [],
        addedAt: pin.at.slice(0, 10),
      });
  }
  for (const candidate of [...candidates]) {
    if (candidate.status !== "active" || pinKeys.has(key(candidate))) continue;
    const original = catalogs[candidate.provider]?.get(candidate.endpoint);
    if (!original) continue;
    for (const provider of providers.filter((p) => p !== candidate.provider)) {
      const endpoints = [
        candidate.endpoint,
        ...MODEL_EQUIVALENTS.flatMap((pair) =>
          candidate.provider === "fal" && pair.fal === candidate.endpoint
            ? [pair.higgsfield]
            : candidate.provider === "higgsfield" && pair.higgsfield === candidate.endpoint
              ? [pair.fal]
              : [],
        ),
      ];
      for (const endpoint of new Set(endpoints)) {
        const peer = catalogs[provider]?.get(endpoint);
        if (
          peer &&
          !candidates.some((c) => c.provider === provider && c.endpoint === endpoint) &&
          sameModelParameters(original, peer, parameters)
        )
          candidates.push({
            ...candidate,
            provider,
            endpoint,
            evidence: [],
            referenceEstimate: undefined,
            why: `Equivalent provider for ${candidate.endpoint}`,
          });
      }
    }
  }
  for (const candidate of candidates)
    if (candidate.alsoClasses?.includes(requestedClass))
      candidates[candidates.indexOf(candidate)] = { ...candidate, class: requestedClass };
  candidates.sort(
    (a, b) =>
      Number(pinKeys.has(key(b))) - Number(pinKeys.has(key(a))) ||
      order.indexOf(a.class) - order.indexOf(b.class) ||
      a.order - b.order ||
      key(a).localeCompare(key(b)),
  );
  const assess = (candidate: ModelSlotCandidate, pinned = false) => {
    const entry = catalogs[candidate.provider]?.get(candidate.endpoint);
    const rejectedBecause: string[] = [],
      warnings: string[] = [];
    if (candidate.status === "retired" || (!pinned && candidate.status !== "active"))
      rejectedBecause.push(`candidate status is ${candidate.status}`);
    if (!resolved.matched) rejectedBecause.push("Task did not resolve to a slot");
    if (!providers.includes(candidate.provider)) rejectedBecause.push("provider does not match");
    if (preferences?.avoid.some((a) => (!a.slot || a.slot === slot?.id) && key(a) === key(candidate)))
      rejectedBecause.push("avoided by project preferences");
    const owner = candidate.evidence.some((e) => e.kind === "owner") || Boolean(candidate.unverifiedAccepted);
    const matchedCapabilities: { capability: string; field: string }[] = [];
    if (!entry) rejectedBecause.push("endpoint missing from catalogue");
    else {
      const checked = checkModelConstraints(entry, { ...checks, minTier: owner ? "discovered" : "verified" });
      rejectedBecause.push(...checked.rejectedBecause);
      warnings.push(...checked.warnings);
      matchedCapabilities.push(...checked.matchedCapabilities);
      if (owner && TRUST_ORDER[entry.tier] < TRUST_ORDER.verified) warnings.push("unverified contract");
      if (pinned && slot && !slot.candidates.some((c) => key(c) === key(candidate))) {
        const concepts = slot.concepts.length ? slot.concepts.map((concept) => [concept]) : [undefined];
        const capable = concepts.some(
          (taskConcepts) =>
            findFalEndpointResult(
              {
                provider: candidate.provider,
                task: q.task ?? slot.inputs?.join(" "),
                ...checks,
                minTier: "discovered",
              },
              {
                slots: file,
                catalog: new Map([[key(entry), entry]]),
                taskConcepts,
                price: () => slotModelPrice(entry, parameters, deps.prices, now),
                now,
              },
            ).candidates.length > 0,
        );
        if (!capable) rejectedBecause.push("task specialism does not match slot");
      }
    }
    let price: ModelChoicePrice = entry
      ? slotModelPrice(entry, parameters, deps.prices, now)
      : {
          kind: "unknown" as const,
          label: "Unknown price",
          usd: null,
          unitPrice: null,
          unit: null,
          asOf: null,
          evidenceKind: "none",
          basis: null,
        };
    const matrixRow = matrix.rows.find(
      (row) => row.slot === slot?.id && row.provider === candidate.provider && row.endpoint === candidate.endpoint,
    );
    const scenarioPrices = matrixRow?.scenarioPrices ?? {};
    const audioDefault =
      entry?.inputs.find((field) => field.name === "generate_audio")?.default ??
      entry?.inputs.find((field) => field.name === "sound")?.default === "on";
    const scenarioSetting =
      slot?.id.startsWith("video.") && !["video.lipsync", "video.avatar"].includes(slot.id)
        ? { ...parameters, generateAudio: parameters.generateAudio ?? Boolean(audioDefault) }
        : parameters;
    const scenarioPrice = matrixRow && priceFromScenarios(matrixRow, scenarioSetting, scenarios);
    if (!planningChoicePrice(price) && scenarioPrice && scenarioPrice.usd !== null)
      price = {
        kind: scenarioPrice.kind === "exact" ? "exact" : scenarioPrice.kind === "typical" ? "typical" : "approximate",
        usd: scenarioPrice.usd,
        label: `$${scenarioPrice.usd}; ${scenarioPrice.formula ?? scenarioPrice.source}; ${scenarioPrice.source}`,
        unit: null,
        unitPrice: null,
        asOf: scenarioPrice.observedAsOf,
        evidenceKind: scenarioPrice.source,
        basis: scenarioPrice.linearUnit ?? null,
      };
    if (price.kind === "typical") warnings.push("typical historical average; dry-run quote is authoritative");
    const estimate = candidate.referenceEstimate;
    const approximateUsd =
      !planningChoicePrice(price) && estimate
        ? estimate.per === "second"
          ? parameters.durationSec === undefined
            ? null
            : estimate.usd * parameters.durationSec
          : estimate.usd * (estimate.per === "image" ? (parameters.images ?? 1) : 1)
        : null;
    if (!planningChoicePrice(price) && approximateUsd === null) warnings.push(price.label);
    if (price.kind === "approximate" || approximateUsd !== null)
      warnings.push("approximate; generate:model --dry-run quote is authoritative");
    if (slot && slot.reviewBy < now.toISOString().slice(0, 10))
      warnings.push(`Slot overdue for review: ${slot.reviewBy}`);
    if (q.maxUsd !== undefined) {
      if (approximateUsd !== null) {
        if (approximateUsd > q.maxUsd) rejectedBecause.push(`approximate estimate exceeds ${q.maxUsd} USD`);
      } else if (planningChoicePrice(price)) {
        if (price.usd! > q.maxUsd) rejectedBecause.push(`planning estimate exceeds ${q.maxUsd} USD`);
      } else if (!q.allowUnknownPrice) rejectedBecause.push(...checkModelPrice(price, q.maxUsd));
      else warnings.push("Unknown price allowed for planning; obtain an authoritative dry-run quote");
    }
    const finalPrice =
      approximateUsd === null
        ? price
        : {
            ...price,
            kind: "approximate" as const,
            usd: approximateUsd,
            label: `Approximately $${approximateUsd}; ${estimate!.setting}; ${estimate!.source}`,
            referenceEstimate: estimate,
          };
    const labelledPrice = referenceFields.length
      ? { ...finalPrice, label: `${finalPrice.label}; at reference setting (${referenceFields.join(", ")})` }
      : finalPrice;
    return {
      provider: candidate.provider,
      endpoint: candidate.endpoint,
      class: candidate.class,
      price: labelledPrice,
      scenarioPrices,
      perCallTypicalUsd: matrixRow?.perCallTypicalUsd ?? null,
      perCallObservedAsOf: matrixRow?.perCallObservedAsOf ?? null,
      why: candidate.why,
      evidence: candidate.evidence,
      warnings,
      ...(matchedCapabilities.length ? { matchedCapabilities } : {}),
      rejectedBecause,
    };
  };
  let rows = candidates.map((c) => assess(c));
  // Only equivalent models can exchange providers; the slot's quality order remains authoritative.
  rows = rows.map((row) => {
    if (row.rejectedBecause.length || pinKeys.has(key(row))) return row;
    const entry = catalogs[row.provider]?.get(row.endpoint)!;
    const peers = providers
      .filter((provider) => provider !== row.provider)
      .flatMap((provider) => {
        const endpoints = [
          row.endpoint,
          ...MODEL_EQUIVALENTS.flatMap((pair) =>
            row.provider === "fal" && pair.fal === row.endpoint
              ? [pair.higgsfield]
              : row.provider === "higgsfield" && pair.higgsfield === row.endpoint
                ? [pair.fal]
                : [],
          ),
        ];
        return [...new Set(endpoints)].flatMap((endpoint) => {
          const other = catalogs[provider]?.get(endpoint);
          if (!other || !sameModelParameters(entry, other, parameters)) return [];
          const listed = candidates.find((c) => c.provider === provider && c.endpoint === endpoint);
          const assessed = assess(
            listed ?? {
              ...candidates.find((c) => key(c) === key(row))!,
              provider,
              endpoint,
              evidence: [],
              referenceEstimate: undefined,
              why: `Equivalent provider for ${row.endpoint}`,
            },
          );
          return assessed.rejectedBecause.some((reason) => !reason.startsWith("no bounded quote <=")) ? [] : [assessed];
        });
      });
    const peer = peers.sort(
      (a, b) => (a.price.usd ?? Infinity) - (b.price.usd ?? Infinity) || key(a).localeCompare(key(b)),
    )[0];
    // An exact peer may replace an approximate row only when it is cheaper; an approximate peer never replaces anything.
    if (!peer) return row;
    const rowUnpriced = row.price.usd === null && peer.price.usd !== null && exactChoicePrice(peer.price);
    if (
      peer.price.kind === "approximate" ||
      (!rowUnpriced &&
        row.price.kind === "approximate" &&
        !(peer.price.usd !== null && row.price.usd !== null && peer.price.usd < row.price.usd))
    )
      return row;
    const equivalents = equivalentPrices(
      [
        { ...row, price: row.price },
        { ...peer, price: peer.price },
      ],
      true,
    );
    // The approximate row's figure includes a planning margin; an exact cheaper peer for the same model is a safe switch.
    if (rowUnpriced)
      return {
        ...peer,
        warnings: [
          ...peer.warnings,
          `Same model has no planning price at ${row.provider} for these parameters; ${peer.provider} has an exact $${Number(peer.price.usd!.toFixed(4))}`,
        ],
        equivalents,
      };
    if (row.price.kind === "approximate")
      return {
        ...peer,
        warnings: [
          ...peer.warnings,
          `Same model is ≈$${row.price.usd} at ${row.provider}; ${peer.provider} exact $${Number(peer.price.usd!.toFixed(4))} is cheaper`,
        ],
        equivalents,
      };
    return { ...(equivalents.cheaper === peer.provider ? peer : row), equivalents };
  });
  const rejected = rows.filter((r) => r.rejectedBecause.length);
  const passing = rows.filter(
    (r, index) =>
      !r.rejectedBecause.length &&
      rows.findIndex((other) => key(other) === key(r) && !other.rejectedBecause.length) === index,
  );
  const catalogue = new Map(
    Object.values(catalogs)
      .flatMap((c) => [...c.values()])
      .map((e) => [key(e), e]),
  );
  // Slot concepts are alternatives, not a conjunctive task: a general editor may also serve inpainting.
  const fallbackConcepts =
    (q.slot || resolved.useCase) && slot?.concepts.length ? slot.concepts.map((concept) => [concept]) : [undefined];
  const fallbackCandidates =
    !passing.length && resolved.matched
      ? fallbackConcepts
          .flatMap(
            (taskConcepts) =>
              findFalEndpointResult(
                { provider: q.provider, task: q.task ?? slot?.inputs?.join(" "), ...checks, minTier: "verified" },
                {
                  allCandidates: true,
                  slots: file,
                  taskConcepts,
                  price: (entry) => slotModelPrice(entry, parameters, deps.prices, now),
                  catalog: catalogue,
                  now,
                },
              ).candidates,
          )
          .sort((a, b) => b.score - a.score || key(a).localeCompare(key(b)))
      : [];
  const fallbackAssessed: ReturnType<typeof assess>[] = [];
  const fallbackRows = fallbackCandidates.flatMap((row, index) => {
    if (
      fallbackCandidates.findIndex((other) => key(other) === key(row)) !== index ||
      candidates.some((c) => key(c) === key(row))
    )
      return [];
    const synthetic: ModelSlotCandidate = {
      ...row,
      class: requestedClass,
      status: "active",
      order: 1,
      why: "Catalogue fallback",
      evidence: [],
      addedAt: now.toISOString().slice(0, 10),
    };
    const checked = assess(synthetic);
    fallbackAssessed.push(checked);
    return checked.rejectedBecause.length
      ? []
      : [{ ...checked, fromCatalogue: true as const, warnings: [...checked.warnings, "not in the slot table"] }];
  });
  const available = passing.length ? passing : fallbackRows;
  const userPin = q.model
    ? providers.map((provider) => {
        const existing = candidates.find((c) => c.provider === provider && c.endpoint === q.model);
        return assess(
          existing ?? {
            provider,
            endpoint: q.model!,
            class: requestedClass,
            status: "active",
            order: 1,
            why: "User pin",
            evidence: [],
            addedAt: now.toISOString().slice(0, 10),
          },
          true,
        );
      })
    : [];
  const validPins = userPin.filter((p) => !p.rejectedBecause.length);
  const a = validPins[0],
    b = validPins[1];
  const pinComparison =
    a &&
    b &&
    a.price.kind !== "approximate" &&
    b.price.kind !== "approximate" &&
    sameModelParameters(catalogs[a.provider]!.get(a.endpoint)!, catalogs[b.provider]!.get(b.endpoint)!, parameters)
      ? equivalentPrices(
          [
            { ...a, price: a.price },
            { ...b, price: b.price },
          ],
          true,
        )
      : undefined;
  const chosenPin = pinComparison?.cheaper ? validPins.find((p) => p.provider === pinComparison.cheaper) : validPins[0];
  const pin = chosenPin ? { ...chosenPin, ...(pinComparison ? { equivalents: pinComparison } : {}) } : userPin[0];
  const pick = q.model ? (pin?.rejectedBecause.length ? null : pin) : (available[0] ?? null);
  const project = q.project ?? "PROJECT";
  const nextCommands = pick
    ? [
        `pnpm fal:scaffold --provider ${pick.provider} --endpoint ${pick.endpoint} --out REQUEST.json`,
        `pnpm ${pick.provider === "fal" ? "fal" : "hf"}:quote --request REQUEST.json${pick.provider === "fal" ? ` --project ${project}` : ""}`,
        `pnpm generate:model --request REQUEST.json --project ${project} --output public/projects/${project}/assets/MODEL_OUTPUT --dry-run`,
      ]
    : [];
  const quoteRows = [...(q.model ? userPin : rows), ...fallbackAssessed];
  const needsQuote = quoteRows
    .filter(
      (row, index) =>
        !planningChoicePrice(row.price) &&
        row.rejectedBecause.every((reason) => reason === `no bounded quote <= ${q.maxUsd} USD`) &&
        quoteRows.findIndex((other) => key(other) === key(row)) === index,
    )
    .map((row) => {
      const request = `REQUEST-${row.provider}-${row.endpoint.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}.json`;
      return {
        ...row,
        scaffoldCommand: `pnpm fal:scaffold --provider ${row.provider} --endpoint ${row.endpoint} --out ${request}`,
        command: `pnpm generate:model --request ${request} --project ${project} --output public/projects/${project}/assets/MODEL_OUTPUT --dry-run`,
      };
    });
  const message = needsQuote.length
    ? `${needsQuote.length} candidates pass non-price checks but need an authoritative quote. Scaffold each request, fill the actual inputs and setting, then run its generate:model --dry-run command; token/compute usage may still require a forecast or authorised bound.`
    : null;
  return {
    referenceSetting: parameters,
    referenceFields,
    needsQuote,
    message,
    matched: resolved.matched,
    useCase: resolved.useCase,
    slot: slot?.id ?? null,
    alternativesSlots: resolved.alternativesSlots,
    concepts: resolved.concepts,
    requestedClass,
    pick,
    ...(q.model
      ? {
          userPin: pin,
          pinPassed: Boolean(pick),
          bestAlternative: available.find((row) => key(row) !== key(pin!)) ?? null,
        }
      : {}),
    alternatives: available.filter((row) => !pick || key(row) !== key(pick)).slice(0, 3),
    rejected,
    fallback: fallbackRows.slice(0, 4),
    nextCommands,
  };
}
