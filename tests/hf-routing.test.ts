import { USER_GRANT } from "./helpers/ceiling-grant";
import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { FalCatalogFileSchema } from "../src/types/fal-catalog";
import { HiggsfieldSchemaDocSchema } from "../src/types/higgsfield";
import {
  higgsfieldSchemaSha256,
  HIGGSFIELD_OUTPUT_SCHEMA,
  resetProviderCatalogCache,
  findProviderEntry,
} from "../src/lib/models/fal-catalog";
import { buildFalOperation, resolveFalSnapshotForPlan } from "../src/lib/providers/fal-operations";
import { registerFalGuard } from "../src/lib/providers/fal-guards/all";
import { extractArtifacts } from "../src/lib/providers/fal-results";
import { HIGGSFIELD_RESULT_HOSTS, trustedArtifactUrl } from "../src/lib/jobs/model-artifacts";
import { executeFalOperation, type ExecutionOptions } from "../src/lib/jobs/execution";
import { OperationStore } from "../src/lib/jobs/store";
import { resolveImportedReferences } from "../src/lib/assets/provider-references";
import type { JobProvider } from "../src/lib/jobs/runner";
import { useTempFalCatalog } from "./helpers/fal-temp-catalog";

const repo = path.resolve(import.meta.dirname, "..");
const endpoint = "bytedance/seedance-2.5/reference-to-video";
/** Stream A's parser is independent; these tests only unwrap the recorded quoted schema fence. */
function fixtureDoc(name: string) {
  const page = readFileSync(path.join(import.meta.dirname, "fixtures/higgsfield/docs", name), "utf8");
  const endpoint = /\*\*Endpoint ID:\*\* `([^`]+)`/.exec(page)?.[1];
  const quoted = page
    .slice(page.indexOf("Complete JSON schema"))
    .split("\n")
    .map((line) => line.replace(/^> ?/, ""))
    .join("\n");
  const json = /```json[^\n]*\n([\s\S]*?)\n```/.exec(quoted)?.[1];
  assert.ok(endpoint && json);
  return HiggsfieldSchemaDocSchema.parse({
    version: 1,
    endpoint,
    title: endpoint,
    usageNotes: [],
    schema: JSON.parse(json),
    asOf: "2026-11-15",
  });
}
const root = mkdtempSync(path.join(tmpdir(), "hf-routing-index-"));
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const catalogDir = path.join(root, "catalog"),
  schemaDir = path.join(root, "schemas");
mkdirSync(catalogDir);
mkdirSync(schemaDir);
for (const [name, category, kind] of [
  ["models_seedance-2-5_reference-to-video.md", "image-to-video", "video"],
  ["models_soul-2_generate.md", "text-to-image", "image"],
] as const) {
  const doc = fixtureDoc(name),
    sha256 = higgsfieldSchemaSha256(doc.schema);
  writeFileSync(path.join(schemaDir, `${sha256}.json`), JSON.stringify(doc));
  writeFileSync(
    path.join(catalogDir, `${category}.json`),
    JSON.stringify(
      FalCatalogFileSchema.parse({
        version: 1,
        provider: "higgsfield",
        category,
        syncedAt: "2026-11-15",
        entries: [
          {
            provider: "higgsfield",
            endpoint: doc.endpoint,
            category,
            displayName: doc.title,
            status: "active",
            firstSeen: doc.asOf,
            lastSeen: doc.asOf,
            schema: { sha256, source: "https://docs.higgsfield.ai/docs/models.md", asOf: doc.asOf, cached: true },
            inputs: [],
            outputs: { kinds: [kind], fields: [kind === "image" ? "images" : "video"] },
            transport: "queue",
            price: null,
            tier: "discovered",
            tags: [],
          },
        ],
      }),
    ),
  );
}
process.env.AGENTBROS_HF_CATALOG_DIR = catalogDir;
process.env.AGENTBROS_HF_SCHEMA_DIR = schemaDir;
resetProviderCatalogCache();
useTempFalCatalog([{ endpoint: "fal-ai/flux/schnell" }]);
const request = {
  provider: "higgsfield" as const,
  endpoint,
  input: { prompt: "test", image_urls: ["https://example.test/input.png"], duration: 5 },
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
async function workspace(fn: () => Promise<void>) {
  const old = process.cwd(),
    directory = mkdtempSync(path.join(tmpdir(), "hf-routing-project-"));
  process.chdir(directory);
  mkdirSync("public/projects/demo", { recursive: true });
  writeFileSync("public/projects/demo/project.json", "{}");
  new OperationStore("demo").configure({ ceilingUsd: 10, maxJobUsd: 2, repairReserveFraction: 0 }, USER_GRANT);
  try {
    await fn();
  } finally {
    process.chdir(old);
    rmSync(directory, { recursive: true, force: true });
  }
}
const base = (patch: Partial<ExecutionOptions> = {}): ExecutionOptions => ({
  providerId: "higgsfield",
  projectId: "demo",
  endpoint,
  model: endpoint,
  input: { prompt: "test" },
  mediaKind: "image",
  output: "public/projects/demo/assets/out.png",
  operationId: "hf:publish",
  maxCostUsd: 1,
  ...patch,
});

test("Higgsfield uses only its provider schema, including a colliding fal endpoint", () => {
  const hf = buildFalOperation(request);
  assert.equal(hf.provider, "higgsfield");
  assert.equal(hf.executable, true);
  assert.equal(hf.verification.live, false);
  assert.equal(resolveFalSnapshotForPlan(hf).sha256, findProviderEntry("higgsfield", endpoint)?.schema?.sha256);
  assert.throws(() => buildFalOperation({ ...request, input: { ...request.input, duration: "5" } }), /integer|number/);
  assert.throws(
    () => buildFalOperation({ ...request, input: { ...request.input, seed: 1 } }),
    /seed|unknown|additional/i,
  );
  const fal = buildFalOperation({
    endpoint,
    input: { prompt: "test", image_urls: ["https://example.test/input.png"], duration: "5" },
  });
  assert.equal(fal.provider, "fal");
  assert.notEqual(hf.schemaSha256, fal.schemaSha256);
  assert.throws(
    () => buildFalOperation({ provider: "higgsfield", endpoint: "fal-ai/flux/schnell", input: { prompt: "test" } }),
    /no Higgsfield/,
  );
});

test("shared guards receive provider in info and context and revalidate their changes", () => {
  let ran = 0;
  registerFalGuard({
    id: "hf-test-provider-context",
    match: (info) => info.provider === "higgsfield",
    check: (input, context, _warnings, info) => {
      assert.equal(context.provider, "higgsfield");
      assert.equal(info.provider, "higgsfield");
      ran++;
      if (input.prompt === "mutate") input.duration = "invalid";
    },
  });
  buildFalOperation(request);
  assert.equal(ran, 1);
  assert.throws(
    () => buildFalOperation({ ...request, input: { ...request.input, prompt: "mutate" } }),
    /integer|number/,
  );
});

test("URL-only Higgsfield outputs classify images, video, audio and audios by field and extension", () => {
  const extracted = extractArtifacts(
    { schema: HIGGSFIELD_OUTPUT_SCHEMA },
    {
      status: "completed",
      images: [{ url: "https://cdn.higgsfield.ai/opaque-image" }],
      video: { url: "https://static-public-media.higgsfield.ai/opaque-video" },
      audio: { url: "https://cdn.higgsfield.ai/opaque-audio" },
      audios: [{ url: "https://cdn.higgsfield.ai/track.wav" }],
    },
    "higgsfield",
  );
  assert.deepEqual(
    extracted.files.map((file) => file.kind),
    ["image", "video", "audio", "audio"],
  );
  assert.ok(extracted.files.every((file) => file.trusted));
  assert.equal(
    extractArtifacts(undefined, { images: [{ url: "https://fal.media/image.png" }] }, "higgsfield").files[0]?.trusted,
    false,
  );
  assert.doesNotThrow(() => trustedArtifactUrl("https://v3.fal.media/output.png", "fal"));
  for (const url of [
    "http://cdn.higgsfield.ai/x",
    "https://cdn.higgsfield.ai.evil.test/x",
    "https://user:pass@cdn.higgsfield.ai/x",
    "https://cdn.higgsfield.ai:444/x",
    "https://fal.media/x",
  ])
    assert.throws(() => trustedArtifactUrl(url, "higgsfield"), /Untrusted/);
});

test("completed result on an untrusted host resumes publication after allowlist review without submit or poll", () =>
  workspace(async () => {
    let submits = 0,
      polls = 0,
      downloads = 0;
    const url = "https://reviewed-hf-result.example/out.png";
    const provider: JobProvider = {
      submit: async () => {
        submits++;
        return { requestId: "result-1" };
      },
      inspect: async () => {
        polls++;
        return {
          state: "completed",
          result: {
            status: "completed",
            request_id: "result-1",
            images: [{ url }],
            expires_at: "2026-11-22T00:00:00Z",
          },
        };
      },
    };
    const options = base({
      provider,
      fetch: async () => {
        downloads++;
        return new Response(png);
      },
    });
    const first = await executeFalOperation(options);
    assert.equal(first.metadata.state, "failed");
    assert.equal(downloads, 0);
    const cost = JSON.parse(readFileSync("public/projects/demo/pipeline/cost-ledger.jsonl", "utf8"));
    assert.equal(cost.provider, "higgsfield");
    assert.equal(cost.operationId, options.operationId);
    assert.equal(cost.estimatedUsd, 1);
    assert.match(cost.notes, /user planning bound/i);
    assert.equal(cost.actualUsd, null);
    assert.equal(cost.assetId, "assets/out.png");
    const hosts = HIGGSFIELD_RESULT_HOSTS as string[];
    hosts.push(new URL(url).hostname);
    try {
      const resumed = await executeFalOperation(options);
      assert.equal(resumed.metadata.state, "published");
      assert.equal(submits, 1);
      assert.equal(polls, 1);
      assert.equal(downloads, 1);
      const job = new OperationStore("demo").snapshot().jobs["hf:publish"]!;
      assert.equal((job.result?.published as Record<string, unknown>).expires_at, "2026-11-22T00:00:00Z");
      assert.equal((await executeFalOperation(options)).metadata.state, "published");
      assert.equal(downloads, 1);
      assert.equal(
        readFileSync("public/projects/demo/pipeline/cost-ledger.jsonl", "utf8").trim().split("\n").length,
        1,
      );
    } finally {
      hosts.pop();
    }
  }));

test("same-endpoint fal and Higgsfield jobs resume through their stored provider", () =>
  workspace(async () => {
    process.env.FAL_KEY = "offline-fal";
    process.env.HIGGSFIELD_API_KEY = "offline-id:offline-secret";
    const calls: string[] = [];
    const requestFetch: typeof fetch = async (url, init) => {
      const value = String(url);
      calls.push(value);
      if (value.startsWith("https://api.higgsfield.ai/"))
        return Response.json(
          init?.method === "POST"
            ? { request_id: "hf-1", status_url: "https://api.higgsfield.ai/requests/hf-1/status" }
            : { request_id: "hf-1", status: "in_progress" },
        );
      return Response.json(init?.method === "POST" ? { request_id: "fal-1" } : { status: "IN_PROGRESS" });
    };
    try {
      const hf = base({ operationId: "provider:hf", fetch: requestFetch });
      const fal = base({
        providerId: "fal",
        operationId: "provider:fal",
        fetch: requestFetch,
        output: "public/projects/demo/assets/fal.png",
      });
      assert.equal((await executeFalOperation(hf)).metadata.state, "running");
      assert.equal((await executeFalOperation(fal)).metadata.state, "running");
      calls.length = 0;
      await executeFalOperation({ ...hf, providerId: undefined });
      await executeFalOperation({ ...fal, providerId: undefined });
      assert.deepEqual(calls, [
        "https://api.higgsfield.ai/requests/hf-1/status",
        `https://queue.fal.run/${endpoint.split("/").slice(0, 2).join("/")}/requests/fal-1/status`,
      ]);
      await assert.rejects(executeFalOperation({ ...hf, providerId: "fal" }), /different inputs/);
    } finally {
      delete process.env.FAL_KEY;
      delete process.env.HIGGSFIELD_API_KEY;
    }
  }));

