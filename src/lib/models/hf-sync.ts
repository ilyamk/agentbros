import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { FalVerifiedFileSchema, type FalCatalogEntry, type FalDriftReport } from "../../types/fal-catalog";
import { HiggsfieldSchemaDocSchema, type HiggsfieldSchemaDoc } from "../../types/higgsfield";
import { CliErrorObject } from "../cli";
import {
  computeDrift,
  hfCatalogDir,
  hfSchemaDir,
  higgsfieldSchemaSha256,
  loadProviderCatalog,
  resetProviderCatalogCache,
  writeCatalog,
} from "./fal-catalog";
import {
  buildHiggsfieldEntry,
  findHiggsfieldFamily,
  parseHiggsfieldCatalogue,
  type HiggsfieldCatalogue,
} from "./hf-catalogue";
import { listWorkflowLinks, parseHiggsfieldWorkflowPage, type HiggsfieldWorkflow } from "./hf-docs";
import { retryAfterMs } from "./fal-sync";

export const HF_DOCS_BASE = "https://docs.higgsfield.ai/docs/models/";
export const HF_CATALOG_URL = "https://dash.higgsfield.ai/api/v2/catalog-models/?page_size=100";
export const HF_DRIFT_REPORT_FILE = "out/qa/model-refresh/hf-catalog-drift.md";
const verifiedFile = fileURLToPath(new URL("./hf-verified.json", import.meta.url));
const ListingSchema = z.object({ results: z.array(z.unknown()), next: z.string().nullable().optional() });

export type HiggsfieldSyncOptions = {
  fromFixtures?: string;
  dryRun?: boolean;
  resume?: boolean;
  outDir?: string;
  schemaDir?: string;
  checkpointDir?: string;
  reportFile?: string;
  verifiedFile?: string;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  timeoutMs?: number;
  log?: (message: string) => void;
};
export type HiggsfieldSyncResult = {
  entries: number;
  workflows: number;
  schemas: number;
  counts: Record<string, number>;
  familiesWithoutDocs: string[];
  cataloguePricing: { family: string; primary: Record<string, unknown> }[];
  warnings: string[];
  drift: FalDriftReport & { newlyReleased: string[] };
  written: string[];
  dryRun: boolean;
};

function writeAtomic(file: string, body: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, body);
  renameSync(temporary, file);
}
function allowedUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.protocol !== "https:" ||
    url.port ||
    !(
      (url.hostname === "docs.higgsfield.ai" &&
        /^\/docs\/models\/[a-z0-9/-]+\.md$/.test(url.pathname) &&
        !url.search) ||
      (url.hostname === "dash.higgsfield.ai" &&
        url.pathname === "/api/v2/catalog-models/" &&
        [...url.searchParams.keys()].every((key) => ["page_size", "page", "cursor", "offset", "limit"].includes(key)))
    )
  )
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Higgsfield sync source is outside the public docs/catalogue allowlist.",
    });
  return url;
}

