import "./helpers/fal-no-network";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createHiggsfieldClient } from "../src/lib/providers/higgsfield/client";
import { prepareHiggsfieldInput } from "../src/lib/providers/higgsfield/uploads";
import { HiggsfieldUploadCache, HiggsfieldUploadCacheSchema } from "../src/lib/providers/higgsfield/upload-cache";
import { createHiggsfieldJobProvider } from "../src/lib/jobs/higgsfield-provider";
import { generationInputHash, generationRequestBody, runGenerationStep } from "../src/lib/jobs/runner";
import { OperationStore } from "../src/lib/jobs/store";
import { estimateHiggsfield } from "../src/lib/models/hf-pricing";
import { importAsset } from "../src/lib/assets/registry";
import { USER_GRANT, writeBudgetBrief } from "./helpers/ceiling-grant";

const endpoint = "higgsfield/genjutsu-light/motion-transfer/v1.0";
const repo = path.resolve(import.meta.dirname, "..");
const tsx = createRequire(path.join(repo, "package.json")).resolve("tsx");
const inline = (type: string, bytes = "reference") => `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
const sourceSha = createHash("sha256").update("reference").digest("hex");
function workspace(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "hf-estimate-uploads-"));
  const project = path.join(root, "public/projects/demo");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  writeBudgetBrief(project);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, project, cache: new HiggsfieldUploadCache("demo", root) };
}

test("estimate follows uploads; job and a second run reuse the cache and send byte-identical bodies", async (t) => {
  const f = workspace(t);
  let creates = 0,
    puts = 0;
  const estimates: string[] = [],
    submits: string[] = [];
  const store = new OperationStore("demo", { directory: path.join(f.project, "pipeline") });
  store.configure({ ceilingUsd: 2, maxJobUsd: 1, repairReserveFraction: 0 }, USER_GRANT);
  const client = createHiggsfieldClient({
    credentials: "offline:secret",
    fetch: async (url, init) => {
      if (String(url).endsWith("/generate-upload-url")) {
        creates++;
        assert.equal(Object.keys(store.snapshot().jobs).length, 0, "uploads precede admission");
        return Response.json({
          public_url: `https://cdn.higgsfield.ai/input-${creates}`,
          upload_url: "https://upload.example.test/put",
          upload_headers: {},
        });
      }
      if (init?.method === "PUT") {
        puts++;
        return new Response(null, { status: 200 });
      }
      if (String(url).includes("/estimate/")) {
        estimates.push(String(init?.body));
        assert.equal(puts, 2);
        return Response.json({ type: "estimate", usd: 0.3 });
      }
      if (init?.method === "POST") {
        const id = new Headers(init.headers).get("Idempotency-Key")!;
        const job = store.snapshot().jobs[id]!;
        assert.equal(job.uploads?.length, 2);
        assert.equal(job.requestBody, init.body);
        submits.push(String(init.body));
        return Response.json({ request_id: `req-${submits.length}` });
      }
      return Response.json({ request_id: `req-${submits.length}`, status: "queued" });
    },
  });
  const input = {
    video_url: inline("video/mp4"),
    image_urls: [inline("image/png", "png")],
    prompt: "test",
    extra: { Z: 1, a: 2 },
  };
  for (const id of ["one", "higgsfield-upload-cache"]) {
    const prepared = await prepareHiggsfieldInput(input, {
      client,
      cache: new HiggsfieldUploadCache("demo", f.root),
      uploads: [],
      persistUpload: () => {},
    });
    await client.estimate(endpoint, prepared);
    const expectedBody = generationRequestBody(prepared);
    const operation = {
      operationId: id,
      provider: "higgsfield",
      endpoint,
      assetId: id,
      preparedInputHash: generationInputHash(prepared),
      quote: {
        currency: "USD" as const,
        lowUsd: 0.3,
        expectedUsd: 0.3,
        highUsd: 0.3,
        bounded: true as const,
        confidence: "user-bound" as const,
        source: "offline",
        asOf: "2026-11-15",
      },
    };
    assert.equal(
      (
        await runGenerationStep({
          store,
          operation,
          input,
          provider: createHiggsfieldJobProvider(client, { cache: f.cache, expectedBody }),
        })
      ).state,
      "queued",
    );
  }
  assert.equal(creates, 2);
  assert.equal(puts, 2);
  assert.deepEqual(estimates, submits);
  assert.equal(estimates[0], estimates[1]);
  assert.ok(!estimates.join("").includes("data:"));
  const cache = HiggsfieldUploadCacheSchema.parse(JSON.parse(readFileSync(f.cache.file, "utf8")));
  assert.equal(cache.expiry, "unknown");
  assert.equal(Object.keys(cache.entries).length, 2);
  assert.ok(cache.entries[`${sourceSha}:video/mp4`]?.uploadedAt);
});

