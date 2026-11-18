import {
  TRUST_ORDER,
  type FalCatalogEntry,
  type InputFieldSummary,
  type FalFindQuery,
  type ModelCapability,
  type ModelChoicePrice,
} from "../../types/fal-catalog";
import { exactChoicePrice } from "./model-choice-price";
import {
  ASPECT_FIELD,
  DURATION_FIELD,
  INPUT_LENGTH_CATEGORIES,
  RESOLUTION_FIELD,
  SIZE_ASPECTS,
  capabilityField,
  checkInputSeconds,
  fieldsMatching,
} from "./capabilities";

// Keep the finder weights here so constraints have identical scoring in both callers.
const FAL_FIND_WEIGHTS = { retiring: -100, category: 100, input: 20, constraint: 10 };
function fits(field: InputFieldSummary, value: string | number): boolean {
  const number = typeof value === "number" ? value : Number.parseFloat(value);
  if (field.type === "integer" && !Number.isInteger(number)) return false;
  if (
    field.enum &&
    !field.enum.some(
      (item) =>
        String(item).toLowerCase() === String(value).toLowerCase() ||
        (typeof value === "number" && Number.parseFloat(String(item)) === value),
    )
  )
    return false;
  return (field.min === undefined || number >= field.min) && (field.max === undefined || number <= field.max);
}
export function checkModelConstraints(
  entry: FalCatalogEntry,
  q: Pick<FalFindQuery, "minTier" | "includeSchemaless" | "includeRetiring"> & {
    categories: NonNullable<FalFindQuery["categories"]>;
    inputs: NonNullable<FalFindQuery["inputs"]>;
    outputs: NonNullable<FalFindQuery["outputs"]>;
    capabilities?: readonly ModelCapability[];
    anyCapabilities?: readonly ModelCapability[];
    field?: string;
    inputAudioSec?: number;
    inputVideoSec?: number;
    durationSec?: number;
    aspect?: string;
    resolution?: string;
  },
) {
  const { categories, inputs, outputs, durationSec: duration, aspect, resolution } = q;
  const rejectedBecause: string[] = [],
    reasons: string[] = [],
    warnings: string[] = [];
  let score = 0;
  if (entry.status !== "active") rejectedBecause.push(`status is ${entry.status}`);
  if (TRUST_ORDER[entry.tier] < TRUST_ORDER[q.minTier ?? "discovered"]) rejectedBecause.push(`tier below ${q.minTier}`);
  if (!entry.schema && !q.includeSchemaless) rejectedBecause.push("schema-less endpoint");
  if (entry.retiresAt) {
    if (!q.includeRetiring) rejectedBecause.push("retiring endpoint");
    warnings.push(`Retires ${entry.retiresAt}; replacement: ${entry.replacement ?? "not listed"}`);
    score += FAL_FIND_WEIGHTS.retiring;
  }
  if (categories.length && !categories.includes(entry.category)) rejectedBecause.push("category does not match");
  else if (categories.length) {
    score += FAL_FIND_WEIGHTS.category;
    reasons.push(`Category: ${entry.category}`);
  }
  if (!categories.includes("training") && entry.category === "training")
    rejectedBecause.push("training excluded by default");
  for (const media of inputs) {
    if (!entry.schema && q.includeSchemaless)
      warnings.push(`Schema unavailable: ${media} input needs /estimate validation`);
    else if (!entry.inputs.some((field) => field.media === media))
      rejectedBecause.push(`missing input media: ${media}`);
    else {
      score += FAL_FIND_WEIGHTS.input;
      reasons.push(`Accepts ${media}`);
    }
  }
  const matchedCapabilities: { capability: string; field: string }[] = [];
  const schemaless = !entry.schema && q.includeSchemaless;
  for (const capability of q.capabilities ?? []) {
    const field = capabilityField(entry, capability);
    if (schemaless) warnings.push(`Schema unavailable: capability ${capability} needs /estimate validation`);
    else if (!field) rejectedBecause.push(`missing capability: ${capability}`);
    else {
      score += FAL_FIND_WEIGHTS.input;
      reasons.push(`Capability ${capability}: ${field.name}`);
      matchedCapabilities.push({ capability, field: field.name });
    }
  }
  if (q.anyCapabilities?.length) {
    const found = q.anyCapabilities.flatMap((capability) => {
      const field = capabilityField(entry, capability);
      return field ? [{ capability, field: field.name }] : [];
    });
    if (schemaless) warnings.push("Schema unavailable: --any-capability needs /estimate validation");
    else if (!found.length) rejectedBecause.push(`missing any capability of: ${q.anyCapabilities.join(", ")}`);
    else {
      score += FAL_FIND_WEIGHTS.input;
      reasons.push(`Capability (any): ${found.map((item) => `${item.capability}: ${item.field}`).join("; ")}`);
      for (const item of found)
        if (!matchedCapabilities.some((known) => known.capability === item.capability)) matchedCapabilities.push(item);
    }
  }
  if (q.field !== undefined) {
    const found = fieldsMatching(entry, q.field);
    if (schemaless) warnings.push(`Schema unavailable: field /${q.field}/ needs /estimate validation`);
    else if (!found.length) rejectedBecause.push(`no input field matches /${q.field}/`);
    else {
      score += FAL_FIND_WEIGHTS.input;
      reasons.push(`Field /${q.field}/: ${found.map((field) => field.name).join(", ")}`);
      matchedCapabilities.push({ capability: `field:${q.field}`, field: found.map((field) => field.name).join(",") });
    }
  }
  if (!schemaless) {
    const seconds = checkInputSeconds(entry, q);
    rejectedBecause.push(...seconds.rejectedBecause);
    warnings.push(...seconds.warnings);
    reasons.push(...seconds.reasons);
  }
  if (outputs.length && !outputs.some((kind) => entry.outputs.kinds.includes(kind)))
    rejectedBecause.push("output kinds do not match");
  const constraints: [string, string | number | undefined, RegExp][] = [
    ["duration", duration, DURATION_FIELD],
    ["aspect", aspect, ASPECT_FIELD],
    ["resolution", resolution, RESOLUTION_FIELD],
  ];
  for (const [label, value, names] of constraints) {
    if (value === undefined) continue;
    if (label === "duration" && INPUT_LENGTH_CATEGORIES.includes(entry.category)) {
      warnings.push(`Length follows the input; plan the script or source audio for ${value} s`);
      continue;
    }
    const fields = entry.inputs.filter((field) => names.test(field.name));
    const sizeAspects = SIZE_ASPECTS;
    const sizeFits =
      label === "aspect" &&
      entry.inputs.some(
        (field) =>
          field.name === "image_size" &&
          field.enum?.some((item) => typeof item === "string" && sizeAspects[item] === value),
      );
    if (!entry.schema && q.includeSchemaless)
      warnings.push(`Schema unavailable: ${label} ${value} needs /estimate validation`);
    else if (
      label === "aspect" &&
      entry.inputs.some((field) => field.media === "image" || field.media === "video") &&
      ((!fields.length && !sizeFits) || fields.some((field) => field.enum?.includes("auto")))
    )
      warnings.push(`aspect follows the input; crop/prepare the source to ${value}`);
    else if (
      label === "duration" &&
      entry.inputs.some((field) => field.media === "video") &&
      (!fields.length ||
        (fields.some((field) => field.enum?.includes("auto")) && !fields.some((field) => fits(field, value))))
    )
      warnings.push(`Length follows the input; prepare and measure the source video for ${value} s`);
    else if (label === "resolution" && !fields.length && /^(?:\d+p|[248]k)$/i.test(String(value)))
      warnings.push("resolution fixed by variant (not documented in the schema)");
    else if (
      !sizeFits &&
      !fields.some((field) => fits(field, field.name.endsWith("_ms") ? Number(value) * 1000 : value))
    )
      rejectedBecause.push(`unsupported ${label}: ${value}`);
    else {
      score += FAL_FIND_WEIGHTS.constraint;
      reasons.push(`Supports ${label} ${value}`);
    }
  }
  return { rejectedBecause, reasons, warnings, score, matchedCapabilities };
}
export function checkModelPrice(price: ModelChoicePrice, maxUsd?: number): string[] {
  return maxUsd !== undefined && (!exactChoicePrice(price) || price.usd! > maxUsd)
    ? [`no bounded quote <= ${maxUsd} USD`]
    : [];
}
