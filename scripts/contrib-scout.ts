import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs, CliErrorObject } from "../src/lib/cli";
import { COMMAND_REGISTRY } from "../src/lib/cli/commands";
import { runOffline } from "../src/lib/contrib/cli";
import { repositoryText } from "../src/lib/context/repository";
import { listPlaybookIds, loadPlaybook } from "../src/lib/playbooks/project";
import { collectMetrics } from "../src/lib/metrics";
import { TrustTierSchema } from "../src/types/contrib";
import type { Catalogue } from "../src/lib/library/catalogue";
import {
  CAPABILITIES,
  CATEGORY_WEIGHTS,
  meetsRequirements,
  needsMarkdown,
  parseCapabilities,
  onlineScout,
  rankOpportunities,
  scoutCommands,
  scoutCurated,
  scoutInstructionBaseline,
  scoutLibrary,
  scoutPlaybooks,
  scoutProviders,
  scoutProvisional,
  scoutReferenceGaps,
  scoutShrinking,
  scoutSkippedTests,
  scoutSlop,
  scoutTechniques,
} from "../src/lib/contrib/scout";

void runOffline(async () => {
  const args = parseArgs([
    {
      name: "online",
      type: "boolean",
      description: "Use authenticated gh to add issues and remove claimed/open-PR work",
    },
    { name: "tier", type: "number", description: "Trust tier; 0 puts small, permitted tasks first" },
    {
      name: "can",
      description: `Comma-separated capabilities you have (${CAPABILITIES.join(", ")}); drops tasks whose requires you do not meet`,
    },
    { name: "category", description: "Filter by category" },
    { name: "limit", type: "number", default: 50, description: "Maximum returned opportunities" },
    { name: "json", type: "boolean", description: "JSON contract (also the default)" },
    { name: "out-json", description: "Also write the needs-board JSON data" },
    { name: "markdown", description: "Also write a Markdown needs board" },
  ] as const);
  if (!Number.isSafeInteger(args.limit) || args.limit! < 0)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--limit must be a non-negative integer" });
  const tier = args.tier === undefined ? undefined : TrustTierSchema.parse(args.tier);
  let caps: ReturnType<typeof parseCapabilities> | undefined;
  try {
    caps = args.can === undefined ? undefined : parseCapabilities(args.can);
  } catch (error) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `--can: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const root = process.cwd(),
    repo = repositoryText(root);
  const books = listPlaybookIds(root).map((id) => loadPlaybook(id, root));
  const metrics = collectMetrics(root);
  const catalogue = JSON.parse(repo.read("docs/library/catalogue.json") ?? '{"items":[]}') as Catalogue;
  let rows = [
    ...scoutPlaybooks(books),
    ...scoutProvisional(repo),
    ...scoutShrinking(metrics.health.instructionFilesOverTarget),
    ...scoutReferenceGaps(repo),
    ...scoutLibrary(catalogue, books, repo),
    ...scoutCommands(COMMAND_REGISTRY, books),
    ...scoutProviders(metrics.evidence.providers),
    ...scoutInstructionBaseline(repo),
    ...scoutSkippedTests(repo),
    ...scoutTechniques(repo),
    ...scoutSlop(repo),
    ...scoutCurated(repo),
  ];
  const online = args.online ? onlineScout(rows, root) : undefined;
  const ranked = rankOpportunities(online?.opportunities ?? rows, tier).filter(
    (row) => !caps || meetsRequirements(row, caps),
  );
  const order = (category: string) => -(CATEGORY_WEIGHTS[category] ?? 0);
  const counts = Object.fromEntries(
    [...new Set(ranked.map((row) => row.category))]
      .sort((a, b) => order(a) - order(b) || a.localeCompare(b))
      .map((category) => [category, ranked.filter((row) => row.category === category).length]),
  );
  rows = ranked.filter((row) => !args.category || row.category === args.category).slice(0, args.limit);
  if (args.markdown) {
    mkdirSync(path.dirname(args.markdown), { recursive: true });
    writeFileSync(args.markdown, needsMarkdown(rows));
  }
  const metadata = {
    opportunities: rows,
    dropped: online?.dropped ?? [],
    ...(online?.warning ? { warning: online.warning } : {}),
    counts,
    total: ranked.length,
    assumptions: [
      "counts and total cover every ranked row (after de-duplication, the --tier and --can filters and, with --online, removal of claimed work) before --category and --limit.",
      "Ranking: priority first (curated rows 1-3, scouted rows 0), then tier 0's S-first preference, then 1000·priority + category weight + size bonus. Each row carries source, priority, requires, read and verify (task contract v1, RFC 0002 §3.4); verify commands run offline without spend.",
      "--can: os and harnessSession need any one listed value, tools need all, gpu and signingKey only when true; designApproval is a process gate and never filters.",
      "Reference gaps: Markdown table rows only; Library missing/weak/legacy or Class BLOCK/MODE/HELPER, excluding explicit completed rows. Historical rows need a current coverage check.",
      "Grouped rows: instruction-lint baseline findings per file, skipped tests per test file and commands without a playbook per command section; evidence lists are capped.",
      "Techniques: design-reference/techniques/*.md front-matter with status draft; size S when a demo block exists, M otherwise.",
      "Slop: design-reference/slop-catalogue.md tables only; Source provisional, or a 3D Sensor cell naming only the critic before its first semicolon.",
      "Curated: contrib/opportunities.json, validated strictly; an invalid file fails the run.",
      "GitHub queries are bounded to 1000 open issues and 1000 open PRs; matching uses ids, titles, evidence paths and PR files.",
    ],
  };
  if (args["out-json"]) {
    mkdirSync(path.dirname(args["out-json"]), { recursive: true });
    writeFileSync(args["out-json"], JSON.stringify(metadata, null, 2) + "\n");
  }
  return { outputs: [args.markdown, args["out-json"]].filter((file): file is string => Boolean(file)), metadata };
});
