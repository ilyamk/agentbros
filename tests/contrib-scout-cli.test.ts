import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { temporaryRepository } from "./contrib-tools-helpers";

test("scout CLI reads a fixture repository offline, filters, limits and writes a needs board", () => {
  const repo = temporaryRepository();
  try {
    repo.write("tsconfig.json", '{"compilerOptions":{"target":"ES2022"},"include":["**/*.ts"]}');
    repo.write("package.json", '{"scripts":{}}');
    const book = JSON.parse(readFileSync("playbooks/explainer/playbook.json", "utf8"));
    repo.write("playbooks/explainer/playbook.json", JSON.stringify({ ...book, status: "draft", benchmarks: [] }));
    repo.write("docs/library/catalogue.json", '{"items":[]}');
    repo.write("src/lib/models/endpoints.json", "{}");
    repo.write("src/lib/providers/schemas/fal-operations.json", "[]");
    repo.write("src/lib/providers/fal-music.ts", "export {};");
    for (const file of [
      "src/lib/film/plan-check.ts",
      "src/lib/film/measure.ts",
      "src/lib/film/cut-sound.ts",
      "src/lib/sensors/findings.ts",
    ])
      repo.write(file, "export {};");
    repo.write("tests/agents-md.test.ts", "const SHRINKING = {};\n");
    repo.git("add", ".");
    repo.git("commit", "-m", "scout fixture");
    repo.write(".env", "MUST NOT BE LOADED\n");
    const result = repo.cli(
      "contrib-scout",
      "--json",
      "--category",
      "bench",
      "--limit",
      "1",
      "--tier",
      "0",
      "--markdown",
      "needs.md",
      "--out-json",
      "out/needs.json",
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    const json = JSON.parse(result.stdout);
    assert.equal(json.metadata.opportunities.length, 1);
    assert.equal(json.metadata.opportunities[0].category, "bench");
    assert.deepEqual(JSON.parse(readFileSync(path.join(repo.root, "out/needs.json"), "utf8")), json.metadata);
    const { counts, total } = json.metadata as { counts: Record<string, number>; total: number };
    assert.equal(counts.bench, 1);
    assert.equal(counts.playbook, 1, "counts cover categories cut by --category");
    assert.equal(
      total,
      Object.values(counts).reduce((sum, count) => sum + count, 0),
    );
    assert.ok(total > json.metadata.opportunities.length, "counts precede --limit");
    assert.deepEqual(Object.keys(json.metadata).sort(), ["assumptions", "counts", "dropped", "opportunities", "total"]);
    assert.match(readFileSync(path.join(repo.root, "needs.md"), "utf8"), /Benchmark explainer/);
    repo.write("contrib/opportunities.json", '{"version":1,"opportunities":[{"key":"x"}]}');
    const invalid = repo.cli("contrib-scout");
    assert.equal(invalid.status, 1);
    assert.match(JSON.parse(invalid.stdout).message, /contrib\/opportunities\.json is invalid/);
    const task = (key: string, requires: object) => ({
      key,
      category: "audio",
      size: "S",
      title: `Task ${key}`,
      why: "w",
      evidence: ["e"],
      definitionOfDone: ["d"],
      requires,
      verify: ["pnpm typecheck"],
    });
    repo.write(
      "contrib/opportunities.json",
      JSON.stringify({
        version: 1,
        opportunities: [
          task("open", {}),
          task("blender", { tools: ["blender"] }),
          task("codex", { harnessSession: ["codex"], os: ["macos"] }),
        ],
      }),
    );
    const scouted = (...args: string[]) =>
      JSON.parse(repo.cli("contrib-scout", ...args).stdout) as {
        ok: boolean;
        message?: string;
        metadata: {
          opportunities: { title: string; source: string; priority: number; requires: object; verify: string[] }[];
          total: number;
        };
      };
    const all = scouted("--limit", "3");
    assert.deepEqual(
      all.metadata.opportunities.map((row) => [row.source, row.priority]),
      [
        ["curated", 2],
        ["curated", 2],
        ["curated", 2],
      ],
      "curated rows lead the scouted ones",
    );
    assert.deepEqual(all.metadata.opportunities[0]!.verify, ["pnpm typecheck"]);
    const can = scouted("--can", "macos,codex,ffmpeg", "--category", "audio");
    assert.deepEqual(can.metadata.opportunities.map((row) => row.title).sort(), ["Task codex", "Task open"]);
    assert.equal(can.metadata.total, all.metadata.total - 1, "--can applies before counts and total");
    assert.deepEqual(
      scouted("--can", "linux,blender", "--category", "audio")
        .metadata.opportunities.map((row) => row.title)
        .sort(),
      ["Task blender", "Task open"],
    );
    const unknown = repo.cli("contrib-scout", "--can", "macos,teleport");
    assert.equal(unknown.status, 1);
    assert.equal(JSON.parse(unknown.stdout).error, "INVALID_INPUT");
    assert.match(JSON.parse(unknown.stdout).message, /teleport/);
    repo.write("contrib/opportunities.json", '{"version":1,"opportunities":[]}');
    assert.equal(repo.cli("contrib-scout", "--limit", "-1").status, 1);
    assert.equal(repo.cli("contrib-scout", "--tier", "9").status, 1);
    assert.equal(repo.cli("contrib-scout", "--unexpected").status, 1);
    assert.equal(JSON.parse(repo.cli("contrib-scout", "--help").stdout).metadata.help, true);
  } finally {
    repo.dispose();
  }
});
