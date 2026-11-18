import { checkModelConstraints, checkModelPrice } from "./model-constraints";
import { loadModelSlots } from "./model-slots-loader";
import {
  FalFindQuerySchema,
  type FalFindQuery,
  type FalFindCandidate,
  type ModelChoicePrice,
  type FalFindResult,
  FAL_CATEGORIES,
  type FalCatalogEntry,
  FalCurationFileSchema,
  providerOf,
  type ProviderId,
  type FalCurationEntry,
} from "../../types/fal-catalog";
import { loadProviderCatalog } from "./fal-catalog";
import type { ModelSlotsFile } from "../../types/model-slots";
import { modelChoicePrice, exactChoicePrice, type ModelPriceParameters } from "./model-choice-price";
import type { HiggsfieldPriceRecord } from "../../types/higgsfield";
import { equivalentPrices, sameModelParameters } from "./models-compare";
import { normaliseTaskTokens, parseFalTask, suggestTaskConcepts } from "./fal-task-map";
import curationFile from "./fal-curation.json";
import hfCurationFile from "./hf-curation.json";
import { genjutsuMode } from "../model-preparation/profiles";

export const modelKey = (entry: { provider?: ProviderId; endpoint: string }) =>
  `${providerOf(entry)}:${entry.endpoint}`;
export function loadModelCuration(): ReadonlyMap<string, FalCurationEntry> {
  const entries = [curationFile, hfCurationFile].flatMap((file) => FalCurationFileSchema.parse(file).entries);
  const map = new Map(entries.map((entry) => [modelKey(entry), entry]));
  if (map.size !== entries.length) throw new Error("Duplicate provider/endpoint curation.");
  return map;
}
const curation = loadModelCuration();
export function defaultFindProvider(env: NodeJS.ProcessEnv = process.env): "fal" | "any" {
  return env.HIGGSFIELD_API_KEY ? "any" : "fal";
}
/** Additive weights: trust dominates price and the small curated release-date bonus. */
export const FAL_FIND_WEIGHTS = {
  category: 100,
  input: 20,
  constraint: 10,
  boundedPrice: 10,
  discovered: 0,
  priced: 30,
  verified: 200,
  live: 240,
  role: 25,
  curated: 5,
  retiring: -100,
} as const;
const UNPRICED: ModelChoicePrice = {
  kind: "unknown",
  label: "Not priced: rejected before pricing",
  usd: null,
  unitPrice: null,
  unit: null,
  asOf: null,
  evidenceKind: "none",
  basis: null,
};
const lexical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
type FindOptions = {
  allCandidates?: boolean;
  slots?: ModelSlotsFile;
  taskConcepts?: readonly string[];
  price?: (entry: FalCatalogEntry, parameters: ModelPriceParameters) => ModelChoicePrice;
  catalog?: ReadonlyMap<string, FalCatalogEntry>;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  hfPrices?: ReadonlyMap<string, HiggsfieldPriceRecord>;
};
const stopwords = new Set(
  normaliseTaskTokens(
    "сделай сделать нужно хочу пожалуйста хорошо привет как дела по из на для это создать сгенерируй make create generate need want please a an the to from for with in of my this into video image photo audio text видео фото изображение картинка звук аудио текст hello how are you your our it nice good well is be do does can could should some any very just fal higgsfield model models service tool endpoint provider generation find media api speech sound модель генерация генератор сервис инструмент найти поиск hero draft fast budget cheap черновик быстро дешево лучшее качество best quality",
  ),
);
/** One identifying token in a name/id/tag (3), or three description tokens (1 each).
 * At least half the informative query tokens must overlap, so a stray word is insufficient.
 */
