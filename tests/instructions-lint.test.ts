import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  instructionBaseline,
  lintInstructions,
  newInstructionFindings,
  type InstructionBaseline,
} from "../src/lib/context/lint";
import { repositoryText, type RepositoryText } from "../src/lib/context/repository";
import { temporaryRepository } from "./contrib-tools-helpers";

function fixture(files: Record<string, string>): RepositoryText {
  return {
    files: Object.keys(files).sort(),
    read: (file) => files[file],
    exists: (file) => file in files || Object.keys(files).some((name) => name.startsWith(`${file}/`)),
  };
}

const paragraph =
  "Keep every original media file intact and register its provenance before creating an edit for review.";

test("detects duplicates across and within files; ignores fences, command tables and pointers", () => {
  const findings = lintInstructions(
    fixture({
      "AGENTS.md": `${paragraph}\n\n${paragraph}`,
      "contrib/AGENTS.md": paragraph,
      "contrib/code.md": `\`\`\`md\n${paragraph}\n\`\`\`\n\n| ${paragraph} |\n\nRead [guide](../AGENTS.md).`,
    }),
  );
  assert.equal(findings.filter((item) => item.code === "duplicate").length, 2);
  assert.ok(!findings.some((item) => item.file === "contrib/code.md"));
});

test("reports every reference class, description caps and root area heuristic", () => {
  const findings = lintInstructions(
    fixture({
      "package.json": JSON.stringify({ scripts: { valid: "true" } }),
      "AGENTS.md":
        "Use `pnpm valid`, `pnpm install` and `pnpm absent`.\n\nRead `scripts/missing.ts` and [missing](docs/absent.md).\n\nUse the `missing-skill` skill and the `missing-agent` agent.\n\nEvery command in `scripts/worker.ts` must produce a result for this area's caller.\n\nRead [existing](docs/existing.md).",
      "scripts/worker.ts": "",
      "docs/existing.md": "",
      ".agents/skills/known/SKILL.md": `---\ndescription: ${"é".repeat(301)}\n---\n`,
      ".agents/agents/known.md": `---\ndescription: Short\n  ${"long ".repeat(121)}\n---\n`,
    }),
  );
  for (const code of ["dead-command", "dead-path", "dead-skill", "dead-agent", "description-cap", "root-level"])
    assert.ok(
      findings.some((item) => item.code === code),
      code,
    );
  assert.equal(findings.filter((item) => item.code === "dead-path").length, 2);
  assert.equal(findings.find((item) => item.code === "root-level")!.severity, "warn");
  assert.equal(findings.filter((item) => item.code === "dead-command").length, 1);
  assert.equal(findings.filter((item) => item.code === "description-cap").length, 2);
});

test("duplicate threshold uses 8-gram Jaccard and fingerprints survive line shifts", () => {
  const files = {
    "AGENTS.md": "Run `pnpm absent` to complete the work.",
    "contrib/AGENTS.md": `${paragraph} Extra.`,
    "contrib/card.md": paragraph,
  };
  const findings = lintInstructions(fixture(files));
  assert.ok(findings.some((item) => item.code === "duplicate"));
  const baseline = instructionBaseline(findings);
  const shifted = lintInstructions(fixture({ ...files, "AGENTS.md": `\n\n${files["AGENTS.md"]}` }));
  assert.deepEqual(newInstructionFindings(shifted, baseline), []);
  assert.ok(
    newInstructionFindings(lintInstructions(fixture({ ...files, "AGENTS.md": "Run `pnpm another-absent`." })), baseline)
      .length > 0,
  );
});

test("bare filenames resolve through tracked descendants, including directory table rows", () => {
  const findings = lintInstructions(
    fixture({
      "src/lib/AGENTS.md":
        "Read `fal-pricing.ts` and `batch.ts`.\n| Path | Role |\n|---|---|\n| `../workers/` | Runs `worker.ts` |\n| `scripts/native/` | Runs `native.ts` |\n| [workers](../workers/) | Runs `linked.ts` |",
      "src/lib/models/fal-pricing.ts": "",
      "src/lib/jobs/batch.ts": "",
      "src/workers/worker.ts": "",
      "src/workers/linked.ts": "",
      "scripts/native/native.ts": "",
    }),
  );
  assert.deepEqual(
    findings.filter((finding) => finding.code === "dead-path"),
    [],
  );
});

