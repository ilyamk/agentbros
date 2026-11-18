/** Fast half: entry-point links, skill links, documented aliases and the MCP scope contract. The CLI half (installed --help, workflow plans) is portable-craft-skills-cli.test.ts, in SLOW. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { COMMANDS } from "../src/mcp/catalog";
import { prepareCommand } from "../src/mcp/bridge";
import { documentedCommands, checkDocumentedFlags } from "./helpers/skill-contract";

const root = process.cwd();
const skills = [
  "creative-studio",
  "creative-strategy",
  "script-and-education",
  "recording-recut",
  "video-recipes",
  "editorial-storytelling",
  "motion-and-typography",
  "captions-and-localization",
  "harness-asset-import",
  "resource-discovery",
  "qa-and-delivery",
  "sound-design-and-mix",
  "model-and-asset-production",
  "blender-3d",
  "engine-selection",
  "reference-analysis",
  "reference-replica",
  "edit-research",
  "reference-preparation",
];
function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? markdownFiles(path.join(directory, e.name))
      : e.name.endsWith(".md")
        ? [path.join(directory, e.name)]
        : [],
  );
}

test("Codex and Claude compatibility entry points resolve exactly the same canonical definitions", () => {
  assert.match(readFileSync("CLAUDE.md", "utf8"), /^@AGENTS\.md$/m);
  for (const folder of ["agents", "skills"]) {
    assert.equal(realpathSync(`.claude/${folder}`), realpathSync(`.agents/${folder}`));
    for (const file of markdownFiles(`.agents/${folder}`)) {
      const portable = file.replace(".agents/", ".claude/");
      assert.equal(realpathSync(portable), realpathSync(file));
      assert.equal(readFileSync(portable, "utf8"), readFileSync(file, "utf8"));
    }
  }
});

test("canonical production skill links resolve and every documented command names a real alias", () => {
  const files = [
    ...markdownFiles(".agents/agents"),
    ...skills.flatMap((skill) => markdownFiles(`.agents/skills/${skill}`)),
  ];
  const commands = files.flatMap((file) => {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const link = match[1]!.split("#")[0]!;
      if (!link || /^(https?:|app:|mailto:)/.test(link)) continue;
      assert.ok(existsSync(path.resolve(path.dirname(file), link)), `${file}: ${link}`);
    }
    return documentedCommands(text, root);
  });
  assert.ok(commands.length >= 35, "Ensure command examples were actually inspected");
});

test("contract audit fails unknown aliases and unsupported command flags instead of executing instruction text", () => {
  assert.throws(() => documentedCommands("`pnpm nonexistent --project ID`", root), /Unknown script alias/);
  assert.throws(
    () =>
      checkDocumentedFlags(
        { script: "scripts/video-workflow.ts", flags: ["invent-review"], source: "bad example" },
        "--request FILE --action ACTION",
      ),
    /Unsupported/,
  );
});

test("portable MCP workflow contract rejects arbitrary execution, path escape and paid scope escalation", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "skill-scope-"));
  try {
    const options = { root: temporary, codeRoot: root, allowPaid: false };
    const workflow = COMMANDS.find((c) => c.name === "video_workflow")!;
    assert.throws(() =>
      prepareCommand(workflow, { scenario: "education", request: "input.json", executable: "/bin/sh" }, options),
    );
    assert.throws(
      () => prepareCommand(workflow, { scenario: "education", request: "../outside.json" }, options),
      /outside|escapes/i,
    );
    symlinkSync(tmpdir(), path.join(temporary, "escaped"));
    assert.throws(
      () => prepareCommand(workflow, { scenario: "education", request: "escaped/input.json" }, options),
      /outside|escapes/i,
    );
    assert.throws(
      () =>
        prepareCommand(
          workflow,
          { action: "create", scenario: "education", request: "input.json" },
          { ...options, projectScope: "fixed-project" },
        ),
      /disabled/i,
    );
    const paid = COMMANDS.find((c) => c.name === "align_captions")!;
    assert.throws(() => prepareCommand(paid, { project: "fixed-project" }, options), /disabled/i);
    const plan = prepareCommand(workflow, { scenario: "education", request: "input.json" }, options);
    assert.equal(plan.flags["scope-root"], realpathSync(temporary));
    assert.ok(!plan.argv.some((arg) => arg.includes("/bin/sh")));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
