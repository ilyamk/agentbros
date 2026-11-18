import { USER_GRANT } from "./helpers/ceiling-grant";
import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  rmdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { executeFalHttpStream } from "../src/lib/providers/stream/service";
import { createFalHttpStreamTransport } from "../src/lib/providers/stream/http";
import { OperationStore } from "../src/lib/jobs/store";
const original = process.cwd();
const root = mkdtempSync(path.join(tmpdir(), "http-stream-fixtures-"));
process.chdir(root);
const pngFile = path.join(root, "synthetic.png");
const generated = spawnSync("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=c=blue:s=32x32",
  "-frames:v",
  "1",
  "-y",
  pngFile,
]);
assert.equal(generated.status, 0);
const png = readFileSync(pngFile);
const inline = `data:image/png;base64,${png.toString("base64")}`;
const request = {
  family: "flux-2" as const,
  variant: "dev",
  operation: "text-to-image",
  transport: "stream" as const,
  input: { prompt: "Synthetic fixture, no provider calls" },
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function setup(id: string) {
  mkdirSync(`public/projects/${id}`, { recursive: true });
  writeFileSync(`public/projects/${id}/project.json`, "{}");
  const store = new OperationStore(id);
  store.configure({ ceilingUsd: 5, maxJobUsd: 2, repairReserveFraction: 0, maxPaidAttemptsPerAsset: 2 }, USER_GRANT);
  return {
    projectId: id,
    output: `public/projects/${id}/assets/image.png`,
    operationId: `stream:${id}`,
    maxCostUsd: 1,
    dryRun: false,
    request,
    store,
  };
}
let connects = 0;
let omitRequestId = false;
let responseType = "text/event-stream";
let handler: (response: ServerResponse) => Promise<unknown> | unknown;
const server = createServer(async (req, res) => {
  if (req.url === "/media") {
    res.setHeader("content-type", "image/png");
    res.end(png);
    return;
  }
  connects++;
  assert.equal(req.method, "POST");
  assert.equal(req.headers.accept, "text/event-stream");
  res.setHeader("content-type", responseType);
  if (!omitRequestId) res.setHeader("x-fal-request-id", "offline-request-" + connects);
  res.flushHeaders();
  await handler(res);
});
let base: string;
test.before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}`;
});
const transport = createFalHttpStreamTransport({
  credentials: "offline-fixture-only",
  fetch: (_url, init) => fetch(base + "/stream", init),
});
const mediaFetch: typeof fetch = (_url, init) => fetch(base + "/media", init);
test.after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.chdir(original);
  rmSync(root, { recursive: true, force: true });
});
test("real HTTP split UTF8/multiline SSE publishes exact inspected bytes and retains unknown invoice", async () => {
  handler = async (res) => {
    const event = Buffer.from('data: {"note":"Привет",\r\ndata: "images":[{"url":"' + inline + '"}]}\r\n\r\n');
    for (let i = 0; i < event.length; i += 7) {
      res.write(event.subarray(i, i + 7));
      await delay(1);
    }
    res.end();
  };
  const options = setup("split");
  const before = connects;
  const result = await executeFalHttpStream({ ...options, transport });
  assert.equal(result.metadata.state, "published");
  assert.equal(connects, before + 1);
  assert.deepEqual(readFileSync(options.output), png);
  assert.equal(result.metadata.billing, null);
  assert.equal(options.store.summary().reservedUsd, 1);
  const resumed = await executeFalHttpStream({ ...options, transport });
  assert.equal(resumed.metadata.state, "published");
  assert.equal(connects, before + 1);
  assert.equal(existsSync(`public/projects/split/pipeline/streams`), false);
  const privateRoot = ".cache/paid-responses/split/streams";
  const directory = path.join(privateRoot, readdirSync(privateRoot)[0]);
  const checkpoint = JSON.parse(readFileSync(path.join(directory, "checkpoint.json"), "utf8"));
  assert.equal(checkpoint.complete, true);
  assert.equal(checkpoint.events, 1);
  options.store.reconcileBilling(options.operationId, {
    receiptId: "actual-fixture-receipt",
    actualUsd: 0.42,
    source: "supplied offline billing fixture",
    confirmedAt: new Date().toISOString(),
  });
  assert.equal(options.store.summary().settledUsd, 0.42);
});
test("network truncation/cancellation retain paid intent, private partial evidence, no reconnect on restart", async () => {
  handler = async (res) => {
    res.write('data: {"step":1}\n\n');
    await delay(30);
    res.destroy();
  };
  const options = setup("interrupted");
  const before = connects;
  await assert.rejects(executeFalHttpStream({ ...options, transport }), /unresolved/);
  assert.equal(options.store.snapshot().jobs[options.operationId].state, "unknown");
  assert.equal(options.store.summary().reservedUsd, 1);
  const result = await executeFalHttpStream({ ...options, transport });
  assert.equal(result.metadata.state, "unknown");
  assert.equal(connects, before + 1);
  assert.equal(result.outputs.length, 0);
  handler = async (res) => {
    res.write('data: {"step":1}\n\n');
    await delay(100);
    if (!res.destroyed) res.end();
  };
  const cancel = setup("cancelled");
  const controller = new AbortController();
  const call = executeFalHttpStream({ ...cancel, transport, signal: controller.signal });
  await delay(15);
  controller.abort();
  await assert.rejects(call, /unresolved/);
  assert.equal(cancel.store.snapshot().jobs[cancel.operationId].state, "unknown");
});
test("limits, incomplete/error events, invalid media and timeout never make partial media complete", async () => {
  const cases: [string, (res: ServerResponse) => Promise<unknown> | unknown, Record<string, number>][] = [
    ["incomplete", (res) => res.end('data: {"images":[]}'), {}],
    ["error", (res) => res.end('data: {"error":"rejected"}\n\n'), {}],
    ["array", (res) => res.end("data: []\n\n"), {}],
    ["utf8", (res) => res.end(Buffer.from([0xff, 0xff, 10, 10])), {}],
    ["total", (res) => res.end(":" + "x".repeat(512) + "\n\n"), { totalBytes: 64 }],
    ["huge", (res) => res.end('data: {"padding":"' + "x".repeat(512) + '"}\n\n'), { eventBytes: 64 }],
    [
      "idle",
      async (res) => {
        await delay(100);
        if (!res.destroyed) res.end();
      },
      { idleMs: 10 },
    ],
  ];
  for (const [id, serve, limits] of cases) {
    handler = serve;
    const options = setup(id);
    await assert.rejects(executeFalHttpStream({ ...options, transport, limits }), /unresolved/);
    assert.equal(options.store.snapshot().jobs[options.operationId].state, "unknown");
    assert.equal(existsSync(options.output), false);
  }
  handler = (res) => res.end('data: {"images":[{"url":"data:image/png;base64,bm90LWltYWdl"}]}\n\n');
  const invalid = setup("invalid-image");
  await assert.rejects(executeFalHttpStream({ ...invalid, transport }));
  assert.equal(invalid.store.snapshot().jobs[invalid.operationId].state, "failed");
  assert.equal(invalid.store.summary().reservedUsd, 1);
  assert.equal(existsSync(invalid.output), false);
});
test("concurrent workers connect once, binary MIME works, download retry publishes without another charged request", async () => {
  handler = async (res) => {
    await delay(40);
    res.end('data: {"images":[{"url":"https://fal.media/offline-image.png"}]}\n\n');
  };
  const options = setup("concurrent");
  const before = connects;
  const first = executeFalHttpStream({ ...options, transport, fetch: mediaFetch });
  const second = await executeFalHttpStream({ ...options, transport, fetch: mediaFetch });
  assert.ok(["running", "submitting"].includes(String(second.metadata.state)));
  await first;
  assert.equal(connects, before + 1);
  const binary = setup("binary");
  responseType = "image/png";
  handler = (res) => res.end(png);
  const binaryResult = await executeFalHttpStream({ ...binary, transport });
  responseType = "text/event-stream";
  assert.equal(binaryResult.metadata.state, "published");
  assert.deepEqual(readFileSync(binary.output), png);
  handler = (res) => res.end('data: {"images":[{"url":"https://fal.media/offline-image.png"}]}\n\n');
  const retry = setup("download-retry");
  const chargedBefore = connects;
  await assert.rejects(
    executeFalHttpStream({ ...retry, transport, fetch: async () => new Response("", { status: 500 }) }),
  );
  const published = await executeFalHttpStream({ ...retry, transport, fetch: mediaFetch });
  assert.equal(published.metadata.state, "published");
  assert.equal(connects, chargedBefore + 1);
});
test("resource failures retain journal, cached result replays locally, and altered publication identity fails before connect", async () => {
  const options = setup("disk-publication");
  const before = connects;
  handler = (res) => {
    writeFileSync(`public/projects/${options.projectId}/assets`, "block-directory");
    res.end('data: {"images":[{"url":"' + inline + '"}]}\n\n');
  };
  await assert.rejects(executeFalHttpStream({ ...options, transport }));
  assert.equal(options.store.snapshot().jobs[options.operationId].state, "failed");
  assert.equal(options.store.summary().reservedUsd, 1);
  unlinkSync(`public/projects/${options.projectId}/assets`);
  const resumed = await executeFalHttpStream({ ...options, transport });
  assert.equal(resumed.metadata.state, "published");
  assert.equal(connects, before + 1);
  await assert.rejects(
    executeFalHttpStream({ ...options, output: `public/projects/${options.projectId}/different.png`, transport }),
    /different/,
  );
  assert.equal(connects, before + 1);
  const spool = setup("disk-checkpoint");
  const spoolBefore = connects;
  handler = async (res) => {
    await delay(15);
    const cacheRoot = `.cache/paid-responses/${spool.projectId}/streams`;
    const checkpoint = path.join(cacheRoot, readdirSync(cacheRoot)[0], "checkpoint.json");
    unlinkSync(checkpoint);
    mkdirSync(checkpoint);
    res.end('data: {"step":1}\n\n');
  };
  await assert.rejects(executeFalHttpStream({ ...spool, transport }), /unresolved/);
  assert.equal(spool.store.snapshot().jobs[spool.operationId].state, "unknown");
  assert.equal(spool.store.summary().reservedUsd, 1);
  assert.equal(connects, spoolBefore + 1);
});
test("complete private spool recovers after lost final commit, altered published bytes cannot be silently delivered", async () => {
  handler = (res) => res.end('data: {"images":[{"url":"' + inline + '"}]}\n\n');
  const options = setup("checkpoint-recovery");
  const before = connects;
  await executeFalHttpStream({ ...options, transport });
  // A crash after checkpoint fsync but before result-ready leaves only charged ownership in the journal.
  const snapshot = options.store.snapshot();
  snapshot.jobs[options.operationId].state = "unknown";
  delete snapshot.jobs[options.operationId].result;
  writeFileSync(options.store.file, JSON.stringify(snapshot));
  const recovered = await executeFalHttpStream({ ...options, transport });
  assert.equal(recovered.metadata.state, "published");
  assert.equal(connects, before + 1);
  assert.equal(options.store.snapshot().jobs[options.operationId].paidAttempts, 1);
  const rawRoot = `.cache/paid-responses/${options.projectId}/streams`;
  const rawFile = path.join(rawRoot, readdirSync(rawRoot)[0], "body.bin");
  const originalBody = readFileSync(rawFile);
  writeFileSync(rawFile, "tampered spool");
  await assert.rejects(executeFalHttpStream({ ...options, transport }), /immutable spool/);
  assert.equal(connects, before + 1);
  writeFileSync(rawFile, originalBody);
  writeFileSync(options.output, "altered");
  await assert.rejects(executeFalHttpStream({ ...options, transport }), /missing or changed/);
  assert.equal(connects, before + 1);
});
test("oversized completed spool fails before replay and pre-connect preparation remains safely retryable", async () => {
  handler = (res) => res.end('data: {"images":[{"url":"' + inline + '"}]}\n\n');
  const options = setup("oversized-restart");
  await executeFalHttpStream({ ...options, transport });
  const before = connects;
  const snapshot = options.store.snapshot();
  snapshot.jobs[options.operationId].state = "unknown";
  delete snapshot.jobs[options.operationId].result;
  writeFileSync(options.store.file, JSON.stringify(snapshot));
  const directory = path.join(
    `.cache/paid-responses/${options.projectId}/streams`,
    readdirSync(`.cache/paid-responses/${options.projectId}/streams`)[0],
  );
  writeFileSync(path.join(directory, "body.bin"), Buffer.alloc(32768));
  await assert.rejects(executeFalHttpStream({ ...options, transport, limits: { totalBytes: 4096 } }), /byte limits/);
  assert.equal(connects, before);
  assert.equal(options.store.summary().reservedUsd, 1);
  const preparation = setup("pre-connect-resource");
  const privateRoot = path.join(
    `.cache/paid-responses/${preparation.projectId}/streams`,
    createHash("sha256").update(preparation.operationId).digest("hex"),
  );
  mkdirSync(path.join(privateRoot, "checkpoint.json"), { recursive: true });
  await assert.rejects(executeFalHttpStream({ ...preparation, transport }), /not regular/);
  assert.equal(connects, before);
  assert.equal(preparation.store.snapshot().jobs[preparation.operationId].state, "reserved");
  assert.equal(preparation.store.snapshot().jobs[preparation.operationId].paidAttempts, 0);
  rmdirSync(path.join(privateRoot, "checkpoint.json"));
  writeFileSync(path.join(privateRoot, "body.bin"), "abandoned unsubmitted preparation");
  const result = await executeFalHttpStream({ ...preparation, transport });
  assert.equal(result.metadata.state, "published");
  assert.equal(connects, before + 1);
});
test("missing provider header uses completed local proof, never a fabricated request ID", async () => {
  omitRequestId = true;
  handler = (res) => res.end('data: {"images":[{"url":"' + inline + '"}]}\n\n');
  const options = setup("no-header");
  const before = connects;
  try {
    const result = await executeFalHttpStream({ ...options, transport });
    assert.equal(result.metadata.state, "published");
    assert.equal(result.metadata.providerRequestId, null);
    const job = options.store.snapshot().jobs[options.operationId];
    assert.equal(job.provider, "fal-stream");
    assert.equal(job.providerRequestId, undefined);
    assert.deepEqual(Object.keys(job.result!.streamProof as object).sort(), [
      "bodySha256",
      "complete",
      "providerRequestIdKnown",
    ]);
    assert.equal((job.result!.streamProof as any).providerRequestIdKnown, false);
    assert.match((job.result!.streamProof as any).bodySha256, /^[a-f0-9]{64}$/);
    await executeFalHttpStream({ ...options, transport });
    assert.equal(connects, before + 1);
  } finally {
    omitRequestId = false;
  }
  handler = (res) => res.end('data: {"images":[{"url":"' + inline + '"}],"streamProof":{"complete":true}}\n\n');
  const forged = setup("forged-proof");
  await assert.rejects(executeFalHttpStream({ ...forged, transport }), /unresolved/);
  assert.equal(forged.store.snapshot().jobs[forged.operationId].state, "unknown");
});
test("shared financial gate rejects incomplete, false header evidence, wrong checksums and wrong endpoints", () => {
  const store = setup("proof-negative").store;
  const proof = { bodySha256: "a".repeat(64), complete: true, providerRequestIdKnown: false };
  const cases = [
    { endpoint: "fal-ai/flux-2/stream", proof: { ...proof, complete: false } },
    { endpoint: "fal-ai/flux-2/stream", proof: { ...proof, providerRequestIdKnown: true } },
    { endpoint: "fal-ai/flux-2/stream", proof: { ...proof, bodySha256: "bad" } },
    { endpoint: "fal-ai/flux-2", proof },
  ];
  for (const [index, fixture] of cases.entries()) {
    const id = `proof:${index}`;
    store.reserveOperation({
      operationId: id,
      provider: "fal-stream",
      endpoint: fixture.endpoint,
      inputHash: "fixture-input",
      assetId: `fixture:${index}`,
      quote: {
        currency: "USD",
        lowUsd: 0,
        expectedUsd: 1,
        highUsd: 1,
        bounded: true,
        source: "explicit offline fixture bound",
        asOf: "2026-10-11",
        confidence: "user-bound",
      },
    });
    store.transitionJob(id, "submitting");
    assert.throws(
      () => store.transitionJob(id, "result-ready", { result: { streamProof: fixture.proof } }),
      /request ID/,
    );
    assert.equal(store.snapshot().jobs[id].state, "submitting");
  }
});
test("default CLI dry-run needs no credentials, changes no files, and validates exact transport", async () => {
  const requestFile = path.join(root, "request.json");
  writeFileSync(requestFile, JSON.stringify(request));
  const env = { ...process.env };
  delete env.FAL_KEY;
  delete env.ELEVENLABS_API_KEY;
  const child = spawnSync(
    process.execPath,
    [
      path.join(original, "node_modules/tsx/dist/cli.mjs"),
      path.join(original, "scripts/generate-stream.ts"),
      "--request",
      requestFile,
      "--output",
      "missing-project/image.png",
    ],
    { encoding: "utf8", env, cwd: root },
  );
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.metadata.dryRun, true);
  assert.equal(result.metadata.quote, null);
  assert.equal(existsSync("missing-project"), false);
  await assert.rejects(
    executeFalHttpStream({ request: { ...request, transport: "queue" }, output: "x.png" }),
    /exact stream/,
  );
  const before = connects;
  await assert.rejects(
    executeFalHttpStream({ request: { ...request, input: { prompt: "x".repeat(5 * 1024 * 1024) } }, output: "x.png" }),
    /4 MiB/,
  );
  assert.equal(connects, before);
  assert.equal(existsSync("x.png"), false);
  assert.equal(result.metadata.maxInputBytes, 4 * 1024 * 1024);
});
