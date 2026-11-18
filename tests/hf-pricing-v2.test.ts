import "./helpers/fal-no-network";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { HiggsfieldPriceTierSchema, type HiggsfieldPriceRecord } from "../src/types/higgsfield";
import {
  higgsfieldPricingFor,
  minimalHiggsfieldInput,
  parseHiggsfieldPricing,
  reparseHiggsfieldPrices,
  serialiseHiggsfieldPrices,
  syncHiggsfieldPrices,
} from "../src/lib/models/hf-pricing";
import { createHiggsfieldPricingEvidence } from "../src/lib/models/pricing-evidence";
import { PricingEvidenceSchema } from "../src/types/pricing-evidence";
import { validateJsonSchema, type JsonSchema } from "../src/lib/providers/json-schema-validate";

const descriptions = JSON.parse(
  readFileSync("tests/fixtures/higgsfield/pricing-descriptions-2026-11-15.json", "utf8"),
) as { endpoints: string[]; pricingDescription: string }[];
const catalogue: unknown = JSON.parse(readFileSync("tests/fixtures/higgsfield/catalog-models.json", "utf8"));
const dir = mkdtempSync(path.join(tmpdir(), "hf-pricing-v2-"));
process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
const now = new Date("2026-11-15T12:00:00Z");
function record(endpoint: string): HiggsfieldPriceRecord {
  const description = descriptions.find((row) => row.endpoints.includes(endpoint))!.pricingDescription;
  return {
    endpoint,
    list: null,
    estimates: [{ input: {}, type: "description", pricingDescription: description, observedAt: "2026-11-15" }],
    observedAsOf: "2026-11-15",
    ...parseHiggsfieldPricing(description),
  };
}
function schemaFromDoc(file: string): JsonSchema {
  const block = readFileSync(`tests/fixtures/higgsfield/docs/${file}`, "utf8")
    .split("Complete JSON schema")[1]!
    .match(/> ```json[^\n]*\n([\s\S]*?)\n> ```/)!;
  return JSON.parse(
    block[1]!
      .split("\n")
      .map((line) => line.replace(/^> ?/, ""))
      .join("\n"),
  ) as JsonSchema;
}
function cli(script: string, args: string[], prices: string) {
  const child = spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENTBROS_HF_PRICES: prices,
      HIGGSFIELD_API_KEY: undefined,
      NODE_OPTIONS: "--import ./tests/helpers/fal-no-network.ts",
    },
  });
  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
  assert.equal(child.stdout.trim().split("\n").length, 1);
  return JSON.parse(child.stdout) as {
    ok: boolean;
    metadata: {
      quote: { highUsd: number | null; notes: string; pricingEvidence?: unknown };
      before: { parsed: number; unknown: number };
      after: { parsed: number; unknown: number };
    };
  };
}

const rates = [
  [0.051, 0.105, 0.21, 0.1013, 0.2084, 0.4341],
  [0.0375, 0.075, 0.15, 0.0747, 0.1493, 0.3011],
  [0.0804, 0.1735, 0.4293, 0.8907],
  [0.0804, 0.1735, 0.4293, 0.8907, 0.0991, 0.2128, 0.5183, 1.0669],
  [0.1387, 0.3264, 0.7858],
  [0.1387, 0.3264, 0.7858],
  [],
  [],
  [0.318, 0.681, 1.632],
  [0.0779],
  [0.0523],
  [0.0945, 0.1263],
  [0.0945, 0.1263],
  [0.0945, 0.1252],
  [0.0945, 0.1252],
  [0.3151],
  [0.1189],
  [0.092],
  [0.13],
];
for (const [index, fixture] of descriptions.entries())
  test(`real description ${index + 1}: ${fixture.endpoints[0]}`, () => {
    const parsed = parseHiggsfieldPricing(fixture.pricingDescription);
    assert.deepEqual(
      parsed.tiers.map((tier) => tier.usdPerUnit),
      rates[index],
    );
    for (const tier of parsed.tiers) assert.deepEqual(HiggsfieldPriceTierSchema.parse(tier), tier);
    if (!parsed.tiers.length) {
      assert.match(parsed.unparsed!, /token-metered/);
      assert.ok(parsed.unparsed!.includes(fixture.pricingDescription), "retain all structured rates");
      assert.match(parsed.unparsed!, index === 7 ? /pixel dimensions/ : /actual token usage/);
    }
  });

