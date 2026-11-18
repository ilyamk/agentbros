import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SyntaxKind as K } from "typescript/unstable/ast";
import { CliErrorObject } from "../cli";
import { COMMAND_REGISTRY } from "../cli/commands";
import { PRICING } from "../pricing";
import { TEMPLATE_REGISTRY } from "../templates/registry";
import type { Catalogue } from "../library/catalogue";
import type { Playbook } from "../../types/playbook";
import { children, evaluator, filesUnder, readSource, walk, withSources } from "../api-surface/source";

export const METRICS_PATH = "out/metrics/metrics.json";
export interface MetricEvidence {
  id: string;
  verified: boolean;
  evidence: string[];
  missing: string[];
}
export interface SensorEvidence extends MetricEvidence {
  source: string;
  calibration: string[];
}
export interface Metrics {
  version: 1;
  raw: {
    playbooks: { total: number; byStatus: Record<string, number> };
    blocks: { total: number; byCategory: Record<string, number> };
    commands: { total: number; bySection: Record<string, number>; bySpend: Record<string, number> };
    providers: number;
    endpoints: number;
    agents: number;
    skills: number;
    sensors: number;
    referenceFilms: number | null;
    techniqueCards: number;
    templates: number;
    tests: number;
  };
  verified: { blocks: number; providers: number; playbooks: number; sensors: number; commands: number };
  evidence: {
    blocks: MetricEvidence[];
    providers: MetricEvidence[];
    playbooks: MetricEvidence[];
    sensors: SensorEvidence[];
    commands: MetricEvidence[];
  };
  health: {
    testFiles: number;
    instructionFilesOverTarget: { file: string; bytes: number; target: number }[];
    unknown: string[];
  };
  sources: Record<string, string[]>;
  unknown: string[];
}
const counts = (values: string[]): Record<string, number> =>
  Object.fromEntries(
    [...new Set(values)].sort().map((value) => [value, values.filter((item) => item === value).length]),
  );
const evidence = (id: string, checks: { met: boolean; source: string }[]): MetricEvidence => ({
  id,
  verified: checks.every((check) => check.met),
  evidence: checks.filter((check) => check.met).map((check) => check.source),
  missing: checks.filter((check) => !check.met).map((check) => check.source),
});
const mentions = (text: string, token: string): boolean =>
  new RegExp(`(?<![\\w:-])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w:-])`, "i").test(text);

