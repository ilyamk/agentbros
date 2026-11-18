import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildFalOperation, requireExecutableFalOperation } from "../src/lib/providers/fal-operations";
import { applyFalGuards, falGuardContext } from "../src/lib/providers/fal-guards/all";
import { executeFalOperation } from "../src/lib/jobs/execution";
import { quoteInputForPlan } from "../src/lib/providers/fal-quote-input";
import type { FalOperationContext } from "../src/types/generation";

const video = "https://example.com/source.mp4",
  image = "https://example.com/reference.png";
const prefix = "higgsfield/genjutsu";
const preset = JSON.parse(readFileSync("tests/fixtures/higgsfield/restyle-presets.json", "utf8")).response.items[0]
  .id as string;
const request = (endpoint: string, input: Record<string, unknown>, context?: FalOperationContext) => ({
  provider: "higgsfield" as const,
  endpoint,
  input,
  context,
});
const plan = (endpoint: string, input: Record<string, unknown>, context?: FalOperationContext) =>
  buildFalOperation(request(endpoint, input, context));
const source = (durationSec: number, extra = {}) => ({ media: { [video]: { durationSec, ...extra } } });

for (const operation of ["motion-transfer", "object-swap", "restyle"]) {
  const endpoint = `${prefix}/${operation}/v1.0`;
  const input =
    operation === "restyle" ? { video_url: video, preset_id: preset } : { video_url: video, image_urls: [image] };
  test(`${operation}: source duration minimum, trimming and unknown metadata`, () => {
    assert.throws(() => plan(endpoint, input, source(3.99)), /at least 4 seconds/);
    assert.doesNotThrow(() => plan(endpoint, input, source(4, { width: 640, height: 640 })));
    const trimmed = plan(endpoint, input, source(30.01)).warnings;
    if (operation === "restyle")
      assert.ok(trimmed.some((w) => /source and audio are trimmed.*30 seconds.*duration and FPS may differ/.test(w)));
    else assert.ok(trimmed.some((w) => /trimmed to 30 seconds.*prepared source duration, rounded up/.test(w)));
    assert.ok(!plan(endpoint, input, source(30)).warnings.some((w) => /trimmed/.test(w)));
    assert.ok(
      plan(endpoint, input, { media: { [video]: { bytes: 10 } } }).warnings.some((w) =>
        /source duration is unknown/.test(w),
      ),
    );
  });
  test(`${operation}: reference count boundaries are encoded by its schema`, () => {
    const max = operation === "restyle" ? 5 : 8;
    for (const count of [1, max])
      assert.doesNotThrow(() => plan(endpoint, { ...input, image_urls: Array(count).fill(image) }));
    assert.throws(() => plan(endpoint, { ...input, image_urls: Array(max + 1).fill(image) }));
    if (operation !== "restyle") assert.throws(() => plan(endpoint, { ...input, image_urls: [] }));
    else assert.doesNotThrow(() => plan(endpoint, { ...input, image_urls: [] }));
  });
}

test("object-swap pixel minimum applies to video, never reference images", () => {
  const endpoint = `${prefix}/object-swap/v1.0`,
    input = { video_url: video, image_urls: [image] };
  assert.throws(() => plan(endpoint, input, source(4, { width: 640, height: 639 })), /at least 409,600 pixels/);
  assert.doesNotThrow(() =>
    plan(endpoint, input, {
      media: { [video]: { width: 640, height: 640, durationSec: 4 }, [image]: { width: 1, height: 1 } },
    }),
  );
  assert.doesNotThrow(() => plan(endpoint, input, source(4, { width: 1920, height: 1080 })));
  assert.ok(plan(endpoint, input, source(4, { width: 640 })).warnings.some((w) => /pixel count is unknown/.test(w)));
});

