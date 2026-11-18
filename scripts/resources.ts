import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseArgs, runScript, CliErrorObject } from "../src/lib/cli";
import { ResourceService } from "../src/lib/resources/service";
import { listResourceProviders } from "../src/lib/resources/registry";
import { confirmResourceLicence, evaluateResourceUsage, resourceLicenceReport } from "../src/lib/resources/rights";
import { resourceCatalogue, recommendResourceRoutes } from "../src/lib/resources/catalogues";
import { ResourceCandidateSchema } from "../src/types/resources";
import { OpenverseFiltersSchema } from "../src/lib/resources/openverse";
import { StockFiltersSchema, StockFormatSchema, isStockProvider, STOCK_PROVIDER_IDS } from "../src/lib/resources/stock";
import { resourceCredits } from "../src/lib/resources/credits";

const specs = [
  {
    name: "action",
    default: "providers",
    description: "providers | route | catalog | search | inspect | confirm | rights | report | acquire | credits",
  },
  { name: "task" },
  { name: "page", type: "number" as const, default: 1 },
  { name: "advertising", type: "boolean" as const, default: false },
  { name: "endorsement", type: "boolean" as const, default: false },
  { name: "standalone-resale", type: "boolean" as const, default: false },
  { name: "provider" },
  { name: "query" },
  { name: "kind", default: "image" },
  { name: "candidate", description: "Saved resource candidate JSON (or array for report)" },
  { name: "project" },
  { name: "source-file" },
  { name: "mode", default: "original" },
  { name: "output" },
  { name: "commercial", type: "boolean" as const, default: false },
  { name: "modified", type: "boolean" as const, default: true },
  { name: "accept-share-alike", type: "boolean" as const, default: false },
  { name: "placements", default: "" },
  { name: "source-url" },
  { name: "licence" },
  { name: "licence-url" },
  { name: "limit", type: "number" as const, default: 10 },
  { name: "category" },
  { name: "source" },
  { name: "excluded-source" },
  { name: "licences" },
  { name: "length" },
  { name: "aspect-ratio" },
  { name: "size" },
  { name: "index", type: "number" as const, description: "Pick one candidate from a saved array" },
  { name: "orientation", description: "Stock: portrait | landscape | square" },
  {
    name: "color",
    description:
      "Stock: black_and_white | black | white | gray | yellow | orange | red | purple | pink | green | teal | blue | brown",
  },
  { name: "safe", type: "boolean" as const, default: false, description: "Stock: strict content filter" },
  { name: "format", description: "Stock: vertical | square | landscape — frame the media fills" },
  { name: "zoom", type: "number" as const, description: "Stock: camera push-in (1–4) the source must survive" },
  { name: "min-width", type: "number" as const },
  { name: "min-height", type: "number" as const },
  { name: "author", description: "Stock: provider author handle (a candidate's authorId)" },
  { name: "same-author-as", description: "Stock: saved candidate JSON whose author to follow" },
  { name: "collections", description: "Unsplash collection ids, comma-separated" },
  { name: "topic", description: "Unsplash topic slug" },
  { name: "image-type", description: "Pixabay: photo | illustration | vector" },
  { name: "video-type", description: "Pixabay: film | animation" },
  { name: "editors-choice", type: "boolean" as const, default: false },
  { name: "order", description: "Stock: relevant | popular | latest" },
  { name: "lang", description: "Stock: two-letter query language" },
  {
    name: "credit",
    type: "boolean" as const,
    default: false,
    description: "Acquire: put the creator in release credits",
  },
  { name: "allow-upscale", type: "boolean" as const, default: false },
  { name: "all", type: "boolean" as const, default: false, description: "Credits: every acquired item" },
] as const;
runScript(async () => {
  const args = parseArgs(specs.map((spec) => ({ description: spec.name, ...spec }))),
    action = String(args.action);
  const usage = {
    advertising: args.advertising === true,
    endorsement: args.endorsement === true,
    standaloneResale: args["standalone-resale"] === true,
    commercial: args.commercial === true,
    modified: args.modified === true,
    acceptShareAlike: args["accept-share-alike"] === true,
    credit: args.credit === true,
    placements: String(args.placements)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  };
  const service = new ResourceService({
    credentials: {
      pexels: process.env.PEXELS_API_KEY,
      pixabay: process.env.PIXABAY_API_KEY,
      unsplash: process.env.UNSPLASH_ACCESS_KEY,
      freesound: process.env.FREESOUND_API_KEY,
      freesoundOAuth: process.env.FREESOUND_OAUTH_TOKEN,
    },
  });
  const outputs: string[] = [];
  function save(value: unknown) {
    if (typeof args.output === "string") {
      const file = path.resolve(args.output);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
      outputs.push(file);
    }
  }
  if (action === "providers") return { outputs, metadata: { providers: listResourceProviders() } };
  if (action === "route") {
    const routes = recommendResourceRoutes(String(args.task ?? ""));
    save(routes);
    return { outputs, metadata: routes };
  }
  if (action === "catalog") {
    const catalogue = resourceCatalogue(String(args.provider ?? ""), String(args.query ?? ""));
    save(catalogue);
    return { outputs, metadata: catalogue };
  }
  if (action === "credits") {
    if (typeof args.project !== "string")
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "Credits require --project." });
    const result = resourceCredits(args.project, { all: args.all === true });
    save(result.markdown);
    return { outputs, metadata: result };
  }
  if (action === "search") {
    const kind = z.enum(["image", "video", "audio"]).parse(args.kind);
    let providerArg = typeof args.provider === "string" ? args.provider : "";
    let author = typeof args.author === "string" ? args.author : undefined;
    if (typeof args["same-author-as"] === "string") {
      const followed = ResourceCandidateSchema.parse(
        JSON.parse(readFileSync(path.resolve(args["same-author-as"]), "utf8")),
      );
      if (!followed.authorId)
        throw new CliErrorObject({ code: "INVALID_INPUT", message: "That candidate has no authorId to follow." });
      providerArg = followed.provider;
      author = followed.authorId;
    }
    const stockRequested = providerArg === "auto" || providerArg.split(",").every((id) => isStockProvider(id.trim()));
    if (typeof args.query !== "string" && !(stockRequested && (author || typeof args.topic === "string")))
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "Resource search requires --query." });
    const query = typeof args.query === "string" ? args.query : "";
    if (stockRequested) {
      if (kind === "audio")
        throw new CliErrorObject({ code: "INVALID_INPUT", message: "Stock photo/video providers do not cover audio." });
      if (args.category && ["photograph", "illustration", "digitized_artwork"].includes(String(args.category)))
        throw new CliErrorObject({ code: "INVALID_INPUT", message: "That category is an Openverse filter." });
      const stock = StockFiltersSchema.parse(
        Object.fromEntries(
          Object.entries({
            orientation: args.orientation,
            color: args.color,
            safe: args.safe === true ? true : undefined,
            format: args.format,
            zoom: args.zoom,
            minWidth: args["min-width"],
            minHeight: args["min-height"],
            author,
            collections:
              typeof args.collections === "string" ? args.collections.split(",").map((id) => id.trim()) : undefined,
            topic: args.topic,
            imageType: args["image-type"],
            videoType: args["video-type"],
            category: args.category,
            editorsChoice: args["editors-choice"] === true ? true : undefined,
            order: args.order,
            lang: args.lang,
          }).filter(([, value]) => value !== undefined),
        ),
      );
      const providers =
        providerArg === "auto"
          ? ("auto" as const)
          : providerArg.split(",").map((id) => z.enum(STOCK_PROVIDER_IDS).parse(id.trim()));
      const result = await service.stock.search(providers, {
        query,
        kind,
        page: Number(args.page),
        limit: Number(args.limit),
        filters: stock,
      });
      const candidates = result.results.map((item) => item.candidate);
      save(candidates);
      return {
        outputs,
        metadata: {
          candidates,
          ranking: result.results.map(({ candidate, score, reasons, blocked }) => ({
            id: candidate.id,
            score,
            reasons,
            ...(blocked ? { blocked } : {}),
            size: candidate.media,
            preview: candidate.previewUrl,
            author: candidate.author,
          })),
          providers: result.providers,
          ...(result.required ? { required: result.required } : {}),
        },
      };
    }
    const provider = z.enum(["freesound", "openverse", "wikimedia", "nasa"]).parse(providerArg);
    const filters = OpenverseFiltersSchema.parse({
      category: args.category,
      source: args.source,
      excludedSource: args["excluded-source"],
      licences: args.licences?.split(","),
      length: args.length,
      aspectRatio: args["aspect-ratio"],
      size: args.size,
    });
    if (provider !== "openverse" && Object.values(filters).some((value) => value !== undefined))
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "These filters require --provider openverse." });
    const candidates = await service.search(provider, {
      query,
      kind,
      commercial: usage.commercial,
      modified: usage.modified,
      openverse: filters,
      limit: Number(args.limit),
      page: Number(args.page),
    });
    save(candidates);
    return { outputs, metadata: { candidates } };
  }
  if (typeof args.candidate !== "string")
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "This action requires --candidate JSON file." });
  const raw: unknown = JSON.parse(readFileSync(path.resolve(args.candidate), "utf8"));
  if (action === "report") {
    const candidates = z.array(ResourceCandidateSchema).parse(Array.isArray(raw) ? raw : [raw]);
    const report = resourceLicenceReport(candidates, usage);
    save(report.markdown);
    return { outputs, metadata: report };
  }
  if (Array.isArray(raw) && typeof args.index !== "number")
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "The file holds several candidates; pick one with --index.",
    });
  const candidate = ResourceCandidateSchema.parse(Array.isArray(raw) ? raw[Number(args.index)] : raw);
  if (action === "inspect") {
    const inspected = await service.inspect(candidate);
    save(inspected);
    return { outputs, metadata: { candidate: inspected } };
  }
  if (action === "confirm") {
    if (typeof args["source-url"] !== "string" || typeof args.licence !== "string")
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Source confirmation requires --source-url and --licence based on the original asset page.",
      });
    const confirmed = confirmResourceLicence(candidate, {
      sourceUrl: args["source-url"],
      licence: args.licence,
      licenceUrl: typeof args["licence-url"] === "string" ? args["licence-url"] : undefined,
    });
    save(confirmed);
    return { outputs, metadata: { candidate: confirmed } };
  }
  if (action === "rights") return { outputs, metadata: evaluateResourceUsage(candidate, usage) };
  if (action === "acquire") {
    if (typeof args.project !== "string")
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "Resource acquisition requires --project." });
    const result = await service.acquire(candidate, {
      projectId: args.project,
      usage,
      sourceFile: typeof args["source-file"] === "string" ? args["source-file"] : undefined,
      mode: z.enum(["original", "preview"]).parse(args.mode),
      ...(typeof args.format === "string"
        ? {
            target: {
              format: StockFormatSchema.parse(args.format),
              ...(typeof args.zoom === "number" ? { zoom: args.zoom } : {}),
            },
          }
        : {}),
      allowUpscale: args["allow-upscale"] === true,
    });
    return {
      outputs: [path.resolve("public", result.asset.files.original), result.resourceReceipt],
      metadata: {
        assetId: result.asset.id,
        duplicate: result.duplicate,
        review: result.review,
        credit: usage.credit ? result.review.creditText : undefined,
      },
    };
  }
  throw new CliErrorObject({ code: "INVALID_INPUT", message: `Unknown resource action: ${action}` });
});