test("cache keys include source hash and the content type after transcode; hits avoid conversion", async (t) => {
  const { cache } = workspace(t);
  let creates = 0,
    conversions = 0;
  const client = {
    createUpload: async (contentType: string) => {
      creates++;
      return {
        public_url: `https://cdn.higgsfield.ai/${contentType}`,
        upload_url: "https://upload.example.test/put",
        upload_headers: {},
      };
    },
    putUpload: async () => {},
  };
  const transcode = () => {
    conversions++;
    return { contentType: "audio/wav", bytes: Buffer.from("converted") };
  };
  const input = { refs: [inline("audio/mpeg"), inline("image/png")] };
  const prepare = () =>
    prepareHiggsfieldInput(input, { client, cache, transcode, uploads: [], persistUpload: () => {} });
  assert.deepEqual(await prepare(), await prepare());
  assert.equal(creates, 2);
  assert.equal(conversions, 1);
  const saved = JSON.parse(readFileSync(cache.file, "utf8"));
  assert.deepEqual(Object.keys(saved.entries).sort(), [`${sourceSha}:audio/wav`, `${sourceSha}:image/png`]);
});

test("provider asserts the estimated bytes before persisting or submitting a different prepared body", async (t) => {
  const f = workspace(t);
  let submits = 0;
  const client = {
    createUpload: async () => {
      throw new Error("unexpected upload");
    },
    putUpload: async () => {},
    submit: async () => {
      submits++;
      return { request_id: "unexpected" };
    },
    status: async () => ({}),
  };
  const provider = createHiggsfieldJobProvider(client, { cache: f.cache, expectedBody: '{"prompt":"estimated"}' });
  await assert.rejects(
    provider.prepareInput!({ prompt: "changed" }, { uploads: [], persistUpload: () => {} }),
    /differs from the estimated request/,
  );
  await assert.rejects(
    provider.submit(endpoint, { prompt: "changed" }, { operationId: "stable", body: '{"prompt":"changed"}' }),
    /differs from the estimated request/,
  );
  assert.equal(submits, 0);
});

test("direct client estimate and submit serialise unsorted prepared objects identically", async () => {
  const bodies: string[] = [];
  const client = createHiggsfieldClient({
    credentials: "offline:secret",
    fetch: async (_url, init) => {
      bodies.push(String(init?.body));
      return Response.json({ request_id: "direct" });
    },
  });
  const input = {
    video_url: "https://cdn.higgsfield.ai/source.mp4",
    image_urls: ["https://cdn.higgsfield.ai/reference.png"],
    resolution: "480p",
    nested: { Z: 1, a: 2 },
  };
  await client.estimate(endpoint, input);
  await client.submit(endpoint, input, { idempotencyKey: "direct" });
  assert.equal(bodies[0], generationRequestBody(input));
  assert.equal(bodies[0], bodies[1]);
});

test("both client estimate and submit, and pricing estimate, refuse nested data URIs before fetch", async () => {
  let calls = 0;
  const request: typeof fetch = async () => {
    calls++;
    return Response.json({});
  };
  const client = createHiggsfieldClient({ credentials: "offline:secret", fetch: request });
  const input = { refs: [{ image_url: inline("image/png") }] };
  await assert.rejects(async () => client.estimate(endpoint, input), /public media URLs/);
  await assert.rejects(async () => client.submit(endpoint, input, { idempotencyKey: "stable" }), /public media URLs/);
  await assert.rejects(
    async () => client.estimate(endpoint, { [inline("image/png")]: "reference" }),
    /public media URLs/,
  );
  await assert.rejects(
    estimateHiggsfield(endpoint, input, (url, init) => request(url, init), { apiKey: "offline:secret" }),
    /public media URLs/,
  );
  assert.equal(calls, 0);
});