test("restyle size, known/unknown presets and the 30-day cache boundary", () => {
  const endpoint = `${prefix}/restyle/v1.0`,
    input = { video_url: video, preset_id: preset };
  assert.doesNotThrow(() => plan(endpoint, input, source(4, { bytes: 200 * 1024 * 1024 })));
  assert.throws(() => plan(endpoint, input, source(4, { bytes: 200 * 1024 * 1024 + 1 })), /200 MiB/);
  assert.ok(plan(endpoint, input, source(4)).warnings.some((w) => /source size is unknown/.test(w)));
  assert.throws(
    () => plan(endpoint, { ...input, preset_id: "00000000-0000-4000-8000-000000000001" }),
    /Unknown.*hf:sync --presets/,
  );
  const asOf = JSON.parse(readFileSync("src/lib/models/hf-restyle-presets.json", "utf8")).asOf;
  const dated = (days: number) => ({ ...source(4), now: new Date(Date.parse(asOf) + days * 86400000).toISOString() });
  assert.ok(!plan(endpoint, input, dated(30)).warnings.some((w) => /older than 30 days/.test(w)));
  assert.ok(plan(endpoint, input, dated(30.001)).warnings.some((w) => /older than 30 days/.test(w)));
  const previous = process.env.AGENTBROS_HF_RESTYLE_PRESETS;
  process.env.AGENTBROS_HF_RESTYLE_PRESETS = "/nonexistent/offline-hf-presets.json";
  try {
    assert.throws(() => plan(endpoint, input), /cache is missing.*hf:sync --presets/);
  } finally {
    if (previous === undefined) delete process.env.AGENTBROS_HF_RESTYLE_PRESETS;
    else process.env.AGENTBROS_HF_RESTYLE_PRESETS = previous;
  }
});

test("Higgsfield guards match provider plus prefix; fal collisions and unrelated prefixes are isolated", () => {
  for (const [endpoint, input] of [
    [`${prefix}/motion-transfer/v1.0`, { video_url: video }],
    [`${prefix}/restyle/v1.0`, { video_url: video, preset_id: "unknown" }],
    ["higgsfield/genjutsu-light/motion-transfer/v1.0", {}],
    ["higgsfield/cinema-studio/4.0", { prompt: "<<<image_1>>>" }],
    ["higgsfield-ai/soul/v2/standard", { custom_reference_id: "character", custom_reference_strength: 0 }],
    ["marketing-studio/image/flare", { enhance_prompt: true }],
  ] as const) {
    for (const provider of ["fal", undefined] as const) {
      const warnings: string[] = [];
      const ran = applyFalGuards({ ...input }, falGuardContext(undefined), warnings, {
        endpoint,
        provider,
        inputSchema: { type: "object" },
        components: {},
      });
      assert.ok(!ran.some((id) => id.startsWith("higgsfield-")));
    }
    const ran = applyFalGuards({}, falGuardContext(undefined), [], {
      endpoint: `other/${endpoint}`,
      provider: "higgsfield",
      inputSchema: {},
      components: {},
    });
    assert.ok(!ran.some((id) => id.startsWith("higgsfield-")));
  }
});

test("Genjutsu Light plans disclose missing schema and unknown limits; explicit opt-in enables execution", () => {
  const req = request(
    "higgsfield/genjutsu-light/motion-transfer/v1.0",
    { video_url: video, image_urls: [image] },
    source(1),
  );
  const result = buildFalOperation(req);
  assert.equal(result.verification.schema, false);
  assert.equal(result.executable, false);
  assert.ok(
    result.warnings.some((w) =>
      /offline schema validation is impossible.*--provider-estimate.*--allow-unvalidated/.test(w),
    ),
  );
  assert.ok(result.warnings.some((w) => /limits are unknown.*first 15 seconds/.test(w)));
  assert.throws(() => requireExecutableFalOperation(result), /--provider-estimate/);
  assert.doesNotThrow(() => requireExecutableFalOperation(buildFalOperation(req, { allowUnvalidated: true })));
});

test("generate:model cannot silently submit Genjutsu Light", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hf-light-cli-"));
  try {
    const file = path.join(dir, "request.json");
    writeFileSync(file, JSON.stringify(request("higgsfield/genjutsu-light/motion-transfer/v1.0", {})));
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/generate-model.ts", "--request", file, "--output", path.join(dir, "out.mp4")],
      { encoding: "utf8", env: { ...process.env, HIGGSFIELD_API_KEY: "" } },
    );
    assert.notEqual(child.status, 0);
    const result = JSON.parse(child.stdout.trim());
    assert.match(JSON.stringify(result), /--provider-estimate.*--allow-unvalidated/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Cinema reference tokens are one-based, modality-specific and within attached arrays", () => {
  const endpoint = "higgsfield/cinema-studio/4.0";
  for (const prompt of ["<<<image_0>>>", "<<<image_2>>>", "<<<video_1>>>", "<<<audio_1>>>"])
    assert.throws(() => plan(endpoint, { prompt, image_urls: [image] }), /attached/);
  assert.doesNotThrow(() =>
    plan(endpoint, {
      prompt: "<<<image_1>>> <<<video_1>>> <<<audio_1>>>",
      image_urls: [image],
      video_urls: [video],
      audio_urls: ["https://example.com/a.wav"],
    }),
  );
});