function lexicalScores(task: string, entries: readonly FalCatalogEntry[]): Map<string, number> {
  const tokens = normaliseTaskTokens(task).filter((token) => token.length > 2 && !stopwords.has(token));
  const scores = new Map<string, number>();
  if (!tokens.length) return scores;
  for (const entry of entries) {
    const strong = new Set(
      normaliseTaskTokens(
        `${entry.endpoint} ${entry.displayName} ${entry.tags.join(" ")} ${entry.family?.title ?? ""}`,
      ),
    );
    const description = new Set(normaliseTaskTokens(entry.description ?? ""));
    const overlap = tokens.filter((token) => strong.has(token) || description.has(token));
    const score = overlap.reduce((sum, token) => sum + (strong.has(token) ? 3 : 1), 0);
    if (score >= 3 && overlap.length / tokens.length >= 0.5) scores.set(modelKey(entry), score);
  }
  return scores;
}
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
/** Honest task discovery. No signal means no ranking, including with explain. No provider calls. */
export function findFalEndpointResult(query: FalFindQuery, options: FindOptions = {}): FalFindResult {
  const q = FalFindQuerySchema.parse(query),
    task = parseFalTask(q.task, options.taskConcepts);
  const explicit = Boolean(
    q.categories?.length ||
    q.inputs?.length ||
    q.outputs?.length ||
    q.capabilities?.length ||
    q.anyCapabilities?.length ||
    q.field,
  );
  const provider = q.provider ?? defaultFindProvider(options.env);
  const providers: ProviderId[] = provider === "any" ? ["fal", "higgsfield"] : [provider];
  let entries = new Map(
    [...(options.catalog?.values() ?? providers.flatMap((id) => [...loadProviderCatalog(id).values()]))]
      .filter((entry) => providers.includes(providerOf(entry)))
      .map((entry) => [modelKey(entry), entry]),
  );
  const scores =
    !explicit && !task.matched ? lexicalScores(q.task ?? "", [...entries.values()]) : new Map<string, number>();
  const best = Math.max(0, ...scores.values());
  const lexicalCategories = [
    ...new Set(
      [...entries.values()]
        .filter((entry) => (scores.get(modelKey(entry)) ?? 0) >= Math.max(3, best * 0.8))
        .map((entry) => entry.category),
    ),
  ];
  const via = explicit ? "explicit" : task.matched ? "task-map" : lexicalCategories.length ? "lexical" : "none";
  const match: FalFindResult["match"] = { matched: via !== "none", via, concepts: task.concepts };
  const suggestions =
    via === "none"
      ? suggestTaskConcepts(q.task ?? "").map((suggestion) => ({
          ...suggestion,
          exampleCommand: `pnpm fal:find --provider ${provider} --task ${shellQuote(q.task ?? "")} --category ${suggestion.categories[0]}`,
        }))
      : [];
  const nextActions =
    via === "none" || via === "lexical"
      ? [
          `pnpm memory --add --type gap --summary ${shellQuote(`fal:find ${via === "none" ? "unmatched" : "lexical"} task: ${q.task ?? "(empty)"}`.replaceAll(/\s+/gu, " ").slice(0, 160))} --agent orchestrator --evidence ${shellQuote(`fal:find match.via=${via}; task=${q.task ?? ""}`)}`,
        ]
      : [];
  if (!match.matched)
    return {
      match,
      candidates: [],
      message:
        "No task concept or meaningful catalogue overlap. Rephrase or pass --category, --inputs, --outputs or --capability.",
      suggestions,
      nextActions,
    };
  if (via === "lexical")
    entries = new Map(
      [...entries].filter(([key, entry]) => scores.has(key) && lexicalCategories.includes(entry.category)),
    );
  const inputs = q.inputs ?? task.inputs,
    outputs = q.outputs ?? task.outputs;
  const requestedCategories = q.categories?.length
    ? q.categories
    : via === "lexical"
      ? lexicalCategories
      : task.categories;
  const categories = requestedCategories.filter(
    (category) =>
      !(
        task.concepts.includes("mesh") &&
        inputs.includes("image") &&
        requestedCategories.includes("image-to-3d") &&
        category === "text-to-3d"
      ),
  );
  const duration = q.durationSec ?? task.durationSec,
    aspect = q.aspect ?? task.aspect,
    resolution = q.resolution ?? task.resolution;
  const now = options.now ?? new Date();
  const slots = options.slots ?? loadModelSlots();
  const rows: FalFindCandidate[] = [];
  const photoOnly =
    task.concepts.length === 1 &&
    task.concepts[0] === "animate-photo" &&
    !inputs.includes("audio") &&
    q.inputAudioSec === undefined;
  for (const entry of entries.values()) {
    const rejectedBecause: string[] = [],
      reasons: string[] = [],
      warnings: string[] = [];
    const provider = providerOf(entry);
    let score = FAL_FIND_WEIGHTS[entry.tier];
    if (via === "lexical") {
      score += 40 * (scores.get(modelKey(entry)) ?? 0);
      warnings.push("Lexical match only; verify the endpoint capabilities before use.");
      reasons.push(`Catalogue token overlap: ${scores.get(modelKey(entry))}`);
    }
    const checked = checkModelConstraints(entry, {
      ...q,
      categories,
      inputs,
      outputs,
      durationSec: duration,
      aspect,
      resolution,
    });
    rejectedBecause.push(...checked.rejectedBecause);
    if (photoOnly && entry.inputs.some((field) => field.required && field.media === "audio"))
      rejectedBecause.push("requires audio in addition to the photo; request an audio input for this route");
    reasons.push(...checked.reasons);
    warnings.push(...checked.warnings);
    score += checked.score;
    const curated = curation.get(modelKey(entry));
    const haystack =
      `${entry.endpoint} ${entry.displayName} ${entry.description ?? ""} ${entry.tags.join(" ")} ${entry.family?.title ?? ""}`.toLowerCase();
    if (task.excludedHints.some((hint) => haystack.includes(hint))) rejectedBecause.push("excluded task specialism");
    if (
      task.hints.length &&
      !task.hints.some((hint) => haystack.includes(hint)) &&
      !(
        !task.requireHints &&
        curated?.roles.some((role) => task.roles.includes(role) && !["hero", "fast-draft", "budget"].includes(role)) &&
        !task.hints.includes("object-swap")
      )
    )
      rejectedBecause.push("task specialism does not match");
    if (curated) {
      const role = curated.roles.filter((role) => task.roles.includes(role));
      score += role.length ? FAL_FIND_WEIGHTS.role : FAL_FIND_WEIGHTS.curated;
      reasons.push(`Curated${role.length ? ` for ${role.join(", ")}` : ""}: ${curated.source}`);
      if (provider === "higgsfield") reasons.push(`${curated.reviewedAt}: ${curated.notes}`);
      if (entry.exclusive && role.length) {
        score += 2;
        reasons.push("Exclusive workflow with a curated role match");
      }
    }
    for (const slot of slots.slots)
      for (const candidate of slot.candidates) {
        if (candidate.provider === provider && candidate.endpoint === entry.endpoint)
          reasons.push(`In slot ${slot.id} as ${candidate.class} (#${candidate.order})`);
      }
    reasons.push(`Trust: ${entry.tier}`);
    if (entry.releasedOn) {
      reasons.push(`Released: ${entry.releasedOn}`);
      const peers = [...entries.values()].filter(
        (peer) =>
          peer.releasedOn &&
          peer.releasedOn <= now.toISOString().slice(0, 10) &&
          peer.category === entry.category &&
          ((entry.family && peer.family?.slug === entry.family.slug) ||
            curation.get(modelKey(peer))?.roles.some((role) => task.roles.includes(role))),
      );
      const dates = [...new Set(peers.map((peer) => peer.releasedOn!))].sort();
      const index = dates.indexOf(entry.releasedOn);
      if (index >= 0 && dates.length > 1) {
        score += (12 * index) / (dates.length - 1);
        reasons.push("Release-date bonus within family or curated role");
      }
    } else reasons.push("Release date: unknown");
    // Pricing costs milliseconds per fal entry; a row already rejected is only shown with --explain.
    const price =
      rejectedBecause.length && !q.explain
        ? UNPRICED
        : options.price
          ? options.price(entry, { durationSec: duration, resolution, aspect })
          : modelChoicePrice(entry, { durationSec: duration, resolution, aspect }, options);
    const bounded = exactChoicePrice(price);
    if (!bounded) warnings.push(price.label);
    else {
      score += FAL_FIND_WEIGHTS.boundedPrice / 2;
      reasons.push(`Bounded estimate: ${price.usd} USD`);
    }
    if (!entry.schema)
      warnings.push(
        "Catalogue-only, no schema, tier discovered; validate via hf:quote --provider-estimate (/estimate) or wait for a schema",
      );
    rejectedBecause.push(...checkModelPrice(price, q.maxUsd));
    const mode = genjutsuMode(entry.endpoint, provider);
    rows.push({
      provider,
      releasedOn: entry.releasedOn ?? null,
      price,
      endpoint: entry.endpoint,
      category: entry.category,
      tier: entry.tier,
      score,
      reasons,
      warnings,
      ...(mode
        ? {
            preparation: {
              mode,
              guide: "docs/higgsfield-prompting.md",
              command: `pnpm model:prepare --action profile --mode ${mode}`,
            },
          }
        : {}),
      estimate: { lowUsd: price.usd, expectedUsd: price.usd, highUsd: price.usd, bounded, unit: price.unit },
      nextCommands: [
        ...(mode ? [`pnpm model:prepare --action profile --mode ${mode}`] : []),
        ...(provider === "fal" ? [`pnpm fal:models --schema ${entry.endpoint}`] : []),
        `pnpm fal:scaffold --provider ${provider} --endpoint ${entry.endpoint} --out REQUEST.json`,
        `pnpm ${provider === "higgsfield" ? "hf" : "fal"}:quote --request REQUEST.json${provider === "fal" ? " --project PROJECT" : ""}${!entry.schema ? " --provider-estimate" : ""}`,
        "pnpm generate:model --request REQUEST.json --project PROJECT --output OUTPUT --dry-run",
      ],
      ...(checked.matchedCapabilities.length ? { matchedCapabilities: checked.matchedCapabilities } : {}),
      ...(rejectedBecause.length ? { rejectedBecause } : {}),
    });
  }
  for (const row of rows) {
    const entry = entries.get(modelKey(row))!;
    const peers = rows.filter(
      (peer) =>
        !peer.rejectedBecause &&
        exactChoicePrice(peer.price) &&
        peer.price.basis === row.price.basis &&
        sameModelParameters(entry, entries.get(modelKey(peer))!, { durationSec: duration, resolution, aspect }),
    );
    if (exactChoicePrice(row.price) && peers.length > 1)
      row.score += FAL_FIND_WEIGHTS.boundedPrice / 2 / (1 + row.price.usd!);
    const other = rows.find(
      (peer) => peer.endpoint === row.endpoint && peer.provider !== row.provider && !peer.rejectedBecause,
    );
    if (other && !row.rejectedBecause)
      row.equivalents = equivalentPrices(
        [
          { provider: row.provider, endpoint: row.endpoint, price: row.price },
          { provider: other.provider, endpoint: other.endpoint, price: other.price },
        ],
        sameModelParameters(entry, entries.get(modelKey(other))!, { durationSec: duration, resolution, aspect }),
      );
  }
  rows.sort(
    (a, b) =>
      b.score - a.score ||
      (a.provider === "fal" && b.provider === "fal"
        ? Math.min(Date.parse(entries.get(modelKey(b))!.firstSeen), now.getTime()) -
          Math.min(Date.parse(entries.get(modelKey(a))!.firstSeen), now.getTime())
        : 0) ||
      lexical(modelKey(a), modelKey(b)),
  );
  const accepted = rows.filter((row) => !row.rejectedBecause);
  if (
    !accepted.length &&
    q.inputs === undefined &&
    task.inputs.includes("image") &&
    task.concepts.includes("mesh") &&
    requestedCategories.includes("text-to-3d")
  ) {
    return {
      ...findFalEndpointResult(
        { ...q, categories: ["text-to-3d"], inputs: task.inputs.filter((media) => media !== "image") },
        options,
      ),
      match,
    };
  }
  return {
    match,
    candidates: [
      ...(options.allCandidates ? accepted : accepted.slice(0, q.limit)),
      ...(q.explain ? rows.filter((row) => row.rejectedBecause).slice(0, 10) : []),
    ],
    suggestions,
    nextActions,
  };
}

/** Array API compatibility: a missing task retains legacy catalogue browsing. Task phrases use honest discovery. */
export function findFalEndpoints(query: FalFindQuery, options: FindOptions = {}): FalFindCandidate[] {
  return findFalEndpointResult(
    query.task === undefined &&
      !query.categories?.length &&
      !query.inputs?.length &&
      !query.outputs?.length &&
      !query.capabilities?.length &&
      !query.anyCapabilities?.length &&
      !query.field
      ? { ...query, categories: FAL_CATEGORIES.filter((category) => category !== "training") }
      : query,
    options,
  ).candidates;
}
