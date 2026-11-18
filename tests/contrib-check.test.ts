import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { checkContribution, structuralIntake, gateTimeoutMs, runGate } from "../src/lib/contrib/check";
import { COMMON_GATES, contributionGates } from "../src/lib/contrib/gates";
import { parsePrBlock } from "../src/lib/contrib/pr-block";
import { draftContributionPr } from "../src/lib/contrib/pr";
import { DEFAULT_CATEGORIES } from "../src/lib/contrib/categories";
import { changeText, temporaryRepository } from "./contrib-tools-helpers";

test("shared gate plan orders intake, category gates, then the common CI list", () => {
  const gates = contributionGates(["library"], "abc", "pr.md", "context.json");
  assert.equal(gates[0]!.name, "contrib:intake");
  assert.ok(gates[0]!.command.includes("--body"));
  assert.deepEqual(
    gates.slice(-COMMON_GATES.length).map((gate) => gate.name),
    COMMON_GATES.map((gate) => gate.name),
  );
  assert.deepEqual(
    gates.slice(1, -COMMON_GATES.length).map((gate) => gate.command.slice(0, 2).join(" ")),
    DEFAULT_CATEGORIES.categories.find((category) => category.id === "library")!.gates,
  );
  assert.deepEqual(gates.find((gate) => gate.name === "leak:check")!.command, [
    "pnpm",
    "leak:check",
    "--mode",
    "diff",
    "--base",
    "abc",
  ]);
});
test("structural intake reuses entry, category, media and dependency checks without body/accountability", () => {
  const entry = {
    path: ".changes/repair.md",
    status: "A",
    additions: 8,
    deletions: 0,
    binary: false,
    content: changeText(),
  };
  assert.deepEqual(structuralIntake([entry]).findings, []);
  assert.ok(structuralIntake([{ ...entry, content: "invalid" }]).findings.some((row) => row.rule === "change-entry"));
  assert.ok(
    structuralIntake([
      entry,
      { path: "docs/image.mp4", status: "A", additions: 0, deletions: 0, binary: true },
    ]).findings.some((row) => row.rule === "media-binary"),
  );
  assert.ok(
    structuralIntake(
      [
        { ...entry, content: changeText("fix") },
        {
          path: "package.json",
          status: "M",
          additions: 1,
          deletions: 1,
          binary: false,
          previousContent: "{}",
          content: '{"dependencies":{"new":"1"}}',
        },
      ],
      ["design-approved"],
    ).findings.some((row) => row.rule === "dependency-justification"),
  );
});
test("check records each result and continues after failure, supports only/skip and committed diff paths", async () => {
  const repo = temporaryRepository();
  try {
    const commands: string[][] = [];
    const evidence = await checkContribution({ root: repo.root }, (command) => {
      commands.push(command);
      return {
        exitCode: command[1] === "lint" ? 1 : 0,
        stdout: JSON.stringify({ ok: command[1] !== "lint" }),
        stderr: "",
      };
    });
    assert.equal(evidence.base, repo.base);
    assert.ok(evidence.categories.includes("docs"));
    assert.equal(evidence.gates[0]!.exitCode, 0);
    assert.ok(evidence.notVerified.some((item) => item.includes("CLA")));
    assert.equal(commands.at(-1)![1], "api:surface");
    assert.ok(evidence.gates.some((gate) => gate.exitCode === 1));
    assert.deepEqual(JSON.parse(readFileSync(path.join(repo.root, ".contrib/evidence.json"), "utf8")), evidence);
    const only = await checkContribution({ root: repo.root, only: ["typecheck"], skip: ["lint"] }, () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    assert.deepEqual(
      only.gates.map((gate) => gate.name),
      ["typecheck"],
    );
    assert.ok(only.notVerified.includes("lint"));
    await assert.rejects(checkContribution({ root: repo.root, only: ["typo"] }), /Unknown gate/);
    repo.write("pr.md", draftContributionPr({ root: repo.root, model: "test-model", owner: "tester" }));
    const full = await checkContribution({ root: repo.root, body: "pr.md", only: ["contrib:intake"] }, (command) => {
      assert.ok(command.includes("--body"));
      return { exitCode: 0, stdout: '{"ok":true}', stderr: "" };
    });
    assert.deepEqual(
      full.notVerified.filter((item) => item.includes("CLA")),
      [],
    );
  } finally {
    repo.dispose();
  }
});
test("check CLI writes one JSON line for structural success, failure and invalid flags", () => {
  const repo = temporaryRepository();
  try {
    repo.write(".env", "THIS MUST NEVER BE LOADED\n");
    const result = repo.cli("contrib-check", "--only", "contrib:intake");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(result.stdout).metadata.evidence.gates[0].exitCode, 0);
    repo.write("docs/binary.bin", Buffer.from([0, 1, 2]));
    repo.git("add", "docs");
    repo.git("commit", "-m", "binary");
    const failed = repo.cli("contrib-check", "--only", "contrib:intake");
    assert.equal(failed.status, 1);
    assert.equal(JSON.parse(failed.stdout).ok, false);
    assert.equal(repo.cli("contrib-check", "--only", "unknown").status, 1);
    assert.equal(JSON.parse(repo.cli("contrib-check", "--help").stdout).metadata.help, true);
    assert.equal(
      parsePrBlock(draftContributionPr({ root: repo.root, model: "model", owner: "tester" })).category,
      "docs",
    );
  } finally {
    repo.dispose();
  }
});