test("Cinema reference counts, creative enums, durations and separate normalisation budgets", () => {
  const endpoint = "higgsfield/cinema-studio/4.0";
  for (const [key, max, url] of [
    ["image_urls", 30, image],
    ["video_urls", 10, video],
    ["audio_urls", 10, "https://example.com/a.wav"],
  ] as const) {
    assert.doesNotThrow(() => plan(endpoint, { prompt: "Shot", [key]: Array(max).fill(url) }));
    assert.throws(() => plan(endpoint, { prompt: "Shot", [key]: Array(max + 1).fill(url) }));
  }
  for (const duration of [4, 30])
    assert.doesNotThrow(() => plan(endpoint, { prompt: "Shot", duration, pacing: "single-shot" }));
  for (const duration of [3, 31]) assert.throws(() => plan(endpoint, { prompt: "Shot", duration }));
  assert.throws(() => plan(endpoint, { prompt: "Shot", camera_movement: "auto" }));
  const references = { prompt: "Shot", video_urls: [video], audio_urls: ["https://example.com/a.wav"] };
  assert.equal(
    plan(endpoint, references, {
      media: { [video]: { durationSec: 31 }, "https://example.com/a.wav": { durationSec: 31 } },
    }).warnings.filter((w) => /separate 30-second total budget/.test(w)).length,
    2,
  );
  assert.equal(
    plan(endpoint, references, { media: { [video]: {}, "https://example.com/a.wav": {} } }).warnings.filter((w) =>
      /reference duration is unknown/.test(w),
    ).length,
    2,
  );
  assert.ok(
    !plan(endpoint, references, {
      media: { [video]: { durationSec: 20 }, "https://example.com/a.wav": { durationSec: 20 } },
    }).warnings.some((w) => /normalised/.test(w)),
  );
});

test("Cinema token-metered unknown price requires a positive bound", async () => {
  const result = plan("higgsfield/cinema-studio/4.0", { prompt: "Ocean waves" });
  const options = {
    providerId: "higgsfield" as const,
    endpoint: result.endpoint,
    model: result.endpoint,
    input: result.input,
    output: "offline.mp4",
    mediaKind: "video" as const,
    quoteInput: quoteInputForPlan(result, result.input),
    dryRun: true,
  };
  assert.equal((await executeFalOperation(options)).metadata.executable, false);
  assert.equal((await executeFalOperation({ ...options, maxCostUsd: 1 })).metadata.executable, true);
  await assert.rejects(executeFalOperation({ ...options, maxCostUsd: 0 }), /positive/);
});

for (const endpoint of ["higgsfield-ai/soul/v2/standard", "higgsfield-ai/soul/cinema", "higgsfield-ai/soul/standard"]) {
  test(`${endpoint}: schema limits and account/training warnings`, () => {
    for (const batch_size of [1, 4]) assert.doesNotThrow(() => plan(endpoint, { prompt: "Portrait", batch_size }));
    assert.throws(() => plan(endpoint, { prompt: "Portrait", batch_size: 2 }));
    assert.throws(() => plan(endpoint, { prompt: "Portrait", aspect_ratio: "auto" }));
    assert.throws(() => plan(endpoint, { prompt: "Portrait", resolution: "4k" }));
    const result = plan(endpoint, { prompt: "Portrait", custom_reference_id: "11111111-1111-4111-8111-111111111111" });
    assert.ok(result.warnings.some((w) => /calling account.*completed training.*cannot be verified offline/.test(w)));
    assert.throws(() => plan(endpoint, { prompt: "Portrait", soul_id: "wrong-field" }));
    if (endpoint.includes("/v2/"))
      assert.throws(
        () =>
          plan(endpoint, {
            prompt: "Portrait",
            custom_reference_id: "11111111-1111-4111-8111-111111111111",
            custom_reference_strength: 0,
          }),
        /greater than 0/,
      );
    else
      assert.doesNotThrow(() =>
        plan(endpoint, {
          prompt: "Portrait",
          custom_reference_id: "11111111-1111-4111-8111-111111111111",
          custom_reference_strength: 0,
        }),
      );
  });
}

