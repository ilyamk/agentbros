import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import fixtures from "./fixtures/provider-contracts/fal-valid.json";

const root = mkdtempSync(path.join(tmpdir(), "voice-tariff-cli-"));
const attempt = path.join(root, "network-attempt");
const guard = path.join(root, "deny-network.cjs");
writeFileSync(
  guard,
  `const deny=()=>{require('node:fs').writeFileSync(${JSON.stringify(attempt)},'attempt');throw new Error('Network forbidden in dry-run');};globalThis.fetch=deny;for(const id of ['node:http','node:https']){const m=require(id);m.get=deny;m.request=deny;}require('node:net').Socket.prototype.connect=deny;`,
);
test.after(() => rmSync(root, { recursive: true, force: true }));
const cli = path.resolve("node_modules/tsx/dist/cli.mjs");
const script = path.resolve("scripts/generate-model.ts");
let sequence = 0;
function request(endpoint: string) {
  const fixture = fixtures.find((row) => row.endpoint === endpoint);
  assert.ok(fixture, endpoint);
  const value = structuredClone(fixture.request);
  return { ...value, input: value.input as Record<string, unknown> };
}
type Envelope = {
  ok: boolean;
  error?: string;
  message?: string;
  metadata?: {
    executable: boolean;
    quote: null | { lowUsd: number; expectedUsd: number; highUsd: number };
    plan: { endpoint: string; input: Record<string, unknown> };
  };
};
function run(
  value: ReturnType<typeof request>,
  options: { bound?: number; tokens?: Record<string, number> } = {},
): Envelope {
  const id = ++sequence;
  const file = path.join(root, `request-${id}.json`);
  writeFileSync(file, JSON.stringify(value));
  const args = [
    "--require",
    guard,
    cli,
    script,
    "--request",
    file,
    "--output",
    path.join(root, `out-${id}.mp4`),
    "--dry-run",
  ];
  if (options.bound !== undefined) args.push("--max-cost-usd", String(options.bound));
  if (options.tokens) {
    const tokenFile = path.join(root, `tokens-${id}.json`);
    writeFileSync(tokenFile, JSON.stringify(options.tokens));
    args.push("--token-forecast", tokenFile);
  }
  // Isolated cwd cannot load the workspace .env; no credentials are inherited.
  const child = spawnSync(process.execPath, args, {
    cwd: root,
    env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 60000, // a cold tsx start on a loaded runner can pass 15s
  });
  assert.equal(child.error, undefined);
  assert.equal(child.stdout.trim().split("\n").length, 1, child.stderr);
  assert.equal(existsSync(attempt), false, "CLI attempted network");
  const result = JSON.parse(child.stdout) as Envelope;
  assert.equal(child.status, result.ok ? 0 : 1, child.stderr);
  return result;
}
function kling(variant: "standard" | "pro", voice?: string | null, audio?: boolean) {
  const value = request(`fal-ai/kling-video/v3/${variant}/image-to-video`);
  value.input.duration = "5";
  if (audio !== undefined) value.input.generate_audio = audio;
  value.input.elements = [
    {
      frontal_image_url: "https://example.com/front.png",
      reference_image_urls: ["https://example.com/ref.png"],
      ...(voice === undefined ? {} : { voice_id: voice }),
    },
  ];
  return value;
}
test("actual standard/pro i2v CLI carries active element voice control into exact audio quote", () => {
  for (const [variant, normal, voiced] of [
    ["standard", 0.63, 0.77],
    ["pro", 0.84, 0.98],
  ] as const) {
    const plain = run(kling(variant, undefined, true));
    assert.equal(plain.ok, true);
    assert.equal(plain.metadata?.quote?.highUsd, normal);
    const voice = run(kling(variant, "voice-fixture", true));
    assert.equal(voice.ok, true);
    assert.equal(voice.metadata?.quote?.expectedUsd, voiced);
    assert.equal(voice.metadata?.quote?.highUsd, voiced);
    assert.equal(run(kling(variant, "voice-fixture", true), { bound: voiced }).ok, true);
    const insufficient = run(kling(variant, "voice-fixture", true), { bound: normal });
    assert.equal(insufficient.ok, false);
    assert.equal(insufficient.error, "VALIDATION");
    assert.match(insufficient.message!, /Published quote exceeds/);
  }
});
test("absent/null/empty voice has no markup; explicit disabled audio with active voice is caller error", () => {
  for (const voice of [undefined, null, ""]) {
    const result = run(kling("standard", voice, true));
    assert.equal(result.ok, true);
    assert.equal(result.metadata?.quote?.highUsd, 0.63);
  }
  const off = run(kling("standard", null, false));
  assert.equal(off.ok, true);
  assert.equal(off.metadata?.quote?.highUsd, 0.42);
  for (const variant of ["standard", "pro"] as const) {
    const invalid = run(kling(variant, "voice-fixture", false));
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error, "INVALID_INPUT");
    assert.match(invalid.message!, /voice control requires generated audio/);
  }
});
test("missing audio preserves schema input and full conservative range including voice", () => {
  for (const [variant, low, high] of [
    ["standard", 0.42, 0.77],
    ["pro", 0.56, 0.98],
  ] as const) {
    const value = run(kling(variant, "voice-fixture"));
    assert.equal(value.ok, true);
    assert.equal(Object.hasOwn(value.metadata!.plan.input, "generate_audio"), false);
    assert.equal(value.metadata?.quote?.lowUsd, low);
    assert.equal(value.metadata?.quote?.highUsd, high);
  }
});
test("newly priced text modes carry explicit audio and duration and reject unsupported voice field", () => {
  for (const [variant, off, on] of [
    ["standard", 0.42, 0.63],
    ["pro", 0.56, 0.84],
  ] as const) {
    for (const [generate_audio, expected] of [
      [false, off],
      [true, on],
    ] as const) {
      const value = request(`fal-ai/kling-video/v3/${variant}/text-to-video`);
      value.input.duration = "5";
      value.input.generate_audio = generate_audio;
      const result = run(value);
      assert.equal(result.ok, true);
      assert.equal(result.metadata?.quote?.highUsd, expected);
    }
  }
  const invalid = request("fal-ai/kling-video/v3/standard/text-to-video");
  invalid.input.voice_id = "not-a-pinned-schema-field";
  assert.equal(run(invalid).error, "INVALID_INPUT");
});
test("actual GPT/Nano CLI requires token forecast and propagates exact image count", () => {
  for (const [endpoint, expected] of [
    ["openai/gpt-image-2.5/flare/text-to-image", 0.043],
    ["openai/gpt-image-2.5/flare/edit", 0.043],
    ["openai/gpt-image-2.5/sunburst/edit", 0.043],
    ["google/nano-banana-2.1/edit", 0.0389],
  ] as const) {
    const value = request(endpoint);
    assert.equal(run(value).metadata?.quote, null);
    const result = run(value, { tokens: { textInput: 1000, imageInput: 1000, imageOutput: 1000 } });
    assert.equal(result.ok, true);
    assert.equal(result.metadata?.quote?.expectedUsd, expected);
    value.input.num_images = 2;
    const doubled = run(value, { tokens: { textInput: 1000, imageInput: 1000, imageOutput: 1000 } });
    assert.equal(doubled.ok, true);
    assert.equal(doubled.metadata?.quote?.expectedUsd, expected === 0.043 ? 0.086 : 0.0777);
  }
});
test("Seedance global/US modes remain unknown without actual dimensions and reference-duration evidence", () => {
  for (const endpoint of [
    "bytedance/seedance-2.5/text-to-video",
    "bytedance/seedance-2.5/image-to-video",
    "bytedance/seedance-2.5/us/text-to-video",
    "bytedance/seedance-2.5/us/image-to-video",
    "bytedance/seedance-2.5/us/reference-to-video",
  ]) {
    const value = request(endpoint);
    value.input.duration = "5";
    value.input.resolution = "720p";
    const result = run(value);
    assert.equal(result.ok, true);
    assert.equal(result.metadata?.quote, null);
    assert.equal(result.metadata?.executable, false);
  }
});

test("published schema defaults are not fabricated as explicit pricing choices", () => {
  const value = request("fal-ai/kling-video/v3/standard/text-to-video");
  const result = run(value);
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result.metadata!.plan.input, "duration"), false);
  assert.equal(Object.hasOwn(result.metadata!.plan.input, "generate_audio"), false);
  assert.equal(result.metadata?.quote, null);
  assert.equal(result.metadata?.executable, false);
});