test("Higgsfield dry-run cannot borrow a fal price and CLI prints plan, validation and unknown-price action", async (t) => {
  const prices = path.join(root, "empty-prices.json");
  writeFileSync(prices, JSON.stringify({ version: 1, syncedAt: null, prices: [] }));
  const previous = process.env.AGENTBROS_HF_PRICES;
  process.env.AGENTBROS_HF_PRICES = prices;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENTBROS_HF_PRICES;
    else process.env.AGENTBROS_HF_PRICES = previous;
  });
  const plan = buildFalOperation(request);
  const options = {
    providerId: plan.provider,
    endpoint,
    model: endpoint,
    input: plan.input,
    mediaKind: "video" as const,
    output: "/tmp/hf-b-dry-run.mp4",
    dryRun: true,
  };
  const unknown = await executeFalOperation(options);
  assert.equal(unknown.metadata.pricing, "unknown");
  assert.equal(unknown.metadata.executable, false);
  assert.equal(unknown.metadata.quote, null);
  assert.match(String(unknown.metadata.nextAction), /--max-cost-usd/);
  assert.equal((await executeFalOperation({ ...options, maxCostUsd: 1 })).metadata.executable, true);
  const requestFile = path.join(root, "request.json");
  writeFileSync(requestFile, JSON.stringify(request));
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(repo, "scripts/generate-model.ts"),
      "--request",
      requestFile,
      "--output",
      "/tmp/hf-b-dry-run.mp4",
      "--dry-run",
    ],
    {
      cwd: repo,
      env: {
        AGENTBROS_NO_DOTENV: "1",
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
        AGENTBROS_HF_CATALOG_DIR: catalogDir,
        AGENTBROS_HF_SCHEMA_DIR: schemaDir,
        AGENTBROS_HF_PRICES: prices,
        AGENTBROS_FAL_CATALOG_DIR: process.env.AGENTBROS_FAL_CATALOG_DIR,
        AGENTBROS_FAL_SCHEMA_CACHE: process.env.AGENTBROS_FAL_SCHEMA_CACHE,
      },
      encoding: "utf8",
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const lines = child.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const result = JSON.parse(lines[0]!);
  assert.equal(result.ok, true);
  assert.equal(result.metadata.plan.provider, "higgsfield");
  assert.deepEqual(result.metadata.validation, { valid: true });
  assert.equal(result.metadata.executable, false);
  assert.equal(result.metadata.pricing, "unknown");
});

