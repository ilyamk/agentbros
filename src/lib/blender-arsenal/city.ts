import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assertPathWithin, CliErrorObject } from "../cli";
import { arsenalPaths } from "./paths";

export const CityAreaSchema = z
  .object({
    lat: z.number().finite().min(-85).max(85),
    lon: z.number().finite().min(-180).max(180),
    radius: z.number().int().min(50).max(1500),
  })
  .strict();
export const OsmSourceSchema = z
  .object({
    elements: z
      .array(
        z
          .object({
            type: z.literal("way"),
            id: z.number().int().nonnegative(),
            tags: z.record(z.string(), z.string()),
            geometry: z
              .array(
                z
                  .object({ lat: z.number().finite().min(-90).max(90), lon: z.number().finite().min(-180).max(180) })
                  .strict(),
              )
              .min(4)
              .max(2000),
          })
          .passthrough(),
      )
      .max(10000),
    remark: z.string().optional(),
  })
  .passthrough()
  .superRefine((source, ctx) => {
    if (source.remark)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Overpass returned incomplete data: ${source.remark}` });
  });
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors, ODbL";
const CreditsSchema = z
  .object({
    attribution: z.literal(OSM_ATTRIBUTION),
    source: z.literal("https://www.openstreetmap.org/copyright"),
    licence: z.literal("ODbL-1.0"),
  })
  .strict();
const ReceiptSchema = z
  .object({
    version: z.literal(1),
    area: CityAreaSchema,
    source: z.literal("https://overpass-api.de/api/interpreter"),
    query: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    licence: z.literal("ODbL-1.0"),
    attribution: z.literal(OSM_ATTRIBUTION),
    licenceUrl: z.literal("https://www.openstreetmap.org/copyright"),
    consent: z.string().min(1),
    fetchedAt: z.string().datetime(),
    buildings: z.number().int().positive(),
  })
  .strict();
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export function cityCoordinateKey(value: number) {
  const rounded = Math.floor(value * 1_000_000 + 0.5),
    absolute = Math.abs(rounded);
  return `${rounded < 0 ? "-" : ""}${Math.floor(absolute / 1_000_000)}.${String(absolute % 1_000_000).padStart(6, "0")}`;
}
export function cityAreaKey(input: z.input<typeof CityAreaSchema>) {
  const a = CityAreaSchema.parse(input);
  return `${cityCoordinateKey(a.lat)}_${cityCoordinateKey(a.lon)}_${a.radius}`;
}

/** Bounded anonymous acquisition, once per area; the Blender recipe has no network path. */
export async function fetchCity(
  input: z.input<typeof CityAreaSchema>,
  consent: string,
  root = process.cwd(),
  fetcher = fetch,
) {
  const area = CityAreaSchema.parse(input);
  if (!consent.trim())
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "OSM acquisition requires --consent identifying who/when/why.",
    });
  const directory = path.join(arsenalPaths(root).local, "generated/osm-source", cityAreaKey(area));
  const file = path.join(directory, "source.json"),
    receipt = path.join(directory, "asset.json");
  assertPathWithin(root, file);
  assertPathWithin(root, receipt);
  const credits = path.join(directory, "credits.json");
  assertPathWithin(root, credits);
  if (existsSync(file) && existsSync(receipt) && existsSync(credits)) {
    const bytes = readFileSync(file),
      saved = ReceiptSchema.parse(JSON.parse(readFileSync(receipt, "utf8")));
    CreditsSchema.parse(JSON.parse(readFileSync(credits, "utf8")));
    if (cityAreaKey(saved.area) !== cityAreaKey(area))
      throw new CliErrorObject({ code: "VALIDATION", message: "OSM source area differs from receipt." });
    if (sha(bytes) !== saved.sha256)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "OSM source hash differs from receipt; preserve and inspect the cache.",
      });
    const source = OsmSourceSchema.parse(JSON.parse(bytes.toString("utf8")));
    return { file, receipt, reused: true, buildings: source.elements.length };
  }
  const query = `[out:json][timeout:30];way["building"](around:${area.radius},${cityCoordinateKey(area.lat)},${cityCoordinateKey(area.lon)});out tags geom;`;
  const endpoint = "https://overpass-api.de/api/interpreter";
  const response = await fetcher(endpoint, {
    method: "POST",
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(45000),
    redirect: "error",
    headers: { "User-Agent": "AI-Video-Creator-city/1.0 (OSM cached building footprints)" },
  });
  if (!response.ok || !response.body)
    throw new CliErrorObject({ code: "NETWORK", message: `OSM fetch HTTP ${response.status}; no geometry cached.` });
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 16 * 1024 * 1024) throw new Error("OSM response exceeds 16 MiB");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = Buffer.concat(chunks),
    source = OsmSourceSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (!source.elements.length)
    throw new CliErrorObject({ code: "ASSET_MISSING", message: "No closed OSM building ways returned for this area." });
  const data = ReceiptSchema.parse({
    version: 1,
    area,
    source: endpoint,
    query,
    sha256: sha(bytes),
    licence: "ODbL-1.0",
    attribution: OSM_ATTRIBUTION,
    licenceUrl: "https://www.openstreetmap.org/copyright",
    consent,
    fetchedAt: new Date().toISOString(),
    buildings: source.elements.length,
  });
  mkdirSync(path.dirname(directory), { recursive: true });
  const staging = mkdtempSync(path.join(path.dirname(directory), ".osm-source-"));
  try {
    writeFileSync(path.join(staging, "asset.json"), JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
    writeFileSync(path.join(staging, "source.json"), bytes, { flag: "wx" });
    writeFileSync(
      path.join(staging, "credits.json"),
      JSON.stringify({
        attribution: OSM_ATTRIBUTION,
        source: "https://www.openstreetmap.org/copyright",
        licence: "ODbL-1.0",
      }) + "\n",
      { flag: "wx" },
    );
    if (existsSync(directory)) {
      // Preserve interrupted publications; a complete concurrent winner remains authoritative.
      if (existsSync(file) && existsSync(receipt) && existsSync(credits))
        return fetchCity(area, consent, root, fetcher);
      renameSync(directory, `${directory}.incomplete-${randomUUID()}`);
    }
    renameSync(staging, directory);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { file, receipt, reused: false, buildings: source.elements.length };
}
