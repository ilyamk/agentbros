import "./helpers/fal-no-network";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { importAsset } from "../src/lib/assets/registry";
import { importedReferenceMedia } from "../src/lib/assets/provider-references";
import {
  higgsfieldPricesFromFixtures,
  higgsfieldPricingFor,
  serialiseHiggsfieldPrices,
  estimateHiggsfield,
} from "../src/lib/models/hf-pricing";
import { quote } from "../src/lib/pricing";
import { executeFalOperation } from "../src/lib/jobs/execution";
import { quoteInputForPlan } from "../src/lib/providers/fal-quote-input";
import { HiggsfieldPricingEvidenceSchema, higgsfieldPricingEvidenceDigest } from "../src/types/pricing-evidence";
import { assertCurrentHiggsfieldPricingEvidence } from "../src/lib/models/pricing-evidence";
import { buildFalOperation } from "../src/lib/providers/fal-operations";
import { generationInputHash } from "../src/lib/jobs/runner";
import { OperationStore } from "../src/lib/jobs/store";
import { USER_GRANT, writeBudgetBrief } from "./helpers/ceiling-grant";

const repo = path.resolve(import.meta.dirname, "..");
const tsx = createRequire(path.join(repo, "package.json")).resolve("tsx");
const light = "higgsfield/genjutsu-light/motion-transfer/v1.0";
const fixtures = higgsfieldPricesFromFixtures(
  JSON.parse(readFileSync(path.join(repo, "tests/fixtures/higgsfield/estimates.json"), "utf8")),
  JSON.parse(readFileSync(path.join(repo, "tests/fixtures/higgsfield/catalog-models.json"), "utf8")),
);
function workspace(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "hf-live-regression-"));
  mkdirSync(path.join(root, "public/projects/demo"), { recursive: true });
  writeFileSync(path.join(root, "public/projects/demo/project.json"), "{}");
  writeBudgetBrief(path.join(root, "public/projects/demo"));
  const prices = path.join(root, "prices.json");
  writeFileSync(prices, serialiseHiggsfieldPrices(fixtures.records, "2026-11-15"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, prices };
}
function cli(root: string, prices: string, script: string, args: string[], preload?: string) {
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      tsx,
      "--import",
      path.join(repo, "tests/helpers/fal-no-network.ts"),
      ...(preload ? ["--import", preload] : []),
      path.join(repo, "scripts", script),
      ...args,
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 60000,
      env: {
        AGENTBROS_NO_DOTENV: "1",
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
        AGENTBROS_HF_PRICES: prices,
      },
    },
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(child.stdout.trim().split("\n").length, 1);
  const result = JSON.parse(child.stdout);
  assert.equal(result.ok, true);
  return result.metadata;
}

test("imported measured media bounds hf:quote and schema-less generate:model dry-runs offline", (t) => {
  const { root, prices } = workspace(t);
  const generate = (file: string, args: string[]) => {
    const result = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", ...args, path.join(root, file)], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return importAsset({
      projectId: "demo",
      rootDir: root,
      sourceFile: path.join(root, file),
      provenance: { origin: "manual" },
    }).asset;
  };
  const video = generate("source.mp4", [
    "-i",
    "testsrc2=s=128x128:r=10",
    "-t",
    "4.1",
    "-c:v",
    "libx264",
    "-crf",
    "0",
    "-pix_fmt",
    "yuv420p",
  ]);
  assert.ok(video.files.bytes > 32 * 1024, "The imported video must exceed the evidence string bound");
  const image = generate("reference.png", ["-i", "color=c=blue:s=32x32", "-frames:v", "1"]);
  const input = {
    video_url: `asset://sha256/${video.hash}`,
    image_urls: [`asset://sha256/${image.hash}`],
    resolution: "480p",
  };
  const file = path.join(root, "request.json");
  writeFileSync(file, JSON.stringify({ provider: "higgsfield", endpoint: light, input }));
  const media = importedReferenceMedia(input, "demo", root);
  assert.deepEqual(media[input.video_url], {
    contentType: "video/mp4",
    bytes: video.files.bytes,
    width: 128,
    height: 128,
    durationSec: 4.1,
    fps: 10,
  });
  assert.equal(
    Object.values(media[input.image_urls[0]!]!).some((value) => value === undefined),
    false,
  );
  assert.deepEqual(importedReferenceMedia({ video_url: "https://example.test/remote.mp4" }, "demo", root), {});
  const quoted = cli(root, prices, "hf-quote.ts", ["--project", "demo", "--request", file]);
  assert.equal(quoted.quote.expectedUsd, 5 * 0.0739);
  const dry = (flags: string[] = []) =>
    cli(root, prices, "generate-model.ts", [
      "--project",
      "demo",
      "--request",
      file,
      "--output",
      path.join(root, "public/projects/demo/assets/x.mp4"),
      "--dry-run",
      ...flags,
    ]);
  for (const flags of [[], ["--provider-estimate"]]) {
    const result = dry(flags);
    assert.equal(result.plan.verification.schema, false);
    assert.match(result.plan.input.video_url, /^data:video\/mp4;base64,/);
    assert.equal(result.executable, false);
    assert.equal(result.quote.expectedUsd, 5 * 0.0739);
    assert.match(result.nextAction, /--provider-estimate.*--allow-unvalidated/);
  }
  assert.equal(dry(["--allow-unvalidated"]).executable, true);
  writeFileSync(
    file,
    JSON.stringify({
      provider: "higgsfield",
      endpoint: "higgsfield/genjutsu/motion-transfer/v1.0",
      input,
      context: { media: { [input.video_url]: { durationSec: 99 } } },
    }),
  );
  assert.equal(cli(root, prices, "hf-quote.ts", ["--project", "demo", "--request", file]).quote.expectedUsd, 5 * 0.154);
  assert.equal(dry().quote.expectedUsd, 5 * 0.154);
});

