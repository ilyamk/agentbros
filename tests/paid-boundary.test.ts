import { USER_GRANT, writeBudgetBrief } from "./helpers/ceiling-grant";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createFalJobProvider, createFalRestQueue } from "../src/lib/jobs/fal-provider";
import { executeFalOperation } from "../src/lib/jobs/execution";
import { OperationStore } from "../src/lib/jobs/store";
const repo = path.resolve(import.meta.dirname, "..");
function project() {
  const dir = mkdtempSync(path.join(tmpdir(), "paid boundary "));
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
  writeBudgetBrief(path.join(dir, "public/projects/test"));
  return dir;
}
test("REST submit makes exactly one HTTP attempt and never follows redirects", async () => {
  let calls = 0;
  const rest = createFalRestQueue({
    credentials: "fake-test-key",
    fetch: async (_url, init) => {
      calls++;
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "manual");
      return new Response("{}", { status: 503 });
    },
  });
  await assert.rejects(rest.submit("fal-ai/flux/schnell", { input: { prompt: "test" } }));
  assert.equal(calls, 1);
});
test("queue adapter separates queued/running/completed result retrieval", async () => {
  let status = "IN_QUEUE";
  let reads = 0;
  const provider = createFalJobProvider({
    submit: async () => ({ request_id: "id" }),
    status: async () => ({ status }),
    result: async () => {
      reads++;
      return { data: { images: [] } };
    },
  });
  assert.deepEqual(await provider.inspect("fal-ai/flux/schnell", "id"), { state: "queued" });
  status = "IN_PROGRESS";
  assert.deepEqual(await provider.inspect("fal-ai/flux/schnell", "id"), { state: "running" });
  assert.equal(reads, 0);
  status = "COMPLETED";
  assert.equal((await provider.inspect("fal-ai/flux/schnell", "id")).state, "completed");
  assert.equal(reads, 1);
});
test("dry runs have no files, keys, reservations or provider calls; unknown remains unexecutable", async () => {
  const result = await executeFalOperation({
    endpoint: "openai/gpt-image-2",
    model: "fal:gpt-image-2",
    input: { prompt: "test" },
    output: "nowhere.png",
    mediaKind: "image",
    dryRun: true,
    provider: {
      submit: async () => {
        throw new Error("must not submit");
      },
      inspect: async () => {
        throw new Error("must not inspect");
      },
    },
  });
  assert.equal(result.metadata.executable, false);
  assert.equal(result.metadata.quote, null);
  await assert.rejects(
    executeFalOperation({
      endpoint: "x/y",
      model: "unknown",
      input: {},
      output: "x",
      mediaKind: "image",
      dryRun: true,
      maxCostUsd: -1,
    }),
  );
});
test("budget rejection precedes provider submit; ambiguous outcomes persist without resubmit", async () => {
  const cwd = process.cwd(),
    dir = project();
  let submits = 0;
  try {
    process.chdir(dir);
    const store = new OperationStore("test");
    store.configure({ ceilingUsd: 0, maxJobUsd: 0 }, USER_GRANT);
    const options = {
      projectId: "test",
      endpoint: "fal-ai/flux/schnell",
      model: "fal:flux-schnell",
      input: { prompt: "test" },
      output: "public/projects/test/assets/image.png",
      mediaKind: "image" as const,
      operationId: "test-op",
      provider: {
        submit: async () => {
          submits++;
          throw new Error("lost response");
        },
        inspect: async () => ({ state: "queued" as const }),
      },
    };
    await assert.rejects(executeFalOperation(options));
    assert.equal(submits, 0);
    store.configure({ ceilingUsd: 1, maxJobUsd: 1 }, USER_GRANT);
    assert.equal((await executeFalOperation(options)).metadata.state, "unknown");
    assert.equal(submits, 1);
    assert.equal((await executeFalOperation(options)).metadata.state, "unknown");
    assert.equal(submits, 1);
    assert.equal(store.summary().reservedUsd, 0.003);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
test("queued submit, failed download and resume publish all images without repeat paid work", async (t) => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) return t.skip("ffmpeg unavailable");
  const cwd = process.cwd(),
    dir = project();
  let submits = 0,
    downloads = 0,
    done = false,
    fail = true;
  try {
    const png = path.join(dir, "fixture.png");
    const generated = spawnSync(
      "ffmpeg",
      ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64", "-frames:v", "1", png],
      { encoding: "utf8" },
    );
    assert.equal(generated.status, 0, generated.stderr);
    const bytes = readFileSync(png);
    process.chdir(dir);
    const options = {
      projectId: "test",
      endpoint: "fal-ai/flux/schnell",
      model: "fal:flux-schnell",
      input: { prompt: "test", num_images: 2 },
      output: "public/projects/test/assets/test image.png",
      mediaKind: "image" as const,
      operationId: "images-op",
      quoteInput: { units: 2 },
      provider: {
        submit: async () => {
          submits++;
          return { requestId: "request-1" };
        },
        inspect: async () =>
          done
            ? {
                state: "completed" as const,
                result: { images: [{ url: "https://fal.media/image1" }, { url: "https://fal.media/image2" }] },
              }
            : { state: "queued" as const },
      },
      fetch: (async () => {
        downloads++;
        if (fail) return new Response("failure", { status: 503 });
        return new Response(new Uint8Array(bytes));
      }) as typeof fetch,
    };
    const pending = await executeFalOperation(options);
    assert.equal(pending.metadata.state, "queued");
    assert.equal(pending.metadata.providerRequestId, "request-1");
    assert.equal(submits, 1);
    done = true;
    const failed = await executeFalOperation(options);
    assert.equal(failed.metadata.state, "failed");
    assert.equal(submits, 1);
    fail = false;
    const published = await executeFalOperation(options);
    assert.equal(published.metadata.state, "published");
    assert.equal(published.outputs.length, 2);
    assert.equal(submits, 1);
    const before = downloads;
    assert.equal((await executeFalOperation(options)).metadata.state, "published");
    assert.equal(downloads, before);
    const store = new OperationStore("test");
    assert.equal(store.summary().reservedUsd, 0.006);
    assert.equal(store.snapshot().jobs["images-op"].receipt, undefined);
    writeFileSync(published.outputs[0]!, "corrupt");
    await assert.rejects(executeFalOperation(options), /Published output/);
    assert.equal(submits, 1);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
test("legacy generation CLI dry-run preserves payloads and does not require keys", () => {
  for (const [script, args] of [
    ["generate-image.ts", ["--prompt", "test", "--output", "x.png", "--num-images", "2"]],
    ["generate-video.ts", ["--prompt", "test", "--output", "x.mp4", "--duration", "5"]],
  ] as const) {
    const result = spawnSync(
      process.execPath,
      [path.join(repo, "node_modules/tsx/dist/cli.mjs"), path.join(repo, "scripts", script), ...args, "--dry-run"],
      { encoding: "utf8", env: { ...process.env, FAL_KEY: "" }, timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.metadata.dryRun, true);
    assert.equal(output.outputs.length, 0);
  }
});
test("modern CLI validates schema before execution; budget CLI is entirely local", () => {
  const dir = project();
  const run = (script: string, args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [path.join(repo, "node_modules/tsx/dist/cli.mjs"), path.join(repo, "scripts", script), ...args],
      { cwd: dir, encoding: "utf8", env: { ...process.env, FAL_KEY: "" }, timeout: 10000 },
    );
    const parsed = JSON.parse(result.stdout);
    assert.equal(result.status, parsed.ok ? 0 : 1);
    return parsed;
  };
  try {
    const request = path.join(dir, "request.json");
    writeFileSync(
      request,
      JSON.stringify({
        family: "gpt-image-2.5",
        variant: "flare",
        operation: "text-to-image",
        input: { prompt: "test" },
      }),
    );
    const planned = run("generate-model.ts", ["--request", request, "--output", "x.png", "--dry-run"]);
    assert.equal(planned.metadata.plan.endpoint, "openai/gpt-image-2.5/flare/text-to-image");
    assert.equal(planned.metadata.executable, false);
    writeFileSync(
      request,
      JSON.stringify({
        family: "gpt-image-2.5",
        variant: "flare",
        operation: "text-to-image",
        input: { prompt: "test", invented: true },
      }),
    );
    assert.equal(
      run("generate-model.ts", ["--request", request, "--output", "x.png", "--dry-run"]).error,
      "INVALID_INPUT",
    );
    const unauthorised = run("budget.ts", ["--project", "test", "--ceiling-usd", "2"]);
    assert.equal(unauthorised.error, "INVALID_INPUT");
    assert.match(unauthorised.message, /user's own words/);
    const set = run("budget.ts", ["--project", "test", "--ceiling-usd", "2", "--answer", "Spend up to two dollars."]);
    assert.equal(set.metadata.summary.ceilingUsd, 2);
    assert.equal(run("budget.ts", ["--project", "test", "--ceiling-usd", "3"]).error, "INVALID_INPUT");
    assert.equal(run("budget.ts", ["--project", "test", "--ceiling-usd", "1"]).metadata.summary.ceilingUsd, 1);
    assert.equal(
      run("budget.ts", ["--project", "test", "--forecast", request, "--answer", "x"]).error,
      "INVALID_INPUT",
    );
    assert.equal(run("budget.ts", ["--project", "test"]).metadata.summary.reservedUsd, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
