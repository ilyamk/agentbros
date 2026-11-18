import { z } from "zod";
import {
  FalCatalogEntrySchema,
  type FalCatalogEntry,
  type FalCategory,
  type FalVerifiedPin,
} from "../../types/fal-catalog";
import { HiggsfieldSchemaDocSchema } from "../../types/higgsfield";
import { higgsfieldSchemaSha256, snapshotFromHiggsfieldDoc, summariseInputs } from "./fal-catalog";
import type { HiggsfieldWorkflow } from "./hf-docs";

const FamilySchema = z
  .object({
    catalog_type: z.enum(["model", "workflow"]).default("model"),
    slug: z.string().min(1),
    title: z.string().min(1),
    description: z.string().nullish(),
    company: z.union([z.string(), z.object({ name: z.string() }).passthrough()]).nullish(),
    released_on: z.iso.date().nullish(),
    tags: z.array(z.string()).default([]),
    is_exclusive: z.boolean().optional(),
    display: z.object({ is_exclusive: z.boolean().optional() }).passthrough().optional(),
    output_types: z.array(z.string()).default([]),
    entry_points: z.array(z.object({ mode_id: z.string() }).passthrough()),
    pricing: z
      .object({ primary: z.record(z.string(), z.unknown()).nullable() })
      .passthrough()
      .nullish(),
    workflow_slug: z.string().nullish(),
  })
  .transform((row) => ({ ...row, is_exclusive: row.is_exclusive ?? row.display?.is_exclusive ?? false }));
export type HiggsfieldFamily = z.infer<typeof FamilySchema>;
export type HiggsfieldCatalogue = {
  families: HiggsfieldFamily[];
  byModeId: Map<string, HiggsfieldFamily>;
  workflowTags: Map<string, string[]>;
};

/** Parse the public catalogue's results; workflow products annotate modes rather than inventing endpoints. */
export function parseHiggsfieldCatalogue(results: unknown): HiggsfieldCatalogue {
  const rows = z.array(FamilySchema).parse(results);
  const families: HiggsfieldFamily[] = [],
    byModeId = new Map<string, HiggsfieldFamily>(),
    workflowTags = new Map<string, string[]>();
  for (const row of rows) {
    row.entry_points = row.entry_points.filter((point) => !point.mode_id.startsWith("higgsfiled/"));
    if (!row.entry_points.length) continue;
    if (row.catalog_type === "workflow") {
      for (const point of row.entry_points)
        workflowTags.set(
          point.mode_id,
          [
            ...new Set([
              ...(workflowTags.get(point.mode_id) ?? []),
              ...row.tags,
              row.slug,
              ...(row.workflow_slug ? [row.workflow_slug] : []),
            ]),
          ].sort(),
        );
    } else {
      families.push(row);
      for (const point of row.entry_points) byModeId.set(point.mode_id, row);
    }
  }
  return { families, byModeId, workflowTags };
}

/** Sibling modes share a family; prefer the longest model prefix, then a matching fast/pro suffix. */
export function findHiggsfieldFamily(
  endpoint: string,
  catalogue: HiggsfieldCatalogue,
  workflows: Iterable<HiggsfieldWorkflow> = [],
): HiggsfieldFamily | undefined {
  const exact = catalogue.byModeId.get(endpoint);
  if (exact) return exact;
  const candidates = [...catalogue.byModeId].flatMap(([mode, family]) => {
    const prefix = mode.replace(
      /\/(?:text-to-video|image-to-video|reference-to-video|text-to-image|image-to-image|first-last-frame|motion-transfer|generate|edit)(?:\/.*)?$/,
      "",
    );
    return endpoint.startsWith(`${prefix}/`)
      ? [{ family, score: prefix.length + (endpoint.split("/").at(-1) === mode.split("/").at(-1) ? 1 : 0) }]
      : [];
  });
  const candidate = candidates.sort((a, b) => b.score - a.score)[0]?.family;
  if (candidate) return candidate;
  const siblings = [...workflows];
  const docsFamily = siblings.find((row) => row.endpoint === endpoint)?.family;
  if (!docsFamily) return undefined;
  return siblings
    .filter((row) => row.family === docsFamily)
    .map((row) => catalogue.byModeId.get(row.endpoint))
    .find((row) => row !== undefined);
}