test("only Genjutsu Light derives capped, ceiled output seconds from measured source", () => {
  const record = fixtures.records.find((row) => row.endpoint === light)!;
  const input = { video_url: "https://example.test/source.mp4", resolution: "480p", duration: 99 };
  for (const [durationSec, seconds] of [
    [4, 4],
    [4.01, 5],
    [14.2, 15],
    [18.2, 15],
  ]) {
    const result = higgsfieldPricingFor(record, input, { media: { [input.video_url]: { durationSec } } });
    assert.deepEqual(result.pricing, { kind: "fixed", usdPerUnit: seconds! * 0.0739, quantity: "request" });
  }
  assert.equal(higgsfieldPricingFor(record, input).pricing.kind, "unknown");
  assert.equal(
    higgsfieldPricingFor(
      { ...record, endpoint: "test/other-output" },
      { ...input, duration: undefined },
      { media: { [input.video_url]: { durationSec: 4 } } },
    ).pricing.kind,
    "unknown",
  );
});

test("exact free estimates supply admission evidence, discount conservatism and one ledger row on resume", async (t) => {
  const { root, prices } = workspace(t);
  const oldCwd = process.cwd(),
    oldPrices = process.env.AGENTBROS_HF_PRICES;
  process.chdir(root);
  process.env.AGENTBROS_HF_PRICES = prices;
  t.after(() => {
    process.chdir(oldCwd);
    if (oldPrices === undefined) delete process.env.AGENTBROS_HF_PRICES;
    else process.env.AGENTBROS_HF_PRICES = oldPrices;
  });
  new OperationStore("demo").configure({ ceilingUsd: 2, maxJobUsd: 2, repairReserveFraction: 0 }, USER_GRANT);
  const endpoint = "higgsfield-ai/soul/v2/standard";
  const input = { prompt: "A request not in the stored samples", batch_size: 1 };
  assert.equal(quote({ provider: "higgsfield", model: endpoint, providerInput: input }).bounded, false);
  let estimates = 0;
  await estimateHiggsfield(
    endpoint,
    input,
    async (_url, init) => {
      estimates++;
      assert.deepEqual(JSON.parse(init.body!), input);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ type: "estimate", usd: 0.004, discount: { usd: 0.004, percentage: 50 } }),
      };
    },
    { apiKey: "offline:secret", maxRetries: 0 },
  );
  const quoted = quote({ provider: "higgsfield", model: endpoint, providerInput: input });
  assert.equal(quoted.expectedUsd, 0.008);
  assert.equal(quoted.pricingEvidence?.kind, "higgsfield-estimate");
  assert.equal(
    quote({ provider: "higgsfield", model: endpoint, providerInput: { ...input, batch_size: 2 } }).bounded,
    false,
  );
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  let submits = 0;
  const options = {
    providerId: "higgsfield" as const,
    projectId: "demo",
    endpoint,
    model: endpoint,
    input,
    mediaKind: "image" as const,
    output: path.join(root, "public/projects/demo/assets/out.png"),
    assetId: "character",
    operationId: "regression:estimate",
    quoteInput: quoteInputForPlan(buildFalOperation({ provider: "higgsfield", endpoint, input }), input),
    provider: {
      submit: async () => {
        submits++;
        return { requestId: "one" };
      },
      inspect: async () => ({
        state: "completed" as const,
        result: { images: [{ url: "https://cdn.higgsfield.ai/image.png" }] },
      }),
    },
    fetch: async () => new Response(png),
  };
  assert.equal((await executeFalOperation(options)).metadata.state, "published");
  assert.equal((await executeFalOperation(options)).metadata.state, "published");
  assert.equal(submits, 1);
  assert.equal(estimates, 1);
  const rows = readFileSync(path.join(root, "public/projects/demo/pipeline/cost-ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].assetId, "character");
  assert.equal(rows[0].estimatedUsd, 0.008);
  assert.equal(rows[0].actualUsd, null);
  assert.match(rows[0].notes, /Admitted quote expected USD/);
});

