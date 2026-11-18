import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
test("timeline CLI dry-run and revision failures leave authored project unchanged", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "edit-cli-"));
  const script = fileURLToPath(new URL("../scripts/timeline-edit.ts", import.meta.url));
  const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, [tsx, script, "--project", "test", ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH },
    });
    assert.equal(result.stdout.trim().split("\n").length, 1, result.stderr);
    return { code: result.status, json: JSON.parse(result.stdout.trim()) };
  };
  try {
    const folder = path.join(dir, "public/projects/test");
    mkdirSync(folder, { recursive: true });
    const project = JSON.stringify({
      name: "test",
      productName: "test",
      colors: {},
      voiceoverEnabled: false,
      musicVolume: 0,
      scenes: [
        { id: "a", text: "one", visualType: "title", durationInFrames: 60 },
        { id: "b", text: "two", visualType: "title", durationInFrames: 60 },
      ],
      futureExtension: "preserve",
    });
    writeFileSync(path.join(folder, "project.json"), project);
    const init = run(["--init"]);
    assert.equal(init.json.ok, true, JSON.stringify(init));
    const command = JSON.stringify({ type: "move", trackId: "visual", clipId: "b", start: { num: 100, den: 1 } });
    const journal = path.join(folder, "pipeline/timeline-edit.json"),
      before = readFileSync(journal, "utf8");
    assert.equal(
      run([
        "--command",
        JSON.stringify({ type: "transition", trackId: "visual", clipId: "a", transition: { kind: "cut" } }),
        "--revision",
        "0",
        "--dry-run",
      ]).json.ok,
      true,
    );
    assert.equal(readFileSync(journal, "utf8"), before);
    assert.equal(run(["--command", command, "--revision", "0"]).json.ok, false); // Dissolve cannot span newly created gap.
    const cut = JSON.stringify({
      type: "batch",
      commands: [
        { type: "transition", trackId: "visual", clipId: "a", transition: { kind: "cut" } },
        JSON.parse(command),
      ],
    });
    assert.equal(run(["--command", cut, "--revision", "0"]).json.ok, true);
    const stale = run(["--command", cut, "--revision", "0"]);
    assert.notEqual(stale.code, 0);
    assert.equal(stale.json.ok, false);
    assert.equal(run(["--undo", "--revision", "1"]).json.ok, true);
    assert.equal(run(["--redo", "--revision", "2"]).json.ok, true);
    assert.equal(readFileSync(path.join(folder, "project.json"), "utf8"), project);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