test("cache rejects invalid JSON, traversal and symlinks; failed uploads leave no cache entry", async (t) => {
  const f = workspace(t);
  await assert.rejects(
    f.cache.reuse(sourceSha, "image/png", async () => {
      throw new Error("PUT failed");
    }),
    /PUT failed/,
  );
  assert.equal(existsSync(f.cache.file), false);
  writeFileSync(f.cache.file, "{}");
  await assert.rejects(
    f.cache.reuse(sourceSha, "image/png", async () => "https://cdn.higgsfield.ai/x"),
    /Invalid pipeline/,
  );
  assert.throws(() => new HiggsfieldUploadCache("../escape", f.root), /Project ID/);
  rmSync(f.cache.file);
  const outside = path.join(f.root, "outside.json");
  writeFileSync(outside, "{}");
  symlinkSync(outside, f.cache.file);
  assert.throws(() => new HiggsfieldUploadCache("demo", f.root), /symlink/);
  rmSync(f.cache.file);
  rmSync(path.dirname(f.cache.file), { recursive: true });
  symlinkSync(path.dirname(outside), path.dirname(f.cache.file));
  assert.throws(() => new HiggsfieldUploadCache("demo", f.root), /symlink/);
});

function setupCli(t: TestContext) {
  const f = workspace(t);
  const callsFile = path.join(f.root, "calls.jsonl"),
    preload = path.join(f.root, "fake-fetch.mjs");
  writeFileSync(
    preload,
    `import {appendFileSync,readFileSync,existsSync} from 'node:fs';
process.env.HIGGSFIELD_API_KEY='offline:secret';
globalThis.fetch=async(url,init)=>{
  const route=String(url); appendFileSync(${JSON.stringify(callsFile)},JSON.stringify({url:route,method:init?.method,body:init?.method==='PUT'?null:init?.body})+'\\n');
  if(route.endsWith('/generate-upload-url')) { const n=readFileSync(${JSON.stringify(callsFile)},'utf8').split('/generate-upload-url').length-1; return Response.json({public_url:'https://cdn.higgsfield.ai/input-'+n,upload_url:'https://upload.example.test/put',upload_headers:{}}); }
  if(init?.method==='PUT')return new Response(null,{status:200});
  if(route.includes('/estimate/')) { if(existsSync('fail-estimate')) { const failure=readFileSync('fail-estimate','utf8'); if(failure==='network')throw new Error('interrupted'); return Response.json({detail:'estimate refused'},{status:Number(failure)}); } return Response.json({type:'estimate',usd:0.3}); }
  if(route==='https://api.higgsfield.ai/${endpoint}')return Response.json({request_id:'req-1'});
  if(route==='https://api.higgsfield.ai/requests/req-1/status')return Response.json({request_id:'req-1',status:'queued'});
  throw new Error('Unexpected offline route');
};`,
  );
  const cli = (script: string, args: string[]) => {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        tsx,
        "--import",
        path.join(repo, "tests/helpers/fal-no-network.ts"),
        "--import",
        preload,
        path.join(repo, "scripts", script),
        ...args,
      ],
      {
        cwd: f.root,
        encoding: "utf8",
        timeout: 60000,
        env: {
          AGENTBROS_NO_DOTENV: "1",
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
        },
      },
    );
    assert.equal(child.stdout.trim().split("\n").length, 1, child.stderr);
    return { status: child.status, result: JSON.parse(child.stdout) };
  };
  const calls = () =>
    existsSync(callsFile)
      ? readFileSync(callsFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  const requestFile = path.join(f.root, "request.json");
  return { ...f, calls, cli, requestFile };
}