test("both CLI provider-estimate routes use the answer for the returned quote and admission", (t) => {
  const { root, prices } = workspace(t);
  const preload = path.join(root, "fake-fetch.mjs");
  writeFileSync(
    preload,
    `import {existsSync} from 'node:fs';process.env.HIGGSFIELD_API_KEY='offline:secret'; globalThis.fetch=async(url,init)=>{if(!String(url).includes('/estimate/'))throw new Error('Unexpected network route');if(existsSync(${JSON.stringify(path.join(root, "no-estimate"))}))throw new Error('Resume called the estimate API');return Response.json({type:'estimate',usd:0.004});};`,
  );
  for (const endpoint of ["higgsfield-ai/soul/v2/standard", "higgsfield/ai-influencer"]) {
    const file = path.join(root, "request.json");
    writeFileSync(
      file,
      JSON.stringify({ provider: "higgsfield", endpoint, input: { prompt: "An exact new prompt for the CLI" } }),
    );
    const quoted = cli(root, prices, "hf-quote.ts", ["--request", file, "--provider-estimate"], preload);
    assert.equal(quoted.quote.expectedUsd, 0.004);
    assert.equal(quoted.quote.pricingEvidence.kind, "higgsfield-estimate");
    // The fake submit is blocked after durable admission; inspect the retained admitted quote.
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        tsx,
        "--import",
        preload,
        path.join(repo, "scripts/generate-model.ts"),
        "--project",
        "demo",
        "--request",
        file,
        "--output",
        path.join(root, `public/projects/demo/assets/${endpoint.includes("influencer") ? "influencer" : "soul"}.png`),
        "--operation-id",
        endpoint.includes("influencer") ? "cli:influencer" : "cli:soul",
        "--provider-estimate",
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 60000,
        env: {
          AGENTBROS_NO_DOTENV: "1",
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
          AGENTBROS_HF_PRICES: prices,
        },
      },
    );
    const result = JSON.parse(child.stdout);
    assert.equal(result.ok, true, child.stdout || child.stderr);
    assert.equal(result.metadata.quote.expectedUsd, 0.004, child.stdout || child.stderr);
    assert.equal(result.metadata.quote.pricingEvidence.kind, "higgsfield-estimate");
    writeFileSync(path.join(root, "no-estimate"), "");
    const resumed = cli(
      root,
      prices,
      "generate-model.ts",
      [
        "--project",
        "demo",
        "--request",
        file,
        "--output",
        path.join(root, `public/projects/demo/assets/${endpoint.includes("influencer") ? "influencer" : "soul"}.png`),
        "--operation-id",
        endpoint.includes("influencer") ? "cli:influencer" : "cli:soul",
        "--provider-estimate",
      ],
      preload,
    );
    assert.equal(resumed.quote.expectedUsd, 0.004);
    rmSync(path.join(root, "no-estimate"));
  }
});