test("basename resolution preserves missing paths, links and directory scope", () => {
  const findings = lintInstructions(
    fixture({
      "src/lib/AGENTS.md":
        "Read `missing.ts`, `elsewhere.ts`, `./models/deleted.ts`, `./models/exact.ts` and [broken](exists.ts).\n| `../workers/` | Runs `absent.ts` |\n| `../workers/` | Runs `untracked.ts` |",
      "src/lib/models/exists.ts": "",
      "src/elsewhere/elsewhere.ts": "",
      "src/elsewhere/deleted.ts": "",
      "src/lib/models/exact.ts": "",
      "src/workers/other.ts": "",
    }),
  );
  assert.deepEqual(
    findings
      .filter((finding) => finding.code === "dead-path")
      .map((finding) => finding.message)
      .sort(),
    [
      "Missing repository path: missing.ts.",
      "Missing repository path: elsewhere.ts.",
      "Missing repository path: ./models/deleted.ts.",
      "Missing repository path: exists.ts.",
      "Missing repository path: absent.ts.",
      "Missing repository path: untracked.ts.",
    ].sort(),
  );
});

test("basename fallback ignores untracked descendants", () => {
  const repo = fixture({ "src/lib/AGENTS.md": "Read `untracked.ts`." });
  repo.exists = (file) => file === "src/lib/local/untracked.ts";
  assert.equal(lintInstructions(repo).filter((finding) => finding.code === "dead-path").length, 1);
});

test("real tracked tree passes its checked-in baseline", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const findings = lintInstructions(repositoryText(root));
  const baseline = JSON.parse(
    readFileSync(path.join(root, "contrib/instructions-baseline.json"), "utf8"),
  ) as InstructionBaseline;
  assert.deepEqual(newInstructionFindings(findings, baseline), []);
});

test("missing git-ignored generated paths are documented state; other missing paths still fail", () => {
  const repo = temporaryRepository();
  try {
    repo.write(".gitignore", "memory/**\n!memory/AGENTS.md\nout/\n");
    repo.write(
      "AGENTS.md",
      "Read [generated](memory/index.json), [output](out/report.json), [missing](docs/absent.md) and [instructions](memory/AGENTS.md).\n",
    );
    repo.git("add", ".gitignore", "AGENTS.md");
    const reader = repositoryText(repo.root);
    assert.equal(reader.exists("memory/index.json"), false);
    assert.equal(reader.ignored!("memory/index.json"), true);
    assert.equal(reader.ignored!("memory/AGENTS.md"), false);
    assert.equal(reader.ignored!("../outside"), false);
    const missing = lintInstructions(reader).filter((finding) => finding.code === "dead-path");
    assert.deepEqual(
      missing.map((finding) => finding.message),
      ["Missing repository path: docs/absent.md.", "Missing repository path: memory/AGENTS.md."],
    );
  } finally {
    repo.dispose();
  }
});

test("lint CLI has one JSON result for help and invalid arguments", () => {
  for (const [flag, status] of [
    ["--help", 0],
    ["--unknown", 1],
  ] as const) {
    const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/instructions-lint.ts", flag], {
      encoding: "utf8",
    });
    assert.equal(run.status, status, run.stdout + run.stderr);
    assert.equal(run.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(run.stdout).ok, status === 0);
  }
});

test("vendored descriptions are exempt from the cap declared in THIRD_PARTY.md", () => {
  const description = `---\ndescription: ${"x".repeat(601)}\n---\n`;
  const findings = lintInstructions(
    fixture({
      ".agents/skills/THIRD_PARTY.md": "| Skill | Upstream |\n|---|---|\n| `vendored` | upstream |\n",
      ".agents/skills/vendored/SKILL.md": description,
      ".agents/skills/owned/SKILL.md": description,
      ".agents/agents/owned.md": description,
    }),
  );
  assert.deepEqual(
    findings.filter((item) => item.code === "description-cap").map((item) => item.file),
    [".agents/agents/owned.md", ".agents/skills/owned/SKILL.md"],
  );
});