export type HiggsfieldEntryOptions = {
  today: string;
  endpoint?: string;
  previous?: FalCatalogEntry;
  verifiedPins?: Readonly<Record<string, FalVerifiedPin>>;
  tags?: string[];
};

function categoryFor(endpoint: string, inputs: FalCatalogEntry["inputs"]): FalCategory {
  if (endpoint === "v1/custom-references") return "training";
  if (inputs.some((input) => input.required && input.media === "video")) return "video-to-video";
  if (/video-edit|video-extend|video-reference|motion-transfer|motion-control|object-swap|restyle/.test(endpoint))
    return "video-to-video";
  if (/qwen.*\/edit$/.test(endpoint)) return "image-to-image";
  if (/text-to-video/.test(endpoint)) return "text-to-video";
  if (/image-to-video|reference-to-video|first-last-frame|image-reference|cinema-studio/.test(endpoint))
    return "image-to-video";
  return "text-to-image";
}

export function buildHiggsfieldEntry(
  workflow: HiggsfieldWorkflow | undefined,
  family: HiggsfieldFamily | undefined,
  options: HiggsfieldEntryOptions,
): FalCatalogEntry {
  const endpoint = workflow?.endpoint ?? options.endpoint ?? family?.entry_points[0]?.mode_id;
  if (!endpoint || endpoint.startsWith("higgsfiled/")) throw new Error("A non-legacy Higgsfield endpoint is required.");
  const doc = workflow
    ? HiggsfieldSchemaDocSchema.parse({
        version: 1,
        endpoint,
        title: workflow.title,
        docsUrl: workflow.docsUrl,
        usageNotes: workflow.usageNotes,
        schema: workflow.schema,
        asOf: options.today,
      })
    : undefined;
  const inputs = doc ? summariseInputs(snapshotFromHiggsfieldDoc(doc)) : [];
  const category = categoryFor(endpoint, inputs);
  const kinds: Array<"image" | "video"> =
    family?.output_types.filter((kind): kind is "image" | "video" => kind === "image" || kind === "video") ?? [];
  if (!kinds.length) kinds.push(category.includes("video") ? "video" : "image");
  const schema = doc
    ? { sha256: higgsfieldSchemaSha256(doc.schema), asOf: options.today, source: doc.docsUrl!, cached: true }
    : null;
  const pin = options.verifiedPins?.[endpoint];
  const company = typeof family?.company === "string" ? family.company : family?.company?.name;
  return FalCatalogEntrySchema.parse({
    provider: "higgsfield",
    endpoint,
    category,
    displayName: workflow?.title ?? family?.title ?? endpoint,
    status: "active",
    firstSeen: options.previous?.firstSeen ?? options.today,
    lastSeen: options.today,
    schema,
    inputs,
    outputs: { kinds: [...new Set(kinds)], fields: kinds.map((kind) => (kind === "image" ? "images" : "video")) },
    transport: category === "training" ? "training" : "queue",
    price: null,
    tier: schema && pin?.catalogSha256 === schema.sha256 ? "verified" : "discovered",
    tags: [...new Set([...(family?.tags ?? []), ...(options.tags ?? [])])].sort(),
    ...(family?.released_on ? { releasedOn: family.released_on } : {}),
    ...(family?.description ? { description: family.description.slice(0, 600) } : {}),
    ...(family ? { exclusive: family.is_exclusive } : {}),
    family: {
      slug: family?.slug ?? workflow?.family ?? endpoint,
      title: family?.title ?? workflow?.family ?? endpoint,
      ...(company ? { company } : {}),
    },
    ...(doc?.docsUrl ? { docsUrl: doc.docsUrl } : {}),
  });
}