test("additive tiers preserve old contracts and validate nearest rounding, caps, extras and approximate", () => {
  assert.equal(HiggsfieldPriceTierSchema.parse({ usdPerUnit: 1, basis: "request" }).rounding, null);
  const tier = {
    when: {},
    usdPerUnit: 1,
    basis: "source-second",
    rounding: "nearest-second",
    capSeconds: 10,
    approximate: true,
    extras: [{ field: "image_urls", includedCount: 5, usdPerExtra: 0.08 }],
  };
  assert.deepEqual(HiggsfieldPriceTierSchema.parse(tier), tier);
  for (const bad of [
    { capSeconds: 0 },
    { approximate: false },
    { rounding: "floor-second" },
    { extras: [{ field: "image_urls", includedCount: -1, usdPerExtra: 1 }] },
  ])
    assert.equal(HiggsfieldPriceTierSchema.safeParse({ ...tier, ...bad }).success, false);
});

test("unknown and almost matching grammar never creates a partial rate", () => {
  for (const fixture of descriptions.filter((row) => !/^(Token-metered|Per 1M)/.test(row.pricingDescription))) {
    const parsed = parseHiggsfieldPricing(`${fixture.pricingDescription} Audio adds $1.`);
    assert.equal(parsed.tiers.length, 0);
    assert.ok(parsed.unparsed);
  }
  const conditional = descriptions[0]!.pricingDescription;
  assert.equal(parseHiggsfieldPricing(conditional.replace("seconds.", "seconds!")).tiers.length, 0);
  assert.equal(parseHiggsfieldPricing(descriptions[2]!.pricingDescription.replace("4K:", "720p:")).tiers.length, 0);
});

const source = "https://samples.test/source.mp4";
const image = "https://samples.test/image.png";
const quoteCases: {
  name: string;
  endpoint: string;
  input: Record<string, unknown>;
  seconds?: number;
  expected: number;
  approximate?: boolean;
}[] = [
  {
    name: "4K",
    endpoint: "bytedance/seedance-2.0/text-to-video",
    input: { resolution: "4K", duration: 5 },
    expected: 0.8907 * 5,
  },
  {
    name: "single 4K",
    endpoint: "kling-video/v3.0/4k/text-to-video",
    input: { resolution: "4K", duration: 5 },
    expected: 0.3151 * 5,
  },
  {
    name: "image and audio alone",
    endpoint: "bytedance/seedance-2.0/reference-to-video",
    input: {
      resolution: "720p",
      duration: 4,
      image_urls: [image],
      audio_urls: ["https://samples.test/audio.wav"],
      $videoInput: "present",
    },
    expected: 0.1735 * 4,
  },
  {
    name: "video references",
    endpoint: "bytedance/seedance-2.0/reference-to-video",
    input: { resolution: "720p", duration: 4, video_urls: [source], $videoInput: "absent" },
    expected: 0.2128 * 4,
  },
  {
    name: "empty video references",
    endpoint: "alibaba/wan-3.0/reference-to-video",
    input: { resolution: "480p", duration: 4, video_urls: [] },
    expected: 0.0375 * 4,
  },
  {
    name: "singular video field",
    endpoint: "alibaba/wan-3.0-prime/reference-to-video",
    input: { resolution: "1080p", duration: 5, reference_video_url: source },
    expected: 0.4341 * 5,
  },
  {
    name: "primary input ceil",
    endpoint: "bytedance/seedance-2.5/video-edit",
    input: { resolution: "480p", duration: 99, video_url: source, video_urls: ["https://samples.test/reference.mp4"] },
    seconds: 4.01,
    expected: 0.1387 * 5,
  },
  {
    name: "extension requested duration",
    endpoint: "bytedance/seedance-2.5/video-extend",
    input: { resolution: "480p", duration: 4, video_url: source },
    seconds: 19,
    expected: 0.1387 * 4,
  },
  {
    name: "nearest down",
    endpoint: "kling-video/motion-control/pro",
    input: { resolution: "1080p", video_url: source },
    seconds: 4.49,
    expected: 0.0779 * 4,
  },
  {
    name: "nearest up",
    endpoint: "kling-video/v3/motion-control/std",
    input: { resolution: "720p", video_url: source },
    seconds: 4.5,
    expected: 0.092 * 5,
  },
  {
    name: "15 second cap",
    endpoint: "kling-video/o3/video-edit",
    input: { resolution: "720p", video_urls: [source] },
    seconds: 15.5,
    expected: 0.0945 * 15,
  },
  {
    name: "10 second cap",
    endpoint: "kling-video/omni/video-edit",
    input: { resolution: "1080p", video_urls: [source] },
    seconds: 14.5,
    expected: 0.1252 * 10,
  },
  {
    name: "custom shot sum",
    endpoint: "kling-video/v3.0/4k/text-to-video",
    input: {
      resolution: "4K",
      duration: 15,
      multi_shots: true,
      multi_prompt: [
        { prompt: "one", duration: 2 },
        { prompt: "two", duration: 3 },
      ],
    },
    expected: 0.3151 * 5,
  },
  {
    name: "custom shot total overrides requested duration",
    endpoint: "kling-video/v3.0/4k/image-to-video",
    input: {
      resolution: "4K",
      duration: 15,
      image_url: image,
      multi_shots: true,
      multi_prompt: [
        { prompt: "one", duration: 3 },
        { prompt: "two", duration: 4 },
      ],
    },
    expected: 0.3151 * 7,
  },
  {
    name: "approximate ceil with margin",
    endpoint: "higgsfield/genjutsu/restyle/v1.0",
    input: { resolution: "480p", video_url: source },
    seconds: 8.1,
    expected: 0.318 * 9 * 1.25,
    approximate: true,
  },
  {
    name: "approximate trimmed duration",
    endpoint: "higgsfield/genjutsu/restyle/v1.0",
    input: { resolution: "720p", video_url: source },
    seconds: 35,
    expected: 0.681 * 30 * 1.25,
    approximate: true,
  },
  ...[0, 5, 7].map((count) => ({
    name: `${count} reference images`,
    endpoint: "minimax/h3/reference-to-video",
    input: { resolution: "2K", duration: 5, image_urls: Array.from({ length: count }, () => image) },
    expected: 0.13 * 5 + Math.max(0, count - 5) * 0.08,
  })),
];
for (const scenario of quoteCases)
  test(`hf:quote request JSON: ${scenario.name}`, () => {
    const row = record(scenario.endpoint);
    const context = {
      now,
      ...(scenario.seconds === undefined ? {} : { media: { [source]: { durationSec: scenario.seconds } } }),
    };
    const result = higgsfieldPricingFor(row, scenario.input, context);
    assert.equal(result.pricing.kind, "fixed");
    assert.equal(result.pricing.kind === "fixed" && result.pricing.usdPerUnit, scenario.expected);
    const evidence = createHiggsfieldPricingEvidence(row, scenario.input, context)!;
    assert.deepEqual(PricingEvidenceSchema.parse(evidence), evidence);
    const prices = path.join(dir, "prices.json"),
      request = path.join(dir, "request.json");
    writeFileSync(prices, serialiseHiggsfieldPrices([row], "2026-11-15"));
    writeFileSync(
      request,
      JSON.stringify({
        provider: "higgsfield",
        endpoint: row.endpoint,
        input: scenario.input,
        context: { media: context.media },
      }),
    );
    const quoted = cli("scripts/hf-quote.ts", ["--request", request], prices).metadata.quote;
    assert.equal(quoted.highUsd, scenario.expected);
    if ("approximate" in scenario && scenario.approximate) assert.match(quoted.notes, /Approximate.*\+25%/);
  });