/** Anonymous GETs only; a successfully fetched page is checkpointed before following any links. */
function pageSource(options: HiggsfieldSyncOptions, today: string): (url: string) => Promise<string> {
  const checkpoint = options.checkpointDir ?? path.resolve(".cache/hf-sync", today);
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return async (value: string): Promise<string> => {
    const url = allowedUrl(value);
    if (options.fromFixtures) {
      const file =
        url.hostname === "dash.higgsfield.ai"
          ? "catalog-models.json"
          : path.join("docs", url.pathname.replace(/^\/docs\//, "").replaceAll("/", "_"));
      return readFileSync(path.join(options.fromFixtures, file), "utf8");
    }
    const cached = path.join(checkpoint, `${createHash("sha256").update(url.href).digest("hex")}.json`);
    if (options.resume && existsSync(cached)) {
      const page = z
        .object({ url: z.literal(url.href), body: z.string() })
        .parse(JSON.parse(readFileSync(cached, "utf8")));
      return page.body;
    }
    for (let attempt = 0; ; attempt++) {
      let wait = Math.min(1000 * 2 ** attempt, 8000);
      try {
        const response = await fetchImpl(url.href, {
          method: "GET",
          headers: { "User-Agent": "AI-Video-Creator-Higgsfield-Sync/1.0" },
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        });
        if (response.ok) {
          const body = await response.text();
          if (!options.dryRun) writeAtomic(cached, `${JSON.stringify({ url: url.href, body })}\n`);
          return body;
        }
        if (response.status !== 429 && response.status < 500)
          throw new CliErrorObject({
            code: "NETWORK",
            message: `Higgsfield sync GET failed (${response.status}) at ${url.href}.`,
          });
        if (response.status === 429) {
          wait = retryAfterMs(response.headers.get("Retry-After"), options.now?.().getTime()) ?? wait;
          if (wait > 60_000)
            throw new CliErrorObject({
              code: "RATE_LIMIT",
              message: "Higgsfield sync Retry-After exceeds the local wait limit.",
              retryAfterMs: wait,
            });
        }
        if (attempt >= (options.maxRetries ?? 3))
          throw new CliErrorObject({
            code: response.status === 429 ? "RATE_LIMIT" : "NETWORK",
            message: `Higgsfield sync GET retries exhausted (${response.status}) at ${url.href}.`,
            ...(response.status === 429 ? { retryAfterMs: wait } : {}),
          });
      } catch (error) {
        if (error instanceof CliErrorObject) throw error;
        if (attempt >= (options.maxRetries ?? 3))
          throw new CliErrorObject({
            code: "NETWORK",
            message: `Higgsfield sync GET retries exhausted at ${url.href}.`,
          });
      }
      await sleep(wait);
    }
  };
}

function driftMarkdown(result: HiggsfieldSyncResult, today: string): string {
  const list = (items: string[]) => (items.length ? items.map((item) => `- ${item}`).join("\n") : "None.");
  return `# Higgsfield catalogue drift\n\nRecorded: ${today}. Sources: public documentation and catalogue; offline fixtures do not establish live acceptance.\n\n${Object.entries(
    result.counts,
  )
    .map(([category, count]) => `- ${category}: ${count}`)
    .join(
      "\n",
    )}\n\n## Added\n\n${list(result.drift.added)}\n\n## Gone\n\n${list(result.drift.gone)}\n\n## Schema changed\n\n${list(result.drift.schemaChanged.map((row) => `${row.endpoint}: ${row.from} → ${row.to}`))}\n\n## Newly released\n\n${list(result.drift.newlyReleased)}\n\n## Families without docs\n\n${list(result.familiesWithoutDocs)}\n\n## Warnings\n\n${list(result.warnings)}\n`;
}

/** Fetch and validate the complete candidate index before publishing any catalogue/schema changes. */
export async function runHiggsfieldSync(options: HiggsfieldSyncOptions = {}): Promise<HiggsfieldSyncResult> {
  const now = options.now?.() ?? new Date(),
    today = now.toISOString().slice(0, 10);
  const get = pageSource(options, today),
    workflows = new Map<string, HiggsfieldWorkflow>();
  const queue = [`${HF_DOCS_BASE}video-generation.md`, `${HF_DOCS_BASE}image-generation.md`];
  const visited = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const url = queue[i]!;
    if (visited.has(url)) continue;
    visited.add(url);
    const markdown = await get(url);
    const workflow = parseHiggsfieldWorkflowPage(markdown, url);
    if (workflow) {
      workflows.set(workflow.endpoint, workflow);
      continue;
    }
    const links = listWorkflowLinks(markdown);
    if (!links.length || /\*\*(?:Endpoint|Endpoint ID):\*\*/.test(markdown))
      throw new CliErrorObject({ code: "VALIDATION", message: `No complete workflow schema/navigation at ${url}.` });
    queue.push(...links);
  }
  const warnings: string[] = [];
  let catalogueComplete = false;
  let catalogue: HiggsfieldCatalogue = { families: [], byModeId: new Map(), workflowTags: new Map() };
  try {
    let url: string | null = HF_CATALOG_URL;
    const rows: unknown[] = [],
      pages = new Set<string>();
    while (url) {
      if (pages.has(url) || pages.size >= 100) throw new Error("Catalogue pagination repeated or exceeded 100 pages.");
      pages.add(url);
      const page = ListingSchema.parse(JSON.parse(await get(url)));
      rows.push(...page.results);
      url = page.next ? new URL(page.next, url).href : null;
    }
    catalogue = parseHiggsfieldCatalogue(rows);
    catalogueComplete = true;
  } catch {
    warnings.push("Public Higgsfield catalogue unavailable; indexing documentation only.");
    options.log?.(warnings[0]!);
  }
  const outDir = options.outDir ?? hfCatalogDir(),
    schemaDir = options.schemaDir ?? hfSchemaDir();
  resetProviderCatalogCache();
  const previous = loadProviderCatalog("higgsfield", outDir);
  const pins = FalVerifiedFileSchema.parse(JSON.parse(readFileSync(options.verifiedFile ?? verifiedFile, "utf8"))).pins;
  const docs = new Map<string, HiggsfieldSchemaDoc>(),
    entries = new Map<string, FalCatalogEntry>();
  for (const endpoint of [
    ...new Set([...workflows.keys(), ...catalogue.byModeId.keys(), ...catalogue.workflowTags.keys()]),
  ].sort()) {
    const workflow = workflows.get(endpoint);
    const family = findHiggsfieldFamily(endpoint, catalogue, workflows.values());
    const entry = buildHiggsfieldEntry(workflow, family, {
      today,
      endpoint,
      previous: previous.get(endpoint),
      verifiedPins: pins,
      tags: catalogue.workflowTags.get(endpoint),
    });
    entries.set(endpoint, entry);
    if (workflow) {
      const doc = HiggsfieldSchemaDocSchema.parse({
        version: 1,
        endpoint,
        title: workflow.title,
        docsUrl: workflow.docsUrl,
        usageNotes: workflow.usageNotes,
        schema: workflow.schema,
        asOf: today,
      });
      const sha = higgsfieldSchemaSha256(doc.schema);
      if (!docs.has(sha)) docs.set(sha, doc);
    }
  }
  // Documentation cannot prove catalogue-only removals during an enumeration outage.
  if (!catalogueComplete)
    for (const old of previous.values()) if (!entries.has(old.endpoint) && !old.docsUrl) entries.set(old.endpoint, old);
  const active = [...entries.values()].filter((entry) => entry.status !== "gone");
  for (const old of previous.values())
    if (!entries.has(old.endpoint)) entries.set(old.endpoint, { ...old, status: "gone" });
  const drift = computeDrift(previous.values(), entries.values(), { generatedAt: now.toISOString() });
  const newlyReleased = active
    .filter(
      (entry) =>
        entry.releasedOn &&
        (!previous.has(entry.endpoint) || entry.releasedOn > (previous.get(entry.endpoint)?.releasedOn ?? "")),
    )
    .map((entry) => entry.endpoint)
    .sort();
  // Gone entries retain their frozen schema pin until deliberately removed from the index.
  const referenced = new Set([...entries.values()].flatMap((entry) => (entry.schema ? [entry.schema.sha256] : [])));
  const familiesWithoutDocs = catalogue.families
    .filter((family) => !active.some((entry) => entry.family?.slug === family.slug && entry.docsUrl))
    .map((family) => family.slug)
    .sort();
  const counts: Record<string, number> = {};
  for (const entry of active) counts[entry.category] = (counts[entry.category] ?? 0) + 1;
  const result: HiggsfieldSyncResult = {
    entries: active.length,
    workflows: workflows.size,
    schemas: docs.size,
    counts,
    familiesWithoutDocs,
    cataloguePricing: catalogue.families.flatMap((family) =>
      family.pricing?.primary ? [{ family: family.slug, primary: family.pricing.primary }] : [],
    ),
    warnings,
    drift: { ...drift, newlyReleased },
    written: [],
    dryRun: !!options.dryRun,
  };
  if (!options.dryRun) {
    for (const [sha, doc] of docs) {
      const target = path.join(schemaDir, `${sha}.json`);
      writeAtomic(target, `${JSON.stringify(doc, null, 2)}\n`);
      result.written.push(target);
    }
    result.written.push(...writeCatalog(entries.values(), outDir, { syncedAt: today, provider: "higgsfield" }));
    for (const file of readdirSync(schemaDir))
      if (/^[a-f0-9]{64}\.json$/.test(file) && !referenced.has(file.slice(0, -5))) rmSync(path.join(schemaDir, file));
    const reportFile = options.reportFile ?? HF_DRIFT_REPORT_FILE;
    writeAtomic(reportFile, driftMarkdown(result, today));
    result.written.push(reportFile);
  }
  return result;
}