for (const endpoint of ["marketing-studio/image", "marketing-studio/image/flare", "marketing-studio/image/sunburst"]) {
  test(`${endpoint}: enhancement, reference formats and unknown metadata`, () => {
    const input = {
      prompt: "Campaign",
      enhance_prompt: true,
      preset_id: "11111111-1111-4111-8111-111111111111",
      image_urls: [image],
    };
    for (const contentType of ["image/jpeg", "image/png", "image/webp"])
      assert.doesNotThrow(() => plan(endpoint, input, { media: { [image]: { contentType } } }));
    assert.throws(
      () => plan(endpoint, input, { media: { [image]: { contentType: "image/gif" } } }),
      /JPEG, PNG or WebP/,
    );
    const warnings = plan(endpoint, input, { media: { [image]: { width: 100 } } }).warnings;
    assert.ok(warnings.some((w) => /format is unknown/.test(w)));
    assert.ok(warnings.some((w) => /preset_id exists.*product image first/.test(w)));
    assert.throws(() => plan(endpoint, { prompt: "Campaign", enhance_prompt: true }));
    assert.throws(() => plan(endpoint, { ...input, image_urls: [image, image, image] }));
    assert.doesNotThrow(() => plan(endpoint, { ...input, image_urls: [image, image] }));
    assert.doesNotThrow(() =>
      plan(endpoint, { prompt: "Campaign", image_urls: Array(16).fill(image), enhance_prompt: false }),
    );
    assert.throws(() => plan(endpoint, { prompt: "Campaign", image_urls: Array(17).fill(image) }));
    if (endpoint === "marketing-studio/image") assert.throws(() => plan(endpoint, { ...input, quality: "low" }));
    else assert.doesNotThrow(() => plan(endpoint, { ...input, quality: "max" }));
  });
}

test("Ads Studio schema encodes batch/aspect/fixed-renderer rules; AI Influencer stays unvalidated", () => {
  const endpoint = "higgsfield/ads-studio/v1.0";
  for (const batch_size of [1, 8]) assert.doesNotThrow(() => plan(endpoint, { prompt: "Campaign", batch_size }));
  for (const batch_size of [0, 9]) assert.throws(() => plan(endpoint, { prompt: "Campaign", batch_size }));
  for (const input of [{ aspect_ratio: "auto" }, { quality: "high" }, { resolution: "2k" }, { renderer: "flare" }])
    assert.throws(() => plan(endpoint, { prompt: "Campaign", ...input }));
  const influencer = plan("higgsfield/ai-influencer", {});
  assert.equal(influencer.verification.schema, false);
  assert.equal(influencer.executable, false);
});

test("generate:model schema-less gates accept explicit opt-in or a successful provider estimate only", () => {
  const repo = path.resolve(import.meta.dirname, ".."),
    tsx = createRequire(path.join(repo, "package.json")).resolve("tsx");
  const dir = mkdtempSync(path.join(tmpdir(), "hf-light-estimate-cli-"));
  try {
    mkdirSync(path.join(dir, "public/projects/demo"), { recursive: true });
    writeFileSync(path.join(dir, "public/projects/demo/project.json"), "{}");
    const file = path.join(dir, "request.json"),
      preload = path.join(dir, "estimate.mjs"),
      calls = path.join(dir, "calls.json");
    writeFileSync(file, JSON.stringify(request("higgsfield/genjutsu-light/motion-transfer/v1.0", {})));
    writeFileSync(
      preload,
      `import {writeFileSync} from 'node:fs';\nprocess.env.HIGGSFIELD_API_KEY='offline:secret';\nglobalThis.fetch=async(url,init)=>{writeFileSync(process.env.HF_TEST_CALLS,JSON.stringify({url:String(url),method:init.method}));return Response.json(process.env.HF_TEST_REJECT==='yes'?{detail:'fixture estimate rejected'}:{type:'estimate',usd:1},{status:process.env.HF_TEST_REJECT==='yes'?400:200});};\n`,
    );
    const invoke = (flags: string[], reject = false) => {
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          tsx,
          "--import",
          preload,
          path.join(repo, "scripts/generate-model.ts"),
          "--request",
          file,
          "--output",
          path.join(dir, "out.mp4"),
          ...flags,
        ],
        {
          cwd: dir,
          encoding: "utf8",
          env: { ...process.env, HF_TEST_CALLS: calls, HF_TEST_REJECT: reject ? "yes" : "no" },
        },
      );
      assert.notEqual(child.status, 0);
      return JSON.stringify(JSON.parse(child.stdout.trim()));
    };
    assert.match(invoke(["--allow-unvalidated"]), /Paid generation requires --project/);
    assert.match(invoke(["--provider-estimate"]), /Paid generation requires --project/);
    assert.equal(existsSync(calls), false);
    assert.match(
      invoke(["--provider-estimate", "--project", "demo", "--max-cost-usd", "0.5"]),
      /Published quote exceeds/,
    );
    assert.deepEqual(JSON.parse(readFileSync(calls, "utf8")), {
      url: "https://api.higgsfield.ai/estimate/higgsfield/genjutsu-light/motion-transfer/v1.0",
      method: "POST",
    });
    assert.match(invoke(["--provider-estimate", "--project", "demo"], true), /fixture estimate rejected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