test("hf:quote refuses missing measurements, unsupported multi-shot fields and unresolved tokens", () => {
  const cases = [
    ...[false, undefined].map((enabled) => ({
      endpoint: "kling-video/v3.0/4k/text-to-video",
      input: {
        resolution: "4K",
        duration: 15,
        ...(enabled === undefined ? {} : { multi_shots: enabled }),
        multi_prompt: [{ prompt: "one", duration: 1 }],
      },
      reason: /multi_shots/,
    })),
    {
      endpoint: "kling-video/o3/video-edit",
      input: {
        resolution: "720p",
        video_urls: [source],
        multi_shots: true,
        multi_prompt: [{ prompt: "one", duration: 1 }],
      },
      reason: /multi_prompt/,
    },
    {
      endpoint: "kling-video/v3.0/4k/text-to-video",
      input: { resolution: "4K", duration: 15, multi_prompt: "invalid" },
      reason: /multi_prompt/,
    },
    {
      endpoint: "bytedance/seedance-2.5/video-extend",
      input: { resolution: "480p", duration: 0, video_url: source },
      reason: /duration/,
    },
    {
      endpoint: "kling-video/motion-control/pro",
      input: { resolution: "1080p", duration: 8, video_url: source },
      reason: /measured source/,
    },
    { endpoint: "kling-video/o3/video-edit", input: { resolution: "720p", multi_shots: true }, reason: /multi_prompt/ },
    {
      endpoint: "kling-video/o3/video-reference",
      input: { resolution: "720p", duration: 5, shots: [{ duration: 3 }] },
      reason: /multi-shot/,
    },
    {
      endpoint: "minimax/h3/reference-to-video",
      input: { resolution: "2K", duration: 5, image_urls: 7 },
      reason: /Array count/,
    },
    {
      endpoint: "higgsfield/cinema-studio/4.0",
      input: { resolution: "720p", aspect_ratio: "16:9", duration: 5 },
      reason: /pixel dimensions/,
    },
    { endpoint: "higgsfield/ads-studio/v1.0", input: {}, reason: /actual token usage/ },
  ];
  for (const [index, scenario] of cases.entries()) {
    const prices = path.join(dir, `unknown-${index}.json`),
      request = path.join(dir, `unknown-request-${index}.json`);
    writeFileSync(prices, serialiseHiggsfieldPrices([record(scenario.endpoint)], "2026-11-15"));
    writeFileSync(
      request,
      JSON.stringify({ provider: "higgsfield", endpoint: scenario.endpoint, input: scenario.input }),
    );
    const quoted = cli("scripts/hf-quote.ts", ["--request", request], prices).metadata.quote;
    assert.equal(quoted.highUsd, null);
    assert.match(quoted.notes, scenario.reason);
  }
});