/** Static evidence is coverage, never a claim that tests passed or a film was judged. Optional usage files are explicit, never read from the user's memory by default. */
export function collectMetrics(root = process.cwd(), usageFiles: string[] = []): Metrics {
  const unknown: string[] = [];
  const catalogue = JSON.parse(readSource(root, "docs/library/catalogue.json")) as Catalogue;
  const playbooks = filesUnder(root, "playbooks", /\/playbook\.json$/).map(
    (file) => JSON.parse(readSource(root, file)) as Playbook,
  );
  const tests = filesUnder(root, "tests", /\/[^/]+\.test\.ts$/).filter((file) => path.posix.dirname(file) === "tests");
  // Inventory tests must not become their own capability evidence.
  const testSources = tests
    .filter((file) => !["tests/metrics.test.ts", "tests/api-surface.test.ts"].includes(file))
    .map((file) => ({ file, text: readSource(root, file) }));
  const namedCommands = new Set(playbooks.flatMap((book) => book.commands));
  const namedBlocks = new Set(playbooks.flatMap((book) => book.library.blocks));
  for (const file of usageFiles) {
    const usage = JSON.parse(readFileSync(file, "utf8")) as { blocks?: { id: string }[] };
    if (!Array.isArray(usage.blocks))
      throw new CliErrorObject({ code: "VALIDATION", message: `Usage file has no blocks array: ${file}` });
    usage.blocks.forEach((block) => namedBlocks.add(block.id));
  }
  // Block: preview declaration/file + a library or determinism test covering the id or all registry items + a playbook/explicit offline usage record.
  const libraryTests = testSources.filter((test) => /(?:library|determin)/i.test(test.file));
  const allItemsTest = libraryTests.find(
    (test) =>
      /loadLibrary\(/.test(test.text) && /for\s*\(const item of items\)/.test(test.text) && /assert\./.test(test.text),
  );
  const blocks = catalogue.items.map((item) =>
    evidence(item.id, [
      {
        met:
          Boolean(item.preview?.image) ||
          ["jpg", "png", "webp"].some((extension) =>
            existsSync(path.join(root, `docs/library/previews/${item.id}.${extension}`)),
          ),
        source: "Catalogue preview.image or local preview image",
      },
      {
        met: Boolean(allItemsTest) || libraryTests.some((test) => mentions(test.text, item.id)),
        source: allItemsTest?.file ?? "A library/determinism test mentioning the block",
      },
      { met: namedBlocks.has(item.id), source: "Playbook library.blocks or supplied library:usage record" },
    ]),
  );
  // Provider: at least one PRICING entry for its prefix with source and dated evidence, plus a test mentioning the prefix. Free/undisclosed prices without evidence stay unverified.
  const providerIds = [...new Set(Object.keys(PRICING).map((key) => key.split(":")[0]!))].sort();
  const providers = providerIds.map((id) => {
    const priced = Object.entries(PRICING).filter(
      ([key, price]) =>
        key.startsWith(`${id}:`) && Boolean(price.source) && /^\d{4}-\d{2}-\d{2}$/.test(price.asOf ?? ""),
    );
    const tested = testSources.find((test) => mentions(test.text, id));
    return evidence(id, [
      {
        met: priced.length > 0,
        source: priced.length
          ? `src/lib/pricing.ts: ${priced.map(([key]) => key).join(", ")}`
          : "Pricing source and asOf date",
      },
      { met: Boolean(tested), source: tested?.file ?? "A test mentioning the provider" },
    ]);
  });
  // Playbook: ready status and an explicitly non-empty benchmark list. No inferred benchmark coverage.
  const books = playbooks.map((book) =>
    evidence(book.id, [
      { met: book.status === "ready", source: "status ready" },
      { met: book.benchmarks.length > 0, source: "Non-empty benchmarks" },
    ]),
  );
  // Command: explicitly named in a playbook commands list, and a test mentioning its alias or script (not a generic registry inventory).
  const commands = COMMAND_REGISTRY.map((command) => {
    const id = command.alias ?? command.script!;
    const tested = testSources.find((test) =>
      [command.alias, command.script, command.script && path.posix.basename(command.script)].some(
        (token) => token && mentions(test.text, token),
      ),
    );
    return evidence(id, [
      { met: Boolean(command.alias && namedCommands.has(command.alias)), source: "Playbook commands" },
      { met: Boolean(tested), source: tested?.file ?? "Test mentioning the script or alias" },
    ]);
  });
  const sensorFiles = [
    "src/lib/film/plan-check.ts",
    "src/lib/film/measure.ts",
    "src/lib/film/cut-sound.ts",
    "src/lib/sensors/findings.ts",
  ];
  const { sensors, overTarget } = withSources(root, [...sensorFiles, "tests/agents-md.test.ts"], (sources) => {
    const sensors: SensorEvidence[] = [];
    for (const file of sensorFiles) {
      const source = sources.get(file)!;
      const ids = new Set<string>();
      if (file.endsWith("/findings.ts")) {
        const reader = evaluator(source);
        const node = reader.declarations.get("COUNTER_OF_CODE");
        const counters = node ? reader.value(node).value : undefined;
        if (counters && typeof counters === "object" && !Array.isArray(counters))
          Object.values(counters).forEach((id) => {
            if (typeof id === "string") ids.add(id);
          });
      } else
        walk(source, (node) => {
          const parts = children(node);
          if (
            (node.kind === K.VariableDeclaration || node.kind === K.PropertyAssignment) &&
            ["id", "dimension"].includes(parts[0]?.getText(source) ?? "") &&
            parts.at(-1)?.kind === K.StringLiteral
          )
            ids.add(parts.at(-1)!.getText(source).slice(1, -1));
          if (
            node.kind === K.CallExpression &&
            ["rangeFinding", "rangeLeg", "skipped"].includes(parts[0]?.getText(source) ?? "") &&
            parts[1]?.kind === K.StringLiteral
          )
            ids.add(parts[1].getText(source).slice(1, -1));
        });
      const group = file.includes("plan-check")
        ? "plan:check"
        : file.includes("findings")
          ? "motion:check"
          : "film:measure";
      // Sensor: a // calibrated on comment attached to a constant used in the sensor's own function; provisional comments never establish calibration.
      const calibratedConstants = [...source.text.matchAll(/\/\/ calibrated on ([^\n]+)\n(?:export )?const (\w+)/g)];
      for (const id of [...ids].sort()) {
        const calibration: string[] = [];
        walk(source, (node) => {
          if (node.kind !== K.FunctionDeclaration) return;
          const body = node.getText(source);
          if (!new RegExp(`const id = ["']${id}["']`).test(body)) return;
          for (const match of calibratedConstants)
            if (new RegExp(`\\b${match[2]}\\b`).test(body) && !/\/\/ provisional/.test(body))
              calibration.push(match[1]!);
        });
        sensors.push({
          ...evidence(`${group}:${id}`, [
            { met: calibration.length > 0, source: `${file}: // calibrated on comment linked to the sensor` },
          ]),
          source: file,
          calibration,
        });
      }
    }
    const budgetSource = sources.get("tests/agents-md.test.ts")!;
    const reader = evaluator(budgetSource);
    const declaration = reader.declarations.get("SHRINKING");
    const budgets = declaration ? reader.value(declaration) : { unknown: ["SHRINKING declaration missing"] };
    unknown.push(...budgets.unknown.map((item) => `Instruction targets: ${item}`));
    const overTarget: Metrics["health"]["instructionFilesOverTarget"] = [];
    if (budgets.value && typeof budgets.value === "object" && !Array.isArray(budgets.value))
      for (const [file, value] of Object.entries(budgets.value)) {
        if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.target !== "number") {
          unknown.push(`Instruction target unknown: ${file}`);
          continue;
        }
        if (existsSync(path.join(root, file))) {
          const bytes = statSync(path.join(root, file)).size;
          if (bytes > value.target) overTarget.push({ file, bytes, target: value.target });
        }
      }
    return { sensors: sensors.sort((a, b) => a.id.localeCompare(b.id)), overTarget };
  });
  const endpointGroups = JSON.parse(readSource(root, "src/lib/models/endpoints.json")) as Record<string, string[]>;
  const snapshots = JSON.parse(readSource(root, "src/lib/providers/schemas/fal-operations.json")) as {
    endpoint: string;
  }[];
  const musicEndpoints = [
    ...readSource(root, "src/lib/providers/fal-music.ts").matchAll(/endpoint:\s*["']([^"']+)["']/g),
  ].map((match) => match[1]!);
  const endpoints = new Set([
    ...Object.values(endpointGroups).flat(),
    ...snapshots.map((row) => row.endpoint),
    ...musicEndpoints,
  ]);
  const corpusFile = "design-reference/library/_corpus.json";
  let referenceFilms: number | null = null;
  if (existsSync(path.join(root, corpusFile))) {
    const corpus = JSON.parse(readSource(root, corpusFile)) as { referenceIds?: string[]; references?: unknown[] };
    referenceFilms = corpus.references?.length ?? corpus.referenceIds?.length ?? null;
    if (referenceFilms === null) unknown.push(`${corpusFile}: no references or referenceIds array`);
  } else unknown.push(`${corpusFile} missing; reference film count unknown`);
  if (!usageFiles.length)
    unknown.push("No library:usage files supplied; block use is based on tracked playbooks only.");
  const verification = { blocks, providers, playbooks: books, sensors, commands };
  return {
    version: 1,
    raw: {
      playbooks: { total: playbooks.length, byStatus: counts(playbooks.map((book) => book.status)) },
      blocks: { total: catalogue.items.length, byCategory: counts(catalogue.items.map((item) => item.category)) },
      commands: {
        total: COMMAND_REGISTRY.length,
        bySection: counts(COMMAND_REGISTRY.map((command) => command.section)),
        bySpend: counts(COMMAND_REGISTRY.map((command) => command.paid)),
      },
      providers: providers.length,
      endpoints: endpoints.size,
      agents: filesUnder(root, ".agents/agents", /\.md$/).filter(
        (file) => path.posix.dirname(file) === ".agents/agents" && !file.endsWith("/README.md"),
      ).length,
      skills: filesUnder(root, ".agents/skills", /\/SKILL\.md$/).length,
      sensors: sensors.length,
      referenceFilms,
      techniqueCards: filesUnder(root, "design-reference/techniques", /\.md$/).filter(
        (file) => !/\/(?:AGENTS|README)\.md$/.test(file),
      ).length,
      templates: TEMPLATE_REGISTRY.length,
      tests: tests.length,
    },
    verified: Object.fromEntries(
      Object.entries(verification).map(([key, rows]) => [key, rows.filter((row) => row.verified).length]),
    ) as Metrics["verified"],
    evidence: verification,
    health: {
      testFiles: tests.length,
      instructionFilesOverTarget: overTarget,
      unknown: [
        "Test pass rate and suite duration are not measured by a static inventory.",
        "Lint/typecheck status, context measurements and GitHub review/slop statistics need separate evidence.",
      ],
    },
    sources: {
      blocks: [
        "docs/library/catalogue.json",
        "tests/*library*.test.ts",
        "tests/*determin*.test.ts",
        "playbooks/*/playbook.json:library.blocks",
      ],
      providers: ["src/lib/pricing.ts:PRICING provider prefixes", "src/lib/providers/", "tests/*.test.ts"],
      endpoints: [
        "src/lib/models/endpoints.json",
        "src/lib/providers/schemas/fal-operations.json",
        "src/lib/providers/fal-music.ts",
      ],
      sensors: [
        ...sensorFiles,
        "plan:check dimensions; film:measure legs including cut-sound; motion:check distinct counters (finding codes sharing a counter count once)",
      ],
      templates: ["src/lib/templates/registry.ts:TEMPLATE_REGISTRY"],
      instructionTargets: ["tests/agents-md.test.ts:SHRINKING (parsed statically)"],
      referenceFilms: [corpusFile],
    },
    unknown,
  };
}

