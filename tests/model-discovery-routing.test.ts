import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import snapshots from "../src/lib/providers/schemas/fal-operations.json";
import inventory from "../src/lib/models/endpoints.json";
import fixtures from "./fixtures/provider-contracts/fal-valid.json";
import { listModels, findModel, findModelSchema, resolveModelEndpoint } from "../src/lib/models/registry";
import { buildFalOperation } from "../src/lib/providers/fal-operations";

test("every schema endpoint has exact typed discovery routing and source evidence", () => {
  const expected = snapshots.map((row) => row.endpoint).sort();
  assert.equal(new Set(expected).size, expected.length);
  assert.deepEqual(
    listModels()
      .map((row) => row.id)
      .sort(),
    expected,
  );
  assert.deepEqual(Object.values(inventory).flat().sort(), expected);
  for (const snapshot of snapshots) {
    const model = findModel(snapshot.endpoint)!;
    assert.deepEqual(model.requestRouting, {
      family: snapshot.family,
      variant: snapshot.variant,
      operation: snapshot.operation,
      region: snapshot.region,
      transport: snapshot.transport,
    });
    assert.equal(model.region, snapshot.region);
    assert.equal(model.capabilities.schemaSha256, snapshot.sha256);
    assert.equal(model.verification.live, false);
    assert.equal(model.verification.localAdapter, true);
    assert.deepEqual(findModelSchema(snapshot.endpoint)?.input, snapshot.input);
    assert.deepEqual(findModelSchema(snapshot.endpoint)?.schemas, snapshot.schemas);
  }
  for (const fixture of fixtures) {
    const routing = findModel(fixture.endpoint)!.requestRouting;
    const routed = buildFalOperation({ ...fixture.request, ...routing });
    assert.equal(routed.endpoint, fixture.endpoint);
  }
});
test("exact family and operation filters preserve legacy grouping/aliases without hiding voice", () => {
  assert.deepEqual(listModels({ family: "kling-v3" }), listModels({ family: "kling-3" }));
  const gallery = listModels({ requestFamily: "flux-2-gallery" });
  assert.equal(gallery.length, 11);
  assert.ok(
    gallery.every(
      (row) => row.family === "flux-2" && row.operation === "style-workflow" && row.requestRouting.operation === "edit",
    ),
  );
  assert.ok(listModels({ family: "flux-2" }).length > listModels({ requestFamily: "flux-2" }).length);
  assert.equal(listModels({ family: "flux-2-gallery" }).length, 11);
  const voice = listModels({ family: "kling-voice", requestOperation: "create-voice" });
  assert.equal(voice.length, 1);
  assert.equal(voice[0].operation, "create-voice");
  assert.equal(voice[0].pricing.kind, "fixed");
  assert.equal(resolveModelEndpoint("gpt-image-2", "image-edit"), "openai/gpt-image-2/edit");
  assert.ok(
    listModels({ requestTransport: "realtime" }).every(
      (row) => row.transport === "session" && row.verification.localAdapter && !row.verification.live,
    ),
  );
  assert.ok(listModels({ region: "singapore" }).every((row) => row.requestRouting.region === "singapore"));
  const priced = listModels().filter((row) => row.pricing.kind !== "unknown");
  assert.equal(priced.length, 26); // +3 GPT Image 2.6 public tariffs
  assert.deepEqual(
    priced.map((row) => row.id).sort(),
    [
      "fal-ai/flux-2-pro",
      "fal-ai/kling-video/v3/pro/image-to-video",
      "bytedance/seedance-2.5/reference-to-video",
      "openai/gpt-image-2.5/sunburst/text-to-image",
      "google/nano-banana-2.1",
      "openai/gpt-image-2.5/flare/text-to-image",
      "openai/gpt-image-2.6/flare/text-to-image",
      "openai/gpt-image-2.6/flare/edit",
      "openai/gpt-image-2.6/sunburst/edit",
      "openai/gpt-image-2.5/flare/edit",
      "openai/gpt-image-2.5/sunburst/edit",
      "google/nano-banana-2.1/edit",
      "fal-ai/kling-video/v3/pro/text-to-video",
      "fal-ai/kling-video/v3/standard/text-to-video",
      "fal-ai/kling-video/v3/standard/image-to-video",
      "bytedance/seedance-2.5/text-to-video",
      "bytedance/seedance-2.5/image-to-video",
      "bytedance/seedance-2.5/us/text-to-video",
      "bytedance/seedance-2.5/us/image-to-video",
      "bytedance/seedance-2.5/us/reference-to-video",
      "fal-ai/kling-video/v3/turbo/pro/text-to-video",
      "fal-ai/kling-video/v3/turbo/pro/image-to-video",
      "fal-ai/kling-video/v3/turbo/standard/text-to-video",
      "fal-ai/kling-video/v3/turbo/standard/image-to-video",
      "fal-ai/kling-video/o3/pro/video-to-video/reference",
      "fal-ai/kling-video/create-voice",
    ].sort(),
  );
});
function cli(...args: string[]) {
  const env = { ...process.env };
  delete env.FAL_KEY;
  delete env.ELEVENLABS_API_KEY;
  const child = spawnSync(
    process.execPath,
    [path.resolve("node_modules/tsx/dist/cli.mjs"), "scripts/fal-models.ts", "--local", ...args],
    { encoding: "utf8", env, maxBuffer: 8 * 1024 * 1024 },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim().split("\n").length, 1);
  return JSON.parse(child.stdout).metadata;
}
test("offline CLI exposes all endpoint routing, exact filters, truncation and actual schema", () => {
  const all = cli("--list", "--limit", "1000");
  assert.equal(all.total, 102);
  assert.equal(all.returned, 102);
  assert.equal(all.truncated, false);
  const paged = cli("--list");
  assert.equal(paged.returned, 50);
  assert.equal(paged.truncated, true);
  const kling = cli("--family", "kling-v3", "--operation", "image-to-video");
  assert.ok(kling.total > 0);
  assert.ok(
    kling.models.every(
      (row: any) => row.requestRouting.family === "kling-v3" && row.requestRouting.operation === "image-to-video",
    ),
  );
  const gallery = cli("--family", "flux-2-gallery", "--category", "edit");
  assert.equal(gallery.total, 11);
  const voice = cli("--schema", "fal-ai/kling-video/create-voice");
  assert.equal(voice.model.requestRouting.operation, "create-voice");
  assert.ok(voice.schema.input);
  assert.ok(voice.schema.schemas);
});