test("local Higgsfield media references resolve to inline preparation without network", () => {
  const file = path.join(root, "input.png");
  writeFileSync(file, png);
  const resolved = resolveImportedReferences({ ...request, input: { image_url: file } });
  assert.match(String(resolved.request.input.image_url), /^data:image\/png;base64,/);
});

test("Higgsfield publication immediately downloads both singular and plural audio outputs", () =>
  workspace(async () => {
    const encoded = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=8000:cl=mono",
      "-t",
      "0.01",
      "-f",
      "wav",
      "pipe:1",
    ]);
    assert.equal(encoded.status, 0, encoded.stderr.toString());
    const downloads: string[] = [];
    const provider: JobProvider = {
      submit: async () => ({ requestId: "audio-1" }),
      inspect: async () => ({
        state: "completed",
        result: {
          audio: { url: "https://cdn.higgsfield.ai/one" },
          audios: [{ url: "https://cdn.higgsfield.ai/two" }],
          expires_at: "2026-11-22",
        },
      }),
    };
    const result = await executeFalOperation(
      base({
        provider,
        mediaKind: "audio",
        output: "public/projects/demo/assets/audio.wav",
        fetch: async (url) => {
          downloads.push(String(url));
          return new Response(encoded.stdout);
        },
      }),
    );
    assert.equal(result.metadata.state, "published");
    assert.deepEqual(downloads, ["https://cdn.higgsfield.ai/one", "https://cdn.higgsfield.ai/two"]);
    assert.equal(result.outputs.length, 2);
  }));