test("declared category limits gates despite overlapping test paths; mismatches stay intake's job", async () => {
  const repo = temporaryRepository();
  const runner = () => ({ exitCode: 0, stdout: "", stderr: "" });
  try {
    repo.write(".changes/repair.md", changeText("fix"));
    repo.write("tests/repair.test.ts", "// Regression fixture\n");
    repo.write("community/unrelated.json", "{}\n");
    repo.git("add", ".");
    repo.git("commit", "-m", "fix with overlapping tests");
    const evidence = await checkContribution({ root: repo.root }, runner);
    assert.deepEqual(evidence.categories, ["fix"]);
    assert.deepEqual(
      evidence.gates
        .filter((gate) => gate.name.startsWith("category:"))
        .map((gate) => gate.command.slice(0, 2).join(" ")),
      DEFAULT_CATEGORIES.categories
        .find((category) => category.id === "fix")!
        .gates.filter((gate) => !COMMON_GATES.some((common) => common.command.join(" ") === gate)),
    );
    assert.equal(evidence.gates[0]!.exitCode, 0);
    repo.write(".changes/repair.md", changeText("docs"));
    repo.git("add", ".changes");
    repo.git("commit", "-m", "mismatched docs category");
    const mismatch = await checkContribution({ root: repo.root, only: ["contrib:intake"] }, runner);
    assert.deepEqual(mismatch.categories, ["docs"]);
    assert.equal(mismatch.gates[0]!.exitCode, 1);
    assert.match(mismatch.gates[0]!.summary, /Paths outside docs/);
    await assert.rejects(checkContribution({ root: repo.root, category: "fix" }, runner), /disagrees/);
    await assert.rejects(checkContribution({ root: repo.root, category: "absent" }, runner), /Unknown category/);
    repo.git("rm", ".changes/repair.md");
    repo.git("commit", "-m", "missing entry");
    const selected = await checkContribution({ root: repo.root, category: "fix", only: ["contrib:intake"] }, runner);
    assert.deepEqual(selected.categories, ["fix"]);
    assert.equal(selected.gates[0]!.exitCode, 1);
  } finally {
    repo.dispose();
  }
});

test("missing entry and dirty-tree warnings name change:add and the local commit step", async (t) => {
  const repo = temporaryRepository();
  const progress = t.mock.method(console, "error", () => {});
  try {
    repo.git("rm", ".changes/repair.md");
    repo.git("commit", "-m", "remove entry");
    repo.write(".changes/uncommitted.md", changeText());
    const evidence = await checkContribution({ root: repo.root, only: ["contrib:intake"] });
    const output = progress.mock.calls.map((call) => call.arguments.join(" ")).join("\n");
    assert.match(output, /missing committed.*change:add.*local commit/);
    assert.match(output, /dirty working tree.*local commit.*contrib:check/);
    assert.ok(evidence.dirtyPaths?.includes(".changes/uncommitted.md"));
  } finally {
    repo.dispose();
  }
});

test("slow gates stream progress, time out and retain each earlier gate's evidence", async (t) => {
  const repo = temporaryRepository();
  let output = "";
  t.mock.method(process.stderr, "write", (chunk: unknown) => {
    output += String(chunk);
    return true;
  });
  try {
    let calls = 0;
    const evidence = await checkContribution(
      { root: repo.root, only: ["lint", "typecheck"], timeoutMin: 0.05 },
      async (_command, root, timeoutMs) => {
        calls++;
        const saved = JSON.parse(readFileSync(path.join(root, ".contrib/evidence.json"), "utf8"));
        if (calls === 1) return { exitCode: 0, stdout: '{"ok":true}', stderr: "" };
        assert.deepEqual(
          saved.gates.map((gate: { name: string }) => gate.name),
          ["lint"],
        );
        assert.ok(saved.notVerified.includes("typecheck"));
        return runGate(
          [
            process.execPath,
            "-e",
            'process.stdout.write("slow gate stdout\\n"); process.stderr.write("x".repeat(1000) + "slow gate stderr\\n"); setInterval(() => {}, 1000);',
          ],
          root,
          timeoutMs,
        );
      },
    );
    assert.deepEqual(
      evidence.gates.map((gate) => gate.exitCode),
      [0, 124],
    );
    assert.match(evidence.gates[1]!.summary, /timed out/);
    assert.match(output, /Starting lint/);
    assert.match(output, /slow gate stdout/);
    assert.match(output, /slow gate stderr/);
    assert.match(output, /Finished typecheck: exit 124, \d+ ms/);
    assert.deepEqual(JSON.parse(readFileSync(path.join(repo.root, ".contrib/evidence.json"), "utf8")), evidence);
  } finally {
    repo.dispose();
  }
});

