import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { descriptionOf, isAgent, isSkill } from "../src/lib/context/repository";

const KIB = 1024;
/** One rule, documented in tests/AGENTS.md#agentsmd-size-budgets: root 15 KiB (Codex auto-loads up to 32 KiB), the four areas 24 KiB, every other AGENTS.md (sub-areas, playbooks) 12 KiB. */
const ROOT_LIMIT_BYTES = 15 * KIB;
const AREAS = new Set(["scripts/AGENTS.md", "src/lib/AGENTS.md", "src/motion/AGENTS.md", "src/templates/AGENTS.md"]);
const AREA_LIMIT_BYTES = 24 * KIB;
const SUB_AREA_LIMIT_BYTES = 12 * KIB;
/** Files over their budget: held at their size rounded up to a KiB so they cannot grow. Remove an entry once the file meets its target. */
const SHRINKING: Record<string, { limit: number; target: number }> = {};

const indexed = () =>
  [...readFileSync("AGENTS.md", "utf8").matchAll(/\]\(([^)]+\/AGENTS\.md)\)/g)].map((match) => match[1]!);

test("CLAUDE.md only imports AGENTS.md, which stays the single source", () => {
  const claude = readFileSync("CLAUDE.md", "utf8");
  assert.match(claude, /^@AGENTS\.md$/m);
  assert.ok(statSync("CLAUDE.md").size < 512, "CLAUDE.md must stay a tiny import");
  for (const file of ["CLAUDE.local.md", ".claude/CLAUDE.md"]) assert.equal(existsSync(file), false, file);
  assert.match(
    readFileSync("AGENTS.md", "utf8"),
    /Run Codex and Claude Code from the repository root/,
    "the 32 KiB Codex cap covers only the root file when agents start at the root",
  );
  assert.ok(
    statSync("AGENTS.md").size <= ROOT_LIMIT_BYTES,
    `root AGENTS.md is ${statSync("AGENTS.md").size} bytes, budget ${ROOT_LIMIT_BYTES}`,
  );
});

test("every indexed AGENTS.md exists and carries a last-updated date", () => {
  const files = indexed();
  assert.ok(files.length >= 7);
  for (const file of ["AGENTS.md", ...files]) {
    assert.match(readFileSync(file, "utf8"), /^Last updated: \d{4}-\d{2}-\d{2}$/m, file);
  }
});

test("relative links in every AGENTS.md resolve", () => {
  for (const file of ["AGENTS.md", ...indexed()]) {
    for (const match of readFileSync(file, "utf8").matchAll(/\]\(([^)]+)\)/g)) {
      const link = match[1]!.split("#")[0]!;
      if (!link || /^https?:/.test(link)) continue;
      assert.ok(existsSync(path.resolve(path.dirname(file), link)), `${file}: ${link}`);
    }
  }
});

test("docs/architecture.md is dated, linked from the root and its links resolve", () => {
  const file = "docs/architecture.md";
  const text = readFileSync(file, "utf8");
  assert.match(text, /^Last updated: \d{4}-\d{2}-\d{2}$/m, file);
  assert.match(
    readFileSync("AGENTS.md", "utf8"),
    /\]\(docs\/architecture\.md\)/,
    "root AGENTS.md links the architecture page",
  );
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const link = match[1]!.split("#")[0]!;
    if (!link || /^https?:/.test(link)) continue;
    assert.ok(existsSync(path.resolve(path.dirname(file), link)), `${file}: ${link}`);
  }
  for (const area of allAgentsFiles().filter((f) =>
    /^(src\/[^/]+|scripts|playbooks|tests|memory|contrib)\/AGENTS\.md$/.test(f),
  )) {
    assert.ok(text.includes(`../${area}`), `${file} maps ${area}`);
  }
});

const allAgentsFiles = () =>
  execFileSync("git", ["ls-files", "*AGENTS.md"], { encoding: "utf8" })
    .split("\n")
    .filter((file) => file && existsSync(file) && !file.startsWith(".agents/"));

test("every AGENTS.md stays within its size budget", () => {
  const files = allAgentsFiles();
  assert.ok(files.length >= 10);
  for (const file of files.filter((file) => file !== "AGENTS.md")) {
    const size = statSync(file).size;
    const limit = SHRINKING[file]?.limit ?? (AREAS.has(file) ? AREA_LIMIT_BYTES : SUB_AREA_LIMIT_BYTES);
    assert.ok(size <= limit, `${file} is ${size} bytes, budget ${limit}${AREAS.has(file) ? " (area)" : " (sub-area)"}`);
  }
});

test("a shrinking file leaves the exception list once it meets its target", () => {
  for (const [file, { limit, target }] of Object.entries(SHRINKING)) {
    assert.ok(limit > target, file);
    assert.ok(statSync(file).size > target, `${file} meets its ${target}-byte target: remove it from SHRINKING`);
  }
});

test("first-party skill and agent descriptions stay within 600 UTF-8 bytes", () => {
  const thirdParty = new Set(
    [...readFileSync(".agents/skills/THIRD_PARTY.md", "utf8").matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]!),
  );
  assert.ok(thirdParty.size > 0, "vendored exclusions must be read from THIRD_PARTY.md");
  const files = execFileSync("git", ["ls-files", "-z", ".agents/"], { encoding: "utf8" })
    .split("\0")
    .filter((file) => (isAgent(file) || isSkill(file)) && existsSync(file));
  assert.ok(files.length > 0);
  for (const file of files) {
    if (isSkill(file) && thirdParty.has(file.split("/")[2]!)) continue;
    const size = Buffer.byteLength(descriptionOf(readFileSync(file, "utf8")));
    assert.ok(size <= 600, `${file}: description is ${size} bytes, cap 600`);
  }
});
