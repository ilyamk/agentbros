import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateImage, removeBackground, generateAndSaveGptImage } from "../src/lib/apis/fal";
import { localMediaDataUri, PendingFalOperationError } from "../src/lib/apis/fal-context";
import { writeBudgetBrief } from "./helpers/ceiling-grant";
const repo = path.resolve(import.meta.dirname, "..");
const runner = path.join(repo, "node_modules/.bin/tsx");
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "legacy fal "));
  const png = path.join(dir, "source with spaces.png");
  const generated = spawnSync(
    "ffmpeg",
    ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64", "-frames:v", "1", png],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr);
  mkdirSync(path.join(dir, "public/projects/test"), { recursive: true });
  writeFileSync(
    path.join(dir, "public/projects/test/project.json"),
    JSON.stringify({
      name: "Test",
      formats: ["vertical"],
      productName: "Test",
      tagline: "",
      colors: { accent: "#ffffff", background: "#000000", text: "#ffffff" },
      voice: "rachel",
      musicPrompt: "",
      musicVolume: 0.1,
      scenes: [{ id: "hook", visualType: "title", text: "" }],
    }),
  );
  return { dir, png };
}
function cli(script: string, args: string[], cwd: string) {
  const env = { ...process.env };
  delete env.FAL_KEY;
  delete env.ELEVENLABS_API_KEY;
  const child = spawnSync(runner, [path.join(repo, "scripts", script), ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  const lines = child.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const result = JSON.parse(lines[0]!);
  assert.equal(result.ok, true);
  return result;
}
test("library rejects untracked paid usage before any transport call", async () => {
  await assert.rejects(generateImage({ prompt: "test" }), /generation context/);
  await assert.rejects(removeBackground("https://example.com/image.png"), /generation context/);
  await assert.rejects(generateAndSaveGptImage("test", "/tmp/should-not-be-created.png"), /requires --project/);
});
test("local identity includes real bytes; invalid or oversized inputs fail offline", (t) => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) return t.skip("ffmpeg unavailable");
  const { dir, png } = fixture();
  try {
    const first = localMediaDataUri(png, "image");
    assert.equal(first, localMediaDataUri(png, "image"));
    assert.match(first, /^data:image\/png;base64,/);
    assert.throws(() => localMediaDataUri(png, "image", 1), /at most/);
    assert.throws(() => localMediaDataUri(png, "video"), /Expected video/);
    const alternate = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=64x64",
      "-frames:v",
      "1",
      png,
    ]);
    assert.equal(alternate.status, 0);
    assert.notEqual(first, localMediaDataUri(png, "image"));
    writeFileSync(png, "not an image");
    assert.throws(() => localMediaDataUri(png, "image"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("singular fal result is published once; library pending explicitly carries resumable metadata", async (t) => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) return t.skip("ffmpeg unavailable");
  const { dir, png } = fixture();
  // A first paid ceiling needs an authority: the brief's budget stands in for the user's answer.
  writeBudgetBrief(path.join(dir, "public/projects/test"));
  const cwd = process.cwd();
  let submits = 0,
    complete = false;
  try {
    const bytes = readFileSync(png);
    process.chdir(dir);
    const context = {
      projectId: "test",
      output: path.join(dir, "public/projects/test/assets/result.png"),
      operationId: "library-rmbg",
      quoteInput: { units: 0 },
      provider: {
        submit: async () => {
          submits++;
          return { requestId: "mock-request" };
        },
        inspect: async () =>
          complete
            ? { state: "completed" as const, result: { image: { url: "https://v3.fal.media/result.png" } } }
            : { state: "queued" as const },
      },
      fetch: async () => new Response(bytes),
    };
    await assert.rejects(removeBackground("https://v3.fal.media/source.png", context), (error) => {
      assert.ok(error instanceof PendingFalOperationError);
      assert.equal(error.metadata.providerRequestId, "mock-request");
      assert.equal(error.metadata.state, "queued");
      assert.equal((error.metadata.quote as { highUsd: number }).highUsd, 0.005);
      return true;
    });
    complete = true;
    const result = await removeBackground("https://v3.fal.media/source.png", context);
    assert.equal(result.width, 64);
    assert.equal(result.height, 64);
    assert.equal(result.content_type, "image/png");
    assert.equal(readFileSync(fileURLToPath(result.url)).compare(bytes), 0);
    assert.deepEqual(await removeBackground("https://v3.fal.media/source.png", context), result);
    assert.equal(submits, 1);
    await assert.rejects(removeBackground("https://v3.fal.media/changed-source.png", context));
    assert.equal(submits, 1);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
test("all legacy paid CLIs plan offline without files or API keys", (t) => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) return t.skip("ffmpeg unavailable");
  const { dir, png } = fixture();
  try {
    for (const script of ["rmbg.ts", "upscale.ts"]) {
      const planned = cli(script, ["--input", png, "--output", "output with spaces.png", "--dry-run"], dir);
      assert.match(planned.metadata.input.image_url, /^data:image\/png;base64,/);
      assert.deepEqual(planned.outputs, []);
    }
    const meme = cli(
      "generate-image.ts",
      ["--prompt", "a meme", "--project", "test", "--model", "gpt-image-2", "--output", "meme.png", "--dry-run"],
      dir,
    );
    assert.equal(meme.metadata.executable, false);
    assert.equal(meme.metadata.quote, null);
    const image = cli(
      "generate-ai-image.ts",
      ["--prompt", "image", "--provider", "fal", "--output", "output.png", "--dry-run"],
      dir,
    );
    assert.equal(image.metadata.quote.highUsd, 0.003);
    for (const script of readdirSync(path.join(repo, "scripts")).filter((name) =>
      /^generate-.+-videos\.ts$/.test(name),
    )) {
      const planned = cli(script, ["--dry-run", "--operation-id", "batch-test"], dir);
      assert.equal(planned.metadata.state, "planned");
      assert.ok(planned.metadata.operations.length > 0);
      assert.ok(
        planned.metadata.operations.every((operation: { operationId: string }) =>
          operation.operationId.startsWith("batch-test:"),
        ),
      );
    }
    const audio = path.join(dir, "audio.wav");
    assert.equal(
      spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", audio]).status,
      0,
    );
    const lip = cli(
      "generate-lipsync.ts",
      ["--portrait", png, "--audio", audio, "--output", "lip.mp4", "--dry-run"],
      dir,
    );
    assert.ok(JSON.stringify(lip).length > 65536, "Large envelopes must not truncate at a pipe write boundary");
    assert.ok(lip.metadata.input.image_url);
    assert.equal(lip.metadata.input.video_url, undefined);
    assert.ok(lip.metadata.quote.highUsd > 0);
    assert.equal(existsSync(path.join(dir, "public/projects/test/pipeline")), false);
    assert.equal(existsSync(path.join(dir, "output.png")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
