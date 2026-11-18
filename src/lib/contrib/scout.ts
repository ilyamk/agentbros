import { createHash } from "node:crypto";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { SyntaxKind as K } from "typescript/unstable/ast";
import { children, walk } from "../api-surface/source";
import {
  CuratedOpportunitiesSchema,
  OpportunitySchema,
  TASK_HARNESSES,
  TASK_OS,
  TASK_TOOLS,
  type Opportunity,
} from "../../types/contrib-tools";
import { TIER_LIMITS, type TrustTier } from "../../types/contrib";
import type { Playbook } from "../../types/playbook";
import type { Catalogue } from "../library/catalogue";
import type { Metrics } from "../metrics";
import { lintInstructions, type InstructionBaseline, type InstructionFinding } from "../context/lint";
import type { RepositoryText } from "../context/repository";
import type { CommandEntry } from "../cli/commands";
import { runCommand, type CommandRunner } from "./check";
import { DEFAULT_CATEGORIES } from "./categories";

/** RFC 6.7 value order; adjacent categories differ by 100, size breaks ties. */
export const CATEGORY_WEIGHTS = Object.fromEntries(
  [
    "bench",
    "sensor",
    "library",
    "playbook",
    "provider",
    "command",
    "worker",
    "audio",
    "reference",
    "agent-skill",
    "instructions",
    "harness",
    "template",
    "asset",
    "test-ci",
    "lesson",
    "fix",
    "docs",
    "showcase",
    "security",
  ].map((id, index) => [id, (20 - index) * 100]),
);
/** Task-contract fields; scanners default to priority 0, no requirements and no verify commands. */
export type TaskFields = Partial<Pick<Opportunity, "source" | "priority" | "value" | "requires" | "read" | "verify">>;
/** The id hashes `category:key` only, so ids stay stable across the task contract (RFC 0002 §3.4). */
export function opportunity(
  key: string,
  category: string,
  size: Opportunity["size"],
  title: string,
  why: string,
  evidence: string[],
  definitionOfDone: string[],
  task: TaskFields = {},
): Opportunity {
  const { source = "scout:other", priority = 0, value, requires = { paid: false }, read = [], verify = [] } = task;
  return OpportunitySchema.parse({
    id: createHash("sha256").update(`${category}:${key}`).digest("hex").slice(0, 16),
    category,
    size,
    title,
    why,
    evidence,
    definitionOfDone,
    covering: [],
    source,
    priority,
    ...(value ? { value } : {}),
    requires,
    read,
    verify,
  });
}
const tagged = (source: string, rows: Opportunity[]): Opportunity[] => rows.map((row) => ({ ...row, source }));
export function scoutPlaybooks(books: Pick<Playbook, "id" | "status" | "benchmarks">[]): Opportunity[] {
  return tagged(
    "scout:playbooks",
    books.flatMap((book) => [
      ...(book.status === "draft"
        ? [
            opportunity(
              `draft:${book.id}`,
              "playbook",
              "M",
              `Bring ${book.id} to ready`,
              "This playbook is still a draft.",
              [`playbooks/${book.id}/playbook.json`],
              ["Meet the playbook readiness checks and add a match regression."],
            ),
          ]
        : []),
      ...(!book.benchmarks.length
        ? [
            opportunity(
              `bench:${book.id}`,
              "bench",
              "S",
              `Benchmark ${book.id}`,
              "The playbook has no benchmark task.",
              [`playbooks/${book.id}/playbook.json`],
              ["Add a frozen, checkable task and reference-run evidence; name it in benchmarks."],
            ),
          ]
        : []),
    ]),
  );
}
export function scoutProvisional(repo: RepositoryText): Opportunity[] {
  return tagged(
    "scout:provisional",
    repo.files
      .filter((file) => /^src\/lib\/(?:sensors|qa-evidence|film)\/.*\.ts$/.test(file))
      .flatMap((file) =>
        (repo.read(file) ?? "")
          .split("\n")
          .flatMap((line, index) =>
            /\/\/\s*provisional\b/i.test(line)
              ? [
                  opportunity(
                    `${file}:${line.trim()}`,
                    "sensor",
                    "M",
                    `Calibrate a provisional threshold in ${file}`,
                    line.trim().replace(/^\/\/\s*/, ""),
                    [`${file}:${index + 1}`],
                    ["Calibrate against degraded references, record the evidence and test the boundary."],
                  ),
                ]
              : [],
          ),
      ),
  );
}
export function scoutShrinking(rows: Metrics["health"]["instructionFilesOverTarget"]): Opportunity[] {
  return tagged(
    "scout:shrinking",
    rows.map((row) =>
      opportunity(
        row.file,
        "instructions",
        "S",
        `Shrink ${row.file}`,
        `${row.bytes} bytes exceeds the ${row.target}-byte target.`,
        [row.file, "tests/agents-md.test.ts:SHRINKING"],
        [
          "Reach the target without losing required guidance; remove its SHRINKING entry.",
          "Pass context and instruction checks.",
        ],
      ),
    ),
  );
}
const cleanCell = (cell: string) => cell.replace(/[*`]/g, "").trim();
/** Tables only: matrix Library=missing/weak/legacy; triage Class=BLOCK/MODE/HELPER, excluding explicit completed rows. */
export function scoutReferenceGaps(repo: RepositoryText): Opportunity[] {
  return tagged(
    "scout:reference-gaps",
    ["design-reference/reference-gap-matrix.md", "design-reference/gap-triage.md"].flatMap((file) => {
      let header: string[] = [];
      let section = "";
      return (repo.read(file) ?? "").split("\n").flatMap((line, index) => {
        if (/^#+ /.test(line)) section = line.replace(/^#+ /, "");
        if (!/^\s*\|/.test(line)) return [];
        const cells = line
          .trim()
          .slice(1)
          .replace(/\|$/, "")
          .split(/(?<!\\)\|/)
          .map(cleanCell);
        if (cells.includes("Library") || cells.includes("Class")) {
          header = cells;
          return [];
        }
        if (!header.length || cells.every((cell) => /^[-: ]*$/.test(cell))) return [];
        const status = cells[header.indexOf(file.endsWith("gap-triage.md") ? "Class" : "Library")] ?? "";
        if (
          file.endsWith("gap-triage.md")
            ? !/^(?:BLOCK|MODE|HELPER)$/.test(status)
            : !/\b(?:missing|weak|legacy)\b/i.test(status)
        )
          return [];
        if (cells.some((cell) => /^(?:done|closed|covered|implemented)$/i.test(cell))) return [];
        const title = cells[header.indexOf("Family")] ?? cells[header.indexOf("What happens")] ?? cells[1] ?? cells[0]!;
        return [
          opportunity(
            `${file}:${section}:${cells.join("|")}`,
            "library",
            "M",
            title,
            `Open reference gap: ${status}. Check current coverage before implementing.`,
            [`${file}:${index + 1}`],
            [
              "Confirm the gap remains open against the catalogue.",
              "Add or extend the justified block/helper, with a preview composition that renders from defaultProps, determinism tests and playbook use; never commit preview images (the maintainer renders them after merge).",
            ],
          ),
        ];
      });
    }),
  );
}
export function scoutLibrary(
  catalogue: Pick<Catalogue, "items">,
  books: Pick<Playbook, "library">[],
  repo: RepositoryText,
): Opportunity[] {
  const used = new Set(books.flatMap((book) => book.library.blocks));
  return tagged(
    "scout:library",
    catalogue.items.flatMap((item) => {
      const preview =
        Boolean(item.preview?.image && repo.exists(item.preview.image)) ||
        ["jpg", "png", "webp"].some((extension) => repo.exists(`docs/library/previews/${item.id}.${extension}`));
      if (preview && used.has(item.id)) return [];
      const why = [
        ...(!preview ? ["No preview sheet has been rendered yet."] : []),
        ...(!used.has(item.id) ? ["No playbook names it."] : []),
      ];
      /** F3 (RFC 0002): intake blocks images, so a contributor makes the preview renderable and the maintainer renders the sheet after merge. */
      const done = [
        ...(!preview
          ? [
              `Make every preview composition listed by pnpm library:list --id ${item.id} render from defaultProps (check it in pnpm studio); never commit preview images, the maintainer renders the sheet after merge.`,
            ]
          : []),
        ...(!used.has(item.id) ? ["Name the block in a playbook that needs it."] : []),
        "Regenerate the catalogue with pnpm library:catalogue.",
      ];
      return [
        opportunity(
          item.id,
          "library",
          "S",
          `Complete evidence for ${item.id}`,
          why.join(" "),
          ["docs/library/catalogue.json", item.importPath],
          done,
        ),
      ];
    }),
  );
}
const EVIDENCE_CAP = 10,
  COMMAND_CAP = 15;
const capped = (items: string[], cap: number) =>
  items.length > cap ? [...items.slice(0, cap), `… and ${items.length - cap} more`] : items;
/** One row per command section, so a contributor reviews a family of tools together. */
export function scoutCommands(
  registry: readonly Pick<CommandEntry, "alias" | "script" | "section">[],
  books: Pick<Playbook, "commands">[],
): Opportunity[] {
  const used = new Set(books.flatMap((book) => book.commands));
  const sections = new Map<string, string[]>();
  for (const command of registry)
    if (command.alias && !used.has(command.alias))
      sections.set(command.section, [...(sections.get(command.section) ?? []), command.alias]);
  return tagged(
    "scout:commands",
    [...sections].map(([section, aliases]) =>
      opportunity(
        `section:${section}`,
        "command",
        aliases.length > COMMAND_CAP ? "M" : "S",
        `Establish playbook use for ${aliases.length} ${section} ${aliases.length === 1 ? "command" : "commands"}`,
        `No playbook names these ${section} commands; assess for each whether a playbook step needs it or it should remain a development-only tool.`,
        [
          `pnpm commands --section ${section}`,
          ...capped(
            aliases.map((alias) => `pnpm ${alias}`),
            COMMAND_CAP,
          ),
        ],
        [
          "For each command, name it in the playbook step that needs it, or record why it stays development-only or should be retired.",
          "Pass the playbook checks.",
        ],
      ),
    ),
  );
}
export function scoutProviders(rows: Metrics["evidence"]["providers"]): Opportunity[] {
  return tagged(
    "scout:providers",
    rows
      .filter((row) => row.missing.includes("Pricing source and asOf date"))
      .map((row) =>
        opportunity(
          row.id,
          "provider",
          "S",
          `Source prices for ${row.id}`,
          "Metrics found no dated price source for this provider.",
          ["src/lib/pricing.ts", "pnpm metrics"],
          ["Add a dated primary price source and mock pricing/admission tests; preserve unknown-price bounds."],
        ),
      ),
  );
}
/** One row per file: findings in the same file are one review, and the file path keeps the id stable. */
export function scoutInstructionBaseline(repo: RepositoryText): Opportunity[] {
  const baseline = JSON.parse(
    repo.read("contrib/instructions-baseline.json") ?? '{"version":1,"fingerprints":[]}',
  ) as InstructionBaseline;
  const known = new Set(baseline.fingerprints);
  const files = new Map<string, InstructionFinding[]>();
  for (const row of lintInstructions(repo))
    if (known.has(row.fingerprint)) files.set(row.file, [...(files.get(row.file) ?? []), row]);
  return tagged(
    "scout:instruction-baseline",
    [...files].map(([file, rows]) => {
      const codes = [...new Set(rows.map((row) => row.code))].sort();
      return opportunity(
        `lint:${file}`,
        "instructions",
        rows.length <= EVIDENCE_CAP ? "S" : "M",
        `Resolve ${rows.length} instruction ${rows.length === 1 ? "finding" : "findings"} in ${file}`,
        `Baselined instruction-lint findings: ${codes.join(", ")}.`,
        [
          ...capped(
            rows.map((row) => `${file}:${row.line}`),
            EVIDENCE_CAP,
          ),
          "pnpm instructions:lint",
        ],
        [
          "Resolve each finding and remove its fingerprint from contrib/instructions-baseline.json.",
          "Pass instruction lint.",
        ],
      );
    }),
  );
}
/** Parse actual calls in an isolated virtual filesystem; never execute tests or resolve checkout imports. */
export function scoutSkippedTests(repo: RepositoryText): Opportunity[] {
  const files = repo.files.filter((file) => /^tests\/.*\.test\.tsx?$/.test(file));
  if (!files.length) return [];
  const root = "/contrib-scout";
  const virtual = Object.fromEntries(files.map((file) => [`${root}/${file}`, repo.read(file) ?? ""]));
  virtual[`${root}/tsconfig.json`] =
    '{"compilerOptions":{"noLib":true,"noResolve":true},"include":["tests/**/*.ts","tests/**/*.tsx"]}';
  const api = new API({ cwd: root, fs: createVirtualFileSystem(virtual) });
  try {
    const snapshot = api.updateSnapshot({ openFiles: files.map((file) => `${root}/${file}`) });
    return tagged(
      "scout:skipped-tests",
      files.flatMap((file) => {
        const source = snapshot
          .getProjects()
          .map((project) => project.program.getSourceFile(`${root}/${file}`))
          .find(Boolean);
        if (!source) throw new Error(`Cannot parse skipped tests: ${file}`);
        const skipped: { line: string; title: string }[] = [];
        walk(source, (node) => {
          if (node.kind !== K.CallExpression) return;
          const [callee, title, options] = children(node);
          if (!callee || !title || !/^(?:test|it|describe)(?:\.skip)?$/.test(callee.getText(source))) return;
          const explicit = callee.getText(source).endsWith(".skip");
          const isSkipped =
            explicit ||
            (options?.kind === K.ObjectLiteralExpression &&
              children(options).some((property) => {
                if (property.kind !== K.PropertyAssignment) return false;
                const [name, value] = children(property);
                return (
                  name?.getText(source).replace(/^["']|["']$/g, "") === "skip" &&
                  value &&
                  !["false", "null", "undefined", "0", "''", '\"\"'].includes(value.getText(source))
                );
              }));
          if (!isSkipped) return;
          skipped.push({
            line: `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`,
            title: title.getText(source),
          });
        });
        return skipped.length
          ? [
              opportunity(
                `skip:${file}`,
                "test-ci",
                skipped.length <= EVIDENCE_CAP ? "S" : "M",
                `Review ${skipped.length} skipped ${skipped.length === 1 ? "test" : "tests"} in ${file}`,
                `Skipped: ${capped(
                  skipped.map((item) => item.title),
                  EVIDENCE_CAP,
                ).join(", ")}. A skipped test may hide a missing contract; retain justified environment gates.`,
                capped(
                  skipped.map((item) => item.line),
                  EVIDENCE_CAP,
                ),
                [
                  "Determine why each test is skipped; add a deterministic fixture, or document and verify the required environment.",
                ],
              ),
            ]
          : [];
      }),
    );
  } finally {
    api.close();
  }
}
/** Flat `key: value` front-matter as technique cards write it; values starting with `"` or `[` are JSON. Undefined without a block. */
function frontMatter(text: string): Record<string, unknown> | undefined {
  const block = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!block) return undefined;
  const fields: Record<string, unknown> = {};
  for (const line of block[1]!.split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const value = line.slice(colon + 1).trim();
    try {
      fields[line.slice(0, colon).trim()] = /^["[]/.test(value) ? (JSON.parse(value) as unknown) : value;
    } catch {
      fields[line.slice(0, colon).trim()] = value;
    }
  }
  return fields;
}
/** Draft technique cards (edit-research step 1): draft until a lab composition demonstrates it or two references confirm it. */
export function scoutTechniques(repo: RepositoryText): Opportunity[] {
  return tagged(
    "scout:techniques",
    repo.files
      .filter((file) => /^design-reference\/techniques\/[^/]+\.md$/.test(file) && !/\/README\.md$/i.test(file))
      .sort()
      .flatMap((file) => {
        const card = frontMatter(repo.read(file) ?? "");
        if (!card || typeof card.id !== "string" || typeof card.name !== "string" || card.status !== "draft") return [];
        const demo = typeof card.demo === "string" && card.demo ? card.demo : undefined;
        return [
          opportunity(
            `technique:${card.id}`,
            "library",
            demo ? "S" : "M",
            `Demonstrate the ${card.name} technique`,
            `Technique card ${card.id} (route ${typeof card.route === "string" ? card.route : "unknown"}) is still a draft${demo ? `; ${demo} implements it but no lab composition demonstrates it yet` : " with no implementing block"}.`,
            [file, ...(demo ? [demo] : [])],
            [
              ...(demo
                ? []
                : [
                    "Build the block by the library contract (src/motion/library/AGENTS.md), with inspiredBy citing each reference span.",
                  ]),
              "Demonstrate it in a lab composition (src/motion/lab/Root.tsx) and compare it with the reference spans using pnpm motion:strip.",
              "Set status to demonstrated, or to confirmed when two or more references' techniques.json link it by techniqueCardId and are cited in sources; pass tests/technique-cards.test.ts.",
              "Regenerate the catalogue with pnpm library:catalogue and name the block in a playbook that needs it.",
            ],
          ),
        ];
      }),
  );
}
type TableRow = { line: number; section: string; cell: (name: string) => string | undefined };
/** Markdown table rows with cells located by header name; a header is the row above a `---` separator. */
function tableRows(text: string): TableRow[] {
  const lines = text.split("\n"),
    rows: TableRow[] = [];
  const split = (line: string) =>
    line
      .trim()
      .slice(1)
      .replace(/\|$/, "")
      .split(/(?<!\\)\|/)
      .map(cleanCell);
  let header: string[] = [],
    section = "";
  lines.forEach((line, index) => {
    if (/^#+ /.test(line)) {
      section = line.replace(/^#+ /, "").trim();
      header = [];
      return;
    }
    if (!/^\s*\|/.test(line)) {
      header = [];
      return;
    }
    const cells = split(line);
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) return;
    if (!header.length && /^\s*\|[-:| ]+\|\s*$/.test(lines[index + 1] ?? "")) {
      header = cells;
      return;
    }
    if (!header.length) return;
    const names = header;
    rows.push({
      line: index + 1,
      section,
      cell: (name) => (names.includes(name) ? cells[names.indexOf(name)] : undefined),
    });
  });
  return rows;
}
const SLOP = "design-reference/slop-catalogue.md";
/** Slop catalogue tables: provisional thresholds to calibrate; 3D signatures only the critic judges, to make measurable. */
export function scoutSlop(repo: RepositoryText): Opportunity[] {
  return tagged(
    "scout:slop",
    tableRows(repo.read(SLOP) ?? "").flatMap((row) => {
      const signature = row.cell("Signature");
      if (!signature) return [];
      const source = row.cell("Source"),
        sensor = row.cell("Sensor, code") ?? row.cell("Sensor");
      if (source !== undefined)
        return /^provisional$/i.test(source)
          ? [
              opportunity(
                `slop:${signature}`,
                "sensor",
                "M",
                `Calibrate the "${signature}" threshold`,
                `Its ${sensor ?? "sensor"} threshold is a hand-set provisional starting point: ${row.cell("Threshold") ?? "see the catalogue"}.`,
                [`${SLOP}:${row.line}`, "design-reference/calibration.md"],
                [
                  "Run pnpm judge:calibrate against reference copies degraded for this signature and set the threshold from the result.",
                  "Record the numbers in design-reference/calibration.md and change the Source cell to calibrated.",
                  "Test the threshold boundary on both sides.",
                ],
              ),
            ]
          : [];
      if (
        /^3D slop/i.test(row.section) &&
        sensor &&
        /^critic\b/i.test(sensor) &&
        !/[:.]/.test(sensor.split(";")[0]!.replace(/^critic\b/i, ""))
      )
        return [
          opportunity(
            `slop3d:${signature}`,
            "sensor",
            "M",
            `Make "${signature}" measurable`,
            `Only the critic judges this 3D signature today (${sensor}).`,
            [`${SLOP}:${row.line}`],
            [
              "Add a deterministic reading (film:measure leg, stage.report field or motion:check code) that detects the signature from frames or the scene.",
              "Calibrate it with pnpm judge:calibrate against a degraded copy and record it in design-reference/calibration.md.",
              "Name the sensor in the catalogue row and test the boundary.",
            ],
          ),
        ];
      return [];
    }),
  );
}
const CURATED = "contrib/opportunities.json";
/** Maintainer-curated rows; a malformed file fails closed rather than silently dropping work. */
export function scoutCurated(repo: RepositoryText): Opportunity[] {
  const text = repo.read(CURATED);
  if (text === undefined) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`${CURATED} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = CuratedOpportunitiesSchema.safeParse(data);
  if (!parsed.success)
    throw new Error(
      `${CURATED} is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`,
    );
  const known = new Set(DEFAULT_CATEGORIES.categories.map((category) => category.id));
  const unknown = parsed.data.opportunities.filter((row) => !known.has(row.category));
  if (unknown.length)
    throw new Error(
      `${CURATED} is invalid: unknown category ${unknown.map((row) => `${row.category} (key ${row.key})`).join(", ")}`,
    );
  return parsed.data.opportunities.map((row) =>
    opportunity(`curated:${row.key}`, row.category, row.size, row.title, row.why, row.evidence, row.definitionOfDone, {
      source: "curated",
      priority: row.priority ?? (row.verify?.length ? 2 : 1),
      value: row.value,
      requires: row.requires ?? { paid: false },
      read: row.read ?? [],
      verify: row.verify ?? [],
    }),
  );
}
/** Score = 1000·priority + category weight + size bonus; priority sorts first, so curated rows (priority ≥ 1) always lead scouted rows (0), and tier 0's S-first preference applies within a priority. */
export function rankOpportunities(rows: Opportunity[], tier?: TrustTier): Opportunity[] {
  const limits = tier === undefined ? undefined : TIER_LIMITS[tier];
  const size = { S: 3, M: 2, L: 1 };
  const score = (row: Opportunity) => 1000 * row.priority + (CATEGORY_WEIGHTS[row.category] ?? 0) + size[row.size];
  return [...new Map(rows.map((row) => [row.id, row])).values()]
    .filter((row) => !limits || (limits.sizes.includes(row.size) && !limits.forbiddenCategories.includes(row.category)))
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        (tier === 0 ? size[b.size] - size[a.size] : 0) ||
        score(b) - score(a) ||
        a.id.localeCompare(b.id),
    );
}
/** `--can` capabilities: what the contributor's machine and harness provide. */
export const CAPABILITIES = [...TASK_OS, "gpu", ...TASK_TOOLS, ...TASK_HARNESSES, "signing-key"] as const;
export type Capability = (typeof CAPABILITIES)[number];
export function parseCapabilities(text: string): Set<Capability> {
  const caps = text
    .split(",")
    .map((cap) => cap.trim().toLowerCase())
    .filter(Boolean);
  const unknown = caps.filter((cap) => !(CAPABILITIES as readonly string[]).includes(cap));
  if (unknown.length) throw new Error(`Unknown capability ${unknown.join(", ")}; use ${CAPABILITIES.join(", ")}`);
  return new Set(caps as Capability[]);
}
/** OS and harness lists need any one; tools need all; gpu and signingKey only when true. designApproval is a process gate, not a capability, so it never filters. */
export function meetsRequirements(row: Pick<Opportunity, "requires">, caps: ReadonlySet<Capability>): boolean {
  const { os, gpu, tools, harnessSession, signingKey } = row.requires;
  return (
    (!os || os.some((item) => caps.has(item))) &&
    (!gpu || caps.has("gpu")) &&
    (tools ?? []).every((tool) => caps.has(tool)) &&
    (!harnessSession || harnessSession.some((item) => caps.has(item))) &&
    (!signingKey || caps.has("signing-key"))
  );
}
export interface GithubIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: { name: string }[];
}
export interface GithubPr {
  number: number;
  title: string;
  body: string;
  url: string;
  files: { path: string }[];
}
export function onlineScout(
  rows: Opportunity[],
  root: string,
  runner: CommandRunner = runCommand,
): { opportunities: Opportunity[]; dropped: Opportunity[]; warning?: string } {
  const run = (args: string[]) => runner(["gh", ...args], root);
  if (run(["--version"]).exitCode || run(["auth", "status"]).exitCode)
    return {
      opportunities: rows,
      dropped: [],
      warning: "gh is unavailable or unauthenticated; offline results retained.",
    };
  const issuesResult = run([
    "issue",
    "list",
    "--state",
    "open",
    "--limit",
    "1000",
    "--json",
    "number,title,body,url,labels",
  ]);
  const prsResult = run(["pr", "list", "--state", "open", "--limit", "1000", "--json", "number,title,body,url,files"]);
  if (issuesResult.exitCode || prsResult.exitCode)
    return { opportunities: rows, dropped: [], warning: "GitHub query failed; offline results retained." };
  const issues = JSON.parse(issuesResult.stdout) as GithubIssue[],
    prs = JSON.parse(prsResult.stdout) as GithubPr[];
  const ready = issues
    .filter((issue) => issue.labels.some((label) => label.name === "agent-ready"))
    .map((issue) => ({
      ...opportunity(
        `issue:${issue.number}`,
        issue.labels.find((label) => label.name.startsWith("category:"))?.name.slice(9) ?? "fix",
        (["S", "M", "L"].find((size) => issue.labels.some((label) => label.name === `size:${size}`)) ??
          "S") as Opportunity["size"],
        issue.title,
        "Open agent-ready issue.",
        [issue.url],
        ["Meet the issue's acceptance criteria and category gates."],
        { source: "issue" },
      ),
      covering: [issue.url],
    }));
  const dropped: Opportunity[] = [];
  const opportunities = [...rows, ...ready].flatMap((row) => {
    const aggregates = new Set([
      "docs/library/catalogue.json",
      "src/lib/pricing.ts",
      "design-reference/reference-gap-matrix.md",
      "design-reference/gap-triage.md",
      "tests/agents-md.test.ts:SHRINKING",
      SLOP,
      "design-reference/calibration.md",
    ]);
    const pointers = row.evidence
      .filter((pointer) => !pointer.startsWith("pnpm ") && !pointer.startsWith("… "))
      .map((pointer) => pointer.replace(/:\d+$/, ""))
      .filter((pointer) => !aggregates.has(pointer));
    const mentions = (item: { body: string; title: string; url: string }) =>
      row.covering.includes(item.url) ||
      item.body.includes(row.id) ||
      item.title === row.title ||
      pointers.some((pointer) => item.body.includes(pointer));
    const coveringIssues = issues.filter(mentions);
    const coveringPrs = prs.filter(
      (pr) =>
        mentions(pr) ||
        pr.files.some((file) =>
          pointers.some((pointer) =>
            [pointer, `${pointer}.ts`, `${pointer}.tsx`, `${pointer}/index.ts`, `${pointer}/index.tsx`].includes(
              file.path,
            ),
          ),
        ),
    );
    const result = {
      ...row,
      covering: [
        ...new Set([...row.covering, ...coveringIssues.map((issue) => issue.url), ...coveringPrs.map((pr) => pr.url)]),
      ],
    };
    if (coveringPrs.length || coveringIssues.some((issue) => issue.labels.some((label) => label.name === "claimed"))) {
      dropped.push(result);
      return [];
    }
    return [result];
  });
  return { opportunities, dropped };
}
export function needsMarkdown(rows: Opportunity[]): string {
  return (
    "# Contribution needs\n\n" +
    rows
      .map(
        (row) =>
          `## ${row.title.replace(/[\r\n]/g, " ")}\n\n${row.id} · ${row.category} · ${row.size}\n\n${row.why}\n\nEvidence: ${row.evidence.join(", ")}\n\nDone: ${row.definitionOfDone.join(" ")}\n\nCovering: ${row.covering.join(", ") || "none"}\n`,
      )
      .join("\n")
  );
}
