import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repo = process.cwd();
test("public discovery answers and the saved leaf prompt retain task-scoped hints in disposable projects", (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-workflow-cli-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    SYSTEMROOT: process.env.SYSTEMROOT,
    AGENTBROS_MODEL_CACHE: path.join(root, "empty-model-cache"),
    AGENTBROS_LOCAL_DOWNLOADS: "never",
    AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
  };
  const cli = (script: string, args: string[]) => {
    const child = spawnSync(
      process.execPath,
      [path.join(repo, "node_modules/tsx/dist/cli.mjs"), path.join(repo, "scripts", script), ...args],
      { cwd: root, env, encoding: "utf8", timeout: 60000 },
    );
    assert.equal(child.status, 0, child.stderr + child.stdout);
    assert.equal(child.stdout.trim().split("\n").length, 1);
    return JSON.parse(child.stdout) as { outputs: string[]; metadata: Record<string, any> };
  };
  cli("film-init.ts", ["--project", "film", "--type", "motion-graphics"]);
  const film = path.join(root, "public/projects/film");
  copyFileSync(path.join(repo, "tests/fixtures/film-chain/brief.json"), path.join(film, "pipeline/brief.json"));
  const direct = cli("film-next.ts", ["--project", "film"]);
  assert.ok(direct.metadata.localTools, "film:next retains task prerequisites");
  const routed = cli("next.ts", ["--project", "film"]);
  assert.ok(routed.metadata.localTools, "next sees the nested film action");
  assert.equal(routed.metadata.route, "film");
  const brief = cli("film-brief.ts", ["--project", "film", "--step", "intake", "--print"]);
  assert.ok(brief.metadata.localTools);
  assert.match(brief.metadata.prompt, /Optional local tools for this task/);
  assert.equal(
    readFileSync(path.join(root, brief.outputs[0]!), "utf8"),
    brief.metadata.prompt,
    "forwarding prompt alone retains the hints",
  );

  const footage = path.join(root, "public/projects/footage");
  mkdirSync(footage, { recursive: true });
  const source = path.join(footage, "source.mp4");
  const ffmpeg = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=5:duration=2",
      "-f",
      "lavfi",
      "-i",
      "sine=duration=2",
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      source,
    ],
    { timeout: 30000, encoding: "utf8" },
  );
  assert.equal(ffmpeg.status, 0, ffmpeg.stderr);
  const next = cli("footage-next.ts", [
    "--project",
    "footage",
    "--goal",
    "captions",
    "--caption-style",
    "clean-sentence",
    "--language",
    "en",
    "--transcriber",
    "local",
    "--source",
    source,
  ]);
  assert.equal(next.metadata.step, "1-transcript");
  assert.ok(next.metadata.localTools);
  const catalogue = cli("commands.ts", ["--query", "voiceover:local"]);
  assert.equal(catalogue.metadata.commands.length, 0, "unprepared optional command is hidden");
  const all = cli("commands.ts", ["--query", "voiceover:local", "--all"]);
  assert.ok(all.metadata.commands.some((c: { alias: string }) => c.alias === "voiceover:local"));
});