test("large exact estimate evidence remains bounded, seals the full input and needs private admission authority", async (t) => {
  const { root, prices } = workspace(t);
  const previous = process.env.AGENTBROS_HF_PRICES;
  process.env.AGENTBROS_HF_PRICES = prices;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENTBROS_HF_PRICES;
    else process.env.AGENTBROS_HF_PRICES = previous;
  });
  const endpoint = "test/large-estimate";
  const url = `https://cdn.higgsfield.ai/video.mp4?token=${"a".repeat(40 * 1024)}`;
  const input = { video_url: url, resolution: "480p" };
  await estimateHiggsfield(
    endpoint,
    input,
    async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ type: "estimate", usd: 0.3 }),
    }),
    { apiKey: "offline:secret" },
  );
  const quoteInput = {
    provider: "higgsfield" as const,
    providerInput: input,
    providerContext: { media: { [url]: { durationSec: 4.1 } } },
  };
  const quoted = quote({ model: endpoint, ...quoteInput });
  const evidence = quoted.pricingEvidence;
  assert.ok(evidence?.provider === "higgsfield");
  assert.equal(evidence.input, undefined);
  assert.deepEqual(evidence.media, {});
  assert.deepEqual(evidence.record.estimates[0]!.input, {});
  assert.ok(Buffer.byteLength(JSON.stringify(evidence)) < 32 * 1024);
  assert.equal(evidence.inputHash, generationInputHash(input));
  assert.deepEqual(HiggsfieldPricingEvidenceSchema.parse(JSON.parse(JSON.stringify(evidence))), evidence);
  assert.deepEqual(assertCurrentHiggsfieldPricingEvidence(evidence, endpoint), evidence);
  const { sha256: _sha256, ...payload } = evidence;
  const forged = { ...payload, inputHash: generationInputHash({ video_url: "different" }) };
  assert.throws(
    () =>
      assertCurrentHiggsfieldPricingEvidence({ ...forged, sha256: higgsfieldPricingEvidenceDigest(forged) }, endpoint),
    /issued in this process/,
  );
  input.video_url = "mutated after quote";
  assert.deepEqual(
    assertCurrentHiggsfieldPricingEvidence(evidence, endpoint),
    evidence,
    "The private original is immutable",
  );
  const cwd = process.cwd();
  process.chdir(root);
  t.after(() => process.chdir(cwd));
  new OperationStore("demo").configure({ ceilingUsd: 1, maxJobUsd: 1, repairReserveFraction: 0 }, USER_GRANT);
  const options = {
    providerId: "higgsfield" as const,
    projectId: "demo",
    endpoint,
    model: endpoint,
    input: { video_url: url, resolution: "480p" },
    mediaKind: "image" as const,
    output: path.join(root, "outside-project.png"),
    operationId: "large:estimate",
    quoteInput: { ...quoteInput, providerInput: { video_url: url, resolution: "480p" } },
    provider: {
      submit: async () => ({ requestId: "large" }),
      inspect: async () => ({
        state: "completed" as const,
        result: { images: [{ url: "https://cdn.higgsfield.ai/large.png" }] },
      }),
    },
    fetch: async () =>
      new Response(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
          "base64",
        ),
      ),
  };
  assert.equal((await executeFalOperation(options)).metadata.state, "published");
  const cost = JSON.parse(readFileSync(path.join(root, "public/projects/demo/pipeline/cost-ledger.jsonl"), "utf8"));
  assert.equal(cost.assetId, "outside-project.png");
  assert.equal(cost.estimatedUsd, 0.3);
});

test("unpriceable estimate descriptions require an explicit bound for admission", async (t) => {
  const { prices } = workspace(t);
  const previous = process.env.AGENTBROS_HF_PRICES;
  process.env.AGENTBROS_HF_PRICES = prices;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENTBROS_HF_PRICES;
    else process.env.AGENTBROS_HF_PRICES = previous;
  });
  const endpoint = "test/description-estimate",
    input = { prompt: "A new request" };
  await estimateHiggsfield(
    endpoint,
    input,
    async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        type: "description",
        pricing_description: "Token-metered pricing. Actual token usage is required.",
      }),
    }),
    { apiKey: "offline:secret" },
  );
  const options = {
    providerId: "higgsfield" as const,
    endpoint,
    model: endpoint,
    input,
    mediaKind: "image" as const,
    output: "/tmp/description.png",
    dryRun: true,
    quoteInput: { provider: "higgsfield" as const, providerInput: input },
  };
  assert.equal((await executeFalOperation(options)).metadata.executable, false);
  const bound = await executeFalOperation({ ...options, maxCostUsd: 0.5 });
  assert.equal(bound.metadata.executable, true);
  assert.equal((bound.metadata.quote as { expectedUsd: number }).expectedUsd, 0.5);
});