test("offline reparse rebuilds all stored observations, preserves numeric answers and is idempotent", () => {
  const rows: HiggsfieldPriceRecord[] = descriptions.flatMap((fixture) =>
    fixture.endpoints.map((endpoint) => ({ ...record(endpoint), tiers: [], unparsed: "old parser" })),
  );
  const numeric: HiggsfieldPriceRecord = {
    endpoint: "test/numeric",
    list: null,
    tiers: [],
    estimates: [{ input: { prompt: "x" }, type: "estimate", usd: 0.1, observedAt: "2026-11-15" }],
    observedAsOf: "2026-11-15",
  };
  rows.push(
    numeric,
    { ...numeric, endpoint: "test/failed", estimates: [] },
    { ...numeric, endpoint: "v1/custom-references", estimates: [] },
  );
  const rebuilt = reparseHiggsfieldPrices(rows);
  assert.deepEqual(
    rebuilt.find((row) => row.endpoint === numeric.endpoint),
    numeric,
  );
  assert.deepEqual(reparseHiggsfieldPrices(rebuilt), rebuilt);
  const file = path.join(dir, "reparse-prices.json");
  writeFileSync(file, serialiseHiggsfieldPrices(rows, "2026-11-15"));
  const envelope = cli("scripts/hf-pricing.ts", ["--reparse", "--dry-run"], file);
  assert.equal(envelope.metadata.before.parsed, 1);
  assert.equal(envelope.metadata.after.unknown, 6);
  assert.equal(readFileSync(file, "utf8"), serialiseHiggsfieldPrices(rows, "2026-11-15"));
  cli("scripts/hf-pricing.ts", ["--reparse"], file);
  assert.equal(readFileSync(file, "utf8"), serialiseHiggsfieldPrices(rebuilt, "2026-11-15"));
});

test("minimal builder chooses a satisfiable reference branch for the provided samples", () => {
  const schema = schemaFromDoc("models_seedance-2-5_reference-to-video.md");
  for (const samples of [{ image }, { video: source }, { audio: "https://samples.test/audio.wav" }]) {
    const input = minimalHiggsfieldInput(schema, samples);
    validateJsonSchema(schema, input, { components: {}, strict: false });
    for (const kind of ["image", "video", "audio"] as const)
      assert.equal(Object.hasOwn(input, `${kind}_urls`), kind in samples);
  }
  const input = minimalHiggsfieldInput(schema, { image, video: source });
  assert.deepEqual(input.image_urls, [image]);
  assert.equal(Object.hasOwn(input, "audio_urls"), false);
});

test("next sync sends recorded prompt-only Kling inputs, skips training, and checkpoints HTTP 400 detail", async () => {
  const checkpointFile = path.join(dir, "sync.jsonl");
  const endpoints = [
    "kling-video/v4.0/text-to-video",
    "kling-video/v4.0-flash/text-to-video",
    "v1/custom-references",
    "higgsfield-ai/soul/standard",
  ];
  const calls: string[] = [];
  const result = await syncHiggsfieldPrices(
    endpoints.map((endpoint) => ({
      endpoint,
      ...(endpoint.includes("/soul/") ? { schema: schemaFromDoc("models_soul-standard_generate.md") } : {}),
    })),
    async (url, init) => {
      calls.push(url);
      const input: unknown = JSON.parse(init.body!);
      if (url.includes("kling-video/")) assert.deepEqual(input, { prompt: "a red fox in snow" });
      const status = url.includes("/soul/") ? 400 : 200;
      return {
        ok: status === 200,
        status,
        headers: { get: () => null },
        json: async () => (status === 400 ? { detail: "style_id is unavailable" } : { type: "estimate", usd: 0.1 }),
      };
    },
    { apiKey: "offline-id:offline-secret", catalogue, now, checkpointFile },
  );
  assert.equal(calls.length, 3);
  assert.ok(calls.every((url) => !url.includes("custom-references")));
  assert.deepEqual(result.failed, [
    { endpoint: "higgsfield-ai/soul/standard", reason: "Higgsfield pricing HTTP 400. style_id is unavailable" },
  ]);
  assert.equal(
    result.records.find((row) => row.endpoint === "v1/custom-references")!.unparsed,
    "training; no estimate route",
  );
  assert.match(readFileSync(checkpointFile, "utf8"), /style_id is unavailable/);
  assert.ok(!readFileSync(checkpointFile, "utf8").includes("secret"));
});