test("interruption leaves pending gates unverified and stops launching commands", async () => {
  const repo = temporaryRepository();
  try {
    const evidence = await checkContribution({ root: repo.root }, () => ({
      exitCode: 130,
      stdout: "",
      stderr: "Interrupted",
      interrupted: true,
    }));
    assert.equal(evidence.gates.length, 2);
    assert.equal(evidence.gates[0]!.name, "contrib:intake");
    assert.ok(evidence.notVerified.includes("api:surface"));
    assert.ok(!evidence.notVerified.includes(evidence.gates[1]!.name));
    assert.deepEqual(JSON.parse(readFileSync(path.join(repo.root, ".contrib/evidence.json"), "utf8")), evidence);
  } finally {
    repo.dispose();
  }
});

test("timeout kills descendants even when their wrapper closes its pipes first", async () => {
  const repo = temporaryRepository();
  try {
    const heartbeat = path.join(repo.root, "heartbeat");
    repo.write(
      "descendant.cjs",
      'const fs = require("node:fs"); process.on("SIGTERM", () => {}); setInterval(() => fs.writeFileSync(process.argv[2], String(Date.now())), 50); setTimeout(() => process.exit(), 15000);',
    );
    repo.write(
      "wrapper.cjs",
      'require("node:child_process").spawn(process.execPath, ["descendant.cjs", process.argv[2]], { stdio: "ignore" }); setInterval(() => {}, 1000);',
    );
    const result = await runGate([process.execPath, "wrapper.cjs", heartbeat], repo.root, 3000);
    assert.equal(result.exitCode, 124);
    const stopped = readFileSync(heartbeat, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(
      readFileSync(heartbeat, "utf8"),
      stopped,
      "descendant should no longer write after the grace-period kill",
    );
  } finally {
    repo.dispose();
  }
});

test("gate timeouts default to 30 minutes for tests and 5 otherwise; overrides are validated", () => {
  assert.equal(gateTimeoutMs(["pnpm", "test:fast"]), 30 * 60000);
  assert.equal(gateTimeoutMs(["pnpm", "test"]), 30 * 60000);
  assert.equal(gateTimeoutMs(["pnpm", "contrib:fails-on-base"]), 55 * 60000);
  assert.equal(gateTimeoutMs(["pnpm", "lint"]), 5 * 60000);
  assert.equal(gateTimeoutMs(["pnpm", "test:fast"], 2), 2 * 60000);
  for (const invalid of [0, -1, NaN, Infinity, 1e9]) assert.throws(() => gateTimeoutMs([], invalid), /timeout-min/);
});
test("check runs a category gate identical to an always-on gate once and names failing tests", async (t) => {
  const repo = temporaryRepository();
  t.mock.method(console, "error", () => {}); // keep the synthetic failure summary out of real test logs
  try {
    const config = {
      ...DEFAULT_CATEGORIES,
      categories: DEFAULT_CATEGORIES.categories.map((row) => ({ ...row, gates: ["pnpm typecheck"] })),
    };
    const commands: string[][] = [];
    // Built at runtime and never echoed, so this fixture cannot appear in a real test run's failure section.
    const at = (file: string, line: number) => ["test", "at", `tests/${file}.test.ts:${line}:1`].join(" ");
    const tap = `${at("decoy", 1)}\n✖ failing tests:\n\n${at("a", 4)}\n✖ a fails\n${at("b", 9)}\n✖ b fails\n`;
    const evidence = await checkContribution(
      { root: repo.root },
      (command) => {
        commands.push(command);
        return command[1] === "test:fast"
          ? { exitCode: 1, stdout: tap, stderr: "" }
          : { exitCode: 0, stdout: '{"ok":true}', stderr: "" };
      },
      config,
    );
    assert.equal(commands.filter((command) => command.join(" ") === "pnpm typecheck").length, 1);
    assert.ok(!evidence.gates.some((gate) => gate.name === "category:typecheck"));
    assert.equal(
      evidence.gates.find((gate) => gate.name === "test:fast")!.summary,
      "Failing: tests/a.test.ts:4, tests/b.test.ts:9.",
    );
  } finally {
    repo.dispose();
  }
});