test("CLI quote and generation prepare imported MP4/PNG once, admit the estimate, and resume without estimating", (t) => {
  const f = setupCli(t);
  const imported = (filename: string, args: string[]) => {
    const source = path.join(f.root, filename);
    const converted = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", ...args, source], { encoding: "utf8" });
    assert.equal(converted.status, 0, converted.stderr);
    return `asset://sha256/${importAsset({ projectId: "demo", rootDir: f.root, sourceFile: source, provenance: { origin: "manual" } }).asset.hash}`;
  };
  const input = {
    video_url: imported("source.mp4", [
      "-i",
      "testsrc2=s=32x32:r=10",
      "-t",
      "4",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
    ]),
    image_urls: [imported("reference.png", ["-i", "color=c=blue:s=32x32", "-frames:v", "1"])],
    resolution: "480p",
  };
  writeFileSync(f.requestFile, JSON.stringify({ provider: "higgsfield", endpoint, input }));
  const quoted = f.cli("hf-quote.ts", ["--request", f.requestFile, "--project", "demo", "--provider-estimate"]);
  assert.equal(quoted.result.ok, true, JSON.stringify(quoted.result));
  assert.equal(quoted.result.metadata.quote.expectedUsd, 0.3);
  assert.equal(existsSync(path.join(f.project, "pipeline/operations.json")), false);
  const run = (id: string) =>
    f.cli("generate-model.ts", [
      "--request",
      f.requestFile,
      "--project",
      "demo",
      "--provider-estimate",
      "--max-cost-usd",
      "0.40",
      "--operation-id",
      id,
      "--output",
      path.join(f.project, `assets/${id}.mp4`),
    ]);
  for (const id of ["first", "first", "second"]) {
    const result = run(id);
    assert.equal(result.result.ok, true, JSON.stringify(result.result));
    assert.equal(result.result.metadata.quote.expectedUsd, 0.3);
    assert.equal(result.result.metadata.quote.pricingEvidence.kind, "higgsfield-estimate");
  }
  const calls = f.calls();
  assert.equal(calls.filter((row) => row.url.endsWith("/generate-upload-url")).length, 2);
  const estimates = calls.filter((row) => row.url.includes("/estimate/"));
  const submits = calls.filter((row) => row.url === `https://api.higgsfield.ai/${endpoint}`);
  assert.equal(estimates.length, 3);
  assert.equal(submits.length, 2);
  for (const row of [...estimates, ...submits]) {
    assert.equal(row.body, estimates[0].body);
    assert.ok(!row.body.includes("data:"));
  }
  const store = new OperationStore("demo", { directory: path.join(f.project, "pipeline") });
  for (const job of Object.values(store.snapshot().jobs)) {
    assert.equal(job.uploads?.length, 2);
    assert.equal(job.requestBody, estimates[0].body);
    assert.equal(job.preparedInputHash, generationInputHash(JSON.parse(estimates[0].body)));
    assert.notEqual(job.preparedInputHash, job.inputHash);
  }
  assert.equal(store.summary().reservedUsd, 0.6);
  assert.equal(existsSync(path.join(f.project, "pipeline/cost-ledger.jsonl")), false);
});

for (const [failure, code] of [
  ["413", "VALIDATION"],
  ["400", "VALIDATION"],
  ["503", "NETWORK"],
  ["network", "NETWORK"],
]) {
  test(`CLI estimate failure ${failure} creates no job, reservation or charge`, (t) => {
    const f = setupCli(t);
    writeFileSync(
      f.requestFile,
      JSON.stringify({
        provider: "higgsfield",
        endpoint,
        input: { video_url: inline("video/mp4"), image_urls: [inline("image/png")], resolution: "480p" },
      }),
    );
    writeFileSync(path.join(f.root, "fail-estimate"), failure);
    const { status, result } = f.cli("generate-model.ts", [
      "--request",
      f.requestFile,
      "--project",
      "demo",
      "--provider-estimate",
      "--max-cost-usd",
      "0.40",
      "--output",
      path.join(f.project, "assets/out.mp4"),
    ]);
    assert.notEqual(status, 0);
    assert.equal(result.ok, false);
    assert.equal(result.error, code, JSON.stringify(result));
    assert.match(result.message, /Higgsfield pricing/);
    assert.equal(existsSync(path.join(f.project, "pipeline/operations.json")), false);
    assert.equal(existsSync(path.join(f.project, "pipeline/cost-ledger.jsonl")), false);
    assert.equal(f.calls().filter((row) => row.url.includes("/estimate/")).length, 1);
    assert.equal(
      f.calls().some((row) => row.url === `https://api.higgsfield.ai/${endpoint}`),
      false,
    );
  });
}

test("hf:quote without project refuses imported, local and inline inputs before fetch; remote URLs pass unchanged", (t) => {
  const f = setupCli(t);
  for (const input of [
    { video_url: `asset://sha256/${sourceSha}` },
    { image_urls: ["./reference.png"] },
    { video_url: "file:///tmp/source.mp4" },
    { image_url: inline("image/png") },
  ]) {
    writeFileSync(f.requestFile, JSON.stringify({ provider: "higgsfield", endpoint, input }));
    const { result } = f.cli("hf-quote.ts", ["--request", f.requestFile, "--provider-estimate"]);
    assert.equal(result.ok, false);
    assert.equal(result.error, "INVALID_INPUT");
    assert.match(result.message, /requires --project/);
  }
  assert.equal(f.calls().length, 0);
  const input = {
    video_url: "https://example.test/source.mp4",
    image_urls: ["https://example.test/ref.png"],
    resolution: "480p",
  };
  writeFileSync(f.requestFile, JSON.stringify({ provider: "higgsfield", endpoint, input }));
  const { result } = f.cli("hf-quote.ts", ["--request", f.requestFile, "--provider-estimate"]);
  assert.equal(result.ok, true);
  assert.equal(result.metadata.quote.expectedUsd, 0.3);
  assert.deepEqual(JSON.parse(f.calls()[0].body), input);
  assert.equal(f.calls().length, 1);
});
