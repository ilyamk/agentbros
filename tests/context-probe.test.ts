import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { probeAnswer, probeCanaries, probeInvocation, probeMarkdown } from "../src/lib/context/probe";
import { ContextProbeRecordSchema } from "../src/types/context-probe";

const root = path.resolve(import.meta.dirname, "..");
const loader = createRequire(import.meta.url).resolve("tsx");
const fake = path.join(root, "tests/fixtures/context-probe/harness.cjs");

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "probe-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: "pipe" });
  git("init", "-q");
  writeFileSync(path.join(directory, "AGENTS.md"), "Root instructions\n");
  writeFileSync(path.join(directory, "CLAUDE.md"), "@AGENTS.md\n");
  mkdirSync(path.join(directory, "docs"));
  writeFileSync(path.join(directory, "docs/context-loading.md"), "# Context loading\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture");
  const log = path.join(directory, "invocations.jsonl");
  const invoke = (harness: string, flags: string[] = [], mode = "") => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        loader,
        path.join(root, "scripts/context-probe.ts"),
        "--harness",
        harness,
        "--seed",
        "test-seed",
        ...flags,
      ],
      {
        cwd: directory,
        encoding: "utf8",
        env: {
          AGENTBROS_NO_DOTENV: "1",
          PATH: process.env.PATH,
          CLAUDECODE: "nested-session-guard",
          CONTEXT_PROBE_HARNESS_BIN: fake,
          PROBE_TEST_MODE: mode,
          PROBE_TEST_LOG: log,
        },
      },
    );
    assert.equal(result.stdout.trim().split("\n").length, 1, result.stdout + result.stderr);
    return { ...result, json: JSON.parse(result.stdout) };
  };
  return { directory, git, invoke, log };
}

test("seeded canaries are distinct, repeatable and absent from invocation prompts", () => {
  const canaries = probeCanaries("one");
  assert.deepEqual(canaries, probeCanaries("one"));
  assert.notDeepEqual(canaries, probeCanaries("two"));
  assert.equal(new Set(Object.values(canaries)).size, 5);
  for (const harness of ["claude-code", "codex"] as const)
    for (const subagent of [false, true]) {
      const args = probeInvocation(harness, subagent);
      for (const token of Object.values(canaries)) assert.ok(!args.join(" ").includes(token));
      if (harness === "codex") assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
      else assert.equal(args[args.indexOf("--tools") + 1], subagent ? "Agent,Task" : "");
    }
});

test("dry-run prints the plan without invoking a binary or writing files", (t) => {
  const f = fixture(t);
  const result = f.invoke("codex", ["--dry-run"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.json.metadata.dryRun, true);
  assert.equal(result.json.metadata.subagent, "n/a");
  assert.equal(existsSync(f.log), false);
  assert.equal(existsSync(path.join(f.directory, "out")), false);
  assert.equal(f.git("status", "--porcelain"), "");
});

for (const harness of ["claude-code", "codex"] as const)
  test(`${harness}: real worktree with fake harness writes dated evidence and cleans up`, (t) => {
    const f = fixture(t);
    const result = f.invoke(harness);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const record = ContextProbeRecordSchema.parse(result.json.metadata.record);
    assert.equal(record.harnessVersion, "fake-harness 1.0");
    assert.equal(record.commit, f.git("rev-parse", "HEAD").trim());
    assert.equal(record.seed, "test-seed");
    assert.deepEqual(record.parent.known, ["root", "skillDescription"]);
    if (harness === "claude-code") assert.deepEqual(record.subagent.known, ["root", "agent"]);
    else assert.equal(record.subagent.status, "n/a");
    assert.equal(readFileSync(path.join(f.directory, "AGENTS.md"), "utf8"), "Root instructions\n");
    assert.equal(f.git("diff", "--", "AGENTS.md", "CLAUDE.md"), "");
    const guide = readFileSync(path.join(f.directory, "docs/context-loading.md"), "utf8");
    assert.ok(guide.startsWith("# Context loading\n"));
    assert.ok(guide.includes(probeMarkdown(record)));
    const records = readdirSync(path.join(f.directory, "out/context/probes"));
    assert.equal(records.length, 1);
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(f.directory, "out/context/probes", records[0]!), "utf8")),
      record,
    );
    const calls = readFileSync(f.log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { cwd: string; args: string[] });
    const runs = calls.filter((call) => !call.args.includes("--help") && !call.args.includes("--version"));
    assert.equal(runs.length, harness === "codex" ? 1 : 2);
    for (const call of runs) assert.equal(existsSync(call.cwd), false, "temporary checkout removed");
    assert.equal(f.git("worktree", "list", "--porcelain").match(/^worktree /gm)!.length, 1);
  });