/** Raw totals with their ready or verified share beside them, so the landing page neither inflates nor hides; format and key cells are constant. */
export function readmeTable(metrics: Metrics): string {
  const ready = metrics.raw.playbooks.byStatus.ready ?? 0;
  const cells = [
    [metrics.raw.playbooks.total, `genres<br>(${ready} ready)`],
    [metrics.raw.blocks.total, `motion-design<br>blocks (${metrics.verified.blocks} verified)`],
    [metrics.raw.agents, "crew agents<br>on set"],
    [3, "formats<br>9:16 · 1:1 · 16:9"],
    [0, "API keys needed<br>to render"],
  ];
  return `<table>\n  <tr>\n${cells.map(([count, label]) => `    <td align="center" width="20%"><h2>${count}</h2><sub>${label}</sub></td>`).join("\n")}\n  </tr>\n</table>`;
}
export function withReadmeMetrics(readme: string, metrics: Metrics): string {
  const start = "<!-- metrics:start -->";
  const end = "<!-- metrics:end -->";
  if (readme.split(start).length !== 2 || readme.split(end).length !== 2 || readme.indexOf(end) < readme.indexOf(start))
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "README must have one ordered metrics:start / metrics:end marker pair.",
    });
  return (
    readme.slice(0, readme.indexOf(start) + start.length) +
    "\n" +
    readmeTable(metrics) +
    "\n" +
    readme.slice(readme.indexOf(end))
  );
}
export function writeReadmeMetrics(root: string, metrics: Metrics): void {
  writeFileSync(path.join(root, "README.md"), withReadmeMetrics(readSource(root, "README.md"), metrics));
}
export function metricDeltas(before: unknown, after: unknown): Record<string, number> {
  const flatten = (value: unknown, prefix = ""): Record<string, number | null> => {
    if (typeof value === "number" || value === null) return { [prefix]: value };
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.assign(
      {},
      ...Object.entries(value).map(([key, item]) => flatten(item, prefix ? `${prefix}.${key}` : key)),
    );
  };
  const old = flatten(before);
  const current = flatten(after);
  return Object.fromEntries(
    [...new Set([...Object.keys(old), ...Object.keys(current)])]
      .sort()
      .filter(
        (key) =>
          key !== "version" && old[key] !== null && current[key] !== null && (old[key] ?? 0) !== (current[key] ?? 0),
      )
      .map((key) => [key, (current[key] ?? 0) - (old[key] ?? 0)]),
  );
}
