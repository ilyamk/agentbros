import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createPublicListPricingEvidence } from "../src/lib/models/pricing-evidence";
import fixtures from "./fixtures/provider-contracts/fal-valid.json";
const root = mkdtempSync(path.join(tmpdir(), "coverage-cli-"));
const attempt = path.join(root, "forbidden-attempt"),
  guard = path.join(root, "guard.cjs");
writeFileSync(
  guard,
  `const fs=require('node:fs');const deny=()=>{fs.writeFileSync(${JSON.stringify(attempt)},new Error('forbidden').stack);throw new Error('Network/key read forbidden');};globalThis.fetch=deny;for(const name of ['node:http','node:https']){const m=require(name);m.get=deny;m.request=deny;}require('node:net').Socket.prototype.connect=function(...args){const normalized=Array.isArray(args[0])?args[0]:args;const value=normalized[0];const local=typeof value==='object'&&value&&typeof value.path==='string'&&value.path.startsWith(require('node:path').join(require('node:os').tmpdir(),'tsx-'+process.getuid())+'/')&&/\\/[0-9]+\\.pipe$/.test(value.path)&&/\\/node_modules\\/tsx\\/dist\\/(?:require-|client-)/.test(new Error().stack);if(local){fs.writeFileSync(${JSON.stringify(path.join(root, "blocked-loader-ipc"))},'blocked');throw new Error('Local tsx loader IPC blocked');}return deny();};const env=process.env;process.env=new Proxy(env,{get(o,k){if(/^(FAL_KEY|ELEVENLABS_API_KEY|PEXELS_API_KEY)$/.test(String(k)))deny();return o[k];}});const read=fs.readFileSync;fs.readFileSync=function(file,...args){if(typeof file==='string'&&/\\.env(?:$|\\.)/.test(file))throw new Error('Credential files forbidden');return read.call(this,file,...args);};require('node:module').syncBuiltinESMExports();`,
);
test.after(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;
function run(endpoint: string, mutate: (input: Record<string, unknown>) => void = () => {}, bound?: number) {
  const row = fixtures.find((f) => f.endpoint === endpoint);
  assert.ok(row, endpoint);
  const request = structuredClone(row.request);
  mutate(request.input);
  const file = path.join(root, `request-${++sequence}.json`),
    output = path.join(root, `result-${sequence}.mp4`);
  writeFileSync(file, JSON.stringify(request));
  const args = [
    "--require",
    guard,
    "--import",
    path.resolve("node_modules/tsx/dist/loader.mjs"),
    path.resolve("scripts/generate-model.ts"),
    "--request",
    file,
    "--output",
    output,
    "--dry-run",
  ];
  if (bound !== undefined) args.push("--max-cost-usd", String(bound));
  const child = spawnSync(process.execPath, args, {
    cwd: root,
    env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir() },
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.stdout.trim().split("\n").length, 1, child.stderr);
  assert.equal(
    existsSync(attempt),
    false,
    (existsSync(attempt) ? readFileSync(attempt, "utf8") : "") + child.stderr + child.stdout,
  );
  assert.equal(existsSync(output), false);
  assert.equal(
    existsSync(path.join(root, "blocked-loader-ipc")),
    true,
    "same-process loader IPC guard must be observed",
  );
  assert.equal(
    readdirSync(root).some((name) => /budget|jobs|pipeline/.test(name)),
    false,
  );
  const result = JSON.parse(child.stdout);
  assert.equal(child.status, result.ok ? 0 : 1, child.stderr);
  if (result.ok && result.metadata.quote) {
    if (result.metadata.quote.confidence === "user-bound")
      assert.equal(Object.hasOwn(result.metadata.quote, "pricingEvidence"), false);
    else assert.deepEqual(result.metadata.quote.pricingEvidence, createPublicListPricingEvidence(endpoint));
  }
  return result;
}
test("actual guarded Turbo CLI preserves missing duration and validates explicit/multishot seconds", () => {
  for (const [endpoint, cost] of [
    ["fal-ai/kling-video/v3/turbo/pro/text-to-video", 0.7],
    ["fal-ai/kling-video/v3/turbo/pro/image-to-video", 0.7],
    ["fal-ai/kling-video/v3/turbo/standard/text-to-video", 0.56],
    ["fal-ai/kling-video/v3/turbo/standard/image-to-video", 0.56],
  ] as const) {
    const missing = run(endpoint, (input) => {
      delete input.duration;
    });
    assert.equal(missing.ok, true);
    assert.equal(missing.metadata.plan.input.duration, undefined);
    assert.equal(missing.metadata.quote, null);
    assert.equal(missing.metadata.executable, false);
    const result = run(endpoint, (input) => {
      input.duration = "5";
    });
    assert.equal(result.ok, true);
    assert.equal(result.metadata.quote.highUsd, cost);
    assert.equal(
      run(
        endpoint,
        (input) => {
          input.duration = "5";
        },
        cost - 0.0001,
      ).error,
      "VALIDATION",
    );
  }
  const endpoint = "fal-ai/kling-video/v3/turbo/pro/text-to-video";
  const multi = run(endpoint, (input) => {
    delete input.prompt;
    input.duration = "5";
    input.multi_prompt = [
      { prompt: "one", duration: "2" },
      { prompt: "two", duration: "3" },
    ];
  });
  assert.equal(multi.ok, true);
  assert.equal(multi.metadata.quote.highUsd, 0.7);
  const mismatch = run(endpoint, (input) => {
    delete input.prompt;
    input.duration = "5";
    input.multi_prompt = [
      { prompt: "one", duration: "2" },
      { prompt: "two", duration: "2" },
    ];
  });
  assert.equal(mismatch.ok, false);
});
test("O3 nullable/absent output seconds remain unknown/manual-bound; explicit duration and voice price are exact", () => {
  const endpoint = "fal-ai/kling-video/o3/pro/video-to-video/reference";
  for (const value of [null, undefined]) {
    const mutate = (input: Record<string, unknown>) => {
      if (value === undefined) delete input.duration;
      else input.duration = value;
    };
    const result = run(endpoint, mutate);
    assert.equal(result.ok, true);
    assert.equal(result.metadata.quote, null);
    assert.equal(result.metadata.executable, false);
    const bounded = run(endpoint, mutate, 0.9);
    assert.equal(bounded.ok, true);
    assert.equal(bounded.metadata.quote.highUsd, 0.9);
    assert.equal(bounded.metadata.quote.confidence, "user-bound");
  }
  assert.equal(
    run(endpoint, (input) => {
      input.duration = "5";
    }).metadata.quote.highUsd,
    0.84,
  );
  assert.equal(
    run(
      endpoint,
      (input) => {
        input.duration = "5";
      },
      0.8399,
    ).error,
    "VALIDATION",
  );
  const voice = run("fal-ai/kling-video/create-voice");
  assert.equal(voice.ok, true);
  assert.equal(voice.metadata.quote.highUsd, 0.007);
  assert.equal(run("fal-ai/kling-video/create-voice", () => {}, 0.0069).error, "VALIDATION");
});