test("failed harness calls still record their status and clean the worktree", (t) => {
  const f = fixture(t);
  const result = f.invoke("claude-code", [], "fail");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.json.details.record.parent.status, "failed");
  assert.equal(result.json.details.record.subagent.status, "failed");
  assert.deepEqual(result.json.details.record.parent.known, []);
  assert.equal(f.git("worktree", "list", "--porcelain").match(/^worktree /gm)!.length, 1);
});

for (const mode of ["no-child", "wrong-child", "contaminated", "background"])
  test(`${mode}: unconfirmed or contaminated child results remain inconclusive`, (t) => {
    const result = fixture(t).invoke("claude-code", [], mode);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.json.metadata.record.subagent.status, "inconclusive");
    assert.deepEqual(result.json.metadata.record.subagent.known, []);
  });

test("help checks and invalid inputs fail before creating a worktree", (t) => {
  const f = fixture(t);
  for (const [harness, flags, mode] of [
    ["codex", [], "bad-help"],
    ["unknown", [], ""],
    ["codex", ["--unknown"], ""],
  ] as const) {
    const result = f.invoke(harness, [...flags], mode);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.json.ok, false);
    assert.equal(existsSync(path.join(f.directory, "out")), false);
  }
  const help = f.invoke("codex", ["--help"]);
  assert.equal(help.status, 0);
  assert.equal(help.json.ok, true);
});

test("answer extraction ignores command text, malformed progress and parent summaries", () => {
  assert.equal(
    probeAnswer(
      "codex",
      'null\n[]\nprogress\n{"type":"item.completed","item":{"type":"command_execution","text":"bad"}}',
      false,
    ),
    undefined,
  );
  assert.equal(probeAnswer("claude-code", '{"type":"result","result":"invented child"}', true), undefined);
  assert.equal(
    probeAnswer("claude-code", '{"type":"result","is_error":true,"result":"not an answer"}', false),
    undefined,
  );
  assert.equal(
    probeAnswer(
      "claude-code",
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}\n{"type":"result","result":"contaminated"}',
      false,
    ),
    undefined,
  );
  assert.equal(
    probeAnswer(
      "codex",
      '{"type":"item.completed","item":{"type":"command_execution"}}\n{"type":"item.completed","item":{"type":"agent_message","text":"contaminated"}}',
      false,
    ),
    undefined,
  );
});

for (const directory of [".agents", ".claude", "src"])
  test(`${directory}: an escaping directory symlink is rejected without changing its target`, (t) => {
    const f = fixture(t);
    const outside = mkdtempSync(path.join(tmpdir(), "probe-outside-"));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(path.join(outside, "settings.json"), "untouched");
    symlinkSync(outside, path.join(f.directory, directory), "dir");
    f.git("add", directory);
    f.git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "symlink fixture");
    const result = f.invoke("claude-code");
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.json.error, "VALIDATION");
    assert.deepEqual(readdirSync(outside), ["settings.json"]);
    assert.equal(readFileSync(path.join(outside, "settings.json"), "utf8"), "untouched");
    assert.equal(f.git("worktree", "list", "--porcelain").match(/^worktree /gm)!.length, 1);
  });
